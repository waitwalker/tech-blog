import { rustPosts } from "./rust-posts";

export interface Post {
  slug: string;
  title: string;
  excerpt: string;
  content: string;
  category: 'Flutter' | 'Rust' | 'Next.js' | 'Architecture';
  date: string;
  readTime: string;
  author: string;
  tags: string[];
}

const catalog: Post[] = [
{
  "slug": "flutter-engine-architecture-overview",
  "title": "Flutter Engine 深度解密：从 C++ 核心、Dart VM 到 Shell 架构体系",
  "excerpt": "全景剖析 Flutter 引擎的分层结构，揭示 C++ 核心层、Skia/Impeller 渲染库、Dart VM 运行时以及嵌入层平台适配机制。",
  "category": "Flutter",
  "date": "2026-08-22",
  "readTime": "16 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "Flutter Engine",
    "C++",
    "系统架构"
  ],
  "content": "\n## 1. Flutter Engine 架构全景\n\nFlutter Engine 是整个框架的心脏，采用 C/C++ 编写，主要负责图形渲染、文本布局、Dart 运行时管理以及平台消息调度。\n\n### 核心组成模块\n1. **Dart VM / Runtime**：管理 Dart 对象的生命周期、Isolate 隔离区、AOT 编译产物的加载与 GC 分代回收。\n2. **Graphics Engine (Skia / Impeller)**：底层 2D 图形加速渲染引擎，负责将 Layer 树转化为具体的 GPU 指令（Metal / Vulkan / OpenGL）。\n3. **Text Layout (LibTxt / HarfBuzz / ICU)**：处理多语言文本字形测量、复杂排版换行与双向文字渲染。\n4. **Shell 层**：与宿主操作系统（Android/iOS/macOS/Linux/Windows）对接，管理窗口 Surface、线程创建与 Vsync 事件分发。\n"
},
{
  "slug": "flutter-rendering-pipeline-four-phases",
  "title": "剖析 Flutter 渲染管线：Animate、Build、Layout、Paint 四大阶段源码全景",
  "excerpt": "从 Vsync 信号触发到 GPU 栅格化，深度跟踪 RendererBinding.drawFrame 的完整生命周期与阶段流转。",
  "category": "Flutter",
  "date": "2026-08-23",
  "readTime": "18 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "渲染管线",
    "源码剖析",
    "性能优化"
  ],
  "content": "\n## 1. 渲染管线的四大黄金阶段\n\n每当硬件发出 Vsync 垂直同步信号时，Flutter 引擎会触发 `RendererBinding.drawFrame()`，按序执行以下四个关键步骤：\n\n```\n[Vsync Signal] \n       ↓\n1. Animate  ── 驱动 Ticker、AnimationController 步进\n       ↓\n2. Build    ── 脏 Element 树重建 (setState 标记)\n       ↓\n3. Layout   ── 从根 RenderObject 向下传递约束并计算几何尺寸\n       ↓\n4. Paint    ── 记录绘制指令到 DisplayList / LayerTree\n       ↓\n[Composite & Rasterize] ── 发送至 GPU 栅格化上屏\n```\n\n## 2. 为什么 Layout 阶段能做到单次遍历（One-Pass）？\nFlutter 强制遵循严格的 **BoxConstraints 约束向下传递、Size 几何尺寸向上反馈** 规则，任何节点不得在同一帧中回溯计算，从而将整棵树的布局时间复杂度严格压制在 O(N)。\n"
},
{
  "slug": "flutter-impeller-next-gen-renderer",
  "title": "Impeller 渲染引擎深度演进：从运行时着色器编译到预编译 Metal/Vulkan 架构",
  "excerpt": "深入解析 Flutter 团队耗时数年自研的 Impeller 渲染器，如何从根本上终结困扰移动端的 Shader 编译卡顿 (Jank)。",
  "category": "Flutter",
  "date": "2026-08-23",
  "readTime": "15 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "Impeller",
    "Shader",
    "Metal/Vulkan"
  ],
  "content": "\n## 1. Skia 在移动端的历史瓶颈：Shader Compilation Jank\n\n在传统 Skia 架构下，着色器程序（Shader）是在运行时首次遇到未知形状/阴影时即时编译的。驱动层编译 MSL/GLSL 会瞬间占用 CPU 几十毫秒，直接导致第一帧严重掉帧卡顿。\n\n## 2. Impeller 的革命性突破\n\nImpeller 采用 **离线预编译 + 现代图形 API 原生驱动** 设计：\n- **AOT 编译所有着色器**：在应用打包构建阶段，使用 `impellerc` 将所有着色器预编译为对应平台的原生二进制（Metal Bytecode / SPIR-V）。\n- **显式状态管理与多线程命令编码**：彻底摆脱全局 OpenGL 状态机包袱，直接利用 Metal/Vulkan 并行录制 Command Buffer。\n"
},
{
  "slug": "flutter-renderobject-layout-protocol",
  "title": "RenderObject 布局协议深度剖析：BoxConstraints 传递与 performLayout 实战",
  "excerpt": "深入掌握 RenderBox 的 min/max 约束计算、relayoutBoundary 边界隔离原理，以及复杂自定义布局的性能设计。",
  "category": "Flutter",
  "date": "2026-08-24",
  "readTime": "14 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "RenderObject",
    "Layout",
    "底层原理"
  ],
  "content": "\n## 1. 约束传递模型：向下传递 Constraints，向上反馈 Size\n\nRenderObject 树在布局时遵循单向数据流：\n- 父节点调用 `child.layout(constraints, parentUsesSize: true)`\n- 子节点在 `performLayout()` 中计算自己的 `size`\n- 父节点根据子节点的 `size` 计算子节点在坐标系中的 `offset`\n\n## 2. 重新布局边界 (Relayout Boundary)\n\n为了避免叶子节点的小变动引发整棵树从根重新计算布局，Flutter 引入了 Relayout Boundary：\n当满足以下任一条件时，当前 RenderObject 成为重排边界：\n1. `parentUsesSize == false` (父节点完全不依赖子节点尺寸)\n2. `constraints.isTight` (父节点给出了严格固定的宽高约束)\n3. `sizedByParent == true` (子节点尺寸完全由父约束决定)\n"
},
{
  "slug": "flutter-layer-tree-and-compositing",
  "title": "从 Paint 到 Compositing：Layer 树构建与 Scene 生成底层机制",
  "excerpt": "拆解 PaintingContext 如何将绘制指令聚合成 ContainerLayer 树，以及底层如何生成 Scene 并提交给 Engine 光栅化。",
  "category": "Flutter",
  "date": "2026-08-24",
  "readTime": "13 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "Layer",
    "Compositing",
    "渲染管线"
  ],
  "content": "\n## 1. 为什么需要 Layer 树？\n\n在复杂的 UI 中，并非所有绘制内容都在一个平面上直接画出。透明度 (Opacity)、剪裁 (Clip)、变换 (Transform) 等操作需要独立的离屏图层进行 GPU 混合（Compositing）。\n\n## 2. PaintingContext 与 Layer 生成流程\n\n```dart\n// PaintingContext 源码级概念\nvoid pushLayer(ContainerLayer childLayer, PaintingContextCallback painter, Offset offset) {\n  // 挂载新的子图层\n  currentLayer.append(childLayer);\n  // 在新图层上下文中继续绘制\n  painter(newContext, offset);\n}\n```\n最终，根 Layer 树会调用 `buildScene()` 生成底层的 `ui.Scene` 对象，直接投递给 Raster 线程送往 GPU。\n"
},
{
  "slug": "flutter-repaintboundary-isolation-mechanism",
  "title": "RepaintBoundary 重绘隔离机制与 Bitmap Cache 内存权衡",
  "excerpt": "深入分析 isRepaintBoundary 标志位如何阻断重绘脏标记扩散，以及位图缓存复用对 GPU 显存的深远影响。",
  "category": "Flutter",
  "date": "2026-08-25",
  "readTime": "12 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "RepaintBoundary",
    "性能调优",
    "显存优化"
  ],
  "content": "\n## 1. 重绘脏标记的向上传播\n\n当一个 RenderObject 调用 `markNeedsPaint()` 时，如果不加阻隔，脏标记会沿着父链一直向上蔓延，直到遇到 `isRepaintBoundary == true` 的节点为止。\n\n## 2. 滥用 RepaintBoundary 的代价\n\nRepaintBoundary 虽然能够隔离重绘，但它会在 GPU 显存中开辟一块 **独立的离屏纹理 (Offscreen Texture)**：\n- **优点**：若子树内容极其复杂但自身不动（如静态背景图表），重绘时直接复用缓存位图，跳过重绘。\n- **缺点**：若子树每帧都在发生变化，每帧都会触发额外的离屏渲染与显存拷贝，反而严重拖慢帧率并加剧显存压力！\n"
},
{
  "slug": "flutter-vsync-and-thread-model",
  "title": "Flutter 四大线程模型与 Vsync 信号调度体系",
  "excerpt": "UI 线程、Raster 线程、Platform 线程与 IO 线程如何协同工作？深度剖析双缓冲、管道化流水线与帧同步调度。",
  "category": "Flutter",
  "date": "2026-08-25",
  "readTime": "16 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "线程模型",
    "Vsync",
    "并发架构"
  ],
  "content": "\n## 1. 核心四大线程职责\n\n1. **Platform Task Runner**：运行在操作系统主线程，处理平台生命周期、系统级输入事件与 Platform View 交互。\n2. **UI Task Runner**：执行 Dart 代码、驱动 Widget/Element/RenderObject 树更新、生成 Layer 树指令（绝对不可在此执行耗时同步计算！）。\n3. **Raster Task Runner**：接收 UI 线程生成的 Layer 树，将其转化为 GPU 指令并调用底层图形 API 上屏。\n4. **IO Task Runner**：在后台执行昂贵的图片解码与纹理上传（Texture Uploading），避免阻塞 Raster 线程。\n\n## 2. 流水线并发 (Pipelining)\n\nUI 线程与 Raster 线程在时间线上是 **错峰流水线并行** 的：当 Raster 线程正在绘制第 N 帧时，UI 线程已经在利用下一个 Vsync 信号构建第 N+1 帧！\n"
},
{
  "slug": "flutter-dart-vm-gc-and-memory",
  "title": "Dart VM 运行时与分代垃圾回收（Generational GC）优化手记",
  "excerpt": "剖析新生代半空间复制算法 (Scavenge) 与老生代标记-清除-压缩算法，掌握避免短命大对象进入老生代的高阶技巧。",
  "category": "Flutter",
  "date": "2026-08-26",
  "readTime": "14 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "Dart VM",
    "垃圾回收",
    "内存优化"
  ],
  "content": "\n## 1. Dart VM 的分代回收架构\n\n- **新生代 (New Generation)**：内存容量较小（几 MB），使用 **半空间复制算法 (Scavenge GC)**，STW（Stop-The-World）停顿极短（< 1ms）。\n- **老生代 (Old Generation)**：存放生命周期较长的对象，采用 **并行标记 (Parallel Mark) + 并发清扫 (Concurrent Sweep)**，尽量减少主线程卡顿。\n\n## 2. 高频避坑点：避免在 build() 中创建大容量临时对象\n\n在每秒 60/120 帧的动画或滚动回调中频繁实例化重量级对象（如超大数组、临时字符串拼接），会迅速填满新生代，诱发高频 GC 甚至将对象过早晋升到老生代，引发不可预测的丢帧。\n"
},
{
  "slug": "flutter-element-tree-diff-algorithm",
  "title": "Element 树核心 Diff 算法：Key 机制与三棵树生命周期联动",
  "excerpt": "深入探索 Widget、Element 与 RenderObject 的一一对应与复用规则，理解 Widget.canUpdate 源码与 Element 挂载流程。",
  "category": "Flutter",
  "date": "2026-08-26",
  "readTime": "13 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "三棵树",
    "Diff算法",
    "Key机制"
  ],
  "content": "\n## 1. Widget.canUpdate 核心判断准则\n\n```dart\nstatic bool canUpdate(Widget oldWidget, Widget newWidget) {\n  return oldWidget.runtimeType == newWidget.runtimeType\n      && oldWidget.key == newWidget.key;\n}\n```\n当 `canUpdate` 返回 `true` 时，Element 实例会被保留复用，仅更新其内部引用的 Widget 配置，从而避免昂贵的 RenderObject 销毁与重建开销。\n"
},
{
  "slug": "flutter-custom-renderobject-practice",
  "title": "深入自定义 RenderObject：高性能手绘图表与流式粒子系统实战",
  "excerpt": "绕过 Widget 层的冗余抽象，直接基于 RenderBox 编写定制化绘制逻辑、处理手势命中与实现极致帧率。",
  "category": "Flutter",
  "date": "2026-08-27",
  "readTime": "15 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "RenderObject",
    "自定义绘制",
    "高性能"
  ],
  "content": "\n## 1. 为什么需要自定义 RenderObject？\n\n在需要每秒渲染数万个动态数据点的金融 K 线图或粒子系统中，使用传统的 Widget 堆叠会导致 Element 树极其臃肿。通过自定义 `RenderBox`：\n1. 完全控制 `performLayout()` 与 `paint()`。\n2. 零 Widget 创建开销，直连 Canvas 指令。\n\n```dart\nclass RenderParticleSystem extends RenderBox {\n  @override\n  void performLayout() {\n    size = constraints.biggest;\n  }\n\n  @override\n  void paint(PaintingContext context, Offset offset) {\n    final Canvas canvas = context.canvas;\n    // 直接操作底层的 Canvas 绘制粒子批处理\n  }\n}\n```\n"
},
{
  "slug": "flutter-gesture-arena-and-dispatch",
  "title": "Flutter 手势竞技场 (Gesture Arena) 与 HitTest 命中测试分发原理",
  "excerpt": "从指针事件 PointerDown 到手势竞技场胜出，深度拆解 GestureRecognizer 的手势竞争与多手势冲突解决策略。",
  "category": "Flutter",
  "date": "2026-08-27",
  "readTime": "13 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "手势竞技场",
    "HitTest",
    "事件分发"
  ],
  "content": "\n## 1. 命中测试 (Hit Testing)\n\n当用户手指触摸屏幕时，Flutter 会从根 RenderView 发起深度优先的 `hitTest()` 遍历，所有命中的 RenderObject 会将自己注册到 `HitTestResult` 路径列表中。\n\n## 2. 手势竞技场胜出判定\n\n多个手势识别器（如 TapGestureRecognizer 与 PanGestureRecognizer）会同时加入竞技场：\n- 当识别到明确的滑动位移时，Pan 手势宣布胜利并强行关闭竞技场，Tap 手势被判定认输并清空状态。\n"
},
{
  "slug": "flutter-platform-channels-codec-binary",
  "title": "Platform Channel 底层二进制通信机制与 StandardMessageCodec 编解码",
  "excerpt": "深入 BinaryMessenger 核心：探究 Dart 与原生层（Java/Objective-C/Swift）之间如何通过共享 ByteBuffer 实现类型安全的跨进程通信。",
  "category": "Flutter",
  "date": "2026-08-28",
  "readTime": "12 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "Platform Channel",
    "底层通信",
    "Codec"
  ],
  "content": "\n## 1. Platform Channel 的底层基石：BinaryMessenger\n\n所有的 MethodChannel 和 EventChannel 本质上都是建立在 `BinaryMessenger` 之上的高层抽象。通信双方交换的都是裸字节流（`ByteData` / `ByteBuffer`）。\n\n## 2. StandardMessageCodec 序列化性能\n\n`StandardMessageCodec` 采用紧凑的二进制格式编码常用数据结构（int, double, String, Map, List）：\n- 相比 JSON 字符串序列化，省去了昂贵的文本解析与字符串分配开销。\n"
},
{
  "slug": "flutter-ffi-zero-overhead-interop",
  "title": "Dart FFI 深度实践：C/C++ 内存共享与零开销跨语言调用",
  "excerpt": "告别 Platform Channel 异步序列化延迟！利用 dart:ffi 直接访问 C 函数指针与本地堆内存，打造高性能原生计算扩展。",
  "category": "Flutter",
  "date": "2026-08-28",
  "readTime": "15 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "Dart FFI",
    "C/C++",
    "极致性能"
  ],
  "content": "\n## 1. 为什么在计算密集型场景下选择 FFI？\n\nPlatform Channel 需要经过线程切换与两次内存拷贝（Dart 堆 $\\rightarrow$ 原生堆），而 **Dart FFI 是直接的函数调用（Direct Function Call）**：\n- 零拷贝（Zero-Copy）：直接通过裸指针（`Pointer<Uint8>`）操作共享内存。\n- 零线程切换损耗：直接在当前 Dart 线程的 CPU 寄存器和栈帧上执行 C 动态库指令。\n"
},
{
  "slug": "flutter-platform-views-texture-hybrid",
  "title": "混合开发进阶：Virtual Display、Hybrid Composition 与 Texture Layer 渲染性能横评",
  "excerpt": "在 Flutter 中内嵌原生 WebView、地图或相机视图时的底层实现演进，深入剖析三大内嵌方案的帧率与内存开销。",
  "category": "Flutter",
  "date": "2026-08-28",
  "readTime": "14 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "Platform Views",
    "混合开发",
    "渲染性能"
  ],
  "content": "\n## 1. 三代 Platform View 方案技术对比\n\n1. **Virtual Display**（历史方案）：将原生 View 渲染到离屏虚拟屏幕，GPU 内存消耗大，文本输入存在严重同步 Bug。\n2. **Hybrid Composition**：将 Flutter 的 UI 分割为多个原生图层并把原生 View 插入其中，解决输入法问题，但在部分设备上引发额外合成开销。\n3. **Texture Layer Hybrid Composition (TLHC)**：通过共享 GPU 纹理直接在 Flutter 渲染树内消费原生图像流，达成最佳帧率与内存平衡。\n"
},
{
  "slug": "flutter-engine-group-memory-sharing",
  "title": "FlutterEngineGroup 引擎组原理：在复杂原生 App 中实现极致内存复用与快速拉起",
  "excerpt": "企业级多 Flutter 页面原生宿主必备架构。详解 EngineGroup 如何共享底层 Isolate、Skia 缓存与运行时资源，将二次加载时间压缩至毫秒级。",
  "category": "Flutter",
  "date": "2026-08-29",
  "readTime": "13 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "FlutterEngineGroup",
    "内存复用",
    "架构设计"
  ],
  "content": "\n## 1. 单个 FlutterEngine 的痛点\n\n传统方案中，每次创建新的 `FlutterEngine` 都需要重新初始化 Dart VM 运行时，额外消耗 ~30MB 内存且冷启动耗时数百毫秒。\n\n## 2. FlutterEngineGroup 的内存共享魔法\n\n通过 `FlutterEngineGroup` 创建的后续引擎实例：\n- 共享底层线程池、GPU 上下文与字体布局缓存。\n- 每个新引擎的内存增量骤降至 **~180KB**，页面秒级瞬间展示！\n"
},
{
  "slug": "flutter-skia-vs-impeller-shader-warmup",
  "title": "为什么 Impeller 能够彻底终结 Shader 编译卡顿？与 Skia 预热方案深度技术对比",
  "excerpt": "对比传统 Skia Shader Warmup 的治标不治本，深入 Impeller 基于离线反射、静态着色器管线布局的根本性革命。",
  "category": "Flutter",
  "date": "2026-08-29",
  "readTime": "15 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "Impeller",
    "Skia",
    "图形学"
  ],
  "content": "\n## 1. 传统 Skia 预热方案的局限\n\n过去为了缓解卡顿，开发者需要手动录制动画生成 `shaders.sksl` 并在启动时预热。然而一旦设备换了 GPU 型号或更新了系统驱动，预热包立刻失效。\n\n## 2. Impeller 的架构级根治\n\nImpeller 彻底剔除了运行时生成着色器的机制，所有绘制图元（Path、Gradient、Blur、Shadow）全部收敛到预先固定编译好的几十个通用着色器中，从数学和架构上保证了 0 运行时着色器编译！\n"
},
{
  "slug": "flutter-image-cache-and-gpu-texture",
  "title": "ImageCache 缓存机制与 GPU 纹理显存生命周期：大图加载 OOM 根治方案",
  "excerpt": "探究 PaintingBinding.instance.imageCache 的容量控制策略、压缩图像解码与 cacheWidth/cacheHeight 缩放裁剪原理。",
  "category": "Flutter",
  "date": "2026-08-29",
  "readTime": "13 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "ImageCache",
    "显存管理",
    "OOM治理"
  ],
  "content": "\n## 1. 原生图片解码的显存陷阱\n\n一张 4000x3000 分辨率的高清照片，即使磁盘文件只有 2MB（JPEG 格式），解码为未压缩的 RGBA8888 像素矩阵后将瞬间吞噬：\n$4000 \\times 3000 \\times 4 \\text{ bytes} = 48 \\text{ MB 显存！}$\n\n## 2. 核心优化：ResizeImage 与 cacheWidth\n\n在构造 `Image.network` 或 `ResizeImage` 时，务必指定 `cacheWidth` / `cacheHeight`，指示底层 IO 线程在解码阶段就将其下采样到实际显示尺寸，节约 90% 以上的显存空间！\n"
},
{
  "slug": "flutter-frame-timing-and-devtools-profiling",
  "title": "帧耗时精细化分析：FrameTiming API 与 DevTools 性能火焰图定位 Jank 瓶颈",
  "excerpt": "如何通过代码监听 buildDuration 与 rasterDuration？手把手教你读懂 DevTools CPU Profiler 与 GPU 栅格化瓶颈定位。",
  "category": "Flutter",
  "date": "2026-08-29",
  "readTime": "14 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "FrameTiming",
    "性能监控",
    "DevTools"
  ],
  "content": "\n## 1. 生产环境性能监控：FrameTiming 监听\n\n```dart\nWidgetsBinding.instance.addTimingsCallback((List<FrameTiming> timings) {\n  for (final timing in timings) {\n    // UI 构建耗时 (超过 16.6ms 说明 Dart 代码存在重度计算)\n    final buildDuration = timing.buildDuration;\n    // GPU 栅格化耗时 (超过 16.6ms 说明图层过于复杂或存在离屏渲染)\n    final rasterDuration = timing.rasterDuration;\n  }\n});\n```\n"
},
{
  "slug": "flutter-accessibility-semantics-tree",
  "title": "语义化树 (Semantics Tree) 与无障碍辅助功能：从 RenderObject 到屏幕朗读器",
  "excerpt": "揭秘 Flutter 辅助功能底层：SemanticsOwner 如何监听 RenderObject 的语义变化，并在各操作系统平台映射无障碍节点树。",
  "category": "Flutter",
  "date": "2026-08-29",
  "readTime": "12 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "Semantics",
    "无障碍",
    "系统架构"
  ],
  "content": "\n## 1. 语义化树与渲染树的双轨并行\n\nFlutter 不仅构建用于视觉渲染的 RenderObject 树，还会同步维护一颗 **SemanticsNode 语义树**：\n- 当用户开启 iOS VoiceOver 或 Android TalkBack 时，引擎会激活语义管道。\n- 将按钮标签、朗读提示与点击动作实时同步给宿主操作系统的无障碍服务。\n"
},
{
  "slug": "flutter-state-restoration-and-engine-lifecycle",
  "title": "状态恢复 (State Restoration) 与 Engine 生命周期同步：Android 进程被杀后无缝自愈",
  "excerpt": "深入 RestorationManager 与 RestorationMixin：如何在后台进程被系统回收后，完美还原滚动位置、表单输入与导航历史栈。",
  "category": "Flutter",
  "date": "2026-08-29",
  "readTime": "14 min",
  "author": "Waitwalker",
  "tags": [
    "Flutter",
    "状态恢复",
    "生命周期",
    "高可用架构"
  ],
  "content": "\n## 1. 为什么移动端需要状态恢复？\n\n在低内存 Android 设备上，App 切入后台很容易被 LMK (Low Memory Killer) 静默终止。当用户重新打开 App 时，如果状态丢失会带来极差的体验。\n\n## 2. RestorationMixin 实战\n\nFlutter 提供了框架级状态序列化支持：\n```dart\nclass _MyFormState extends State<MyForm> with RestorationMixin {\n  final RestorableTextEditingController _controller = RestorableTextEditingController();\n\n  @override\n  String? get restorationId => my_form_restoration_id;\n\n  @override\n  void restoreState(RestorationBucket? oldBucket, bool initialRestore) {\n    registerForRestoration(_controller, form_text);\n  }\n}\n```\n"
},

  // 原始文章
  {
    slug: 'flutter-hybrid-architecture-practice',
    title: 'Flutter 3.x 高性能跨端架构与 Hybrid 混合栈深度实践',
    excerpt: '深入解析复杂 App 中 Flutter 与原生 iOS/Android 的混合路由通信、内存复用机制及底层渲染优化方案。',
    category: 'Flutter',
    date: '2026-08-20',
    readTime: '12 min',
    author: 'Waitwalker',
    tags: ['Flutter', '跨端架构', 'iOS/Android', '性能优化'],
    content: `
## 1. 混合工程架构设计

在大型企业级 App 开发中，纯 Flutter 往往无法完全替代原生业务生态。我们需要构建一套高效、轻量的 Flutter + Native 混合栈体系。

### 核心设计目标
- 单 Engine 内存复用：多个 Flutter 页面共享单一 FlutterEngine 实例，将内存开销从每个实例 ~30MB 降低到整体共享 ~35MB。
- 双向类型安全通信：利用 Pigeon 代码生成器替代原始 MethodChannel，消除运行时字符串匹配与动态类型解析风险。

\`\`\`dart
// Pigeon 接口定义示例
@HostApi()
abstract class NativeDeviceApi {
  DeviceInfo getDeviceInfo();
  void triggerHapticFeedback(int type);
}
\`\`\`

---

## 2. 渲染管道与帧率稳定性优化

1. 避免全局 setState 重绘：使用精细化状态管理（如 Bloc / Riverpod），将重绘范围限制在叶子节点。
2. RepaintBoundary 合理拆分：在复杂动效或图表列表区域添加 RepaintBoundary，隔离重绘上下文，避免触发整个 RenderObject 树的重绘。
3. 图片纹理复用：对高清大图进行严格的缓存尺寸限制（cacheWidth / cacheHeight），防止内存瞬间膨胀触发系统杀后台。
`
  },
  {
    slug: 'rust-tokio-async-network-service',
    title: 'Rust 异步运行时 Tokio 与高并发网络服务开发手记',
    excerpt: '基于 Rust 的零成本抽象与内存安全特性，探索使用 Tokio 构建高吞吐、低延迟并发网络服务的架构与踩坑经验。',
    category: 'Rust',
    date: '2026-08-15',
    readTime: '15 min',
    author: 'Waitwalker',
    tags: ['Rust', 'Tokio', '并发编程', '高性能系统'],
    content: `
## 1. 为什么选择 Rust 与 Tokio？

在追求极端性能与内存可预测性的后端服务中，Rust 提供了无 GC 停顿与编译期线程安全保证。
Tokio 作为 Rust 事实上的异步标准库，提供了基于 Work-Stealing 机制的多线程事件循环调度器。

\`\`\`rust
use tokio::net::TcpListener;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("0.0.0.0:8080").await?;
    println!("Server listening on port 8080");

    loop {
        let (mut socket, _) = listener.accept().await?;
        tokio::spawn(async move {
            let mut buf = [0; 1024];
            while let Ok(n) = socket.read(&mut buf).await {
                if n == 0 { return; }
                if socket.write_all(&buf[0..n]).await.is_err() { return; }
            }
        });
    }
}
\`\`\`

---

## 2. 异步关键避坑指南

1. 绝对不要在异步任务中执行阻塞式 I/O：使用 tokio::task::spawn_blocking 处理密集型 CPU 计算或同步文件读写。
2. Pin 与 Unpin 机制理解：异步 Future 状态机自引用结构的底层保障。
3. Channel 背压（Backpressure）机制：使用 mpsc::channel(buffer_size) 有界通道，防止生产者过快撑爆内存。
`
  },
  {
    slug: 'nextjs-app-router-static-export-performance',
    title: 'Next.js App Router 极致性能优化与 Static Export 落地指南',
    excerpt: '如何将 Next.js 项目静态化导出并部署至超轻量 VPS（如 512MB Lightsail），实现毫秒级加载与近乎零内存损耗。',
    category: 'Next.js',
    date: '2026-08-10',
    readTime: '10 min',
    author: 'Waitwalker',
    tags: ['Next.js', 'React 19', 'Web性能', 'DevOps'],
    content: `
## 1. 为什么在 512MB VPS 上选择 Static Export？

Node.js 运行时及 SSR（服务端渲染）通常需要至少 150MB~300MB 常驻内存，在 512MB 最低配置的云服务器上很容易因为流量激增或 GC 滞后导致 OOM 奔溃。

通过配置 output: 'export'：
- 构建工作在本地开发机完成，利用多核 CPU 瞬间打包生成 HTML/CSS/JS 静态文件。
- 远端服务器仅需运行极其轻量的高性能 Web 服务器（如 Caddy），内存占用低于 20MB。
`
  },

  // 20篇 Rust 基础与核心专栏文章
  {
    slug: 'rust-variables-and-mutability',
    title: 'Rust 基础篇 (一)：变量绑定、不可变性与常量深度剖析',
    excerpt: '深入探讨 Rust 中默认不可变设计的工程哲学，变量遮蔽 (Shadowing) 的内存重用机制，以及常量与不可变变量的核心差异。',
    category: 'Rust',
    date: '2026-08-21',
    readTime: '8 min',
    author: 'Waitwalker',
    tags: ['Rust', '语法基础', '变量', '内存安全'],
    content: `
## 1. 为什么 Rust 的变量默认是不可变的？

在大多数编程语言中，变量默认可变。Rust 选择默认不可变（Immutable）的核心原因在于**并发安全**与**代码可推导性**：
- 如果数据不可变，多个线程同时读取时绝对不可能发生数据竞争（Data Race）。
- 阅读代码时，无需担心某个函数在深层调用链中意外修改了全局或传入的局部变量。

\`\`\`rust
fn main() {
    let mut x = 5;
    println!("初始值: {}", x);
    x = 6; // 必须有 mut 关键字才允许修改
    println!("修改后: {}", x);
}
\`\`\`

## 2. 变量遮蔽 (Shadowing) 的妙用

Rust 允许通过重复使用 \`let\` 声明同名变量来遮蔽之前的变量。这不仅可以改变变量的值，还可以改变其数据类型，同时保持不可变性：

\`\`\`rust
let spaces = "   "; // &str 类型
let spaces = spaces.len(); // 转换为 usize 类型，同名变量遮蔽
\`\`\`
`
  },
  {
    slug: 'rust-data-types-scalars-and-compounds',
    title: 'Rust 基础篇 (二)：标量与复合数据类型的底层内存布局',
    excerpt: '从 CPU 寄存器和栈帧角度剖析 Rust 的整型、浮点型、布尔型、字符型以及元组与数组的内存对齐与存储方式。',
    category: 'Rust',
    date: '2026-08-21',
    readTime: '9 min',
    author: 'Waitwalker',
    tags: ['Rust', '数据类型', '内存布局', '计算机底层'],
    content: `
## 1. 标量类型 (Scalar Types)

Rust 包含四种核心标量类型：
1. **整数型**：有符号 (\`i8\` ~ \`i128\`, \`isize\`) 与无符号 (\`u8\` ~ \`u128\`, \`usize\`)。
2. **浮点型**：\`f32\` (单精度) 与 \`f64\` (双精度，默认推荐)。
3. **布尔型**：\`bool\` 占用 1 个字节。
4. **字符型**：\`char\` 占用 4 个字节，代表一个 Unicode 标量值（支持 Emoji 与汉字）。

## 2. 复合类型 (Compound Types)

### 元组 (Tuple)
元组长度固定，可容纳多种不同类型的值：
\`\`\`rust
let tup: (i32, f64, u8) = (500, 6.4, 1);
let (x, y, z) = tup; // 解构
println!("y 的值为: {}", tup.1);
\`\`\`

### 数组 (Array)
数组分配在栈（Stack）上，长度在编译期确定且必须包含同类型元素：
\`\`\`rust
let a: [i32; 5] = [1, 2, 3, 4, 5];
let b = [3; 5]; // 等价于 [3, 3, 3, 3, 3]
\`\`\`
`
  },
  {
    slug: 'rust-functions-and-expressions',
    title: 'Rust 基础篇 (三)：语句 vs 表达式——函数式设计精髓',
    excerpt: '理解 Rust 是一门“基于表达式”的语言。深入解析分号的魔力、隐式返回以及如何编写高内聚的局部代码块。',
    category: 'Rust',
    date: '2026-08-22',
    readTime: '7 min',
    author: 'Waitwalker',
    tags: ['Rust', '函数式编程', '控制流', '语法精要'],
    content: `
## 1. 语句 (Statements) 与 表达式 (Expressions)

- **语句**：执行操作但不返回值的指令（以分号 \`;\` 结尾）。
- **表达式**：计算并产生一个值的代码片段（无结尾分号）。

\`\`\`rust
fn calculate(x: i32) -> i32 {
    let y = {
        let temp = x * 2;
        temp + 1 // 表达式，注意末尾没有分号！
    };
    y * 3 // 隐式返回整个函数的结果
}
\`\`\`

如果给最后一行的 \`y * 3\` 加上分号，它将变成一条语句，返回值会隐式退化为单例单元类型 \`()\`，从而触发编译器类型不匹配报错。
`
  },
  {
    slug: 'rust-control-flow-loops-and-if',
    title: 'Rust 基础篇 (四)：控制流艺术——if 表达式与带标签的 loop 循环',
    excerpt: '探究 if 作为表达式的赋值技巧，掌握 loop 的返回值特性，以及在多层嵌套循环中使用生命周期标签精准 break。',
    category: 'Rust',
    date: '2026-08-22',
    readTime: '8 min',
    author: 'Waitwalker',
    tags: ['Rust', '控制流', '循环', '模式设计'],
    content: `
## 1. if 作为表达式使用

在 Rust 中，\`if\` 是一个表达式，可以直接用于变量初始化（类似其他语言的三元运算符）：

\`\`\`rust
let condition = true;
let number = if condition { 5 } else { 6 };
\`\`\`

## 2. loop 循环带返回值与循环标签

\`loop\` 循环可以通过 \`break\` 语句携带返回值，在重试网络连接或等待任务时极其优雅：

\`\`\`rust
let mut counter = 0;
let result = loop {
    counter += 1;
    if counter == 10 {
        break counter * 2;
    }
};

// 循环标签 (Loop Labels)
'outer: loop {
    'inner: loop {
        break 'outer; // 直接跳出外层循环
    }
}
\`\`\`
`
  },
  {
    slug: 'rust-ownership-and-stack-heap',
    title: 'Rust 核心篇 (五)：所有权模型 (Ownership) 与堆栈内存管理',
    excerpt: 'Rust 最震撼人心的核心设计——零 GC 实现内存安全。深入剖析所有权三定律、移动语义 (Move) 与 Drop 析构时机。',
    category: 'Rust',
    date: '2026-08-23',
    readTime: '14 min',
    author: 'Waitwalker',
    tags: ['Rust', '所有权', '内存模型', '核心架构'],
    content: `
## 1. 所有权三定律

1. Rust 中每一个值都有一个被称为其 **所有者 (Owner)** 的变量。
2. 值在任一时刻 **有且只有一个** 所有者。
3. 当所有者离开作用域时，这个值将被 **自动丢弃 (Drop)** 并释放对应的堆内存。

\`\`\`rust
fn main() {
    let s1 = String::from("hello"); // s1 申请堆内存
    let s2 = s1; // 所有权转移 (Move)，s1 失效！

    // println!("{}", s1); // 编译报错：borrow of moved value: \`s1\`
    println!("{}", s2); // 正常打印
} // s2 离开作用域，自动调用 drop 释放堆空间
\`\`\`

## 2. 为什么是 Move 而不是浅拷贝？

如果允许 \`s1\` 和 \`s2\` 同时指向同一片堆内存，当二者离开作用域时会触发 **双重释放 (Double Free)**，造成严重的内存安全隐患。因此 Rust 强制通过 Move 语义使得旧变量立刻失效。
`
  },
  {
    slug: 'rust-references-and-borrowing-rules',
    title: 'Rust 核心篇 (六)：引用、借用检查器与数据竞争防范',
    excerpt: '详解不可变引用 (&T) 与可变引用 (&mut T)。借用检查器如何在编译期彻底扑灭悬垂指针与多线程竞态条件。',
    category: 'Rust',
    date: '2026-08-23',
    readTime: '11 min',
    author: 'Waitwalker',
    tags: ['Rust', '借用检查', '引用', '并发安全'],
    content: `
## 1. 借用黄金法则 (The Rules of References)

在任何给定的时间，对于同一块数据：
- 要么只能有 **一个可变引用** (\`&mut T\`)；
- 要么可以有 **任意多个不可变引用** (\`&T\`)；
- **引用必须总是有效的**（编译器严禁悬垂引用 Dangling Reference）。

\`\`\`rust
fn main() {
    let mut s = String::from("hello");

    let r1 = &s; // 不可变借用
    let r2 = &s; // 不可变借用
    println!("{} and {}", r1, r2);
    // r1, r2 作用域在此结束 (NLL: Non-Lexical Lifetimes)

    let r3 = &mut s; // 可变借用，安全！
    r3.push_str(", world");
}
\`\`\`
`
  },
  {
    slug: 'rust-slices-and-zero-copy-views',
    title: 'Rust 基础篇 (七)：切片类型 (Slice) 与零拷贝内存视图',
    excerpt: '深入理解字符串切片 (&str) 与数组切片 (&[T])，如何通过胖指针 (Fat Pointer) 高效安全地操作子序列数据。',
    category: 'Rust',
    date: '2026-08-24',
    readTime: '9 min',
    author: 'Waitwalker',
    tags: ['Rust', '切片', '零拷贝', '性能调优'],
    content: `
## 1. 什么是切片？

切片是没有所有权的数据类型，它引用集合中一段连续的元素序列。在底层，切片是一个 **胖指针 (Fat Pointer)**，包含：
1. 指向数据首地址的裸指针。
2. 切片的长度 (Length)。

\`\`\`rust
fn first_word(s: &str) -> &str {
    let bytes = s.as_bytes();
    for (i, &item) in bytes.iter().enumerate() {
        if item == b' ' {
            return &s[0..i]; // 零拷贝切片视图
        }
    }
    &s[..]
}
\`\`\`

## 2. 字符串字面量的本质

所有的字符串字面量（如 \`let s = "Hello";\`）其类型都是 \`&str\`，直接指向编译产物二进制中的只读数据段，完全不需要在堆上开辟内存。
`
  },
  {
    slug: 'rust-structs-and-memory-layout',
    title: 'Rust 基础篇 (八)：结构体定义、方法实现与内存对齐',
    excerpt: '掌握经典结构体、元组结构体与单元结构体，理解 impl 块中 self、&self 与 &mut self 的方法接收器语义。',
    category: 'Rust',
    date: '2026-08-24',
    readTime: '10 min',
    author: 'Waitwalker',
    tags: ['Rust', '面向对象', '结构体', '架构设计'],
    content: `
## 1. 结构体定义与方法

\`\`\`rust
#[derive(Debug)]
struct Rectangle {
    width: u32,
    height: u32,
}

impl Rectangle {
    // 关联函数（类似静态构造器）
    fn square(size: u32) -> Self {
        Self { width: size, height: size }
    }

    // 不可变借用方法
    fn area(&self) -> u32 {
        self.width * self.height
    }

    // 可变借用方法
    fn scale(&mut self, factor: u32) {
        self.width *= factor;
        self.height *= factor;
    }
}
\`\`\`
`
  },
  {
    slug: 'rust-enums-option-and-pattern-matching',
    title: 'Rust 基础篇 (九)：枚举与模式匹配——消灭 Null 指针的设计哲学',
    excerpt: '为什么说 Rust 没有 null？深入解析 Option<T> 与 Result<T, E>，掌握 match 穷尽性检查与 if let 语法糖。',
    category: 'Rust',
    date: '2026-08-25',
    readTime: '11 min',
    author: 'Waitwalker',
    tags: ['Rust', '枚举', '模式匹配', '类型系统'],
    content: `
## 1. 极其强大的带数据枚举

Rust 的枚举不仅是数字标记，还可以携带任意类型的数据（类似于代数数据类型 ADT）：

\`\`\`rust
enum Message {
    Quit,
    Move { x: i32, y: i32 },
    Write(String),
    ChangeColor(i32, i32, i32),
}
\`\`\`

## 2. Option<T> 替代 Null

通过标准库的 \`Option<T>\`，编译器强制开发者在编译期显式处理为空的分支，彻底杜绝生产环境的 NullPointerException：

\`\`\`rust
fn plus_one(x: Option<i32>) -> Option<i32> {
    match x {
        None => None,
        Some(i) => Some(i + 1),
    }
}
\`\`\`
`
  },
  {
    slug: 'rust-modules-crates-and-workspaces',
    title: 'Rust 工程篇 (十)：模块系统、Crate 与大型 Workspace 组织架构',
    excerpt: '如何在大规模 Rust 团队项目中划分 mod、控制 pub(crate) 可见性、管理 Cargo.toml 依赖并搭建多包 Monorepo。',
    category: 'Rust',
    date: '2026-08-25',
    readTime: '12 min',
    author: 'Waitwalker',
    tags: ['Rust', '工程架构', 'Cargo', '模块系统'],
    content: `
## 1. 模块树与可见性控制

Rust 默认一切都是私有的，需要通过 \`pub\` 明确暴露接口：
- \`pub\`: 全局公开。
- \`pub(crate)\`: 仅在当前 Crate 内可见。
- \`pub(super)\`: 仅父级模块可见。

## 2. Cargo Workspace 配置多模块

\`\`\`toml
# 根目录 Cargo.toml
[workspace]
members = [
    "crates/core",
    "crates/network",
    "crates/server"
]
\`\`\`
`
  },
  {
    slug: 'rust-collections-vector-string-hashmap',
    title: 'Rust 基础篇 (十一)：核心集合深入——Vec、String 与 HashMap 的底层原理',
    excerpt: '探究动态数组的翻倍扩容策略、String 的 UTF-8 变长字节切片限制，以及 HashMap 的 SipHash 抗哈希碰撞攻击机制。',
    category: 'Rust',
    date: '2026-08-26',
    readTime: '13 min',
    author: 'Waitwalker',
    tags: ['Rust', '数据结构', 'HashMap', '底层原理'],
    content: `
## 1. Vec<T> 的内存模型

\`Vec<T>\` 在栈上维护三元组：\`(pointer, capacity, length)\`。当 \`len == cap\` 时，添加元素会触发堆内存重新分配（通常翻倍），并将旧数据拷贝至新地址。

## 2. HashMap 与 Entry API

使用 \`entry\` API 可以避免重复哈希计算，实现极简的词频统计：

\`\`\`rust
use std::collections::HashMap;

let text = "hello world wonderful world";
let mut map = HashMap::new();

for word in text.split_whitespace() {
    let count = map.entry(word).or_insert(0);
    *count += 1;
}
\`\`\`
`
  },
  {
    slug: 'rust-error-handling-result-and-panic',
    title: 'Rust 基础篇 (十二)：错误处理哲学——可恢复 Result 与不可恢复 Panic',
    excerpt: '掌握 ? 操作符链式传播、自定义 Error 类型、thiserror 与 anyhow 库在工程中的选型与实战策略。',
    category: 'Rust',
    date: '2026-08-26',
    readTime: '10 min',
    author: 'Waitwalker',
    tags: ['Rust', '错误处理', 'thiserror', '稳定性'],
    content: `
## 1. 问号操作符 (?) 的解包与自动转换

\`?\` 操作符用于简化错误传播。当遇到 \`Err\` 时提前返回，并自动调用 \`From::from\` 进行错误类型转换：

\`\`\`rust
use std::fs::File;
use std::io::{self, Read};

fn read_username_from_file() -> Result<String, io::Error> {
    let mut s = String::new();
    File::open("hello.txt")?.read_to_string(&mut s)?;
    Ok(s)
}
\`\`\`
`
  },
  {
    slug: 'rust-generics-and-monomorphization',
    title: 'Rust 基础篇 (十三)：泛型抽象与编译期单态化 (Monomorphization)',
    excerpt: 'Rust 如何在提供高级泛型抽象的同时保持 C++ 级的运行期极速性能？深入解析单态化生成特化代码的底层机制与代码膨胀权衡。',
    category: 'Rust',
    date: '2026-08-27',
    readTime: '9 min',
    author: 'Waitwalker',
    tags: ['Rust', '泛型', '单态化', '性能优化'],
    content: `
## 1. 泛型函数与结构体

\`\`\`rust
struct Point<T> {
    x: T,
    y: T,
}

impl<T> Point<T> {
    fn x(&self) -> &T {
        &self.x
    }
}
\`\`\`

## 2. 零运行时开销 (Zero-Cost Abstractions)

Rust 编译器在编译期会将泛型代码替换为针对具体类型的具体实现（单态化）。例如 \`Point<i32>\` 和 \`Point<f64>\` 会生成两份独立的高效汇编，完全没有虚函数表指针跳转或装箱拆箱开销。
`
  },
  {
    slug: 'rust-traits-and-abstract-behavior',
    title: 'Rust 核心篇 (十四)：Trait 特征系统——定义共享行为与孤儿规则',
    excerpt: '对比面向对象接口，掌握 Trait Bound 约束、where 从句、默认实现以及为何必须遵循 Orphan Rule 保证生态安全。',
    category: 'Rust',
    date: '2026-08-27',
    readTime: '12 min',
    author: 'Waitwalker',
    tags: ['Rust', 'Trait', '抽象设计', '接口'],
    content: `
## 1. Trait 的定义与实现

\`\`\`rust
pub trait Summary {
    fn summarize(&self) -> String {
        String::from("(Read more...)") // 默认实现
    }
}

pub struct NewsArticle {
    pub headline: String,
}

impl Summary for NewsArticle {
    fn summarize(&self) -> String {
        format!("{}", self.headline)
    }
}
\`\`\`

## 2. 孤儿规则 (Orphan Rule)

你只能在下列条件之一满足时为某个类型实现某个 Trait：
1. 该 Trait 定义在当前 Crate 中。
2. 该类型定义在当前 Crate 中。

这从根源上阻止了第三方库意外覆盖标准库或破坏其他库行为的可能。
`
  },
  {
    slug: 'rust-lifetimes-and-borrow-checker',
    title: 'Rust 进阶篇 (十五)：生命周期的本质——借用检查器的编译期标定',
    excerpt: '生命周期标注并非改变变量的实际存活时间，而是帮助编译器校验引用之间的有效性。深入解析生命周期省略规则与静态生命周期。',
    category: 'Rust',
    date: '2026-08-28',
    readTime: '15 min',
    author: 'Waitwalker',
    tags: ['Rust', '生命周期', '静态检查', '高阶技巧'],
    content: `
## 1. 为什么需要生命周期标注？

当函数返回引用时，编译器必须知道返回的引用到底是绑定在哪个入参的生命周期上，以防返回已销毁的局部变量引用：

\`\`\`rust
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}
\`\`\`

这里 \`'a\` 表示返回值的生命周期与 \`x\` 和 \`y\` 中生命周期较短的那一个完全一致。
`
  },
  {
    slug: 'rust-closures-and-fn-traits',
    title: 'Rust 进阶篇 (十六)：闭包机制——Fn、FnMut 与 FnOnce 底层捕获行为',
    excerpt: '深入理解闭包的环境捕获（不可变借用、可变借用与 move 所有权获取），探究三大 Fn Trait 的自动推导与闭包作为函数参数。',
    category: 'Rust',
    date: '2026-08-28',
    readTime: '11 min',
    author: 'Waitwalker',
    tags: ['Rust', '闭包', '函数式', '高阶函数'],
    content: `
## 1. 闭包的三种捕获模式

- **FnOnce**：消耗捕获的变量（通过移动所有权），只能被调用一次。
- **FnMut**：可以修改捕获的变量值。
- **Fn**：仅不可变借用外部环境变量。

\`\`\`rust
let list = vec![1, 2, 3];
// move 关键字强制闭包获取 list 的所有权（常用于跨线程传递）
let takes_ownership = move || println!("{:?}", list);
takes_ownership();
\`\`\`
`
  },
  {
    slug: 'rust-iterators-and-lazy-evaluation',
    title: 'Rust 进阶篇 (十七)：迭代器与惰性求值——比传统循环更快的现代抽象',
    excerpt: '剖析 map、filter、fold 等组合子，理解 Rust 编译器如何将链式迭代器激进优化为无边界检查的向量化汇编代码。',
    category: 'Rust',
    date: '2026-08-29',
    readTime: '10 min',
    author: 'Waitwalker',
    tags: ['Rust', '迭代器', '高性能', '现代语法'],
    content: `
## 1. 迭代器的惰性特性 (Lazy Evaluation)

在调用消费型适配器（如 \`collect()\`、\`sum()\`）之前，迭代器适配链条不会执行任何实际计算：

\`\`\`rust
let v1: Vec<i32> = vec![1, 2, 3];
let v2: Vec<_> = v1.iter().map(|x| x + 1).filter(|x| x % 2 == 0).collect();
\`\`\`

## 2. 零成本性能测试

在基准测试中，Rust 的迭代器往往比手动编写的 \`for i in 0..len\` 循环更快，因为编译器能够推导出索引安全从而完全省略循环体内部的边界检查（Bounds Check）。
`
  },
  {
    slug: 'rust-smart-pointers-box-rc-arc-refcell',
    title: 'Rust 核心篇 (十八)：智能指针全解——Box、Rc、Arc 与 RefCell 内部可变性',
    excerpt: '构建复杂图结构与树结构必备。掌握堆分配 Box、单线程引用计数 Rc、跨线程 Arc 以及打破借用规则的 RefCell 运行时检查。',
    category: 'Rust',
    date: '2026-08-29',
    readTime: '16 min',
    author: 'Waitwalker',
    tags: ['Rust', '智能指针', '内部可变性', '内存管理'],
    content: `
## 1. 智能指针家族概览

| 智能指针 | 内存位置 | 所有权 | 线程安全 | 检查时机 |
| :--- | :--- | :--- | :--- | :--- |
| \`Box<T>\` | 堆 | 唯一所有者 | 取决于 T | 编译期 |
| \`Rc<T>\` | 堆 | 共享所有权 | 否 (单线程) | 编译期 |
| \`Arc<T>\` | 堆 | 共享所有权 | 是 (原子操作) | 编译期 |
| \`RefCell<T>\` | 栈/堆 | 配合包装使用 | 否 | 运行期 |

\`\`\`rust
use std::rc::Rc;
use std::cell::RefCell;

// 共享且可变的数据节点
let value = Rc::new(RefCell::new(42));
let a = Rc::clone(&value);
*a.borrow_mut() += 10;
println!("当前值: {}", value.borrow());
\`\`\`
`
  },
  {
    slug: 'rust-concurrency-threads-and-channels',
    title: 'Rust 并发篇 (十九)：无畏并发 (Fearless Concurrency) 与消息传递',
    excerpt: '基于 CSP 模型的 MPSC 消息通道通信，探讨 Send 与 Sync 特征如何从类型系统层面防止数据在线程间非法传递。',
    category: 'Rust',
    date: '2026-08-29',
    readTime: '12 min',
    author: 'Waitwalker',
    tags: ['Rust', '并发', '多线程', 'MPSC'],
    content: `
## 1. 多生产者单消费者 (MPSC) 通道

“不要通过共享内存来通信，而要通过通信来共享内存”：

\`\`\`rust
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

fn main() {
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let val = String::from("hello from worker");
        tx.send(val).unwrap();
    });

    let received = rx.recv().unwrap();
    println!("主线程收到消息: {}", received);
}
\`\`\`
`
  },
  {
    slug: 'rust-shared-state-concurrency-mutex',
    title: 'Rust 并发篇 (二十)：共享状态并发——Arc 与 Mutex 组合拳实战',
    excerpt: '如何在多线程环境下安全共享可变状态？详解互斥锁 Mutex 与读写锁 RwLock 的死锁预防及内存屏障机制。',
    category: 'Rust',
    date: '2026-08-29',
    readTime: '13 min',
    author: 'Waitwalker',
    tags: ['Rust', '并发', 'Mutex', 'Arc', '高性能'],
    content: `
## 1. Arc<Mutex<T>> 黄金拍档

在多线程中修改计数器：

\`\`\`rust
use std::sync::{Arc, Mutex};
use std::thread;

fn main() {
    let counter = Arc::new(Mutex::new(0));
    let mut handles = vec![];

    for _ in 0..10 {
        let counter_clone = Arc::clone(&counter);
        let handle = thread::spawn(move || {
            let mut num = counter_clone.lock().unwrap();
            *num += 1;
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }

    println!("最终计数值: {}", *counter.lock().unwrap());
}
\`\`\`
`
  }
