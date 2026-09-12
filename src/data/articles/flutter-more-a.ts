export const flutterMoreA: Record<string, string> = {
  "flutter-rendering-pipeline-four-phases": `把「一帧」理解成 \`setState\` 立刻重画，会在生产里把瓶颈找错。\`setState\` 不会调用 Metal，也不会走完 Layout；它只把某个 \`Element\` 丢进 \`BuildOwner\` 的脏列表。真正把 Dart 世界推进到可提交 \`Scene\` 的，是 Vsync 到来之后 \`SchedulerBinding\` 串起来的 Animate → Build → Layout → Paint。Raster 线程上的 GPU 工作，严格来说已经不算这四个阶段。

读完你应该能独立回答三个问题：这一帧的时间被哪个阶段吃掉了、为什么 Layout 必须一次遍历而不能像 CSS 那样反复回流、UI 线程已经 \`compositeFrame\` 之后屏幕上为什么还可能是上一帧。

## 1. 先画边界：四个阶段都不碰 GPU

四个阶段全部跑在 **UI Task Runner** 上，主体是 Dart。它们的产品是 Layer 树（以及树上 Picture / DisplayList 的记账），不是 framebuffer。

- Framework → Engine：\`SceneBuilder\` 建好的 \`Scene\`、帧回调、语义树。
- Engine → Framework：Vsync（\`onBeginFrame\` / \`onDrawFrame\`）、指针、生命周期。

所以 \`FrameTiming.buildDuration\` 量的是这条 Dart 管线；\`rasterDuration\` 量的是另一条线程。把 GPU 掉帧优化成「少 \`setState\`」，方向可能完全反了。

不变量：**四个阶段可以脏、可以跳过，但不能换序，也不能在 Paint 里再改 Size。** 换序会破坏 Layout 的一次遍历；Paint 改 Size 会让命中测试和合成用两套几何。

Debug 里 \`debugDoingLayout\` / \`debugDoingPaint\` 就是在守这条边界。Release 关掉断言，越界不会立刻炸，会变成「偶发错位、偶发二次 layout、偶发上一帧残影」——更难查。

## 2. 节拍器：Vsync 怎样变成 drawFrame

没有 Vsync，Framework 不会自己空转刷屏（\`scheduleWarmUpFrame\` 是启动和测试的例外，它不等下一拍）。Embedder 从 Choreographer / CADisplayLink 拿到垂直同步，投递到 UI Runner。这就是帧的节拍器。

一次对齐的帧，Scheduler 把时间切成几段相位（\`SchedulerPhase\`）：

1. \`transientCallbacks\`：Ticker 步进，这就是 Animate。
2. 微任务插在相位之间。这里如果堆积大量 \`Future\` 回调，会直接吃掉后面 Build 的预算。
3. \`persistentCallbacks\`：\`WidgetsBinding.drawFrame\`，Build / Layout / Paint / Composite。
4. \`postFrameCallbacks\`：这一帧已经交给栅格化，只能做「下一帧再生效」的事。在这里再 \`setState\` 不会 intra-frame 循环，但会立刻预约下一帧。

\`\`\`dart
void drawFrame() {
  buildOwner.buildScope(rootElement);
  pipelineOwner.flushLayout();
  pipelineOwner.flushCompositingBits();
  pipelineOwner.flushPaint();
  renderView.compositeFrame();
  pipelineOwner.flushSemantics();
  buildOwner.finalizeTree();
}
\`\`\`

这不是示意，是职责顺序。\`flushLayout\` 之前 Widget 树必须已经把这一帧的配置建完；\`flushPaint\` 之前几何必须稳定；\`compositeFrame\` 是 UI 侧的终点，不是上屏。语义树可以在同一帧稍后刷，无障碍不跟像素抢同一微秒，但会占 UI Runner。

## 3. Animate：只允许改「值」，尽量别改「树」

Animate 的主体是 \`Ticker\` / \`AnimationController\`。它们拿到 \`Duration elapsed\`，写出一个 double，再触发 \`setState\`，或直接改某个 \`RenderObject\` 的字段后 \`markNeedsPaint\`。

原则：动画值可以每帧变，树结构尽量别每帧变。每帧 insert/remove 孩子，Build 和 Layout 都会从 O(脏节点) 退化成 O(子树)。隐式动画（\`AnimatedContainer\`）看起来省事，代价是宽高、padding、decoration 可能同时脏，四个阶段全跑。

把动画限制在已有对象的 paint 属性上（opacity、transform、对齐），才能让后面的阶段走边界提前返回。这不是风格问题，是预算问题：Animate 本身几乎不耗时，它决定后面三个阶段有多脏。

\`AnimationController\` 必须挂在 \`TickerProvider\` 上，而 Ticker 只在 \`SchedulerBinding\` 处于帧循环时走。页面不可见时 \`Ticker.muted\`，否则后台仍在申请 Vsync，既耗电又和前台抢节拍。

## 4. Build：脏列表，不是整棵 Widget 树

\`setState\` 只调用 \`element.markNeedsBuild()\`。\`BuildOwner\` 把脏 Element 按 depth 排序，然后只 \`rebuild\` 这些节点。祖先先于子孙，这样子在父的新配置里重建，不会用到即将被扔掉的 slot。

\`Widget.canUpdate\` 为 true 时，Element 和它下面的 RenderObject **原地更新**。false 则 deactivate 旧的、inflate 新的。Build 的复杂度应接近脏节点数量，而不是 Widget 构造函数被调用的次数——构造 Widget 很便宜，inflate Element、挂 State、挂 RenderObject 才贵。

\`\`\`dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType
      && oldWidget.key == newWidget.key;
}
\`\`\`

\`LayoutBuilder\`、\`Overlay\`、\`GlobalKey\` 重挂载会把 Build 和 Layout 重新绑在一起：builder 在父 layout 过程中才跑，等于在 Layout 阶段插入了一次 Build。这是合法的受控例外，但会让「Build 时间」和「Layout 时间」在 Timeline 上缠在一起，排障时不要按名字机械切分。

\`const\` Widget 能跳过重建，前提是配置真的没变。父仍 rebuild 时，const 子只是 canUpdate 之后什么都不做，不是子树从树上消失。

## 5. Layout：一次遍历靠一条协议活着

父给子 \`BoxConstraints\`（min/max 宽高），子必须在盒子里选定 \`size\`，再把孩子摆到 \`parentData.offset\`。子不能说「我先随便高，你再告诉我宽」。

\`\`\`dart
child.layout(constraints, parentUsesSize: true);
size = constraints.constrain(Size(width, child.size.height));
\`\`\`

\`parentUsesSize: true\` 表示父稍后要读 \`child.size\`。若为 false，或约束是紧的（min==max），或 \`sizedByParent == true\`，这个节点可以成为 **relayout boundary**：子树内部 relayout 停在这里。

\`PipelineOwner\` 把需要 layout 的节点按 depth 排序后一次 \`performLayout\`。同一帧回头给已经 layout 过的祖先新约束，debug 断言会炸；release 里则变成不可预测的二次遍历。这就是 Flutter 相对 CSS 的那条硬边界：**禁止回流。**

Sliver 是同一协议的另一套约束（剩余绘制范围、滚动偏移），不是例外。列表快，是因为没出现的孩子根本不进这棵树，而不是因为 Layout 算法更聪明。

## 6. Paint：往当前 Layer 记账

\`paint\` 拿到 \`PaintingContext\` 和 offset。\`context.canvas.draw*\` 并不调用 GPU，它往当前 \`PictureLayer\` 的 recorder 里追加指令。需要独立合成属性时，context \`pushOpacity\` / \`pushClipRect\` / \`pushTransform\`，挂新 Layer。

所以 Paint 阶段慢，常见原因是：记录了太多层、太多 \`saveLayer\`、在 paint 里做了本该在 layout 做的测量（对同一段超长字符串反复 \`TextPainter.layout\`）。真正的 fill rate 在 Raster 线程，这一阶段看不见。

Paint 的脏标记 \`markNeedsPaint\` 向上走，直到 \`isRepaintBoundary == true\`。没有边界，一个转圈指示器可以逼整页重记 DisplayList。有边界但子树每帧都变，边界变成每帧重建的离屏纹理，Paint 未必省，Raster 一定更贵。

\`flushCompositingBits\` 夹在 Layout 和 Paint 之间：它重算「这棵子树要不要独立合成」。Opacity 从 1.0 变成 0.9，bits 翻了，后面 Paint 才会 push 新 Layer。漏算会画错；每帧都翻会多挂层。

## 7. 和合成的分界：流水线从这里切开

Paint 之后 \`RenderView.compositeFrame\` 把 Layer 树 \`addToScene\`，生成 \`ui.Scene\`，投递 Raster Runner。UI Runner **可以** 开始准备下一帧。第 N 帧在 GPU 上，第 N+1 帧在 Dart 里。

如果 Raster 还在画 N，N+1 的 Scene 会排队。表现是持续掉帧而不是单帧尖刺。\`buildDuration\` 很低、\`rasterDuration\` 很高，就是这种病。

系统合成器（SurfaceFlinger / Core Animation）还要再吃一次延迟。触控跟手不只取决于你的 Dart 是否小于 8ms。追求「输入到上屏一拍内」，要同时看 Embedder 的 Vsync 对齐和系统合成，而不是再抠 Build。

一个完整的反例能把阶段切清楚。滚动列表时在 \`NotificationListener<ScrollNotification>\` 里同步 \`TextPainter.layout\` 一段长文，再 \`setState\` 把高度写进 item：Animate 相位（滚动 Ticker）里插入了 Layout 的活，Build 被额外点脏，Layout 对可见行再量一遍文本。Timeline 上你会看到 \`transientCallbacks\` 变长、\`flushLayout\` 变长，而 GPU 条可能仍是绿的。正确拆法是：滚动只改 \`ScrollPosition\`（paint/合成），文本高度在第一次 layout 时量完缓存，滚动路径禁止 \`setState\`。

\`scheduleWarmUpFrame\` 和普通帧的差别也在这里。它跳过「等下一拍 Vsync」，用于第一帧尽快有像素。字体 fallback、首图解码、shader/PSO 绑定经常撞在这一帧，所以启动慢不能用稳态的 16.6ms 去套。稳态优化和启动优化是两条时间线。

## 8. 脏标记是三条河，不要汇成海

| 标记 | 谁消费 | 被什么挡住 |
|---|---|---|
| \`markNeedsBuild\` | \`BuildOwner.buildScope\` | 没有 build boundary，靠少 \`setState\`、拆 \`State\` |
| \`markNeedsLayout\` | \`PipelineOwner.flushLayout\` | relayout boundary |
| \`markNeedsPaint\` | \`PipelineOwner.flushPaint\` | repaint boundary |

三者独立。布局钉死、只改颜色，应只走 paint。改了一句文案导致整页 relayout，是因为文本所在节点不是 boundary，或者父 \`parentUsesSize: true\` 一路传到根。

还有一条小河：\`markNeedsCompositingBitsUpdate\`。它不直接画，但决定 Paint 时挂不挂 Layer。和三条主河搞混，会把「多了一层离屏」误诊成「build 太勤」。

生命周期上，这四段都在 UI Isolate。跨 Isolate 的 \`compute\` 回传必须在下一帧之前拷回主堆；拷贝本身记在微任务里，看起来像 Build 变慢，其实是分配和 GC。

## 9. 设计取舍（为什么是现在这样）

- **四阶段同步、同线程**：推理简单，没有「layout 到一半 build 插进来」的数据竞争。代价是任一阶段超时，整帧 UI 超时。
- **Layout 一次遍历**：O(N) 可预测。代价是写不了「子决定父、父再改子」的弹性布局，必须把那种需求编译成约束。
- **Paint 只记账**：UI 和 Raster 流水线并行。代价是两套时间线，DevTools 里看错条就会改错代码。
- **脏标记冒泡 + 边界**：局部更新。代价是边界用错会适得其反——缓存层每帧失效，或脏标冲到根。

这些取舍决定了什么优化有意义。换状态库缩短不了 Raster；给每帧都在变的子树加 \`RepaintBoundary\` 缩短不了 Paint；在 \`build\` 里缓存一个错的 \`Size\` 解决不了 Layout 协议问题。

## 10. 怎么把原理用到排障上

遇到掉帧，按阶段提问，不要一上来拆业务 Widget：

1. **是 \`buildDuration\` 还是 \`rasterDuration\`？** 方向完全相反。
2. **Build 时间是否随页面深度线性涨？** 是则脏范围太大，查 \`setState\` 位置、拆 \`State\`、const。
3. **Layout 是否在 Timeline 里反复出现同一节点？** 是则破坏了一次遍历，查 \`LayoutBuilder\`、intrinsic 宽高、在 paint 里 layout。
4. **Paint 是否伴随大量 \`saveLayer\` / 大图？** 那是合成账单，不是 \`setState\` 次数。
5. **Animate 是否每帧在改树结构？** 先把动画收到 \`Transform\` / \`Opacity\` 上，再谈别的。

能回答这五问，四个阶段对你就不再是概念图，而是一帧的时间表。时间表对上了，再决定动 Widget、动 RenderObject，还是动图层。

## 11. 小结

Animate、Build、Layout、Paint 是时间片上必须按序完成的四段 Dart 工作，产品是 \`Scene\`，不是像素。卡顿要么是某一段超了预算，要么是脏标记没有停在边界上，要么是你把 GPU 的事误记在这四段里。把问题归到阶段，后面讲 Impeller、Layer、RepaintBoundary 才有落点。下一篇会离开 UI Runner，看封闭图元和离线管线怎样把 Scene 变成可预测的 GPU 时间。
`,
  "flutter-impeller-next-gen-renderer": `把 Impeller 理解成「更快的 Skia」会在打开开关之后立刻失效。它要消灭的不是平均填充率，而是 **第一次画某种效果时，驱动现场编译着色器那几十毫秒**。Skia 的能力面是开放的：没见过的 Path + 模糊 + 高级混合，可以在运行时特化出一条新 GPU 程序。移动驱动上，这一特化就是一次掉帧，甚至一次连续掉帧。

读完你应该能独立回答三个问题：为什么同一动画「第一次卡、第二次顺」、Impeller 把编译挪到哪一个生命周期、打开 Impeller 之后 GPU 条仍然高应该去减什么而不是怀疑着色器缓存。

## 1. 先画边界：Impeller 不管 Dart 对象

Impeller 活在 **Raster Task Runner** 上。它吃的是 UI 线程交过来的 DisplayList / Layer 树，吐的是 Metal、Vulkan（或 GLES 回退）的 command buffer。它 **不** 跑 \`build()\`，**不** 持有 \`Element\`，**不** 解引用 Dart 堆上的 Widget。

\`dart:ui\` 的 \`Canvas.drawPath\` 在 UI 线程只是往 Picture 记账。记账便宜；贵的是 Raster 侧把这条 path 变成覆盖率：三角化、stencil-then-cover、再采样。所以 GPU 掉帧和 Dart 掉帧是两种病。\`FrameTiming.buildDuration\` 对前者不敏感。

不变量：**着色器程序在打包时就该存在；运行时原则上不再让驱动编译源码。** 违反这条，Impeller 就退回 Skia 的失败模式。

## 2. Skia 在移动端到底卡在哪

Skia 是通用 2D 引擎。遇到新的绘制组合，它生成 SKSL，再交给后端编成 Metal/GLSL。桌面驱动往往有磁盘缓存，一次编译终身受益。移动端的现实是：

- GPU 驱动编译器慢，且和厂商强相关。
- 缓存键包含设备、驱动版本、绘制组合。换机、升级系统、换一个没录到的效果，缓存失效。
- 动画中途第一次出现模糊、虚线、高级 blend，编译发生在 **当前帧的 Raster 线程**。这一帧的 \`rasterDuration\` 从 8ms 变成 40ms，用户只看到「卡一下」。

\`Skia\` warmup 包试图提前录一遍动画，把当时用到的 shader 存下来。它是缓存策略，不是架构。没录到的组合、没覆盖的 GPU，warmup 帮不上。

## 3. 封闭图元：把 2D 收敛成有限操作

Impeller 的第一刀是缩小问题域。圆、矩形、RRect、路径填充/描边、纹理采样、文字（字形图集）、渐变、模糊、阴影、裁剪、混合，被收成一套 **封闭的 Contents / Geometry**。

封闭的含义是：任意 Flutter 2D API，最后都要落到这套图元上。多一个开放的「用户运行时特化」，就多一个必须现场编译的变体。少一个图元，某个 \`Canvas\` API 就要用更贵的通用路径模拟（例如用离屏 + 模糊近似阴影）。

路径是最危险的开放面。Impeller 对复杂 Path 常用 stencil-then-cover：先把覆盖率打进模板，再一次性上色。它避免为每个新形状编一条专用 fragment shader，代价是模板缓冲带宽。简单矩形走更短的几何体，不走这条。

## 4. impellerc 与 PSO：编译发生在构建期

构建期 \`impellerc\` 把 Impeller 的着色器源编成目标后端的二进制：Metal 的 AIR/metallib、Vulkan 的 SPIR-V。这些产物打进 Engine 或应用包，随 AOT 快照一起分发。

运行时要的是 **管线状态对象（PSO）**：顶点格式、混合模式、深度/模板、采样数、render pass 格式。着色器已经是二进制，创建 PSO 仍然有驱动开销，但比编译源码低一个数量级，而且可以在首帧前、空闲时预热。

\`\`\`dart
// Dart 侧看不到 PSO。你能控制的是「画出哪种封闭操作」。
canvas.drawRRect(rrect, paint..color = color); // 走矩形/圆角短路径
canvas.saveLayer(bounds, Paint()..imageFilter = blur); // 强制一次离屏 pass
\`\`\`

同一视觉，第一条往往是一条实体；第二条是「先画到中间纹理，再采样」。Impeller 消灭的是编译，消灭不了 pass 的数量。

和 Skia warmup 的本质差别：warmup 是「把见过的编好存着」；Impeller 是「没见过的也不现场编」。换 GPU 只要后端二进制还在包里，语义不变。

## 5. 从 DisplayList 到 Entity 的翻译

UI 线程交出的是 DisplayList（一组绘制命令 + 变换 + clip）。Raster 线程上 Impeller 把它译成 Entity 图：每个 Entity 带变换、混合、Clip 栈和一份 Contents。

翻译是一次遍历，不是着色器编译。然后按 render pass 组织：主屏 pass、离屏 pass（\`saveLayer\`、Backdrop、高级 blend）、字形/图集更新。Command buffer 在 Metal/Vulkan 上可以并行录制，不再有 OpenGL 那种全局状态机——这也是 Impeller 坚持现代 API 的原因。

**UI 不碰 GPU 上下文；Raster 不跑 Dart。** DisplayList 跨线程移交是所有权转移，不是共享可变命令流。你在下一帧 \`setState\` 改 Canvas 内容，碰不到上一帧正在录的 buffer。

## 6. 线程、内存、显存各记各的账

几块互不混淆的资源：

- **Dart 堆**：Picture 的 Dart 句柄、\`ui.Image\` 句柄。GC 管句柄，不管像素。
- **原生堆**：DisplayList 的指令、path 的点、glyph 缓存的 CPU 侧。
- **GPU 显存**：纹理、MSAA、离屏 color/stencil、字形图集、PSO 池。

图片：压缩文件在 IO Runner 解码，像素上传常在 Raster。解码尺寸是宽 × 高 × 4，和 JPEG KB 无关。4000×3000 是 48MB 量级，Impeller 不会因为「没编译着色器」就让这张图变便宜。

字形图集涨到上限会重建。第一次画某语言、某 emoji 彩色字体，可能伴随一次图集扩容和上传。这表现为「首帧或第一次出中文时 Raster 尖刺」，不是 shader jank，工具上看是纹理上传。

## 7. Impeller 仍然贵的操作

打开 Impeller 之后掉帧，优先查这些，而不是怀疑「是不是没预编译全」：

| 操作 | 为什么贵 | 和着色器编译的关系 |
|---|---|---|
| \`saveLayer\` / 模糊 / 阴影 | 额外离屏 pass + 带宽 | 无关 |
| \`BackdropFilter\` | 读回 framebuffer，打断流水线 | 无关 |
| 全屏 \`Opacity\` 动画 | 整层离屏再混合 | 无关 |
| 复杂 Path / 虚线 | stencil 或细分 | 无关 |
| 超大图 / 未解码到位图 | 上传和采样 | 无关 |
| Platform View | 打破「一条 Raster 画完」 | 无关 |

文字测量仍在 UI 线程（LibTxt / HarfBuzz）。Impeller 只画已经 shaping 好的 glyph。\`build\` 里反复 \`TextPainter.layout\` 是 UI 病，换渲染器无效。

## 8. 平台边界：谁在用、谁还不是

iOS 上 Impeller 已成为默认，Metal 路径最完整。Android 上 Vulkan 是主路径，部分设备回退 GLES；回退不是「又变成 Skia」，但能力与驱动质量参差。桌面逐步切；Web 仍是 CanvasKit / Skwasm 那套 Skia 语义，不能拿移动端 Impeller 的结论去优 Web。

软件渲染、部分测试、旧 Embedder，仍可能走 Skia。混合 App 里旧 Engine 和新 Engine 并存时，不要假设「工程开了 Impeller 就全进程都是 Impeller」。

极端自定义着色器（\`FragmentProgram\`）有 Impeller 的运行时着色器路径，但那是显式出口，不是 Skia 式的隐式特化。用它等于你自己把「封闭图元」打开一个口，帧时间可预测性要你自己证明。

确认当前进程是不是 Impeller，不要靠感觉。iOS 上 Engine 日志和 \`debugPrint\` 抓不到 GPU 后端；Android 可用 Impeller 开关、\`--enable-impeller\` / \`--no-enable-impeller\`，以及 GPU 捕获里是否出现 \`impeller::\` 的 pass 名。混合工程里旧 \`FlutterEngine\` 和新 Engine 并存时，一页 Impeller、一页 Skia 完全可能。把 Skia 的 warmup 包留在 Impeller 默认的产品里，是在治已经不存在的病。

首帧仍然可能尖刺，只是原因换了：PSO 第一次绑定、glyph atlas 从空扩到能装 CJK、第一张大纹理上传、swapchain 第一次建立。这些是资源生命周期，不是源码编译。预热手段也换了：让首个路由的静态页先画一遍常见 RRect/文字/图片，而不是录一份 SkSL warmup。预热发生在 Raster 空闲或启动动画之前，不要放在滑动热路径上。

MSAA、模板缓冲、离屏 color attachment 才是 Impeller 帧内的稳定成本。路径走 stencil-then-cover 时，模板附件的带宽按分辨率线性涨；模糊按半径采样邻域。把 3x 模糊从全屏收到 200×200 的卡片上，比纠结「要不要再编一条 shader」有效得多。

DisplayList 上的一条 \`drawPaint\` 全屏色，翻译成 Impeller 可能是一次 CoverGeometry + SolidColorContents，几乎是最便宜的 pass。同一视觉用一张 1×1 纹理拉伸、再套 \`ColorFilter\`，会多一次采样和可能的离屏。Framework 的 \`ColorFiltered\`、\`ShaderMask\`、\`BackdropFilter\` 在 Impeller 里各自对应不同的 Contents 和 clip 覆盖策略：\`ShaderMask\` 通常要把子树先画到中间纹理再 mask；\`ColorFiltered\` 有时能折叠进混合。看 Widget 名猜 GPU 成本会错，要看它最终有没有迫使 \`saveLayer\` 语义。

文字不是「一条 drawText shader」。LibTxt 在 UI 线程 shaping，Raster 侧把 glyph 送进 atlas。atlas 满了要扩容或淘汰，扩容是一次 CPU 上传。Emoji 彩色字体、可变字体、fallback 到第二张 face，都可能让 atlas 布局失效重建。这表现为「第一次出现某个字卡一下」，和 Skia 的 shader jank 症状相同、机理完全不同。用「预编译」去治字形图集，不会好。

混合模式里，SrcOver 是快路径；高级 blend（ColorBurn、Hue 等）往往要读 dst，等于局部 saveLayer。设计师随手一个「叠加」，可能把本可以合批的矩形拆成逐个离屏。能用 SrcOver + 预乘颜色解决的，不要进高级 blend。

Impeller 的 PSO 池按「着色器 + 混合 + 采样数 + 附件格式」做键。同一条 \`drawRRect\`，在不透明和半透明、有无 MSAA 下不是同一个 PSO。第一次走进半透明圆角，仍可能付一次创建成本，只是没有 GLSL 编译那几十毫秒。把主题从全不透明改成全局 0.99 opacity，等于让整页走另一组管线，首屏尖刺会回来。这是封闭集合内部的组合爆炸，仍然有限，但不是零。

调试时 GPU 捕获应能看到 pass 名和纹理尺寸。若一帧里出现多张与屏幕一样大的中间纹理，问题就是离屏图，不是「Impeller 没开好」。若捕获里根本没有 impeller 命名空间，你在错误的后端上优化。

包体积是离线编译的显性账单：Metal 的 metallib、Vulkan 的 SPIR-V 变体要打进 Engine。这是「所有设备预付」换「运行时不编译」。裁掉用不到的后端（纯 iOS 不必带一份给 GLES 的幻想）是 Embedder/构建的事，不是业务 Dart 的事。业务侧能做的仍然是少制造离屏，而不是少 import 某个 Widget 来减 shader。

## 9. 设计取舍（为什么是现在这样）

- **封闭图元 + 离线编译**：帧时间分布可预测。代价是包体积增加，以及「Skia 能随便特化、Impeller 还没做的效果」要用更贵的通用 pass 模拟。
- **现代 API、无全局状态机**：多线程录制、更清晰的资源生命周期。代价是 GLES/旧设备要单独回退，Embedder 更厚。
- **不在 Dart 里暴露 PSO**：业务代码稳定。代价是性能问题经常要同时看 Dart 火焰图和 GPU 捕获（Xcode GPU Frame Debugger / Android GPU Inspector）。
- **保留 DisplayList 作为 UI↔Raster 契约**：换 Skia/Impeller 不必改 Framework。代价是翻译层本身也有 CPU 开销，极端简单场景未必比老路径短。

这些取舍决定了「什么优化有意义」。给 Skia 写 warmup 包，在 Impeller 默认的平台上基本是在治已经不存在的病；减 \`saveLayer\`，两种后端都有效。

## 10. 怎么把原理用到排障上

遇到「开了 Impeller 还是卡」，按层提问：

1. **尖刺只出现一次，之后再也不见？** 更像 PSO 首次绑定、字形图集扩容、纹理首次上传，而不是旧式 shader 编译。看它是否可预热、是否发生在真机而不是模拟器。
2. **每帧 Raster 都高？** 减离屏、减模糊、减 clip、减图素。Impeller 把「偶尔几十毫秒」变成了「稳定的填充率」，后者才是可优化的。
3. **只有某机型？** 先确认后端是 Vulkan 还是 GLES，再查驱动；不要在 Dart 里微优化。
4. **Web 或软件渲染？** 你不在 Impeller 世界里。
5. **UI 条和 GPU 条谁高？** 谁高优化谁。渲染器换了，这条分流没换。

能回答这五问，Impeller 就不再是开关，而是一张「编译已付清、pass 还要付」的账单。

## 11. 小结

Impeller 用封闭图元和构建期管线，换掉 Skia 在移动端「开放特化 + 运行时编译」的历史包袱。它不让第一帧 magically 变快，它让第一帧和第一百帧走同一类 GPU 成本。成本仍然是像素、离屏、带宽。下一篇回到 UI 线程，看 Layout 协议如何保证这些像素的几何只被算一次。
`,
  "flutter-renderobject-layout-protocol": `把 Flutter 布局理解成「CSS 那种算完再回头改」，会在自定义布局里立刻写出二次 \`layout\` 和整页 relayout。Flutter 的协议是严格的 **约束向下、尺寸向上**：父给出一个盒子，子必须在盒子里报 \`size\`，同一帧没有回流。\`BoxConstraints\` 和 \`performLayout\` 不是 API 细节，是这条不变量的执法点。

读完你应该能独立回答三个问题：一次 \`setState\` 为什么有时只脏一块、有时冲到根；\`parentUsesSize\` / 紧约束 / \`sizedByParent\` 各自挡住什么；intrinsic 宽高和 \`LayoutBuilder\` 为什么能把 O(N) 变成反复测量。

## 1. 先画边界：Layout 只产生几何，不产生像素

Layout 跑在 UI Runner，发生在 Build 之后、Paint 之前。它改的是 \`RenderObject.size\`、\`parentData.offset\`、变换矩阵，不调用 GPU，也不该在这里解码图片。

调用方向永远是父 → 子：

\`\`\`dart
child.layout(constraints, parentUsesSize: true);
// 此后才能读 child.size，且只能读，不能回头换一套约束再 layout 一次
\`\`\`

子在 \`performLayout\` 里：读 \`constraints\` → 给自己的孩子传 **更紧或相等** 的约束 → 设定 \`size\`（必须 \`constraints.isSatisfiedBy(size)\`）→ 用 \`parentData.offset\` 摆子节点。

不变量：**子不得放宽超出自己收到的盒子；父不得在子已经 layout 之后再改约束。** 破坏第一条，子会画出盒子外，命中测试和 clip 各执一词；破坏第二条，一次遍历作废。

## 2. 一次对话：四个字段，缺一不可

一次合法的父子对话只有这些输出：

| 字段 | 谁写 | 含义 |
|---|---|---|
| \`constraints\` | 父在 \`layout()\` 时传入 | 本节点的合法尺寸区间 |
| \`size\` | 子在 \`performLayout\`/\`performResize\` | 选定的宽高，必须落在区间内 |
| \`parentData.offset\` | 父在孩子 layout 之后 | 子在父坐标系里的原点 |
| \`parentUsesSize\` | 父在调用时声明 | 父稍后是否依赖 \`child.size\` |

\`parentUsesSize: true\` 不是性能开关，是正确性声明。父要拿子的高度做自己的高度，就必须声明；框架据此决定子能不能当 relayout boundary。谎报 false，父读到的 size 可能是上一轮的，布局会静默错。

\`applyPaintTransform\` / \`hitTest\` 依赖同一套 offset。Layout 写错 offset，Paint 看起来「偏了」，其实是几何协议没遵守，不该去调 Canvas。

## 3. BoxConstraints 的代数：只能收紧，不能放松

\`BoxConstraints\` 是区间，不是一个点。常用操作都是在收紧：

- \`tighten(width:, height:)\`：把区间压成一点（紧约束）。
- \`deflate(EdgeInsets)\`：减去 padding 后仍须合法，不够减时落到零。
- \`loosen()\`：把 min 降到 0，max 保持。这是「放松下限」，仍然不能超过自己从父那里拿到的 max。
- \`constrain(Size)\`：把任意愿望尺寸夹进区间。

子把 \`constraints.biggest\` 直接当 size，等于「能有多大占多大」，\`RenderColoredBox\`、全屏 \`CustomPaint\` 常这样。子把 \`constraints.smallest\` 当 size，等于「能有多小缩多小」。内容驱动的节点（文本、图片）在区间里按内容挑一点，再用 \`constrain\` 夹住。

跨过 max 再靠 clip 遮，是协议破坏：命中测试仍按 \`size\`，用户点到「看不见但能点」或「看得见点不中」。

## 4. Relayout boundary：脏标记的堤坝

\`markNeedsLayout\` 默认向上走。若不加阻拦，叶子改一句文案，根 \`RenderView\` 也会进 \`PipelineOwner\` 的待 layout 队列，整棵树按 depth 再走一遍。

节点成为 relayout boundary 的条件（满足其一即可）：

1. 父声明 \`parentUsesSize == false\`（父几何不依赖子 size）。
2. 约束是紧的（\`minWidth==maxWidth && minHeight==maxHeight\`），子再怎么变也撑不破钉子。
3. \`sizedByParent == true\`，尺寸只由约束决定，与孩子无关。

边界的意义：子树内部 relayout **停在这里**，不再向上污染。列表行、\`Stack\` 里按 \`StackFit.expand\` 铺开的孩子、忽略子尺寸的装饰盒，能快，是因为它们经常是边界，不是因为它们的 \`performLayout\` 写得更短。

\`\`\`dart
@override
void performLayout() {
  size = constraints.biggest; // 自身是 boundary 的常见写法
  child?.layout(BoxConstraints.tight(size), parentUsesSize: false);
}
\`\`\`

这里孩子拿到紧约束，孩子也是 boundary。孩子内部再闹，传到这里结束。

## 5. sizedByParent 与 performResize：尺寸和孩子解耦

\`sizedByParent == true\` 时，框架先调 \`performResize\` 用约束定 \`size\`，再调 \`performLayout\` 只摆孩子。\`RenderProxyBox\` 的许多装饰节点、\`RenderColoredBox\` 走这条路。

这把「我多大」和「孩子多大」切开。孩子变了只需孩子 layout；自己的 size 钉在约束上，祖先不必知道。这是第三条 boundary 条件的来源。

反例是 \`RenderParagraph\`：size 依赖文本、字体、max 宽。它几乎必然 \`parentUsesSize: true\` 向上传。所以改文案会 relayout 文本，若父是按内容撑开的 \`Column\`，会继续向上，直到遇到紧约束（例如屏幕宽）或某个不读子 size 的祖先。

## 6. PipelineOwner：按 depth 一次冲洗

需要 layout 的节点被丢进 \`_nodesNeedingLayout\`，\`flushLayout\` 按 depth 升序处理。先父后子：父的 \`performLayout\` 会调用子的 \`layout\`；若子已经在队列里，这次调用会把它清掉，避免做两遍。

同一帧对已 layout 且约束未变的节点再 \`layout\`，走的是 fast path：直接返回。约束变了且该节点不是你可以合法二次 layout 的特例，debug 会断言「Laid out twice」。普通 \`RenderBox\` 不要学 sliver 里那套受控的二次测量。

生命周期：\`attach\` 进树才有 \`owner\`；\`detach\` 后不能 \`markNeedsLayout\`。在已经 dispose 的 \`State\` 里异步回调里碰 RenderObject，是在违反生命周期，不是布局算法 bug。

## 7. 两条贵路径：intrinsic 与 LayoutBuilder

**Intrinsic 宽高**（\`getMaxIntrinsicWidth\` 等）问的是「在另一根轴还不知道时，这根轴想要多少」。这是对协议的一次侧通道查询。正确实现必须 **纯函数**：只读约束和子 intrinsic，不写 \`size\`，不改 \`parentData\`。父若在 \`performLayout\` 里对每个孩子问 intrinsic 再 layout，复杂度从 O(N) 变成 O(N × 查询次数)。\`IntrinsicHeight\` Widget 之所以贵，就是因为它逼整条 cross-axis 先测量一遍。

**dry layout**（\`computeDryLayout\`）是「只问 size、不落 offset」的正规侧通道，供 \`ParentDataWidget\`、溢出报告、某些 overlay 使用。它同样必须无副作用。你自定义 \`performLayout\` 却不实现匹配的 dry layout，debug 会告警，release 里有的父会拿到错误预测尺寸。

**\`LayoutBuilder\`** 把 builder 推迟到父 layout 时。这是 Build 插入 Layout 的受控例外：约束直到现在才知道。它合法，但会让 Timeline 上 Build 和 Layout 缠在一起，并且 builder 每次父 layout 都可能重建子 Element。能用静态约束表达的，不要拖到 LayoutBuilder。

## 8. Sliver 不是另一套世界观

视窗列表走 \`RenderSliver\`，约束是 \`SliverConstraints\`：滚动轴上的 remaining paint extent、cache extent、cross-axis 的紧宽。返回的是 \`SliverGeometry\`（paintExtent、layoutExtent、scrollExtent），不是一个 \`Size\`。

协议精神没变：向下给剩余空间，向上报「我用了多少、还能滚多少」。没进 cache extent 的孩子不 inflate，这是列表能装一万行的原因——树的基数被视窗裁过，而不是 layout 函数更神。

在 sliver 孩子里用普通 \`BoxConstraints.expand()\` 当无限高，文本会试图在无限高里排一行超长或无限高，这是协议用错坐标系，不是文本 bug。

## 9. 常见协议破坏

- 在 \`performLayout\` 里根据子 size 再给子一套不同约束并第二次 \`layout\`。部分 sliver / 表格有受控二次测量；普通 \`RenderBox\` 做了，debug 炸、release 抖。
- 在 \`paint\` 或手势回调里改 \`size\`。命中测试用新几何，合成用旧 Layer，画面和点击分离。
- 忽略 \`constraints.constrain\`，画出盒子外再靠 clip 遮。
- 异步图像解码完成后只 \`markNeedsPaint\` 却按解码尺寸改 layout：应 \`markNeedsLayout\`，否则父还按 0×0 排。
- 对已 detach 的 child 调 \`layout\`。

自定义布局先写一张纸面表：每个孩子拿到什么 min/max，自己最终 size 是什么，谁是 boundary。再用 \`debugDumpRenderTree()\` 对实际约束。纸面表和 dump 对不上，代码先别写动画。

读 dump 时盯三列：\`constraints\`、\`size\`、\`relayoutBoundary\`。constraints 是 \`BoxConstraints(w=0.0-400.0, h=0.0-Infinity)\` 而 size 是有限高，说明这个节点在无限高里按内容落地——它几乎一定 \`parentUsesSize: true\`，不是 boundary。若父是 \`Column\` 且没有把垂直约束收紧，脏会继续向上。\`Flex\` 的协议是：非 \`Expanded\` 的孩子先在剩余空间里 layout（loose），再把剩余分给 flex 孩子（tight）。这仍然是一次遍历里的两次孩子循环，不是回流；孩子自己若再问 intrinsic，那才打开缺口。

baseline 是第三条次要协议：父问子「你的文字基线在哪」，用于 \`Wrap\` / 输入框对齐。实现必须在 layout 之后能回答，且不改 size。漏实现时父会退回底边，看起来像「文字偏了」，其实是协议缺了字段，不是 paint 平移错了。

\`ParentDataWidget\`（\`Positioned\`、\`Flexible\`、\`Expanded\`）不创造 RenderObject，只改孩子的 \`parentData\`。它在 Element 更新时把 flex、top/left 写进已有节点，然后 \`markNeedsLayout\`。你自定义多孩子布局却忘了配套 \`ParentData\`，孩子的 \`Flexible\` 会落到错误的类型上，运行时抛的是 parentData 类型断言，不是 layout 算错。协议的一部分是：**父决定 parentData 的类型，孩子只读自己那份。**

无限约束要当成错误输入来处理，不要当成「随便长」。\`ListView\` 在主轴给孩子无限 max，孩子若再放一个纵向 \`Column\` 且没有 \`shrinkWrap\`/内层滚动，Column 会在无限高里按 children 求和，可能成功但失去虚拟化，也可能断言失败。自定义 \`performLayout\` 里对 \`constraints.maxHeight.isInfinite\` 必须有分支：要么改成内容高度，要么强迫孩子紧约束到一个有限视窗。不处理无限，就是把父的滚动协议吞掉。

## 10. 设计取舍（为什么是现在这样）

- **单向约束**：O(N)、可缓存 boundary。代价是「子决定父宽、父再决定子高」必须拆成两帧或改成更紧的约束表达，写过 CSS 的人会觉得死板。
- **parentUsesSize 显式声明**：让框架能自动立 boundary。代价是谎报会静默错，而不是编译失败。
- **intrinsic 作为逃逸口**：真需要「先量内容」时有路。代价是这条路默认贵，框架无法帮你立 boundary。
- **Sliver 另起约束类型**：滚动轴语义清晰。代价是两套 \`performLayout\` 脑模型，混用时出现无限约束。

这些取舍决定了什么优化有意义。给每个叶子加 \`RepaintBoundary\` 挡不住 layout 洪水；把 \`Column\` 换成 \`CustomMultiChildLayout\` 而不立 boundary，同样会整页 relayout。

## 11. 怎么把原理用到排障上

一次「改了右下角，整页卡」，按协议提问：

1. **这一帧是 layout 多还是 paint 多？** Timeline 里 \`PipelineOwner.flushLayout\` 和 \`flushPaint\` 分开。
2. **脏节点的 \`_relayoutBoundary\` 停在哪？** dump render tree，看约束是否 tight、父是否 uses size。
3. **有没有 intrinsic / LayoutBuilder / 在 paint 里 layout？** 这三项把一次遍历打开缺口。
4. **异步回包后 mark 的是 layout 还是 paint？** 尺寸变了却只 mark paint，几何和像素会分家。
5. **是否在错误的生命周期调 layout？** dispose 之后、detach 之后，都不是布局问题。

能回答这五问，你才能决定是拆 \`State\`、收紧约束，还是写一个真的 boundary。

## 12. 小结

布局协议是单向数据流：约束向下、尺寸向上、一次遍历、脏标记停在 boundary。谁破坏单向，谁就失去 O(N) 和可预测性。几何稳定之后，下一篇才谈 Layer 树——那些像素哪些可以合在一张纹理上画完。
`,
  "flutter-layer-tree-and-compositing": `把 Paint 理解成「已经把像素画上屏幕」，会把 GPU 账单记到错误的阶段。\`paint\` 记下的不是最终像素，是 **Layer 树**：哪些绘制指令进同一张 Picture，哪些必须独立成层、离屏、再混合。合成（Compositing）决定 pass 的数量。很多「GPU 忙」其实是 \`saveLayer\` / clip / opacity / blur 把一帧拆成了多次离屏绘制。

读完你应该能独立回答三个问题：为什么静态图标堆叠不一定慢、全屏模糊一定慢；Layer 和 RenderObject 为什么不是一一对应；多挂一层换来的是动画局部性还是显存与带宽。

## 1. 先画边界：Layer 是 UI 交给 Raster 的计划

Layer 树在 UI 线程上由 \`PaintingContext\` 搭好，经 \`SceneBuilder\` 变成 \`ui.Scene\`，**移交所有权**给 Raster Runner。Raster 遍历 Layer，调 Impeller/Skia 出图。此后 UI 可以开始第 N+1 帧，不得再改第 N 帧那棵已交出的树。

不变量：

- **不是每个 RenderObject 都有 Layer。** 只有需要独立合成属性的节点才 \`push\`；其余绘制进当前 \`PictureLayer\` 的 display list。
- **Picture 一经结束就不可变。** 再画只能换一张新 Picture，或只更新祖先 Layer 的属性（offset、opacity、transform）。
- **Raster 不解引用 Dart Widget。** 跨线程的是 C++ 侧 \`engineLayer\` 和像素资源。

这条边界一旦画清，「多一个 Widget」和「多一次离屏」就不再被当成同一件事。

## 2. PaintingContext：当前层是一支画笔

\`PaintingContext\` 持有当前 \`ContainerLayer\` 和一只 \`Canvas\`（底层是 recorder）。普通 \`drawRect\` / \`drawImage\` 都落进当前 Picture。需要独立合成时：

\`\`\`dart
void paint(PaintingContext context, Offset offset) {
  context.pushOpacity(offset, alpha, (PaintingContext ctx, Offset o) {
    ctx.paintChild(child, o);
  });
}
\`\`\`

\`pushOpacity\` / \`pushClipRect\` / \`pushTransform\` / \`pushClipPath\` 会：

1. 结束当前 Picture（如果有）。
2. 挂一个新的 \`ContainerLayer\` 子节点。
3. 在新 context 里继续 paint。
4. 弹出，父层可以再开一张新 Picture 画后续内容。

所以一次「中间插入 clip」会把本可以合在一起的绘制拆成三截：clip 前的 Picture、clip 层、clip 后的 Picture。拆得越多，Raster 侧切换越多，retained rendering 的粒度也越碎。

## 3. Layer 类型决定 GPU 在做什么

常见层不是装饰语法，是不同的 GPU 工作：

| Layer | 典型来源 | GPU 含义 |
|---|---|---|
| \`PictureLayer\` | 普通 paint | 回放 DisplayList |
| \`OffsetLayer\` | \`RepaintBoundary\`、对齐 | 平移；常作为缓存根 |
| \`TransformLayer\` | \`Transform\` | 矩阵；3D 时可能要独立合成 |
| \`ClipRectLayer\` / \`ClipRRectLayer\` | \`ClipRect\` 等 | scissor 或离屏 |
| \`ClipPathLayer\` | \`ClipPath\` | 几乎必然更贵，常走 stencil/离屏 |
| \`OpacityLayer\` | \`Opacity\` | 整层 alpha，通常离屏再混合 |
| \`ImageFilterLayer\` | 模糊、滤镜 | 离屏 + 采样 |
| \`BackdropFilterLayer\` | 毛玻璃 | 读回已画内容，打断流水线 |
| \`TextureLayer\` | 相机、视频 | 外部纹理，不进 Picture |
| \`PlatformViewLayer\` | WebView、地图 | 在 Flutter 的独占合成上开洞 |

\`BackdropFilter\` 是架构上最贵的常用层：它要求「下面已经画完」，Raster 不能随便把后续绘制提前，也不能只更新这一层而不管背景。毛玻璃动画等于每帧读回主缓冲。

## 4. 从 Layer 树到 Scene：retained 的真正含义

整棵树最后 \`addToScene\`：

\`\`\`dart
void addToScene(SceneBuilder builder) {
  engineLayer = builder.pushOffset(offset, oldLayer: engineLayer as OffsetEngineLayer?);
  // 子层递归
  builder.pop();
}
\`\`\`

\`oldLayer: engineLayer\` 是 retained rendering 的钩子：若这一层的属性没变、子 Picture 没变，Engine 可以复用上一帧已经栅格化或已经建好的 GPU 资源，而不是整树重录。\`markNeedsAddToScene\` 沿树向上走，作用类似 \`markNeedsPaint\`，但对象是 Layer，不是 RenderObject。

因此：动画如果只改 \`OpacityLayer\` 的 alpha，理论上只需更新一个属性，子 Picture 保持不动。动画如果改的是 Picture 内部的 path（例如每帧 \`drawPath\` 新形状），retained 帮不上，必须重录。

Picture 的 recorder 有一个容易忽略的细节：一旦 \`endRecording\`，指令序列冻结。同一 \`Canvas\` 引用在下一帧已经是另一张 recorder。你把 \`Paint\` 对象缓存下来是好的；把「上一帧的 Canvas」缓存下来是野指针式的错误。\`PaintingContext.canvas\` 只在当前 \`paint\` 调用内有效。

clip 的选择会改变层怎么切。\`Clip.hardEdge\` 的矩形常常能变成 scissor，不离屏；\`Clip.antiAliasWithSaveLayer\` 明确要求离屏，圆角阴影、子项画出边界时才会「干净」，账单是一整张与 clip bounds 一样大的中间纹理。能用 \`ClipRect\` 就不要 \`ClipPath\`；能用 \`borderRadius\` + 不 clip 的装饰，就不要给整列表加 \`ClipRRect\`。

\`addToScene\` 还有一条静默路径：若 Layer 被标记为「本帧不需要添加到 Scene」（例如完全在屏幕外且引擎支持 culling），Raster 可以跳过。依赖「看不见就不画」来省 GPU 时，要确认你的层有正确的 \`bounds\`，否则 culling 失效，全屏模糊在折叠的 bottom sheet 里仍然每帧跑。

\`Transform\` 在 2D 平移/缩放且对齐像素时，常常只是 \`OffsetLayer\` / \`TransformLayer\` 改矩阵，子 Picture 不动。一旦带透视或 3D，合成器要按深度排序，层不能再随便和兄弟合进同一 Picture。\`Transform.rotate\` 每帧转一个大卡片，若卡片内部是静态的，应让内部成为 boundary，只让 TransformLayer 的矩阵变。内部每帧重录，Transform 层就只是多付一次矩阵乘。

\`PhysicalModel\` / \`Material\` 的 elevation 阴影在实现上经常是多一层 blur 或预烘焙阴影图。elevation 动画等于阴影层每帧变参数，可能触发离屏。能用静态 \`BoxShadow\` 且不动画的，不要用 elevation 动画整张卡片。这是合成账单，不是 Material 主题问题。

Scene 提交之后，UI 侧的 Layer 树还在，供下一帧做 \`oldLayer\` 复用。\`debugDumpLayerTree()\` 看到的就是这棵还活着的 Dart 树。它和 GPU 上此刻的 command buffer 不是同一快照：你 dump 的时候 Raster 可能已经在画它的上一版。排障时不要拿这一刻的 dump 去对上一帧的 GPU 捕获，时间错开一拍就会误判「层没更新」。

\`PerformanceOverlayLayer\`、\`AnnotatedRegionLayer\` 这类辅助层几乎不占填充率，但会打断 Picture 的合并：overlay 插在中间，前后必须拆成两张 Picture。Debug 开关打开时帧变慢，有时不是检查逻辑本身，是层被拆碎、retained 粒度变差。测稳态性能时关掉 overlay，再用 Timeline 的数字对比。

## 5. 合成与 RepaintBoundary 不是同一个开关

\`RepaintBoundary\` 会创建一个 \`OffsetLayer\`，并把子树画进可缓存的 buffer。它隔离的是 **重绘**（谁要重记 Picture），附带一张可选位图缓存。

合成（\`needsCompositing\`）隔离的是 **混合方式**（谁必须离屏、谁必须按序）。一个节点可以需要合成但不需要位图缓存（临时 Opacity），也可以是 repaint boundary 但子树每帧都在重画（缓存命中率为零）。

\`flushCompositingBits\` 在 Layout 之后、Paint 之前重算 \`needsCompositing\`。子树从「不透明矩形」变成「半透明」，bits 翻了，Paint 才会真正 \`pushOpacity\`。否则框架可以继续把绘制合进父 Picture，少一次离屏。

## 6. saveLayer：显式离屏，账单最清楚

\`Canvas.saveLayer\` 是程序员直接下的离屏命令：先把后续绘制打到一张临时纹理，再按 \`Paint\`（blend、filter、alpha）压回。它不一定对应一个长期存在的 Layer 对象，但 GPU 成本同类。

典型来源：

- \`Paint.maskFilter\` / \`imageFilter\` 画进当前 Picture
- 复杂 blend
- 部分 clip + opacity 组合，框架自己降级成 saveLayer

临时纹理尺寸跟 bounds 走。bounds 写 \`null\` 或写得太大，就是全屏离屏。动画中每帧 saveLayer，等于每帧分配/复用一张与脏区一样大的中间缓冲，带宽按像素线性涨。

## 7. 线程与内存：层是哪块堆上的对象

- **Dart 堆**：\`Layer\` 实例、\`Picture\` 句柄。树在 UI Isolate。
- **原生堆**：DisplayList、Engine 的 \`Layer\` 镜像、\`engineLayer\`。
- **GPU 显存**：每张缓存纹理、MSAA、离屏 FBO。\`RepaintBoundary\` 的缓存、\`saveLayer\` 的中间纹理都在这儿。

跨线程移交必须冻结 Picture。UI 在下一帧重录 Picture 时，Raster 仍可能在读上一张——所以 Picture 不可变，否则要加锁，帧预算扛不住。

泄漏排查要问在哪块堆：DevTools 能看见 Dart 侧 Layer 是否还被 \`LayerHandle\` 握着；显存要看纹理数量和尺寸。只盯 Widget 数量，看不见一张 1080p 离屏。

\`LayerHandle\` 存在的原因：RenderObject detach 后 Layer 可能仍被 Engine 用到这一帧结束。没有句柄，Dart 过早 GC，Raster 解引用野指针。自定义 RenderObject 自己持 Layer，必须用 \`LayerHandle\`，不要裸字段。

## 8. Platform View：合成器上最贵的例外

当必须嵌 WebView、地图、相机预览，Engine 不再独占所有像素。Platform View 通过虚拟 Display、overlay 或 Hybrid Composition 嵌进来。Layer 树上会出现「洞」或一张外部纹理。

这破坏了「一条 Raster 线程画完所有像素」的假设：多一次系统合成、多一次同步点、Android 上还有厂商 Surface 的差异。表现常是「只有某机型掉帧」「滚动时 WebView 周围闪」。优化手段是少嵌、改用纹理（自己画）、或把平台视图从动画热路径拿开，而不是减 Dart \`build\`。

## 9. 设计取舍（为什么是现在这样）

- **默认合进同一 Picture**：静态页面填充率低。代价是任意脏点可能重录一大段 display list。
- **需要时才 push Layer**：动画可以只更新一层属性。代价是每层显存和一次合成。
- **Picture 不可变 + 跨线程移交**：UI/Raster 流水线无锁。代价是改一个点就要换一张 Picture，或把该点提前拆成独立层。
- **允许 saveLayer / Backdrop 这种逃逸口**：设计师要的模糊做得到。代价是逃逸口没有自动 boundary，一用就是带宽。

这些取舍决定了什么优化有意义。把一个静态图标拆成二十个 Widget，只要最后还在同一 Picture 里，GPU 几乎无感；给整页加一个 \`Opacity\`，再少的 Widget 也是全屏离屏。

## 10. 怎么把原理用到排障上

GPU 条高时，按层提问，不要先换状态库：

1. **是重录 Picture 还是离屏 pass 多？** Performance overlay 的棋盘格（raster cache / layer）在闪，说明缓存层每帧失效。
2. **有没有全屏 Opacity / Backdrop / 模糊？** 先拿掉或缩到最小矩形。
3. **clip 是 Rect 还是 Path？** Path clip 往往多一次离屏或 stencil。
4. **Platform View 是否在滚动/动画热路径上？** 这是例外路径，Dart 火焰图看不见。
5. **纹理尺寸是否等于屏幕而不是控件？** \`saveLayer\` bounds、图片解码尺寸、boundary 缓存，三笔显存。

能回答这五问，Layer 树就是一张「哪些像素可以一起画」的计划，而不是 DevTools 里一堆看不懂的层名。

## 11. 小结

Layer 树是合成计划：Picture 记账、独立层负责变换/裁剪/透明/滤镜，Scene 移交给 Raster。合成次数和离屏尺寸，不是 Widget 数量，才是 GPU 侧的账单。下一篇专门把 \`RepaintBoundary\` 从这棵树上拆出来——它是重绘洪水的堤坝，也是一张可选的、容易用错的位图缓存。
`,
  "flutter-repaintboundary-isolation-mechanism": `把 \`RepaintBoundary\` 理解成「加速魔法」，会在列表和动画里把显存打爆。\`markNeedsPaint\` 会沿父链向上走，直到遇到 \`isRepaintBoundary == true\`。Boundary 的本质是 **重绘洪水的堤坝**，附带一张可选的位图缓存。用对了，吵闹的子树出不去、安静的子树不重画；用错了，每帧多一张离屏纹理，带宽按像素线性涨。

读完你应该能独立回答三个问题：一个 loading 转圈为什么能逼整页重画、为什么「给每一项都加 Boundary」会在滚动时更卡、relayout boundary 和 repaint boundary 挡住的为什么不是同一条河。

## 1. 先画边界：它隔离 paint，不隔离 layout，更不隔离 build

\`RepaintBoundary\` 对应的 \`RenderRepaintBoundary\` 把 \`isRepaintBoundary\` 设为 true，并持有一个 \`OffsetLayer\`。它做两件事：

- **挡脏标记**：子树 \`markNeedsPaint\` 走到这里入队，不再向上。
- **可选缓存**：子树画进这块 Layer 的 buffer；祖先重绘时若子树没脏，直接合成这张纹理。

它 **不** 挡 \`markNeedsBuild\`，也 **不** 挡 \`markNeedsLayout\`。子树每帧 \`setState\`，Build 照跑；子树 size 在变，Layout 照跑，缓存因尺寸变化整张作废。把 Boundary 当「性能饰品」往根上套，三条河里只可能影响一条。

不变量：**缓存有价值，当且仅当「纹理能活过下一帧」且「重绘它比重绘外面更便宜」。** 两边都吵，或 size 每帧变，命中率为零，还多一次离屏。

## 2. 脏标记怎样停下来

\`RenderObject.markNeedsPaint\` 的控制流是：

\`\`\`dart
void markNeedsPaint() {
  if (_needsPaint) return;
  _needsPaint = true;
  if (isRepaintBoundary) {
    owner?.requestVisualUpdate();
    owner?._nodesNeedingPaint.add(this);
    return;
  }
  parent?.markNeedsPaint();
}
\`\`\`

没有边界，标记走到 \`RenderView\`（根永远是 boundary）。\`flushPaint\` 从这些根开始 \`paint\`，子树里没脏且自身是 boundary 的节点，走「合成旧 Layer」而不是重录 Picture。

\`RenderView\`、\`RenderRepaintBoundary\`、以及部分需要独立合成的对象会是 boundary。\`Opacity\` 需要合成，但不自动等于「有位图缓存的 repaint boundary」。需要合成只说明 Paint 时要 \`pushLayer\`；缓存是另一笔显存投资。

## 3. OffsetLayer 与位图缓存的生命周期

子树第一次 paint，产出 Picture，Raster 可能把它栅格化进一张纹理（实现随 Engine 版本和是否满足缓存条件而变）。之后：

- 子树没脏、祖先在重绘：祖先的 \`addToScene\` 挂上这个 \`OffsetLayer\`，像素复用。
- 子树脏：只从该 boundary 重 paint，更新 Layer，祖先仍不必重录自己的 Picture。
- size 变、DPR 变、设备旋转：纹理尺寸不对，必须重建。动画里 height 从 0 长到 400，每一帧一张新纹理，缓存是负优化。

\`toImage\` / \`toImageSync\` 走同一块 Layer：把子树栅格化成 \`ui.Image\`。这是显式读回，发生在 Raster，可能阻塞或排队。用它做截图可以；每帧 \`toImage\` 当特效，等于每帧强制离屏 + 读回，比普通 Boundary 更贵。

## 4. 和 relayout boundary 的正交关系

| | Relayout boundary | Repaint boundary |
|---|---|---|
| 挡住 | \`markNeedsLayout\` | \`markNeedsPaint\` |
| 典型条件 | 紧约束、\`parentUsesSize==false\`、\`sizedByParent\` | \`isRepaintBoundary==true\` |
| 缓存 | 几何，几乎无显存 | 像素，占显存 |
| 失败模式 | 整页 relayout | 整页重录 Picture，或显存爆炸 |

两者独立。一个节点可以挡住重绘但挡不住布局（\`RepaintBoundary\` 包着一段会变高的文本）；也可以挡住布局但挡不住重绘（紧约束的全屏背景，里面粒子仍向上标 paint，直到遇到 paint 边界）。

排障时先问「这一帧 flush 的是哪张队列」。用错边界，是在给另一条河修堤。

## 5. 什么时候该加，什么时候是负优化

适合加的结构，核心是 **一侧稳、一侧吵**：

- 外面吵、里面稳：滚动的列表上方有一张复杂插画、地图上的静态控件、不随滚动变的图表。外面每帧 paint，里面那张纹理直接合成。
- 里面吵、外面稳：一个局部 loading、一个小仪表盘指针。转圈不出边界，整页 Picture 不用重录。

不要加：

- 本身每帧都在变、且几乎铺满父的区域（全屏粒子、视频、进度条拉满宽）。缓存每帧失效，还多一次 blit。
- 普通文字列表的每一项。项很轻，滚动时项进出本来就要 paint；每项一张纹理，滚动变成纹理搬运。
- 尺寸动画中的节点。缓存键包含 size。

列表项只在「项很重且滚动时项内容不变」（大图 + 复杂装饰、内容静态）时才值得考虑。这是显存换 CPU 的交易，要用棋盘格看是否在闪。

## 6. 棋盘格、overlay 和「闪」的含义

Performance overlay 的 raster cache checkerboard：缓存层被重绘时闪格。稳定的格子表示「这块是缓存且没在每帧重建」；狂闪表示 Boundary 在工作但命中率为零——它每个 Vsync 都在付离屏成本。

另一格是层边界可视化。层多不一定坏（opacity 动画需要层）；层多且每帧都脏，才是账单。

不要凭感觉加完 Boundary 就宣称优化。没有「闪/不闪」和 \`rasterDuration\` 前后对比，你不知道自己买的是隔离还是显存。

## 7. 线程、内存、生命周期

脏标记和 \`paint\` 在 UI 线程。纹理分配、栅格化、合成在 Raster。\`toImage\` 的像素读回可能在 Raster 完成后把 \`ui.Image\` 句柄投递回 UI。UI 不得在 paint 里同步等 GPU；那会把流水线拧成串行，双线程变成单线程。

内存三块：

- Dart：\`RenderRepaintBoundary\`、\`OffsetLayer\`、\`LayerHandle\`。
- 原生：Engine 层对象。
- 显存：缓存纹理。这是 Boundary 真正可能「泄漏」的地方——不是 Dart GC 不管，是你一直让一个全屏 Boundary 活着，纹理就一直钉在 GPU 上。路由压栈后仍在树里的巨型离屏，和「泄漏」对 RSS 的贡献一样。

生命周期：RenderObject \`detach\` 时必须丢掉对 Layer 的拥有（经 \`LayerHandle\`）。Boundary 出树，纹理应在帧结束后可释放。自定义 \`isRepaintBoundary == true\` 的对象，若自己 new Layer 却不走 Handle，是在和 Raster 抢生命周期。

## 8. 自己把 RenderObject 标成 boundary

不一定要用 Widget。任何 \`RenderObject\` 都可以 \`isRepaintBoundary => true\`。自定义图表若内部动画只改指针，把图表节点标成 boundary，比在外面再包一层 Widget 更少一次 Element。

\`\`\`dart
class RenderGauge extends RenderBox {
  @override
  bool get isRepaintBoundary => true;

  @override
  void paint(PaintingContext context, Offset offset) {
    // 只重画仪表。祖先滚动时走 OffsetLayer 合成。
  }
}
\`\`\`

你同时要保证：size 尽量稳；祖先不要每帧改你的 offset 以外的合成属性（例如给 boundary 再套一个每帧变的 \`Opacity\`，外层仍会离屏）。Boundary 不是盔甲，它只在自己这层挡 paint。

嵌套 Boundary 的账单要算像素，不要算个数。两层各 100×100，显存大约是两张小纹理；一层包住全屏、里面再包 20 个列表项各一张全宽纹理，滚动时是 20 次更新。估算用 \`宽 × 高 × devicePixelRatio² × 4\` 字节。1080×240 的项在 3x 设备上约 1080×3 × 240×3 × 4 ≈ 9MB；20 项就是 180MB 量级的最坏值（引擎会有缓存上限和淘汰，但峰值带宽仍按脏项算）。

\`RenderOpacity\`、\`RenderAnimatedOpacity\` 在 opacity 介于 0 和 1 之间时 \`needsCompositing == true\`，会 push \`OpacityLayer\`。这不是 \`isRepaintBoundary\`。外层半透明动画会把内层 Boundary 的缓存纹理再离屏混合一次：内层稳，外层吵，缓存仍然有用，但外层那张全尺寸离屏每帧都在。正确的结构是把透明度动画收进尽可能小的那一层，而不是给整页 \`Opacity\` 再在里面到处贴 Boundary。

\`isRepaintBoundary\` 从 false 变成 true（或反过来）会触发 compositing bits 更新，Layer 类型可能从「画进父 Picture」变成「独立 OffsetLayer」。这发生在热切换时（例如按条件包一层 \`RepaintBoundary\`），中间会有一帧丢掉旧 Picture。不要在动画中途根据帧号加加减减 Boundary。

和滚动的关系要单独算。\`ListView\` 本身会把屏幕外 sliver 从树上摘掉（或保持 cache extent 内）。项上的 Boundary 在项滑出 cache 后随 RenderObject detach，纹理可释放。若你用 \`cacheExtent\` 开得很大又给每项 Boundary，等于提前栅格化很多张纹理换滚动顺滑，RSS 和显存一起涨。这是明确的交易：只在「项很重、滑回屏幕时重绘很贵、内存有余量」时做。普通文字项不要做。

\`RepaintBoundary.wrap\` 和在 build 里 \`RepaintBoundary(child: ...)\` 是同一 RenderObject。真正不同的是你把它放在哪一层：放在「变的东西」外面，隔离才成立；放在「变的东西」上，缓存每帧失效。一个页面标题栏不动、下面列表滚、角落一个转圈——三块三策：标题可 boundary，列表按需，转圈单独小 boundary，而不是给 \`Scaffold\` 套一个。

\`toImageSync\` 在 UI 线程请求同步读回，极端情况下会等 Raster 完成这一层。它把流水线拧成串行，只适合截图、分享卡片这类低频路径。用它做实时倒影、每帧毛玻璃，是在用最贵的方式模拟 \`BackdropFilter\`（而 BackdropFilter 已经够贵）。看到 \`toImage\` 出现在 \`paint\` 或 Ticker 里，先删。

引擎对 raster cache 有尺寸和条目上限，不是你贴多少 Boundary 就缓存多少。超大层可能被拒绝缓存，只留下「挡脏标记」这一半功能——这仍然有用：子树重绘不必冲到根。所以「棋盘格不出现」不一定是没 Boundary，可能是没资格进位图缓存。这时隔离还在，显存账单没有，不要为了看见格子再强迫扩大/缩小层去骗缓存。

另一个极端是 Boundary 包住一个 \`PlatformView\`。平台视图本来就在另一条合成路径上，再包一层 Flutter 位图缓存，等于有的后端要把平台视图先读进纹理。这通常更慢。平台内容的隔离交给 Embedder，不要用 RepaintBoundary 去「优化」WebView。

\`markNeedsPaint\` 在 boundary 处入队后，\`flushPaint\` 只从这些根 DFS。兄弟 boundary 没脏就不会被 visit 到。这是「里面吵、外面稳」能成立的微观原因：父 Picture 不重录，邻居也不重录。一旦父不是 Picture 而是一层每帧都变的 Opacity，父要重 \`addToScene\`，但邻居的像素仍可复用——所以 Opacity 动画里，静态邻居上的 Boundary 仍然值钱，动的那一层上的 Boundary 不值钱。把节点画成「谁在动、谁在旁边」，比看 Widget 树层级更准。

## 9. 设计取舍（为什么是现在这样）

- **默认不缓存、脏标记冒泡到根**：实现简单，静态页少占显存。代价是一个小动画可以重录整页。
- **显式 Boundary + 可选位图**：把「隔离」交给作者，因为框架不知道哪一侧稳。代价是误用直接变成显存泄漏式的卡顿。
- **与 compositing bits 分离**：需要合成不等于需要缓存。代价是两个概念都要懂，只懂 Widget 名会用错。
- **\`toImage\` 复用同一机制**：截图不必另开一套栅格化。代价是这条 API 看起来像 Dart 同步能力，其实在向 Raster 要读回。

这些取舍决定了什么优化有意义。给整页加一个 Boundary 几乎无益——根已经是。给每帧全变的子树加，是给 Raster 加活。给「里面稳、外面吵」加，才是在用显存买 CPU。

## 10. 怎么把原理用到排障上

一个小转圈导致掉帧，按堤坝提问：

1. **paint 队列里入队的是根还是近处的 boundary？** 若是根，转圈没有堤坝。
2. **棋盘格在闪吗？** 闪则有堤坝但缓存无意义，考虑拿掉或缩小动画区域。
3. **layout 是否也在每帧跑？** 是则你加错了河；去立 relayout boundary 或停止改 size。
4. **纹理有多大？** 全屏 DPR×宽×高×4 是一笔显存。列表 × N 项再乘一次。
5. **有没有每帧 \`toImage\`？** 那是强制读回，先删掉再谈 Boundary。

能回答这五问，你才能决定加、撤、还是把动画收进更小的 RenderObject。

## 11. 小结

\`RepaintBoundary\` 是重绘隔离，附带一张有生命周期的位图。隔离的前提是「里面稳、外面吵」或「里面吵、外面稳」。两边都吵，就别隔。下一篇把视角拉到线程：Vsync 怎样同时叫醒 UI 和 Raster，以及你在错误的 Runner 上等待会得到哪种卡顿。
`,
  "flutter-vsync-and-thread-model": `把 Flutter 理解成「一个 UI 线程包打天下」，会把三种完全不同的病当成同一种：Dart 超时、GPU 超时、平台通道堵在主线程。运行时是 **四条 Task Runner**，靠 Vsync 对齐；跨队列通信全是投递任务，不是直接调函数。搞混「谁可以等谁」，优化就会改到错误的代码。

读完你应该能独立回答三个问题：卡顿发生在哪一条 Runner、为什么 Dart 已经很快仍可能掉帧、插件回调里 \`setState\` 为什么有时要先切回 UI。

## 1. 先画边界：四条队列，职责必须互斥

| Runner | 典型线程 | 允许做什么 | 绝对不要做什么 |
|---|---|---|---|
| Platform | 系统主线程 | 生命周期、插件、部分输入、Platform View | 重计算、等网络（Android 上 ANR） |
| UI | Engine 创建的 UI 线程 | Dart、手势、build/layout/paint 记账 | 同步读磁盘、等 GPU、大 FFI |
| Raster | Engine 创建的 GPU 线程 | Skia/Impeller、纹理上传、提交 swapchain | 跑 Dart、阻塞等锁 |
| IO | 后台线程 | 图片解码、部分文件 | 碰 \`dart:ui\` 里和 GPU 绑定的对象 |

不变量：**UI 不碰 GPU 上下文；Raster 不跑 Dart；Dart 对象不得在 Raster 上解引用。** Layer 树从 UI 交到 Raster，走的是一次线程安全的移交，不是共享可变树。

Isolate 是内存隔离单位，不是这四条 Runner 之一。根 Isolate 默认绑在 UI Runner 上；\`Isolate.spawn\` / \`compute\` 另起 OS 线程和堆。worker 再快，也帮 Raster 画不动一个 \`saveLayer\`。

## 2. Vsync 如何变成一帧

Embedder 向系统注册 Vsync（Android \`Choreographer\`，iOS \`CADisplayLink\`，桌面则是合成器的呈现时钟）。信号到来：

1. Engine 的 Animator 被唤醒，向 UI Runner 投递「开始帧」。
2. \`PlatformDispatcher.onBeginFrame\`：Animate（Ticker）。
3. \`onDrawFrame\`：Build / Layout / Paint / \`compositeFrame\`。
4. \`Scene\` 投递 Raster Runner。
5. GPU 完成，buffer 交给系统合成器。

没有 Vsync，Framework 不会空转刷屏。\`scheduleWarmUpFrame\` 是启动例外：不等下一拍，尽快出第一帧，可能和系统节拍不对齐，所以第一帧时间不能拿来当稳态指标。

帧预算是显示周期：60Hz 约 16.6ms，120Hz 约 8.3ms。这个数字是 **UI 和 Raster 流水线共享的节拍**，不是「Dart 独享 16ms」。

## 3. 流水线：N 在 GPU 上，N+1 在 Dart 里

UI 处理完 N 就可以开始准备 N+1，不必等 N 上屏。这是双线程的全部意义。

\`\`\`dart
// 伪时序
// t0  Vsync    UI: drawFrame(N)
// t1           UI: Scene(N) 移交；UI 空闲或处理输入
// t1           Raster: 执行 Scene(N)
// t2  Vsync    UI: drawFrame(N+1)        Raster: 仍可能在 N
// t3           UI: 移交 Scene(N+1)       Raster: 提交 N，开始 N+1
\`\`\`

若 Raster 持续慢于节拍，Scene 排队。表现是 \`buildDuration\` 正常、\`rasterDuration\` 高、连续掉帧而不是单尖刺。这时在 Dart 里微优化 JSON 毫无意义。

反过来，UI 超时，Raster 会饿着：GPU 再快也没有新 Scene。Performance overlay 两条条形图，就是这两条 Runner 的占用，不是「CPU / GPU」的模糊标签。

流水线深度有限。为了不撕裂、为了和系统合成器对齐，提交的往往是「已经完成的 buffer」。这会引入大约一帧的显示延迟。触控跟手差，不一定是你的 \`build\` 超了 2ms，可能是流水线 + 系统合成叠了两拍。

## 4. SchedulerPhase：同一条 UI 线程上的相位

即使在 UI Runner 内部，一帧也被切成相位。\`SchedulerPhase.idle\` 时你可以随意 \`scheduleFrame\`；\`transientCallbacks\` 里跑 Ticker；\`persistentCallbacks\` 里跑 \`drawFrame\`；\`postFrameCallbacks\` 里这一帧已经交出。

\`\`\`dart
WidgetsBinding.instance.addPostFrameCallback((_) {
  // 安全读 RenderBox.size，几何已稳定
});
\`\`\`

在 \`build\` 里读 \`context.size\` 往往还是上一帧或 null；那是相位错了，不是 RenderObject 没 layout。在 \`persistentCallbacks\` 里再同步等一份 Platform Channel 回包，等于在帧中途把 UI Runner 借给 Platform Runner，预算直接打穿。

微任务插在相位之间。\`Future.then\`、\`await\` 的后续，如果每帧产生几百个，看起来「我没在 build 里干活」，Timeline 上却是 UI 线程在帧前被微任务吃掉。这仍是 UI 病。

## 5. Platform Channel 为什么是「异步」

Channel 的异步不是 Dart 语法糖，是线程模型的推论：Dart 把字节丢进队列，Platform Runner 取出、调 Java/ObjC、再把字节扔回 UI 队列。你 \`await\` 到的延迟 = 排队 + 拷贝 + 原生执行。

没有共享内存。大图走 Channel 会双倍拷贝（进 Java heap，再进 Dart heap）。每帧数据不要走 Channel；零拷贝大缓冲走 FFI / \`TransferableTypedData\` / 纹理。

插件回调默认可能在 Platform 线程。在那里碰 \`setState\` 或任何 \`dart:ui\` 对象，轻则断言，重则静默损坏。必须投递回 UI：

\`\`\`dart
void onNativeEvent(dynamic data) {
  SchedulerBinding.instance.scheduleTask(() {
    if (!mounted) return;
    setState(() => _value = data);
  }, Priority.touch);
}
\`\`\`

\`scheduleTask\` 仍受帧节拍约束。一股脑把一万个原生事件打进 UI 队列，和在 \`build\` 里算一万次没区别。

Engine 侧的 Animator 还负责「这一拍要不要跳过」。UI 或 Raster 连续超时，Vsync 到来时上一帧还没提交，Animator 会跳帧：不是把积压的 Scene 一张张补画（那会越来越滞后），而是丢掉中间态，追最新一帧。所以严重卡顿时动画会「瞬移」，不是 Ticker 算错了 elapsed。\`FrameTiming.frameNumber\` 不连续、\`buildDuration\` 偶发远超预算，就是跳帧在发生。

输入路径和帧路径是两条投递。指针事件从 Platform Runner 进 UI，不必等下一个 Vsync 才能 hitTest；但由输入触发的 \`setState\` 仍要等到下一拍 \`drawFrame\` 才变成像素。这就是「跟手」的下限：事件处理可以在帧间发生，上屏不能。把重逻辑放在手势回调里同步做，等于在两次 Vsync 之间抢 UI Runner，下一帧 buildDuration 直接被吃掉。手势回调里只改值、标脏，把重活推到 worker 或下一帧的 \`idle\` 相位。

桌面和 120Hz 手机把预算砍到 8.3ms，流水线更脆：UI 用掉 6ms，Raster 只剩缝。这时「还能塞点微任务」的 Debug 直觉完全失效。\`SchedulerBinding.instance.schedulingStrategy\` 可以在负载高时推迟非用户可见的任务；业务代码更实际的做法是：触摸优先级的工作用 \`Priority.touch\`，日志上报用 \`Priority.idle\`。闲时任务跑进 \`transientCallbacks\` 之前，会表现为「一抬手下一帧就卡」，其实是 idle 工作抢了节拍。

Platform View 把四条 Runner 的互斥打开一个洞：Android 的 Hybrid Composition 会在 Platform 线程和系统合成器上再同步一次。Vsync 仍在走，但 Flutter 的 Raster 不再独占 swapchain。滚动一个内嵌 WebView，掉帧可能发生在系统合成，overlay 的 GPU 条和 UI 条都看不懂。这类问题的第一动作是把 Platform View 移出动画热路径，而不是减 Dart 分配。

多窗口 / 多 Engine 时，每份 Engine 有自己的 Animator 和 Vsync waiter。两个 Flutter 表面对同一块屏幕，可能对不齐节拍，表现为一边顺一边撕。\`FlutterEngineGroup\` 共享 VM 和 GPU 上下文，但不合并两条帧循环。混合栈里一个原生滚动 + 一个 Flutter 滚动要对齐，是 Embedder 问题，不是你在 Dart 里 \`vsync\` 对得不够准。

\`FrameTiming\` 的字段要拆开读：\`vsyncOverhead\` 是信号来了但 UI Runner 没立刻开工（被微任务或上一帧拖住）；\`buildDuration\` 是 Dart 管线；\`rasterDuration\` 是 GPU 线程；\`layerCacheCount\` / 内存相关字段反映缓存。只看「掉没掉帧」会把 vsyncOverhead 误当成 build 慢，于是去拆 Widget，其实是 Channel 回包堵在 UI 队列头上。把 \`FrameTiming\` 打到日志里按字段分桶，比看平均 FPS 更接近这四条 Runner 的实情。

后台与前台切换时，Embedder 会停 Vsync waiter，Ticker 被 mute。回到前台第一拍往往伴随着 GPU 上下文恢复、纹理重新上传。这不是「Dart 启动慢」，是 Raster 在重建它不该在后台保持的资源。把重活放在 \`AppLifecycleState.resumed\` 同步做，会和恢复 Vsync 撞车，第一帧必卡。恢复路径上只标脏，让随后几拍的空闲去补纹理。

## 6. IO Runner：解码不是上传

图片：压缩文件在 IO Runner 解码成 RGBA，再上传成 GPU 纹理（上传常在 Raster）。把「解码」和「上传」当成一件事，会误判卡在哪。

- 解码慢：IO 队列堆积，图片迟迟不出现，UI 未必掉帧。
- 上传慢：Raster 超时，滚动掉帧，解码其实已经完成。
- 解码尺寸错误：4000×3000 × 4 ≈ 48MB，列表里几张就能把内存打穿。\`cacheWidth\` / \`cacheHeight\` 在解码时缩小，省的是原生堆和显存，不是 JPEG 文件大小。

\`dart:ui\` 的 \`ImmutableBuffer\` / \`ImageDescriptor\` 可以在 worker isolate 解码后把句柄送回。像素不要经 Channel 绕一圈。

## 7. 内存与生命周期：谁分配、谁释放、谁跨线程

- **Dart 堆**：只在其 Isolate 里可见。UI Isolate 的卡顿不会被 worker 的 GC 直接分担；worker 回传的大对象会在 UI Isolate **再分配一份**。
- **原生堆**：Layer、DisplayList、Codec 中间缓冲。Codec 若被 \`ImageCache\` 钉住，原生像素不随 Dart 短命 Widget 死掉。
- **GPU 显存**：纹理、MSAA、离屏。Raster 独占。

跨线程移交必须拷贝或转移所有权。这就是 Channel 拷贝、FFI 要自己 \`free\`、Texture 要用共享 GPU 对象的原因。Engine 销毁（\`FlutterEngine.destroy\`）必须停四条 Runner、丢 GPU 上下文。Activity 销毁后仍有 Dart 定时器在 \`setState\`，是生命周期漏了，不是 Vsync 太勤。

混合 App 多 Engine：每份 Engine 一套 Runner + 一份 GPU 上下文。RSS 随页面线性涨，先查有没有 \`FlutterEngineGroup\`，再查有没有把重活放到了 Platform 线程。

## 8. 设计取舍（为什么是现在这样）

- **四条 Runner 而不是一条**：Dart 和 GPU 流水线并行，插件不堵栅格化。代价是问题要先分流，工具也要两套（Dart Timeline + GPU 捕获）。
- **帧对齐 Vsync**：省电、不撕裂。代价是输入到上屏至少隔着合成器的一拍；想「立即画」只能 warm-up 或接受撕裂。
- **单 UI Isolate 跑 Framework**：无 UI 数据竞争。代价是任何同步卡顿都是全屏卡顿，重活必须离开 UI。
- **Channel 拷贝语义**：安全、语言无关。代价是不适合热路径大数据。

这些取舍决定了什么优化有意义。在 Platform 线程做 JSON 解析，Android 上是 ANR 候选项；在 UI 线程 \`dart:io\` 同步读文件，是自己砸节拍；在 Raster 上看不到的「Dart 优化」改变不了 \`rasterDuration\`。

## 9. 怎么把原理用到排障上

遇到卡顿，先钉 Runner，再改代码：

1. **overlay 里 UI 条高还是 GPU 条高？** 高的那条就是病所在。
2. **是否伴随 ANR / 主线程 watchdog？** 去 Platform Runner，查插件和 Platform View，不查 \`setState\`。
3. **图片是迟迟出现还是滚动掉帧？** 前者偏 IO/解码，后者偏上传/Raster。
4. **掉帧是否和 Channel 大包、FFI 同步调用同时出现？** 看调用发生在哪条线程。
5. **是否多 Engine？** 线程数和 RSS 一起涨，不是单帧算法问题。

能回答这五问，线程模型就是一张「谁可以等谁」的表，Vsync 是表上的节拍器。

## 10. 小结

Flutter 用四条任务队列把操作系统、Dart、GPU、解码拆开，用 Vsync 对齐成帧。流水线让 UI 和 Raster 可以错开一个节拍；也让「我 Dart 很快仍掉帧」成为常态而不是悖论。下一篇进入 UI Isolate 内部，看分代 GC 怎样把「每帧 new」变成掉帧源。
`,
  "flutter-dart-vm-gc-and-memory": `把卡顿理解成「GC 不好」会把真正的病——无界分配、短命大对象晋升、钉在错误堆上的像素——掩盖掉。Dart VM 用分代回收：新生代复制，老年代标记-清扫（必要时压缩）。Flutter 每秒 60/120 次 build，若热路径每帧都 \`new\` 大对象，GC 就会变成掉帧源。原理要落到「对象活多久、有多大、在哪块堆」。

读完你应该能独立回答三个问题：为什么一千个临时 Widget 往往无害而一帧一份大 \`List<Offset>\` 有害、晋升为什么是性能事件、ImageCache / \`ui.Image\` / FFI 指针为什么在 DevTools Memory 里看不见同一笔账。

## 1. 先画边界：三块堆，GC 只管其中一块

一次 Flutter 进程里至少有三块互不混淆的内存：

- **Dart 堆**：Isolate 私有（更准确：每个 Isolate 有自己的对象图；同 group 共享代码和元数据，不共享可变对象）。Widget、Element、State、普通 List/Map、闭包，都在这里。分代 GC 管它。
- **原生堆（C++）**：DisplayList、Layer 镜像、字体缓存、Codec 中间缓冲、FFI 分配。Dart GC 看不见，要 \`free\` / \`dispose\` / Engine 析构。
- **GPU 显存**：纹理、MSAA、离屏、字形图集。Raster 线程持有。\`RepaintBoundary\` 缓存也在这儿。

\`ui.Image\` 在 Dart 里只是句柄。句柄被 ImageCache 或 State 钉住，原生像素和 GPU 纹理就不会放。只看 DevTools 的 Dart 堆下降，RSS 可能纹丝不动——像素不在那一堆。

不变量：**跨 Isolate 不能共享可变对象；跨 UI/Raster 不能共享 Dart 对象。** 要传，就拷贝或转移所有权（\`TransferableTypedData\`、纹理 id）。

## 2. 新生代：半空间复制，为「这一帧用完就扔」而设计

新对象从 TLAB / bump-pointer 在新生代分配，几乎是加一个指针。新生代用 **scavenge**：活对象从 from-space 拷到 to-space，其余当垃圾。空间小（数 MB 量级，随负荷可调），停顿短，目标是亚毫秒到一两毫秒。

\`build()\` 里创建一棵浅 Widget 树，通常符合这个模型：对象很小、立刻没有引用、下一轮 scavenge 就没了。这就是为什么「少 new Widget」很少是第一优化——Widget 构造便宜，活得也短。

危险的是同一拍里分配 **大** 的新生代对象：几万个 Offset、整页解码前的 \`Uint8List\`、超长字符串拼接。它们很快把新生代填满，scavenge 变勤；若还被某个长命对象够到，下一节的晋升就会发生。

\`\`\`dart
@override
void paint(PaintingContext context, Offset offset) {
  final points = <Offset>[]; // 每帧一份，点多了就是分配事件
  for (final p in particles) {
    points.add(Offset(p.x, p.y));
  }
  context.canvas.drawPoints(PointMode.points, points, _paint);
}
\`\`\`

热路径应复用 \`List\` / \`Float32List\` / \`Paint\` / \`Path\`，或把缓冲放进 \`State\` 里原地更新。不是因为「new 慢」，是因为你在 8.3ms 里制造 GC 工作。

## 3. 老年代：活过几次 scavenge 的对象

对象连续几次 scavenge 还活着，就 **晋升** 进老年代。老年代用标记-清扫，标记可以并行，清扫可以并发；空间不够或碎片严重时 compact，停顿明显变长。老年代 GC 一旦撞上帧，Timeline 上会出现和 Vsync 重合的大块 STW 或很长的 mutator 暂停。

晋升是性能事件，因为它意味着：

- 这块内存从「廉价复制」变成「要参与整堆标记」。
- 若它其实是短命的（只是太大、逃过了新生代的几次拷贝），老年代被垃圾污染，标记成本被抬高。
- 老年代对象若指向新生代，写屏障要记账（remembered set）。热路径上对老对象反复塞新 List，写屏障 + 晋升双开。

典型错误：把每帧的 \`List<Offset>\` 存进 \`State\` 却每次 \`= <Offset>[...]\` 换新表，旧表若还被动画闭包、缓存、Riverpod 容器握着，就晋升；图片解码结果没人 \`dispose\`，却被全局 cache 引用，原生堆和 Dart 句柄一起钉死。

## 4. 写屏障、跨代指针、Isolate

向一个老年代对象的字段写入指向新生代的引用，VM 必须记下，否则 scavenge 只扫新生代会漏根。这就是写屏障。你感觉不到它，除非热路径每帧在改一个长命 \`State\` 里的大对象图。

Isolate 堆不共享。\`compute\` 的入参和回包要拷贝（可拷类型：num、String、List/Map 的树、typed data 的拷贝；\`TransferableTypedData\` 转移所有权）。worker 上 GC 再狠，也减不掉 UI Isolate 的 scavenge；它能做的是让 UI 少分配——把 JSON 解析、图像变换放过去，只把小结果拷回来。

回传一个 20MB 的 \`Uint8List\`，是在 UI Isolate **再分配 20MB**。那一瞬间新生代/老年代都可能被打满。大缓冲应在 worker 里变成更小的结构，或走纹理/文件，不要当消息。

## 5. Flutter 特有的钉住：缓存、图片、Layer

GC 只回收没有入边的 Dart 对象。Framework 里有几处合法的「长命根」：

- **\`ImageCache\`**：默认约 1000 张、100MB 上限（可改）。它按 \`ImageProvider\` 的 key 钉 \`ImageStream\`。列表快速滚动会把解码结果打进缓存；上限太高，RSS 高；上限太低，同一张图反复解码，IO 和 Raster 来回打。
- **\`ui.Image\` / \`Codec\`**：必须 \`dispose\`。不 dispose 的句柄会让原生像素活过所有 Dart 引用的直觉寿命。
- **Layer / \`LayerHandle\`**：Raster 可能仍在用上一帧的 Layer。句柄是跨线程生命周期的 Dart 侧锚点。
- **\`KeepAlive\` / \`AutomaticKeepAliveClientMixin\`**：Tab、列表项被刻意钉住，Element 和 State 不随滑出而 unmount。内存换的是切换速度，不是泄漏，但账单要记账。
- **闭包与 \`Ticker\`**：\`AnimationController\` 没 \`dispose\`，Ticker 继续要帧，对象图活着，Vsync 也不停。

泄漏排查先问在哪块堆：DevTools Memory 看 Dart；原生用 Instruments / Android Studio Profiler；显存看纹理数量和 ImageCache 字节。三套工具，三套结论。

## 6. 分配与帧时间：GC 事件要和 Vsync 叠图

DevTools Timeline 里 GC 是独立事件。它与掉帧重合，才是「GC 造成的卡」。不重合，只是堆在涨，卡在别处。

看这些量，而不是看「GC 坏了」的感觉：

| 信号 | 更可能的原因 |
|---|---|
| 新生代 scavenge 极勤，停顿仍短 | 热路径小对象太多，先复用缓冲 |
| 偶发长停顿，老年代 mark/compact | 短命大对象晋升，或长命图太大 |
| Dart 堆稳，RSS 涨 | 原生像素、字体、GPU 纹理 |
|  isolate 回包瞬间掉帧 | 主 Isolate 正在拷贝/分配大消息 |

Release 和 Debug 的分配器、JIT、检查器都不一样。不要拿 Debug 的 GC 曲线做上线结论。Profile 模式更接近 Release，仍带 Timeline。

\`ImageCache\` 的 key 是 \`ImageProvider\` 的 \`==\` / \`hashCode\`。同一 URL 但每次 \`new NetworkImage(url)\` 且你重写坏了相等性，缓存会当不同图，解码 N 次、钉 N 份。反过来，key 太粗（都当同一张）会显示错图。这是 Dart 堆上的字典问题，像素却在原生和 GPU。调 \`maximumSizeBytes\` 而不修 key，只是在用错误的上限补错误的身份。

另一类钉住是 \`StreamSubscription\`、\`ChangeNotifier.addListener\`、\`Timer\` 没有在 \`dispose\` 里摘掉。闭包捕获 \`State\`，Element 已经 unmount，对象图仍从全局的 notifier 活着。DevTools Memory 的「leak」往往是这条边，不是 VM 没回收。\`leak_tracker\` / \`debugIsWidgetCreated\` 能在测试里把这类边变成失败，比在生产里看 RSS 更早。

大对象分配还有一条捷径：\`Uint8List(n)\` 超过一定阈值会直接进老年代或成为「大对象区」，跳过新生代的廉价 scavenge。所以「先 new 大缓冲再立刻不用」不是新生代问题，是直接污染老年代。图片、音频、文件应流式处理或在 worker 里消化成小结构再回传。

字符串是隐藏的大对象来源。\`jsonEncode\` 一整棵树、\`TextSpan\` 里拼接日志、\`toString()\` 打到每帧的 overlay，都会在 UI Isolate 产生长 \`String\`。它们不可变，拼接即分配。热路径用 \`StringBuffer\` 仍是分配，只是少中间对象；真正的办法是不要在 60Hz 路径上做字符串。\`debugPrint\` 在 Profile 里也不是免费的。

\`finalizer\` 不是析构函数。它在对象不可达之后的某个 GC 时机跑，可能晚于你需要释放 GPU 纹理的那一帧，也可能在 isolate 退出时成批跑。及时 \`dispose\` 是协议；finalizer 是防漏的网。把资源释放只挂在 finalizer 上，RSS 会呈锯齿：GC 才降，帧中间一直顶着。

Isolate group 共享 AOT 代码和部分元数据，这是 \`FlutterEngineGroup\` 省内存的真正原因之一：第二份 Engine 不再映射一份完整机器码。堆仍然隔离。看到「group 共享」就往另一份 Engine 塞对象，会在发送端口上拷贝，甚至直接失败。共享的是代码，不是你的 \`ImageCache\`。每份 Engine 一份缓存，这是混合栈 RSS 的常见倍数。

\`compute\` 的闭包不能捕获 UI 对象。能发过去的是可拷贝消息。你把 \`BuildContext\`、\`RenderBox\`、\`ui.Image\` 塞进 worker，不是「GC 会处理」，是发送直接失败或把一份巨大的拷贝打进子 isolate 再打回来。Worker 的正确输入是纯数据：文件路径、字节、数字窗口；输出是更小的纯数据或 transferable。GC 优化从这条边界开始：减少跨堆拷贝，比微调新生代大小有用。

Timeline 里 \`CollectNewGeneration\` 和 \`CollectOldGeneration\` 要分开看。前者密而短，说明热路径分配多，去复用；后者疏而长，说明老年代体积或碎片，去找晋升和长命图。把两者都叫「GC 卡顿」然后全局关动画，是在用产品功能给分配器赔罪。

\`WeakReference\` 和 \`Expando\` 不会把对象钉在老年代，适合「缓存想握但不阻止回收」的边。ImageCache 不是弱引用，它是有上限的强缓存。把业务对象图做成无上限 Map 当缓存，GC 永远看不见垃圾，这是泄漏协议，不是分代算法失败。上限 + 按代淘汰（LRU）是你必须在 Dart 里写的，VM 不会替你猜哪张图还可以扔。

## 7. FFI 与 External：GC 的盲区

\`Pointer<T>\`、\`malloc\`、第三方 so 里的缓冲，不在 Dart 堆。GC 不会因为 Dart 侧包装对象死了就 \`free\` 指针——除非你注册了 \`NativeFinalizer\` / \`Finalizer\`，并且包装对象真的不可达。

把 FFI 指针存进一个被全局单例钉住的对象，等于手动泄漏。把 \`Uint8List\` 的 \`asExternalTypedData\` 在原生释放后还在 Dart 里读，是 use-after-free，GC 帮不上。

Engine 自己的图片、路径、Picture 也走类似「Dart 句柄 + 原生对象」模型。\`Picture.toImage\` 再产一张 \`ui.Image\`，两套资源。用完不 dispose，堆记账会骗过你。

## 8. 设计取舍（为什么是现在这样）

- **分代 + 短停顿新生代**：契合「每帧大量短命小对象」的 UI 框架。代价是大对象和长命图一旦晋升，老年代 GC 成为偶发长卡。
- **Isolate 不共享堆**：没有 UI 数据竞争。代价是并行必须拷贝，大结果回传本身是分配事件。
- **句柄式原生资源**：GPU/解码可以在 C++ 里管理。代价是 \`dispose\` 成为协议，泄漏不在 GC 曲线上。
- **ImageCache 全局钉住**：滚动列表不反复解码。代价是默认上限在大图场景下等于合法地占 100MB+。

这些取舍决定了什么优化有意义。把所有 Widget 改成对象池，通常赢不回一毫秒；把每帧的粒子数组改成复用的 \`Float32List\`，可能直接拿掉一次 scavenge。把图片 \`cacheWidth\` 设对，省下的是 GC 根本看不见的 48MB。

## 9. 怎么把原理用到排障上

RSS 涨或偶发掉帧，按堆提问：

1. **DevTools 里 Dart 堆是否在涨？** 涨则找长命根（缓存、闭包、KeepAlive、未 dispose 的 controller）。不涨则去原生/显存。
2. **GC 事件是否压在 Vsync 上？** 是则看新生代还是老年代，对症减分配或减晋升。
3. **热路径有没有每帧新的大 List / Path / 字符串？** 复用或移出 UI Isolate。
4. **ImageCache 字节、\`ui.Image\` 是否 dispose？** 列表页优先查这个。
5. **有没有 FFI / 多 Engine？** 前者 GC 盲区，后者是整份堆 × N。

能回答这五问，GC 就不再是敌人，而是一张「短命保持短命、长命保持稳定」的时间表。

## 10. 小结

分代 GC 为「这一帧用完就扔」的小对象而快，为「误晋升的大对象」和「钉在原生/GPU 上的像素」而慢。让短命对象保持短命，让长命对象保持稳定，帧时间才稳。下一篇回到 Framework：Element 树怎样用 \`runtimeType + key\` 决定哪些对象该继续活着、哪些该在这一帧结束时 unmount。
`,
  "flutter-element-tree-diff-algorithm": `把 Flutter 的更新理解成「整棵 Widget 树销毁重建」，会既高估 Widget 的成本，又低估 Key 用错的成本。三棵树分工不同：Widget 是不可变配置，Element 是实例化的生命周期，RenderObject 是布局与绘制。Diff **发生在 Element 层**。Key 不是优化开关，是 **身份证明**：你还是不是同一个人，决定 State、焦点、滚动位置、Layer 缓存跟谁走。

读完你应该能独立回答三个问题：为什么列表交换两项没有 Key 会「跟错人」、\`canUpdate\` 为 false 时销毁的是哪棵树上的对象、\`GlobalKey\` 能跨位置挪 Element 的代价是什么。

## 1. 先画边界：Widget 可以扔，Element 才是人

每一帧 \`build\` 都可以 \`new\` 一棵新的 Widget 树。这很便宜：Widget 通常是 const 或短命小对象，没有 \`State\`，没有 native 资源。框架拿新 Widget 去对 **已经挂在树上的 Element**：

- 能对上：Element 留下，换一份配置，可能更新对应 RenderObject 的字段。
- 对不上：旧 Element 走 deactivate →（本帧未被 GlobalKey 救回）unmount，新 Widget \`inflate\` 出新 Element。

不变量：**State 和 RenderObject 的寿命跟 Element，不跟 Widget。** 你看到 \`build\` 跑了，不表示 \`State.initState\` 跑了，更不表示 RenderObject 被 new 了。

这和 React 的「组件实例」类似，但 Flutter 的 Element 同时握着 State **和** RenderObject。复用错了，不只是业务 state 错，连 size、layer 缓存、焦点节点都会错。

## 2. canUpdate：身份证只有两行

\`\`\`dart
static bool canUpdate(Widget oldWidget, Widget newWidget) {
  return oldWidget.runtimeType == newWidget.runtimeType
      && oldWidget.key == newWidget.key;
}
\`\`\`

\`runtimeType\` 必须同一运行时类型，不是「长得像」。\`Text\` 和 \`_Text\` 内部类、两个不同的 \`StatefulWidget\` 子类，都不能更新同一 Element。\`key\` 必须同时为 null 或相等；一个有 \`ValueKey(1)\`、一个无 key，直接判死刑。

true：\`element.update(newWidget)\`，ComponentElement 再 \`rebuild\`，RenderObjectElement 调 \`updateRenderObject\`。false：不在这个节点上「变成另一种东西」，而是拆掉重建。

没有第三行「props 深比较」。Widget 的字段是否变化，是 \`update\` 之后各 Element 自己决定要不要 \`markNeedsLayout\` / \`markNeedsPaint\`。Diff 只解决身份，不解决「要不要重绘」。

## 3. updateChild：一个孩子的完整故事

父 Element 对单个 child 的更新，控制流可以收成：

\`\`\`dart
Element? updateChild(Element? child, Widget? newWidget, Object? newSlot) {
  if (newWidget == null) {
    if (child != null) deactivateChild(child);
    return null;
  }
  if (child != null) {
    if (child.widget == newWidget) {
      if (child.slot != newSlot) updateSlotForChild(child, newSlot);
      return child;
    }
    if (Widget.canUpdate(child.widget, newWidget)) {
      if (child.slot != newSlot) updateSlotForChild(child, newSlot);
      child.update(newWidget);
      return child;
    }
    deactivateChild(child);
  }
  return inflateWidget(newWidget, newSlot);
}
\`\`\`

\`child.widget == newWidget\` 是同一引用（\`const\` 或你缓存了 Widget 实例），连 \`update\` 都跳过。这是 const 有用的真正位置：不是「不 build 父」，是「子 Element 认为配置没换」。

\`slot\` 是这个孩子在父 RenderObject 里的位置（例如 \`IndexedSlot\`）。同一 Element 换 slot，不必重建，但父要调整 sibling 链表和 \`parentData\`。列表插入一项而不改后面项的 Key，后面项只换 slot，State 仍在。

## 4. 多孩子：先按 Key，再按位置

\`updateChildren\` 面对一组孩子时，先用 Key 建表，再线性扫：

1. 新 Widget 有 Key，且旧孩子里有相同 Key + 可 canUpdate：对上，挪到新位置。
2. 否则尝试当前位置的旧孩子 canUpdate（无 Key 时的默认：按位置复用）。
3. 对不上：旧的 deactivate，新的 inflate。
4. 多出来的旧孩子全部 deactivate。

没有 Key，交换两项就是「位置 0 的 Element 吃到位置 0 的新 Widget」。若类型相同，canUpdate 为 true：\`TextField\` 的输入、\`Scrollable\` 的 offset、\`AutomaticKeepAlive\` 的状态，都会留在位置上，而不是跟 id 走。用户看到的是「两项交换后，打的字还在上面那个框里」。

\`ValueKey(id)\` 是集合里稳定身份的常规写法。\`ValueKey(index)\` 在排序、插入后会骗人，和没 Key 几乎一样。\`ObjectKey\` / \`UniqueKey\` 每次 new 都是新身份，等于强迫重建——\`UniqueKey\` 用在「我就是要你拆掉」的场景，例如强制重启动画。

## 5. GlobalKey：跨位置挪人，而不是更快的 Key

\`GlobalKey\` 把 Element 登记进全局表。下一帧它可以出现在树的另一处：框架先从旧父 deactivate，再挂到新父，**同一 Element、同一 State、同一 RenderObject** 搬家。\`Overlay\`、\`Navigator\` 的一些英雄动画、你手写的「这个面板从抽屉拖到桌面」，靠的是它。

代价：

- 全局注册表，查找和冲突检测更贵。
- 同一时刻只能出现一次；两处 \`build\` 都挂同一个 GlobalKey，断言失败。
- 搬家发生在 \`buildScope\` 过程中，和普通 update 的深度排序交织，难推理。
- 它让 Element 逃过「按位置就地更新」，也让你更容易把本该死去的 State 钉在全局。

静态子树、列表项，不要用 GlobalKey 当 id。那是杀鸡用牛刀，而且牛会踢人。

## 6. deactivate 与 unmount：死亡分两步

deactivate 不是立刻销毁。Element 进 \`inactiveElements\`，本帧稍后 \`finalizeTree\` 时若仍无人认领，才 \`unmount\`：\`State.dispose\`、RenderObject \`detach\`、\`dropChild\`、清依赖。

GlobalKey 的搬家发生在 deactivate 之后、unmount 之前：新位置 \`inflate\` 发现 GlobalKey 已有 Element，把它 reactive 回来。所以「从树上拿下来再挂上去」可以在同一帧完成，State 不跑 \`dispose\`。

你在 \`dispose\` 里做的事（停 Ticker、关 controller、取消订阅）不会在 GlobalKey 搬家时跑。反过来，以为「Widget 没了 State 就死了」，会在 Key 复用时看到「死不掉的订阅」。生命周期跟 Element，不跟 Widget 实例。

\`unmount\` 之后 Element 不能再 \`markNeedsBuild\`。异步回调必须看 \`mounted\`。这是生命周期，不是 Diff 算法的附录。

## 7. 脏列表：Diff 并不走整棵树

\`setState\` 只把该 StatefulElement 丢进 \`BuildOwner._dirtyElements\`。\`buildScope\` 按 depth 排序后逐个 \`rebuild\`。没脏的子树，即使父 rebuild 了，仍走 \`updateChild\`：能 const / canUpdate 就留下。

所以 Diff 的复杂度接近「脏节点 × 其直接孩子数」，不是整棵应用树。父 \`setState\` 很大时，孩子又没有 const、没有拆 Element，才会变成「整页 Diff」。这是脏范围问题，不是算法没哈希。

\`InheritedWidget\` 是另一条通知边：依赖它的 Element 登记在 \`InheritedElement\` 的依赖表里。数据变了，只通知依赖者 \`didChangeDependencies\` / mark dirty，不靠从根 Diff 下去。依赖登记本身是生命周期的一部分：unmount 必须取消登记，否则 InheritedElement 会钉住已死的子孙。

条件插入兄弟是 Key 的经典试验场：\`if (flag) Banner()\` 插在 \`ListView\` 前面，Banner 无 Key、ListView 无 Key，flag 从 false 变 true 时，位置 0 的 Element 会拿 Banner 的 Widget 去 canUpdate 原来的 ListView——类型不同，ListView 被拆掉重建，滚动位置清零。给 ListView 一个稳定 \`Key\`，插入只 inflate Banner，ListView Element 换 slot 留下。\`Offstage\` / \`OverlayPortals\` 不走这条「插兄弟」的路，它们把孩子留在树上只是不画，State 还在；用 \`if\` 卸掉和用 \`Offstage\` 藏起来，Diff 结果完全不同。

\`updateChildren\` 还有 \`forgottenChildren\`：父在这次更新里没提到、但 GlobalKey 可能要认领的孩子，先不 unmount，等帧末。你自己重写 \`RenderObjectElement\` 却忘了把没再出现的孩子 \`deactivateChild\`，会把旧 RenderObject 留在 child 链表上，paint 出「幽灵孩子」。这是 Diff 协议在自定义 Element 上的镜像，和自定义 layout 协议一样，少一步就静默错。

\`StatefulElement\` 在第一次 \`mount\` 时 \`createState\`，之后直到 unmount 都是同一个 \`State\` 实例。\`didUpdateWidget\` 的 \`oldWidget\` 是上一份配置，不是「上一个身份」。身份没变、配置变了，才走这里：你在这里比较 \`oldWidget.id != widget.id\` 再清控制器，等于用字段模拟 Key。能用 Key 表达的身份，不要推迟到 \`didUpdateWidget\` 里手写。反过来，同一身份下 URL 变了要换订阅，那才是 \`didUpdateWidget\` 的活。

\`BuildOwner.lockState\` 在 build 期间禁止再 \`markNeedsBuild\`，防止 build 重入。你在 \`build\` 里同步调用会 \`setState\` 的回调，debug 会断言。正确的逃逸是 \`schedulePostFrameCallback\` 或把通知改成「这一帧只记值，下一帧再脏」。这不是风格，是 Diff 正在遍历脏列表时不能修改列表。

## 8. 三棵树联动：一次身份判断的下游

canUpdate true：

- Element 留。
- StatefulElement 的 \`State\` 留，\`didUpdateWidget\` 可能跑。
- RenderObjectElement 调 \`updateRenderObject\`，RenderObject 留；是否 \`markNeedsLayout/Paint\` 看字段。

canUpdate false：

- 旧 Element deactivate/unmount，State.dispose，RenderObject detach 并从父的 child 链表摘掉，Layer 句柄松开。
- 新 Element mount，State.initState，新 RenderObject 第一次 layout/paint。

这就是「Key 用错」的爆炸半径：你以为只是文字没对上，其实焦点节点、\`RestorationBucket\`、\`AutomaticKeepAlive\`、\`RepaintBoundary\` 的纹理，全跟错了人或被拆掉重建。

## 9. 设计取舍（为什么是现在这样）

- **Widget 不可变、每帧可 new**：配置像值，好 diff、好 const。代价是新手以为 new Widget 等于 new State。
- **身份 = runtimeType + key，默认按位置**：少写 Key 时静态 UI 仍然对。代价是集合重排必须显式给身份，否则静默跟错人。
- **GlobalKey 作为逃逸口**：真需要跨位置保留身份时有路。代价是全局性和唯一性，默认不用。
- **deactivate 延迟到帧末 unmount**：同一帧搬家可行。代价是 \`dispose\` 时机比「widget 离开 build 方法」更晚，异步必须看 \`mounted\`。

这些取舍决定了什么优化有意义。给整页加 GlobalKey 不会更快；给列表项 \`ValueKey(id)\` 不是微优化，是正确性。把 \`StatelessWidget\` 拆成更小的 \`StatefulWidget\` 来缩小脏范围，改变的是谁进 dirty list，不是 canUpdate 公式。

## 10. 怎么把原理用到排障上

「切换 Tab 状态丢了 / 没丢该丢的」按身份提问：

1. **同级孩子有没有稳定 Key？** 排序、插入、条件 \`if\` 插一个兄弟，都是 Key 的试验场。
2. **是 update 了还是 unmount/initState 了？** 在 \`didUpdateWidget\` 和 \`dispose\` 打点，立刻能看见 Diff 走了哪条路。
3. **脏的是哪个 Element？** 父 setState 过大，Diff 再正确也在做无用 update。
4. **有没有 GlobalKey 冲突或意外搬家？** 两处同时 build 同一 key，或以为 dispose 了其实只是 deactivate。
5. **Inherited 依赖有没有泄漏？** 已 unmount 仍被通知，是登记没摘干净，不是 Diff 没跑。

能回答这五问，三棵树就不再是 mermaid 图，而是一次更新里谁该活、谁该死、谁该搬家。

## 11. 小结

Diff 问的是「你还是不是同一个人」。\`runtimeType + key\` 是身份证，位置只是没有身份证时的猜测。Widget 可扔，Element 是人，RenderObject 跟人走。把身份说清楚，后面自定义 RenderObject 才不会在每次父 rebuild 时把你手绘的树拆掉重建。
`,
  "flutter-custom-renderobject-practice": `当每帧有成千上万个点、粒子、K 线时，先被吃光的往往不是 GPU，是 **树的基数**：每个粒子一个 Widget，就有一个 Element、一个 RenderObject，Diff、visit、hitTest、layout 全是 O(N)。自定义 \`RenderBox\` 的原理是把 layout/paint 收回到一个节点，数据仍是 N 条，树是 1 个节点。这不是「更底层所以更快」的神秘学，是在遵守前面几篇已经立住的不变量：一次 layout、paint 只记账、脏标记分河。

读完你应该能独立回答三个问题：什么时候该写 RenderObject 而不是 \`CustomPaint\`、数据变了该 \`markNeedsPaint\` 还是 \`markNeedsLayout\`、一万次 \`drawCircle\` 和一次 \`drawRawAtlas\` 为什么能差出一个数量级。

## 1. 先画边界：降基数，而不是重写引擎

自定义 RenderObject 仍然活在 UI Runner 上，仍然走 \`performLayout\` / \`paint\` / \`hitTest\`，仍然把指令记进 Layer。它 **不** 让你碰 Metal，也 **不** 让你绕过 Vsync。

该写它的信号：

- N 很大，且 N 个对象没有各自的 State / 无障碍节点需求。
- 布局是领域算法（时间轴、K 线视窗、力导向），用 \`Stack\` + \`Positioned\` 表达会先 Diff 死。
- 需要在 layout 里读约束、在 paint 里用同一套几何，还要自己做命中测试。

不该写它的信号：组合现有布局就够；只是想画一个静态图标（\`CustomPainter\` 足够）；其实瓶颈在 \`saveLayer\` 和大图。

\`CustomPaint\` 是「一个 RenderCustomPaint + 你的 painter」。它已经是单节点。若你不需要自定义 hitTest/layout 协议，先用它。升到自己的 \`RenderBox\`，是因为你要管 \`parentData\`、孩子、semantics、layer，或要把数据更新从 Widget rebuild 里彻底拿开。

## 2. 最小合法对象：约束、尺寸、记账

\`\`\`dart
class RenderParticles extends RenderBox {
  List<Particle> particles = const [];

  set particles(List<Particle> value) {
    if (identical(_particles, value)) return;
    _particles = value;
    markNeedsPaint();
  }

  List<Particle> _particles = const [];

  @override
  void performLayout() {
    size = constraints.biggest;
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    final canvas = context.canvas;
    canvas.save();
    canvas.translate(offset.dx, offset.dy);
    _paintAll(canvas);
    canvas.restore();
  }

  @override
  bool hitTestSelf(Offset position) => size.contains(position);
}
\`\`\`

\`sizedByParent\` 语义在这里用 \`constraints.biggest\` 表达：尺寸只由约束决定，粒子再多也不撑开父。粒子变了只 \`markNeedsPaint\`，**不要** \`markNeedsLayout\`，除非算法改了 size。错标 layout，父链不是 boundary 时整页重排，单节点的优势被你自己抹掉。

Widget 侧用 \`LeafRenderObjectWidget\` 把字段打进 RenderObject，在 \`updateRenderObject\` 里赋值。赋值函数里比较旧值，决定 mark 哪条河。这就是自定义节点的 Diff：O(字段)，不是 O(粒子)。

## 3. 生命周期：attach、owner、LayerHandle

RenderObject 只有 \`attach\` 之后才有 \`PipelineOwner\`。在构造函数里 \`markNeedsPaint\` 没有 owner，标记会被记下，挂上树再刷。在 \`detach\` 之后异步回包里 mark，是生命周期错误。

自己持有 \`Layer\`（例如要把子树推进一个 \`OffsetLayer\` 做局部缓存）必须用 \`LayerHandle<T>\`，在 \`detach\` / \`dispose\` 里丢掉。裸 \`Layer?\` 字段会和 Raster 抢对象寿命：Dart 侧 GC 了，Raster 还在 \`addToScene\`。

\`dispose\` 路径上停 Ticker、释放 \`ui.Image\`、\`Picture\`。粒子系统若自己录了一张静态背景 Picture，那是原生资源，不是 List 里的 double。

## 4. 合批：GPU 对调用次数不友好

Impeller/Skia 对「一次提交很多顶点」友好，对「一万次 \`drawCircle\`」不友好。每条 \`draw*\` 都是 DisplayList 上的一条命令，翻译成 Entity 也是一份 Contents。N 大时，CPU 侧录制先爆，GPU 还没开始填像素。

热路径优先：

- \`drawRawPoints\` / \`drawRawAtlas\` / \`drawVertices\`：数据放 \`Float32List\`，每帧原地改，不 \`new List<Offset>\`。
- 静态背景录进 \`Picture\`，动画层只画变化的那一层。需要时把背景放进自己的 repaint boundary。
- \`Paint\`、\`Path\` 做成字段复用。\`Path\` 每帧 \`reset()\` 再填，比 new Path 少晋升。

\`\`\`dart
final _rstTransforms = Float32List(n * 4);
final _rects = Float32List(n * 4);
final _colors = Int32List(n);

canvas.drawRawAtlas(atlas, _rstTransforms, _rects, _colors,
    BlendMode.modulate, null, _paint);
\`\`\`

合批改变的是 Paint 阶段的录制成本和 Raster 的绑定次数。它不改变 Layout 协议，也不让你在 paint 里改 size。

## 5. 手势与命中：空间索引，不要为粒子生成节点

\`hitTestSelf\` 为 true，这个盒子吃下命中测试。细到某个粒子，自己做空间索引（网格、四叉树、按 x 排序后二分），在 \`hitTest\` / \`handleEvent\` 里查。

为每个可点粒子 inflate 一个 RenderObject，等于放弃自定义节点的全部意义。命中测试默认深度优先、子到父。你没有 child，就要在 \`hitTestSelf\` 里给出「这个点有没有东西」。

和滚动父的冲突走手势竞技场，不是在 \`paint\` 里判断。画布需要「按下即赢、挡住父滚动」时，用 \`EagerGestureRecognizer\` 或自己的 \`RenderPointerListener\` 语义，而不是 \`Listener\` 和 \`Scrollable\` 各听各的。

无障碍：N 个粒子不要 N 个 semantics 节点。聚合成分组、或只暴露当前选中项。语义树也在 UI 线程刷，基数同样能吃掉帧。

## 6. 数据从哪进树：Ticker 优于每帧 setState

粒子位置若在 \`State.build\` 里每帧算一遍再作为参数传下去，Element 仍要 \`updateRenderObject\`。便宜，但有一份 Widget 配置和一次 dirty build。

更干净的模型：\`RenderParticles\` 自己持 \`Ticker\`（通过 \`TickerProvider\` 从 Widget 注入），在 tick 里改内部数组并 \`markNeedsPaint\`。Widget 树这一帧可以完全不脏。这把 Animate 直接接到 RenderObject，跳过 Build，符合「动画改值不改树」。

\`\`\`dart
void _onTick(Duration elapsed) {
  _integrate(elapsed);
  markNeedsPaint();
}
\`\`\`

需要把选中项反映到 Widget 层（给外面一个 callback）时，才向上通知。不要为了 DevTools 好看每帧 \`setState\`。

## 7. 和孩子共存：parentData 是你的协议

不是所有自定义节点都是叶子。时间轴可能有「可拖标记」作为 child。这时用 \`MultiChildRenderObjectWidget\`，自己定义 \`ParentData\`：每个孩子除了 \`offset\`，还可以有 \`time\`、\`lane\`。

\`performLayout\` 里给孩子传紧约束（标记大小已知）或内容约束，然后按领域坐标写 \`parentData.offset\`。孩子自己可以是 boundary。你仍然是一次遍历：先定自己的 size（通常 \`constraints.biggest\`），再 layout 孩子，禁止根据孩子 size 改自己再 layout 孩子第二遍，除非你非常清楚自己在做受控的二次测量。

\`paint\` 里 \`context.paintChild(child, child.parentData.offset + offset)\`。漏了 \`paintChild\`，孩子的 Layer 不会进树，看起来像「没画」，其实是合成计划没挂上。

## 8. 调试与不变量：先让 debug 替你骂

自定义布局必须满足约束：\`size\` 出区间，debug 会在 \`debugAssertDoesMeetConstraints\` 炸。实现 \`computeDryLayout\` 与 \`performLayout\` 一致，否则父的 dry 查询会撒谎。

\`\`\`dart
@override
Size computeDryLayout(BoxConstraints constraints) => constraints.biggest;

@override
bool get sizedByParent => true;

@override
void performResize() {
  size = constraints.biggest;
}
\`\`\`

\`debugDumpRenderTree\`、\`debugDumpLayerTree\`、Performance overlay 的棋盘格，是这套对象的标准探头。粒子系统掉帧时先看是 UI 条高（录制了太多 draw 调用、每帧分配）还是 GPU 条高（真的像素太多、有离屏）。前者合批和复用缓冲；后者减模糊、减 overlap、减分辨率。

溢出不是视觉问题，是约束问题。\`debugPaintSizeEnabled\` 下出现黄黑条，说明你在 \`performLayout\` 里让孩子拿到了比你自己 \`size\` 更大的空间，或 paint 时用 offset 把内容画到盒子外。clip 掉只是把命中测试和像素再次分家。正确做法是给孩子 \`constraints.constrain\` 过的盒子，或明确 \`clipBehavior\` 并接受命中测试也被 clip。

需要局部缓存时，让这个 \`RenderBox\` \`isRepaintBoundary => true\`，而不是在外面再包 Widget。指针动画只 \`markNeedsPaint\`；坐标轴作为静态 \`Picture\` 字段，数据源变了才重录坐标轴。不要把整张 K 线每帧 \`saveLayer\` 做阴影，阴影预烘焙进 atlas。

语义上覆盖 \`describeSemanticsConfiguration\`，把当前可见区间、选中蜡烛的数值暴露成少量节点。N 根 K 线 N 个 semantics，无障碍服务遍历会在 UI 线程再吃掉一帧。这和降 Widget 基数是同一原则在另一棵树上。

\`updateRenderObject\` 是数据进入节点的闸门。比较要按值或按世代号，不要只比引用——调用方每帧 \`List.from\` 一份新列表，引用永远不同，你会每帧 mark，合批的意义还在，脏范围的意义没了。世代号（数据源每变一次 +1）让「没变」真正变成 no-op：

\`\`\`dart
@override
void updateRenderObject(BuildContext context, RenderKline renderObject) {
  renderObject.generation = generation;
  renderObject.viewport = viewport;
}
\`\`\`

\`generation\` 变才重读点；\`viewport\` 变只改窗口，可能只 mark paint。把「数据变了」和「相机变了」分成两个字段，是自定义节点相对 \`CustomPainter.shouldRepaint\` 能做细的地方。

孩子会变化时，不要在 \`paint\` 里根据数据 \`insert\`/\`remove\` RenderObject。那是 Element 的活。自定义多孩子节点的孩子集合应由 Widget 树声明，\`RenderObjectElement\` 去 diff。你在 paint 里改孩子链表，等于在错误的阶段改树，和在 paint 里改 size 是同一类协议破坏。

## 9. 设计取舍（为什么是现在这样）

- **默认一切皆 Widget 树**：可组合、可无障碍、可热重载。代价是基数大时 CPU 死在树上。
- **允许叶子 RenderObject 直接 Canvas**：逃逸口明确。代价是你要自己遵守布局协议、生命周期和合批。
- **CustomPaint 作为更浅的逃逸口**：多数绘制不必碰 parentData。代价是 hitTest/layout 定制能力有限，数据更新仍常走 Widget。
- **合批 API 暴露为 Canvas 原语而不是粒子框架**：Engine 保持封闭图元。代价是领域层要自己管 \`Float32List\` 布局。

这些取舍决定了什么优化有意义。把粒子做成 3000 个 \`Positioned\`，再换状态库，树还在；合成一个 RenderObject，N 变成数据，Diff 变成字段比较。反过来，三个按钮不要写 RenderObject，那是在用大炮打组合问题。

## 10. 怎么把原理用到排障上

「K 线滚动掉帧」按基数和阶段提问：

1. **Timeline 上是 build/layout 还是 paint/raster？** 树太大，前两者高；draw 太多，paint 高；离屏和填充，raster 高。
2. **有没有每帧 markNeedsLayout？** 视窗平移通常只改 paint 或一层 transform。
3. **有没有每帧 new 大 List / Path？** 和 GC 篇同一件事，会在自定义 paint 里更狠。
4. **命中测试是否 O(N) 扫全部粒子？** 触摸时掉帧，查索引，别加 Boundary。
5. **是否其实 CustomPaint 就够，却多写了一层错误协议？** 二次 layout、paint 改 size、漏 paintChild，都是自伤。

能回答这五问，自定义 RenderObject 就是「一棵子树收成一个节点」的工程，而不是另起一套渲染器。

## 11. 小结

自定义 RenderObject 把 N 个领域对象变成 1 个布局绘制节点 + N 条指令。遵守约束向下、脏标记分河、Picture 只记账、合批提交，帧预算才回到像素本身。它接上本专栏从 Engine、管线、Impeller、Layout、Layer、Boundary、线程到 GC、Element 的整条链：树要薄，阶段要纯，跨线程的东西要冻结。再往后，才是手势竞技场怎样在这一个节点上和滚动父抢同一根手指。
`,
};
