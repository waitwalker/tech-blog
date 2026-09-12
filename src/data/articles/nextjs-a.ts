export const nextjsA: Record<string, string> = {
  "nextjs-app-router-mental-model": `把 App Router 理解成「pages 目录换了个文件夹名」会在生产里立刻失效。\`page.tsx\` 不是「一个页面文件」，它是某段 URL 的叶子。真正的单位是 **路由段（segment）**：每个文件夹是一段路径，每段可以挂自己的 layout、loading、error、template、default。它们的 **生命周期不一样**。导航时谁卸载、谁保住状态、谁触发 Suspense，全由这段契约决定，而不是由你在组件里写的 \`useEffect\`。

这篇文章只讲心智模型：段怎么组成树、layout 为什么不随叶子换掉、\`children\` 和具名槽差在哪、loading/error 包的是哪一段。读完你应该能独立回答三个问题：从 \`/dashboard/a\` 点到 \`/dashboard/b\` 时哪些组件还活着、为什么弹窗刷新会变成整页、根 layout 里塞一个客户端大组件会拖垮什么。

## 1. 先画边界：文件系统是路由编译器，不是页面列表

\`app/dashboard/settings/page.tsx\` 对应 URL \`/dashboard/settings\`。中间每一层文件夹都是段：\`app\`（根）、\`dashboard\`、\`settings\`。段上可以放：

- \`layout.tsx\`：外壳，必须渲染 \`children\`（更内层段）
- \`page.tsx\`：这层作为叶子时的主内容
- \`loading.tsx\`：这层的隐式 Suspense fallback
- \`error.tsx\`：这层的 Error Boundary
- \`template.tsx\`：看起来像 layout，但每次导航都新实例
- \`default.tsx\`：并行路由槽匹配不上时的后备
- \`route.ts\`：没有 UI 的 HTTP 处理，不是段的可见外壳

Pages Router 的心智是「一个文件 = 一个 URL = 一次整页渲染」。App Router 的心智是「URL 是段的路径，UI 是段上文件的组合」。同一 URL 上同时存在根 layout、中间 layout、叶子 page，它们不是互相替代，是嵌套。

不变量：**没有 page 的段不能单独作为可导航叶子**（除非它只是 layout 分组）。有 page 的段，外层 layout 仍然在。

## 2. 导航时谁活着：layout 与 page 的寿命

这是整套模型里最贵的一条。

从 \`/dashboard/orders\` 客户端导航到 \`/dashboard/settings\`：

- \`app/layout.tsx\` 还在
- \`app/dashboard/layout.tsx\` 还在（段 \`dashboard\` 没变）
- \`orders/page.tsx\` 卸掉，\`settings/page.tsx\` 挂上
- dashboard layout 里的 state、订阅、滚动位置、打开的客户端 Context **默认保住**

从 \`/dashboard/orders\` 到 \`/account/profile\`：

- 根 layout 还在
- \`dashboard\` 段卸掉，它的 layout 卸掉
- \`account\` 段的 layout 新建

这就是「认证壳放哪」的原理：要登录态、侧栏、websocket 不断，必须放在 **所有子页共享且导航时不变的那段 layout**。放进 page，每次切页都会重连。放进根 layout，连营销首页也会带上那套客户端壳。

\`template.tsx\` 故意相反：每次导航新实例，适合进场动画、每次进入都要重置的表单。它不是 layout 的别名。用错的症状是「我把用户菜单写在 template 里，切页就闪一下重新拉用户」。

## 3. children 是更内层段，不是随意插槽

layout 的函数签名是 \`({ children })\`。\`children\` 由框架填成「这一段下面匹配到的那一截」。你不能在 layout 里用 \`usePathname\` 自己 \`if\` 拼出子页来代替 children——那样等于绕开段树，loading/error 的边界也会错。

并行路由引入具名槽：\`app/dashboard/@modal\`、\`@analytics\`。layout 变成：

\`\`\`tsx
export default function Layout({
  children,
  modal,
  analytics,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  analytics: React.ReactNode;
}) {
  return (
    <>
      {children}
      {modal}
      {analytics}
    </>
  );
}
\`\`\`

\`children\` 仍是默认槽。\`@modal\` 是额外匹配规则，不是 children 的别名。弹窗走 \`@modal/(.)photo/[id]\` 这类拦截路由时，刷新和客户端导航会走不同匹配——那是下一篇并行/拦截要讲的，这里只需记住：**槽是段树的横向枝，不是 page 里的 \`useState\`。**

## 4. loading.tsx 包的是这一段，不是整个应用

\`dashboard/loading.tsx\` 是 \`dashboard\` 段的 Suspense 边界。进入 dashboard 下任何一个还在等数据的叶子，先出这个 fallback，**外层 layout 已经在**。所以侧栏可以立刻出现，内容区转圈。

把慢请求写在根 layout 里 \`await getUser()\`，等于根段堵住，\`loading.tsx\` 帮不上——layout 自己不进自己的 loading。慢数据必须下沉到 page 或带 Suspense 的子组件。

\`error.tsx\` 同理：它接住 **这一段及其子树** 的渲染错误。根 error 是最后兜底。叶子里一个图表 throw，若只有根 error，整壳白屏。给会失败的叶子自己的 error.tsx，是在段树上画故障域。

\`error.tsx\` 必须是客户端组件，因为它是 Error Boundary。这不是风格，是 React 约束。

## 5. 软导航 vs 硬刷新

客户端 \`<Link>\` / \`router.push\`：框架尽量复用未变的 layout，只拉变化段的 RSC payload。硬刷新（地址栏回车、新开标签）：整棵段树在服务端重新跑一遍，所有 layout 的本地 state 清零。

拦截路由的弹层：软导航时 URL 变成 photo，UI 仍叠在当前 layout 上；硬刷新没有「当前 layout 的客户端记忆」，匹配真实 \`photo/page\`，于是弹窗变成整页。这不是 bug，是模型：URL 始终是真源，客户端叠层只是导航时的投影。

## 6. 分组与动态段

\`(marketing)\` 这种括号分组 **不出现在 URL**，只为了共用一份 layout 而不改路径。\`[id]\` 是动态段，\`[...slug]\` 是捕获剩余，\`[[...slug]]\` 可选。动态段的 \`generateStaticParams\`、\`dynamicParams\` 决定构建时能穷举哪些叶子——静态导出下穷举失败就是 404，不是运行时再算。

\`page.tsx\` 和 \`route.ts\` 不能躺在同一段里抢同一 URL。UI 叶子和 HTTP 端点要分开段，或接受其中一个。

## 7. 软导航拉什么：Partial Rendering

客户端导航不会重新下载整份 HTML。框架比较新旧段树，只向服务器要 **变化的那些段** 的 RSC payload（Flight）。未变的 layout 在客户端继续跑，服务端也可以跳过它们的渲染。这叫 Partial Rendering。

含义：

- layout 里的 \`await getSession()\` 在软导航时 **不一定重跑**。会话过期后侧栏还显示旧用户，往往是这段 layout 没变、payload 没刷新。要用 \`cookies()\` 等动态 API 或显式 \`revalidate\` 打破。
- page 变了，只拉 page 那段。所以把「当前页标题」放在 layout 用 pathname 算，软导航可能对，硬刷新也对；把「当前页数据」放 layout 傻等，会串页。

服务端组件的数据获取跟着段的渲染走。段不重新渲染，数据就不重新取。这是模型，不是缓存开关没关。

## 8. searchParams 进不了 layout

\`page.tsx\` 可以收 \`searchParams\`。\`layout.tsx\` 在 Next 的模型里 **故意收不到 searchParams**：layout 要跨 URL 查询字符串存活，若它依赖 \`?tab=\`，每次改 query 都得拆壳，和「layout 保命」矛盾。

要按 query 变 UI：放进 page，或放进读取 \`useSearchParams\` 的客户端叶子（会牺牲一部分静态性）。把 filter 写进 layout 的 props，类型上就不成立。

同理，\`params\` 只保证有「这层及外层」的动态段。内层 \`[id]\` 的 id，外层 layout 看不到——它还要为还没进来的兄弟叶子保命。

## 9. 根 layout 的重量

根 layout 包住全站。在这里 \`import\` 一个带 \`'use client'\` 的巨型图表库，等于每个 URL 的客户端 bundle 都背它，包括完全静态的文章页。客户端边界一旦在根上打开，下面再怎么 RSC 也晚了：模块图已经从根被染成客户端。

根 layout 适合：\`html\` / \`body\`、字体、全局样式、极轻的主题脚本。认证、数据、重交互，往下放到真正共享那一段。

静态导出（本站这种 \`output: 'export'\`）下，根 layout 更要瘦：没有服务器给你按段补 payload，首包就是全部。

## 10. 和 Pages Router 的三处不可翻译

1. \`_app\` + \`_document\` 的「整页壳」变成嵌套 layout 树，壳是分段的。
2. \`getServerSideProps\` 的「一页一函数」变成段上任意服务端组件的多次 await，再加上缓存分层。
3. 客户端路由不再默认整页换新，state 会跨叶子活着——这会让「我以为切页就卸载」的订阅泄漏。

迁移时按段画树，不要按旧 pages 文件一对一改名。一个旧 \`pages/dashboard/index.js\` 可能拆成 \`dashboard/layout.tsx\` + \`dashboard/page.tsx\` + \`dashboard/loading.tsx\`，这才是同构，不是把文件挪进 \`app/\`。

## 11. 排障怎么问

1. 切页时侧栏闪一下重拉数据？壳写在 page 或 template，不在稳定 layout。
2. 全屏 loading，侧栏也没了？\`await\` 写在比 \`loading.tsx\` 更外的 layout。
3. 一个组件炸，整站 error？故障域只画在根上。
4. 弹窗刷新变整页？你在用拦截路由的软导航投影，硬刷新走叶子 page。这是预期。
5. 静态导出缺页？动态段没进 \`generateStaticParams\`。
6. 改了 \`?q=\` layout 里的列表不变？layout 本来就不吃 searchParams。

## 12. 小结

App Router 的原理是 **段的树 + 段上文件的不同寿命**。layout 跨叶子存活，page 随叶子替换，loading/error 是段的边界，template 故意不存活，槽是横向枝。软导航只重渲染变化的段，所以 layout 里的数据获取不会「每次切页都跑」。URL 仍是真源；客户端导航只是尽量少拆这棵树。

能回答「这次导航拆了哪几段、谁还活着、loading 包住谁」，心智模型才算立住。下一篇讲 RSC：默认服务端的模块图，以及 \`'use client'\` 边界真正切断的是什么。`,

  "react-server-components-deep-dive": `把 RSC 理解成「SSR 换了个名字」会在生产里立刻失效。SSR 产出的是 HTML 字符串，水合后再变成客户端树。RSC 产出的是 **序列化后的组件树（Flight）**：哪些子树已经在服务器算完、哪些位置要挂一块客户端组件、props 是什么。浏览器里的 React 按这份说明书装配，而不是把整页当客户端应用从头跑一遍。

「零 bundle」也不是魔法。它的意思非常具体：**这段服务端组件 import 的模块，根本不会进客户端 JS 图。** Markdown 解析器、ORM、fs、巨大的日期库，只要只被服务端文件引用，用户就不下载它们。一旦你在根上写了 \`'use client'\`，这棵子树的依赖全部染色，零 bundle 当场取消。

这篇文章只讲边界：两套模块图怎么切、什么能当 props 穿过边界、\`children\` 为什么是漏洞也是正道、async 组件和 Suspense 怎么接。读完你应该能独立回答三个问题：为什么接口类型不能当客户端 props、为什么「为了用一个 onClick 把整页标成客户端」会把包体积打回去、静态导出下 RSC 还剩什么。

## 1. 先画边界：两套模块图，不是两个生命周期钩子

编译器从入口（\`page.tsx\` / \`layout.tsx\`）开始走。默认节点属于 **服务端图**：可以 \`import 'fs'\`、可以 \`await db.query()\`、可以碰密钥。遇到某个文件顶上的 \`'use client'\`，从这个文件起改走 **客户端图**：可以 \`useState\`、可以 \`onClick\`、不能再直接 \`fs\`。

关键不变量：**指令是模块级的，不是函数级的。** 一个文件里不能「这个函数服务端、那个函数客户端」。\`'use client'\` 标的是这个模块以及它 import 的后续客户端模块。服务端文件 **可以** import 客户端模块，含义是「这里留下一个客户端洞，把可序列化 props 填进去」。客户端文件 **不能** import 服务端模块——否则密钥和 Node API 会被打进浏览器。

所以边界是 import 边，不是 JSX 标签名。你把 \`Button\` 和 \`db.ts\` 写在同一个文件里，再标 \`'use client'\`，数据库客户端就会进 bundle，或者构建直接报错。

## 2. 穿过边界的只有可序列化数据

服务端渲染 \`<ClientChart points={pts} />\` 时，\`pts\` 必须能被 Flight 协议记下再在客户端复活。允许：JSON 能表达的结构、少量特化类型（Date、bigint、undefined 的处理依版本而定）。不允许：函数、class 实例、\`Map\`/\`Set\`（未登记时）、带方法的领域对象、数据库连接。

这就是「接口当 prop 传不过去」的根：接口在运行时不存在，你传的是对象；对象上如果挂了方法，序列化会丢方法或直接拒绝。正确做法是传纯数据，客户端自己 new 行为。

\`bind\` 到 Server Action 的函数看起来像传函数，其实编译器换成了 action id + 绑定参数。绑定参数同样会序列化到客户端，**能被看见**。不要 bind 密钥。

## 3. children 是已经算完的树，不是反向 import

允许这种结构：

\`\`\`tsx
// CardShell.tsx
"use client";
export function CardShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return <section>{open ? children : null}</section>;
}

// page.tsx  默认服务端
import { CardShell } from "./CardShell";
import { HeavyMarkdown } from "./HeavyMarkdown"; // 服务端，重型依赖

export default async function Page() {
  const doc = await loadDoc();
  return (
    <CardShell>
      <HeavyMarkdown source={doc} />
    </CardShell>
  );
}
\`\`\`

\`HeavyMarkdown\` 仍在服务端跑完，产物作为 \`children\` 插进客户端壳。客户端 bundle 没有 markdown 解析器。这是官方鼓励的组合：交互在叶子壳上，重计算在服务端子树里。

反过来，从 \`CardShell\` 去 \`import { loadDoc }\` 是禁止的。children 是「服务端塞进来的洞」，不是客户端去调服务端函数。

## 4. async 组件只属于服务端图

服务端组件可以是 \`async function\`，在渲染时 \`await\`。抛出的 Promise 被最近的 \`Suspense\` 接住，于是有流式。客户端组件不能做成 async 组件（至少在当前模型里不能当常规客户端组件用）；客户端读 Promise 走 \`use()\`，并且 Promise 的身份要稳定。

含义：数据获取的默认位置是服务端组件。\`useEffect + fetch\` 变成「交互之后再取」的补充，而不是主路径。把所有数据都放到客户端 \`useEffect\`，等于放弃 RSC 的整张图。

## 5. Flight 协议：说明书不是 HTML

服务端跑完一棵混合树后，并不是只吐 HTML。对客户端洞，它写下类似「在这个位置挂模块 \`LikeButton\`，props 是 \`{ count: 3 }\`」的记录。这套记录叫 Flight。HTML 可以同时输出，好让首屏有像素；随后的客户端导航往往只拉 Flight，不再拉整页 HTML。

因此水合和 RSC 的关系要分开看：

- 有 HTML 的服务端输出：浏览器可以先显示。
- 需要交互的洞：对应的客户端模块必须在 bundle 里，水合只发生在这些洞上。
- 纯服务端子树：没有对应的客户端函数，也就 **没有水合工作**。

传统 SSR 的水合是「整棵树对一遍」。RSC 把水合范围收成「标了客户端的那些岛」。岛越小，主线程越闲。

Flight 也解释了为什么 props 必须可序列化：说明书里写不下函数指针。Action 是特例，写的是服务端登记过的 id。

## 6. 和 SSR、SSG 的差别

传统 SSR：服务器跑一遍 **客户端** 组件树，吐 HTML，浏览器再下发同一份 JS 水合。组件的依赖 **仍然在客户端包里**，否则水合对不上。SSR 省的是首字节前的 CPU 和 SEO，不省 JS 下载。

RSC：服务端组件没有客户端对应物。SSG / 静态导出只是「这次服务端渲染发生在构建时」。Flight 仍然可以在构建时生成；没有 Node 服务器之后，你不能在请求时再跑服务端组件——这就是本站 \`output: 'export'\` 的约束。

所以：RSC 可以和静态导出共存（构建时算完），但不能在纯静态托管上「每次请求 \`await db\`」。那需要服务器。

## 7. 染色：从哪一行开始，整棵 import 树都是客户端

\`'use client'\` 文件 import 的所有模块，只要没有再被切回服务端（做不到切回），都按客户端打包。一个很深的 \`utils/format.ts\` 若被客户端按钮 import，它就不能再碰 \`fs\`。若它同时被服务端 import，bundler 会把它当成共享的 isomorphic 模块：两边都能跑的纯函数才安全。

实践：

- 纯函数、类型、常量：可以两边 import。
- 读库、读盘、读环境密钥：只放服务端文件，文件名都不要被客户端碰到。
- 带 hook 的组件：独立文件，顶上 \`'use client'\`，尽量叶子化。

「为了 onClick 给 page.tsx 加 \`'use client'\`」是最贵的一笔：page 的所有 import 都进客户端，RSC 白做。正确的是 page 保持服务端，抽出 \`LikeButton.tsx\`。

## 8. 序列化成本与 payload

Flight 不是免费的。把 2000 行表格当 props 塞进客户端组件，用户仍要下载这份数据。零 bundle 指依赖代码，不指数据。大数据该：

- 留在服务端渲染成 HTML（能静态看的）
- 或分页后再传
- 或客户端自己再 fetch（接受二次请求）

不要把「能传 props」理解成「应该把整个查询结果灌进客户端」。

## 9. 密钥与环境变量

没有 \`NEXT_PUBLIC_\` 前缀的环境变量只应出现在服务端图。客户端文件读 \`process.env.SECRET\` 会在构建时报错或被内联进公开包。RSC 的安全模型是 **模块图隔离**，不是「运行时藏一下」。审 import 边，比审 env 文件更重要。

## 10. 排障怎么问

1. 包体积没降？用打包分析看 \`'use client'\` 标在哪一层，是不是整页染色。
2. 「xxx is not a valid Server Component prop」？你传了函数或 class 实例。改成数据，或把行为留在客户端。
3. 构建报服务端模块被客户端 import？画 import 边，从报错文件向上找到第一个 \`'use client'\`。
4. 静态导出时 \`await db\` 失败？没有运行时服务器，RSC 只能在 build 执行。
5. 客户端子树拿不到新数据？你把数据放在没随导航重跑的 layout 里，或 props 没变 Flight 不推。

## 11. 设计取舍

- **默认服务端**：包小、数据近、密钥安全。代价是交互必须显式下沉，心智要从「全是 React 客户端」改过来。
- **过早 \`'use client'\`**：写起来像老 React。代价是包体积和密钥风险回到原点。
- **一切 HTML 在服务端**：SEO 和首屏好。代价是交互延迟取决于 Flight 和流式切分。

## 12. 小结

RSC 的原理是 **两套模块图 + 可序列化的边界 props**。服务端图跑完变成 Flight 说明书；客户端图只对标了 \`'use client'\` 的那些洞。\`children\` 让重型服务端子树嵌进轻量客户端壳，而不把解析器打进浏览器。

能回答「这个 import 在哪张图、这个 prop 能不能过边界、染色从哪一行开始」，边界才算画清。下一篇讲 Server Action：看起来像传函数，其实是一次带 id 的 POST。`,

  "nextjs-server-actions-and-mutations": `把 Server Action 理解成「前端直接跑后端函数」会在生产里立刻失效。你在组件里写的 \`await createPost(formData)\`，编译之后是一次 **带框架生成 id 的 POST**。浏览器并不执行 \`createPost\` 的函数体；它把参数序列化发到当前源，服务器按 id 找到登记过的函数再跑。没有这层协议，密钥、数据库、\`revalidatePath\` 都不可能安全地出现在「看起来像函数调用」的语法里。

这篇文章只讲突变这一侧：Action 怎么被登记、闭包 \`bind\` 会把什么暴露给客户端、和 Route Handler 的分工、缓存怎么失效、静态导出为什么整套都不能用。读完你应该能独立回答三个问题：为什么 Action 入口必须自己做鉴权、\`bind(userId)\` 为什么不能当保密手段、突变成功后为什么列表还是旧的。

## 1. 先画边界：是 RPC 外观，是 HTTP 突变

\`'use server'\` 可以标在文件顶（该文件导出的函数都是 Action），也可以标在 async 函数体内（内联 Action）。编译器给每个 Action 一个 id，客户端运行时只知道 id 和序列化参数。

\`\`\`ts
"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function createPost(formData: FormData) {
  const session = await getSession();
  if (!session) throw new Error("UNAUTHENTICATED");
  const title = String(formData.get("title") ?? "").trim();
  if (!title) return { ok: false as const, error: "EMPTY" };
  await db.post.create({ data: { title, authorId: session.uid } });
  revalidatePath("/posts");
  return { ok: true as const };
}
\`\`\`

这不是魔法 \`eval\`。它是：

1. 构建期登记 \`createPost → id\`
2. 客户端 POST，body 里是 id + 参数
3. 服务端校验请求来自同源、带框架的 CSRF 机制
4. 执行函数，按返回值决定是否刷新 RSC 树

 progressive enhancement：\`<form action={createPost}>\` 在 JS 关掉时仍能提交。这是 Action 相对手写 \`fetch('/api')\` 的真正优势之一，不是少写一个 route 文件那么浅。

## 2. 谁可以调用：公开表面

任何能在客户端拿到 Action 引用的地方都能 POST。把 Action 从服务端组件作为 prop 传给客户端按钮，等于公开这个端点。URL 不出现在 \`app/api\` 里，**不等于未公开**。爬虫和用户一样可以复放那个 POST。

因此入口第一行仍是鉴权、校验、鉴权、校验。省略 Guard 的理由不成立。\`getSession()\` 读 cookie，和 Route Handler 里读 cookie 是同一安全模型。

内联 Action 写在服务端组件里，看起来「只有这个页面能用」。编译后仍然是一个可 POST 的 id。页面级只是引用方式，不是 ACL。

## 3. bind：闭包会序列化到客户端

\`createPost.bind(null, draftId)\` 把 \`draftId\` 编进客户端能看到的 bound args。用户打开 DevTools 就能读。不要 bind 价格、角色、密钥、他人的 id 当「隐藏字段」。隐藏字段在 HTML 里从来就不隐，Action bind 也一样。

需要保密的上下文：在 Action 内从 session、数据库再读一遍，不要信客户端带来的 bound 参数当权威。\`draftId\` 可以当提示，进函数后必须 \`assertOwner(session, draftId)\`。

## 4. 返回值、错误与 \`useActionState\`

Action 可以 return 数据，客户端用 \`useActionState\` / \`useFormState\` 接到。throw 会变成错误状态。不要 throw 一堆 stack；和过滤器同一纪律：对外 code，对内日志。

\`useFormStatus\` 读的是 **最近的父 form** 的 pending，不是全局。按钮在 form 外就永远不 pending。\`useActionState\` 把上次结果、pending、派发函数收成一套，替代 \`useState + fetch + try/catch\` 三件套。

乐观更新（\`useOptimistic\`）发生在客户端，Action 失败要能回滚。乐观层不是服务器真相。

## 5. 和 Route Handler 怎么分工

| | Server Action | Route Handler |
|---|---|---|
| 调用方 | 自己的 UI、\`<form>\`、客户端 \`startTransition\` | 浏览器、移动端、Webhook、第三方 |
| 路径 | 框架 id，不作为稳定公共 API | \`/api/...\` 稳定 |
| CSRF | 框架同源机制 | 自己做 |
| 缓存刷新 | 直接 \`revalidatePath/Tag\` | 也能调，但常被外部系统调用 |
| 静态导出 | 没有服务器，不可用 | 同样不可用 |

Webhook、OAuth 回调、给别的服务的 REST，用 Handler。表单和页面内突变，用 Action。不要用 Action 冒充公共 API，也不要为每个输入框手写一个 \`route.ts\` 只为少学 Action。

## 6. 突变之后的缓存

函数跑完，用户仍可能看见旧列表——因为 RSC 树和 Data Cache 还在。必须显式：

- \`revalidatePath('/posts')\`：这条路由的 Full Route Cache + 相关树
- \`revalidateTag('posts')\`：所有打了这个 tag 的 fetch / \`unstable_cache\`
- Next 16 的 \`updateTag\`：在 Action 里读-改-读，避免自己刚写的被旧缓存挡住

漏掉失效，就是「POST 200，页面还是旧的」。多写一个很大的 \`revalidatePath('/')\` 会把整站静态页打穿，CDN 和 ISR 一起买单。tag 粒度要和查询粒度对齐：按 \`post-id-3\` 失效，不要按 \`all\`。

## 7. 闭包里的动态数据

Action 若在渲染时捕获了 \`now\`、\`searchParams\`、未冻结的对象，每次渲染可能生成不同闭包，客户端拿到的 id 行为会让人意外。把 Action 放进独立 \`actions.ts\`，参数显式传入，比「写在 Server Component 函数里随手闭包」可推理。

文件顶 \`'use server'\` 的模块不要再 export 非 async 的普通工具函数给客户端——客户端 import 这个文件会把整个模块当服务器参考，边界变糊。工具函数放 \`lib/\`。

## 8. 静态导出与本站

\`output: 'export'\` 没有 Node 运行时接那个 POST。Action 在构建时不能替代运行时突变。本博客是静态站，文章页没有 Action 是模型决定的，不是漏写。要评论、点赞，得另接后端或放弃纯导出。

开发时 Action 能跑、导出后 404/失败，先查 next.config 而不是查函数体。

## 9. 排障怎么问

1. 未登录也能改数据？入口没有读 session。
2. 用户改了 hidden/bound 的 \`userId\` 就把别人的资源改了？把客户端参数当权威了。
3. 提交成功列表不变？没 \`revalidatePath/Tag\`，或 tag 打错层。
4. pending 一直 false？按钮不在 \`<form>\` 里，或没用 \`useFormStatus\` / \`useActionState\`。
5. 生产没有 Action？静态导出或 Edge 上用了 Node-only API。

## 10. 设计取舍

- **Action 当页面突变**：少胶水、能无 JS 提交、失效函数就近。代价是公开表面不好在网关文档里列出来，要靠代码审查。
- **一切走 REST Handler**：契约清楚、易给第三方。代价是每个表单自己管 CSRF、pending、revalidate。
- **闭包 bind 图省事**：少传参。代价是参数出现在客户端，保密模型崩。

## 11. 小结

Server Action 的原理是 **登记 id + POST + 服务端再执行**。语法像函数，安全模型像 HTTP 端点。鉴权、校验、幂等、缓存失效，一项都不能因为「没有 \`/api\` 路径」而省略。

能回答「这个函数的公开表面是什么、bind 了什么、成功后哪一层缓存必须死」，突变才算接上。下一篇讲流式渲染：Suspense 切的是哪一段 HTML，以及为什么一个 \`Promise.all\` 会把流式抵消掉。`,

  "nextjs-streaming-and-suspense-rendering": `把流式渲染理解成「加一个 loading 转圈」会在生产里立刻失效。Suspense 不是动画组件，它是 **渲染树的切分点**：哪一段 HTML 可以先出管，哪一段必须等 Promise。HTTP 层用 chunked 传输把已经准备好的字节先送给浏览器；React 再用后续 chunk 把 fallback 换成真实子树。首字节时间和 LCP 可以早于最慢的那个 fetch——前提是你没有用 \`Promise.all\` 把所有源又绑回一棵必须整块完成的树。

这篇文章只讲这一层：await 写在哪会堵住谁、\`loading.tsx\` 和显式 \`<Suspense>\` 包的范围差在哪、流式与水合/Flight 怎么接、静态导出为什么几乎没有运行时流。读完你应该能独立回答三个问题：为什么侧栏出来了内容区还在转、为什么一个 \`Promise.all\` 让 TTFB 回到最慢查询、为什么根 layout 里的 \`await\` 让整页 \`loading.tsx\` 失效。

## 1. 先画边界：切的是树，不是「感觉上的慢」

服务端渲染从上往下走。遇到普通同步组件，立刻产出 HTML。遇到 \`async\` 服务端组件且它还在 \`await\`，React 要决定：把整棵祖先停住，还是在某个边界先吐 fallback。

\`<Suspense fallback={...}>\` 就是这个边界。边界 **以上** 的 HTML 可以先发出去（壳、导航、已完成的兄弟）。边界 **以内** 的子树挂起，先发 fallback，数据好了再发补丁。没有边界的 \`await\` 会一直挂到最近的祖先边界；若一直到根都没有，整次响应等最慢的那个 await——流式为零。

不变量：**慢的是 Promise，堵不堵取决于最近的 Suspense。** 组件慢不是流式的充分条件。

## 2. 一次请求里的时间线

假设 dashboard 页：Header 静态，\`UserCard\` await 30ms，\`Analytics\` await 800ms。

错误写法：page 顶上 \`const [user, analytics] = await Promise.all([...])\` 再渲染。TTFB ≥ 800ms，Header 也得等。你把两段数据在进入 JSX **之前** 就汇合了，树还没长出 Suspense 节点。

正确写法：page 立刻返回 JSX，两个 async 子组件自己 await，各自包 Suspense。Header 的 HTML 先出管；UserCard 30ms 后补上；Analytics 800ms 后补上。用户先看见壳和用户信息，图后到。LCP 若是 Header 或 UserCard，就不必等于 Analytics。

\`\`\`tsx
export default function DashboardPage() {
  return (
    <>
      <Header />
      <Suspense fallback={<CardSkeleton />}>
        <UserCard />
      </Suspense>
      <Suspense fallback={<ChartSkeleton />}>
        <Analytics />
      </Suspense>
    </>
  );
}

async function Analytics() {
  const data = await loadAnalytics(); // 800ms
  return <Chart data={data} />;
}
\`\`\`

\`Promise.all\` 用在 **同一边界内确实要同时具备的数据**（同一张卡的标题+金额）。用在整页，就是反模式。

## 3. loading.tsx 是段级隐式 Suspense

\`app/dashboard/loading.tsx\` 等价于框架给 \`dashboard\` 段套了一层 Suspense，fallback 是这个文件。进入 dashboard 下还在等的叶子时，**外层 layout 已经在**，只有这段的 children 位置走 fallback。

它包不住比它更外的 await。根 layout 里 \`await getSession()\`，整棵树在 layout 完成前不会开始流 dashboard 的 loading——用户看见的是白屏或上一段的壳，而不是 dashboard 骨架。

更细的卡片级等待：在 page 里显式 \`<Suspense>\`。段级用 loading.tsx，卡片级用组件旁的 Suspense。两层可以叠：先出段骨架，再出页壳，再逐卡替换。

## 4. 和 Flight、水合的关系

流式不只是 HTML chunk。App Router 里后续补丁常常是 Flight 记录：这个洞的服务端子树算完了，请换成真实组件。客户端 React 把 fallback 卸掉，挂上新子树。需要交互的客户端岛，水合发生在岛上，不必等整页所有流结束。

因此「首屏有像素」和「按钮可点」可以是两个时刻。骨架先到，图表后到，图表里的客户端过滤器更后水合。把所有东西放进一个客户端大组件，流式只能推一块大 fallback，意义被吃掉。

## 5. 错误边界不要和挂起混成一个洞

Suspense 管 pending。\`error.tsx\` / \`ErrorBoundary\` 管 throw。数据失败应 throw（或返回明确空态），让错误边界接住，而不是让 Suspense 永远 pending。一个 fetch reject 若没被 catch，会冒到 error 边界；若你把它吞成一直不 resolve 的 Promise，用户会看着骨架转圈到超时。

独立数据源：独立 Suspense + 尽量独立 error 边界。一个图表失败不应取消旁边已经流完的卡片。

## 6. 缓存会改变「谁慢」

同一次请求里的 \`fetch\` 去重（Request Memoization）让 layout 和 page 打同一 URL 只慢一次。跨请求的 Data Cache 命中时，\`async\` 组件可能同步就有数据，Suspense 根本不挂起——流式边界仍在，只是这条路径没有等待。失效后第一次又会挂起。不要在开发环境（很多缓存关着）的体感上设计生产骨架，两边的挂起集合不一样。

静态生成 / ISR：构建时把能算的算完，HTML 里可能已经没有 fallback。运行时流式主要出现在 SSR 动态段。

## 7. 静态导出几乎没有运行时流

\`output: 'export'\` 在构建时生成完整 HTML。没有服务器在请求过程中再推 chunk。Suspense 在构建期要么等到数据（等于 SSG 时 \`await\`），要么你得有构建期就能结束的 Promise。用户刷新静态文件，一次拿完整文档，没有「先壳后卡」。

流式是 **有运行时服务器** 的能力。本博客这种静态站，文章页谈 chunked streaming 没有落点；骨架屏最多是客户端导航时的 loading.tsx（若仍走 Next 客户端路由）。纯静态托管的整页刷新没有第二段 chunk。

## 8. 反模式清单（都是把切分点焊死）

- 页面顶 \`await Promise.all(所有源)\` 再 return JSX
- 根 layout \`await\` 慢查询
- 一个巨大客户端组件内部再 fetch，服务端流式插不进岛里
- fallback 和真实 UI 尺寸差太大，替换时 CLS 爆（骨架要占位）
- 把互不相关的三张卡放进同一个 Suspense，最慢的一张决定三张一起出

## 9. 排障怎么问

1. TTFB 等于最慢接口？await 在 Suspense 外，或被 Promise.all 汇合。
2. 壳也在转圈？await 写在 layout，且没有更外的已完成 HTML。
3. 骨架一闪而过或从不出现？数据走了缓存，或组件其实是同步的。
4. 替换时页面乱跳？fallback 没占住宽高。
5. 导出后没有流式？没有服务器，这是模型。

## 10. 设计取舍

- **切得细**：首屏快、故障隔离好。代价是瀑布：A 的 HTML 到了才开始拉 B（若 B 依赖 A 的输出）。能并行的 fetch 应在各自组件里同时发起，而不是等父 await 完再渲染子。
- **切得粗**：实现简单。代价是用户盯着最大公约数的慢。
- **全客户端拉数**：服务端流式用不上。代价是白屏或 SPA 转圈，SEO 和 LCP 都差。

## 11. 小结

流式的原理是 **Suspense 把树切成可先发送的 HTML/Flight 块**。慢的是 Promise；堵不堵看最近边界。\`loading.tsx\` 是段级边界，显式 \`<Suspense>\` 是更细的边界。\`Promise.all\` 在进树之前汇合数据，等于拆掉切分。

能回答「这个 await 外面包着哪一层 Suspense、Header 是否已出管」，流式才算设计过。下一篇讲 SSG / SSR / ISR：HTML 在何时、何地、为谁生成。`,

  "nextjs-rendering-strategies-ssg-ssr-isr": `把渲染模式理解成「开哪个开关更快」会在生产里立刻失效。四种（加上 PPR 是五种）策略的差别不是分数高低，是 **HTML 在何时、何地、为谁生成**。选错的账单很具体：用户看见过期价格、爬虫看见登录墙、静态导出后 Server Action 全部 404、ISR 窗口里钱已经变了页面还没变。

这篇文章只讲契约：构建时、请求时、后台再生、静态壳加动态洞，各自保证什么、不保证什么。读完你应该能独立回答三个问题：本站为什么必须 \`output: 'export'\`、带 cookie 的页为什么不能当静态、\`revalidate: 60\` 的脏窗口产品是否接受。

## 1. 先画边界：渲染时刻 × 运行时

问三个问题就能定位：

1. **何时跑 React？** 构建机上 / 每个请求 / 过期后在后台。
2. **跑完的结果给谁看？** 所有人同一份，还是按 cookie/地域/登录态不同。
3. **跑的时候有没有 Node？** 没有就不能在请求时 \`await db\`，也不能接 Action。

| 模式 | 何时生成 | 请求时有无 Node | 每人一份？ |
|---|---|---|---|
| Static Export | 构建时 | 无（任意静态托管） | 是，文件即真相 |
| SSG | 构建时 | 可有可无（有则还能 ISR/SSR 混） | 默认是 |
| ISR | 构建时 + 过期后后台再生成 | 要 | 窗口内可能旧 |
| SSR | 每个请求 | 要 | 可以按人 |
| PPR | 构建时出壳，请求时流式填洞 | 要 | 壳共享，洞可按人 |

没有银弹。营销页、文档、本博客：Export/SSG。后台看板：SSR 或客户端拉。商品详情：ISR 或 PPR。把后台做成 ISR，用户会看见别人的数据或过期权限。

## 2. Static Export：文件就是应用

\`output: 'export'\` 把每个可穷举的 URL 变成 \`out/xxx/index.html\`。没有 \`route.ts\` 运行时，没有 Server Action，没有请求时 RSC。\`generateStaticParams\` 必须列出所有动态段，\`dynamicParams = false\` 时没列出的就是真 404。

这是本站的模式。文章、分类、游戏页全部在构建时算完。\`await\` 可以出现在服务端组件里，但只在 \`next build\` 时执行一次。构建机读 \`posts.ts\`，不在用户刷新时读数据库。

代价：评论、点赞、按用户推荐，要么纯客户端接第三方，要么放弃纯导出。好处：Caddy/Nginx/对象存储就能扛，没有 Node 冷启动，没有服务器漏洞面。

不变量：**导出后不存在「这个请求的 cookies()」。** 构建时读 cookie 没有意义。动态函数会迫使路由退出静态；在 export 下则直接构建失败或降级成你没料到的空页。

## 3. SSG：构建时渲染，部署后当静态文件

未开 \`export\` 时，SSG 仍是构建期 HTML，但前面可以有 Next 服务器做 ISR、中间件、偶发 SSR。纯 SSG 路由不碰 Node 数据，和 CDN 最合得来。

\`generateStaticParams\` 决定预渲染哪些 \`[slug]\`。构建时打 CMS 的那一次失败，对应页面就缺。CI 要当构建错误，不要当「上线后再生成」——除非你明确走 ISR 的 on-demand。

## 4. SSR：每个请求跑一遍树

\`cookies()\`、\`headers()\`、\`no-store\`、\`dynamic = 'force-dynamic'\` 会把段标成动态。每个请求在服务器上跑服务端组件，TTFB 含数据时间。最新，也最贵。要自己管缓存（CDN 按 cookie 分流很容易把缓存击穿成每人一份源站计算）。

SSR 不是「不能缓存」，而是默认这份 HTML 不能当公共静态文件。可以在 Handler 或 \`fetch\` 上自己设 \`Cache-Control\`。乱加 \`s-maxage\` 又按用户变内容，CDN 会串页。

个性化后台、实时权限，用 SSR 或客户端拉。不要用 ISR 的「大家看同一份、偶尔再生」去近似。

## 5. ISR：时间或事件驱动的再生

\`export const revalidate = 60\`：这份静态 HTML 最多用 60 秒。过期后 **下一次请求** 可以先拿到旧的，后台再生成新的（具体实现随版本，但产品语义是「允许脏窗口」）。\`revalidateTag('product-1')\` 是事件驱动：下单、CMS webhook 时主动打死相关页。

脏窗口必须写进产品预期。SKU 价格、库存、活动倒计时，60 秒旧数据可能等于错钱。博客正文、文档，60 秒甚至 1 天都可接受。

on-demand 再生失败（构建错误、CMS 超时）时，旧页会继续活。要有告警，不要以为 tag 一调就一定换新。

## 6. PPR：静态壳 + 动态洞

Partial Prerendering 把一页拆成：构建时就能确定的壳（导航、布局、静态文案）预渲染；\`cookies()\` 或动态 \`fetch\` 的洞在请求时流式填入。用户先看到壳，再看到「你好，张三」。

它不是第五种完全独立的宇宙，是 **SSG 和 SSR 在同一 URL 上的切分**，切分点和 Suspense 边界对齐。没有服务器就没有请求时的洞，PPR 退化成整页静态或不可用。

适用：电商详情（壳、图、描述静态，价格/库存/购物车动态）。不适用：整页都随用户变的后台。

## 7. 动态函数如何「污染」一段

段上一旦调用 \`cookies()\` / \`headers()\` / 未缓存的动态 \`fetch\`，这段就不能当纯静态输出。App Router 以 **段** 为粒度：layout 动态，可能拖累它包着的静态叶子，或反过来按版本实现有差异。排障时看这段的构建输出是 ● 静态还是 λ 动态，不要只看 page 文件有没有 \`revalidate\`。

\`searchParams\` 让 page 动态，但 layout 吃不到 searchParams——上一篇心智模型。filter 写在 page，壳仍可静态。

## 8. 和本仓库的对应

\`next.config.mjs\` 里 \`output: 'export'\`。游戏页、文章页、分类页都是构建产物。\`generateStaticParams\` 从 \`posts\` 数组来。加一篇文章必须进数据源再 build，不是请求时读 CMS。这不是缺陷，是选择：运维面最小，突变能力为零。

若以后要评论，选项是：静态页 + 第三方客户端评论，或拆掉 export 上 Node。没有第三条「既 export 又在请求时写库」的路。

## 9. 排障怎么问

1. 构建缺动态段？\`generateStaticParams\` 没列全，或 export 下用了动态函数。
2. 用户看见过期价？ISR 窗口，或 CDN 没随 tag 失效。
3. 登录后仍是匿名壳？把用户相关 UI 放在了静态段，或 PPR 的洞没挂上动态 API。
4. Action 404？export 没有服务器。
5. 开发里每次都是新的、生产像静态？\`next dev\` 和 \`next start\` / CDN 的缓存默认不同。以生产为准。

## 10. 设计取舍

- **全静态**：便宜、快、安全面小。无请求时数据、无 Action。
- **全 SSR**：永远新鲜。贵、慢、易把源站打满。
- **ISR**：吞吐接近静态，允许脏。脏不可接受时不能用。
- **PPR**：体验接近「壳立刻有、洞稍后到」。实现和运维复杂度最高，且要服务器。

## 11. 小结

渲染模式的原理是 **何时跑 React、结果能否共享、有没有 Node**。Export/SSG 共享且构建时算完；SSR 按请求算且可不共享；ISR 共享但允许过期；PPR 共享壳、按请求填洞。产品对「旧数据」和「个性化」的态度，比「哪种更快」更先决定选型。

能回答「这一页的 HTML 是构建机写的还是这个请求写的、能不能给所有人同一份」，模式才算选过。下一篇讲 Route Handler：没有 React 树的 HTTP 函数，以及它和 Action 的公开表面差在哪。`,

  "nextjs-route-handlers-rest-api": `把 Route Handler 理解成「pages/api 换了个文件名」只对了一半。文件是 \`app/api/xxx/route.ts\`，导出的是 \`GET\` / \`POST\` / \`PUT\` / \`PATCH\` / \`DELETE\` / \`HEAD\` / \`OPTIONS\`。里面 **没有 React 树**：不跑 layout、不跑 RSC、不跑 \`loading.tsx\`。它是框架内的 HTTP 适配器，吃 Web 标准的 \`Request\`，吐 \`Response\`。适合 Webhook、OAuth 回调、给移动端/第三方的 REST，以及需要稳定 URL 的流式接口。

这篇文章只讲这一层：方法怎么映射、和 Server Action 的公开表面差在哪、缓存与 Cookie、CORS、签名校验、Edge 与 Node runtime、静态导出为什么整文件都不存在。读完你应该能独立回答三个问题：为什么 Webhook 不能做成 Action、GET 什么时候会被 CDN 缓存成事故、本站 \`output: 'export'\` 下 \`app/api\` 会怎样。

## 1. 先画边界：没有组件，只有函数

\`\`\`ts
// app/api/webhooks/stripe/route.ts
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const raw = await request.text();
  const ok = verifyStripe(raw, request.headers.get("stripe-signature"));
  if (!ok) return NextResponse.json({ error: "invalid" }, { status: 400 });
  await enqueue(raw);
  return NextResponse.json({ received: true });
}
\`\`\`

同目录不能再放 \`page.tsx\` 抢同一 URL。UI 叶子和 HTTP 端点必须分开段。Handler 里 \`return <div/>\` 没有意义；要 HTML 就去 page。

不变量：**Handler 的 URL 是公共契约。** 写进第三方后台的回调地址、App 的 baseURL、OpenAPI，都不能像 Action id 那样随构建改掉。换路径是破坏性变更。

## 2. 和 Server Action 怎么选

| | Route Handler | Server Action |
|---|---|---|
| 调用方 | 任意 HTTP 客户端 | 自己的 UI / form |
| URL | 稳定、可文档化 | 框架 id |
| CSRF | 自己做 | 框架同源机制 |
| 签名 Webhook | 正道（读 raw body） | 别用 |
| 无 JS 表单 | 普通 HTML form 也能 POST 过来 | \`<form action={fn}>\` 专门优化 |
| 缓存刷新 | 可调 \`revalidateTag\` | 同样，且更常就近调用 |

第三方只认 HTTP。Stripe、GitHub、OAuth 不会帮你调 Action。给自己页面的突变用 Action 更少胶水。给世界的接口用 Handler。

不要用 Handler 只为了「少学 Action」去包一层自己的 JSON-RPC；也不要把 Action 当 Webhook 入口——拿不到稳定路径和 raw body 纪律。

## 3. GET 与缓存是事故高发地

GET 在 HTTP 里可缓存、可重放。Handler 默认若被当成静态或被 CDN 抓住，\`GET\` 可能在构建时跑一次，或在边缘缓存很久。带用户数据的 GET 必须：

- \`export const dynamic = 'force-dynamic'\`，或
- 读 \`cookies()\` / \`headers()\` 让它变动态，或
- 明确 \`Cache-Control: private, no-store\`

公开、可共享的 GET（RSS、公开 JSON）反而应该设 \`s-maxage\`，让 CDN 干活。不设的结果是源站被爬虫打满；乱设的结果是用户 A 的 JSON 被用户 B 命中。

POST 默认不缓存。Webhook 用 POST。不要用 GET 做删除或发邮件。

## 4. Body：JSON 与 raw

\`request.json()\` 只能读一次 body。签名校验必须先 \`request.text()\` 拿原始字节，再 \`JSON.parse\`。先 json() 再验签，原始字节丢了，HMAC 对不上。

体积上限要自己挡。不限的 JSON parse 是内存炸弹。流式上传走 \`request.body\` ReadableStream，不要 \`await request.arrayBuffer()\` 把 2GB 一次性读进堆。

## 5. Cookie、CORS、鉴权

读 cookie：\`cookies()\` 或 \`request.headers.get('cookie')\`。写 cookie：\`NextResponse\` 的 \`cookies.set\`。Handler 和 RSC 读的是同一份 cookie 存储，session 逻辑应抽到 \`lib/auth\`，不要复制。

浏览器跨源调你的 API 才会碰到 CORS。Webhook 服务器对服务器通常不走 CORS。给 SPA 外域用时，\`OPTIONS\` 要显式处理，\`Access-Control-Allow-Origin\` 不要 \`*\` 还带 credentials。

鉴权：Bearer、session cookie、mTLS，和写 Nest Controller 同一标准。Handler 没有 Nest Guard 数组，但你可以写 \`requireUser(request)\` 在每个方法第一行调用。漏掉就是公开写接口。

## 6. 流式响应

可以 \`return new Response(stream)\` 做 SSE 或 chunked JSON。这和页面的 RSC 流式不是同一条管道：没有 Suspense，没有 layout。客户端用 \`fetch\` + \`getReader()\`。注意：某些托管（中间缓冲的 CDN、部分 Serverless）会把流攒完再发，流式在那些环境是幻觉。选平台前先验证。

## 7. runtime：Node 还是 Edge

默认 Node：能用 \`fs\`、原生 SDK、长连接库。Edge：冷启动小、没有完整 Node API，包体积和 CPU 时间紧。验签、重 SDK 往往必须 Node。地理路由、极轻的 redirect 才适合 Edge。

\`export const runtime = 'nodejs'\` 写清楚，避免平台默认给你切到 Edge 后 SDK 爆炸。

## 8. 静态导出

\`output: 'export'\` **不会** 把 \`route.ts\` 变成静态文件里的服务器。构建要么忽略、要么失败，取决于版本和用法。本站没有可用的 \`/api/*\`。要 Webhook，必须另外部署 Node（Nest、独立 Worker），不能指望静态博客进程接 Stripe。

开发时 Handler 能跑、\`next export\` 后没有，先查 output 模式。

## 9. 排障怎么问

1. 第三方回调 404？export、路径写错、或方法不是 POST。
2. 验签永远失败？先 \`json()\` 再读 text，或反代改了 body。
3. 用户串数据？GET 被公共缓存。
4. OPTIONS 失败？浏览器预检，没处理 CORS。
5. Edge 上 SDK 报缺失模块？runtime 选错。

## 10. 设计取舍

- **Next 里兼做 API**：一个仓库、同 cookie 域。代价是 Node 运行时和前端绑死，扩缩一起。
- **UI 静态 + 后端独立（Nest）**：本站方向。契约用 types 包。代价是两个部署。
- **全 Action**：页面突变舒服。第三方进不来。

## 11. 小结

Route Handler 的原理是 **方法名映射到 Web Request/Response**，没有 React。URL 是契约，GET 的缓存语义是刀，Webhook 要 raw body 和签名。它和 Action 的差别是公开表面：一个给世界，一个给自己的 UI。

能回答「这个 URL 谁会打、能不能缓存、有没有 Node」，Handler 才算设计过。下一篇讲并行路由和拦截路由：同一 layout 上的多槽，以及弹窗为什么刷新会变成整页。`,

  "nextjs-parallel-and-intercepting-routes": `把「点击图片弹出层、URL 跟着变、刷新却变成完整详情页」理解成 \`useState\` 加 \`router.push\`，在生产里会立刻对不上。App Router 把这件事拆成两套匹配规则：**并行路由**（同一 layout 上同时填多个槽）和 **拦截路由**（客户端导航时借用另一段的 UI，硬刷新走真实叶子）。状态不在 React state 里，在 URL 和段树上。刷新丢失弹层、后退关掉层、分享链接打开整页，都是模型，不是要修的 bug。

这篇文章只讲这两套规则：\`@slot\` 是什么、\`default.tsx\` 为什么必须有、\`(.)\` / \`(..)\` / \`(...)\` 各自拦哪一层、软导航和硬刷新为什么渲染不同的树。读完你应该能独立回答三个问题：layout 为什么要同时收 \`children\` 和 \`modal\`、没有 default 时硬刷新为什么 404、拦截页和真实 \`photo/[id]/page.tsx\` 为什么要两份 UI。

## 1. 先画边界：槽是横向枝，不是 children 的别名

默认段树是纵向的：\`app/feed/layout.tsx\` 包着 \`app/feed/page.tsx\`，layout 只收 \`children\`。并行路由在同一层再长出枝：

\`\`\`
app/feed/
  layout.tsx
  page.tsx
  @modal/
    default.tsx
    (.)photo/[id]/page.tsx
app/photo/[id]/page.tsx
\`\`\`

\`@modal\` 文件夹名里的 \`@\` 表示具名槽。\`feed/layout.tsx\` 变成：

\`\`\`tsx
export default function FeedLayout({
  children,
  modal,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
}) {
  return (
    <>
      {children}
      {modal}
    </>
  );
}
\`\`\`

\`children\` 仍是默认槽（feed 列表）。\`modal\` 是另一套匹配。两套可以同时为真：列表还在，弹层叠在上面。这不是 CSS \`position: fixed\` 能代替的——列表对应的段没有卸，滚动位置和客户端 state 还在。

不变量：**槽的匹配失败不等于整页失败，除非你没提供 \`default.tsx\`。** 框架在「这个槽这趟导航没有对应页」时渲染该槽的 default；没有 default，开发态会警告，硬刷新常见 404。

## 2. 并行路由解决什么

同一 URL 上要同时存在两块独立生命周期的 UI：主列 + 侧栏分析、主列 + 弹层、主列 + 团队切换器。它们各自可以有自己的 \`loading.tsx\` / \`error.tsx\`，一块挂起或报错不必拆掉另一块。

\`@analytics/page.tsx\` 和 \`page.tsx\` 一起匹配 \`/feed\`。导航到只有主列的 URL 时，analytics 槽走 default（通常 \`null\`）。独立数据获取、独立 Suspense，这是段级切分，不是组件树上手写两个 fetch。

不要用并行路由去模拟 Tab。Tab 没有「刷新后变成另一棵合法叶子」的需求，\`useState\` 或 searchParams 更简单。并行路由的成本是文件系统和 default 纪律。

## 3. 拦截：软导航借壳，硬刷新走真页

\`@modal/(.)photo/[id]/page.tsx\` 里的 \`(.)\` 表示 **拦截同级** 的 \`photo/[id]\`。客户端从 \`/feed\` 点进 \`/photo/123\`：

- URL 变成 \`/photo/123\`（可分享、可后退）
- 匹配的是 \`@modal\` 里的拦截页（弹层）
- \`children\` 仍是 feed，列表不卸

硬刷新 \`/photo/123\`（新标签、地址栏回车）：

- 没有「当前正在 feed」的客户端记忆
- 拦截不成立
- 走 \`app/photo/[id]/page.tsx\` 完整详情

所以你需要 **两份 UI**：拦截页（薄，假定背后有 feed 壳）和真实 page（完整，独立可渲染）。复制是代价；省略真实 page，分享链接和刷新会空。省略拦截页，就没有「不丢滚动的弹层」。

## 4. (.) (..) (...) 拦的是哪一层

相对的是 **文件系统上的段，不是 URL 字符串随便写**。

- \`(.)\`：同级。\`feed/@modal/(.)photo\` 拦 \`feed\` 的兄弟 \`photo\`，或按你放的位置对应同层路由。
- \`(..)\`：上一级。从 \`feed/internal/@modal/(..)photo\` 往上拦。
- \`(...)\`：从根 \`app\` 拦。深层里拦截顶层 \`photo\`。

拦错层的症状：客户端导航完全不弹层，直接整页跳；或弹了但 URL 对不上后退栈。先画文件夹树，再写括号，不要从 Instagram 教程抄路径。

\`(..)(..) \` 两级同理。括号分组 \`(marketing)\` 不计入 URL，但计入你对「级」的直觉时容易数错——以段为准，以分组名为准要对照文档和实际匹配。

## 5. default.tsx 不是可选装饰

硬刷新 \`/feed\` 时 \`@modal\` 没有 photo 可匹配，必须渲染 \`@modal/default.tsx\`，通常：

\`\`\`tsx
export default function Default() {
  return null;
}
\`\`\`

软导航关掉弹层（\`router.back()\` 或推回 \`/feed\`）时，modal 槽也回到 default。没有它：框架不知道槽的空态，匹配空洞会炸。

\`default.tsx\` 还可以放「槽的空占位」——分析面板未选中时的提示。它是槽的 404 兜底，不是 page 的替身。

## 6. 关闭弹层与历史栈

打开拦截：\`<Link href="/photo/123">\` 往历史上推一条。关闭应当 \`router.back()\`，让 URL 回到 feed，拦截卸掉，列表还在。用 \`router.push('/feed')\` 会再堆一条 feed，后退又打开弹层，用户觉得「关不掉」。

分享出去的是 \`/photo/123\`。对方打开没有你的历史栈，必须是完整页。不要在拦截页里假设「一定有背后的 feed state」。

## 7. 和普通 modal 的取舍

| | 拦截 + 并行 | 纯客户端 Modal |
|---|---|---|
| URL | 真源，可分享 | 默认没有，或你自己 sync |
| 刷新 | 整页详情 | 层消失 |
| 后退 | 关层 | 未必 |
| 背后页 | 段还在 | 取决于你有没有卸 |
| 实现量 | 两份 UI + default | 一份 UI |

需要分享、需要刷新落地、需要滚动保持：走路由。一次性确认框：\`useState\`。用路由做确认框是过度设计；用 state 做相册是少做了产品。

## 8. 排障怎么问

1. 刷新 404？缺 \`photo/[id]/page.tsx\` 或缺 \`@modal/default.tsx\`。
2. 点击直接整页跳、不弹？拦截路径层级写错，或 Link 进了硬导航（\`<a>\` 而非 \`<Link>\`）。
3. 关掉再后退又弹？关闭用了 \`push('/feed')\` 而不是 \`back()\`。
4. 列表被卸掉？弹层写成了 children 而不是 \`@modal\`，或 layout 没渲染 children。
5. 只有开发正常？default 在生产匹配更严，硬刷新路径没测。

## 9. 设计取舍

- **两份 UI**：刷新和导航都正确。要保持弹层和整页视觉差小，改两处。
- **只做拦截不做真页**：开发体验好，分享坏。
- **槽过多**：\`@modal\` \`@drawer\` \`@sidebar\` 叠三层，default 和匹配矩阵爆炸。能合并成一个槽就合并。

## 10. 小结

并行路由的原理是 **同一 layout 上多套独立匹配的槽**。拦截路由的原理是 **软导航时用槽里的页顶替目标叶子，硬刷新仍走真实叶子**。URL 始终是真源；客户端叠层只是有历史栈时的投影。\`default.tsx\` 是槽的空态，不是可选项。

能回答「这次导航 modal 槽匹配了谁、刷新时哪份 page 生效」，弹层才算接到段树上。下一篇也是 Next.js 专栏最后一篇：Middleware 与 Edge——请求命中页之前那一层，以及它为什么不能当后端。`,

  "nextjs-middleware-and-edge-runtime": `把 Middleware 理解成「迷你后端」会在生产里立刻失效。它跑在请求命中 \`page.tsx\` / \`route.ts\` **之前**，默认是 Edge Runtime：没有完整 Node API、CPU 时间和包体积都紧、冷启动要小。能做的是改 URL、改 cookie、改 header、短路成 redirect/rewrite。不能当通用服务器：查主库、跑重 JWT 全家桶、读 \`fs\`，都会在边缘上变成超时或构建失败。

这篇文章只讲这一层：matcher 拦谁、rewrite 和 redirect 差在哪、鉴权读 cookie 的正确粒度、Edge 的能力边界、静态导出下还有没有 Middleware。读完你应该能独立回答三个问题：为什么在 middleware 里连数据库是错的、rewrite 为什么不改地址栏、静态博客的 middleware 会不会进 \`out/\`。

## 1. 先画边界：过滤器，不是应用服务器

\`middleware.ts\` 放在项目根或 \`src/\`，导出函数：

\`\`\`ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const token = request.cookies.get("session")?.value;
  if (!token && request.nextUrl.pathname.startsWith("/dashboard")) {
    const login = new URL("/login", request.url);
    login.searchParams.set("from", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
\`\`\`

它 **早于** RSC 渲染、早于 Route Handler、早于 \`loading.tsx\`。没有 \`await db.user.find\` 的正当位置：那会让每个静态资源、每个图片请求（若 matcher 太宽）都打库。

不变量：**Middleware 的输入输出是 HTTP 的皮，不是业务对象。** 你能看见的是 URL、header、cookie。看不见 React 树，也看不见即将渲染的组件 props。

## 2. matcher：先决定谁被拦

默认不写 matcher 时，容易误伤 \`_next/static\`、图片、favicon。每一个静态 chunk 都跑一遍 JWT 解析，边缘 CPU 和延迟一起涨。

\`matcher\` 是正向前缀/路径列表。排除静态：

\`\`\`ts
matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\\\.png$).*)"],
\`\`\`

更稳的是白名单：只拦 \`/dashboard/:path*\`、\`/api/:path*\`。少即是快。改 matcher 前后用日志打 pathname，你会发现自己拦过 \`/games/xxx.webp\` 这类路径。

## 3. next / redirect / rewrite

- \`NextResponse.next()\`：放行，可顺便 \`headers.set\`（CSP、地理、请求 id）。
- \`redirect\`：302/307 等，**地址栏变**。登录墙、把 www 归到 apex、把旧文档路径迁走。
- \`rewrite\`：内部换目标，**地址栏不变**。\`/about\` 内部交给 \`/zh/about\`，或 A/B 把 10% 流量指到 \`/b\` 页。

rewrite 不是反向代理万能胶。目标仍在本应用路由树里。拿到外域再 fetch，那是 Handler 的事，不该在 Edge 里把响应体整份读进来。

cookie 分桶做 A/B：第一次 rewrite 时 set cookie，后续用同一桶，避免同一用户来回跳实验。

## 4. 鉴权：读 cookie，不要在边缘验完整会话图

常见正确用法：有没有 session cookie、没有则 redirect。完整验签、查 Redis 会话、拉权限位，放在 Server Component / Guard / Handler。Middleware 只做廉价门卫。

把整个 JWT 库 + JWKS 刷新 + 角色图塞进 middleware，Edge bundle 膨胀，冷启动变差，每个匹配请求都付这份税。需要「边缘就拒绝过期 token」时，用轻量校验（过期时间字段）而不是完整 OIDC。

CSRF、CORS 预检：Middleware 可以挡明显坏请求，但不能替代 Handler 里的验签。

## 5. Edge Runtime 能干什么、不能干什么

能：URL 解析、cookie、header、少量计算、\`fetch\` 到近的 API（仍要设超时）。

不能（或极痛）：\`fs\`、大量 npm 原生模块、长时间 CPU、WebSocket 服务、可靠的内存状态（isolate 会丢）。Node 的 \`crypto\` 子集有，完整 SDK 常常没有。

\`export const runtime = 'edge'\` 在 Route Handler 上也会把该 Handler 推进 Edge。Middleware **默认就是 Edge**，没有「先当 Node 用着」这回事。要 Node 能力，把逻辑下沉到 Handler，middleware 只 redirect。

## 6. 国际化与地理

根据 \`Accept-Language\` 或 cookie rewrite 到 \`/zh/...\` / \`/en/...\`。检测逻辑要稳定：用户手动切语言后写 cookie，middleware 优先 cookie，避免每次按 header 把人抽回。

地理：平台注入的 country header（如 \`x-vercel-ip-country\`）只在特定托管有。本地 \`next dev\` 没有，必须有 fallback。合规上：地理不准当唯一鉴权。

## 7. 静态导出

\`output: 'export'\` **没有请求时服务器跑 middleware**。构建产物是静态文件，Caddy/Nginx 不会执行 \`middleware.ts\`。开发时 redirect 能跑、导出后登录墙消失，这是模式，不是漏配 matcher。

本站是静态博客 + 游戏。鉴权、i18n 分流若依赖 middleware，部署后不会生效。该在构建时生成多语言 HTML，或前面加真正的网关（CDN 规则、独立 Worker）。

## 8. 和网关、Handler 的分工

| 层 | 该做 | 不该做 |
|---|---|---|
| CDN / 反代 | TLS、WAF、全站 redirect | 业务鉴权细节 |
| Middleware | 廉价门卫、rewrite、实验分桶 | 查库、重 SDK |
| Route Handler / RSC | 真鉴权、真数据 | 每个静态资源验 JWT |

三层都写登录检查会乱。选一层做权威，其它层只做短路。

## 9. 排障怎么问

1. 静态资源变慢？matcher 太宽。
2. 本地有墙、导出没有？export 无运行时。
3. 无限 redirect？redirect 目标仍匹配 matcher 且仍无 cookie。
4. rewrite 后 404？目标路径在 app 树里不存在。
5. Edge 构建失败？import 了 Node 库。下沉到 Handler。

## 10. 设计取舍

- **门卫放 Middleware**：未登录请求不到 RSC，省渲染。只能看 cookie 皮。
- **门卫放 layout**：能 \`await getUser()\`，信息全。未登录也先跑一段 React。
- **门卫放 CDN**：最快。规则弱，复杂会话搞不定。

## 11. 小结

Middleware 的原理是 **匹配 → 改写或拒绝**，跑在 Edge，输入是 HTTP 皮。它不是后端，不是数据库客户端，也不是静态导出后的运行时。鉴权只做廉价判断；重活下沉。matcher 白名单。rewrite 改内部，redirect 改地址栏。

能回答「这个请求会不会进 middleware、进了之后有没有 Node、导出后还在不在」，这一层才算设计过。

至此 Next.js 专栏从段树、RSC、Action、流式、渲染模式、Handler、并行拦截到 Middleware 的主干已经按同一深度写完。缓存生命周期等篇在同专栏后续条目里。`,
};