,
{
  "slug": "nextjs-dynamic-og-image-generation",
  "title": "Next.js 15 动态 OpenGraph 社交图生成：Satori 引擎、@vercel/og 与 Edge 渲染管线",
  "excerpt": "深入探究 @vercel/og 底层原理：从 JSX 到 Yoga 弹性盒布局、Satori SVG 矢量转换与 Resvg PNG 栅格化流水线。",
  "category": "Next.js",
  "date": "2026-08-20",
  "readTime": "16 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "OpenGraph",
    "Satori",
    "Edge Runtime",
    "性能优化"
  ],
  "content": "\n## 1. 动态 OpenGraph 渲染流水线全景解密\n\n在现代 Web 应用中，动态生成包含标题、作者与品牌视觉的社交卡片能够显著提升点击率。`@vercel/og` 依托 Satori 引擎与 Resvg，将 JSX 声明式 UI 在 Edge Runtime 毫秒级转换为高质量 PNG。\n\n```tsx\nimport { ImageResponse } from 'next/og';\nexport const runtime = 'edge';\n\nexport default async function Image() {\n  return new ImageResponse(\n    <div style={{ display: 'flex', background: '#090d16', color: '#fff', padding: 40 }}>\n      <h1>MonsterAI 动态分享图</h1>\n    </div>,\n    { width: 1200, height: 630 }\n  );\n}\n```\n"
},
{
  "slug": "nextjs-webassembly-high-performance-compute",
  "title": "Next.js 15 与 WebAssembly (Wasm) 深度整合：Rust 密集算力迁移与边缘协同",
  "excerpt": "解密 WebAssembly 在 Next.js 15 中的编译与加载流水线：wasm-pack 构建、Turbopack 异步引入与浏览器/Edge 双端算力加速。",
  "category": "Next.js",
  "date": "2026-08-20",
  "readTime": "18 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "WebAssembly",
    "Rust",
    "Wasm",
    "高性能计算"
  ],
  "content": "\n## 1. WebAssembly 线性内存与零拷贝调用\n\n将 Rust 密集计算（如加密、图像滤波与仿真）编译为 Wasm，结合 Next.js 15 的异步 WebAssembly 模块加载，打破 JavaScript 事件循环算力天花板。\n\n```rust\n#[wasm_bindgen]\npub fn process_pixels(buffer: &mut [u8]) {\n    // 底层 CPU 指令级并行加速计算\n}\n```\n"
},
{
  "slug": "nextjs-progressive-web-app-offline-workbox",
  "title": "Next.js 15 渐进式 Web 应用 (PWA)：Workbox 离线缓存、Serwist 与 Service Worker 生命周期",
  "excerpt": "构建离线可用原生级 Web 体验：Service Worker 注册流水线、Workbox 运行时缓存策略（Stale-While-Revalidate vs Cache-First）与后台同步。",
  "category": "Next.js",
  "date": "2026-08-21",
  "readTime": "15 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "PWA",
    "Workbox",
    "Service Worker",
    "离线优先"
  ],
  "content": "\n## 1. 现代 PWA 与 Serwist 架构\n\n淘汰年久失修的旧插件，采用 Serwist 深度适配 Next.js 15 App Router。通过静态预缓存清册与动态分级运行时缓存，实现断网环境下无缝阅读与秒级加载。\n"
},
{
  "slug": "nextjs-turbopack-bundler-deep-dive",
  "title": "Turbopack 深度构建调优：Rust 增量计算引擎、SWC 转换与模块图拓扑",
  "excerpt": "下一代打包器底层揭秘：Turbo 增量计算缓存图 (Turbo Engine)、SWC AST 转换流水线与毫秒级 HMR 热更新原理。",
  "category": "Next.js",
  "date": "2026-08-21",
  "readTime": "17 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "Turbopack",
    "Rust",
    "SWC",
    "构建调优"
  ],
  "content": "\n## 1. Turbo Engine 增量函数计算图\n\nTurbopack 将所有编译过程建模为纯函数 `f(Input) -> Output`，建立有向无环图（DAG）。代码修改时仅让受影响的微量函数缓存失效，实现 < 10ms 的极致 HMR。\n"
},
{
  "slug": "nextjs-microfrontends-and-module-federation",
  "title": "Next.js 现代化微前端架构：Multi-Zones 拓扑拆分、Module Federation 与跨应用状态",
  "excerpt": "拆解大型前端单体应用：Next.js Multi-Zones 独立部署与 URL 重写网关，结合 Module Federation 2.0 实现运行时组件共享。",
  "category": "Next.js",
  "date": "2026-08-22",
  "readTime": "19 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "微前端",
    "Multi-Zones",
    "Module Federation",
    "系统架构"
  ],
  "content": "\n## 1. Multi-Zones 多区域架构\n\n将巨石应用拆分为独立部署的多个 Next.js 实例，通过 Caddy/Nginx 统一路由反向代理，实现 100% 的团队独立构建与故障物理隔离。\n"
},
{
  "slug": "nextjs-auth-patterns-and-session-management",
  "title": "Next.js 现代身份认证全景：Iron-session 无状态加密 Cookie、JWT 与严格服务端鉴权",
  "excerpt": "安全第一的身份验证架构：无状态封印 Cookie (Sealed Cookies)、JWT 双令牌轮换 (Access + Refresh Token) 与 Server Action 鉴权校验。",
  "category": "Next.js",
  "date": "2026-08-22",
  "readTime": "18 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "身份认证",
    "JWT",
    "Iron-session",
    "安全架构"
  ],
  "content": "\n## 1. 无状态密封 Cookie 架构\n\n摒弃在 localStorage 中暴露明文 Token 的危险做法，利用 iron-session 将会话以 AES-256-GCM 强加密存入 httpOnly Cookie，彻底免疫 XSS 窃取。\n"
},
{
  "slug": "nextjs-seo-architecture-and-metadata-api",
  "title": "Next.js 15 企业级 SEO 体系：Metadata API、动态 Sitemap、Robots 与 JSON-LD 结构化数据",
  "excerpt": "从爬虫友好到搜索引擎顶级权重：深入 Metadata 对象继承树、generateMetadata 并发解析与 Schema.org 结构化数据自动化注入。",
  "category": "Next.js",
  "date": "2026-08-23",
  "readTime": "15 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "SEO",
    "Metadata",
    "Sitemap",
    "结构化数据"
  ],
  "content": "\n## 1. Metadata 树状继承与动态计算\n\n通过 App Router 顶层约定文件 `sitemap.ts` 与 `robots.ts`，配合 `generateMetadata` 和 JSON-LD，全面提升搜索引擎收录与富文本展示效果。\n"
},
{
  "slug": "nextjs-internationalization-routing-patterns",
  "title": "Next.js 15 无痛国际化 (i18n) 实践：子路径路由、字典按需懒加载与 RTL 双向排版",
  "excerpt": "打造全球化多语言站点：App Router 国际化动态段 [lang]、请求级字典懒加载、类型安全翻译键与多语言 SEO hreflang 声明。",
  "category": "Next.js",
  "date": "2026-08-23",
  "readTime": "16 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "i18n",
    "多语言",
    "App Router",
    "国际化"
  ],
  "content": "\n## 1. [lang] 动态路由段与中间件协商\n\n利用服务端动态 import 字典，客户端零打包体积增加；配合 CSS 逻辑属性（ms/me/start/end），完美适配阿拉伯语等 RTL 自右向左书写系统。\n"
},
{
  "slug": "nextjs-form-validation-zod-react-hook-form",
  "title": "Next.js 15 全栈表单验证体系：React Hook Form、Zod 模式验证与 Server Action 联动",
  "excerpt": "打造零冗余类型安全表单：Zod Schema 双端复用、客户端即时交互反馈、useActionState 状态同步与后端防御性数据拦截。",
  "category": "Next.js",
  "date": "2026-08-24",
  "readTime": "16 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "Zod",
    "React Hook Form",
    "表单验证",
    "TypeScript"
  ],
  "content": "\n## 1. Zod 双端统一验证架构\n\n单一 Schema 定义，客户端 React Hook Form 非受控绑定实现零无用重渲染，服务端 Server Action safeParse 终极拦截防御非法注入。\n"
},
{
  "slug": "nextjs-database-integration-drizzle-orm",
  "title": "Next.js 15 现代化数据库持久层：Drizzle ORM 类型安全查询、连接池管理与 Edge 兼容",
  "excerpt": "轻量零开销 SQL 优先方案：Drizzle ORM Schema 声明式设计、Postgres/MySQL 驱动连接池配置、Server Component 直连查库与迁移自动化。",
  "category": "Next.js",
  "date": "2026-08-24",
  "readTime": "17 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "Drizzle ORM",
    "PostgreSQL",
    "数据库",
    "类型安全"
  ],
  "content": "\n## 1. 极轻量纯 TypeScript ORM\n\n零 Rust 二进制引擎负担，冷启动 < 2ms，支持在 Serverless 与 Edge 原生运行。Server Components 直连查库彻底消除额外网络往返。\n"
},
{
  "slug": "nextjs-security-hardening-csp-headers",
  "title": "Next.js 生产环境安全加固：严格内容安全策略 (CSP)、Nonce 动态注入与安全标头",
  "excerpt": "构筑坚如磐石的防御屏障：在 App Router 中通过中间件生成随机 Nonce、严格 Content-Security-Policy 拦截 XSS、HSTS 与 CORS 配置。",
  "category": "Next.js",
  "date": "2026-08-25",
  "readTime": "18 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "Web安全",
    "CSP",
    "Nonce",
    "生产加固"
  ],
  "content": "\n## 1. 动态 Nonce 严格 CSP 防线\n\n中间件逐请求生成高熵随机 Nonce 并注入响应标头，React 服务端组件自动绑定内联脚本，物理拦截所有未经授权的恶意脚本执行。\n"
},
{
  "slug": "nextjs-realtime-sse-and-websocket-patterns",
  "title": "Next.js 15 实时通信全解：Server-Sent Events (SSE) 流式传输与外部 WebSocket 解耦架构",
  "excerpt": "构建现代低延迟实时应用：Route Handlers 实现标准 HTTP/2 SSE 单向流、结合外部长连接网关（Rust/Go）实现百万级高并发实时中枢。",
  "category": "Next.js",
  "date": "2026-08-25",
  "readTime": "17 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "实时通信",
    "SSE",
    "WebSocket",
    "高并发"
  ],
  "content": "\n## 1. SSE 流式响应与长连接解耦\n\n在 Route Handler 中利用 ReadableStream 输出高效 SSE 单向流，外部独立 Rust 网关承载高并发双向 WebSocket，职责单一且互不干扰。\n"
},
{
  "slug": "nextjs-animation-framer-motion-gsap",
  "title": "Next.js 15 顶级交互动效工程：Framer Motion、GSAP 与 App Router 页面转场协同",
  "excerpt": "打造丝滑 60/120 FPS 视觉体验：React 19 下的动画生命周期、Framer Motion 布局动画 (layoutId)、GSAP ScrollTrigger 与路由平滑转场。",
  "category": "Next.js",
  "date": "2026-08-26",
  "readTime": "16 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "Framer Motion",
    "GSAP",
    "动效工程",
    "用户体验"
  ],
  "content": "\n## 1. 现代动效引擎协同\n\n利用 template.tsx 解决 App Router 路由退出动画时序问题，借助 Framer Motion FLIP layoutId 与 GSAP ScrollTrigger 打造殿堂级视觉质感。\n"
},
{
  "slug": "nextjs-file-upload-s3-and-presigned-urls",
  "title": "Next.js 15 云端大文件直传架构：S3 / R2 预签名 URL、分片断点续传与元数据流",
  "excerpt": "彻底规避 Node.js 服务端带宽瓶颈：Route Handler 生成 Presigned Upload URLs、客户端直传云存储、分片断点续传与防篡改回调。",
  "category": "Next.js",
  "date": "2026-08-26",
  "readTime": "17 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "文件直传",
    "AWS S3",
    "Cloudflare R2",
    "存储架构"
  ],
  "content": "\n## 1. 预签名直传架构\n\n通过 Route Handler 签发 15 分钟临时凭据，客户端通过 XMLHttpRequest 直传 S3/R2，实现零服务端带宽消耗与 Multipart 分片断点续传。\n"
},
{
  "slug": "nextjs-monitoring-opentelemetry-observability",
  "title": "Next.js 15 全栈可观测性：OpenTelemetry 链路追踪、Sentry 异常捕获与 Prometheus 指标中枢",
  "excerpt": "生产级性能监控与故障定位：配置 OpenTelemetry SDK、分布式 Trace ID 全链路透传、Core Web Vitals 自动化上报与日志告警。",
  "category": "Next.js",
  "date": "2026-08-27",
  "readTime": "18 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "OpenTelemetry",
    "可观测性",
    "Sentry",
    "APM"
  ],
  "content": "\n## 1. 全栈立体可观测性\n\n利用 Next.js 15 内置 instrumentation.ts 挂载 OpenTelemetry Node SDK，结合 Sentry 异常录屏与 Prometheus 性能指标大盘，彻底终结黑盒运维。\n"
},

