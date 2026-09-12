export const nextjsB: Record<string, string> = {
  "nextjs-caching-and-revalidation-lifecycle": `把「Next 的缓存」理解成 \`fetch\` 上那个 \`cache\` 开关，会在生产里立刻失效。出 bug 几乎都是同一句话的变体：你以为没缓存，其实还有一层在；你以为刷掉了，其实刷的是另一层。Next 15 把默认从「尽量缓存」改成「\`fetch\` 默认不进 Data Cache」，并没有把四层模型拆掉。Request Memoization、Data Cache、Full Route Cache、Client Router Cache 还在，只是默认值和入口变了。Next 16 的 Cache Components（\`'use cache'\` + \`cacheLife\` + \`cacheTag\`）是把隐式 fetch 缓存收成显式指令，层还是那些层。

这篇文章只讲生命周期：每一层的 key 是什么、活多久、被谁失效、和动态函数怎么打架。读完你应该能独立回答三个问题：这次请求打到了哪一层、突变之后该 \`revalidateTag\` 还是 \`updateTag\`、为什么 \`next dev\` 里是新的、\`next start\` 里还是旧的。

## 1. 缓存不是开关，是四段不同寿命的状态机

把四层画在一张表上，排障才有坐标：

1. **Request Memoization**。活在这一次服务端渲染。同一棵树里两次 \`fetch(url)\` 或两次 \`cache()(id)\`，只打源一次。请求结束就扔。它不是跨用户的缓存，是去重。
2. **Data Cache**。跨请求、跨用户（除非你把 cookie 编进 key）。存 fetch 结果或 \`unstable_cache\` / \`'use cache'\` 的函数结果。失效靠时间、tag、path。
3. **Full Route Cache**。整段路由的 HTML + RSC Flight payload。静态路由构建期生成；ISR 在过期后于后台再生成。动态路由根本不进这一层。
4. **Client Router Cache**。浏览器里的段缓存。prefetch 和回退导航走它。Next 15 起动态页默认不再缓存 30 秒（\`staleTimes.dynamic = 0\`），layout 仍可能留下。

四层的 key 不同。Memoization 的 key 是调用参数；Data Cache 的 key 是 fetch URL+选项或你给 \`unstable_cache\` 的 key 数组；Full Route Cache 的 key 是路由路径加被允许的 searchParams；Router Cache 的 key 是段。改错 key 的症状是：你以为按商品失效，结果整站目录还是旧的，或反过来一次 tag 把无关页全刷了。

不变量：**没有「关缓存」这一个动作。** \`cache: 'no-store'\` 只退出 Data Cache；layout 的 Full Route Cache、客户端点过的段、同一次请求里的 memoize，都还在。\`export const dynamic = 'force-dynamic'\` 退出 Full Route Cache 和这段的静态生成，不退出你在别的函数里写的 \`'use cache'\`。

## 2. Request Memoization：一次渲染里的 Map

React 在服务端渲染时给 \`fetch\` 和 \`cache()\` 准备了一张请求内的 Map。layout 调 \`getUser(id)\`，page 再调一次，数据库只打一次。这就是「为什么我没做 Data Cache，日志里也只有一条 SQL」。

\`\`\`tsx
import { cache } from "react";
import { db } from "@/lib/db";

export const getUser = cache(async (id: string) => {
  return db.user.findUnique({ where: { id } });
});
\`\`\`

\`cache()\` 的 key 是**参数的浅比较**。对象参数每次 new 一个字面量，去重失败。传 \`id: string\`，不要传整个 \`searchParams\` 对象。\`fetch\` 的 memoize 看 URL、method 和一部分 headers；两个调用点写了不同的 \`Authorization\`，就变成两次。

它不跨请求。用户 A 和用户 B 不会共享这张 Map。把它当全局 LRU 是错的。\`unstable_cache\` / \`'use cache'\` 才跨请求。

开发态 React 严格模式会把某些客户端逻辑跑两遍，但服务端组件的 memoize 仍按一次请求算。不要用「我看到两条日志」直接断定 memoize 坏了——先看是不是两条请求、是不是构建时预渲染加运行时又跑、是不是 Route Handler 和 RSC 各打一次（它们不是同一棵渲染树）。

\`cookies()\` / \`headers()\` 读了之后，这次渲染被标成动态，但 memoize 仍在。动态不等于不去重。去重回答的是「这一次计算要不要重复付」，动态回答的是「这次结果能不能留给下一次」。两件事叠在同一个 \`await\` 上，所以日志看起来像一回事。

把 \`getUser\` 写成普通 async 函数、在三个 Server Component 里各调一次，没有 \`cache()\` 也没有相同的 \`fetch\`，就会打三次库。这不是 Next 的锅，是你没有请求内去重。ORM 自己的 dataloader 可以补；和 \`cache()\` 二选一，不要套两层还用不同的 key 规则。

## 3. Data Cache：跨请求的那一层，以及默认为什么改了

Next 14：\`fetch\` 默认 \`force-cache\`，GET 进 Data Cache。大量「CMS 改了前台没变」来自这里。Next 15：\`fetch\` 默认不进 Data Cache，等价于你以前手写的 \`no-store\`。升级之后「怎么变慢了 / 怎么源站 QPS 涨了」，不是性能回归，是默认值把账单还给了你。团队把「Next 会帮我们缓存」写进规范，却没写进代码，升级就是一次静默的架构变更。

要进 Data Cache，必须显式：

\`\`\`ts
const res = await fetch(url, { cache: "force-cache" });

const res2 = await fetch(url, {
  next: { revalidate: 3600, tags: ["product", \`product-\${id}\`] },
});
\`\`\`

\`revalidate: 3600\` 是 stale-while-revalidate：过期后先把旧的给出去，后台再拉。失败则继续用旧的。不要把它理解成「准时 3600 秒切新」。准时是缓存的幻觉。第一个过期请求的用户，拿到的仍可能是旧 HTML，他只是顺便当了刷新扳机。

非 fetch 的源（Prisma、\`fs\`、RPC）没有 fetch 那套选项。Next 15 用 \`unstable_cache\`；打开 Cache Components 之后用 \`'use cache'\`：

\`\`\`ts
import { unstable_cache } from "next/cache";

export const getProduct = unstable_cache(
  async (id: string) => db.product.findUnique({ where: { id } }),
  ["product"],
  { revalidate: 3600, tags: ["product"] },
);
\`\`\`

\`["product"]\` 是 key 前缀，真正的 key 还要加上函数参数。参数必须可序列化。传一个 Prisma client 或 class 实例，key 对不上或直接抛。漏掉 \`locale\`、币种、feature flag，就会出现「英文站看到中文缓存」。多出来的输入（整个 headers 对象）会让缓存永远 miss。

\`'use cache'\` 把缓存从 fetch 选项提升到函数/组件作用域：

\`\`\`ts
import { cacheLife, cacheTag } from "next/cache";

export async function getProduct(id: string) {
  "use cache";
  cacheLife("hours");
  cacheTag("product", \`product-\${id}\`);
  return db.product.findUnique({ where: { id } });
}
\`\`\`

\`cacheLife\` 的 profile 不是一个数字，是三段：\`stale\`（客户端可以先用多久）、\`revalidate\`（服务端何时在后台刷新）、\`expire\`（过了就不再当命中）。把 ISR 的「一个 revalidate 秒数」理解成这三段，才能解释「为什么用户还看到旧的，但日志里已经在刷新」。

Data Cache 的存储位置是平台的事：本地在 \`.next/cache\`，Vercel 一类平台有跨实例的 Data Cache / Runtime Cache。多实例之间是否共享，决定 \`revalidateTag\` 能不能打到所有人。自己用多台 Node 跑 \`next start\` 而没有共享缓存，tag 失效只发生在接到 Action 的那台——这是架构问题，不是 API 用错。

## 4. Full Route Cache：缓存的是渲染结果，不是那一次 fetch

即使 Data Cache 命中，动态函数仍能让整页不进 Full Route Cache。反过来：所有 fetch 都 \`no-store\`，这一页也进不了 Full Route Cache。这一层缓存的是**已经渲染完的 RSC payload + HTML**。构建时静态页写进制品；运行时 ISR 把新的结果写回。CDN 能端的是这一层的 HTML，不是你函数里的 Map。

一段路由能不能静态，看它在渲染时碰了什么：

- \`cookies()\`、\`headers()\`、\`draftMode()\`、\`connection()\`：绑定到这次请求，静态外壳没了。
- page 的 \`searchParams\`：这一页按搜索参数分叉，默认偏动态。
- 未缓存的 \`fetch\` / 未缓存的 DB：框架认为结果不可复用。
- \`Math.random()\` / \`Date.now()\`：构建期写死一个值，或把段标动态，取决于是否被 \`'use cache'\` 包住。

\`\`\`ts
export const revalidate = 60;
export const dynamic = "auto";
\`\`\`

段配置是粗粒度锤子。\`revalidate = 60\` 给这棵段一个默认 ISR 窗口；\`dynamic = 'force-dynamic'\` 直接放弃 Full Route Cache。生产里先让叶子数据带 tag，再对真正永远动态的壳（用户栏）用 \`connection()\` 或 \`Suspense\` 挖洞，而不是整页 \`force-dynamic\`。

Partial Prerendering / Cache Components 的静态壳 + 动态洞，就是把 Full Route Cache 的粒度从「整页」降到「洞以外的那一圈」。洞必须有 Suspense 边界，否则洞的动态性会泡到整页——和流式渲染是同一条边界。壳里出现一次未缓存的 \`cookies()\`，洞白挖。

## 5. Client Router Cache：回退为什么还显示旧页

客户端点过 \`/product/1\`，RSC payload 会留在内存。Next 14 动态段默认 30 秒内回退复用；Next 15 把 \`staleTimes.dynamic\` 默认改成 0，动态页回退会重新向服务器要。静态段、layout 仍可能复用。这不是「浏览器 HTTP 缓存」，是 Next 路由器自己的段表。禁用 CDN 也关不掉它。

所以「我已经 \`revalidateTag\` 了，点浏览器后退还是旧的」要分层问：

- 服务端 Data Cache / Full Route Cache 是否真的失效（看 \`next start\` 的响应头和源站日志）。
- 客户端是不是根本没发新请求（Router Cache 命中）。\`router.refresh()\` 强制当前段再拉。Server Action 成功返回后，Next 会把本次响应里带的刷新打到客户端缓存；**你在 Action 里忘了 revalidate，客户端不会自己猜。**
- prefetch：\`<Link>\` 默认对静态段预取。预取的是当时的 payload。tag 失效后，下一次预取才是新的。不要指望「失效的瞬间所有已经打开的 tab 都变」。

\`\`\`tsx
"use client";

import { useRouter } from "next/navigation";

export function RefreshButton() {
  const router = useRouter();
  return (
    <button type="button" onClick={() => router.refresh()}>
      刷新当前段
    </button>
  );
}
\`\`\`

\`router.refresh()\` 不卸 layout 的客户端状态。这是 App Router 的契约：layout 保活。刷新的是 RSC 子树，不是整页 \`location.reload()\`。输入框里没提交的字还在，详情数字应该变——若数字也不变，是服务端层没失效，不是 refresh 没调用。

## 6. 动态函数、PPR 洞、和「误伤整页」

\`cookies()\` 在 layout 里一读，这个 layout 以下默认都不能静态。认证壳要读 cookie，于是整棵营销站都变成每个请求 SSR——这是最常见的误伤。修法是把读 cookie 的那一块推进 Suspense 洞，或推进一个客户端叶子去调 Route Handler，让静态壳留下来。

Next 15 的 \`connection()\` 显式说「我要等真实请求」。比在代码里随手 \`headers()\` 更可读。构建时预渲染碰到 \`connection()\` 会挂起，等运行时。

\`\`\`tsx
import { connection } from "next/server";
import { cookies } from "next/headers";

export async function UserChip() {
  await connection();
  const jar = await cookies();
  const token = jar.get("session")?.value;
  if (!token) return null;
  return <span>{await whoami(token)}</span>;
}
\`\`\`

page 里用洞把它隔开：

\`\`\`tsx
import { Suspense } from "react";

export default function Page() {
  return (
    <>
      <StaticHero />
      <Suspense fallback={<span>…</span>}>
        <UserChip />
      </Suspense>
    </>
  );
}
\`\`\`

没有 Suspense，动态子树的等待会堵住整页，Full Route Cache 也保不住壳。\`draftMode()\` 是另一条显式动态：编辑预览必须绕过 Data Cache 和 Full Route Cache 看草稿。忘记关 draft，等于你一个人在「永远 no-store」的会话里调试缓存，结论全部作废。

\`searchParams\` 不要在静态营销页的 page 组件上解构「以防以后有 UTM」。有 UTM 就整页动态。UTM 交给客户端或一个隔离的洞。

## 7. 失效：时间、tag、path，以及第二参数

三条失效：

- **时间。** \`revalidate: 60\` / \`cacheLife('minutes')\`。适合能忍过期的目录、价格不敏感的内容。不适合库存、权限、支付状态。
- **tag。** 数据带着 \`product-42\` 和 \`product-list\`。突变 \`product-42\` 时刷自己和列表，不要刷 \`product\` 这个全站桶。
- **path。** \`revalidatePath('/blog/foo')\` 刷这一段的 Full Route Cache；\`revalidatePath('/blog', 'layout')\` 刷这段 layout 以下。path 不知道 Data Cache 里那些没渲染进这页的 key，所以「只改了 DB、没渲染过的详情页」仍可能在 Data Cache 里活着——tag 才能打到它们。

\`\`\`ts
"use server";

import { revalidatePath, revalidateTag, updateTag } from "next/cache";

export async function publishProduct(id: string) {
  await db.product.update({ where: { id }, data: { published: true } });
  revalidateTag(\`product-\${id}\`, "max");
  revalidateTag("product-list", "max");
  revalidatePath(\`/product/\${id}\`);
}
\`\`\`

Next 16 起 \`revalidateTag(tag, profile)\` 的第二参数是 stale-while-revalidate 的窗口：立刻给旧的，后台刷新。单参数形式已弃用。\`updateTag(tag)\` 是读己之写：Action 所在的这次后续读要看到新值，适合用户刚改完自己的显示名。选错的症状很具体：\`revalidateTag\` 之后当前表单还显示旧名，是你需要 \`updateTag\`；所有人立刻 404 风暴打源，是你把热 tag 做成了同步击穿。

不要 \`revalidatePath('/')\` 当万能钥匙。根 path 加上 \`'layout'\` 等于整站 Full Route Cache 作废，源站和构建缓存一起抖。CMS webhook 里按 slug 刷 tag，不要按站点根刷。

## 8. 取舍：静态、ISR、按 tag、完全动态、Cache Components

| 模式 | 买到什么 | 代价 |
|---|---|---|
| 纯静态 | CDN、零源站 | 内容变了要重建或等窗口 |
| ISR / \`cacheLife\` | 多数请求仍快，偶尔后台刷新 | 过期边界上的人看到旧的 |
| tag 点杀 | 突变后精确刷新 | tag 设计本身是 API，设计错就等于没缓存或整站刷 |
| \`force-dynamic\` / 默认 no-store | 正确性最简单 | TTFB、源站、无法 CDN 整页 |
| Cache Components 挖洞 | 壳静态、洞动态 | 必须会画 Suspense 边界，洞里不能偷读 cookies 到壳 |

默认选：公开内容带 tag + 合理 \`cacheLife\`；用户私有数据不要进 Data Cache（或 key 里显式含 user id，且绝不放 Full Route Cache）；突变走 Action + \`updateTag\` / \`revalidateTag\`。不要为了「看起来像 SSR」把可静态的营销页打成动态。

\`'use cache'\` 和 \`fetch cache: 'force-cache'\` 叠在一起会双重缓存，失效要打两层。能包函数就包函数，不要 fetch 一层、\`unstable_cache\` 再包一层还用不同 tag。函数必须是纯的：同样输入同样输出，没有偷偷读 cookie。框架若检测不到，就会出现「缓存了不该缓存的请求」。纯，不是风格，是正确性。

## 9. 排障：按层问，不要先加 \`no-store\`

1. **dev 和新的、start 旧的。** \`next dev\` 的缓存行为不是生产。结论只认 \`next build && next start\` 或平台预览。
2. **Action 成功页面没变。** 先看 Action 有没有 \`revalidateTag\` / \`updateTag\`；再看 tag 字符串是否和读路径完全一致（多一个空格都是新 tag）；再看是不是 Router Cache：同一 SPA 会话里 \`router.refresh()\`。
3. **改了 A 商品 B 商品也变。** tag 太粗。列表用 \`product-list\`，实体用 \`product-\${id}\`，互不替代。
4. **源站被打穿。** 失效后所有实例同时 miss。热 key 用 SWR（\`revalidateTag\` 带 profile），不要用立刻过期的 expire。
5. **个性化内容串用户。** 把 cookie 读在已缓存的函数里，或 Full Route Cache 了带用户名的 HTML。私有数据退出 Full Route Cache，Data Cache 的 key 必须含用户维度，更好是不缓存私有。
6. **\`Date.now()\` 写进缓存函数。** 构建期或首次命中的时间被冻住。时间放进未缓存的洞，或不要放进输出。
7. **升级 14 → 15 源站 QPS 暴涨。** fetch 默认不再进 Data Cache。公开接口补 \`next: { revalidate, tags }\` 或 \`'use cache'\`。
8. **多实例 tag 不生效。** 没有共享 Data Cache。需要平台缓存或自己的失效总线，不能假设进程内存是全局的。
9. **构建时和运行时各一份。** \`generateStaticParams\` 写进制品的页，运行时 tag 失效后要能重新生成；\`dynamicParams = false\` 的未知 id 直接 404，不会在首次访问时现填缓存。

日志：给每次源站访问打 request id。命中缓存时这条日志不该出现。出现了还觉得「缓存开了」，是 key 或层写错。响应头 \`x-nextjs-cache\` / 平台自己的 cache status 只覆盖其中一层，不要用一个 HIT 断定四层都 HIT。

## 10. 和 RSC、Server Action 怎么咬合

RSC 树在服务端走完，缓存的决策发生在 await 点。没有 Suspense 的整页 \`await getProduct()\` 会让这一页的缓存粒度变成「整个 page 函数」。拆成带 tag 的 \`getProduct\` 和带 \`connection()\` 的 \`UserChip\`，壳和洞才分开。

Server Action 是突变的提交点。它跑完后框架根据你调用的 revalidate 去刷 Data Cache 和 Full Route Cache，并把刷新指令带回客户端。Action 里再 \`fetch\` 默认仍是这次请求的语义；不要在 Action 里靠 Data Cache 读「刚写的值」——写后读用 \`updateTag\` 或直接用 DB 返回值。Action 里 \`cookies()\` 很正常，它本来就是一次 POST，不会因此把营销首页变成动态，除非你在首页的渲染路径上也读了同一份 cookie。

\`generateStaticParams\` 决定哪些详情页进构建期 Full Route Cache。没返回的 id 走动态。目录很大时不要在构建期生成全部，用 ISR / tag 让第一次访问写入 Data Cache + 路由缓存。构建时间是产品参数，和缓存命中率同一张账。

## 11. key 设计：比调用缓存 API 更值钱

tag 是你的失效 API，不是日志标签。建议：

- 实体：\`\${type}-\${id}\`
- 集合：\`\${type}-list\` 或 \`\${type}-list-\${filterHash}\`
- 关系：改评论时刷 \`post-\${postId}\`，不要只刷 \`comment-\${id}\` 而留下文章页的旧计数

读路径和写路径必须共用同一份常量，不要各写各的字符串字面量。TypeScript 用联合类型把 tag 收窄：

\`\`\`ts
export type CacheTag = \`product-\${string}\` | "product-list" | "catalog";

export function productTag(id: string): CacheTag {
  return \`product-\${id}\`;
}
\`\`\`

key 数组必须包含**所有会改变结果的输入**。不要把用户 id 放进公开列表的 key。不要把时间戳放进 key 还指望命中。\`unstable_cache\` 的 key 不自动含闭包里读到的全局；闭包读了 \`process.env.PRICE_GROUP\`，必须手动放进 key，否则切环境变量后旧条目还在。

缓存入口函数不要做权限判决。先鉴权，再按 id 读已缓存的公开投影。把「当前用户能不能看」编进缓存函数，要么串权，要么 key 膨胀到每人一份——那已经不是 Data Cache 该管的粒度。

## 12. 小结

缓存是分层状态机。Memoization 去重一次渲染；Data Cache 跨请求存数据；Full Route Cache 存渲染结果；Router Cache 存客户端段。Next 15 改的是 fetch 默认值，Next 16 改的是入口（\`'use cache'\`），不是这四层。失效要对着层和 key：时间换吞吐，tag 换精确，path 换整段 HTML，\`updateTag\` 换当前用户的读己之写。调任何开关之前先问在哪一层。下一篇把突变收到 React 19 的 Action 模型里：pending 不是你的 \`useState\`，是过渡的生命周期。
`,

  "react-19-new-hooks-actions-use": `把 React 19 的新 hooks 理解成「少写几行 \`useState\` + \`useEffect\`」，会在表单、乐观更新和 RSC 边界上立刻失效。\`useActionState\`、\`useOptimistic\`、\`use()\` 不是语法糖，是把**异步从副作用里拽回渲染模型**：一次 Action 是一次过渡（transition），pending / 错误 / 乐观结果是这条过渡的状态，不是你在组件上另开的三份布尔。\`use()\` 让 Promise 和 Context 能在渲染期读，和 Suspense 对齐，和 \`useEffect\` 里 \`then\` 是两条时间线。

这篇文章只讲这条模型：Action 怎样变成过渡、表单怎样把 \`FormData\` 交出去、乐观更新怎样和权威状态对账、\`use()\` 为什么对 Promise 引用过敏。读完你应该能独立回答三个问题：\`useFormStatus\` 为什么必须写在 \`<form>\` 的子组件里、每次 render \`new Promise\` 为什么会无限挂起、乐观更新失败时 UI 靠什么回滚。

## 1. Action 不是又一个 fetch 封装

React 19 里，能传给 \`<form action>\`、\`<button formAction>\`、或丢进 \`startTransition\` 的异步函数，叫 Action。框架保证三件事：

1. 调用被包进过渡：紧急更新（输入）不被这次请求堵住，pending 可观测。
2. 成功后的 DOM 表单会按规范重置（受控输入另说）。
3. 和 Concurrent 渲染兼容：过渡可以被打断，但 Action 的那一次执行不会被「渲染两次」跑成两次提交——提交点在事件，不在 render。

\`\`\`tsx
"use client";

async function saveBio(formData: FormData) {
  await updateBio(String(formData.get("bio") ?? ""));
}

export function BioForm() {
  return (
    <form action={saveBio}>
      <textarea name="bio" />
      <button type="submit">保存</button>
    </form>
  );
}
\`\`\`

没有 \`onSubmit\`、没有 \`preventDefault\`、没有 \`fetch\` 再 \`setState\`。浏览器会原生提交；有 JS 时 React 拦下来跑 Action，没 JS 时（Server Action）仍是 POST。这是渐进增强，不是装饰。

自己用 \`onSubmit\` 再 \`e.preventDefault()\` 再 \`void fetch()\`，等于退出这条协议：没有自动 pending，没有自动重置，没有和 \`useFormStatus\` 对接，也没有 Server Action 的刷新指令。能跑，只是你把框架已经付过的账又付一遍，还付错层。

## 2. 过渡才是 pending 的真源

\`isPending\` 不是「请求发出去了」。它是：**还有未完成的过渡**。输入框的 \`setState\` 是紧急更新，立刻提交；Action 是非紧急的，可以在 CPU 忙时让路。所以你会看到：按钮已经 \`disabled\`，输入仍能打字。这不是 bug，是过渡的定义。

\`startTransition(async () => { await save(); })\` 把任意异步函数收成 Action。\`useTransition\` 给出的 \`isPending\` 覆盖这次过渡。\`useActionState\` 内部就是这条路，外加把返回值收成 state。

不要再用 \`useEffect\` 监听 \`isPending\` 去「补一次刷新」。过渡结束时 React 已经按 Action 的返回值和 Server Action 的 revalidate 指令更新树。再补一次 \`router.refresh()\` 会打出双请求，并把乐观状态窗口拉长。

过渡可重叠。连点两次提交，两次 Action 都会跑——除非你在按钮上 \`disabled={isPending}\` 或自己做队列。框架不给你「自动防抖」。连点造成两条写入，是业务 bug，不是 hook 没文档。

## 3. \`useActionState\`：把返回值收成状态

\`useActionState(action, initialState)\` 返回 \`[state, formAction, isPending]\`。包装后的 \`formAction\` 签名变成「先吃上一份 state，再吃 \`FormData\`」。所以 Server Action 也必须改签名：

\`\`\`ts
"use server";

export type SaveState = { ok: true } | { ok: false; error: string };

export async function saveName(prev: SaveState, formData: FormData): Promise<SaveState> {
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 2) return { ok: false, error: "名字太短" };
  try {
    await db.user.update({ where: { id: prev && "id" in prev ? 0 : 0 }, data: { name } });
    return { ok: true };
  } catch {
    return { ok: false, error: "保存失败" };
  }
}
\`\`\`

上面 \`where: { id: ... }\` 那种从 prev 里硬挖 id 是错的。id 不该来自客户端可改的 prev。id 来自服务端 session，或来自 \`bind\` 的加密闭包。\`prev\` 只用来带「上一轮校验错误」，不要当可信输入。

客户端：

\`\`\`tsx
"use client";

import { useActionState } from "react";
import { saveName, type SaveState } from "./actions";

const initial: SaveState = { ok: true };

export function NameForm() {
  const [state, action, pending] = useActionState(saveName, initial);
  return (
    <form action={action}>
      <input name="name" required />
      <button type="submit" disabled={pending}>
        {pending ? "保存中" : "保存"}
      </button>
      {!state.ok && <p role="alert">{state.error}</p>}
    </form>
  );
}
\`\`\`

校验错误走返回值，不要 \`throw\`。\`throw\` 进最近的 Error Boundary，整段表单卸掉，用户失去输入。可恢复的业务错误是 state；真正的渲染崩溃才是 boundary。

第三参 permalink 给无 JS 的 POST 一个回落 URL。有 JS 时很少用到；做可分享的搜索表单时，permalink 让「提交后的 URL」和 state 对齐。

## 4. \`useFormStatus\`：为什么必须是子组件

\`useFormStatus()\` 读的是**最近的父级 \`<form>\` 的提交状态**，靠 React 树，不是靠你把 pending 当 props 传来传去。它必须写在 form 的子树里。写在和 \`<form>\` 平级的按钮上，永远是 \`pending: false\`。

\`\`\`tsx
"use client";

import { useFormStatus } from "react-dom";

function Submit({ children }: { children: React.ReactNode }) {
  const { pending, data, method } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? \`正在 \${method} \${data?.get("name") ?? ""}\` : children}
    </button>
  );
}

export function FormWithStatus({ action }: { action: (fd: FormData) => void }) {
  return (
    <form action={action}>
      <input name="name" />
      <Submit>保存</Submit>
    </form>
  );
}
\`\`\`

\`data\` / \`method\` / \`action\` 是 React 19 补上的。按钮要显示「正在保存张三」，读 \`data\`，不要再复制一份 \`useState\`。\`useFormStatus\` 不能替代 \`useActionState\`：它没有上一轮的返回值，只有「此刻这份表单在不在飞」。错误文案仍要 \`useActionState\` 的 state，或你自己把 Server Action 的返回值写进 URL。

一个页面两个 form，两个独立的 status。共用一个顶层 \`isSaving\` 会让无关按钮一起转圈。这正是 hook 被设计成「读最近的 form」的原因。

## 5. \`useOptimistic\`：先写 UI，提交是另一条时间线

乐观更新的不变量：屏幕上的值 = 权威状态 + 尚未确认的增量。权威状态从 props / server 来；增量在 Action 完成或失败后必须消失。\`useOptimistic(state, reducer)\` 把这条不变量收成 API。

\`\`\`tsx
"use client";

import { useOptimistic } from "react";
import { send } from "./actions";

type Message = { id: string; text: string; pending?: boolean };

export function Thread({ messages }: { messages: Message[] }) {
  const [optimistic, add] = useOptimistic(messages, (current: Message[], text: string) => [
    ...current,
    { id: "tmp", text, pending: true },
  ]);

  async function formAction(formData: FormData) {
    const text = String(formData.get("text") ?? "");
    add(text);
    await send(text);
  }

  return (
    <div>
      {optimistic.map((m) => (
        <p key={m.id} data-pending={m.pending ? "1" : "0"}>
          {m.text}
        </p>
      ))}
      <form action={formAction}>
        <input name="text" />
        <button type="submit">发送</button>
      </form>
    </div>
  );
}
\`\`\`

\`messages\` 是权威。Action 期间 reducer 的输出覆盖屏幕。Action 结束，如果父级因 revalidate 传来新的 \`messages\`，乐观层卸掉，列表回到权威。失败且父级没变，也卸掉增量——这就是回滚。你不必写 \`catch { setX(old) }\`。

坑在两处。第一，\`key\`。临时 id 和服务器 id 对不上，卸乐观层时 React 会以为删了一条、又插了一条，闪一下。临时 id 要用稳定算法（客户端 uuid），服务端回显同一 id，或接受闪一下。第二，不可回滚的副作用不要乐观：扣款、发邮件、删不可恢复的文件。乐观只给「加一条消息、点赞、改显示名」这种能撤回的字段。

\`add()\` 必须发生在过渡里。放在过渡外，React 不认这是乐观层，会变成真正的本地 state，权威回来时对不上账。\`form action\` 和 \`startTransition\` 都在过渡里；\`await send()\` 之后再 \`add()\` 就晚了。

## 6. \`use()\`：渲染期读 Promise / Context

\`use(promise)\` 在渲染里解包。未决议就 throw 给最近的 Suspense；已拒绝就 throw 给最近的 Error Boundary。\`use(context)\` 等价于 \`useContext\`，但可以写在条件分支里——这是它和 hooks 规则分道的地方。

\`\`\`tsx
import { use, Suspense } from "react";

function Comments({ promise }: { promise: Promise<Comment[]> }) {
  const comments = use(promise);
  return (
    <ul>
      {comments.map((c) => (
        <li key={c.id}>{c.body}</li>
      ))}
    </ul>
  );
}

export function Page({ promise }: { promise: Promise<Comment[]> }) {
  return (
    <Suspense fallback={<p>加载评论…</p>}>
      <Comments promise={promise} />
    </Suspense>
  );
}
\`\`\`

Promise 必须**稳定**。每次 render \`use(fetch(...))\`，每次都是新 Promise，Suspense 永远落不下来，CPU 空转。稳定从哪来：父级 Server Component \`await\` 之前把 promise 当 props 传下来（RSC 会缓存这次请求的引用）；或 \`cache()\` 包过的函数；或 \`useMemo\` / state 里保住的那一个。不要在客户端组件的函数体里现场 \`fetch\` 再 \`use\`。

服务端组件里直接 \`await\` 比 \`use()\` 简单。\`use()\` 的正当位置是：**客户端子树要在渲染期读一个已经存在的 Promise**，好让 Suspense 边界落在比 page 更小的地方。服务端已经 \`await\` 完再当 props 传值，客户端就不必 \`use()\`。

不要用 \`try/catch\` 包 \`use()\` 来处理 reject。拒绝走 Error Boundary。要可恢复 UI，让 Promise resolve 成 \`{ ok: false }\`，或在父级用 \`error.tsx\`。

## 7. 和 Server Action、RSC 的边界

客户端 Action 可以就是一个 async 函数；Server Action 是带 \`'use server'\` 的那一种，编译成 POST + 闭包序列化。props 和 \`bind\` 进去的值会出现在客户端可见的 payload 里。\`bind(userId)\` 不是保密，是方便。保密的 id 来自 cookie / session，在函数体里读。

\`\`\`ts
"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";

export async function rename(formData: FormData) {
  const session = await getSession();
  if (!session) return { ok: false as const, error: "未登录" };
  const name = String(formData.get("name") ?? "").trim();
  await db.user.update({ where: { id: session.uid }, data: { name } });
  revalidatePath("/me");
  return { ok: true as const };
}
\`\`\`

RSC 负责权威数据：page 里 \`await getMessages()\` 再把数组传给客户端 \`Thread\`。客户端负责 Action 和乐观层。不要在客户端再 \`useEffect\` 拉一份同样的列表——那是第二真源，乐观对账会对到过期的那一份。

闭包捕获了过大的对象（整个 \`formState\`、整个 \`user\`），序列化变慢，而且可能把不该下发的字段带过边界。Action 参数保持 \`FormData\` + 几个标量。

## 8. 错误、pending、重试

三条错误通道，不要混：

- **返回值。** 校验、业务拒绝、可展示的失败。\`useActionState\` 的 state。
- **Error Boundary。** 渲染崩溃、未处理的 throw、\`use()\` 的 reject。
- **网络中断。** Action 卡在 pending。React 19 没有把离线做成默认自动重试；按钮应在 pending 时不可点，并给「还在提交」的文案。重复提交靠 \`disabled\`，不靠「再写一个 debounce hook」。

重试：把上一次 \`FormData\` 留下来再调 \`formAction\`。\`useFormStatus().data\` 只在飞行中有。落地后要重试，自己 \`useRef\` 存一份，或让用户再点一次（输入还在不受控字段里）。受控输入被你在提交时 \`setValue('')\` 清掉，失败就无法重试——清值放成功分支。

\`useActionState\` 的 state 在下一次成功之前会一直留着上一轮错误。成功时必须返回一份干净的 \`{ ok: true }\`，不要 \`return prev\`。

## 9. 取舍：Action vs 自己 fetch vs 路由跳转

| 路径 | 适合 | 不要用在 |
|---|---|---|
| \`<form action={serverAction}>\` | 突变、要刷新 RSC、要无 JS 也能提交 | 上传进度条、流式 webhook、非表单 REST |
| \`useActionState\` + 返回值 | 校验错误要留在页上 | 成功后必须换 URL 的支付回跳（用 \`redirect\`） |
| \`useOptimistic\` | 可回滚字段 | 钱、库存扣减的唯一真源 |
| \`use()\` | 客户端读已有 Promise / 条件读 Context | 替代 \`useEffect\` 发请求 |
| 自己 \`fetch\` + Route Handler | 细进度、取消、非 HTML 协议 | 普通表单——你会把 pending 再造一遍 |

成功后要跳转，在 Server Action 里 \`redirect()\`。它抛一个控制流异常，不要 \`try/catch\` 把它吃掉。需要「成功仍留在本页」才返回 state。

## 10. 排障：无限挂起、乐观回不去、表单丢字段

1. **Suspense 转圈到死。** \`use()\` 的 Promise 每次 render 都新。把它抬到父级或 \`cache()\`。
2. **\`useFormStatus\` 永远 false。** hook 不在 form 子树。把按钮拆成子组件。
3. **乐观条目闪一下消失又出现。** \`key\` 从 tmp 换成服务器 id。对齐 id，或接受 remount。
4. **乐观停在「发送中」。** 父级权威没更新：Server Action 忘了 \`revalidatePath\` / \`updateTag\`，或客户端自己又持有一份旧 \`messages\` state 当权威。权威必须来自 server props。
5. **字段丢失。** 受控组件没写 \`name\`，\`FormData\` 是空的。Action 协议走的是原生表单字段，不是 React state。要么 uncontrolled + \`name\`，要么提交前手动 \`FormData.set\`。
6. **校验失败整页白屏。** Action \`throw\` 了。改成返回值。
7. **连点双写。** 没 \`disabled={pending}\`。加。幂等 key 放服务端。
8. **\`bind\` 的 id 被篡改。** 那不是加密。鉴权以 session 为准。
9. **\`use()\` 在客户端 fetch。** 没有稳定引用，也没有 RSC payload。改回 Server Component \`await\`，或用查询库管缓存。

## 11. 和缓存失效叠在一起

Action 成功只改了 DB，没有 \`revalidateTag\` / \`updateTag\` / \`revalidatePath\`，RSC 权威不变，乐观层卸完就回到旧列表——看起来像「乐观 bug」，其实是缓存生命周期那篇的层没刷。两个 API 要一起设计：写函数返回新投影，失效函数点名那些 tag。

\`updateTag\` 给当前用户读己之写：改完显示名，这次导航就要新的。\`revalidateTag(tag, 'max')\` 给其他人 SWR。不要只用 \`router.refresh()\` 假装失效——refresh 打当前段，打不到没挂载的详情页的 Data Cache。

\`useActionState\` 的 permalink 和 Full Route Cache 是另一处咬合：无 JS 提交会 GET/POST 到 permalink，那条路由必须能渲染「带错误 state」的版本，否则渐进增强只在有 JS 时成立。多数内部工具可以放弃无 JS；对公开表单不要假装支持。

## 12. 小结

React 19 把突变收成 Action：一次过渡，一份 pending，一份返回值，一份可卸掉的乐观层。\`useActionState\` 管返回值和 pending，\`useFormStatus\` 管子树里的按钮，\`useOptimistic\` 管权威和增量的对账，\`use()\` 管渲染期读 Promise。非法状态是：把 Promise 当一次性值在 render 里 new、把业务错误 throw 成崩溃、把不可回滚的事当乐观、把 \`bind\` 当保密。和 Next 叠在一起时，Action 的最后一行是失效，不是 \`console.log\`。下一篇从样式引擎说：Tailwind v4 把 token 放回 CSS，而不是再生成一份巨型工具类文件。
`,

  "tailwind-css-v4-and-modern-styling": `把 Tailwind v4 理解成「v3 换了个更快的 JIT」，会在主题、变体和 \`@apply\` 上立刻失效。v4 的内核是 Oxide（Rust）+ Lightning CSS：扫描源码、生成原子类、做 \`@import\` / 嵌套 / 前缀，是一条 CSS 管线，不是「先用 JS 配一份 theme 对象再吐 CSS」。设计 token 进 \`@theme\`，变成原生 CSS 变量；工具类仍是一个类一条声明。约束来自变量和约定，不来自运行时 CSS-in-JS。

这篇文章只讲这条管线：token 怎样变成 \`bg-brand-500\`、层和变体怎样叠优先级、自定义为什么改走 \`@utility\` / \`@custom-variant\`、和组件边界怎么切。读完你应该能独立回答三个问题：为什么动态拼接的类名仍然不生效、暗色主题为什么不该复制两套颜色类、\`@apply\` 在 v4 里为什么要 \`@reference\`。

## 1. 原子类还在，变的是谁生成它们

v3：\`@tailwind base/components/utilities\`，\`tailwind.config.js\` 的 \`content\` 数组告诉扫描器去哪找类名。v4：一行 \`@import "tailwindcss"\`，扫描器自己从项目里找，尊重 \`.gitignore\`。配置可以没有 JS 文件。

\`\`\`css
@import "tailwindcss";

@theme {
  --color-brand-500: oklch(0.63 0.2 250);
  --font-sans: "Inter", ui-sans-serif, system-ui;
  --spacing-18: 4.5rem;
  --breakpoint-3xl: 120rem;
}
\`\`\`

\`--color-brand-500\` 不是随便起的变量名。命名空间决定工具类：\`color\` → \`bg-brand-500\` / \`text-brand-500\` / \`border-brand-500\`；\`font\` → \`font-sans\`；\`spacing\` → \`p-18\` / \`m-18\` / \`gap-18\`；\`breakpoint\` → \`3xl:\`。写错命名空间，变量存在，类不存在。这是类型系统那种「非法状态不可表示」在 CSS 里的弱版：约定即生成规则。

Oxide 扫的是源码文本，不是 AST 语义。\`clsx('bg-' + color)\`、\`styles[dynamic]\`、从 CMS 回来的类字符串，扫描器看不见完整 token，就不会生成那条规则。生产里类丢失，先问是不是动态拼接，再问是不是文件在 \`node_modules\` 里没被扫到。后者用 \`@source\`：

\`\`\`css
@source "../node_modules/@acme/ui/dist";
@source not "../fixtures";
\`\`\`

自动扫描不是「什么都能变」。它只是少写 \`content: []\`。静态完整性这条不变量从 v3 带到 v4，没有放松。

## 2. Oxide 和 Lightning CSS：构建期发生了什么

一次开发保存大致是：文件变更 → Oxide 扫类名差量 → 生成对应工具类 → Lightning CSS 做嵌套展开、\`@import\` 内联、语法降级和压缩。增量经常是个位数毫秒。所以「CSS 构建太慢」在 v4 项目里多半不是 Tailwind，是别的插件或整份 JS 打包。

它仍然是构建期。浏览器拿到的是 CSS 文件，不是一个运行时去 \`insertRule\`。主题切换能很快，是因为变量在运行时改，不是因为引擎在运行时编译新的工具类。\`hover:bg-brand-500\` 在产物里已经存在；暗色只是让 \`--color-brand-500\` 指向另一个值，或让 \`.dark\` 变体那条规则生效。

Lightning CSS 的浏览器基线比 PostCSS + Autoprefixer 的「尽力兼容 IE」更硬。v4 官方基线大约是 Safari 16.4+、Chrome 111+、Firefox 128+。要古董浏览器，留在 v3。这不是口味，是 \`@property\`、cascade layers、\`color-mix()\` 这些特性的地板。

## 3. \`@theme\`：token 进 CSS 变量

\`@theme\` 块里的变量会注册进 Tailwind 的主题，并默认暴露为 \`:root\` 上的 CSS 变量。组件里可以 \`background: var(--color-brand-500)\`，和 \`bg-brand-500\` 指向同一份。设计系统和工具类终于共用一个真源。

\`\`\`css
@theme {
  --color-fg: var(--color-neutral-900);
  --color-bg: var(--color-neutral-50);
}

@layer base {
  .dark {
    --color-fg: var(--color-neutral-50);
    --color-bg: var(--color-neutral-950);
  }
}
\`\`\`

暗色模式改变量，页面上 \`text-fg\` / \`bg-bg\` 跟着变。不要写 \`dark:bg-neutral-950 dark:text-neutral-50\` 复制每一个组件。复制是 v3 时期的权宜：那时 token 和类的对应要经过 JS config，运行时改 theme 不自然。v4 把权宜收回去。

\`@theme inline\` 一类写法让某些 token 只参与生成、少一层 var 间接。颜色透明度在 v4 走 \`color-mix()\`：\`bg-brand-500/50\` 不再依赖独立的 \`--tw-bg-opacity\` 那套。读生成 CSS 时看到 \`color-mix\`，不要改回旧的 opacity 变量黑魔法。

间距、字体、圆角同样是变量。\`p-[13px]\` 这种任意值仍可用，但会把设计系统凿出洞。洞多了，页面上出现 13、14、15px 三种「差不多的空隙」，原子化的约束就死了。任意值是逃生口，不是默认。

## 4. 层、变体、优先级

v4 用原生 \`@layer\`：theme、base、components、utilities。层之间的优先级由层决定，不由源码顺序猜。utilities 层高于 base，所以 \`p-4\` 能盖掉 base 里的 \`p { margin: ... }\`。你自己写的未分层 CSS 会跑到层外，**比所有层都高**——这是「我加了一行全局 CSS，Tailwind 全失效」的常见根因。把它放进 \`@layer base\` 或 \`@layer components\`。

变体从左到右组合：\`dark:md:hover:bg-brand-500\`。v3 有些版本是右到左，迁移时选择器会换含义。\`group-\`、\`peer-\`、\`has-\`、\`not-\`、\`in-\` 可组合。\`@custom-variant\` 用来登记项目自己的模式，而不是再写一堆 \`plugin\`：

\`\`\`css
@custom-variant theme-midnight (&:where([data-theme="midnight"] *));
\`\`\`

之后 \`theme-midnight:bg-black\` 就是合法工具类。变体是选择器模板，不是 JS 回调。能用选择器表达的，不要写插件。

容器查询成为一等变体：\`@container\` 标记容器，\`@md:p-8\` 按容器宽度而不是视口。组件在侧栏和主列要不同 padding，这是正确的轴。继续用 \`md:\` 视口变体给「本来是组件级」的布局，是把页面宽度误当成组件宽度。

## 5. \`@utility\`：自定义从插件回到 CSS

v3 自定义工具类：\`plugin(({ addUtilities }) => ...)\`。v4：

\`\`\`css
@utility tab-4 {
  tab-size: 4;
}

@utility tab-* {
  tab-size: --value(integer);
}
\`\`\`

\`tab-4\` 从此能跟 \`hover:\`、\`md:\` 走，因为它登记进 utilities 层。写在随便一个 CSS 文件里的 \`.tab-4 { tab-size: 4 }\` 没有变体，也没有层，行为不同。

旧 \`theme()\` 函数不再是主路。要用 token，写 \`var(--color-brand-500)\` 或 \`--spacing(4)\` 这类 v4 提供的函数。\`@apply\` 仍能用，但在 CSS Modules / Vue SFC 的 \`<style>\` 里必须先 \`@reference\` 一份主题，否则 \`@apply flex\` 找不到 \`flex\` 是什么：

\`\`\`css
@reference "../../app.css";

.card {
  @apply rounded-lg p-4 bg-bg text-fg;
}
\`\`\`

\`@apply\` 把原子类又糊回一坨组件类，等于放弃「在 JSX 里能看见布局」的优点，换来「这个 class 到底生成了什么」的间接。少量重复（\`flex items-center gap-2\`）抽 React 组件，不要抽成 \`@apply\` 工具。重复三次以上再抽。抽早了，你的 \`btn-primary\` 会变成第二套设计系统，和 \`@theme\` 抢真源。

## 6. 和组件的边界：类名爆炸在哪消化

原子化的成本是 JSX 上的类字符串。消化它的地方是 **React 组件边界**，不是 CSS 抽象层。\`<Button variant="primary" size="sm">\` 内部写死那一串工具类；调用方不拼类。

\`\`\`tsx
const variants = {
  primary: "bg-brand-500 text-white hover:bg-brand-600",
  ghost: "bg-transparent text-fg hover:bg-neutral-100",
} as const;

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof variants;
};

export function Button({ variant = "primary", className = "", ...rest }: ButtonProps) {
  return <button className={\`inline-flex items-center gap-2 rounded-md px-3 py-1.5 \${variants[variant]} \${className}\`} {...rest} />;
}
\`\`\`

\`className\` 逃生口要有，但调用方每用一次逃生口就是一次设计系统泄漏。ESLint 可以限制某些包路径不准出现 \`className=\`。这比再上 CSS-in-JS 便宜。

\`cva\` / \`tailwind-variants\` 这类库仍能用，它们只是字符串拼盘。不要在运行时根据 theme 对象生成新类名——扫描器看不见运行时。变体表必须是静态字面量。

## 7. 主题切换：改变量，不要分叉整棵树

运行时切主题：在 \`html\` 上改 \`class="dark"\` 或 \`data-theme\`，CSS 变量变，所有 \`bg-bg\` / \`text-fg\` 跟着变。React 不必为切主题重渲整棵树。闪白是另一件事：首屏 HTML 必须已经带对主题 class，否则第一帧用 \`:root\` 的亮色，水合后再切。把主题写进 cookie / \`localStorage\` 的内联脚本放 \`<head>\`，在 React 之前跑。

\`\`\`tsx
export function ThemeScript() {
  const js = \`document.documentElement.dataset.theme = localStorage.getItem("theme") || "light";\`;
  return <script dangerouslySetInnerHTML={{ __html: js }} />;
}
\`\`\`

不要用 \`useEffect\` 在水合后才读 \`localStorage\` 设 dark——那正好制造 CLS 和闪白。性能那篇会再碰到：主题闪是 LCP/CLS 问题，不是 Tailwind 问题。

多主题（品牌白标）同样走变量集。\`@theme\` 给默认，\`[data-brand=acme]\` 覆盖一组 \`--color-*\`。不要为每个品牌复制一份组件。

## 8. 和 CSS Modules、原生 CSS、CSS-in-JS 混用

混用时必须规定**谁赢**。推荐：

- 布局、间距、颜色、排版：Tailwind 工具类 + \`@theme\`。
- 真正的图形（复杂 \`clip-path\`、关键帧插值）：原生 CSS，放 \`@layer components\`。
- 第三方库自带的 class：不要 \`@apply\` 去「统一」，用包装组件在外层补间距。

CSS-in-JS（runtime）和 Tailwind 叠在同一节点上，优先级靠生成顺序和 \`!important\`，排障成本高于任何一边单独用。新代码不要再为「这个按钮要动态颜色」上 runtime CSS-in-JS——动态颜色改变量。编译期 CSS-in-JS（zero-runtime）可以和原子类共存，但仍有两套 token 的风险。能删就删。

v3 的 \`tailwind.config.js\` 用 \`@config "./tailwind.config.js"\` 还能挂一段时间。新 token 不要再往 JS 里加。迁移是单向的：JS 只出不进。

## 9. 取舍

- **原子类 + 变量：** 约束强、产物可预测、主题便宜。代价是 JSX 嘈杂、动态类名不可见。
- **CSS Modules：** 局部作用域清爽。代价是 token 漂移、变体（hover/dark/container）要手写。
- **runtime CSS-in-JS：** 动态极强。代价是运行时、缓存失效、和 RSC 不熟——样式生成跑在客户端，RSC 的零 bundle 被打穿。
- **\`@apply\` 组件类：** 看起来整洁。代价是间接、和原子类双真源。

默认：Tailwind 做设计系统，React 做组合，原生 CSS 做图形。三层都去「抽象按钮」，就会有三个 Button。

## 10. 排障

1. **类写了没样式。** 动态拼接；或文件没扫到（\`@source\`）；或类名打错命名空间（\`--color-brand\` 写成 \`--brand-color\`）。看生成 CSS 里有没有这条规则，比看 JSX 快。
2. **我的全局样式被盖 / 我盖不住 Tailwind。** 层。未分层的文件在层外；\`@layer utilities\` 里的东西盖 \`base\`。用 DevTools 看规则属于哪一层。
3. **\`@apply\` 报 unknown utility。** 缺 \`@reference\`。或那个类本就是动态任意值，不存在于主题。
4. **暗色不生效。** 自定义了 \`@custom-variant dark\` 却和 \`prefers-color-scheme\` 那套叠错选择器；或只改了 class 没改变量。先看 \`html\` 的 class / data，再看 \`--color-bg\` 的计算值。
5. **包体积暴涨。** 扫到了 \`node_modules\` 里的故事书或测试夹具。\`@source not\`。任意值爆炸（每个组件一个 \`w-[347px]\`）也会堆规则。
6. **HMR 丢样式。** 多份 CSS 入口重复 \`@import "tailwindcss"\`，各生成一套。全应用一个 CSS 入口。
7. **旧浏览器花了。** 基线不够。不要给 v4 加一串 Autoprefixer 幻想。

## 11. 设计系统怎么进仓库

一份 \`app.css\`（或 \`packages/ui/theme.css\`）是 token 的唯一入口。颜色用 OKLCH，避免 HSL 调亮度时色相发灰。间距用一条尺度（4px 网格），不要 3、4、5 混用。断点与容器查询分开命名，避免 \`md\` 既是视口又是容器。

组件库（\`packages/ui\`）依赖这份 CSS，不在每个组件再声明 \`--color-brand-500\`。应用可以覆盖变量，不能覆盖组件内部的任意值。PR 检查：新增 \`bg-[#...]\` 要说明为什么 token 不够。不够就加 token，不要加任意值。

和 Next 的关系：把 \`app.css\` 引进根 layout。不要在每个 page 再 import 一次 Tailwind。RSC 不执行 CSS-in-JS；原子类是字符串，对 RSC 友好。这是它在 App Router 里仍占上风的物理原因，不是社区口味。

## 12. 小结

v4 的原理是「扫描源码生成原子类 + 用 \`@theme\` 把 token 变成 CSS 变量」。Oxide 加快的是这条构建管线，没有取消静态扫描这条不变量。主题走变量，组合走 React 组件，图形走原生 CSS。动态类名、层外 CSS、\`@apply\` 双真源，是三类独立的事故。下一篇把「非法状态」从 CSS 命名空间换到 TypeScript：条件类型和映射类型是编译期函数，不是注释。
`,

  "frontend-typescript-advanced-type-system": `把高级类型理解成「给 IDE 看的注释」或「类型体操比赛」，会在 SDK 和组件库边界上立刻失效。条件类型、映射类型、模板字面量类型是**编译期函数**：输入一个类型，输出另一个。运行时 0 成本。它们的正当用途是把非法状态从调用方的自动补全里删掉，不是把错误信息变成一页 \`extends infer\`。过度体操和过度抽象是同一种病，只是发生在类型层。

这篇文章只讲能在生产边界上赚钱的那几条：distributive 怎么把联合拆开、\`infer\` 怎么抽出形状、映射怎么改字段、模板字面量怎么拼事件名、\`satisfies\` 和品牌类型怎么守住字面量。读完你应该能独立回答三个问题：为什么 \`ToArray<string | number>\` 是 \`string[] | number[]\`、什么时候该停手改写成接口、\`noUncheckedIndexedAccess\` 打开之后 \`arr[0]\` 为什么变成可能 \`undefined\`。

## 1. 类型是编译期函数，不是装饰

\`interface User { id: string }\` 是命名一个形状。\`type X = T extends U ? A : B\` 是算一个形状。生产代码两者都要：领域对象用接口，变换用 \`type\`。把变换写成 10 个 \`interface\` 继承，调用方看不懂；把领域对象写成 10 层 \`infer\`，错误信息看不懂。

类型检查发生在编译期。\`as\` 是在对检查器撒谎。撒谎一次，边界上的非法值会在运行时以 \`undefined is not a function\` 出现。高级类型的目标是**少撒谎**：让错误的调用在编辑器里红，而不是在线上红。

\`any\` 是退出检查。\`unknown\` 是「必须先收窄」。从 JSON / 网络进来的值是 \`unknown\`，不是 \`any\`，也不是你希望的 \`User\`。用校验函数（zod 一类，或手写谓词）把它变成 \`User\`。类型层的 \`as User\` 不读网络。

## 2. 条件类型与 distributive

\`T extends U ? X : Y\` 在 \`T\` 是**裸类型参数**时对联合分配：

\`\`\`ts
type ToArray<T> = T extends unknown ? T[] : never;
type A = ToArray<string | number>; // string[] | number[]
\`\`\`

这是联合的 \`map\`。事件表、\`Promise\` 展开、把 \`A | B\` 变成函数重载，都靠它。不想分配，把 \`T\` 包进元组：

\`\`\`ts
type ToArrayWhole<T> = [T] extends [unknown] ? T[] : never;
type B = ToArrayWhole<string | number>; // (string | number)[]
\`\`\`

\`string[] | number[]\` 和 \`(string | number)[]\` 不是一回事。前者不能 \`push\` 一个 number 进「可能是 string[]」的那个分支。选错的症状是：你认为函数接受联合，调用方传入联合却报错——往往是分配把返回值拆碎了，或反过来该拆没拆。

\`never\` 在分配里是空联合。\`Exclude<T, U> = T extends U ? never : T\` 能把成员剔掉，是因为 \`never | X\` 就是 \`X\`。\`Extract\` 相反。过滤联合用它们，不要手写一长串三元。

\`T extends any\` 看起来无意义，它的作用就是触发分配。看到它不要删，先问是不是故意在 map 联合。

## 3. \`infer\`：在模式里开一个绑定

\`infer U\` 只能出现在条件类型的 \`extends\` 右侧。它说：如果匹配这个形状，把这块名字叫 \`U\`。

\`\`\`ts
type Awaited<T> = T extends Promise<infer U> ? Awaited<U> : T;
type FirstArg<T> = T extends (first: infer P, ...rest: never[]) => unknown ? P : never;
type El<T> = T extends readonly (infer U)[] ? U : never;
\`\`\`

嵌套 \`Promise\` 用递归 \`Awaited\`。不要只剥一层还在文档里写「我们不套两层 Promise」——调用方会套。递归要有底：\`T extends Promise<infer U> ? Awaited<U> : T\` 碰到非 Promise 停。没底会 \`Type instantiation is excessively deep\`。那不是 TS 的 bug，是你的函数在类型层死循环。

\`infer\` 在多个位置同时出现时，每个都是独立绑定。\`T extends (a: infer A, b: infer B) => infer R\` 抽出参数和返回值。抽不出来就 \`never\`，调用方会在 \`never\` 上失败——这比抽成 \`any\` 好，失败是可见的。

生产里 \`infer\` 的正当对象是**你自己仓库的形状**：路由表、SDK 响应、组件 props。不要为 \`Array.prototype.reduce\` 的类型去复刻一遍 lib.es5.d.ts。

## 4. 映射类型：改字段，不要复制粘贴接口

\`{ [K in keyof T]: X }\` 遍历键。修饰符 \`readonly\` / \`?\` 可以加或减（\`-?\`、\`-readonly\`）。

\`\`\`ts
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type RequiredKeys<T> = { [K in keyof T]-?: T[K] };
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};
\`\`\`

\`as\` 重映射改键名：

\`\`\`ts
type Getters<T> = {
  [K in keyof T as \`get\${Capitalize<string & K>}\`]: () => T[K];
};

type EventMap = { click: MouseEvent; focus: FocusEvent };
type Handlers = {
  [K in keyof EventMap as \`on\${Capitalize<K>}\`]: (e: EventMap[K]) => void;
};
\`\`\`

\`Handlers\` 有 \`onClick\`、\`onFocus\`，参数类型跟着事件走。漏一个 \`onXxx\` 或参数写错，调用方立刻红。这就是组件库要的：props 从一份事件表生成，而不是手写 30 个可选回调。

\`K in keyof T as never\` 可以删键。\`Omit\` 的一种实现就是重映射到 \`never\`。自己写 \`Omit\` 前先用内置的；内置的错误信息更短。

映射默认保留可选和只读。\`T[K]\` 在 \`K\` 来自 \`keyof T\` 时可能已经是 \`T[K] | undefined\`（取决于 \`exactOptionalPropertyTypes\`）。抄片段时连同 \`tsconfig\` 一起抄，否则在 A 项目能编过的工具类型在 B 项目红。

## 5. 模板字面量类型：把字符串当联合

\`\`on\${Capitalize<K>}\`\` 在类型层做字符串拼接。\`K\` 是联合时，结果也是联合。路由、query key、CSS 变量名、i18n key，都能变成可补全的字面量。

\`\`\`ts
type Route = "/users" | "/users/:id" | "/posts/:id";
type ParamName<R extends string> = R extends \`\${string}:\${infer P}/\${infer Rest}\`
  ? P | ParamName<\`/\${Rest}\`>
  : R extends \`\${string}:\${infer P}\`
    ? P
    : never;

type UserParams = ParamName<"/users/:id">; // "id"
\`\`\`

解析路由参数是模板字面量的正经活。写错 \`id\` 成 \`Id\`，\`params.Id\` 红。不要用 \`Record<string, string>\` 当 params——那是在说任何键都合法。

模板类型会爆炸。\`\${A}\${B}\${C}\` 而 A/B/C 各 20 个成员，联合是 8000。TS 会慢或报过大。空间太大就不要生成，改成「前缀 + 品牌字符串」或运行时校验。类型要为补全和非法排除服务，不为穷举宇宙服务。

## 6. \`satisfies\`、\`as const\`、const 泛型

标注 \`const r: Record<string, string> = { home: '/' }\` 会把 \`'/' \` 放宽成 \`string\`，字面量丢了。\`as const\` 把值收成字面量，但对象变成 \`readonly\`，有时过窄。\`satisfies\` 检查形状、保留推断：

\`\`\`ts
const routes = {
  home: "/",
  user: "/users/:id",
} as const satisfies Record<string, string>;

type RouteKey = keyof typeof routes; // "home" | "user"
type Home = (typeof routes)["home"]; // "/"
\`\`\`

配置表、权限表、feature flag 用这个。既能保证值是字符串，又能在 \`routes.home\` 上拿到 \`"/"\`。

const 类型参数（\`<const T>\`）让函数在调用处推断字面量：

\`\`\`ts
function defineEvents<const T extends readonly string[]>(events: T) {
  return events;
}
const ev = defineEvents(["click", "focus"] as const);
\`\`\`

没有 \`const\`，\`T\` 往往是 \`string[]\`，后面的模板类型全废。SDK 的 \`defineConfig\`、\`defineRoutes\` 必须用 \`const\` 或 \`as const\`，否则高级类型在入口就丢了精度。

## 7. 品牌类型：把 \`string\` 不是 \`UserId\` 写成类型

\`string\` 能当 user id、也能当 post id。函数 \`getUser(id: string)\` 接受任何字符串。品牌类型用交叉一个不会在运行时存在的字段，把两种 \`string\` 分开：

\`\`\`ts
type Brand<T, B extends string> = T & { readonly __brand: B };
type UserId = Brand<string, "UserId">;
type PostId = Brand<string, "PostId">;

function userId(raw: string): UserId {
  if (!raw) throw new Error("empty id");
  return raw as UserId;
}

declare function getUser(id: UserId): Promise<unknown>;
\`\`\`

\`getUser(postId)\` 红。运行时仍是 string，没有额外字段。\`as UserId\` 只允许出现在校验函数里，这是品牌的唯一出口。到处 \`as UserId\` 等于没品牌。

和 \`enum\` 比：品牌不生成运行时对象。和 \`uuid\` 标称类比：没有构造函数开销。适合 id、非空字符串、经过校验的 email。不要给每一个字段都品牌，错误信息会变成 \`Brand<string, "Foo">\` 满屏。

## 8. 方差、索引、以及 \`undefined\`

函数参数逆变、返回值协变。\`(x: Animal) => void\` 不能当 \`(x: Dog) => void\` 用——调用方会传入 Dog，实现若只接受 Animal 的超类型……等一下：实现接受 Animal 其实能接受 Dog。TS 对函数参数默认是**双变**（bivariant）在方法上，严格函数类型（\`strictFunctionTypes\`）才对独立函数参数做逆变。打开它。组件的 \`onChange?: (v: T) => void\` 在严格模式下会暴露「子类型回调」错误，这是对的。

\`noUncheckedIndexedAccess\` 让 \`arr[0]\` 和 \`map[key]\` 变成 \`T | undefined\`。索引不是证明，是希望。打开后，\`users[0].id\` 会红，除非你先收窄。这会让很多「我知道一定有」的代码变吵。吵是因为那些地方本来就可能空。用 \`arr.at(0)\` 或 \`if (arr.length)\`，不要 \`arr[0]!\`。

\`in\` / \`out\` 标记泛型方差（TS 4.7+）：\`interface Box<out T>\` 协变。写库时标上，调用方的错误会落在声明而不是使用点。应用代码很少需要手写。

## 9. 取舍：体操、简单接口、运行时校验

| 工具 | 买到什么 | 代价 |
|---|---|---|
| 接口 + 联合 | 可读、错误短 | 变换要手写 |
| 条件/映射/模板 | 一份表生成全部 API | 错误长、编译慢、新人读不懂 |
| 品牌类型 | id 互斥 | \`as\` 纪律；JSON 边界仍要校验 |
| \`satisfies\` | 形状检查 + 字面量 | 老 TS 没有 |
| zod 等运行时 | 真的挡住网络脏数据 | 运行时成本、schema 和类型双份 |

边界（网络、localStorage、query string）必须有运行时校验。类型在边界上是断言，不是检查。内部，TS 已经收窄的值不要再 parse 一遍。两边都做「深拷贝 + 再校验」是把编译期保证扔了。

停手标准：错误信息超过三行、或 \`tsc\` 这个文件超过一秒、或只有作者能改这个 \`type\`。停手后改成显式接口 + 几个重载，比再加一层 \`infer\` 更负责任。

## 10. 排障

1. **「类型实例化过深」。** 递归没底，或联合爆炸。加终止条件，或把联合改成映射对象。
2. **分配行为不符合预期。** 裸 \`T\` vs \`[T]\`。用一个测试类型文件 \`type _ = Assert<Equal<Actual, Expected>>\` 钉住。
3. **字面量变成 \`string\`。** 缺 \`as const\` / \`satisfies\` / \`const\` 泛型。从入口追推断，不要在末尾 \`as\`。
4. **\`T[K]\` 是 \`T[K] | undefined\`。** \`noUncheckedIndexedAccess\` 或可选字段。用 \`NonNullable\` 或收窄，不要关编译选项来消红。
5. **库的回调类型不匹配。** \`strictFunctionTypes\` 和方法双变。把回调写成独立函数类型属性，不要写成方法语法（方法双变）。
6. **JSON.parse 之后一切皆 \`any\`。** 开 \`noImplicitAny\`，给 parse 包一层校验。
7. **IDE 卡。** 巨型模板联合。砍生成范围。

\`Equal\` 辅助可以自己写：\`type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false\`。把工具类型的预期钉在 \`types/xxx.test-d.ts\`，和单测同等重要。类型回归不会在 Jest 里红，会在调用方的编辑器里红——那时已经晚了一个版本。

## 11. 在 API 边界怎么用

SDK：一份 \`paths.ts\` 描述路由和方法，映射出 \`client.get('/users/:id', { params: { id } })\` 的 params 和响应。响应类型从 OpenAPI 生成，或从 zod schema \`z.infer\`。不要手写第三份。生成物提交进仓库，CI 校验「schema 变了生成物必须变」。

组件库：\`variant: 'primary' | 'ghost'\` 用字面量联合，不要 \`string\`。\`as const satisfies\` 一张 variant 表，再映射出 \`className\` 表。props 用 \`Discriminated union\`：\`{ type: 'link'; href: string } | { type: 'button'; onClick: () => void }\`，比 \`href?: string; onClick?: () => void\` 少一个非法组合（link 没有 click、button 没有 href）。

非法状态不可表示，优先于工具类型炫技。能用联合解决的，不要 \`infer\`。能用品牌解决的，不要 \`string\` 加注释。

Next / Nest 的 DTO：前端不要 \`interface\` 一份、后端 \`class\` 一份还字段不同。共享 \`packages/types\`，用类型而不是 class（class 在前端多余）。运行时校验放 Nest 的 pipe 和前端的表单，schema 能共享就共享，不能共享就至少共享字段名和联合。Monorepo 那篇会把构建图接上。

## 12. 小结

高级类型是编译期函数：条件做 if，分配做 map，\`infer\` 做解构，映射做字段变换，模板做字符串联合。\`satisfies\` 保住字面量，品牌把 \`string\` 切开，索引访问承认 \`undefined\`。目的是把非法调用挡在编辑器里。体操超过可读性就停。边界上类型代替不了校验。下一篇把「运行时状态图」从类型里拿出来：Zustand 的中心仓库和 Jotai 的原子网，差的是图的形状，不是谁更现代。
`,

  "frontend-state-management-zustand-vs-jotai": `把「选状态库」理解成选口味，会在渲染粒度和 SSR 水合上立刻失效。Zustand 和 Jotai 都能在 React 外读写，都比「只靠 Context」少一次整树重渲的默认陷阱。真正的差别是**状态图的形状**：Zustand 是一份（或几份）可切 selector 的中心仓库；Jotai 是一张原子依赖图，派生节点自动订阅上游。数据本来就是一棵领域对象（用户、购物车、编辑器文档），中心仓库更省事。数据本来就是一堆互不相关的开关和格子，原子网更省事。选反了不是性能微调，是每天都在和订阅粒度打架。

这篇文章只讲这张图：Context 为什么常常不是答案、selector 怎么切、原子怎么连、异步该不该进状态库、RSC 之后客户端状态还剩什么。读完你应该能独立回答三个问题：为什么 \`useStore()\` 不带 selector 会整页重渲、Jotai 的 \`Provider\` 不包为什么 SSR 会串用户、什么时候两边都不要、只把状态放 URL。

## 1. 先问状态图长什么样

画一张图，节点是会变的数据，边是「谁从谁算出来」。然后问三件事：

1. **有几个真源？** 购物车是一个对象，还是每个商品行一个独立开关？
2. **谁会一起变？** 一起变的，放一起订阅；从不一起变的，硬塞一个 store 会让无关组件重渲，或拆成原子却要手动同步。
3. **寿命？** 页面级、会话级、跨路由、要进 localStorage、要和 URL 同步——寿命不同，不该进同一张图。

状态库解决的是「可变数据的订阅」。服务器来的权威列表，RSC 已经给了 props，不必再抄进 store。抄了就有两个真源：Action 刷新了 props，store 还是旧的。乐观更新那篇说过，权威在 server props。客户端 store 只放：**还没上服务器的交互态**（草稿、选中 id、面板开合）、以及**跨路由要活着且不属于 URL 的会话态**。

URL 能表达的（tab、分页、筛选）放 URL。刷新、分享、后退免费得到。再做一份 store 镜像，是第三真源。

## 2. Context 为什么常常不是答案

\`useState\` + Context 能传值。默认行为是：\`value\` 引用变了，所有 \`useContext\` 的消费者重渲。把整份 app state 放进一个 Context，等于没有 selector。拆很多 Context 等于手写一张订阅图，还没有 Devtools。

\`useSyncExternalStore\` 是 React 18 给外部 store 的合法入口：订阅、快照、\`getServerSnapshot\`。Zustand / Jotai 内部走它。自己用 Context「优化」到最后，会重新发明这两个库的一半，而且没有另一半（中间件、原子组合）。

Context 的正当位置：主题、i18n、DI（把 store 本身注入，而不是注入 state 值）。注入 store，消费者用 selector 读字段。注入 value 对象，你已经输了粒度。

## 3. Zustand：一个 store，切 selector

\`create\` 返回 hook。不带参数等于订阅整个 state；带函数等于只订阅切片。切片引用变了才重渲。

\`\`\`ts
import { create } from "zustand";

type CartItem = { id: string; qty: number };
type CartState = {
  items: CartItem[];
  add: (id: string) => void;
  setQty: (id: string, qty: number) => void;
};

export const useCart = create<CartState>()((set, get) => ({
  items: [],
  add: (id) => {
    const cur = get().items;
    const i = cur.findIndex((x) => x.id === id);
    if (i === -1) set({ items: [...cur, { id, qty: 1 }] });
    else set({ items: cur.map((x, j) => (j === i ? { ...x, qty: x.qty + 1 } : x)) });
  },
  setQty: (id, qty) => set({ items: get().items.map((x) => (x.id === id ? { ...x, qty } : x)) }),
}));
\`\`\`

组件：

\`\`\`tsx
const items = useCart((s) => s.items);
const add = useCart((s) => s.add);
\`\`\`

\`add\` 函数引用稳定（默认），\`items\` 只有数组换新引用时重渲。\`useCart((s) => ({ items: s.items, add: s.add }))\` 每次返回新对象，**每次都重渲**。要返回对象，用 \`shallow\` 比较，或拆成两次 hook。这是 Zustand 第一坑，比选库争论常见十倍。

\`set\` 是浅合并。\`set({ items })\` 不动其它字段。嵌套对象要自己不可变更新。没有 Immer 就老老实实展开；用 \`immer\` 中间件可以 \`set((s) => { s.items.push(...) })\`，但那是中间件，不是默认。

多个 store 合法。用户会话一个，编辑器文档一个。不要做 \`useAppStore\` 上帝对象——那是 Redux 早期单体再加一个 hook。selector 再细，任意字段变化仍可能碰到「谁不小心订阅了根」。拆 store 按变化率和寿命，不按文件数量。

## 4. 中间件、Devtools、不可变

Zustand 中间件是函数包装 \`create\`。\`devtools\`、\`persist\`、\`subscribeWithSelector\` 常见。\`persist\` 把切片写 \`localStorage\`，SSR 时服务器没有 \`localStorage\`，水合会对不齐。处理：\`skipHydration\` + 客户端 \`useEffect\` 里 \`rehydrate\`，或接受第一帧用默认值。不要在模块顶层读 \`localStorage\` 当 initial——那会在服务器和浏览器各一份，水合警告，严重时串出「服务器 HTML 带用户 A 的草稿」。

\`\`\`ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useDraft = create<{ text: string; setText: (t: string) => void }>()(
  persist(
    (set) => ({
      text: "",
      setText: (text) => set({ text }),
    }),
    { name: "draft", skipHydration: true },
  ),
);
\`\`\`

订阅粒度：\`subscribeWithSelector\` 让 \`store.subscribe(selector, listener)\` 只在切片变时响。React 外的代码（非 React 模块、WebSocket handler）用 \`useCart.getState()\` / \`useCart.setState()\`，不要为了改一行去 \`createRoot\`。这是 Zustand 相对 Context 的本质优势：store 先于 UI 存在。

## 5. Jotai：原子和依赖收集

一个 atom 是一个节点。组件 \`useAtom(x)\` 只订阅 x。派生 atom 在读上游时自动登记依赖，上游变了才重算。

\`\`\`ts
import { atom } from "jotai";

export const countAtom = atom(0);
export const doubleAtom = atom((get) => get(countAtom) * 2);
export const incAtom = atom(null, (get, set) => set(countAtom, get(countAtom) + 1));
\`\`\`

写 atom（第三种）把命令收成节点，组件 \`useSetAtom(incAtom)\` 不订阅 count，点按钮不因 count 变而重渲——按钮本就不必重渲。这是原子图的细粒度：读和写可以分开订。

\`Provider\` 给一张独立的原子存储。SSR 时**每个请求一个 Provider**，否则默认存储是模块单例，用户 A 的 count 会漏到用户 B。这是 Jotai 第一坑，比 Zustand 更狠，因为 atom 定义在模块顶层，看起来像「没有全局状态」。没有 Provider，就是全局。

\`\`\`tsx
import { Provider } from "jotai";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return <Provider>{children}</Provider>;
}
\`\`\`

原子过多时，心智负担从「store 太大」变成「谁依赖谁」。一张 200 节点的图没有文档，和上帝 store 一样不可维护。原子要有边界：按功能文件夹导出一组 atom，不要从 \`atoms.ts\` 倒出 80 个。

## 6. 异步：状态库不是查询库

Zustand 里写 \`fetchUsers: async () => { const r = await api(); set({ users: r }) }\` 能跑。并发、缓存、重试、失效、去重，你都要自己做。Jotai 的 async atom 能 \`await get(otherAtom)\`，Suspense 友好，但仍然不是规范化缓存。

列表、详情、分页、失效标签，用 TanStack Query（或 SWR）。状态库放：当前选中 id、草稿、UI 开关。Query 放：服务器数据。选中 id 变了，queryKey 变了，query 去拉。不要把服务器列表抄进 Zustand 再在 Action 后手动同步——你在实现一个更差的 query cache。

\`\`\`ts
import { atom } from "jotai";

export const selectedIdAtom = atom<string | null>(null);
\`\`\`

\`\`\`tsx
const id = useAtomValue(selectedIdAtom);
const { data } = useQuery({ queryKey: ["product", id], queryFn: () => getProduct(id!), enabled: !!id });
\`\`\`

异步 atom 适合「派生过程本身是异步，且寿命跟组件树走」的局部计算，不适合当 HTTP 缓存。错误、loading、stale 这些状态 Query 已经建模。再造一份 \`{ loading, error, data }\` 在 store 里，是 2018 年的写法。

## 7. SSR 水合：两份快照必须同一份

\`useSyncExternalStore\` 要求服务器快照和客户端第一帧快照一致。不一致：水合 mismatch，React 会丢掉服务器 HTML。表现是闪一下、输入丢了、警告刷屏。

规则：

- 服务器不要读 \`window\` / \`localStorage\` / \`document.cookie\` 来初始化 store（cookie 在 RSC 里用 \`cookies()\` 读，作为 props 传下来，不要当 store 初始值的隐式输入）。
- 需要浏览器存储的状态，第一帧用默认值，mount 后再 hydrate。接受第一帧无草稿。
- Jotai：请求级 \`Provider\`。Zustand：不要模块单例里塞用户数据；用户数据从 RSC props 来，或显式 \`createStore()\` 每请求一份。

\`\`\`ts
import { createStore } from "zustand";

export function createCartStore(init?: Partial<CartState>) {
  return createStore<CartState>()((set, get) => ({
    items: init?.items ?? [],
    add: (id) => { /* 同前 */ },
    setQty: (id, qty) => { /* 同前 */ },
  }));
}
\`\`\`

每请求 \`createCartStore()\`，用 Context 把 store 传下去。模块级 \`useCart\` 单例只适合**没有用户私有数据**的真正全局 UI（如「侧栏开合」，且你接受 SSR 永远默认闭合）。

## 8. 和 RSC 的分工

Server Component 不能用 \`useState\` / Zustand hook。它能读 cookie、能 \`await\` 数据库、能把结果当 props 传给客户端叶子。叶子里才出现 store。

合法：RSC 拉购物车快照 → 客户端 \`useCart\` 以快照为初始 → 本地加减 → Action 提交 → \`revalidatePath\` → RSC 再传新快照。非法：RSC 和客户端各 fetch 一次购物车；或 store 在模块单例里活过导航，RSC 新快照来了 store 不理。

导航时 App Router 保活 layout。layout 里的客户端 store 不会因为 page 换了而重置。这是「跨页购物车还在」的原因，也是「从用户 A 切到登录页再进用户 B，store 还是 A」的原因。登出 Action 必须显式 \`store.setState(initial)\`，不要指望卸载。layout 不卸载。

## 9. 取舍

| | Zustand | Jotai |
|---|---|---|
| 图 | 中心对象 | 原子 DAG |
| 订阅 | 你写 selector | 依赖收集 |
| 心智 | Redux 简化 | Recoil / 电子表格 |
| SSR | 单例易踩私有数据 | 必须 Provider |
| 工具 | Devtools 时间旅行熟 | 图可视化看依赖 |
| 适合 | 领域对象、编辑器文档 | 大量离散状态、派生多 |

团队从 Redux 来、有清晰的聚合根 → Zustand。页面是格子、筛选器、每个格子独立 → Jotai。同一功能里不要两个真源。可以在应用级 Zustand 放会话，在某个复杂页局部用 Jotai——但要画清楚边界，禁止两边互相同步同一字段。

都不适合：表单的瞬时输入（\`useState\`）、服务器列表（Query）、能放 URL 的筛选（\`searchParams\`）。

## 10. 排障

1. **无关组件跟着跳。** Zustand 没 selector，或 selector 返回新对象。Jotai 在组件里 \`useAtom\` 了过大的根原子。画订阅。
2. **水合警告。** 第一帧读了 \`localStorage\`。推迟 hydrate。
3. **串用户。** Jotai 没 Provider；Zustand 模块单例塞了用户数据。
4. **登出后还在。** store 在 layout，没重置。
5. **和 Query 打架。** 列表进了 store。删掉，只留 selectedId。
6. **乐观对不上。** store 当了权威。权威回 props。
7. **Devtools 里 action 名叫 \`anonymous\`。** \`set\` 第三参给名字；或用 \`devtools\` 中间件。没法复盘的 store 等于没法排障。
8. **测试里状态泄漏。** 单例 store 跨测试。每个测试 \`setState(initial)\` 或用 \`createStore\`。

## 11. 什么时候两边都不要

默认路径：RSC 给权威 → 客户端 \`useState\` 给叶子交互 → 要跨叶子再提升 → 提升到 URL 或提升到一个小 store。跳过前两步直接上全局库，是过早的中心化。

编辑器、画布、复杂表格，状态更新频率高、对象大，Context 和原子的每节点 hook 开销都可能成为问题。这时 Zustand 一个 store + 细 selector，或把热路径放进 \`useRef\` + 订阅（不经 React 渲染）是正当的。先量：\`React Profiler\` 看是不是这条状态链路。不要因为文章标题有 Jotai 就把 K 线图拆成一万个 atom。

WebSocket 进来的数据：handler 里 \`setState\`，不要每条消息 \`useState\`。节流到动画帧。状态库在这里是外部事件的汇合点，这是 \`useSyncExternalStore\` 的本职。

## 12. 小结

状态库的原理是订阅粒度。Zustand 用中心仓库加 selector 买明确的领域对象；Jotai 用原子 DAG 买自动依赖和细订阅。Context 传值不传订阅。服务器数据进 Query，交互草稿进 store，可分享的进 URL，权威进 RSC props。SSR 要请求级存储，layout 保活要显式重置。选图的形状，不要选logo。下一篇把「快」从状态更新换成用户时间：LCP、INP、CLS 是三条不同的等待，对策不能共用一个「减包体积」。
`,

  "frontend-web-performance-core-web-vitals": `把 Web 性能理解成「把 JS 包减到 100KB」或「Lighthouse 再涨 10 分」，会在真实用户时间上立刻失效。Core Web Vitals 量的是用户能感到的三种等待：**看见**（LCP）、**点了之后下一次绘制**（INP）、**布局跳**（CLS）。三者独立。压了 bundle，LCP 仍可能被一张没设优先级的图拖死；主线程空了，CLS 仍可能被晚到的字体和广告撑开。优化要对着指标的定义下手，对着实验室分数下手会优化到一个不存在的用户。

这篇文章只讲定义、测量、以及 Next/React 里最常见的凶手。读完你应该能独立回答三个问题：这一页的 LCP 元素到底是哪一块像素、INP 的 200ms 里三段时间各是什么、为什么 \`next/font\` 能压 CLS 却可能伤 LCP。

## 1. 指标是定义，不是分数

实验室（Lighthouse、本地 Performance 面板）是一台空闲机器、固定视口、冷缓存或热缓存你说了算。线上 RUM（CrUX、\`web-vitals\`、平台 Analytics）是真用户的网络、CPU、视口、扩展程序。**以 RUM 的 P75 为门禁**，实验室用来找原因。两者打架时信 RUM，用实验室解释 RUM。

阈值（作为工作目标，不是道德）：LCP P75 < 2.5s，INP P75 < 200ms，CLS P75 < 0.1。不到阈值的页面，先不要为包体积开新的构建插件。到了阈值的页面，再谈微优化。

FID 已经退出 Vitals。还在用 FID 做看板的，换 INP。FID 只量第一次输入的延迟，INP 量整个生命周期里最差的那几次交互（取近似最坏）。SPA 里点了十次按钮，FID 可能很好，INP 已经炸了。

## 2. LCP：最大那一块内容的绘制时间

LCP 记录视口内最大的图、图文块、或视频封面，从导航开始到它的那次绘制。元素可能换：标题先画，大图后到，LCP 元素从 h1 换成 img。最终值以那次最大的为准。优化错对象（把 logo 优化成 LCP）是常见的自我感动。

测量：Performance 面板看 Largest Contentful Paint 标记；RUM 里上报 \`entry.url\` / element 选择器。先问「是哪一个节点」，再谈怎么快。

构成大约是：TTFB + 资源加载 + 渲染。TTFB 慢：源站、没有 Full Route Cache、没有 CDN、SSR 等数据库。资源慢：LCP 图没有 \`priority\`、走了懒加载、域名未预连、体积按 3x 图发给 1x 屏。渲染慢：CSS 阻塞、字体未就绪用了不可见文本、主线程被 hydration 占满到画不出那一帧。

\`\`\`tsx
import Image from "next/image";

export function Hero() {
  return (
    <Image
      src="/hero.jpg"
      alt=""
      width={1280}
      height={720}
      priority
      sizes="100vw"
    />
  );
}
\`\`\`

\`priority\` 等价于高优先级 preload，并关掉懒加载。LCP 图必须有。非 LCP 图不要 \`priority\`，否则和 LCP 抢带宽。\`sizes\` 写错成 \`100vw\` 而实际只有 400px 宽，浏览器会下过大的图——LCP 是解码和传输的函数，不是「用了 next/image」的布尔。

\`fetchpriority="high"\` 给原生 \`<img>\` 同样的信号。背景 CSS 图很难成为可预测的 LCP 优化对象：发现晚、优先级低。首屏大图用 \`<img>\` / \`next/image\`，不要用 CSS \`background-image\`。

## 3. INP：到下一帧绘制，不是到事件回调

一次交互的 INP 样本 = 输入延迟 + 处理时间 + 呈现延迟。点按钮到视觉反馈的那一帧。回调跑完但没改 DOM、或改了 DOM 却被长任务挡住没画，INP 仍然差。优化 \`onClick\` 里的 \`setState\` 不够，还要问这一帧有没有画出来。

长任务（>50ms，LoAF 更细）是主线程的病。来源：hydration、一次 filter 大列表、同步 JSON.parse 大包、第三方脚本、CSS-in-JS 运行时、无虚拟化的表格。拆分：

- 把非紧急更新丢进 \`startTransition\`，让输入保持紧急。
- \`scheduler.yield()\` 或把工作切到 \`requestIdleCallback\` / Worker。Worker 碰不了 DOM，只能算。
- 减少 hydration 量：RSC 少下水合子树，客户端叶子变小。

\`\`\`tsx
"use client";

import { startTransition, useState } from "react";

export function Filter({ all }: { all: Item[] }) {
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(all);
  return (
    <>
      <input
        value={q}
        onChange={(e) => {
          const v = e.target.value;
          setQ(v);
          startTransition(() => setShown(all.filter((x) => x.name.includes(v))));
        }}
      />
      <List items={shown} />
    </>
  );
}
\`\`\`

输入的 \`setQ\` 紧急，过滤在过渡里。没有过渡时，一次按键要等 filter 完才显示字符，INP 和体感都差。列表本身还要虚拟化，否则呈现延迟在 layout 上。

第三方脚本（分析、聊天、A/B）默认在主线程。\`strategy="lazyOnload"\`、\`worker\` 包装、或干脆晚到交互之后再加载。第一屏就 hydrate 聊天 widget，是买 INP 事故。

## 4. CLS：意外位移的加权和

一次位移分数 ≈ 影响面积比例 × 移动距离比例。累计是页面生命周期里意外位移之和。用户点击引起的位移可以豁免（在 500ms 左右的窗口内）。广告在已渲染内容上方插入、图片没有宽高、字体 swap 把文字撑开，是三大来源。

\`\`\`tsx
<Image src={src} alt="" width={640} height={360} />
\`\`\`

\`width/height\` 或 CSS \`aspect-ratio\` 给浏览器占位。响应式图用 \`sizes\` + 同一比例。广告位写死最小高度。不要在已有内容上方插公告条——插下面，或预留那一条的高度。

字体：\`next/font\` 把字体文件打进自有源，并用 \`size-adjust\` / fallback 度量对齐，减少 swap 位移。\`font-display: swap\` 无度量对齐时，先用后备字体再换成 Web 字体，字宽一变就是 CLS。\`optional\` 几乎无 CLS，但慢网络可能永远看不到 Web 字体。\`next/font\` 默认在 CLS 和展示之间取了工程甜点，不要随手改成 \`swap\` 还关掉调整。

暗色主题闪白也是 CLS / 观感问题：第一帧亮、水合后暗。主题脚本放 \`<head>\`，见样式那篇。

## 5. 实验室 vs RUM：两套数对不上时怎么办

实验室用模拟 4G、慢 CPU，容易把 TTFB 和 LCP 放大。RUM 含缓存命中的回访，P75 可能比实验室好看。对不上时：

- 按路由切 RUM，不要全站一个数。\`/blog/slug\` 和 \`/checkout\` 的 LCP 元素根本不同。
- 按设备切。移动 P75 不达标、桌面达标，优化对象是移动 LCP 图和 TTFB，不是桌面 bundle。
- 看导航类型。\`back_forward\` / \`reload\` / \`navigate\`。Router Cache 让回退很快，RUM 会被这些样本拉好——那不代表落地页好。落地页看 \`navigate\`。
- 实验室关扩展、关 React Scan、用生产构建。\`next dev\` 的数字没有资格进讨论。

\`web-vitals\` 上报要带：路由、LCP 元素类型、INP 事件类型（click / key）、attribution（INP 的长任务脚本 URL）。没有 attribution 的看板只能吓人，不能指文件。

## 6. Next 里的常见凶手

**TTFB / LCP：** 整页 \`await\` 慢查询，没有 Suspense 流式。首字节等最慢的那个 fetch。洞和流式把壳先吐出去，LCP 如果在壳上（标题、已有的 hero），数字会掉下来。LCP 如果在洞里（用户头像当了最大块——少见但有），流式救不了，要换 LCP 元素或给洞更快的源。

**hydration：** 根 layout 塞了巨大 \`'use client'\` 树，JS 下载+执行挡住交互和绘制。叶子才 client。能 RSC 的图表用静态 SVG 或服务器算好的 path。

**图片：** 没 \`priority\` 的 hero；\`fill\` 却父级没有定位和尺寸；GIF 当 hero。用静态图或视频海报。

**字体：** 多个 \`next/font\` 家族各一份，阻塞 CSS。子集化，只引用到的 weight。

**中间件：** 每个请求跑一堆 JWT 解析和地理库，TTFB 直接加几十毫秒。中间件要短，见 Edge 那篇的短文；长逻辑放 Route Handler。

**缓存：** 可静态的页 \`force-dynamic\`，每次 SSR。LCP 的 TTFB 部分是缓存生命周期那篇的锅，不是图片插件的锅。先问这一页能不能进 Full Route Cache。

## 7. 流式、Suspense、和 LCP 的关系

流式让已准备好的 HTML 先出管。对 LCP 有用的前提是：**LCP 元素在先出的那一段里**。整页一个大 \`await\`，流式不存在。\`loading.tsx\` 是段级 Suspense，fallback 若是骨架，骨架通常不是 LCP 元素（不够大或不是图/文本块的最终形态），最终 LCP 仍等真实内容。骨架能改善体感，不一定改善 LCP。把 hero 放进不 await 的壳，把评论列表放进洞。

\`\`\`tsx
export default function Page() {
  return (
    <>
      <Hero />
      <Suspense fallback={<CommentsSkeleton />}>
        <Comments />
      </Suspense>
    </>
  );
}
\`\`\`

\`Hero\` 里不要再 await 慢接口。评论再慢也不该拖 LCP。这是布局决策，不是微优化。

PPR / Cache Components 的静态壳同理：壳里放 LCP，洞里放个性化。个性化块当 LCP，等于放弃静态壳对 LCP 的帮助。

## 8. 主线程长任务：hydration、第三方、大渲染

把 Performance 面板的 Main 轨按任务切开。50ms+ 的黄条点进去看栈。

- **hydration。** 栈在 \`hydrateRoot\` / 组件函数。减客户端树，或延迟 hydrate 折迭区（\`lazy\` + IntersectionObserver）。
- **事件处理。** 栈在你的 \`onClick\`。拆过渡、虚拟化、Worker。
- **第三方。** 栈在 \`gtag\` / 未知 eval。晚加载、代理、删除。
- **布局 thrash。** 读几何再写 DOM 循环。批量读、批量写，或不要在渲染期读 \`getBoundingClientRect\`。

INP attribution 会告诉你「这次 click 的处理里最长的脚本是谁」。没有这条日志时不要猜是「React 慢」。React 19 的编译器和 \`use\` 不会自动删掉你 20MB 的客户端表格。

\`useTransition\` 不能把已经同步跑完的 80ms 变快，它只能让这段工作不堵住输入。80ms 的 filter 仍占主线程，INP 的处理段还在。要降处理段，算法和数据量，不是再包一层过渡。

## 9. 取舍

| 手段 | 帮谁 | 伤害谁 |
|---|---|---|
| 静态 / CDN | LCP-TTFB | 个性化实时性 |
| 流式壳 | LCP（若元素在壳） | 复杂度、洞的 CLS（若未占位） |
| \`priority\` 图 | LCP | 其它带宽 |
| \`next/font\` 对齐 | CLS | 可能的 CSS 阻塞 / 字体下载 |
| 少客户端 JS | INP、也帮 LCP 渲染 | 交互必须下沉到叶子 |
| 晚加载第三方 | INP | 分析少样本 |
| 虚拟列表 | INP、内存 | SEO / 无障碍（要补） |

不要用 \`loading.tsx\` 盖住整页来「优化 LCP」——用户看见的是骨架，LCP 可能变成骨架或更晚的真内容，分数和体验一起糊。

## 10. 排障顺序

1. **看 RUM 哪个指标炸、哪条路由、哪个设备。** 不要一上来 \`analyze\` 包。
2. **LCP：确认元素。** 图？字？图就 priority+尺寸+格式（AVIF/WebP）+ 别用 CSS 背景。字就字体和 TTFB。TTFB 就缓存层和源站。
3. **INP：确认事件类型和 attribution。** click 慢看处理器；keydown 慢看每键工作。hydration 阶段的 INP 单独归「首交互」，和「用了十分钟之后的 INP」不是同一个修复。
4. **CLS：录屏或 layout shift 区域。** 图、字体、插入、广告、cookie 条。cookie 条预留高度。
5. **实验室复现要用生产构建和类似 CPU 节流。** 复现不了就补 RUM attribution，不要改无关代码。
6. **改完看同一路由的 P75，不要看一次 Lighthouse。** 样本不足时分数乱跳。

\`next/script\` 的 \`beforeInteractive\` 会挡解析，只给主题脚本这类必须。分析用 \`afterInteractive\` 或 \`lazyOnload\`。\`beforeInteractive\` 塞聊天，LCP 和 INP 一起死。

## 11. 和包体积的关系

包体积影响：下载时间（弱网 LCP/INP）、解析编译时间（INP、LCP 的渲染段）、hydration 时间。它是原因的一种，不是定义。一份 30KB 的客户端组件若在 \`onClick\` 里同步排序 10 万行，INP 照样炸；一份 200KB 但拆在折叠后 \`lazy\` 的图表，可能不影响任何 Vitals。

看路由级 bundle（\`@next/bundle-analyzer\`），按入口而不是按仓库总量。把 \`moment\` 换成 \`Intl\`、把巨大图标库换成按图标 import，只在分析器证明它在 LCP/INP 路径上时才是 Vitals 工作。否则它是工程卫生，另开 PR，不要和「修 LCP」混成一次提交。

图片和字体常常比 JS 更重。Vitals 看板如果只盯 JS KB，会错过 2MB 的 hero PNG。资源面板按字节排，比按框架排诚实。

## 12. 小结

LCP、INP、CLS 是三种等待：像素、CPU 到下一帧、布局稳定。测量先 RUM 后实验室，先元素/事件后手段。Next 里最贵的决策是：LCP 在不在静态壳、客户端树有多大、图和字体有没有占位和优先级。减包是手段之一，不是指标本身。下一篇把前后端放进同一张构建图：Turborepo 缓存的是任务哈希，不是「文件夹在一起」；Nest 和 Next 只共享类型和纯函数，不共享运行时。
`,

  "fullstack-monorepo-turborepo-nest-next": `把 Monorepo 理解成「前后端放同一个 Git 仓库」会在第三次 CI 和第一次类型漂移时立刻失效。文件夹在一起不产生契约。契约来自**同一份类型被两边 import、同一张任务图决定谁先 build、同一份缓存 key 决定这次 CI 能不能跳过**。Turborepo 做任务图和缓存，不做架构。Nest 和 Next 运行时分离：一个是 Node 进程里的 IoC，一个是 RSC/Action/浏览器。硬把 Nest 的 \`@Injectable()\` class 推进 Next 的 Server Component，或把 Next 的 \`'use client'\` 推进 Nest，编译器也许能骗过一会儿，运行时不会。

这篇文章只讲这张图：包怎么切、Turbo 的缓存 key 必须含什么、类型包怎么演进、CI 怎么既快又不撒谎。读完你应该能独立回答三个问题：为什么 \`apps/web\` import \`apps/api\` 是事故、远程缓存命中了错误环境的制品该怎么造 key、DTO 加可选字段时为什么要当 breaking 看。

## 1. Monorepo 不是搬家，是一张有向图

合法依赖方向：\`apps/*\` → \`packages/*\`，\`packages\` 之间单向。\`apps/web\` 和 \`apps/api\` 互不 import。需要共用的，下沉到 \`packages/types\`、\`packages/ui\`、\`packages/config\`、\`packages/db\`。app 之间说话走 HTTP / 队列，不走 TypeScript import。

\`\`\`
apps/web          Next.js
apps/api          NestJS
packages/types    DTO、错误码、共享联合
packages/ui       React 组件，仅 web 用
packages/config   tsconfig / eslint
packages/db       Prisma schema 与客户端，仅 api 用
\`\`\`

\`packages/ui\` 依赖 \`types\` 可以；\`types\` 依赖 \`ui\` 不行。\`db\` 不要被 \`web\` import——浏览器和 RSC 会把 Prisma 引擎拖进错误的运行时。web 要的是 types 里的 \`UserDto\`，不是 \`PrismaClient\`。

这张图要写进 ESLint \`import/no-restricted-paths\` 或 \`dependency-cruiser\`，不要写进 wiki。wiki 三个月后必破。CI 对非法 import 红，比 code review 认人稳。

「先放一起以后再拆」会变成永远的上帝包 \`packages/common\`。common 里既有日期函数又有 Nest 装饰器又有 React hook，任何一边的构建都会被另一边拖下水。按运行时切包：isomorphic 纯函数一个包，React 一个，Nest 一个，Node-only 一个。

## 2. 任务图：Turbo 缓存的是哈希，不是目录

\`turbo.json\` 声明任务的依赖和输出。\`build\` 依赖 \`^build\` 表示先建依赖包。\`outputs\` 告诉缓存什么算制品。没声明的输出等于没缓存，或更糟——缓存了不完整的目录，下次命中出一个半残的 \`.next\`。

\`\`\`json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**", "!.next/cache/**"]
    },
    "lint": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"], "outputs": [] },
    "dev": { "cache": false, "persistent": true }
  }
}
\`\`\`

\`!.next/cache/**\` 不要进制品缓存。那是 Next 自己的增量，跨机器复用会脏。\`dev\` 关缓存：开发服务器不是可复现制品。

缓存 key 默认含：任务名、包的文件哈希、依赖包的哈希、\`turbo.json\`、lockfile 相关输入。**不含**你没声明的环境变量。\`NEXT_PUBLIC_API_URL\` 变了，若没写进 \`env\` / \`globalEnv\`，Turbo 会把 staging 的前端制品交给 production 任务——命中是真的，URL 是错的。这比缓存 miss 危险，因为 CI 是绿的。

\`\`\`json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**", "!.next/cache/**"],
      "env": ["NEXT_PUBLIC_API_URL", "NODE_ENV"]
    }
  },
  "globalEnv": ["CI"]
}
\`\`\`

密钥不要进 key（也不要进客户端）。进 key 的是**会影响制品内容**的变量。\`DATABASE_URL\` 不影响 Next 的 JS bundle，不要写进 web 的 \`build.env\`；它影响 Nest 的 prisma generate 目标的话，写进 api 的任务。

远程缓存把这份 key 对上的 tar 传到共享存储。命中条件是 key 完全一致。Node 版本、\`packageManager\` 字段、操作系统有时也在影响链上。矩阵构建（linux + darwin）不要共享一份未声明 os 的缓存，除非你证明制品与 os 无关。Nest 的 \`dist\` 通常无关；带 native 的 Prisma 引擎有关。

## 3. workspace 协议和内部依赖

pnpm / yarn / bun 的 \`workspace:*\` 让内部包不走 registry 版本号。app 的 \`package.json\`：

\`\`\`json
{
  "name": "web",
  "dependencies": {
    "@acme/types": "workspace:*",
    "@acme/ui": "workspace:*"
  }
}
\`\`\`

内部包导出要明确：\`exports\` 字段指向 \`dist\` 或源码。Next 能编译 workspace 源码（transpilePackages），Nest 的 \`tsc\` 通常要的是已构建的 \`dist\`。所以 \`types\` 包的 \`build\` 必须在 app \`build\` 之前——这就是 \`^build\`。不要一边 Next 直接吃 \`src/index.ts\`，一边 Nest 吃过期的 \`dist\`，两边看到的类型会在同一天分叉。

统一：内部包始终产出 \`dist\` + \`.d.ts\`，两边都依赖构建后的类型。或始终两边都走源码，Nest 用 \`ts-node\` / SWC 跑源码。混用是第三种，也是最常见的事故源。选一种写进 \`packages/types/package.json\` 的 \`exports\` 和 CI。

\`\`\`json
{
  "name": "@acme/types",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.js"
    }
  }
}
\`\`\`

不要 \`export *\` 把内部文件全部倒出。公开面越小，Nest 改一个私有 helper 越不会逼 web 重编。公开面就是契约，列在 \`index.ts\`。

## 4. 类型包：契约怎么演进

\`packages/types\` 放：请求/响应 DTO、错误码联合、分页形状、WebSocket 事件名。不放：React 组件、Nest 装饰器、Prisma 生成物（生成物带运行时）。

\`\`\`ts
export type ProductDto = {
  id: string;
  title: string;
  priceCents: number;
  currency: "CNY" | "USD";
};

export type ProductListQuery = {
  cursor?: string;
  limit: number;
};

export type ApiError = {
  code: "NOT_FOUND" | "VALIDATION" | "CONFLICT";
  message: string;
  fields?: Record<string, string>;
};
\`\`\`

加**可选**字段看起来兼容，前端老客户端会忽略，可以。改字段类型、改联合成员语义、删字段，是 breaking。Monorepo 里 breaking 不会等 semver：同一 lockstep 提交里两边一起改。这是 Monorepo 相对多仓的好处。代价是：你不能只发后端。CI 必须两边编译。

Prisma 的 \`Product\` 类型不要直接当 \`ProductDto\`。库表有 \`passwordHash\`、有内部 flag。映射函数放 \`packages/db\` 或 api 层，输出 \`ProductDto\`。web 只认识 DTO。泄漏 Prisma 类型进 web，等于泄漏表结构进前端包，下一次 \`include\` 一加，bundle 和契约一起脏。

运行时校验：Nest 用 class + \`class-validator\` 或用 zod。若用 zod，schema 放 \`packages/types\`，\`z.infer\` 当类型，Nest pipe 和 Next 表单共用。不要 TS 接口一份、zod 一份、class 一份。三份里一定有一份先漂。

## 5. Nest 和 Next 只共享什么

共享：类型、错误码、少量 isomorphic 纯函数（钱的格式化、slug 规则、时区转换——确认没有 \`window\` / \`fs\`）。不共享：Nest 模块、PrismaClient、React 组件、环境变量加载方式、日志对象。

鉴权：Next 的 Server Action 和 Nest 的 Guard 用同一套 JWT 语义，但验证库各调各的，密钥来自各进程的 env。不要从 web import Nest 的 \`AuthGuard\`。cookie 名、header 名放 types 当常量。

\`\`\`ts
export const AUTH_COOKIE = "acme_session" as const;
\`\`\`

通信：浏览器 → Next（RSC/BFF）→ Nest，或浏览器 → Nest。两种都行，不要两种对同一资源混用还字段不同。BFF 在 Next 的 Route Handler 里聚合，类型仍来自 types 包。不要在 BFF 里发明第四份 DTO。

静态导出的 Next 仍然可以和 Nest 并肩：构建时不碰 Nest，运行时只靠 URL。types 包在构建期约束前端，不需要 Nest 进程活着。CI 仍要两边 build，免得 DTO 只在一边编过。

## 6. 配置下沉，应用不复制

\`packages/config\` 出 \`tsconfig.base.json\`、ESLint 平面配置。app 的 tsconfig \`extends\` 它，再写 \`paths\` 和 \`jsx\`。Next 需要 \`"jsx": "preserve"\`，Nest 不需要。不要强行一份 tsconfig 打天下，**继承 + 覆盖**。\`strict\`、\`noUncheckedIndexedAccess\`、\`exactOptionalPropertyTypes\` 在 base 打开，例外在 app 里写明理由。types 包最严，因为它是契约。

格式化：Dart 那套与这里无关；这边用仓库已有的 Prettier / ESLint。不要每个包一份 \`printWidth\`。冲突的配置等于没有配置。

Next 的 \`transpilePackages: ['@acme/ui']\` 在吃源码时需要。若 ui 已 build 成 JS，可以不写。和第三节选的「源码 vs dist」一致。

## 7. \`packages/db\` 与生成物

Prisma schema 一份。\`prisma generate\` 产出客户端，挂在 \`db\` 包的 build 上。api 依赖 \`db\`。生成物进 git 还是 CI 生成，选一种。进 git 的好处是 web 即使误 import 也能在类型上立刻红；坏处是 diff 吵。CI 生成要保证 turbo 的 \`inputs\` 含 schema，schema 变了 \`db#build\` 失效。

\`\`\`json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "inputs": ["src/**", "prisma/schema.prisma", "package.json"],
      "outputs": ["dist/**", "node_modules/.prisma/**"]
    }
  }
}
\`\`\`

\`outputs\` 漏了 generated client，缓存命中后 api 会在运行时找不到引擎。这是 Turbo 排障第一名：任务绿、运行红，因为缓存了不完整 outputs。

迁移：只在 api 的发布流程跑 \`prisma migrate\`。web 的 CI 不要连生产库。types 包更不能连库。

## 8. CI：分层，不要每次全宇宙

预提交：改到的包 \`turbo lint test --filter=...[HEAD^]\`。CI 主门禁：\`turbo build lint test\` 用远程缓存。Nightly：e2e、全 feature、镜像扫描。

\`--filter=web...\` 表示 web 及其依赖。\`--filter=...web\` 表示依赖 web 的（通常没有）。改 \`types\` 应让 web 和 api 都重建。Turbo 靠图做这件事，前提是 \`package.json\` 依赖写对了。漏写依赖、靠 tsconfig paths 偷偷 import，缓存会认为 web 没变。**paths 不是依赖声明。** 依赖必须写进 \`package.json\`。

远程缓存的权限：写缓存需要凭证。fork PR 不要用能写生产缓存的密钥，避免投毒。只读命中可以。缓存内容当制品看：里面有 \`NEXT_PUBLIC_*\`，没有服务端密钥——密钥进了 bundle 是 Next 的事故，不关 Turbo。

## 9. 取舍

| 选项 | 买到 | 代价 |
|---|---|---|
| lockstep Monorepo | 类型同步、一次 PR 改完 | 不能独立发前端「不管后端」 |
| 多仓 + 发 npm | 独立版本 | DTO 漂、协调成本 |
| Turbo 远程缓存 | CI 墙钟 | key 设计、投毒面 |
| 内部包走 dist | 运行时清晰 | 每次改 types 先 build |
| 内部包走源码 | 改了就看到 | Nest/Next 编译器行为不一致 |
| 上帝 \`common\` | 短期快 | 运行时互相污染 |

默认：Monorepo + 内部包 dist + Turbo + 非法 import 门禁。团队两人、项目三个月，可以先单仓单包；图开始慢、类型开始漂，再切，不要在第一天发明 12 个包。

## 10. 排障

1. **改了 types，web 没红。** web 没用到新字段，或吃了旧 dist。看 \`types#build\` 是否在 web 之前；看 \`exports\` 是不是指到了 \`src\` 和 \`dist\` 中过期的那个。
2. **CI 命中缓存但线上 URL 错。** env 没进 key。补 \`env\`，作废旧缓存。
3. **本地绿、CI 红。** 本地没 \`--frozen-lockfile\`；或本地有没提交的 dist。CI 用 \`pnpm install --frozen-lockfile\` 和 \`turbo\` 的干净 \`outputs\`。
4. **Prisma 引擎找不到。** outputs 漏 generated；或 os 不同共享了 native 缓存。
5. **循环依赖。** \`ui\` → \`types\` → 某文件再 import \`ui\`。拆类型到 types，组件留 ui。
6. **Next 把 Prisma 打进客户端 bundle。** web import 了 db。ESLint 拦。
7. **\`transpilePackages\` 漏了，报 unexpected token。** ui 的 TSX 没被 Next 编译。补，或改吃 dist。
8. **远程缓存永远 miss。** 时间戳写进了源码或 \`build.ts\` 生成了不可复现文件。\`SOURCE_DATE_EPOCH\`；不要把 \`Date.now()\` 写进制品。
9. **filter 没重建下游。** 依赖只写在 tsconfig paths。补 \`package.json\`。

\`turbo run build --summarize\` / \`--dry-run=json\` 看任务是否被跳过、key 是什么。猜缓存不如把 dry-run 贴进 PR。

## 11. 和运行时分离怎么闭合

开发时 \`turbo run dev --parallel\` 起 web 和 api。端口、CORS、cookie domain 写进 \`packages/config\` 的文档和 \`.env.example\`，不要每人一份口口相传的 localhost。Next 的 \`rewrites\` 可以把 \`/api/*\` 转到 Nest，浏览器只看同一 origin，CORS 少一档。生产可以同一 origin 反代，也可以分开子域。types 不关心。

测试：契约测试放 types 旁，用样例 JSON 满足 DTO。api 的 e2e 打真实 HTTP。web 的组件测试 mock fetch，返回的对象必须 \`satisfies ProductDto\`。三层都过，漂移才难。只测 web 对 mock 的渲染，mock 已经漂了你看不见。

发布：api 镜像和 web 静态/Node 镜像分两条流水线，但同一 git sha。事故时「前端 3a1c、后端 9f0e」是 Monorepo 没管发布的结果。看板贴 sha。回滚一起回。lockstep 的含义在运行时仍成立，不是只在编译时。

Cache 那篇的 tag、Action 那篇的 DTO、状态那篇的 Query key，字段名都应来自 types 包。Monorepo 的价值是让这几篇文章里的字符串变成同一个标识符。否则你在四层缓存上点名 \`product-list\`，在 Nest 里叫 \`products\`，在 Query 里叫 \`['items']\`，失效永远少打一个。

## 12. 小结

Monorepo 的原理是一份依赖图、一份类型契约、一份可哈希的任务。Turbo 加速图，不规定图。Nest 和 Next 共享 DTO 和纯函数，不共享运行时对象。缓存 key 必须含改变制品的环境；outputs 必须含运行真正需要的文件。非法 import 用机器拦。演进 DTO 时把删改当 breaking，在同一次提交里改完两边。图、契约、缓存，三件都写进 CI，才算从「两个项目躺在同一个磁盘上」变成全栈工程。
`,
};
