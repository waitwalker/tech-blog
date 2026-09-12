export const flutterArticles: Record<string, string> = {
  "flutter-engine-architecture-overview": `把 Flutter 理解成「一套跨端 Widget」会在生产里立刻失效。\`setState\` 不会把像素推上屏幕；\`build()\` 也不会调用 Metal。真正完成「Dart 世界 ↔ 操作系统世界」翻译的，是用 C/C++ 写的 **Flutter Engine**。Framework（\`package:flutter\`）只是 Engine 的客户：它产出一棵 Layer 树，然后把控制权交出去。

这篇文章只讲 Engine 这一层：它怎么分层、线程怎么切、一帧像素怎么走完、内存和消息在谁手里。读完你应该能独立回答三个问题：卡顿发生在哪条 Runner、启动慢消耗的是哪块资源、多 Flutter 页面为什么会把 RSS 打爆。

## 1. 先画边界：Framework 不在 Engine 里

日常写的 \`StatelessWidget\` / \`State.setState\` 属于 **Framework**，跑在 Dart 里，源码在 \`flutter/lib\`。Engine 的源码在 \`flutter/engine\`，主体是 C++，外加少量各平台的 Java/ObjC/Swift 嵌入代码。

两者通过一张很窄的契约对话：

- Framework → Engine：提交 \`Scene\`（Layer 树的最终形态）、注册帧回调、发 Platform Message、要纹理、要语义更新。
- Engine → Framework：Vsync 到达、指针事件、生命周期、Platform Message 回包、栅格化完成。

\`dart:ui\` 就是这张契约在 Dart 侧的投影。\`window\` / \`PlatformDispatcher\` / \`SceneBuilder\` / \`PictureRecorder\` 看起来像 Dart API，实现几乎都在 Engine。所以：**调 \`dart:ui\` 已经是在调 Engine，只是没有自己写 JNI。**

这个边界一旦画清，很多误解会消失。例如「Flutter 是解释执行所以慢」——Release 里 Dart 是 AOT 机器码，慢通常不在解释器，而在你是否堵了 UI Runner，或是否让 Raster Runner 画了过多离屏层。

## 2. Engine 的四层，职责必须互斥

可以把一份 \`FlutterEngine\` 实例拆成四块。生产问题几乎都能归到其中一块「做了不该它做的事」。

### 2.1 Dart Runtime（不管像素）

Runtime 负责：

- 加载 AOT isolate 快照（\`isolate_snapshot_data/instr\`）和 isolate 组快照
- 跑根 Isolate（以及你 \`compute\` / \`Isolate.spawn\` 出来的子 Isolate）
- 分代 GC、分配器、JIT（仅 Debug/Profile 的部分场景）
- 把 Dart 的微任务、事件循环和 Engine 的 Task Runner 接上

它 **不** 调用 GPU，**不** 持有窗口。\`build/layout/paint\` 这些 Framework 工作，只是跑在 Runtime 所在的 UI Task Runner 上。Runtime 卡顿的典型原因是：同步计算、超大对象分配引发 GC、在 UI Isolate 里做本该给 worker 的活。

Isolate 是内存隔离单位，不是线程。根 Isolate 默认绑在 UI Runner 上；你新 spawn 的 Isolate 会在新的 OS 线程上跑。跨 Isolate 只能传、不能共享可变对象——这是 Dart 的模型，Engine 只是实现了它。

### 2.2 图形后端：Skia 或 Impeller（不管 Dart 对象）

这一层吃的是 **DisplayList / 渲染指令**，吐的是 Metal、Vulkan 或 OpenGL 命令。

- **Skia**：通用 2D 引擎，能力面宽。代价是遇到没见过的绘制组合，可能在运行时编译着色器，移动驱动上一次编译可以是几十毫秒。
- **Impeller**：Flutter 自研，图元集合封闭，着色器在构建期用 \`impellerc\` 编进包，运行时原则上不再现场编译。

两者都活在 **Raster Task Runner** 上。你在 Dart 里 \`Canvas.drawPath\`，并没有立刻画：那是在 UI 线程往 Picture/DisplayList **记账**。真正的 fill rate、MSAA、纹理采样发生在 Raster 线程。

所以 GPU 掉帧和 Dart 掉帧是两种病。\`FrameTiming.buildDuration\` 对前者不敏感，\`rasterDuration\` 对后者不敏感。

### 2.3 文本、图片、字体（最容易被忽略的账单）

文本：LibTxt 做段落布局，HarfBuzz 做 shaping，ICU 做 bidi 和换行。**测量发生在 UI 线程。** 在 \`build\` 里对同一段超长字符串反复 \`TextPainter.layout\`，吃的就是 16.6ms 预算。

图片：压缩文件在 **IO Runner** 解码成 RGBA，再上传成 GPU 纹理（常在 Raster 侧完成上传）。解码尺寸是 \`宽 × 高 × 4\`，和 JPEG 文件 KB 数无关。4000×3000 的图是 48MB 量级，列表里几张就能把内存打穿。

字体：字形缓存、fallback 链、emoji 彩色字体，往往在首帧或第一次用到某语言时初始化。启动慢不一定是 Dart 代码多，可能是第一次 shaping CJK。

### 2.4 Shell / Embedder（唯一碰操作系统的一层）

Shell 回答这些题：

- 窗口 Surface 从哪来、多大、像素比多少
- Vsync 谁提供（Choreographer / CADisplayLink / 桌面合成器）
- 触摸、键盘、IME 从哪进
- App 前后台、Activity/ViewController 销毁时 Engine 怎么停
- Platform View（WebView、地图）如何嵌进 Flutter 的合成

换端（Android → iOS → 桌面）理论上只换 Shell，不换 Runtime 和图形语义。这是 Flutter「一份 Dart 代码」能成立的真正原因。代价是：每个平台的 Surface、线程、后台限制都不一样，Embedder 的 bug 会表现为「只有某机型掉帧」。

## 3. 线程模型：四条 Task Runner

Engine 不用「一个 UI 线程包打天下」。它有四条队列，跨队列通信全是 **投递任务**，不是直接调函数。

| Runner | 典型线程 | 允许做什么 | 绝对不要做什么 |
|---|---|---|---|
| Platform | 系统主线程 | 生命周期、插件、部分输入、Platform View | 重计算、等网络（Android 上会 ANR） |
| UI | Engine 创建的 UI 线程 | Dart、手势、build/layout/paint 记账 | 同步读磁盘、等 GPU、大 FFI |
| Raster | Engine 创建的 GPU 线程 | Skia/Impeller、纹理上传、提交 swapchain | 跑 Dart、阻塞等锁 |
| IO | 后台线程 | 图片解码、部分文件 | 碰 \`dart:ui\` 对象 |

**不变量：** UI 不碰 GPU 上下文；Raster 不跑 Dart；Dart 对象不得在 Raster 上解引用。Layer 树从 UI 交到 Raster 时，走的是一次线程安全的移交，不是共享可变树。

Platform Channel 的「异步」就是这个模型的直接推论：Dart 把字节丢进队列，Platform Runner 取出、调 Java/ObjC、再把字节扔回去。你 \`await\` 到的延迟 = 排队 + 拷贝 + 原生执行。没有共享内存，所以大图走 Channel 会双倍拷贝。

## 4. 一帧到底怎么走完

用一次用户点按钮、触发 \`setState\` 来把整条链路串起来。

1. **输入**  
   系统把 pointer 交给 Shell → 转成 Engine 的指针包 → 投递到 UI Runner → Framework 做 HitTest 和手势竞技场。

2. **标脏**  
   \`setState\` 只给 Element 打标。没有立刻 build，更没有立刻 draw。

3. **等 Vsync**  
   Shell 从系统拿到下一拍 Vsync，唤醒 UI Runner。这就是帧的节拍器。没有 Vsync，Framework 不会自己空转刷屏（调试里的自定义 scheduler 除外）。

4. **UI Runner：Animate → Build → Layout → Paint**  
   产出的是 Layer 树 / DisplayList，不是 framebuffer。这一段时间计入 \`buildDuration\`。

5. **移交**  
   \`Scene\` 被投递到 Raster Runner。UI Runner **可以** 开始准备下一帧（流水线）。如果 Raster 还在画上一帧，可能产生排队，表现为持续掉帧而不是单帧尖刺。

6. **Raster Runner**  
   Impeller/Skia 执行指令、采样纹理、处理 clip/saveLayer、提交到 swapchain。时间计入 \`rasterDuration\`。

7. **系统合成**  
   最终 buffer 交给 SurfaceFlinger / Core Animation。这里还有一次合成延迟，和 Flutter 内部流水线叠加，所以「触控跟手」不只取决于你的 Dart 是否小于 8ms。

关键推论：**你在 Framework 里做的优化，只能缩短步骤 4。** 步骤 6 的模糊、大图、过多离屏，必须减层、减像素。步骤 1/3 的问题在 Embedder。把所有卡顿都怪 Redux，是在错的层找原因。

## 5. 启动路径：为什么冷启动像「引擎点火」

创建一个 \`FlutterEngine\` 大致要：

1. 加载并映射 AOT 快照（mmap 机器码，不是逐字节解析 Dart）
2. 创建四条 Runner / 线程
3. 初始化 Dart isolate，跑 \`main()\` 直到第一帧回调挂上
4. 建 GPU 上下文、可能编译/绑定首批管线
5. 等第一块 Surface 和第一次 Vsync
6. 第一帧 layout + 字体 fallback + 首图解码

所以冷启动慢，常见账单是：快照太大、首帧字体/图片、GPU 管线第一次绑定、在 \`main()\` 里同步做插件初始化。Debug 模式还有 JIT 和检查器，不能拿来和 Release 比启动。

\`FlutterEngineGroup\` 的意义就在这里：第一份 Engine 付完 VM/GPU/字体的固定成本，后续 spawn 只再挂一个 Isolate 和一块 Surface，增量内存可以到百 KB 级。混合 App 里每页 new 一个孤立 Engine，等于每次重新点火。

## 6. 内存：谁分配、谁释放、谁跨线程

几块互不混淆的堆：

- **Dart 堆**：Isolate 私有。GC 管。图片的 \`Codec\` 解码结果若被 ImageCache 引用，会钉在堆上。
- **原生堆（C++）**：Layer、DisplayList、字体缓存、Codec 中间缓冲。
- **GPU 显存**：纹理、MSAA、离屏 FBO/Texture。\`RepaintBoundary\` 缓存也在这儿。

跨线程移交必须拷贝或转移所有权，不能两边同时写。这就是 Channel 拷贝、FFI 要自己管 \`free\`、Texture 要用共享 GPU 对象的原因。

泄漏排查要先问在哪块堆：DevTools Memory 看 Dart；原生要用 instruments / Android Studio Profiler；显存看纹理数量和 \`ImageCache\` 的字节上限。三套工具，三套结论。

## 7. 和操作系统的另外两条管道

**Platform Message（Channel）**  
消息、编解码、跨 Platform ↔ UI 队列。适合配置、权限、一次性调用。不适合每帧数据和零拷贝大缓冲。

**FFI**  
同一进程、C ABI、直接函数调用。没有队列语义，默认也没有线程切换。适合计算库。指针生命周期完全由你证明。

**Platform View / Texture**  
当必须嵌 WebView、相机、地图时，Engine 不再独占 GPU。像素通过虚拟 Display、多 Surface 合成或共享纹理进来。这是 Engine 架构上最贵的例外：破坏了「一条 Raster 线程画完所有像素」的假设。

选管道就是选一致性模型。不要用 Channel 模拟 FFI，也不要用 FFI 调 UIKit。

## 8. 设计取舍（为什么是现在这样）

- **自绘而不是系统控件**：像素跨端一致，动画不受 OEM 控件限制。代价是无障碍、IME、平台 View 都要 Engine 自己接一层语义树和嵌入协议。
- **单 UI Isolate 跑 Framework**：没有 UI 数据竞争，推理简单。代价是任何同步卡顿都是全屏卡顿，必须把重活赶到 worker Isolate 或原生。
- **渲染下沉 C++**：换 Shell 就能换端。代价是性能问题经常要同时看 Dart 火焰图和 GPU 捕获。
- **帧对齐 Vsync**：省电、不撕裂。代价是输入到上屏至少隔着合成器的一拍。

这些取舍决定了「什么优化有意义」。例如在 Dart 里微优化 JSON 解析，远不如让 JSON 离开 UI Isolate；在 Widget 层换状态库，远不如减少 \`saveLayer\`。

## 9. 怎么把原理用到排障上

遇到问题，按层提问，不要一上来改业务代码：

1. **是 UI 超时还是 Raster 超时？** \`FrameTiming\` 一拆就知道。方向完全相反。
2. **是启动还是稳态？** 启动看快照、字体、首管线；稳态看每帧分配、图层、图片尺寸。
3. **是单 Engine 还是多 Engine？** RSS 随页面线性涨，先查有没有 EngineGroup。
4. **是 Dart 堆、原生堆还是显存？** 工具不同。
5. **有没有平台 View / Channel 大包？** 这些走的是例外路径。

能回答这五问，Engine 对你就不再是黑盒，而是一张有边界的地图。

## 10. 小结

Flutter Engine 是运行时、渲染器、资源系统和操作系统嵌入层的合体。Framework 产出场景描述，Engine 负责在正确的线程上、用正确的内存模型，把场景变成屏幕上的 buffer。

跨端能力来自 Shell 可替换；流畅来自 UI/Raster 流水线；可预测的帧时间来自「Dart 不碰 GPU、GPU 不跑 Dart」。把问题归到这一层，后面讲管线、Impeller、Isolate、Channel 才有落点。下一篇会沿着第 4 节的步骤 4，把 Animate / Build / Layout / Paint 拆开。`,

  "flutter-rendering-pipeline-four-phases": `一帧不是「画一下」那么简单。Vsync 到来后，Flutter 必须在约 16.6ms（120Hz 则 8.3ms）内走完 Animate → Build → Layout → Paint，再交给 Raster 线程合成。任何一个阶段把预算吃光，用户看到的就是 Jank。

## 问题从哪里来

\`setState\` 并不等于立刻刷新。它只是给 Element 打脏标记。真正的工作被攒到下一帧的 \`RendererBinding.drawFrame\`。如果你在滚动回调里同步算布局，等于在 Animate/Build 阶段做 Layout 的事，帧必然爆。

## 原理：四个阶段各自保证什么

**Animate**  
Ticker / \`AnimationController\` 按帧时间步进。只更新数值，不碰树。原则：动画值可以每帧变，树结构尽量别每帧变。

**Build**  
只重建被标脏的 Element 子树。\`Widget.canUpdate\` 为 true 时 Element 和 RenderObject 复用。Build 的复杂度应接近「脏节点数量」，而不是整棵 Widget 树。

**Layout**  
从根 \`RenderObject\` 向下传 \`BoxConstraints\`，向上返回 \`Size\`。Flutter 强制 **一次遍历**：子节点不能在同一帧回头改父约束，否则 O(N) 变成反复震荡。

**Paint**  
不立刻调用 GPU。它把绘制指令记进 Layer / DisplayList。真正的 GPU 工作在 Raster 线程。所以 Paint 阶段慢，通常是「记录了太多层/太多 saveLayer」，不是「GPU 没力」。

## 为什么 Layout 能 One-Pass

父给子一个约束盒子（min/max 宽高），子必须在这个盒子里选自己的 size。子不能说「我先随便高，你再告诉我宽」。这个不变量让每个节点最多被 layout 一次（除非它不是 relayout boundary 且祖先又脏了）。

## 和合成的分界

Paint 之后还有 Composite：把 Layer 树建成 \`Scene\`，Raster 线程执行。UI 线程此时已经可以开始准备下一帧。这就是流水线：第 N 帧在 GPU 上，第 N+1 帧在 Dart 里。

## 工程上怎么用

- 动画只改 \`RepaintBoundary\` 内的绘制，避免整页 Build。
- \`LayoutBuilder\` 会把父布局和子 build 绑在一起，能不用就不用。
- 列表用 \`Sliver\`，让未出现的孩子根本不进 Layout。

## 小结

四个阶段是时间片上的流水线，不是四个可以随便穿插的钩子。谁在哪个阶段做事，决定你有没有 16ms。`,

  "flutter-impeller-next-gen-renderer": `Impeller 要解决的不是「画得更好看」，而是 **首帧和动画中突然出现的 shader 编译卡顿**。Skia 在移动端的历史包袱是：遇到没见过的绘制组合，运行时才编译 GPU 程序，一次可能几十毫秒。

## 问题从哪里来

模糊、渐变、复杂 Path、阴影，每一种组合都可能对应新的着色器变体。Android 上驱动编译 GLSL 尤其慢。用户表现是：第一次打开某页面掉一帧，之后就顺了——因为 shader 已经在缓存里。

## 原理：把编译从运行时挪到构建时

Impeller 的核心不变量：

- **图元集合封闭**：圆、矩形、路径、模糊、渐变等，收敛到有限几种绘制操作。
- **着色器离线编译**：\`impellerc\` 在构建期生成 Metal 二进制或 SPIR-V，打进包。
- **管线状态对象（PSO）预先创建**：顶点格式、混合模式、深度模板在运行时不再现场编译。
- **无全局 OpenGL 状态机**：用 Metal/Vulkan 的 command buffer，线程可以并行录制。

因此「第一次画某种效果」不再触发编译，只是绑定已经存在的管线。

## 和 Skia Warmup 的本质差别

Skia 预热是录制一遍动画，把当时用到的 shader 存下来。换 GPU、换系统、换一个没录到的效果，预热包就失效。Impeller 是架构上取消运行时编译，不是缓存问题。

## 取舍

包体积会增加（预编译 shader）。极端自定义着色器要走 Impeller 的扩展路径，不能再指望 Skia 的无限运行时特化。换来的是帧时间分布可预测。

## 工程上怎么用

打开 Impeller 后仍掉帧，不要先怀疑 shader。去看是否 \`saveLayer\`、大图解码、过多 clip。Impeller 消灭的是编译尖刺，不是所有 GPU 负载。

## 小结

Impeller 用「封闭图元 + 离线管线」换掉「开放特化 + 运行时编译」。卡顿从「偶尔几十毫秒」变成「稳定的填充率问题」，后者才是可以优化的。`,

  "flutter-renderobject-layout-protocol": `Flutter 布局不是 CSS 那套「算完再回头改」。它是严格的 **约束向下、尺寸向上** 协议。理解 \`BoxConstraints\` 和 \`performLayout\`，才能写对自定义布局，也才能解释为什么有的 setState 会整页 relayout。

## 问题从哪里来

父要横向排三个孩子，每个孩子又想「按内容高度撑开」。如果孩子能强迫父改宽，父再改孩子高，同一帧会来回算。Flutter 直接禁止这种回溯。

## 原理：一次对话

父调用：

\`\`\`dart
child.layout(constraints, parentUsesSize: true);
\`\`\`

孩子在 \`performLayout\` 里：

1. 读 \`constraints\`（min/max 宽高）。
2. 给自己的孩子传 **更紧或相等** 的约束（不能放宽到超出自己收到的盒子）。
3. 设定 \`size\`，必须满足约束。
4. 用 \`parentData.offset\` 摆子节点。

\`parentUsesSize: true\` 表示父稍后会读 \`child.size\`。若为 false，孩子可以成为 relayout boundary：孩子自己变大变小，不必通知父。

## Relayout Boundary 何时出现

满足任一条件，节点成为边界：

- 父不使用子 size（\`parentUsesSize == false\`）
- 约束是紧的（max==min，尺寸被钉死）
- \`sizedByParent == true\`（尺寸只由约束决定，如 \`RenderColoredBox\`）

边界的意义：子树内部 relayout 停在这里，不再向上污染。这是列表、叠层、忽略子尺寸的容器能快的原因。

## 常见协议破坏

- 在 \`performLayout\` 里根据子 size 再给子一套不同约束并第二次 \`layout\`（部分 sliver 有受控的二次 layout，普通 RenderBox 不要学）。
- 在 paint 里改 size。
- 忽略 \`constraints.constrain(size)\`，画出盒子外再靠 clip 遮——命中测试会错。

## 工程上怎么用

自定义布局先写约束传递的纸面表：每个孩子拿到什么 min/max，自己最终 size 是什么。再用 \`debugDumpRenderTree()\` 看实际约束。性能上，尽量让会独立变化的子树处于 boundary 下。

## 小结

布局协议是单向数据流。谁破坏单向，谁就失去 O(N) 和可预测性。`,

  "flutter-layer-tree-and-compositing": `Paint 记下的不是最终像素，是 **Layer 树**。合成（Compositing）决定哪些内容进同一张纹理、哪些必须离屏。很多「GPU 忙」其实是 saveLayer / clip / opacity 把一帧拆成了多次离屏绘制。

## 问题从哪里来

Opacity、Blur、复杂 Clip、Transform 动画，都会让一块 UI 不能和背景一次画完。GPU 要先画到中间纹理，再混合。中间纹理又占显存又占带宽。

## 原理：从 PaintingContext 到 Scene

\`PaintingContext\` 当前有一个 \`ContainerLayer\`。需要独立合成时：

1. \`pushOpacity\` / \`pushClipRect\` / \`pushTransform\` 挂一个新 Layer。
2. 在新 Layer 的 context 里继续 paint。
3. 弹出，回到父 Layer。

整棵 Layer 树最后 \`buildScene()\`，生成 \`ui.Scene\`，交给 Raster 线程。Raster 线程遍历 Layer，调用 Impeller/Skia 出图。

不是每个 RenderObject 都对应一个 Layer。只有「需要合成属性」的节点才 push layer，其余绘制进当前 PictureLayer 的 display list。这就是为什么一个静态图标堆叠不一定慢，一个全屏模糊一定慢。

## 合成与 RepaintBoundary

\`RepaintBoundary\` 会创建一个 \`OffsetLayer\`，并把子树画进可缓存的 buffer。它隔离的是 **重绘**，不是布局。子树每帧都变，缓存没有意义，还多一次离屏。

## 取舍

多 Layer：动画可以只更新一层（例如只转 opacity）。代价是显存和合成时间。少 Layer：填充率低，但任何脏点都可能重画一大片。

## 工程上怎么用

DevTools 打开「Performance overlay」看 UI/GPU 条。GPU 条高：减 clip、减 opacity 动画、减 blur，或把动画限制在小的 boundary 里。不要给整页加 \`Opacity\`。

## 小结

Layer 树是「哪些像素可以一起画」的计划。合成次数，不是 Widget 数量，才是 GPU 侧的账单。`,

  "flutter-repaintboundary-isolation-mechanism": `\`markNeedsPaint\` 会沿父链向上走，直到遇到 \`isRepaintBoundary == true\`。RepaintBoundary 的本质是 **重绘洪水的堤坝**，附带一张可选的位图缓存。用对了省帧，用错了费显存。

## 问题从哪里来

一个小 loading 转圈，如果没有边界，脏标记会走到根，整页重画。反过来，给每帧都在变的列表每一项都加 Boundary，等于每项一张离屏纹理，滚动时带宽爆炸。

## 原理

RenderObject 默认 \`isRepaintBoundary == false\`。\`RepaintBoundary\` 对应的 RenderObject 为 true，并带 \`OffsetLayer\`：

- 子树 paint 的目标是这块 Layer 的 buffer。
- 祖先重绘时，若子树没脏，直接合成这张缓存纹理。
- 子树脏时，只重绘这棵子树，再更新缓存。

缓存有代价：尺寸变化、设备像素比变化都要重建纹理。动画里 size 一直变，缓存命中率为零。

## 和布局边界的区别

Relayout boundary 挡的是 \`markNeedsLayout\`。Repaint boundary 挡的是 \`markNeedsPaint\`。两者独立。一个节点可以挡住重绘但挡不住布局，反之亦然。

## 工程上怎么用

适合加：静态复杂子树（图表、地图上的控件、不滚动的头部插画）。  
不要加：本身每帧在变的东西（进度条、粒子、视频）。  
列表项：只在「项很重且滚动时项内容不变」时考虑；普通文字列表不要。

用 Performance overlay 的棋盘格（checkerboard）看缓存层是否在闪——闪说明一直在重绘缓存，Boundary 是负优化。

## 小结

Boundary 是隔离，不是加速魔法。隔离的前提是「里面稳、外面吵」或「里面吵、外面稳」。两边都吵，就别隔。`,

  "flutter-vsync-and-thread-model": `Flutter 运行时不是「一个线程画 UI」。它是四条任务队列，靠 Vsync 对齐。搞混线程，就会出现：卡顿在 Dart、卡顿在 GPU、卡顿在平台通道，三种完全不同的病。

## 四条 Runner

- **Platform**：操作系统主线程。生命周期、插件、Platform View、部分输入。Android 上别在这里做重活，否则 ANR。
- **UI**：Dart。Widget/Element/RenderObject、手势竞技场、生成 Layer 树。帧预算里的 build/layout/paint 都在这。
- **Raster**：消费 Layer 树，调 Skia/Impeller。不能跑 Dart。
- **IO**：图片解码、部分文件和网络回调投递。解码后的像素要再上传纹理，上传常发生在 Raster。

## 原理：Vsync 如何变成一帧

Embedder 注册系统 Vsync。信号来时：

1. UI Runner 被唤醒，\`drawFrame\`。
2. 若上一帧 Raster 还没跑完，可能等待或开始流水线的下一拍（取决于实现和是否 vsync 对齐）。
3. Layer 树跨线程交给 Raster。
4. GPU 完成，buffer 交给系统。

流水线意味着：**UI 处理 N+1 时，Raster 可能还在处理 N**。所以「我 Dart 已经很快了仍掉帧」完全可能——GPU 侧没跟上。

## 双缓冲与延迟

为了不撕裂，提交的是「上一帧完成的 buffer」。这会引入一帧延迟。追求极致触控跟手时，要理解这是合成器的锅，不是 Dart 慢了 8ms 那么简单。

## 工程上怎么用

- CPU 重活：\`compute\` / Isolate，不要占 UI。
- 图片：\`cacheWidth\` 在 IO 解码时缩小，避免 Raster 上传 48MB 纹理。
- 插件回调默认可能在 Platform 线程，切回 UI 再 \`setState\`。

## 小结

线程模型规定了「谁可以等谁」。Vsync 是节拍器。优化前先确认瓶颈在哪一条 Runner。`,

  "flutter-dart-vm-gc-and-memory": `Dart VM 用分代 GC：新生代复制，老年代标记清除。Flutter 每秒 60/120 次 build，如果每帧都 new 大对象，GC 会变成掉帧源。原理要落到「对象活多久、有多大」。

## 问题从哪里来

\`build()\` 里创建 1000 个临时 Widget 通常没问题——它们很小、立刻死、新生代 scavenge 亚毫秒。危险的是：每帧 new 大 List/图片解码器/超长字符串，或把短命对象挂到长命缓存上，迫使它们晋升老年代。

## 原理：两代

**新生代（New）**  
半空间复制（Scavenge）：活对象拷到另一半，其余当垃圾。空间小、停顿短。适合「这一帧用完就扔」的 Widget、Element 更新中的短命对象。

**老年代（Old）**  
活过几次 scavenge 的对象进来。标记可以并行，清扫可以并发，但一旦 compact 或老年代满，停顿明显变长。老年代里的对象如果被新生代引用（跨代指针），写屏障会记账。

Isolate 堆不共享。主 Isolate 的卡顿不会被 worker Isolate 的 GC 直接分担，但 worker 回传的大对象会在主 Isolate 分配。

## 晋升是性能事件

短命大对象晋升后：占老年代、增加标记成本、可能触发老年代 GC。典型错误：把每帧的 \`List<Offset>\` 存进 \`State\` 却不复用；图片解码结果没人管却被全局 cache 引用。

## 工程上怎么用

- 热路径复用 List/Paint/Path，或放到 \`State\` 里按需更新。
- 图片用 \`ImageCache\` 上限，解码指定 \`cacheWidth\`。
- 用 DevTools Memory 看「GC 次数 vs 帧时间」是否重合。

## 小结

GC 不是敌人，无界分配才是。让短命对象保持短命，让长命对象保持稳定，帧时间才稳。`,

  "flutter-element-tree-diff-algorithm": `Flutter 三棵树：Widget（不可变配置）、Element（实例化的生命周期）、RenderObject（布局绘制）。Diff 发生在 Element 层。Key 不是「优化」，是 **身份证明**。

## 问题从哪里来

列表交换两项、Tab 切换、\`if\` 插入一个兄弟。没有 Key，Element 按位置复用：第一个孩子对第一个孩子。于是 State、焦点、滚动位置会「跟错人」。

## 原理：canUpdate

\`\`\`dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType
      && oldWidget.key == newWidget.key;
}
\`\`\`

true：更新同一个 Element，换新的 Widget 配置，RenderObject 尽量留下。  
false：拆掉旧 Element（deactivate/unmount），inflate 新的。

同级多个孩子时，框架先按 Key 匹配，再按类型+位置匹配。\`GlobalKey\` 还能跨位置把 Element 挪走，代价是全局注册表和更贵的查找。

## 和 React 的差异

Flutter 的 Element 同时握着 State 和 RenderObject。复用 Element 等于复用 State **和** 布局对象。所以 Key 用错，不只是 state 错，连 size/layer 缓存都会错。

## 工程上怎么用

- 集合里稳定身份：\`ValueKey(id)\`，不要用 index（排序后 index 会骗人）。
- 不要给静态子树随便 GlobalKey。
- \`const\` Widget 能跳过重建，但 Key 规则仍然适用。

## 小结

Diff 问的是「你还是不是同一个人」。runtimeType + key 就是身份证。位置只是没有身份证时的猜测。`,

  "flutter-custom-renderobject-practice": `当每帧有成千上万个点、粒子、K 线时，Widget 树本身会先把 CPU 吃光。自定义 \`RenderBox\` 是把 layout/paint 收回到一个节点，直接打 Canvas。

## 问题从哪里来

每个粒子一个 Widget → 每个粒子一个 Element + RenderObject。60fps 下光 diff 和 visit 子节点就不够用。正确模型：一个 RenderObject 拥有全部粒子数据。

## 原理：最小实现

\`\`\`dart
class RenderParticles extends RenderBox {
  @override
  void performLayout() {
    size = constraints.biggest;
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    final canvas = context.canvas;
    canvas.save();
    canvas.translate(offset.dx, offset.dy);
    // 一次遍历粒子，drawPoints / drawAtlas
    canvas.restore();
  }

  @override
  bool hitTestSelf(Offset position) => size.contains(position);
}
\`\`\`

数据变了调 \`markNeedsPaint\`，不要 \`markNeedsLayout\`，除非 size 算法变了。动画用 Ticker 改内部数组，再 mark paint。

## 合批是性能核心

用 \`Canvas.drawPoints\`、\`drawRawAtlas\`、\`drawVertices\`，而不是循环 \`drawCircle\` 一万次。Impeller/Skia 对合批友好，对调用次数不友好。

## 手势

重写 \`handleEvent\` 或组合 \`RawGestureDetector\`。命中测试：若粒子可点，自己做空间索引，不要为每个粒子生成 RenderObject。

## 小结

自定义 RenderObject 的原理是 **降低树的基数**。把 N 个对象变成 1 个节点 + N 条绘制指令。`,

  "flutter-gesture-arena-and-dispatch": `一次触摸会同时唤醒多个手势识别器。Flutter 用 **竞技场（Arena）** 做仲裁：同一指针，最终只能有一套手势赢。这比「谁先注册谁处理」可预测。

## 问题从哪里来

列表要竖滑，子项要横滑删除，子项还要 tap。三个识别器都会在 pointer down 时入场。没有竞技场，就会又滚动又删除。

## 原理：两条链路

**HitTest**  
从 RenderView 深度优先往下，\`hitTest\` 为 true 的节点把自己加入路径。路径是「从内到外」的候选列表。

**Arena**  
每个相关的 \`GestureRecognizer\` 入场。默认大家 hold。某识别器确定（例如移动超过阈值）就 \`accept\`，框架让其余 \`reject\`。都不确定则可能延迟到 pointer up（tap 就是这种）。

父子都可以认领。\`Listener\` 是原始指针，不进竞技场；\`GestureDetector\` 进。\`behavior: HitTestBehavior.opaque\` 会让命中测试在自己这里停下，挡住下面的人。

## 竞争策略

- 滚动通常等垂直/水平锁定期。
- 双击会拖延单击的胜出（等待可能的第二次 down）。
- \`EagerGestureRecognizer\` 可以在 down 时立刻赢——用在「必须挡住父滚动」的画布。

## 工程上怎么用

嵌套滚动先确定谁是竞技场赢家，再用 \`notification\` 做二次协调。不要在 \`Listener.onPointerMove\` 里和 \`Scrollable\` 抢同一根手指还不进 arena。

## 小结

命中测试决定谁有资格，竞技场决定谁能做完。手势 bug 先画「谁入场、谁 accept」。`,

  "flutter-platform-channels-codec-binary": `MethodChannel 看起来像 \`invokeMethod\`，底下是 **BinaryMessenger + Codec**。每一次调用都是：编码 → 跨线程队列 → 原生解码 → 执行 → 再编码回来。延迟和拷贝都发生在这条链上。

## 问题从哪里来

把 4K 图片或每帧传感器数据走 MethodChannel，会在 Dart 堆和原生堆之间来回拷贝，并卡住 Platform 线程。这不是 Channel「慢」，是你选错了通道。

## 原理

\`BinaryMessenger\` 只认识 \`ByteData\`。\`StandardMessageCodec\` 把 null/bool/int/double/String/List/Map/Uint8List 编成紧凑二进制，比 JSON 少解析和临时字符串。

\`MethodChannel\` 在 codec 之上加了 method 名和 error 结构。\`EventChannel\` 是反向流：原生 push，Dart listen。两者都默认异步，因为要切线程。

共享的是消息，不是内存。\`Uint8List\` 仍会拷贝（除非走 FFI/纹理）。

## 何时不该用 Channel

- 需要零拷贝大缓冲：FFI 或 Texture。
- 需要同步返回：Channel 做不到真正的同步（会阻塞 UI 或 ANR）。
- 高频小包：考虑合并、或 EventChannel 批量。

## 工程上怎么用

自定义 Codec 只在类型集合稳定时做。错误用 \`PlatformException.code\` 当稳定协议。Dart 侧 \`await\` 必须能在 dispose 后丢弃。

## 小结

Channel 是消息总线，不是共享内存。原理是编解码 + 队列，不是函数调用。`,

  "flutter-ffi-zero-overhead-interop": `FFI 把 C 函数当成 Dart 能直接 \`call\` 的地址。没有序列化，没有方法名字符串，默认也没有线程切换。这是和 Platform Channel 完全不同的调用模型。

## 问题从哪里来

音视频、密码学、物理引擎，Channel 的拷贝和异步往返不可接受。FFI 让 Dart 和 C 共享同一调用栈（在同一线程上）。

## 原理

\`DynamicLibrary.lookup\` 得到函数指针，\`Pointer<NativeFunction<...>>.asFunction\` 得到 Dart 闭包。参数是 C ABI：int、指针、struct（按 FFI 布局）。

内存：\`Pointer<Uint8>\` 指向的是 **原生堆**。Dart 的 \`Uint8List\` 在托管堆。要零拷贝，必须让 Dart 直接读写这块 Pointer，或用 \`asTypedList\` 在同一内存上做视图（视图的生命周期不能超过原生释放）。

## 危险点

- 原生内存在 Dart 还在用时 \`free\`：use-after-free。
- 在 UI 线程跑重 C 函数：和同步 Dart 循环一样掉帧。应 \`NativeCallable\` 或在 Isolate/worker 调 FFI。
- 异常不能跨 ABI：C++ 异常必须在 C 边界捕掉。
- GC 不会扫 C 堆：泄漏要自己管，\`NativeFinalizer\` 可绑释放。

## 和 Channel 怎么选

配置、权限、一次性系统 API → Channel。  
热路径、大缓冲、已有 C 库 → FFI。

## 小结

FFI 的原理是「同一进程、同一 ABI、手动内存」。性能来自没有中间层，风险也来自没有中间层。`,

  "flutter-platform-views-texture-hybrid": `在 Flutter 里嵌 WebView/地图/相机，等于让 **两套渲染器争同一块屏幕**。三代方案的差别是：原生 View 的像素如何进入 Flutter 的 Layer 树，以及输入法/手势谁优先。

## 三代方案

**Virtual Display**  
原生 View 画到虚拟 Display，再当一张图贴进 Flutter。实现简单，显存贵，输入法和焦点问题多，基本淘汰。

**Hybrid Composition**  
把 Flutter 图层拆成多个原生 Surface，把平台 View 插在中间。输入法正常，但多 Surface 合成在部分 Android 设备上很贵，互相遮挡和圆角 clip 也麻烦。

**Texture Layer Hybrid Composition (TLHC)**  
平台 View 画进共享 GPU 纹理，Flutter 把它当 \`TextureLayer\` 合成。少一次「整窗拆 Surface」，帧率和内存通常最好。仍要注意：纹理更新频率、尺寸变化、旋转。

## 原理级代价

平台 View 破坏「Flutter 独占 GPU」的假设。每帧可能多一次 fence 同步。手势要在原生和 Dart 之间决定谁赢，竞技场规则到边界会失效，得靠平台手势透传。

## 工程上怎么用

能用 Flutter 控件就不要嵌原生。必须嵌时优先 TLHC；动画期间避免改平台 View 的 size。列表里滚视频，限制同时存在的 Texture 数量。

## 小结

混合视图的原理是「像素如何汇合」。选方案就是选同步点和合成次数，不是选一个 Widget 名。`,

  "flutter-engine-group-memory-sharing": `每个 \`FlutterEngine\` 都带一份 Runtime、线程、字体和 GPU 资源。在原生壳里每开一个 Flutter 页面就 new Engine，内存和启动时间都会翻倍。\`FlutterEngineGroup\` 的原理是 **共享不能重复的，隔离必须隔离的**。

## 问题从哪里来

混合 App 里「设置页、钱包、客服」各起一个 Engine：重复的 Dart isolate 堆、重复的 shader/字体缓存、重复的线程。二次打开仍像冷启动。

## 原理：Group 共享什么

Group 内第一个 Engine 完整初始化。后续 \`spawn\`：

- 共享：进程级 GPU 上下文、字体管理、部分线程池、AOT 快照映射。
- 隔离：每个 Engine 自己的 UI Isolate、自己的渲染 Surface、自己的 Channel 注册。

所以增量内存可以到百 KB 量级，启动变成「再挂一个 Isolate」而不是「再起一个 VM」。

## 不能共享的

插件单例如果假设「全局只有一个 Engine」，在 Group 里会串。\`static\` 缓存、MethodChannel 名冲突、后台 isolate 与哪个 Engine 通信，都要按 Engine 实例来。

## 工程上怎么用

原生侧一个 Group 单例。每个 Flutter 容器 spawn child engine，销毁容器时 destroy engine，不要 destroy group。Dart 侧避免真正的进程级可变全局。

## 小结

EngineGroup 把 VM 级资源变成进程单例，把页面级状态留在 Isolate。这是混合架构的内存模型，不是一个启动优化开关。`,

  "flutter-skia-vs-impeller-shader-warmup": `Skia 的 shader warmup 和 Impeller 的预编译，经常被当成同一件事。不是。一个是 **缓存已知变体**，一个是 **取消运行时变体生成**。

## Skia 路径

Skia 根据绘制状态特化着色器（混合、覆盖类型、颜色空间……）。第一次用到某变体，驱动编译。Warmup：启动时先画一遍，让编译发生在闪屏，而不是第一次动画。

局限：

- 变体空间大，录不全。
- 和 GPU/驱动绑定，换机失效。
- 仍可能在运行时遇到新变体。

## Impeller 路径

绘制被收成固定几何+固定程序。模糊不是「新 shader」，是走已经编译好的 blur 管线 + 不同 uniform。没有「新形状 → 新 shader」这条边。

因此 Impeller 不是更好的 warmup，是去掉 warmup 要解决的那类事件。

## 仍然会卡的情况

管线第一次绑定的开销、纹理上传、MSAA 解析、过大 saveLayer。那些不是 shader compile jank。

## 工程上怎么用

能开 Impeller 就开。还用 Skia 的设备，warmup 只覆盖首屏真实动画，不要幻想覆盖全 App。用 FrameTiming 看尖刺是编译还是填充。

## 小结

Warmup 治标：把编译挪个时间点。Impeller 治本：编译不再出现在运行时。`,

  "flutter-image-cache-and-gpu-texture": `图片占用的不是文件大小，是 **解码后的 RGBA 和 GPU 纹理**。2MB 的 JPEG 可以变成 50MB 显存。OOM 和滚动掉帧，经常是 ImageCache 和纹理生命周期没管住。

## 原理：两条缓存

**ImageCache（CPU/解码结果）**  
\`PaintingBinding.imageCache\` 按数量和字节设上限。超过则淘汰。缓存的是 \`ImageStream\` 的帧，不是文件。

**GPU 纹理**  
上传后活在 Raster/GPU 侧。Widget 释放不一定立刻删纹理；引擎有自己的图集/缓存策略。屏幕上同时出现的大图数量，才是显存峰值。

解码在 IO 线程。若不指定 \`cacheWidth/cacheHeight\`，按全分辨率解码，再在绘制时缩放——中间那份全分辨率矩阵已经把内存打爆。

## 计算

宽 × 高 × 4（RGBA）。4000×3000×4 = 48MB。列表 10 张就是 480MB 量级，还没算 GPU 副本。

## 工程上怎么用

- 永远按显示逻辑像素 × devicePixelRatio 设 cacheWidth。
- 列表用缩略图，点开再加载大图。
- 调 \`imageCache.maximumSizeBytes\`，但更重要的是别让错误尺寸进缓存。
- 动图表（GIF/WebP）每一帧都是一张图，更要限同时播放数。

## 小结

图片内存 = 解码尺寸 × 同时存活数。文件 KB 数几乎无关。从解码那一刻缩小，才是根治。`,

  "flutter-frame-timing-and-devtools-profiling": `优化没有测量就是玄学。\`FrameTiming\` 把一帧拆成 **UI 用时** 和 **Raster 用时**。DevTools 火焰图再告诉你时间花在哪类调用。两者要一起看。

## 原理：一帧的时间戳

\`buildDuration\`：Vsync 到 UI 线程完成 Layer 树。超预算 = Dart/布局/paint 记录太重。  
\`rasterDuration\`：Raster 线程栅格化。超预算 = 图层、模糊、大图、着色器。

两者之和不是简单的用户可见延迟，因为流水线并行。但任一持续超过帧间隔，队列会堆积，掉帧开始可见。

\`\`\`dart
WidgetsBinding.instance.addTimingsCallback((timings) {
  for (final t in timings) {
    final uiMs = t.buildDuration.inMicroseconds / 1000;
    final gpuMs = t.rasterDuration.inMicroseconds / 1000;
    if (uiMs > 16 || gpuMs > 16) {
      // 上报：哪一侧、哪个路由
    }
  }
});
\`\`\`

## 火焰图怎么读

CPU Profiler：看 \`build\`、\`performLayout\`、\`paint\` 谁占柱子。  
不要在没开「Track Widget Builds」时猜是哪个 Widget。  
GPU：看是否 saveLayer、图片解码上传与帧尖刺重合。

## 工程上怎么用

线上采样，不要每帧打日志。按路由聚合 P95。优化只针对超预算的那一侧：UI 超了减 build/layout；Raster 超了减层和像素。

## 小结

FrameTiming 给病种（UI 还是 GPU），火焰图给病灶。先分类再下药。`,

  "flutter-accessibility-semantics-tree": `看见的树是 RenderObject；读屏器用的是 **Semantics 树**。两者并行。关闭语义时几乎零成本；打开 TalkBack/VoiceOver 时，语义管道成为第二条必须同步的提交路径。

## 原理

每个 RenderObject 可贡献 \`SemanticsConfiguration\`：标签、按钮、选中、滑动动作。\`SemanticsOwner\` 把脏语义节点合成 \`SemanticsNode\` 树，经 Engine 映射成 Android AccessibilityNodeInfo / iOS UIAccessibility。

为什么独立成树：视觉上的 Clip/Transform 和「用户理解的控件」不是一一对应。一个自定义绘制的滑杆，像素是 Path，语义必须是「可调的 slider，当前 30%」。

## 合并与排除

\`ExcludeSemantics\` 整棵子树对读屏消失。\`MergeSemantics\` 把孩子们合成一个节点，避免「图标、文字、按钮」被读成三次。错误合并会让焦点顺序错乱。

## 工程上怎么用

自定义 RenderObject 必须同步语义，否则可点却不可读。测试用 \`SemanticsTester\` 或集成测试的语义句柄，不要只看截图。动画中频繁改语义会打满 Platform 线程。

## 小结

语义树是 UI 的公开协议。渲染树服务 GPU，语义树服务人与系统服务。两边都要在布局变更时更新。`,

  "flutter-state-restoration-and-engine-lifecycle": `Android 可以在后台杀掉进程。用户回来时期望滚动位置和表单还在。状态恢复的原理是：**在引擎被杀前，把一棵可序列化的恢复树交给操作系统；启动后再灌回 Element。**

## 问题从哪里来

\`State\` 在内存里。进程死了，\`State\` 就没了。导航栈如果只活在 Dart 内存，也会丢。必须有一份与 Activity 生命周期绑定的 bucket。

## 原理

\`RestorationManager\` 持有 \`RestorationBucket\` 树，key 是字符串路径。\`RestorationMixin\` 在 State 里注册属性：滚动 offset、TextField、Page 索引。引擎暂停时序列化成二进制，交给 Embedder 存进系统 \`savedInstanceState\`。

新进程：Engine 冷启动 → 读 bucket → 对应 State \`restoreState\` 在 initState 之后、第一帧之前恢复。所以第一帧可以已经是「用户离开时的样子」，而不是闪一下首页。

## 和 Engine 生命周期

\`AppLifecycleState.detached\` / Android Activity destroy 时要保证 bucket 已写。多 Engine（Group）时每个 Engine 自己的 restoration id 不能撞。

不是所有状态都能恢复：网络登录态、大对象、未完成上传。只恢复「用户以为没走」的 UI 状态。

## 工程上怎么用

滚动列表、表单、Navigator 开 restorationId。不要把整个 bloc 塞进 bucket。用可版本化的 map，避免升级后反序列化崩溃。

## 小结

恢复不是缓存，是跨进程的 UI 快照。原理是把 Dart 状态映射成系统可保管的字节，再在新 Engine 里按 key 对号入座。`,
};