{
  "slug": "nextjs-app-router-mental-model",
  "title": "Next.js 15 App Router 核心心智模型：路由段、嵌套布局与插槽机制",
  "excerpt": "彻底告别 Pages Router：深入理解 page.js, layout.js, template.js, loading.js 与 error.js 的文件契约系统。",
  "category": "Next.js",
  "date": "2026-08-27",
  "readTime": "16 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "App Router",
    "React 19",
    "前端架构"
  ],
  "content": "\n## 1. App Router 文件契约层级\n\nApp Router 采用基于文件系统的直观层次结构：\n```\napp/\n ├── layout.tsx     ── 共享外壳 (不会因路由切换重新挂载)\n ├── template.tsx   ── 模板外壳 (每次导航均创建新实例，触发动画)\n ├── loading.tsx    ── 基于 Suspense 的即时骨架屏\n ├── error.tsx      ── 基于 ErrorBoundary 的局部错误捕获\n └── page.tsx       ── 页面实际内容\n```\n"
},
{
  "slug": "react-server-components-deep-dive",
  "title": "React Server Components (RSC) 深度解密：客户端 vs 服务端组件边界",
  "excerpt": "为什么 RSC 是 React 十年最重要变革？剖析服务端直接读库、零 Client Bundle 体积与 use client 边界划分黄金法则。",
  "category": "Next.js",
  "date": "2026-08-28",
  "readTime": "18 min",
  "author": "Waitwalker",
  "tags": [
    "React 19",
    "RSC",
    "Next.js",
    "性能革命"
  ],
  "content": "\n## 1. RSC 的本质优势\n\n- **零客户端 JS 体积 (Zero Bundle Size)**：服务端组件仅在服务端运行，其引用的所有重型依赖（如 Markdown 解析器、日期库）完全不会打包进客户端 JS！\n- **直接访问后端资源**：无需再写 `useEffect + fetch`，在组件内直接 `await db.query()` 即可拿到数据。\n\n```tsx\n// 服务端组件 (默认)\nexport default async function UserProfile({ id }: { id: string }) {\n  const user = await db.user.findUnique({ where: { id } });\n  return <ClientButton initialData={user} />;\n}\n```\n"
},
{
  "slug": "nextjs-server-actions-and-mutations",
  "title": "Next.js Server Actions 实战：零 API 路由实现全栈表单提交与数据变更",
  "excerpt": "告别冗余 API 胶水代码：使用 'use server' 指令直接在服务端执行函数，结合 useActionState 实现极致优雅的表单交互与验证。",
  "category": "Next.js",
  "date": "2026-08-28",
  "readTime": "14 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "Server Actions",
    "React 19",
    "全栈"
  ],
  "content": "\n## 1. 极简 Server Action 范式\n\n```tsx\n// app/actions.ts\n'use server'\n\nimport { revalidatePath } from 'next/cache';\n\nexport async function createPost(formData: FormData) {\n  const title = formData.get('title') as string;\n  await db.post.create({ data: { title } });\n  revalidatePath('/posts'); // 触发数据缓存失效与即时刷新\n}\n```\n"
},
{
  "slug": "nextjs-streaming-and-suspense-rendering",
  "title": "流式渲染 (Streaming) 与 Suspense：秒级首屏与渐进式内容加载",
  "excerpt": "告别整页白屏等待！结合 React Suspense 与 HTTP 分块传输编码 (Chunked Transfer)，实现首屏毫秒级响应并流式推送慢速数据块。",
  "category": "Next.js",
  "date": "2026-08-28",
  "readTime": "13 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "Streaming",
    "Suspense",
    "首屏优化"
  ],
  "content": "\n## 1. 流式分块渲染\n\n通过 Suspense 边界隔离慢速数据请求，快速内容（导航栏、静态文本）立即上屏，慢速组件流式到达：\n\n```tsx\nexport default function Dashboard() {\n  return (\n    <div>\n      <FastHeader />\n      <Suspense fallback={<ChartSkeleton />}>\n        <SlowAnalyticsChart />\n      </Suspense>\n    </div>\n  );\n}\n```\n"
},
{
  "slug": "nextjs-rendering-strategies-ssg-ssr-isr",
  "title": "Next.js 四大渲染模式：Static Export、SSR、ISR 增量静态再生全对比",
  "excerpt": "系统性梳理 Static Export、Dynamic SSR、Incremental Static Regeneration (ISR) 与 Partial Prerendering (PPR) 的适用场景与缓存策略。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "15 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "ISR",
    "SSR",
    "SSG",
    "PPR"
  ],
  "content": "\n## 1. 四大渲染模式选型决策树\n\n| 渲染策略 | 渲染时机 | 客户端 JS | 适用场景 | 运维要求 |\n| :--- | :--- | :--- | :--- | :--- |\n| **Static Export (SSG)** | 构建期 (Build time) | 仅静态文件 | 博客、文档、营销落地页 | 任意极简 Web 容器 (Caddy/Nginx) |\n| **Dynamic (SSR)** | 请求期 (Request time) | 动态水合 | 强个性化、实时用户看板 | Node.js 运行时 / Serverless |\n| **ISR** | 定期后台重新生成 | 混合 | 内容更新频率适中的电商页面 | 需要持久缓存系统 |\n| **PPR (Partial Prerender)** | 静态壳 + 动态流 | 极致优化 | 现代化复杂全栈门户 | Next.js 15+ 试验性特性 |\n"
},
{
  "slug": "nextjs-route-handlers-rest-api",
  "title": "Next.js Route Handlers：在 App Router 中构建高性能 RESTful API 与 Webhooks",
  "excerpt": "使用标准的 Web Request / Response API 构建服务端接口：处理 CORS 跨域、Stream 流式数据响应与三方 Webhook 签名验证。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "12 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "Route Handlers",
    "REST API",
    "Webhooks"
  ],
  "content": "\n## 1. 标准 Route Handler 定义\n\n```typescript\n// app/api/chat/route.ts\nimport { NextResponse } from 'next/server';\n\nexport async function POST(request: Request) {\n  const body = await request.json();\n  return NextResponse.json({ message: \"Echo\", data: body });\n}\n```\n"
},
{
  "slug": "nextjs-parallel-and-intercepting-routes",
  "title": "Next.js 高级路由系统：并行路由 (@modal) 与拦截路由 ((.)) 实战复杂弹窗",
  "excerpt": "打造类似 Twitter/Instagram 的无刷新相册弹窗体验：URL 改变但保持背景页面状态、直接刷新 URL 渲染完整单页的高阶路由技巧。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "14 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "并行路由",
    "拦截路由",
    "UX体验"
  ],
  "content": "\n## 1. 拦截路由语法规则\n\n- `(.)`: 匹配同级路由段。\n- `(..)`: 匹配上一级路由段。\n- `(...)`: 从根目录拦截。\n"
},
{
  "slug": "nextjs-middleware-and-edge-runtime",
  "title": "Next.js Middleware 与 Edge Runtime：毫秒级多语言国际化与请求重定向",
  "excerpt": "在请求到达路由前极速拦截：利用 V8 隔离区 Edge Runtime 实现毫秒级 JWT 校验、A/B 分流测试与地理位置重定向。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "13 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "Middleware",
    "Edge Runtime",
    "国际化"
  ],
  "content": "\n## 1. Middleware 核心配置\n\n```typescript\n// middleware.ts\nimport { NextResponse } from 'next/server';\nimport type { NextRequest } from 'next/server';\n\nexport function middleware(request: NextRequest) {\n  const token = request.cookies.get('token')?.value;\n  if (!token && request.nextUrl.pathname.startsWith('/dashboard')) {\n    return NextResponse.redirect(new URL('/login', request.url));\n  }\n  return NextResponse.next();\n}\n\nexport const config = {\n  matcher: ['/dashboard/:path*'],\n};\n```\n"
},
{
  "slug": "nextjs-caching-and-revalidation-lifecycle",
  "title": "Next.js 15 缓存生命周期：Request Memoization, Data Cache 与 Full Route Cache",
  "excerpt": "深度理清 Next.js 四层缓存体系：探究 fetch 自动去重、tag 标签化精准重新验证 (revalidateTag) 与 Next.js 15 默认缓存变更。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "16 min",
  "author": "Waitwalker",
  "tags": [
    "Next.js",
    "缓存架构",
    "Data Cache",
    "性能优化"
  ],
  "content": "\n## 1. 四层缓存架构模型\n\n1. **Request Memoization (React)**：同一渲染树中重复的相同 fetch 调用自动去重，生命周期仅限单次渲染。\n2. **Data Cache (Next.js)**：跨请求、跨部署的持久化数据缓存。\n3. **Full Route Cache (Next.js)**：构建期或 ISR 生成的静态 HTML 与 RSC Payload。\n4. **Router Cache (Client)**：客户端浏览器内存中保存的路由段缓存。\n"
},
{
  "slug": "react-19-new-hooks-actions-use",
  "title": "React 19 新特性全景：useActionState, useOptimistic, use() 与 Actions 范式",
  "excerpt": "全面拥抱 React 19：告别繁琐的 isPending 状态维护，掌握异步 Actions、乐观更新 (Optimistic UI) 与 use() 挂起读取 Promise。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "15 min",
  "author": "Waitwalker",
  "tags": [
    "React 19",
    "Hooks",
    "useActionState",
    "乐观UI"
  ],
  "content": "\n## 1. useActionState 与 Actions\n\n```tsx\n'use client'\n\nimport { useActionState } from 'react';\nimport { updateNameAction } from './actions';\n\nexport function ProfileForm() {\n  const [state, formAction, isPending] = useActionState(updateNameAction, null);\n\n  return (\n    <form action={formAction}>\n      <input name=\"name\" />\n      <button type=\"submit\" disabled={isPending}>\n        {isPending ? \"更新中...\" : \"保存\"}\n      </button>\n      {state?.error && <p className=\"error\">{state.error}</p>}\n    </form>\n  );\n}\n```\n"
},
{
  "slug": "tailwind-css-v4-and-modern-styling",
  "title": "Tailwind CSS v4 现代化样式方案：CSS 原生变量驱动与原子化样式最佳实践",
  "excerpt": "无需 tailwind.config.js！探索基于 CSS @theme 指令与 Lightning CSS 高性能 Rust 引擎的全新 Tailwind v4 构建体验。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "12 min",
  "author": "Waitwalker",
  "tags": [
    "Tailwind CSS",
    "CSS",
    "原子化",
    "前端样式"
  ],
  "content": "\n## 1. Tailwind v4 的重大架构革新\n\n- **纯 CSS 配置**：使用 `@theme` 指令直接在 CSS 文件中扩展设计令牌（Colors, Fonts, Spacing），彻底抛弃繁重的 JavaScript 配置文件。\n- **Lightning CSS 驱动**：底层完全用 Rust 重写，构建与样式扫描速度提升 10 倍以上！\n"
},
{
  "slug": "frontend-typescript-advanced-type-system",
  "title": "现代前端 TypeScript 高级类型体操：条件类型、映射类型与模板字面量",
  "excerpt": "写出具备顶级类型推导的 SDK 与组件库：深入解析 infer 关键字、分布式条件类型、深度只读 DeepReadonly 与类型收窄技巧。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "14 min",
  "author": "Waitwalker",
  "tags": [
    "TypeScript",
    "类型系统",
    "类型体操",
    "泛型"
  ],
  "content": "\n## 1. infer 关键字与条件类型\n\n```typescript\n// 提取 Promise 返回类型的工具类型\ntype Awaited<T> = T extends Promise<infer U> ? Awaited<U> : T;\n\n// 提取函数第一个入参\ntype FirstParam<T> = T extends (first: infer P, ...args: any[]) => any ? P : never;\n```\n"
},
{
  "slug": "frontend-state-management-zustand-vs-jotai",
  "title": "现代前端状态管理之争：Zustand (集中式原子) vs Jotai (分散式原子) 深度对比",
  "excerpt": "告别 Redux 冗长样板代码！对比两种现代状态管理流派的渲染性能、异步数据流处理与 SSR 同构水合最佳实践。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "13 min",
  "author": "Waitwalker",
  "tags": [
    "Zustand",
    "Jotai",
    "状态管理",
    "React"
  ],
  "content": "\n## 1. Zustand 极简 Hook 模式\n\n```typescript\nimport { create } from 'zustand';\n\ninterface BearState {\n  bears: number;\n  increase: () => void;\n}\n\nexport const useBearStore = create<BearState>((set) => ({\n  bears: 0,\n  increase: () => set((state) => ({ bears: state.bears + 1 })),\n}));\n```\n"
},
{
  "slug": "frontend-web-performance-core-web-vitals",
  "title": "前端性能工程：Core Web Vitals (LCP, INP, CLS) 指标深度优化指南",
  "excerpt": "打造丝滑 Web 体验：优化最大内容绘制 (LCP)、消除交互延迟 (INP) 与防范累积布局偏移 (CLS) 的全链路实战策略。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "15 min",
  "author": "Waitwalker",
  "tags": [
    "Web性能",
    "Core Web Vitals",
    "LCP",
    "INP"
  ],
  "content": "\n## 1. 核心指标健康阈值\n\n- **LCP (Largest Contentful Paint)**: < 2.5 秒 (首屏关键资源提前 preload, fetchpriority=\"high\")。\n- **INP (Interaction to Next Paint)**: < 200 毫秒 (主线程长任务拆分, scheduler.yield())。\n- **CLS (Cumulative Layout Shift)**: < 0.1 (图片/广告位强制设置宽高比 aspect-ratio)。\n"
},
{
  "slug": "fullstack-monorepo-turborepo-nest-next",
  "title": "全栈 Monorepo 工程化：使用 Turborepo 搭建 Next.js 现代化多包与全栈架构",
  "excerpt": "打造高效全栈研发流水线：共享 TypeScript 类型接口、公共 UI 组件库、高速增量远程缓存与多应用并行开发。",
  "category": "Next.js",
  "date": "2026-08-29",
  "readTime": "16 min",
  "author": "Waitwalker",
  "tags": [
    "Turborepo",
    "Monorepo",
    "Next.js",
    "TypeScript",
    "工程化"
  ],
  "content": "\n## 1. Monorepo 目录结构规划\n\n```\nmy-monorepo/\n ├── apps/\n │    ├── web/        ── Next.js 15 客户端前端\n │    └── core/       ── 高并发后端与微服务\n ├── packages/\n │    ├── types/      ── 共享数据模型与契约接口\n │    ├── ui/         ── 共享通用 React 组件库\n │    └── config/     ── 共享 tsconfig 与 lint 规则\n └── turbo.json\n```\n"
}
];

export const posts: Post[] = [...catalog, ...rustPosts];