export const nextjsArticles: Record<string, string> = {
  "nextjs-app-router-mental-model": `App Router 的单位不是「页面文件」，是 **路由段（segment）**。每个文件夹是一段 URL，每段可以有 layout、loading、error、page。它们的生命周期不一样，这是心智模型的全部。

## 原理：段上的文件契约

- \`layout.tsx\`：该段外壳，导航时 **不卸载**（除非段变了）。状态、订阅、DOM 能保住。
- \`template.tsx\`：每次导航 **新实例**，适合进场动画。
- \`page.tsx\`：叶子段的主内容，对应一次匹配。
- \`loading.tsx\`：该段的 Suspense fallback，立刻可显示。
- \`error.tsx\`：该段 Error Boundary。

嵌套 layout 形成树：根 layout 包着 \`/dashboard\` layout 包着 page。切换 \`/dashboard/a\` 到 \`/dashboard/b\`，dashboard layout 还在。

## 插槽与 children

layout 必须渲染 \`children\`，那是更内层段。并行路由的 \`@slot\` 是额外插槽，不是 children。弄混就会出现「弹窗把整页换掉」。

## 工程上怎么用

认证壳放需要持久的 layout。把会报错的叶子放进自己的 error.tsx，避免整棵树白屏。不要在根 layout 塞客户端大组件。

## 小结

App Router 是段的树，不是 pages 的列表。谁在导航中存活，看它是 layout 还是 page。`,

  "react-server-components-deep-dive": `RSC 默认在服务端跑完，输出的是序列化后的组件树，不是 HTML 字符串那么简单。客户端收到的是「哪些地方需要挂客户端组件」的指令。零 bundle 的意思是：**这段组件的依赖根本不进浏览器**。

## 原理：两套模块图

没有 \`'use client'\` 的文件属于服务端图，可以 \`import fs\`、直接查库。遇到 \`'use client'\` 边界，服务端只保留对该客户端模块的引用，把 props 序列化过去。

不能从服务端往客户端传函数、class 实例、Map（除非支持的子集）。能传的是可序列化数据。这就是边界。

客户端组件仍可渲染服务端子节点（通过 children 插槽），因为 children 已经在服务端算好再传来。

## 为何快

Markdown 解析、日期库、ORM 都不下发。HTML 流里尽早出现内容。代价是交互必须明确下沉到客户端叶子。

## 工程上怎么用

叶子按钮、输入框才 \`'use client'\`。数据获取放服务端组件。不要为了用一个 hook 把整页标成客户端。

## 小结

RSC 的原理是「模块图分裂 + 可序列化 props」。边界画错，不是性能微调，是架构错误。`,

  "nextjs-server-actions-and-mutations": `Server Action 是可被客户端调用的服务端函数，带有框架生成的端点和 CSRF 机制。它不是魔法 \`eval\`，是 **一次 POST + 闭包序列化**。

## 原理

\`'use server'\` 文件或函数被编译成 ID。客户端调用时把参数序列化发到服务器，服务器执行函数，再按结果刷新相关路由缓存。绑定的 \`bind(id)\` 会把额外参数藏进闭包，必须当敏感数据看：客户端其实能看到序列化后的 bound args。

\`useActionState\` / \`useFormStatus\` 让 pending、错误、乐观 UI 成为表单的一等状态，不必手写 fetch。

## 和 Route Handler

Action 适合「表单/突变 + 随后 revalidate」。需要 Webhook、流式上传、非表单 REST 时仍用 Route Handler。

## 工程上怎么用

函数入口做鉴权，和写 API 一样。校验输入。突变后 \`revalidatePath\` / \`revalidateTag\` 要精确，避免整站缓存被一把刷掉。静态导出场景没有服务端，Action 不可用。

## 小结

Action 是带协议的服务端函数。原理是 POST 调用 + 缓存失效，不是「前端直接跑后端」。`,

  "nextjs-streaming-and-suspense-rendering": `流式渲染让 **已准备好的 HTML 先出管**，后面的 Suspense 块随数据到达再推。首字节和 LCP 可以早于最慢的那个 fetch。

## 原理

服务端渲染遇到 \`<Suspense fallback>\` 且子组件还在 await，就先把 fallback 写入流，继续渲染兄弟。数据好了发补丁，客户端替换。这依赖 HTTP 流和 React 的 progressive hydration。

没有 Suspense 的整页 \`await\` 会堵住整棵树。把慢查询拆成带 Suspense 的子树，才是流式。

## 和 loading.tsx

\`loading.tsx\` 是该路由段的隐式 Suspense。段级等待用它；更细的卡片级等待在 page 里显式 Suspense。

## 工程上怎么用

每个独立数据源一块 Suspense。不要一个 Promise.all 把所有源绑死。错误用 error.tsx 包在对应段，避免一个失败取消整片流。

## 小结

流式的原理是「渲染和数据解耦」。Suspense 是切分点，不是 loading 动画组件那么简单。`,

  "nextjs-rendering-strategies-ssg-ssr-isr": `四种模式的差别是 **HTML 在何时、何地、为谁生成**。选错的代价是缓存击穿或用户看到过期钱。

## 原理对照

- **静态导出**：构建时生成全部 HTML，无 Node 服务器。动态段必须可穷举。没有 Server Action、没有运行时 DB。
- **SSR**：每请求在服务器渲染。最新，但 TTFB 含数据时间，要自己管缓存。
- **SSG**：构建时渲染，之后当静态文件。适合不变的文档。
- **ISR**：静态生成 + 过期后在后台再生。用户可能看到上一代，下一次才是新的（视实现）。\`revalidate\` 是秒级时间，\`revalidateTag\` 是事件驱动。

没有银弹。营销页静态；用户后台 SSR 或客户端拉；文章 ISR；本博客这种纯静态站用 export。

## 工程上怎么用

\`generateStaticParams\` + \`dynamicParams = false\` 防止漏路径。带用户 cookie 的页面不要当静态。ISR 的脏数据窗口要写进产品预期。

## 小结

渲染模式是缓存与新鲜度的契约。原理是「谁在什么时刻跑 React 渲染」。`,

  "nextjs-route-handlers-rest-api": `\`app/api/xxx/route.ts\` 导出 \`GET/POST\` 就是 Route Handler。它跑在服务器（或 Edge），没有 React 树。适合 Webhook、OAuth 回调、给第三方的 REST。

## 原理

请求进 Handler，你返回 \`Response\`。可以读 cookie、headers，连数据库。默认 Node runtime，可改 Edge（没有完整 Node API）。

和 Server Action 比：Handler 是公开 HTTP，路径稳定，便于外部系统；Action 是给自己的 UI 突变用的。

静态导出时 Handler 不存在。本仓库 \`output: 'export'\` 就不能靠它做后端。

## 工程上怎么用

校验、鉴权、限流和传统后端服务一样。CORS 显式设。Webhook 验签。不要在 Handler 里塞页面 HTML。

## 小结

Route Handler 是框架内的 HTTP 适配器。原理是函数映射方法，不是「又一个 pages/api 的语法糖」那么浅——runtime 和导出模式会直接决定它能不能用。`,

  "nextjs-parallel-and-intercepting-routes": `并行路由让同一 layout 同时填多个槽（\`@modal\`、\`@analytics\`）。拦截路由让「点进详情」在当前布局上叠一层，刷新则走完整页。这是 URL 与 UI 层次的解耦。

## 原理

\`@modal\` 是具名槽，layout 用 \`{ modal, children }\` 接收。默认槽是 children。拦截 \`(.)photo\` 表示「在当前段拦截 photo 路由」：客户端导航时渲染拦截页（弹层），硬刷新匹配真实 \`photo/page\`。

默认页 \`default.tsx\` 在槽对不上时渲染，避免整页 404。硬刷新弹层 URL 时尤其需要。

## 工程上怎么用

弹层状态用 URL，不要只用 useState，否则刷新丢失。关闭弹层用 \`router.back()\` 或指向无拦截的路径。槽不要过深，调试成本高。

## 小结

并行是「多槽同时存在」，拦截是「导航时借壳」。原理都是文件系统路由的额外匹配规则。`,

  "nextjs-middleware-and-edge-runtime": `Middleware 在匹配的请求命中页面/Handler **之前** 跑，默认 Edge。它能改 URL、cookie、header，但不能当完整后端：没好的 Node API，CPU 时间和包体积都紧。

## 原理

\`middleware.ts\` 导出函数，\`NextRequest\` 进，\`NextResponse\` 出。\`matcher\` 过滤路径。改写（rewrite）不改浏览器地址，重定向会改。鉴权常在这里看 cookie，没有 cookie 就 redirect。

Edge 冷启动小，但把重 JWT 库全塞进去会反噬。能在网关做的事（地理、AB）适合；查主库不适合。

## 工程上怎么用

matcher 排除静态资源。别在 middleware 里连数据库。多语言：根据 header rewrite 到 \`/zh/...\`。和 CSP header 一起设时注意顺序。

## 小结

Middleware 是边缘上的请求过滤器。原理是「匹配 → 改写/拒绝」，不是通用服务器。`,

  "nextjs-caching-and-revalidation-lifecycle": `Next 15 的缓存是分层的：请求内去重、数据缓存、整路由缓存、客户端路由缓存。出 bug 几乎都是 **你以为没缓存，其实有一层还在**。

## 四层

1. **Request Memoization**：同一次渲染里相同 \`fetch\` 去重。只活在这一次请求。
2. **Data Cache**：跨请求的 fetch 缓存（服务端）。\`cache: 'no-store'\` 关掉。\`next: { revalidate, tags }\` 控制。
3. **Full Route Cache**：静态路由的 HTML 结果。
4. **Client Router Cache**：客户端点过的段。

\`revalidateTag('product-1')\` 是事件驱动失效。\`revalidate: 60\` 是时间驱动。用户突变后必须显式失效，否则 ISR 窗口里仍是旧 HTML。

## 工程上怎么用

每个 fetch 写明意图：用户私有数据 no-store；公开内容带 tag。失效时 tag 粒度要够细。开发模式缓存行为和生产不同，以生产为准做验证。

## 小结

缓存是分层状态机。原理是「每一层的 key 和失效条件」。调一个开关前先问在哪一层。`,

  "react-19-new-hooks-actions-use": `React 19 把「突变」收成 Actions：函数执行期间的 pending、错误、乐观结果由框架管。\`use()\` 让 Promise/Context 能在渲染里读，和 Suspense 对齐。

## 原理

\`useActionState(action, initial)\`：调用 action → pending true → 返回新 state。不必自己写 \`useState + useEffect\`。  
\`useOptimistic\`：在 Action 完成前先改 UI，失败再回滚。  
\`use(promise)\`：渲染期解包，未决议就 throw 给最近的 Suspense。只能在渲染中用，不能在 effect 里。

这把异步从「副作用」拉回「数据流」。和 RSC 的 await 组件是同一哲学的客户端对应物。

## 工程上怎么用

表单用 Action，不要再 fetch+setState 三件套。乐观更新只用于可回滚的字段。\`use()\` 的 Promise 要稳定引用，每次渲染 new Promise 会重挂起。

## 小结

新 hooks 的原理是「把异步纳入渲染模型」。pending 不是你的 state，是 Action 的生命周期。`,

  "tailwind-css-v4-and-modern-styling": `Tailwind v4 把设计 token 更多交给 **原生 CSS 变量和引擎**，而不是一长串生成好的工具类文件。原子类仍在，但主题、变体、构建管线更接近 CSS 本身。

## 原理

工具类还是「一个类一个声明」。变的是：主题用 \`@theme\` 写进 CSS；构建用新引擎扫源码；颜色/间距成为变量，运行时也能覆写（主题切换）。

原子化的本质权衡没变：约束来自设计系统，而不是运行时 CSS-in-JS。类名爆炸靠约定和抽取组件，不靠运行时。

## 工程上怎么用

组件边界用 React 组件包一组原子类，不要在 20 处复制 \`flex items-center gap-2\`。黑暗模式用变量，不要两套完整颜色类。和 CSS Modules 混用时明确谁赢。

## 小结

v4 的原理是「工具类 + 原生变量」。设计系统进 CSS，组件进 React，两边别抢。`,

  "frontend-typescript-advanced-type-system": `条件类型、映射类型、模板字面量类型让 TS 能描述 **数据形状的变换**，不只是标注。原理是类型级函数：输入一个类型，输出另一个。

## 原理

\`T extends U ? X : Y\` 是类型里的 if。 distributive 在裸类型参数上展开联合。\`{ [K in keyof T]: ... }\` 映射字段。模板字面量 \`\` \`on\${Capitalize<K>}\` \`\` 拼事件名。

这些发生在编译期。运行时 0 成本。过度体操会让错误信息不可读，和过度抽象一样有害。

## 工程上怎么用

为边界写类型（API 响应、配置、事件表），不要为内部循环写 10 层 infer。\`satisfies\` 保留字面量。\`noUncheckedIndexedAccess\` 打开后，索引变成可能 undefined——这是正确的。

## 小结

高级类型是编译期程序。原理是变换和约束，目的是把非法状态排除出调用方，而不是炫技。`,

  "frontend-state-management-zustand-vs-jotai": `Zustand 是一个 store（可切 selector）。Jotai 是原子网。原理差异是 **状态图的形状**：中心仓库 vs 依赖图。

## Zustand

一个（或几个）store，\`set\` 不可变更新，\`subscribeWithSelector\` 减少渲染。适合「本来就有领域对象」的 App：用户、购物车、编辑器文档。

## Jotai

每个 atom 是节点，派生 atom 自动依赖收集。适合「很多独立小状态」：每个格子、每个筛选器。原子过多时心智负担转移到「谁依赖谁」。

两者都能在 React 外读写下，这是和仅 Context 的差别：不是为了绑 UI 才存在的状态。

## 怎么选

有清晰领域模型、要 Devtools 时间旅行、团队来自 Redux → Zustand。  
页面是大量离散开关、派生多 → Jotai。  
别在同一功能里混两套真源。

## 小结

状态库的原理是订阅粒度。选中心还是选原子，看你的数据是不是本来就碎。`,

  "frontend-web-performance-core-web-vitals": `LCP、INP、CLS 是用户能感到的三种痛：看见慢、点了卡、布局跳。优化要对着指标的 **定义** 下手，而不是对着 Webpack 包体积玄学下降。

## 原理

**LCP**：最大内容绘制。通常是首屏大图或标题。优化：图片尺寸、优先级、服务器 TTFB、不挡渲染的 CSS。

**INP**：交互到下一帧绘制。点按钮到视觉反馈的延迟。优化：少长任务、拆 effect、Web Worker、减少主线程 JS。

**CLS**：意外位移。图没宽高、字体 swap、插入广告。优化：占位、\`size-adjust\`、不要在已渲染内容上方插 DOM。

它们互相独立。压了 JS 体积，LCP 仍可能被一张没 \`priority\` 的图拖死。

## 工程上怎么用

实验室 Lighthouse + 线上 RUM。按路由看 P75。图片永远带宽高。交互路径上的同步工作用 profiler 找 50ms+ 长任务。

## 小结

Vitals 是用户时间的三个投影。原理是「哪一段用户在等」。等像素、等 CPU、等布局稳定，对策完全不同。`,

  "fullstack-monorepo-turborepo-nest-next": `Monorepo 不是文件夹搬家，是 **用同一份类型和同一份构建图约束全栈与多应用**。Turborepo 负责任务图和缓存，不负责架构。

## 原理

\`apps/web\`、\`apps/api\`、\`packages/types\`。types 包导出 DTO，两端 import。改一个字段，两边编译一起红。这是契约。

Turbo 根据 \`pipeline\` 和文件 hash 决定 \`build\` 是否跳过。远程缓存让 CI 命中本地没做过的任务。缓存 key 必须包含环境，否则 staging 产物会被 production 命中。

## 工程上怎么用

内部包用 \`workspace:\`。ESLint/tsconfig 下沉到 \`packages/config\`。不要把 apps 互相 import。多端和 Next 的运行时分离，只共享类型和少量 isomorphic 函数。

静态导出的 Next 仍然可以在 monorepo 里和其他后端服务并肩，靠 types 包说话，靠 HTTP 通信。

## 小结

Monorepo 的原理是「一份图、一份契约、可缓存的任务」。Turbo 加速图，types 包固定契约。`,
};
