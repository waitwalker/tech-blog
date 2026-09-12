export const flutterMoreB: Record<string, string> = {
  "flutter-gesture-arena-and-dispatch": `把「手势」理解成 \`GestureDetector(onTap: …)\` 的回调注册，会在嵌套滚动、侧滑删除、双击和长按同时存在时立刻失效。Flutter 里一次触摸不是发给「最上面那个 Widget」的函数调用，也不是 Android 那套捕获/冒泡优先级表。它是两段协议：先 **HitTest 决定谁有资格看见这根指针**，再 **GestureArena 决定资格名单里谁能把这根指针用完**。谁先注册谁处理——这个模型从来就不是 Flutter 的模型。

读完你应该能独立回答三个问题：列表竖滑和子项横滑为什么不会同时赢、\`Listener\` 为什么能绕过竞技场、\`HitTestBehavior.opaque\` 挡掉的到底是命中还是手势。

## 1. 先画边界：指针事件不是手势

手势是 Framework 的概念。Engine 只认识 \`PointerData\`：down / move / up / cancel、位置、pressure、device kind、pointer id。Shell 从系统拿到 \`MotionEvent\` / \`UITouch\`，压成包，投到 **UI Task Runner**。Raster 完全不参与；Platform Runner 只负责采集，不裁判输赢。

所以「手势卡顿」几乎一定是 UI Runner 的病：HitTest 太深、Recognizer 在 move 里做重活、在竞技场回调里同步 \`setState\` 整棵大树。它不是 GPU 的病，也不是 Channel 的病。用 \`FrameTiming.buildDuration\` 能看见它，用 \`rasterDuration\` 看不见。

\`dart:ui\` 的 \`PointerDataPacket\` 进 \`GestureBinding\`。从这一刻起，对象都是 Dart 堆上的，生命周期跟一次指针会话绑定：down 分配，up/cancel 释放。跨帧存活的是 Recognizer 自己，不是事件对象。把 \`PointerDownEvent\` 存进 \`State\` 再在下一帧读坐标，读到的是一份快照，不是「还活着的手指」。

不变量先写在这里，后面所有机制都围着它转：

- 一根手指一个 \`pointer\` id，一场竞技场。
- 命中测试不看手势类型，只回答几何。
- 原始指针分发和竞技场仲裁是两条线，\`Listener\` 只走第一条。
- 全部发生在 UI Isolate / UI Runner，没有并行 HitTest。

## 2. HitTest：资格名单怎么来

从 \`RenderView\` 深度优先往下。每个 \`RenderBox\` 大致做三件事：

1. 把事件坐标从父坐标系变换到自己的 paint 坐标系（含 transform、scroll offset、\`Layer\` 的 offset）。
2. \`hitTestSelf\`：这一点是不是落在自己的命中形状里。默认矩形是 \`size\`；异形按钮才去 \`Path.contains\`。
3. \`hitTestChildren\`：从 **最后一个 child 往前** 走——后绘制的在 z 轴上面，先被问。

返回 true 表示「这条路径有效」，自己会被 \`HitTestResult.add(HitTestEntry(this))\`。路径的语义是从内到外：最先 add 的是最深处的目标。之后 \`GestureBinding.dispatchEvent\` 按这条路径从头走到尾，等于从最上面的控件走到根。

\`HitTestBehavior\` 改的是「自己没孩子命中时还要不要入路径」：

| behavior | 孩子没命中时 | 是否挡住后续兄弟 | 典型用途 |
|---|---|---|---|
| \`deferToChild\` | 不入路径 | 不 | 空白 \`Container\`、只想让孩子热 |
| \`opaque\` | 入路径 | 是 | 大按钮扩大热区、模态遮罩 |
| \`translucent\` | 入路径 | 否 | 叠层上的半透明控件、装饰性水印仍要点穿到下面 |

不变量：**命中测试不看手势类型。** 它不知道你是 tap 还是 pan。把「不想响应 tap」写成 \`IgnorePointer\`，会把 pan 也一起关了——那是在资格层下手，不是在竞技场认输。

\`IgnorePointer\` 让子树 \`hitTest\` 直接返回 false，自己也不入路径。\`AbsorbPointer\` 自己命中、不把事件传给孩子，等于一块黑洞：路径在它这里形成，孩子的 Recognizer 根本看不到 pointer。两者都比「Recognizer.reject」更早、更粗。排障时先问是不是根本没入路径，再问是不是入了但输了竞技场。

自定义 \`RenderBox\` 如果 \`hitTest\` 和 \`paint\` 用了不同的变换，就会出现「看见点不中、点中看不见」。不变量是：**hit 用的矩阵必须和 paint 一致。** \`HitTestResult.addWithPaintTransform\` 存在的原因就是把这张矩阵记进 \`HitTestEntry\`，后面把全局坐标变回本地时还用它。

\`\`\`dart
@override
bool hitTest(BoxHitTestResult result, {required Offset position}) {
  if (!size.contains(position)) return false;
  final hitChildren = hitTestChildren(result, position: position);
  if (hitChildren || hitTestSelf(position)) {
    result.add(BoxHitTestEntry(this, position));
    return true;
  }
  return false;
}
\`\`\`

\`size.contains\` 是矩形热区。圆形按钮必须重写 \`hitTestSelf\`，否则四角也能点——那不是竞技场的问题。

## 3. 分发：路径上每个人都先看见 raw pointer

\`GestureBinding.dispatchEvent\` 沿 \`HitTestResult.path\` 走。每个 entry 的 \`target.handleEvent(event, entry)\`。\`RenderPointerListener\`（\`Listener\`）在这里直接回调 \`onPointerDown/Move/Up\`。它 **不加入竞技场**。

这是一个经常被忽略的分界：

- \`Listener\`：原始指针，同步、可与任何人并行。适合画笔、游戏、自己做手势状态机。
- \`GestureDetector\` / \`RawGestureDetector\`：把 pointer 交给一组 \`GestureRecognizer\`，由竞技场仲裁。
- \`InkWell\` / \`Button\`：内部仍是 Recognizer，只是多了水波纹和语义。水波纹在 \`onTapDown\` 就启动，所以「滑走了还闪一下」常常是 Ink 的锅。

\`handleEvent\` 发生在 UI 线程、当前事件的调用栈上。\`onPointerMove\` 里做 10ms 的计算，这一帧的 build/layout 预算就被吃掉。Recognizer 的 \`handleEvent\` 同样如此。手势代码看起来「只是回调」，实际和 \`build()\` 抢同一条 16.6ms。

坐标：事件带的是全局位置。\`HitTestEntry\` 上的 \`transform\` 把全局变本地。\`Scrollable\` 在滚动后，同一根手指的局部坐标会变，全局坐标跟手。自己算 delta 时要用 \`PointerMoveEvent.delta\` 或全局差，不要缓存 down 时的局部坐标去减——那会把滚动本身算进拖拽。

\`PointerRouter\` 是另一条分发线：Recognizer 在 \`addPointer\` 时按 pointer id 注册，之后 **即使 HitTest 路径变了**（手指滑出控件），move/up 仍能送到这个 Recognizer。这就是「在按钮上按下、滑到外面再抬起」Tap 会认输、Drag 仍能跟手的原因。不要把 HitTest 路径理解成整个手势期间的订阅列表；它只决定 **down 那一帧谁有资格入场**。

## 4. 竞技场的不变量

同一 \`pointer\`（同一根手指的 id）对应一场 \`GestureArena\`。入场成员是 \`GestureArenaMember\`。框架源码里的硬规则比文档少，但每一条都是 bug 的根：

- **一场最多一个赢家。** 赢的人收到 \`acceptGesture(pointer)\`，其余 \`rejectGesture(pointer)\`。没有「两个都赢 50%」。
- **没人认领可以全灭或默认胜。** pointer up 时若竞技场还开着，\`sweep\` 会把胜利判给仍在场的第一个成员。Tap 经常靠这条活下来：它从不主动 \`accept\`，等别人认输或 sweep。
- **可以 hold。** \`GestureArenaManager.hold(pointer)\` 阻止 up 时立刻 sweep。双击识别器靠它把第一下 tap 的胜负推迟到 \`kDoubleTapTimeout\`（通常 300ms）之后。这就是「有双击时单击变慢」的物理来源，不是设备卡。
- **可以提前 close。** 一旦有人 \`resolve(GestureDisposition.accepted)\`，竞技场关闭，再来的 move/up 只发给赢家（以及仍走 \`Listener\` / \`PointerRouter\` 的那些人）。
- **认输不可撤回。** \`rejected\` 之后再看到符合自己的轨迹也没用。所以过早 \`accept\` 和过早 \`reject\` 一样致命。

\`accept\` 不是「我感兴趣」，是「我确定这是我的手势，别人必须停」。\`HorizontalDragGestureRecognizer\` 在位移超过 touch slop 且方向锁定后才 accept。在那之前它只是 possible，和 Tap 共存。slop 的值来自 \`kTouchSlop\`（逻辑像素，约 18），并按设备像素比和 pointer kind 调整。把 slop 改成 1，横滑会赢掉几乎所有 tap。

父子都能入场。子项的横滑和父级的竖滑是 **同一场** 竞技场里的两个成员，不是两场。这就是嵌套手势能被仲裁的原因：它们看见的是同一 pointer id。Widget 树的父子关系只决定谁能 \`addPointer\`（因为 HitTest 路径包含两者），真正的互斥是 arena 做的。

\`\`\`dart
class _ClaimOnSlop extends HorizontalDragGestureRecognizer {
  @override
  void handleEvent(PointerEvent event) {
    super.handleEvent(event);
    // 不要在 down 里 accept。那会让父级 Scrollable 永远拿不到这根手指。
  }
}
\`\`\`

## 5. Recognizer 的状态机

以 \`DragGestureRecognizer\` 为骨架，绝大多数冲突都能映射过来。

- **down**：\`addPointer\`，入场，进入 possible，\`PointerRouter\` 注册。此时 **没有赢家**。
- **move**：累计 delta。未过 slop 则继续 hold。过 slop 后按轴策略决定：水平识别器发现垂直分量明显更大就 \`reject\`；否则 \`resolve(accepted)\`，发出 \`onStart\`，之后 \`onUpdate\`。
- **多轴竞争**：\`Scrollable\` 默认在主轴上更贪，用的是 \`VerticalDragGestureRecognizer\` / \`HorizontalDragGestureRecognizer\`，不是 \`PanGestureRecognizer\`。\`Pan\` 两轴都吃，更容易从父级抢走滚动。列表项里用 \`Pan\` 做「随便拖」是常见误用。
- **up**：若仍 possible，sweep。Tap 会在此时赢，Drag 会认输（没过 slop 的轻微抖动被当成 tap，这是对的）。
- **cancel**：所有人 reject，状态机回 idle。系统抢占（来电、权限弹窗、窗口失焦）走这条。视觉态必须当 up 处理，否则按钮会停在「按住」。

\`TapGestureRecognizer\` 的坑更细：

- 移动超过 slop → 认输，把机会让给 Drag。
- \`onTapDown\` 在竞技场尚未关闭时就可能触发（「可能是 tap」）。真正的 \`onTap\` 在赢了之后。
- 若树上还有 \`DoubleTapGestureRecognizer\`，单击要等双击窗口。把导航放在 \`onTapDown\`，用户其实在滑列表或准备双击时都会误跳。

\`EagerGestureRecognizer\` 在 down 时立刻 accept。画布、地图内部手势常用它挡住父 \`Scrollable\`。它是一把锤子：一旦用了，父级彻底拿不到这根手指。正确用法是「根据 down 位置决定这根手指归谁」：点在可编辑图形上才 eager claim，点在空白处让父级滚。

\`LongPressGestureRecognizer\` 用定时器。定时器触发前它 hold；触发则 accept。和 Tap 共存时，长按成功 Tap 必输；长按失败（中途移动）两者可能都输，滚动接手。

## 6. 多指、滚轮、鼠标：不是同一套裁判

多指：每个 pointer 一场竞技场。\`ScaleGestureRecognizer\` 同时追踪多个 pointer id，自己在成员内部做焦点、缩放、旋转。它赢的是「这些 pointer 组成的缩放手势」，但实现上仍按 pointer 入场。两指缩放时，单指 Tap 必须在第二指 down 时被拒绝——否则你会看到「捏合结束弹出一次点击」。

鼠标：hover 不走竞技场。\`MouseTracker\` 维护 annotations 集合，进入/退出是集合 diff。\`onEnter/onExit\` 和 tap 无关。一帧里鼠标移动跨越多个 annotation，会按顺序发 exit/enter。\`MouseRegion\` 的 \`opaque\` 同样影响命中，但不产生 \`GestureArena\`。

滚轮是 \`PointerScrollEvent\`，走 \`PointerSignalResolver\`：路径上第一个 \`resolve\` 的人吃掉这次滚动，避免父子各滚一次。这不是竞技场，是「信号只能有一个消费者」。自己在 \`Listener.onPointerSignal\` 里处理滚轮却不 \`resolve\`，父级 \`Scrollable\` 仍会滚。

手写笔 / trackpad 的 \`PointerDeviceKind\` 不同，slop 和按钮掩码不同。不要用「有 down 就是手指」写死逻辑。trackpad 的平移可能以 scroll signal 的形式进来，根本没有 down/up 对。

## 7. 生命周期、取消与内存

Recognizer 挂在 \`RenderPointerListener\` 或 \`RawGestureDetector\` 的 State 上。Element unmount 时必须 \`dispose\`：从 arena 退场、从 \`PointerRouter\` 注销、取消长按定时器。漏了会变成「已经不在树里的横滑还在跟手」——典型场景是列表项滑出视口被回收，Recognizer 还在 router 里。

\`PointerCancelEvent\` 必须当 up 处理：清 offset、关动画、不要留下「按住」的视觉态。Android 上窗口丢失焦点、iOS 上系统边缘手势抢占，都会 cancel。\`Scrollable\` 在认输后要把 drag 停掉；在赢了之后才进入 ballistic。自己实现嵌套滚动，优先用 \`NestedScrollView\` / \`NotificationListener<ScrollNotification>\`，不要在 \`Listener.onPointerMove\` 里 \`ScrollController.jumpTo\` 同时让 \`Scrollable\` 也入场——两套状态机会打架，而且 Listener 不受 arena 约束。

内存：事件对象短命，Recognizer 长命。每帧 \`new\` 一个 \`GestureRecognizer\` 是错误用法——\`RawGestureDetector\` 的 \`gestures\` factory 应返回稳定实例，或让 State 持有并在 \`didUpdateWidget\` 里更新回调闭包。闭包捕获了整页 \`BuildContext\` 再塞进长命 Recognizer，等于把整页钉在堆上。

跨组件：\`Hero\`、\`Overlay\`、\`Navigator\` 会改变 HitTest 的树形状。弹层出现后，底下的按钮仍可能 translucent 命中，除非 barrier 是 opaque。这是命中问题，不是竞技场 bug。\`ModalBarrier\` 的存在就是为了在资格层把下面的人踢出去。

## 8. 设计取舍

- **竞技场而不是静态优先级表：** 输赢在运行时由识别器自己声明「我确定了」。代价是延迟：Tap 要等别人认输或 sweep，单击会和双击互相拖慢。换来的是同一套代码在列表、画布、对话框里行为一致。
- **HitTest 与手势分离：** 可以点穿、可以半透明叠层。代价是两套 bug：点不中 vs 手势抢。排查必须先分类。
- **Listener 逃生口：** 需要零延迟的指针（绘图、游戏）。代价是你自己成为正确性的唯一保证，框架不再帮你互斥。
- **单 UI Isolate：** 手势状态无数据竞争，推理简单。代价是识别逻辑必须轻；想在 worker 里做手势识别，得自己把 pointer 流送出去，再把结论送回来，延迟至少一帧。
- **down 时刻锁定入场名单：** 手指滑出控件仍能跟手。代价是「热区外松手」的语义要每个 Recognizer 自己定义（Tap 输、Drag 赢）。

这些取舍决定了「什么优化有意义」。给每个列表项加 \`Listener\` 拦截 move，看起来能「更跟手」，实际是拆掉了仲裁，父级滚动会抖。正确做法是让对的 Recognizer 在对的时刻 \`accept\`。

## 9. 排障时按层提问

1. **点了没反应：** 先问 HitTest。是不是 \`IgnorePointer\`、零尺寸、transform 把热区移走、父级 \`AbsorbPointer\`、\`behavior\` 默认 \`deferToChild\` 而孩子是空的 \`Container\`。\`debugDumpRenderTree()\` 看 size 和 \`hasSize\`。
2. **反应了但抢了滚动：** 画入场名单。子项是不是 \`Pan\` 而不是轴对齐的 Drag；是不是过早 accept；\`NeverScrollableScrollPhysics\` 是否误用。在 Recognizer 回调里临时 \`print\` pointer id 和 \`runtimeType\` 比猜 Widget 树快。
3. **先闪一下按下态再滑走：** 副作用放在了 \`onTapDown\` / Ink highlight。移到 \`onTap\`，或接受「highlight 可以闪、导航不能闪」。
4. **双击总是先触发单击：** 这是超时换正确性。需要双击的表面不要同时提供单击导航，或改用 \`SerialTapGestureRecognizer\` 自己数次数。
5. **画布和列表抢：** 画布按命中对象决定是否 \`EagerGestureRecognizer\` claim。不要全局 eager。
6. **只有某机型：** 查 \`PointerDeviceKind\` 和系统手势（iOS 返回边缘、Android 三键/手势导航）。系统会在 Flutter 赢之前 cancel。
7. **Platform View：** 竞技场到原生边界失效，走平台手势透传。那是混合视图那篇文章的路径，不要在 Dart 里加 Recognizer 硬抢。

能画出「谁 hit、谁入场、谁 accept、谁没 dispose」，手势就不再玄学。

## 10. 源码级走一遍：从 MotionEvent 到 onTap

把一次单击钉到具体类型上，后面排障才不会在 Widget 层空转。

Android 上 \`FlutterView.onTouchEvent\` 把 \`MotionEvent\` 收成 \`PointerData\`：\`pointer\` 来自 pointer id，\`kind\` 来自 tool type，坐标先按视图矩阵变成物理像素，再在 Engine 里除以 device pixel ratio 变成逻辑像素。iOS 上 \`FlutterViewController\` 的 \`touchesBegan/Moved/Ended/Cancelled\` 做同样的事。包进 \`PointerDataPacket\` 后，**投递目标是 UI Task Runner**，不是当前这个主线程调用栈。所以你在原生 \`onTouchEvent\` 里打的时间戳，和 Dart \`PointerDownEvent.timeStamp\` 之间隔着一次队列。主线程忙时，手势会「肉眼可见地晚一拍」，这不是 Recognizer 的 slop，是 Embedder 排队。

UI Runner 上 \`GestureBinding._handlePointerDataPacket\` 把 packet 转成 \`PointerEvent\` 序列。同一帧里可能有 down+move，顺序必须保留。然后：

1. \`hitTestInView\` 从 \`RendererBinding\` 拿到 \`RenderView\`，对每个 event 做 HitTest（move 也会测，但 arena 入场只在 down）。
2. \`dispatchEvent\`：先 \`pointerRouter.route\`（已经订阅该 pointer 的 Recognizer / Listener），再沿本次 HitTest 路径 \`handleEvent\`。
3. down 时路径上的 \`RenderPointerListener\`、\`RenderSemanticsGestures\`、\`RawGestureDetector\` 对应的 RenderObject 调用各自 Recognizer 的 \`addPointer\`。
4. \`GestureArenaManager.close(pointer)\`：所有想入场的人已经入场，竞技场关闭「报名」，开始等待 accept / reject / sweep。
5. 若这是一个几乎立刻抬起的 tap，move 很少，up 时 \`sweep\`。仍在场的成员按加入顺序，**第一个** 获得胜利。\`TapGestureRecognizer\` 通常靠这条赢，而不是自己 \`accept\`。

\`debugPrintGestureArenaDiagnostics = true\` 会把入场、hold、sweep、win/lose 打到控制台。比在每个 \`onTap\` 里 \`print\` 更接近真相。生产关掉。

\`Scrollable\` 的 \`VerticalDragGestureRecognizer\` 在 \`scrollDirection\` 为垂直时入场。它的 \`minFlingDistance\`、\`dragStartBehavior\` 决定 \`onStart\` 的位置是「过 slop 的那一点」还是「down 的那一点」。\`DragStartBehavior.down\` 跟手更狠，但也更容易和 tap 抢——因为 accept 更早。列表项要 tap、列表要滚，用默认 \`start\` 通常更正确。

## 11. 嵌套滚动、系统手势、Overlay：竞技场的边界在哪

竞技场的不变量是「同一 pointer id」。越出这个 id，框架帮不了你。

**嵌套滚动。** 外层 \`CustomScrollView\`、内层横向 \`PageView\`，两根轴，两个 Drag 识别器，仍是同一 pointer。垂直 slop 先满足则外层赢，水平先满足则内层赢。\`PageView\` 里再放纵向列表，变成「先锁轴」。\`NeverScrollableScrollPhysics\` 不是仲裁，是直接让内层识别器不工作。\`NotificationListener<OverscrollNotification>\` 是竞技场结束之后的事：已经有人赢了，你在用输家的溢出做协调。不要用 notification 去「模拟」accept/reject。

**iOS 边缘返回、Android 预测性返回。** 系统手势在 Flutter 竞技场之外。边缘 20pt 的 back swipe 可能直接 \`PointerCancelEvent\`。自己在边缘做抽屉，要和系统手势抢，输的常常是 Flutter。要么留白给系统，要么用原生侧关掉该边缘手势（有平台限制）。这不是 \`EagerGestureRecognizer\` 能赢的局。

**Overlay / Hero / Tooltip。** Overlay 插在独立子树，HitTest 从 overlay 的 \`RenderStack\` 开始。一个全屏 \`ModalBarrier\` 必须 opaque，否则会点到 route 下面。Hero 飞行中旧位置和新位置都可能短暂可命中，要用 \`IgnorePointer\` 包飞行中的那一份。\`CompositedTransformFollower\` 的绘制在另一处，hitTest 默认仍在 follower 的 layout 位置——看见和点中分离，是这套协议最典型的坑。要么自己做 hit 变换，要么把可点控件放在真正 layout 到目标处的那棵子树上。

**多指拖拽。** \`ImmediateMultiDragGestureRecognizer\` / \`DelayedMultiDragGestureRecognizer\` 为每个 pointer 创建独立的 drag 对象，允许「两根手指拖两个 item」。它们和 \`ScaleGestureRecognizer\` 冲突：捏合需要两指属于同一识别器。画布类编辑器要在 down 时按命中对象分流：点空白走 scale/pan，点 item 走 multi-drag，不要把所有识别器无脑挂在同一 \`RawGestureDetector\` 上指望 arena 懂业务。

\`\`\`dart
RawGestureDetector(
  gestures: {
    TapGestureRecognizer: GestureRecognizerFactoryWithHandlers<TapGestureRecognizer>(
      () => TapGestureRecognizer(),
      (TapGestureRecognizer d) {
        d.onTap = widget.onTap;
      },
    ),
    HorizontalDragGestureRecognizer: GestureRecognizerFactoryWithHandlers<HorizontalDragGestureRecognizer>(
      () => HorizontalDragGestureRecognizer(),
      (HorizontalDragGestureRecognizer d) {
        d.onUpdate = widget.onHorizontalDragUpdate;
      },
    ),
  },
  child: widget.child,
)
\`\`\`

factory 的第一个闭包应返回 **长命** 实例（或至少不要每帧新语义）。\`GestureDetector\` 内部就是这张 map。自己写才能少挂不需要的识别器——\`GestureDetector\` 默认会创建 tap/longPress/pan/scale 等一长串，即使回调是 null，有的版本仍可能入场。明确的 \`RawGestureDetector\` 是嵌套场景里更干净的刀。

### 竞技场诊断时要把 pointer id 画出来

同一屏幕上可以有多根手指、一支笔、一个鼠标。日志里只打 \`onTap\` 而不打 \`pointer\`，你会把两场竞技场的输赢拼成一个故事。正确的最小日志是：\`pointer\`、\`runtimeType\`、\`accepted/rejected\`、时间戳。\`GestureArenaManager\` 内部是 \`Map<int, _GestureArena>\`，按 id 索引。自己用 \`Listener\` 做状态机时，也要按 id 分桶，不要用「当前只有一根手指」的全局布尔。

\`PointerDownEvent.buttons\` 区分鼠标左/右键、触控笔笔杆键。右键不要进 tap 导航，应进 \`onSecondaryTap\`。把右键当 tap，桌面和 Web 上会无法弹出上下文菜单。\`kPrimaryButton\` 掩码是这条边界。

\`device\` 字段标识物理设备。手指和笔同时存在时，笔的 hover 不应取消手指的 drag。\`MouseTracker\` 和 \`GestureBinding\` 共享事件流但裁判不同：hover 更新 annotation，down 才开竞技场。用 \`Listener.onPointerHover\` 改滚动位置，等于在竞技场外偷拨，父级 \`Scrollable\` 不知道，松手后 ballistic 会跳。

### HitTest 与滚动偏移：localPosition 的陷阱

\`BoxHitTestResult.addWithPaintOffset\` 把 child 的 offset（含 scroll offset）记进矩阵。\`Scrollable\` 的 sliver 只命中可见孩子——这是性能不变量：未 layout 的 sliver child 不在树上，谈不上命中。自己用 \`Viewport\` 以外的方式做「只画可见项」时，必须保证不可见项要么不在子级列表，要么 \`hitTest\` 为 false。留在树上且 size 非零的离屏按钮仍能被点到，如果它们的几何因缺 clip 而叠在视口上。

\`clipBehavior: Clip.none\` 的 \`Stack\` 是命中事故高发区：视觉溢出、命中也溢出，挡住了后面本该可点的控件。\`clipBehavior\` 默认 clip 的组件，hitTest 仍可能在 clip 外返回 true，除非 RenderObject 实现了 clip 感知的 hitTest（\`RenderClipRect\` 会裁）。不要假设「看不见 = 点不中」。看见走 paint，点中走 hitTest，两套 clip。

\`Transform.scale\` 缩小时，命中区域跟着矩阵变。视觉热区变小，手指变难点。扩大热区应在未缩放的祖先加 padding，或重写 \`hitTestSelf\` 用更大的 rect，不要靠用户「点准中心」。

### 手势与语义、平台视图的交接

读屏激活走 \`SemanticsAction.tap\`，不经过竞技场。\`GestureDetector\` 若只设 \`onTap\`，框架会同步提供语义 tap；\`RawGestureDetector\` 和纯 \`Listener\` **不会**。自绘按钮用 Listener 收手势，必须另挂 \`Semantics(onTap: ...)\`，否则 TalkBack 用户无法激活。这是手势篇和无障碍篇的接缝：两条输入路径，一份业务函数。

Platform View 矩形上，HitTest 会命中 \`RenderAndroidView\` / \`RenderUiKitView\`。Recognizer 可能入场，但后续事件被 Embedder 转走后，Flutter 侧会收到 cancel。表现是：外层 Scrollable 抖一下又停，WebView 开始滚。eager 策略就是在 down 时决定这场 cancel 发不发。把它当 bug 修来修去，不如把策略写成参数。

### 自己实现 GestureArenaMember 时的最小契约

多数人停在 \`GestureDetector\`。一旦要做「双指在画布平移、单指在已选图形上变形」，就要自己实现 \`GestureRecognizer\`。最小契约只有四件事：\`addPointer\`、\`handleEvent\`、\`acceptGesture\`、\`rejectGesture\`。漏掉 reject 里的清理，输了之后仍会在 \`PointerRouter\` 里吃 move，表现为「认输了还在跟手」。

\`\`\`dart
class CanvasPanRecognizer extends OneSequenceGestureRecognizer {
  Offset? _start;
  void Function(Offset delta)? onPan;

  @override
  void addPointer(PointerDownEvent event) {
    startTrackingPointer(event.pointer, event.transform);
    _start = event.position;
    resolve(GestureDisposition.accepted); // 仅当确定父级不该滚时
  }

  @override
  void handleEvent(PointerEvent event) {
    if (event is PointerMoveEvent && _start != null) {
      onPan?.call(event.position - _start!);
    }
    if (event is PointerUpEvent || event is PointerCancelEvent) {
      stopTrackingPointer(event.pointer);
    }
  }

  @override
  void acceptGesture(int pointer) {}

  @override
  void rejectGesture(int pointer) {
    stopTrackingPointer(pointer);
    _start = null;
  }

  @override
  String get debugDescription => 'canvasPan';
}
\`\`\`

\`OneSequenceGestureRecognizer\` 表示「这根手指的整段序列归我」。\`MultiTapGestureRecognizer\` 一类才同时看多根。\`startTrackingPointer\` 把你挂进 \`PointerRouter\`；\`stopTrackingPointer\` 必须在 up/cancel/reject 成对调用。不成对就是泄漏：Recognizer 活在 State 里，router 里的订阅却指向已经不该收事件的对象。

\`resolve(accepted)\` 在 \`addPointer\` 里立刻调用，等于 Eager。只有在 HitTest 已经告诉你「点在画布空白」时才能这样。点在按钮上仍 eager，按钮的 Tap 永远赢不了。分流发生在 **工厂创建哪个识别器** 或 **addPointer 里是否 resolve**，不是发生在 \`onTap\` 里 return。

\`GestureRecognizer.team\`（\`GestureArenaTeam\`）允许一组识别器共享胜负：水平拖和垂直拖组成队，队赢了再在队内分。\`Scrollable\` 内部用 team 处理某些嵌套。自己用 team 前先确认不是「两个都该输给第三个人」。team 赢了会挡住队外的 Tap。

### 鼠标、触控板、kTouchSlop 的量纲

\`kTouchSlop\` 是逻辑像素。dpr=3 的设备上物理像素约 54。把 slop 写成 2，所有 tap 都会变成 drag。桌面鼠标的 slop 更小（\`kPrecisePointerHitSlop\` 一类常量），因为指针精度高。同一套 \`PanGestureRecognizer\` 在手机和桌面表现不同，是常量按 \`PointerDeviceKind\` 分支，不是 bug。

触控板的平移在部分平台是 \`PointerPanZoomStart/Update/End\`，不是 down/move/up。\`Listener\` 要额外挂这些回调。只处理 down/move 的自绘画布，在 Mac 触控板上会完全不动。这是指针设备种类的边界，不是竞技场没赢。

\`PointerSignalResolver\` 的 \`register\` 在一次信号分发中只生效一次。父子都 \`onPointerSignal\` 里 \`resolve\`，先被 HitTest 路径排到的人赢。想让父级滚轮、子级只在按住 Alt 时缩放，必须在子级 **有条件地** resolve，不要无条件吃掉。

### 与滚动物理、通知的分工

竞技场决定谁拥有手指。\`ScrollPhysics\` 决定赢了之后怎么滑。把「滑不动」当成手势 bug，有一半其实是 \`NeverScrollableScrollPhysics\`、父级 \`AbsorbPointer\`、或 \`IgnorePointer\` 包了列表。先问谁赢了 arena：若 \`VerticalDrag\` 已经 accept 仍不滑，去查 physics 和 \`ScrollController\` 是否在别处 \`jumpTo\`。若 arena 里 Tap 赢了，再查为什么 Drag 过早 reject——多半是 slop 或轴锁。

\`NotificationListener\` 发生在滚动已经发生之后。用它做「吸顶、折叠头」可以；用它做「禁止父级滚动」晚了。禁止发生在 physics 和 arena。通知是只读观察。

这三条——资格、所有权、物理——画在一张纸上，比在三个 Widget 上各打一次补丁干净。

把「手势系统」收成一句工程口令：**先几何，后所有权，再物理。** 几何是 HitTest 矩阵与 clip；所有权是 pointer id 上的竞技场；物理是赢了之后 ScrollPhysics / 画布矩阵怎么积分。三层任何一层的 bug 都会被说成「手势坏了」，但修的文件完全不同。几何在 \`RenderBox\`，所有权在 \`GestureRecognizer\`，物理在 \`Scrollable\` 或你自己的 Ticker。跨层打补丁（在 Listener 里 jumpTo 又让 Scrollable 入场）会制造不可复现的抖动。新需求先问落在哪一层，再决定加 Recognizer、改 hitTest，还是改 physics。这句口令可以贴在自定义交互的 PR 模板上，比再贴一份 GestureDetector 参数表有用。

调试时把 \`debugPrintHitTestResults\` 和 \`debugPrintGestureArenaDiagnostics\` 成对打开，只开一个会误判。路径上有人、竞技场里没人，是 Listener 或 IgnorePointer；竞技场里有人却全输，是 slop 和轴锁。两者日志时间戳对齐同一 pointer id，故事才会闭合。关日志再提交，否则用户设备会卡在打印上——这本身也是 UI Runner 的病。

至此可以把手势调试收成固定三问：路径上有谁、竞技场里谁赢、赢了之后物理是否在听。三问都有日志开关。再往下才是 Platform View 和系统手势那些例外。例外另案处理，不在 Recognizer 里加 if 平台。

## 12. 小结

指针从 Shell 进 UI Runner，经 HitTest 变成资格路径，经 Arena 变成唯一赢家，Recognizer 把赢家的 pointer 流翻译成 tap/drag/scale。不变量是一场指针一次所有权转移。\`Listener\` 故意不参加这场转移。嵌套手势的正确性来自「同一 pointer id 进同一场竞技场」，不是来自 Widget 树的父子关系本身。把问题画回这两段协议，代码改动才会落在正确的层。`,

  "flutter-platform-channels-codec-binary": `把 \`MethodChannel.invokeMethod\` 理解成「调了一个 Java/ObjC 函数」，会在大图、每帧传感器、同步返回这三个场景里立刻撞墙。Channel 不是 FFI，不是共享内存，也不是 JNI 的直接包装。它是 **一份编过码的字节，被投进跨线程队列，对端再解码**。你 \`await\` 到的延迟 = 编码 + 两次队列等待 + 原生执行 + 回包编码。没有函数调用语义，所以也没有「传一个对象引用过去」。

读完你应该能独立回答三个问题：一次 invoke 在哪条线程上跑完、\`Uint8List\` 会不会拷贝、什么数据绝对不该走 Channel。

## 1. 先画边界：三层 API，一份字节

日常看见的是三张皮：

- \`MethodChannel\`：方法名 + 参数 + 成功/失败结构。适合 RPC。
- \`EventChannel\`：原生 push、Dart \`listen\`。适合传感器流、导航事件。
- \`BasicMessageChannel\`：双向任意消息，没有 method 名。适合自定义协议。

三张皮底下是同一个东西：\`BinaryMessenger\`。它只认识 \`ByteData\`。名字、Map、异常，全是 Codec 的幻觉。

Engine 侧对应 \`PlatformMessage\`。Dart 的 \`PlatformDispatcher.sendPlatformMessage\` 把字节交给 Engine；Engine 投到 **Platform Task Runner**；Embedder 再交给插件注册表。回包沿反向走：Platform Runner → UI Runner → Dart 回调。

不变量：

- 消息是值，不是引用。对端改 Map 不会反映回来。
- 默认异步。没有「在同一调用栈上进 Java 再返回」的 Channel。
- 每个 \`FlutterEngine\` 一份 messenger。多 Engine 时同名 Channel 互不相通，除非你自己桥。
- Codec 必须两端一致。一边 \`StandardMessageCodec\`、一边 JSON，解码会直接失败。

\`\`\`dart
const channel = MethodChannel('app.device');

Future<String> model() async {
  final result = await channel.invokeMethod<String>('getModel');
  return result ?? '';
}
\`\`\`

这看起来像函数。它不是。\`getModel\` 只是字节里的一段 UTF-8。原生没注册这个名字，你得到的是 \`MissingPluginException\`，发生在回包之后，不是编译期。

## 2. Codec：类型怎么变成字节

\`StandardMessageCodec\` 是默认选择。它用 tag byte 标记类型，再跟 payload：

| tag | 类型 | 备注 |
|---|---|---|
| 0 | null | |
| 1 / 2 | true / false | |
| 3 | int32 | |
| 4 | int64 | Dart 的 \`int\` 在 64 位上走这条或更大 |
| 5 | float64 | 对齐到 8 字节 |
| 6 | String | UTF-8，长度前缀 |
| 7 | Uint8List | 长度 + 原始字节 |
| 8–10, 13 | typed list | int32/int64/float64/float32 |
| 11 | List | 元素递归编码 |
| 12 | Map | key/value 递归；key 不必是 String |

对齐规则容易被忽略：\`float64\` 和部分 list 要 pad 到 8 字节对齐。自己手写解码器如果不 pad，会在「某些长度的字符串后面跟一个 double」时读到垃圾。这就是为什么不要轻易重写 Codec。

\`JSONMessageCodec\` 走 UTF-8 JSON。调试友好，热路径不友好：多一次字符串分配、数字全是 JSON number、\`Uint8List\` 只能变 base64。\`StringCodec\` 只传字符串。\`BinaryCodec\` 原样过 \`ByteData\`，是 Channel 能做到的最薄封装，仍有队列和拷贝。

\`StandardMethodCodec\` 在 message codec 外包一层：成功是 \`[method, args]\` 或 \`[result]\`；失败是 \`[code, message, details]\`。\`PlatformException.code\` 应该是稳定协议（\`permission_denied\`），不要把异常堆栈当 code。

Pigeon 生成的是「固定结构的 StandardMethodCodec」。它消灭的是字符串方法名和动态 Map，不是拷贝，也不是线程跳。生成代码里你看见的 \`codec.encodeMessage\`，和手写 Channel 是同一条路。

## 3. 拷贝发生在哪：没有共享 ByteBuffer 的幻觉

文档偶尔说「共享 ByteBuffer」。实现上，跨 JNI / ObjC 边界时，字节几乎总会被拷一次：

1. Dart 堆上的 \`Uint8List\` / \`ByteData\` 编码进 message buffer（可能已经是拷贝）。
2. Engine 把 buffer 交到 Platform 线程。有的路径是 move，有的是 copy，取决于实现和是否能转移所有权。
3. Android 上 JNI 取 \`byte[]\`，通常再拷到 Java 堆。iOS 上 \`NSData\` 可能 copy-on-write，但 Dart 侧释放后你不能假设仍指向同一页。
4. 回包再走一遍。

所以一张 8MB 的图走 Channel，峰值内存很容易是 8MB × 2～4，再加上编解码临时对象。这不是「Channel 实现差」，是消息语义的直接推论：**消息必须在发送方释放后仍能被接收方读。** 要满足这点，要么拷贝，要么做复杂的跨堆生命周期，Engine 选了拷贝。

零拷贝大缓冲的正确出口是 FFI 指针、\`Texture\` 注册表、或 \`dart:ui\` 的 \`Image\` / \`ImmutableBuffer\`。不要试图用 \`TransferableTypedData\` 骗过 Channel——那只在 Dart Isolate 之间有效，出不了 Engine。

## 4. 线程模型：异步是推论，不是语法糖

四条 Runner 的约束在 Channel 上变成一张时间表：

| 步骤 | 线程 | 你能做什么 | 卡住的后果 |
|---|---|---|---|
| \`invokeMethod\` 编码 | UI / 调用方 Isolate | 准备 Dart 对象 | 大对象编码打 build 预算 |
| 投递 | Engine 队列 | 无 | 队列堆积表现为延迟，不是抛错 |
| 插件方法 | **Platform（主线程）** | 调系统 API | Android 上重活 = ANR |
| 回包解码 | UI | \`setState\` | 回包太大同样卡帧 |

默认插件代码跑在主线程，因为系统 API（权限、窗口、蓝牙适配器）要求如此。Flutter 后来加了 \`TaskQueue\` / background platform channels：你可以声明某个 Channel 的 handler 跑在后台线程。这只是把「原生执行」挪走，编码/解码和 Dart 回调仍在 UI Isolate。

不变量：**Dart 回调回到 UI Isolate。** 在后台 Isolate 里 \`invokeMethod\` 需要 \`BackgroundIsolateBinaryMessenger.ensureInitialized(rootIsolateToken)\`。忘了会直接抛。回包也不能在 worker 里 \`setState\`。

\`await channel.invokeMethod\` 在等待期间 UI Isolate 是空闲的（相对这条调用而言），可以继续处理帧。这是它和「同步 JNI」的关键差别。反过来，你没法用 Channel 实现「在 layout 里同步问原生一个高度」——那会要么死锁，要么至少拖到下一帧。这种问题用 FFI、或把高度缓存进 Dart。

EventChannel 的 \`listen\` 在 Dart 侧订阅时给原生发一份 \`listen\` 方法调用；cancel 再发 \`cancel\`。原生若在错误的线程 \`sink.success\`，Embedder 会帮你投递，但高频小包仍会把 Platform 和 UI 队列打满。传感器 1kHz 原样 push 是典型误用，应该原生合批，20～50Hz 再发，或改共享内存。

## 5. 生命周期：Channel 比 Widget 活得长

\`MethodChannel\` 对象只是名字 + codec + messenger 的句柄。真正的注册表在 Engine / 插件侧。典型事故：

- Widget \`dispose\` 了，\`EventChannel\` 的 \`StreamSubscription\` 没 \`cancel\`，原生还在 \`sink.success\`，回包进已经拆掉的 \`setState\`。
- 热重载后 Dart 侧换了 handler，原生侧还是旧的。Debug 里表现为「改了插件没生效」。
- 多 Engine：插件 \`registerWith\` 用了静态 \`MethodChannel\`，第二个 Engine 的消息打到第一个的 handler，或反过来。正确做法是 handler 持有 \`FlutterPluginBinding.binaryMessenger\`，按 engine 实例注册。
- 引擎销毁顺序：先 \`destroy\` Engine 再卸插件，队列里的回包会丢。Dart 侧 \`await\` 永远不结束——必须在 \`dispose\` 里用 \`timeout\` 或忽略 \`FlutterError\`。

\`\`\`dart
class BatteryTap extends State<BatteryLabel> {
  static const _ch = EventChannel('app.battery');
  StreamSubscription<dynamic>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = _ch.receiveBroadcastStream().listen((event) {
      if (!mounted) return;
      setState(() => _level = event as int);
    });
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }
}
\`\`\`

\`mounted\` 检查不是可选的。回包可能在 \`dispose\` 之后、\`cancel\` 被原生处理之前到达。

## 6. 错误协议与版本

Channel 没有 IDL，除非你用 Pigeon。手写时要把这些当公共 API：

- 方法名、参数 Map 的 key、类型。
- \`PlatformException.code\` 枚举。
- 未实现：\`MissingPluginException\` vs 自己返回 null。两者在 Dart 侧分支完全不同。
- 版本：原生先发、Dart 后发时，旧 Dart 遇到新方法应忽略；旧原生遇到新方法应返回明确 code，不要崩溃。

二进制兼容比 JSON 更脆：\`StandardMessageCodec\` 加一种 tag 是 Engine 版本问题，你自己的业务字段只能加 Map key。不要把 struct 按位置塞进 List 当协议，插入一个字段会让所有版本一起炸。

安全：Channel 不是进程隔离。任何插件都能听同名 Channel（同 Engine 内）。不要用它传密钥后还假设「用户看不见」——它只是同进程消息。真正的隔离是操作系统进程和 TEE。

## 7. 何时不该用 Channel

- **需要零拷贝大缓冲：** FFI、Texture、\`ImmutableBuffer\`。
- **需要同步返回参与 layout：** 做不到。预取、缓存、或把逻辑搬进 Dart。
- **每帧数据：** 相机帧、音频 PCM、触摸采样。Channel 的队列和拷贝会先于你的算法成为瓶颈。
- **调用 UIKit / Android View 层级：** 必须在主线程且和视图生命周期绑在一起，用插件 + Platform View，不要从 worker Isolate 乱 invoke。
- **只是想「快一点」：** 先测。几十字节的配置走 Channel 是微秒到毫秒级，完全够用。过早上 FFI 换来的是内存安全和构建复杂度。

反例也对：权限、取电量、一次性地打开设置页、付费凭证校验（短字符串）——Channel 是正确工具。Pigeon 让它类型安全，不改变它的成本模型。

## 8. 设计取舍

- **消息而不是共享堆：** 插件崩溃可以变成异常而不是 Dart VM 内存损坏。代价是拷贝和异步。
- **默认主线程：** 系统 API 好写。代价是一条慢插件拖死所有 Channel 和部分输入。
- **字符串方法名：** 动态、可热更新协议。代价是重构靠搜字符串，Pigeon 就是补这个洞。
- **每 Engine 一份 messenger：** 多 Flutter 页面互不串。代价是插件作者必须按实例写，不能用 Java \`static\` 偷懒。

这些取舍解释了为什么 Flutter 同时保留 Channel 和 FFI。它们解决的是不同的一致性模型：一个要安全和系统集成，一个要热路径。用 Channel 模拟 FFI，或用 FFI 调 Activity，都是在错误的模型里找性能。

## 9. 排障

1. **\`MissingPluginException\`：** 先问是哪一个 Engine、是 Debug 热重载还是 Release、插件有没有在 \`GeneratedPluginRegistrant\` 里、iOS 是否进了正确的 \`AppDelegate\`。多 flavor 最容易漏注册。
2. **卡住的 \`await\`：** 原生没调 \`result.success/error\`，或 Engine 已销毁。用 timeout 包一层，原生用 \`runOnce\` 保证 result 只回一次（回两次会断言）。
3. **ANR / 主线程卡顿：** 插件里做了磁盘、解码、网络。挪到后台线程，回主线程只 \`result.success\`。
4. **大包延迟：** 量 \`ByteData.lengthInBytes\`。超过几百 KB 就该换通道。编码本身会在 UI 线程分配。
5. **类型错误：** Dart \`int\` 和 Java \`Integer\`/\`Long\`、iOS \`NSNumber\` 的宽度。\`StandardMessageCodec\` 在 32 位设备上可能给你 32-bit，别假设永远 64。
6. **EventChannel 只收到一次：** 原生把 sink 存成局部变量，\`listen\` 返回后就释放。sink 必须活到 \`cancel\`。
7. **偶发乱码 / 错字段：** 自定义 Codec 的对齐；或两端 Flutter 版本不一致导致 tag 集合不同。

线上打点打三件事：方法名、payload 字节数、往返耗时分位数。不要打 payload 内容。

## 10. 字节布局与自写 Codec 的最小正确实现

\`StandardMessageCodec\` 的 \`writeValue\` 是一份递归下降：遇到 List/Map 就写长度再逐元素。字符串先写 UTF-8 长度（变长编码：0–253 单字节，254 后跟 uint16，255 后跟 uint32），再写字节。\`Float64\` 之前 \`writeAlignment(8)\`：从当前 write position pad \`0\` 直到 \`% 8 == 0\`。这就是「前面字符串长度一变，后面 double 全错」的根。

自己要扩展类型时，正确姿势是 **包一层** 而不是复制一份 codec：

\`\`\`dart
class DateCodec extends StandardMessageCodec {
  static const int _date = 128;
  @override
  void writeValue(WriteBuffer buffer, Object? value) {
    if (value is DateTime) {
      buffer.putUint8(_date);
      super.writeValue(buffer, value.toUtc().millisecondsSinceEpoch);
      return;
    }
    super.writeValue(buffer, value);
  }

  @override
  Object? readValueOfType(int type, ReadBuffer buffer) {
    if (type == _date) {
      final ms = super.readValue(buffer) as int;
      return DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true);
    }
    return super.readValueOfType(type, buffer);
  }
}
\`\`\`

tag \`128–255\` 留给业务。小于 128 的是框架的。两端必须同一天发版，否则一边写 128 一边当 unknown type 抛错。Pigeon 生成的自定义 codec 也走这条路。

\`WriteBuffer\` / \`ReadBuffer\` 基于 \`ByteData\`。大 List<int> 用 typed list tag（7–10、13）而不是 tag 11 的通用 List：后者每个元素一个 tag，百万整数会把编码时间打进 UI 帧。这是「Channel 传了个 int 数组就卡」的常见原因——类型是 \`List<int>\` 不是 \`Int32List\`。

Android JNI 侧 \`StandardMessageCodec\` 的 Java 实现对 \`byte[]\` 对应 Dart \`Uint8List\`。Java \`ArrayList\` 对应 List，\`HashMap\` 对应 Map。\`Integer\` 和 \`Long\` 都会来，Dart 侧写成 \`as int\` 没问题，写成 \`as int\` 再塞进只接受 32 位的 FFI 就要小心。iOS 上 \`NSNumber\` 的 \`bool\` / \`int\` / \`double\` 容易混：JSON 里 \`true\` 和 \`1\` 不同，Standard codec 里 bool 和 int 也不同，但如果你在原生用 \`@{@"ok": @1}\` 而 Dart 当 \`bool\` 解，会类型异常。协议要写死。

消息大小没有写在文档里的硬顶，但 Android Binder 对同进程不是瓶颈，跨进程插件（极少见）才是。真正的顶是内存和编码时间。超过 256KB 的 payload 就该问自己是不是走错通道。

## 11. 后台 Isolate、TaskQueue、与插件注册顺序

\`BackgroundIsolateBinaryMessenger.ensureInitialized(token)\` 把 worker Isolate 接到 **同一个 Engine 的 messenger**。它不是新 Channel 世界，只是允许非 UI Isolate 发消息。回包回到这个 worker 的事件循环，不是 UI。worker 里 \`invokeMethod\` 再 \`sendPort.send\` 给 UI，才是完整链路。漏 \`ensureInitialized\` 的错误信息直白；漏「回包进 worker 后去碰 \`dart:ui\`」会变成更隐蔽的崩溃。

Android 插件的 \`BinaryMessenger.makeBackgroundTaskQueue()\` 让 handler 跑在后台线程：

\`\`\`java
TaskQueue queue = binding.getBinaryMessenger().makeBackgroundTaskQueue();
channel = new MethodChannel(
    binding.getBinaryMessenger(),
    "app.unzip",
    StandardMethodCodec.INSTANCE,
    queue);
\`\`\`

适合解压、哈希、读大文件。不适合碰 \`Activity\`、\`View\`、\`Looper.getMainLooper()\` 上才安全的 API。\`result.success\` 可以从后台线程调，Embedder 会切。\`result\` 只能用一次；二次调用 Debug 断言、Release 可能静默。把 \`result\` 存下来等异步，必须保证成功和失败互斥，取消时也要回一次（error 或 success(null)），否则 Dart \`await\` 挂死。

注册顺序：\`GeneratedPluginRegistrant\` 在 Engine \`run\` 之前。自己手写的 Channel 若在 \`runApp\` 之后才在原生注册，Dart 启动期的第一次 invoke 会 \`MissingPluginException\`。反过来，Dart 侧 \`setMethodCallHandler\` 必须在原生第一次往 Dart 推之前挂上——\`EventChannel\` 的 \`listen\` 是 Dart 主动的，安全；原生在 Engine 启动瞬间就 \`sink.success\`，可能丢。启动事件要可重放或等 \`listen\`。

Pigeon 的 \`@HostApi()\` / \`@FlutterApi()\` 只是生成两边的方法表。\`FlutterApi\` 是原生调 Dart，仍然异步。不要在原生 \`onCreate\` 同步等 Dart 准备好——没有同步。用「Dart 第一帧后 ping 原生 ready」或队列把早期事件攒到 Dart handler 挂上。

### MissingPluginException 的分层含义

同一句 \`MissingPluginException\` 至少四种病：

1. 插件根本没链进这个产物（flavor、按需交付、iOS 没进 \`GeneratedPluginRegistrant\`）。
2. 插件链了，但挂在另一份 Engine 的 messenger 上（Group / 多 FlutterView）。
3. 方法名拼错或原生用了不同的 channel 名常量。
4. Dart 调用发生在原生 \`onAttachedToEngine\` 之前（启动竞态）。

前两种用「这个 Engine 上 \`hasPlugin\`」区分；后两种用日志打出两边的字符串常量（包括隐藏字符）。不要一遇到就 \`flutter clean\`。

\`invokeMethod\` 的泛型 \`T\` 只是 Dart 侧转换，不是 codec 保证。原生回了 \`int\`，你写成 \`invokeMethod<String>\`，失败发生在解码之后的 cast。用 \`invokeMapMethod\` / \`invokeListMethod\` 时，元素类型仍是动态。Pigeon 的价值是把这层 cast 变成生成代码里的显式字段。

### 编码性能：对象图形状比字节数先爆

10000 个 \`{id: int, name: String}\` 的 List<Map> 走 Standard codec：每个 map 一个 tag、两个 key 字符串、两个值。key 字符串 \`id\`/\`name\` 重复一万次。改成列式：\`{'ids': Int32List, 'names': List<String>}\` 或直接 FFI。Channel 适合「浅而宽」的配置对象，不适合「深而重复」的 ORM 导出。

字符串：Dart UTF-16，codec UTF-8。中文热路径上转码本身可测。路径、token 这类短字符串无所谓；聊天记录全量同步不要走 Channel。

\`const StandardMessageCodec()\` 是无状态的，可全局复用。不要每次 invoke \`new\` 一个自定义 codec 的重配置对象，若它还关了文件句柄。

### 安全与拒绝服务

任何 Dart 代码都能在同 Engine 上 \`MethodChannel('app.device').invokeMethod('whatever')\`。插件 handler 必须校验方法名和参数类型，不要把未校验的 path 传给 \`File\`。Channel 不是安全边界，是便利边界。敏感操作还要操作系统权限和你自己的鉴权。

恶意或错误的超大 payload：解码会在 UI 或 Platform 线程分配。对 EventChannel 的上游做大小限制。原生往 Dart 推无界日志流，能把帧打掉也能把堆打爆。合批、截断、采样。

### EventChannel 的 listen/cancel 状态机

EventChannel 在原生侧不是无限流，是两次 RPC：Dart \`listen\` → 原生 \`onListen\`；Dart cancel → \`onCancel\`。\`onListen\` 里开传感器，\`onCancel\` 里关。只开不关，页面 pop 后传感器还在跑，这是耗电和往已销毁 Engine 推事件的根源。

\`onListen\` 被调用两次：热重载、重复订阅。第二次应先按 cancel 清理再开，或拒绝（error）。\`receiveBroadcastStream()\` 每次 listen 都走一遍原生 onListen。把 stream 存在 State 里复用，不要在 \`build\` 里每次 \`receiveBroadcastStream()\`。

\`StreamController\` 在 Dart 插件包装里再套一层时，要 \`onCancel\` 链式传到 Channel cancel。漏一层，原生永远收不到 cancel。

二进制心跳：若原生 50Hz push 一个 double，Channel 仍可能够用。若 50Hz push 一帧 JPEG，不够。用频率 × 编码后字节估算：超过每秒 1～2MB 就该换共享内存或 Texture。估算写进设计文档，避免到线上才发现。

### Android 主线程与 Dart 的「假并发」

插件方法默认主线程，Dart 回调 UI 线程。两者都是「不能停」的线程，只是职责不同。插件里 \`Thread.sleep\` 或同步磁盘，ANR；Dart 回调里 \`jsonDecode\` 2MB，掉帧。把重活丢给 \`Executors\` / \`TaskQueue\` 后，\`result.success\` 带大 \`byte[]\` 仍会在 **回包解码时** 打 UI。所以「我已经后台算完了」不等于「Dart 侧便宜」。回包只传路径或 id，让 Dart 用 FFI/文件去取，或让原生直接把结果写成 Texture。

\`runOnUiThread\` 在已经在主线程时再 post，会把 success 推迟到下一则 Looper 消息，多一帧延迟。已经在主线程就直接 \`result.success\`。

iOS 上同类问题是 \`DispatchQueue.main\`。Texture 上传应在 Flutter 规定的线程，乱 \`async\` 到随机队列会和 Raster 抢 GL 上下文（若你错误地碰了 GL）。Texture registry 的 API 才是合法入口。

### 版本协商

启动时一次 \`getProtocolVersion\`，小于本地支持的范围就降级方法集。不要每个方法自己 try/catch MissingPlugin。版本号进 Standard codec 的 int 即可。Pigeon 的版本字段同样道理。跨 App 和独立插件进程（极少）才需要兼容多年；同仓库发版的壳和 Flutter 模块，用「壳版本 ≥ 模块要求」更简单。但模块热更新（动态下发 isolate 快照，若你做了）会让 Channel 协议重新变成分布式问题，那时必须有版本。

### 一次 invoke 的墙钟时间怎么拆

把 \`Stopwatch\` 打在 Dart 编码前、原生 handler 入口、原生 \`result.success\` 前、Dart 解码后。四段：

1. Dart 编码：对象图形状问题。
2. 队列等待：Platform 线程忙（其它插件、WebView、IME）。
3. 原生执行：你的算法或系统 API。
4. 回包解码 + 微任务排队：UI 忙。

只看总 \`await\` 耗时会把 2 和 3 混在一起，于是去「优化」一个其实已经很快的 Java 方法。主线程 trace 才能看见 2。Dart Timeline 自定义事件包住 invoke，能看见 1 和 4。三件套都要，缺一就会改错层。

同步方法在 Android 上有 \`invokeMethod\` 的 blocking 变体吗？官方 Dart API 没有真正的同步 invoke。JNI 侧有阻塞等回包的嵌入者 API，App 业务不要用：容易和主线程互相等，ANR 或卡死。需要同步语义时，把值缓存在 Dart，Channel 只做刷新。

### 命名空间与多模块

Channel 名是全局（每 Engine）字符串。\`app.device\` 这种太短，插件市场会撞。用反域名 \`com.company.module/device\`。Pigeon 的 \`@ConfigurePigeon\` 也要设。两个 Flutter 模块打进同一壳，短名字必撞——第二份 handler 覆盖第一份，bug 表现为「偶发调到另一个模块的实现」。

EventChannel 和 MethodChannel 可以同名吗？不要。底层是同一 messenger 的同一 key。分后缀 \`/method\` \`/event\`。文档里写死。代码审查搜 \`MethodChannel(\` 看字符串字面量有没有抽成常量——两边不共享常量文件是漂移源。

### 二进制兼容实验

加字段：Map 加 key，旧端忽略。删字段：旧端要能缺省。改类型：新 key。不要 reuse 同一 key 换类型。List 按位置的协议几乎无法演进。这和 Standard codec 的 tag 稳定是同一哲学：追加，不重解释。

单元测试：用 codec \`encodeMessage\` / \`decodeMessage\` 在纯 Dart 测往返，不启动引擎。把黄金字节数组提交进仓库，防止有人「优化对齐」时踩碎线上。Channel 协议一旦进生产，黄金测试比注释可靠。

Channel 协议一旦发布，就应按独立于 Dart 版本的 **公有 API** 来管理。方法名、Map key、错误 code、EventChannel 的事件形状，全部进 changelog。Flutter 升级、Pigeon 升级、Kotlin 空安全升级，都不允许默默改二进制含义。一次线上事故的典型链是：原生把 \`status\` 从 int 改成 string，Dart \`as int\` 崩，页面白屏，看起来像「偶发空指针」。防御是 codec 往返黄金测试 + 版本协商 + \`fromPrimitives\` 式的宽容解析（Channel 回包同样该宽容）。

再谈背压。EventChannel 没有内建窗口。原生 \`sink.success\` 能把 Dart 微任务队列打满，UI 来不及 \`setState\` 就下一包又到。实现背压的地方在 **生产者**：传感器采样降频、合批（20ms 内的 N 个样本合成一条）、或满了就丢旧保新。Dart 侧 \`Stream\` 的 \`pause\` 能否传到原生，取决于你是否在 \`onPause\` 里真的停传感器。默认 pause 只停 Dart 订阅，原生还在 push，缓冲堆在引擎队列。要闭环，pause 必须变成一次 cancel 或一次「pause」方法调用。这和「Channel 是消息不是共享内存」是同一推论：对端不知道你来不及，除非你发消息告诉它。

最后是可观测性。每个 Channel 方法在 Debug 打 payload 大小和耗时；Release 只打方法名、大小桶、耗时分位数、失败 code。不要打 token。大小桶用 0-1KB / 1-16KB / 16-256KB / 更大。一旦「更大」出现在滚动路径，报警。这比事后用感觉说「Channel 慢」更能推动换 FFI 或 Texture 的决策。决策要有数字：连续一周 P95 > 8ms 且 payload > 64KB，就立项换通道。数字写进技术债票，避免口头「以后优化」。

插件的 \`result.success(null)\` 和完全不回包，在 Dart 侧一个是完成一个是挂起。code review 对每个分支（权限拒绝、取消、异常、成功）都要看到 result 被调。用封装 \`onceResult\` 保证只回一次。JNI 崩溃在 \`reply already submitted\` 就是没封装。把这层封装当基础设施，业务 handler 只 return 值或 throw，由封装翻译成 success/error。Channel 的正确性一半在这种无聊的纪律，一半在选对通道。纪律不值钱但不做会值夜班。

把插件当成小型 RPC 服务来运维，还会碰到超时、重试、幂等三个经典问题。Channel 默认没有超时：原生不回包，\`await\` 永远挂。业务层必须 \`timeout\`。超时后原生可能仍在跑，回头 \`result.success\` 会打到已经不关心的 Completer，甚至二次提交崩溃。所以超时也要原生可取消：Dart 发 \`cancel\` 或同一 callId 的取消方法。没有 callId 的 Channel 无法取消，这是协议缺陷，新插件应带 callId。

重试：权限类、一次性支付类禁止自动重试。读配置可以重试。重试要幂等，原生用 requestId 去重。用户连点按钮会发出两次 invoke，没有去重就会下两单。去重发生在原生事务层，不发生在「按钮 setState loading」——loading 挡不住双 Engine、挡不住 EventChannel 回放。

幂等和 EngineGroup 交叉：两份 Engine 各 invoke 一次「初始化 SDK」，进程级 SDK 初始化两次可能炸。原生用原子布尔。Dart 的 static 布尔帮不上另一份 Isolate。这又回到「Java static 是进程级」——这里反而要用进程级去重，是少数 static 合法的场景。合法 static 写进注释「进程级幂等」，避免被下一轮「去掉所有 static」的清理误删。

序列化层再补一条：\`NaN\` / \`Infinity\` 在 Standard codec 的 double 里可以编码，JSON codec 不一定。两端要用同一 codec，且业务要决定 NaN 是错误还是合法。传感器数据出现 NaN 原样传到图表，会让路径变成空洞。Channel 边界上校验有限性，比在图表里防御更早。

包体积与反射：Java 插件用反射找方法，Proguard 会把方法名 strip 掉，Release \`MissingPluginException\`、Debug 正常。keep 规则必须进插件 AAR。iOS 的 strip 同理。Channel 字符串方法名让反射/动态分发很诱人，也让混淆很危险。Pigeon 生成的显式方法更抗混淆。选择 Pigeon 不只是类型安全，还是 Release 存活率。

最后，Channel 与 Isolates 的 token：\`RootIsolateToken\` 在 Flutter 3 之后才能从 background isolate 发消息。老代码在 worker 里直接 \`MethodChannel\` 会抛。升级 Flutter 后搜 \`Isolate.spawn\` 附近有没有 Channel，补 \`ensureInitialized\`。漏掉的表现是「后台压缩完无法通知原生保存」，只在走 worker 的机型上出现，难复现。把 token 初始化放进 worker 入口模板，不要让每个业务自己记。

协议评审加一项：这个方法的最大 payload、调用频率、失败是否可重试、是否必须主线程。四项写在注释头里。缺一项不合并。Channel 的事故几乎都能追溯到这四项里某一项是空白。空白不是「以后补文档」，是运行时的未定义行为。把四项当签名的一部分，和类型一样硬。

至此 Channel 可以收成一张检查表，但不要当空话：名字带域名、codec 两端同一份、handler 按 Engine 实例、result 只回一次、payload 有大小桶、主线程只做主线程的事、超大或每帧走别的通道。检查表每一项都对应过一次事故。新插件对照着写，比对照着「最佳实践」十原则有用，因为每一项都能指出失败时的异常类型和线程。

对照这张检查表合并插件时，把「主线程只做主线程的事」写成代码结构：handler 里立刻把 \`call\` 丢进后台，主线程返回。结构保证比注释保证硬。其余项同理，能写成封装就不要写成提醒。

做完这些，Channel 就不再是「调原生的黑盒」，而是一条有大小、有线程、有版本的消息总线。总线该瘦。瘦了才稳。

## 12. 小结

Channel 是 Codec 加跨线程消息队列。\`MethodChannel\` 只是在字节上印了方法名。拷贝和异步是消息语义的不变量，不是实现缺陷。大缓冲、每帧数据、同步 layout 查询，这三件事不走这条路。把插件当 RPC 服务来设计：稳定 code、按 Engine 注册、主线程只做必须在主线程的事，Channel 就会安静地待在它该待的层。`,

  "flutter-ffi-zero-overhead-interop": `把 FFI 理解成「更快的 MethodChannel」，会在指针释放、线程和异常这三个地方把进程打崩。Channel 的模型是消息：拷贝、异步、失败是 \`PlatformException\`。FFI 的模型是 **C ABI 上的直接函数调用**：同一进程、同一地址空间、默认同一条线程、没有编解码、没有队列、GC 看不见 C 堆。性能来自中间层消失，use-after-free 也来自中间层消失。

读完你应该能独立回答三个问题：\`Pointer.asTypedList\` 的生命周期谁保证、为什么重计算仍会掉帧、C++ 异常为什么不能翻过 \`extern "C"\`。

## 1. 先画边界：调用模型完全不同

| | Platform Channel | FFI |
|---|---|---|
| 单位 | 编码后的消息 | C 函数 + 指针 |
| 线程 | 必经 Platform Runner | 默认就在调用者线程 |
| 内存 | 拷贝 | 共享（你自己证明安全） |
| 失败 | 异常对象 | 未定义行为 / 进程死 |
| 对象 | 只能传 Codec 认识的值 | 传布局匹配的 struct / 指针 |
| 系统 UI | 适合 | 不适合（去调 UIKit 是你自己的 UB） |

\`dart:ffi\` 让 Dart 拿到一个函数指针，按平台 C ABI 压栈、跳转、取值。没有方法名字符串，没有 \`StandardMessageCodec\`。\`lookup\` 失败发生在加载期；调用期的错误，C 不会替你变成 Dart 异常。

\`\`\`dart
final dylib = DynamicLibrary.open('libcodec.so');
final decode = dylib.lookupFunction<
    Int32 Function(Pointer<Uint8>, Int32),
    int Function(Pointer<Uint8>, int)>('codec_decode');
\`\`\`

\`lookupFunction\` 的两个类型参数分别是 C 侧签名和 Dart 侧签名。整数宽度必须对齐：C \`int\` 在 LP64 上是 32 位，对应 \`Int32\`，不是 Dart \`int\` 的 64 位幻觉。指针在 64 位上是 \`Pointer<…>\`，不要先转 \`Int32\`。

Dart 3 的 \`@Native\` 注解把 lookup 收进编译期，原理不变：仍是 C ABI，仍是你管内存。

## 2. 内存：两块堆，一种视图

Dart 堆上的 \`Uint8List\` 会被 GC 移动（除非是外部 typed data）。C 堆上的 \`malloc\` 字节不会。FFI 的零拷贝来自 **让 Dart 直接看 C 的那一段**：

\`\`\`dart
final p = calloc<Uint8>(n);
final view = p.asTypedList(n);
// view[i] = ... 直接写 C 堆
nativeProcess(p, n);
calloc.free(p); // 此后 view 就是悬空的
\`\`\`

\`asTypedList\` 造的是外部 typed data：Dart 侧像 \`Uint8List\`，底层指针仍是 \`p\`。不变量：

- **视图不得活过 \`free\`。** GC 不会在 \`free\` 时把视图作废。你要自己把 view 的最后一个引用和 \`free\` 排好序。
- **不要对可能移动的 Dart 堆取指针再交给异步 C。** \`Uint8List\` 的 \`.asPointer()\` 一类扩展若存在，也只在「C 函数同步用完就返回」时安全。异步回调里用这份指针是 UAF。
- **Dart 对象指针不能当 C 指针传。** Isolate 的对象头、GC 移动、压缩指针，C 一概不懂。要跨回调保住 Dart 对象，用 \`NativeCallable\` 或 \`SendPort\`，不要传 \`Object\` 的地址。

\`NativeFinalizer\` 把「C 资源的释放」绑到 Dart 对象不可达上：

\`\`\`dart
final finalizer = NativeFinalizer(dylib.lookup('codec_free'));

class CodecBuffer implements Finalizable {
  CodecBuffer(this.ptr) {
    finalizer.attach(this, ptr.cast(), detach: this);
  }
  final Pointer<Uint8> ptr;
}
\`\`\`

它解决的是「忘了 \`free\`」。它不解决「还在用就 \`free\`」——\`detach\` 再手动释放，或保证 C 侧不再持有。Finalizer 在哪个线程跑，也不保证是分配时的线程；C 的 \`free\` 一般可以，C++ 对象带锁的析构要自己确认。

\`Arena\`（\`package:ffi\`）适合「一次调用范围内的临时分配」：函数返回就释放。不要把 Arena 分配的指针存进全局给下一帧用。

## 3. 线程：零切换是默认，不是优点本身

FFI 调用发生在 **当前 Dart Isolate 的 OS 线程** 上。根 Isolate 绑 UI Runner。所以：

- 在 \`build\` / 手势 / \`onTap\` 里调 20ms 的 C 函数，和写 20ms 的 Dart 循环一样掉帧。没有 Channel 那种「至少把重活甩到主线程以外」的意外保护——Channel 反而可能把活甩到 Platform 线程（然后 ANR）。FFI 更直接：谁调用谁阻塞。
- 正确的重活路径：\`Isolate.run\` / \`compute\` / 长期 worker Isolate 里调 FFI。C 库若自己开线程，必须和 Dart 约定「回调怎么回去」。
- \`NativeCallable.listener\` 可以从任意 C 线程把调用投进 Isolate 事件循环。\`NativeCallable.isolateLocal\` 只能在创建它的 Isolate 线程调。选错会静默丢回调或断言。
- \`isLeaf: true\`（leaf FFI）告诉 VM「这个 C 函数不会再调 Dart、不会再进 VM」。于是 VM 可以少做过渡工作，调用更快。C 里若回头调 \`Dart_PostCObject\` 或任何 Dart API，就是未定义行为。短、纯、不回调的函数才标 leaf。

不变量：**C 线程 ≠ UI Runner ≠ Platform Runner。** 从 C 线程直接碰 \`JNIEnv\`、UIKit、\`dart:ui\` 对象，三种都是错。要碰 Android 系统 API，回到 Channel 或自己 \`AttachCurrentThread\` 且不碰 Flutter JNI 表。要碰 Flutter 纹理，走 Texture registry 的文档路径。

引擎自己的 Raster 线程更不能跑你的 FFI——你也调不到，除非你把指针偷过去。不要偷。

## 4. ABI、结构体、C++ 的边界

FFI 只保证 C ABI。C++ 的 \`std::string\`、虚表、name mangling、异常表，一律不在契约里。

- 导出用 \`extern "C"\`。符号名才能 \`lookup\` 到。
- 结构体按 \`Struct\` 写字段，注意对齐。\`Packed\` 才对应 \`__attribute__((packed))\`。一边 pack 一边不 pack，字段会错位，表现为「随机数值」而不是立刻崩溃。
- 不要把 \`std::vector\` 当结构体传。传 \`data()\` 指针 + \`size\`。
- C++ 异常必须在 \`extern "C"\` 边界捕掉，变成错误码。翻过边界进入 Dart 是未定义行为，移动端上常见于「偶发 native crash，堆栈在 \`libdart\`」。
- 虚函数：传对象指针加一套 C 函数表（自己做 vtable），或只暴露 C API。

\`\`\`c
// codec_api.h
#ifdef __cplusplus
extern "C" {
#endif
typedef struct { uint8_t* data; int32_t len; } CodecSpan;
int32_t codec_decode(CodecSpan in, CodecSpan* out);
void codec_free(void* p);
#ifdef __cplusplus
}
#endif
\`\`\`

\`out\` 指向的内存谁分配，必须写进函数文档。常见约定：callee \`malloc\`，caller \`codec_free\`。两边 \`free\` 或两边都不 \`free\`，都是事故。

动态库加载：Android 用 \`System.loadLibrary\` 后再 \`DynamicLibrary.open\`，注意 ABI split（armeabi-v7a / arm64-v8a）。iOS 常用静态链进 Runner，然后 \`DynamicLibrary.process()\`。符号被 strip 掉会 \`lookup\` 失败。Release 的 \`strip\` 配置要给导出符号留口。

## 5. 生命周期：指针、Isolate、库卸载

一份典型热路径会跨越三种寿命：

1. **调用栈寿命：** 参数指针只在此次 C 调用内有效。
2. **Dart 对象寿命：** \`NativeFinalizer\` 绑定的 buffer。
3. **Isolate 寿命：** worker 死了，还在跑的 C 线程必须停止往回 post。否则向已死 Isolate 发消息会丢，或 native 还持有 isolate 的 callback 指针 → 崩溃。

\`RootIsolateToken\` / \`NativeApi.initializeApiDL\` 是 C 调回 Dart 的前提。没初始化就 \`Dart_PostCObject\`，VM 不认识你。每个 Isolate 要单独保证 callback 的可调用性；不要假设「在主 Isolate 建的 \`NativeCallable\` 能在 worker 里调」。

库卸载：热重载不卸载 \`.so\`。真正的进程退出才卸。长期存活的 C 全局状态会在热重载后和「新的 Dart 世界」共存——Debug 里表现为单例对不上。C 侧单例按进程活，Dart 侧单例按 Isolate 活。多 Engine、多 Isolate 时这是 bug 源。

## 6. 和 Channel、Isolate 怎么拼

三种跨界手段经常一起出现，职责必须互斥：

- **Channel：** 权限、UI、系统服务、一次性配置。主线程、消息、安全失败。
- **FFI：** 编解码、加密、物理、图像处理算法。同一线程或 worker，共享缓冲。
- **Isolate：** 把 FFI 重活从 UI 挪走。Isolate 之间仍然不能共享可变 Dart 对象；但 **可以共享 C 堆指针**（同一进程）。这是真正的零拷贝跨 Isolate：worker 写 C 缓冲，把地址当 \`int\` 发给主 Isolate，主 Isolate 包成 \`Pointer\` 再上传纹理。前提是所有权协议：谁 free、何时 free、主 Isolate 是否还在读。

不要把 C 指针塞进 Channel 当 \`int\` 发给 **另一个进程**。Channel 能出进程边界（理论上），指针不能。同进程插件用 Channel 传指针也是坏味道：类型是假的，生命周期更假。

## 7. 设计取舍

- **零中间层：** 纳秒级调用、零拷贝视图。代价是 UB 回到工程现场。
- **默认同线程：** 没有意外的线程跳。代价是 UI 调用即卡顿。
- **C ABI 最小公约：** 任何语言都能出 C API。代价是 C++ / Rust 都要做一层薄包装。Rust 用 \`extern "C"\` + \`repr(C)\` 是目前最干净的搭档。
- **GC 不管 C 堆：** 没有扫描开销。代价是泄漏和 UAF 要自己的工具（ASan、leak tracer、\`NativeFinalizer\` 计数）。

「零开销」是相对 Channel 的编码和队列而言。它不是相对正确的算法而言。一份没向量化的 C 循环，不会因为从 Dart 能直接调用就变快。先保证 leaf、同缓冲、少分配，再谈 FFI 本身的纳秒。

## 8. 排障

1. **随机 crash 在 \`asTypedList\` 之后：** 已经 \`free\`。把 \`free\` 和最后一个 view 使用放到同一次所有权转移里，或改 \`NativeFinalizer\` 且禁止手动 \`free\`。
2. **UI 掉帧但 C 函数「很快」：** 量实际耗时。20ms 的「很快」在 60Hz 是整帧。搬到 Isolate。\`Timeline.startSync\` 包一层就能在 DevTools 里看见。
3. **\`lookup\` 失败：** 符号名 mangled、被 strip、Android ABI 目录不对、iOS 没加进 \`Other Linker Flags\`。\`nm\` 看导出表。
4. **数值全错、不崩：** 对齐、\`Int32\` vs \`Int64\`、endian（极少数）、\`Packed\`。先 \`sizeof\` 对一下 Dart \`sizeOf<T>()\` 和 C \`sizeof\`。
5. **C++ 异常 / \`std::terminate\`：** 边界没 catch。用错误码。
6. **多 Isolate 双 free：** 指针当 \`int\` 传来传去，两边都觉得自己是 owner。所有权只写在一个方向：callee alloc / caller free，或相反，永不对称。
7. **Debug 正常 Release 崩：** leaf 标错、LTO 把符号吃了、C 依赖未定义行为被优化放大。

ASan 编一份 debug \`.so\` 比在 Dart 里加 log 有效得多。FFI 的 bug 多数不是 Dart 逻辑错。

## 9. 工程上真正的热路径长什么样

一次图像滤镜的正确形状：IO 线程或 worker Isolate 读文件 → C 堆分配输出缓冲 → leaf FFI 处理 → 把指针交给 UI Isolate → \`decodeImageFromPixels\` 或直接 \`Texture\` 上传 → \`NativeFinalizer\` 在 \`Image\` 释放后 \`free\`。全程没有 Channel，没有 \`Uint8List.fromList\`，没有在 UI Isolate 上跑滤镜。

错误形状：\`Image.memory(await channel.invokeMethod('filter', bytes))\`。这里有三次拷贝（去、回、解码），两次线程跳，还可能在主线程滤镜。

## 10. 结构体、数组、ffigen：布局必须对得上 sizeof

\`Struct\` 的字段顺序、对齐、padding 必须和 C \`sizeof\` / \`offsetof\` 一致。Dart 的 \`sizeOf<T>()\` 在运行时给你一份数字，CI 里用 assert 和 C 侧打印的 \`sizeof\` 对一下，能消灭一类「某机型数值全错」。

\`\`\`dart
final class Vec2 extends Struct {
  @Float()
  external double x;
  @Float()
  external double y;
}

final class PathHeader extends Struct {
  @Int32()
  external int count;
  external Pointer<Vec2> points;
}
\`\`\`

\`@Array(16)\` 做内嵌数组。指针数组是 \`Pointer<Pointer<Vec2>>\`，不是 \`Pointer<Vec2>\` 的 Dart List。从 C \`malloc(n * sizeof(Vec2))\` 拿到的连续缓冲，用 \`ptr.asTypedList\` 做的是字节视图；要按结构走，用 \`structPtr[i]\` 这种 \`Pointer\` 下标（步长是 \`sizeOf\`）。

\`Packed\` 对应 C 的 packed。网络协议、文件头才需要。CPU 上未对齐访问在部分 ARM 上慢或 trap。能不 pack 就不 pack。

\`ffigen\` 从头文件生成这些 \`Struct\` 和 \`lookupFunction\`。它消灭的是手写签名漂移，不消灭 ABI 本身。C++ 头要有 \`extern "C"\` 的那一层。宏、位域、未命名 union、va_list，ffigen 会放弃或生成不可用代码。位域改成整型 + mask。

\`@Native<Int32 Function(Pointer<Uint8>, Int32)>(isLeaf: true) external int codecDecode(Pointer<Uint8> p, int n);\` 把符号解析推迟到编译期/加载期，调用点更像普通函数。\`asset\` 路径可把 \`.so\` 当 Flutter asset 打包。原理没变：leaf 仍禁止回调 Dart。

不支持的东西要记成边界：变参函数、C++ 异常、成员函数、线程局部和 Dart Isolate 的映射。不要用 FFI 调 \`printf\` 这类变参。封装成固定参数的 C 函数。

## 11. 从 C 调回 Dart：消息循环才是安全点

C 线程上的回调想进 Dart，只有几条合法路：

1. **\`NativeCallable.listener\`：** 创建时绑在某 Isolate。C 任何线程调这个函数指针，VM 把调用投进该 Isolate 的事件循环。参数必须是 FFI 能拷的（整数、指针），不能是 Dart 对象。
2. **\`Dart_PostCObject\` / \`SendPort.nativePort\`：** C 组一份 \`Dart_CObject\` 发到 port。适合流式数据。要 \`Dart_InitializeApiDL\`。Isolate 死后 port 无效，C 必须能停。
3. **自己的无锁队列 + Dart 侧 \`Timer\`/\`scheduleMicrotask\` 轮询：** 最土也最可控。适合音频回调这种不能阻塞、不能等 VM 的实时线程。

非法路：在 C 音频回调里直接碰 \`JNIEnv\` 调 FlutterJNI、在 Raster 线程 \`SendPort.send\`、把 Dart 对象指针存进 C 全局。崩的堆栈会在 \`libdart.so\` 里，看起来像 VM bug。

\`\`\`c
// 合法：只投递指针和长度，不碰 Dart 堆
void on_frame(uint8_t* p, int n) {
  Dart_CObject type;
  type.type = Dart_CObject_kInt64;
  type.value.as_int64 = (int64_t)p;
  Dart_PostCObject_DL(g_port, &type);
}
\`\`\`

所有权：C 认为 post 之后 Dart 会 \`free\`，Dart 认为 C 还会写这块缓冲——这是 use-after-free 的剧本。协议写成「双缓冲，C 写 A 时 Dart 读 B，用序号握手」或「Dart 拷走再回 ack，C 才能 reuse」。实时系统用双缓冲；普通解码用 ack。

Rust 侧 \`extern "C"\` + \`#[repr(C)]\` + \`no_mangle\` 是目前最不容易在析构和异常上翻车的搭档。\`panic\` 必须 \`catch_unwind\` 成错误码，不能进 Dart。\`flutter_rust_bridge\` 生成的是 FFI + 一套所有权约定，它没有取消 ABI，只是把 \`free\` 和错误码写成了代码。出了 UAF 仍然是你的指针问题，不是「桥」的锅。

### 分配器、对齐、以及 Dart_InitializeApiDL 的版本

\`malloc\` 不对齐清零；\`calloc\` 清零。结构体里未赋值的指针字段是随机值，C 一解引用就崩。用 \`calloc\` 或显式赋 \`nullptr\`。\`posix_memalign\` / \`aligned_alloc\` 在 SIMD 和某些 GPU 上传路径上需要。\`Allocator\` 接口可以换成 arena。不要混用：\`malloc\` 的指针 \`delete\`，或 Arena 释放后还 \`free\`。

64 位上 \`size_t\` 是 8 字节，对应 \`Size\` / \`Uint64\`，不是 \`Int32\`。文件长度、缓冲大小用错宽度，大文件截断。

\`Dart_InitializeApiDL\` 必须用当前 VM 的 \`NativeApi.majorVersion/minorVersion\`。\`.so\` 和 Flutter 引擎版本不匹配时，API DL 初始化失败，C 调回看起来像「偶尔成功」——其实你用了错误偏移的函数表。插件的 \`.so\` 要和 Flutter 版本一起发，不要假设用户设备上的 \`libflutter.so\` 永远和编译时一致（embedder 场景尤其如此）。

### 热路径上的拷贝清单

一次「零开销」滤镜仍可能悄悄拷贝：

1. Dart \`Uint8List.fromList\` 从网络来的数据——拷。
2. 为了拿指针，\`calloc\` + \`memcpy\`——拷。
3. C 输出到新缓冲——合理的一份。
4. \`Uint8List\` 包装再 \`decodeImageFromPixels\`——可能再拷进 \`ui.Image\`。
5. 上传 GPU——设备相关，常是 DMA，不算你的堆。

能消掉的是 1 和 2：网络直接读进 C 堆或 \`ImmutableBuffer\`，FFI 原地处理。\`decodeImageFromPixels\` 的像素格式、行对齐必须和 C 输出一致，否则颜色错还要再转一遍。

\`isLeaf: true\` 的函数里做 \`malloc\` 可以（不进 VM），但 leaf 里不要等锁太久——你堵的是 UI 或 worker 线程。锁竞争不是 FFI 层能消的，是 C 库自己的线程模型。

### 调试符号与崩溃归类

Release \`.so\` 无符号时，Crashlytics 里只有偏移。保留一份 unstripped 给符号化。崩溃在 \`Dart_Invoke\` / \`Precompiled...\` 不一定是 Dart 逻辑错，可能是 C 写越界破坏了堆，过一会儿 GC 才炸。ASan 编的 debug so、以及在 C 边界做 canary，比在 Dart 里加 try/catch 有用——FFI 调用默认 **不** 把 C 的 SIGSEGV 变成 Dart 异常。

### 一份可维护的 FFI 封装形状

不要在 Widget 里 \`lookupFunction\`。做成：

1. \`codec_api.h\`：纯 C，文档写清谁 alloc/free、线程、错误码。
2. 薄 \`.cc\`：捕 C++ 异常，转错误码，\`extern "C"\`。
3. \`ffigen\` 出 \`codec_bindings.dart\`。
4. 手写 \`CodecBuffer\`：持有 \`Pointer\`、\`NativeFinalizer\`、长度，暴露 \`Uint8List\` 视图方法但不把视图存成字段（避免视图活过 buffer）。
5. \`CodecWorker\`：长期 Isolate，SendPort 收任务，内部调 FFI，回传「指针整型 + 长度」或拷贝后的小结果。
6. UI Isolate 只收「已完成的 ui.Image / 路径」，不收生指针——除非你有严格的帧同步。

错误码不要用「返回 nullptr 表示失败」又同时让 nullptr 表示空输入。\`int codec_last_error()\` 或 out 参数。Dart 侧转成异常。异常发生在 Dart，C 已经回到稳定状态（无锁、无半初始化单例）。

测试：VM 里用 \`dart:ffi\` 跑纯 Dart 测试即可，不必起 Flutter。用黄金输入输出字节。ASan 构建单独 CI job。不要只在真机「看起来画面对」——那测不到越界。

### 和 dart:ui 对象的边界

\`ui.Image\`、\`ui.Scene\`、\`ui.Path\` 不是 FFI 结构体，不能把它们的 Dart 句柄当 C 指针解。Engine 暴露的 C API（\`FlutterEngine\` embedder API）是另一套，给 **嵌入者** 用，不是给 App FFI 用。App 里想把像素变成 \`ui.Image\`，用 \`decodeImageFromPixels\` / \`ImmutableBuffer\`。想把纹理给 Flutter 显示，用 Texture registry。想自己调 Metal，你已经在写引擎扩展，不是业务 FFI。

\`Pointer.fromAddress(int)\` 可以从 SendPort 传来的整数恢复指针。整数在 Dart 里是 64 位，足够装指针。不要截成 32 位再传。Isolate 之间传 \`int\` 是拷贝一个整数，不是拷贝缓冲——这就是零拷贝的那条缝。安全完全取决于整数还指不指着有效内存。

### 错误码、半失败、以及重入

C 函数返回「写了 3 个输出里的 2 个然后失败」，Dart 侧很难清理。约定：失败则所有 out 指针要么不变，要么 callee 已 free。成功才转移所有权。文档写 \`on error, no ownership transfer\`。Dart 只在 \`rc == 0\` 时 attach \`NativeFinalizer\`。

重入：C 回调里再调回 Dart，Dart 又调这个 C 函数。非 leaf 允许，但 C 库要能重入或明确禁止。禁止的话用线程局部「in_call」断言。音频回调线程禁止任何会锁的 Dart 往返——只投递。

### 动态库查找路径

Android \`System.loadLibrary("codec")\` 依赖 \`jniLibs\` 或 Prefab。\`DynamicLibrary.open("libcodec.so")\` 在 load 之后才能。只 open 不 load，旧设备可能找不到。iOS \`DynamicLibrary.process()\` 要求符号被链接进主二进制或 \`-force_load\`。静态库里的符号被 dead-strip 掉是 Release 独有事故：Debug 还在，Release \`lookup\` 失败。\`__attribute__((used))\` 或显式导出列表。

macOS 桌面还要注意沙盒和 \`@rpath\`。Windows 注意 \`codec.dll\` 的运行库（MT/MD）和 Flutter 的 CRT 一致，否则跨 CRT \`malloc/free\` 崩。

### 性能对照实验怎么写才公平

对比 Channel vs FFI：同一份输入、同一线程、预热后测稳态，再测含首次 lookup 的冷路径。FFI 的 lookup 和 \`asFunction\` 有一次性成本，应放在 isolate 启动，不要放进每帧。Channel 的 codec 也有一次性。数字要分冷/热。热路径 FFI 赢是预期；冷路径上一次 100 字节配置 Channel 更简单，别为基准测试的漂亮数字把权限检查改成 FFI。

FFI 工程化的核心是把「指针」变成「带类型的资源对象」，让业务代码几乎看不见 \`Pointer\`。业务只看见 \`CodecBuffer\` / \`DecodedFrame\`，它们的析构（Finalizer 或显式 \`dispose\`）是唯一释放点。谁 \`clone\` 谁就多一次 dispose。这和 \`ui.Image\` 的契约故意对齐，降低心智。暴露 \`Pointer\` 给 Widget 层，三个月后必有 UAF。

线程策略写成库的 README 第一段：哪些函数 leaf、可在 UI 调（必须 < 1ms）；哪些必须 worker；哪些 C 内部自开线程、回调如何回 Isolate。没有这段，调用方会在 \`onTap\` 里解码 4K。审查 PR 先看调用线程，再看算法。

二进制发布：\`.so\` / \`.a\` 与 Flutter 引擎、NDK、C++ STL 版本钉在 lockfile。CI 编 ASan 与 Release 两份。符号表归档。崩溃匹配偏移。没有符号化的 native 崩溃，在 FFI 项目里等于没有崩溃报告。

不要用 FFI 调用 Objective-C / JNI。那是把运行时和异常模型再引入一遍，且极易在错误线程碰 UI。需要系统 API 走 Channel；需要算力走 FFI。中间状态（既要 UIKit 又要零拷贝）拆成：FFI 算出像素，Channel 或 Texture registry 交给视图。硬用 FFI 调 \`UIImage\` 是在借未来的崩溃。

最后一条不变量：**Dart GC 扫描不到的每一字节，都要有一个 Dart 对象当监护人。** 监护人消失，Finalizer 释放。没有监护人的裸指针，只允许活在一次同步调用栈上。跨 await、跨 isolate、跨帧，必须升级为有监护人的对象。这条比任何工具都能减少 UAF。工具用来抓漏网的。监护人策略用来让漏网变少。

FFI 与安全编译选项必须进构建：\`-fstack-protector\`、\`-D_FORTIFY_SOURCE=2\`、Android 上 \`FORTIFY\`、尽可能 \`-fno-exceptions\` 因为异常已在边界捕掉。C++ 仍开 RTTI 只会增肥。Rust \`panic=abort\` 在移动端可接受，前提是 abort 前把错误日志写出去，否则用户只看见闪退。

32 位设备（若仍支持）上指针 4 字节，Dart \`int\` 仍 64。\`Pointer.fromAddress\` 没问题，但 C \`int\` 长度 32，文件 offset 用 \`int\` 会在 2GB 截断。移动端图片缓冲很少到 2GB，资产文件可能。用 \`int64_t\` 传长度。ffigen 对 \`off_t\` 的映射要人工检查。

模拟器和真机 ABI 不同：iOS 模拟器是 arm64 或 x86_64，\`.a\` 要 lipo。Android 模拟器 x86_64 经常被团队忘了编 so，表现为「只有模拟器 FFI 失败」。CI 矩阵含模拟器 ABI 或明确不支持并在启动时检测。

文档里给一份「禁止清单」比允许清单短：禁止 FFI 调 UI；禁止跨 await 裸指针；禁止 leaf 回调 Dart；禁止 C++ 异常出边界；禁止在 UI Isolate 跑 >1ms 的 FFI；禁止双 owner free。代码审查对着清单打勾。清单外的才需要讨论。FFI 的复杂性来自例外，不来自 lookupFunction 那三行。

与 Channel 共存时的启动顺序：先 \`NativeApi.initializeApiDL\`（若需要），再 loadLibrary，再 lookup，再 \`NativeFinalizer\` 绑定，最后业务可用。顺序反了会「偶发 null function pointer」。把顺序写成 \`CodecRuntime.ensure()\` 单例（Isolate 级），\`main\` 和 worker 入口都调。不要散落在各个页面 \`initState\`。页面 initState 太晚，也太多次。

把 FFI 库的发布当成 native SDK 发布：semver、changelog、最小系统版本、NDK 版本。Dart 包装版本和 so 版本一起涨。出现「Dart 包装 2.0 + 旧 so」要用符号 \`codec_abi_version\` 启动时比对，不匹配就拒绝调用并打错误，而不是随机崩溃。ABI 版本是整数，放 .so 导出符号，Dart lookup 得到。这比靠文件名约定可靠。

内存工具：Android 用 heapprofd 看 native alloc，iOS 用 Allocations 过滤非 Dart 堆。FFI 泄漏在这些图上是持续上涨的 malloc，而 Dart DevTools 是平的。两张图一起看才能证明「不是 Dart 的锅」。证明完再进 C 代码，不要反过来在 Dart 里加 delay 碰运气。

最后一个工作流：改 C 边界必须同时改黄金字节测试、ffigen、Dart 包装、文档谁 free。四份 diff 缺一不合并。边界变更是 FFI 里最贵的变更，故意让它贵，才能保持少变。少变是零开销能持续的前提——否则你每周都在修 UAF，性能数字再好看也上不了线。

跨语言字符串：C 要 \`const char*\` 以 \`\\0\` 结尾，Dart \`toNativeUtf8\` 分配的是临时块，必须 free。生命周期仍是同步调用栈。把 \`Pointer<Utf8>\` 存起来跨帧，C 读到的是已释放或被复用的堆。路径、错误信息这种短字符串，宁可每次拷，不要玩零拷贝。零拷贝留给像素和 PCM，不要留给字符串显得专业。专业体现在所有权写清楚，不体现在每一字节都不拷。

FFI 落地时还要把构建系统当成产品：Android 用 CMake + Prefab 或 \`jniLibs\`，iOS 用 CocoaPods vendored 或 xcframework。符号可见性默认 hidden，只导出 \`codec_*\`。隐藏符号减少冲突，也减少别人乱 lookup 你的内部函数。内部函数一旦被业务 lookup，你就没法改布局。导出面小，是 ABI 稳定的前提。

调试器：NDK gdb/lldb 能在 Dart 调 C 的地方下断点。学会在 Android Studio 里 attach 到带 so 的进程。只会 Dart 调试器的团队，FFI 问题会拖成「偶现 native crash」无限期。技能清单要写进组内 onboarding。

与 Isolate 的 CPU 亲和：worker Isolate 默认普通线程，可能和 UI 抢大核。重任务可在 C 里用线程池，Dart 只投递。但线程池大小要考虑和 Flutter IO Runner、编解码器抢核。池太大，低频掉帧；太小，吞吐不够。数字用 trace 看调度延迟，不要抄「CPU 核数×2」。

版权与安全：引入的 C 库许可证、CVE。FFI 让你把别人的 C 堆进进程，漏洞也进进程。依赖扫描覆盖 so，不只覆盖 pubspec。这和「零开销」无关，和「零中间层所以零隔离」有关。Channel 调另一个进程还能有进程隔离（少见）；FFI 从来没有。选 FFI 就是选同一命运。认清这一点，审核会认真一点。

FFI 与产品灰度：so 随 App 发，不能像 Dart 热更新那样随便换算法。要热更算法，把算法放 Dart 或放可下发的脚本，C 只留稳定原语（卷积、FFT）。原语稳定，产品逻辑灵活。反过来把产品逻辑写进 C，发版周期被商店绑死。选 FFI 的边界也是选发版边界。把会变的留在 Dart，把稳的、热的留在 C。这条产品约束和内存所有权一样，决定你两年后还敢不敢改这块代码。敢改，是因为 C 面小；不敢改，往往是因为当初图快把业务塞进了 so。

把「监护人对象」落实到代码模板：每个导出的分配函数都有对应的 Dart class，class 创建即 \`attach\` Finalizer，\`dispose\` 可提前 \`detach\`。模板放在仓库 \`ffi/README\`。没有对应 class 的 \`Pointer\` 不允许出现在 \`lib/\` 业务目录，只允许出现在 \`lib/ffi/raw/\`。目录墙比规范有效。墙的另一侧是生成代码和 raw binding，允许丑；业务侧只看见 class。丑和安全被隔开，审查才审查得完。完了，零开销才不是零纪律。

至此 FFI 的地图可以叠在专栏第一篇的 Engine 图上：它不经过 Platform Runner，不经过 Codec，直接在当前 Isolate 的线程上跳进 C。因此它既跳过了 Channel 的保护，也跳过了 Channel 的成本。保护要用监护人、错误码、leaf 承诺自己补；成本要用 worker 把重活从 UI Runner 挪走。补完这两头，零开销才是可上线的零开销，而不是演示里的零开销。演示总是同步、短、不释放。线上总是异步、长、有人忘释放。模板和目录墙是为线上写的。演示代码进不了 \`lib/\`。

上线前用 ASan 跑一遍黄金输入，用符号化验证崩溃管道。管道不通，等于飞行无黑匣子。有黑匣子，UAF 才是可修的事故而不是传说。传说不能迭代。事故可以。FFI 允许事故进进程，所以必须允许事故被看见。看见，是零开销互操作对工程的最后一项要求。

## 12. 小结

FFI 是同一进程里的 C 调用。零开销来自没有消息和没有队列；正确性来自你能证明指针、线程、异常三条边界。和 Channel 的分工是一致性模型不同：一个把失败变成对象，一个把失败变成崩溃。热路径用 FFI，系统 API 用 Channel，重活离开 UI Isolate。三条同时成立，才是「零开销互操作」，而不是把崩溃从 Java 换到 C。`,

  "flutter-platform-views-texture-hybrid": `在 Flutter 里嵌 WebView、地图、相机，等于让 **两套渲染器争同一块屏幕**。这不是「再包一个 Widget」那么便宜。Flutter 的默认假设是：Raster 线程独占 GPU，一帧的像素由 Impeller/Skia 画完，交给系统合成器。Platform View 打破的就是这条假设。三代方案的差别不在 Widget 名字，而在 **原生 View 的像素从哪条路径进入 Flutter 的 Layer 树，以及输入法、手势、合成器同步点落在哪里**。

读完你应该能独立回答三个问题：Virtual Display 为什么伤显存和焦点、Hybrid Composition 贵在几次合成、Texture Layer 仍然掉帧时该查哪条同步。

## 1. 先画边界：这是 Engine 最贵的例外

Framework 侧你看见的是 \`AndroidView\` / \`UiKitView\` / \`AndroidViewSurface\` / \`PlatformViewLink\`。它们都只是把一个 \`int viewId\` 和工厂回调交给 Engine。真正花钱的是 Embedder：

- 原生 View 的窗口 / Surface / 纹理从哪来
- 它的绘制和 Flutter 的 swapchain 如何同步（fence）
- 触摸先给 Flutter 还是先给原生
- IME、无障碍、截屏、截图谁能看见这块像素

不变量：

- Flutter 不再「一条 Raster 线程画完所有像素」。多了至少一次跨渲染器的汇合。
- 汇合要么发生在 **系统合成器**（多 Surface 叠层），要么发生在 **Flutter 合成器**（把原生帧当纹理采样）。
- 手势竞技场到这块矩形的边缘失效。原生 View 内部是另一套命中测试。
- 生命周期跟的是原生 View，不是 Element。Element unmount 必须把原生 View detach，否则窗口泄漏。

能用纯 Flutter 画出来的控件，不要嵌原生。这不是洁癖，是避免例外路径。

## 2. 三代方案：像素怎么汇合

### Virtual Display（VD）

Android 早期方案。Engine 申请一块 VirtualDisplay，让原生 View 画到这块虚拟屏的 Surface 上，再把结果当纹理贴进 Flutter Layer 树。

代价是刚性的：

- 虚拟屏有自己的分辨率和 DPI，和设备屏再采样一次，文字容易糊。
- 多一块离屏 GPU 缓冲，显存按 \`宽 × 高 × 4 × 缓冲数\` 涨。
- 输入法和焦点要跨虚拟屏，历史 bug 多：键盘弹不出来、IME 高度不对、光标错位。
- 无障碍桥要再映射一层。

它实现简单，所以曾经是默认。现在应视为淘汰路径，只在旧设备 fallback 时出现。

### Hybrid Composition（HC）

把 Flutter 自己的画面拆成多个原生 Surface（或 \`FlutterImageView\`），按 z 序插入：底下一块 Flutter、中间原生 View、上面再一块 Flutter（给悬浮按钮、工具栏）。系统合成器做最终叠层。

换来的是：原生 View 仍是「真 View」，IME、焦点、无障碍走系统默认路径，WebView 输入终于正常。

代价转到合成：

- 每多一块 Surface，系统合成器多一次 composition。部分 Android 设备（尤其是 OEM 的 Overlay 数量限制）会从 Overlay 掉到 GPU composition，整页掉帧。
- 圆角 clip、半透明、transform 动画迫使系统没法用 Overlay，退回 GPU。
- Flutter 侧「上面那一块」要和原生 View 对齐像素，滚动时容易出现一帧缝。
- iOS 的 \`UiKitView\` 本质上长期接近这种叠层：\`UIView\` 插在 \`FlutterView\` 层级里。

### Texture Layer Hybrid Composition（TLHC）

原生 View 画进一块 **共享 GPU 纹理**（或 \`SurfaceTexture\` / \`HardwareBuffer\`），Flutter 把它当 \`TextureLayer\` 采样，重新回到「单 swapchain 合成」。系统合成器只看见 Flutter 的那张最终 buffer。

这通常是 Android 10+ 的首选：少一次整窗拆 Surface，帧率和内存更好，圆角和透明度可以当普通 Layer 来 clip。

仍然要付的账：

- 纹理更新频率。相机 30fps 更新纹理，Flutter 60fps 采样，要靠 fence 等 GPU 写完。等久了掉帧，不等会撕。
- 尺寸变化、旋转、DPI 改变要重建纹理。动画里改 Platform View 的 size 等于每帧 alloc 纹理。
- 某些效果（需要「真 View」才能做的截屏、部分 WebView 硬件加速路径）会强制 fallback 回 HC。
- 输入法：纹理不是 View，焦点和 IME 仍要额外桥。TLHC 在这方面比 VD 好、比 HC 脆，具体随版本变。

| 方案 | 像素汇合点 | IME / 焦点 | 显存 | 合成开销 | 现状 |
|---|---|---|---|---|---|
| VD | 虚拟屏 → 纹理 | 差 | 高 | 中 | 淘汰 / fallback |
| HC | 系统合成器多 Surface | 好 | 中 | 高（设备相关） | iOS 默认思路；Android 特定场景 |
| TLHC | Flutter 纹理采样 | 中好 | 较低 | 较低 | Android 优先 |

## 3. 线程与同步点

Platform View 把线程模型从「UI 记账、Raster 上屏」扩成至少四家：

- **UI Runner：** 布局出一块矩形，Layer 树上挂 \`PlatformViewLayer\` 或 \`TextureLayer\`。
- **Platform Runner：** 创建/布局原生 View，转发触摸，处理 IME。这块在系统主线程，卡了就是 ANR。
- **原生 View 自己的渲染线程：** WebView、地图、相机各有各的。你控制不了。
- **Raster Runner：** 采样纹理或提交拆开的 Surface。

同步靠 GPU fence 或 Surface 的 \`dequeue/queue\`。不变量：**不要在 UI Runner 上等原生 View 画完。** 布局只决定矩形；像素可以晚一拍。追求「原生和 Flutter 像素同一帧对齐」会把流水线锁死，表现为两者一起掉帧。

触摸路径更乱。一次 down：

1. 系统先给 Flutter 的根 View。
2. Flutter HitTest 若打中 Platform View 矩形，Embedder 决定是否 \`claim\` 并把后续事件转给原生。
3. 原生内部再 HitTest。
4. 若 Flutter 同时有自己的手势（例如外层 \`Scrollable\`），两边都想跟手。Android 上靠 \`PlatformViewGestureMixin\` / eager 策略；iOS 上靠 \`gestureRecognizersBlockingPolicy\`。

竞技场规则到这里失效。你不能指望 \`VerticalDragGestureRecognizer\` 和 WebView 内部的滚动自动互斥。必须显式：要么让 Platform View 在 down 时 eager claim（内部可滚），要么让 Flutter 父级滚、原生不抢。两边都可滚是最糟的产品状态。

## 4. 内存与生命周期

原生 View 活在 Java/ObjC 堆，纹理活在 GPU，Layer 活在 C++ 堆，Element 活在 Dart 堆。四块要一起拆：

- Element unmount → Controller dispose → Embedder 从层级移除 View → 释放 Surface / 纹理。
- 只 \`setState\` 把 \`AndroidView\` 从树里拿掉却缓存了 controller，View 会成为「看不见的窗口」，继续耗电、接触摸。
- 列表里 \`AndroidView\`：滚动出视口应销毁或至少 \`keepAlive\` 有上限。同时存在的 WebView 数量是内存峰值，不是「缓存策略能抹平」的那种。
- \`AutomaticKeepAliveClientMixin\` 对 Platform View 很危险：它会把原生实例钉住。

显存估算不要看 Widget 数量。一块 1080×1920 的 WebView，RGBA 单缓冲约 8MB，双/三缓冲再乘。HC 模式下 Flutter 上下两层各一份；VD 再加虚拟屏。列表里三个全屏级 Platform View，百 MB 显存是正常数量级。

iOS 的 \`UiKitView\` 还参与 Auto Layout。在 \`performLayout\` 对应的那次主线程布局里改 UIView frame，会和 Flutter 的 layout 抢主线程。动画期间改 size 等于每帧触发布局约束求解。

## 5. 剪裁、透明、截屏：fallback 的真实原因

TLHC 看起来最好，但遇到这些绘制属性，Engine 可能静默 fallback：

- 对 Platform View 做 \`ClipRRect\` / \`Opacity\` / \`Transform\` 3D / \`ShaderMask\`
- 祖先 \`RepaintBoundary\` 要求和原生像素一起缓存
- 需要读回像素的截图 \`OffsetLayer.toImage\`

fallback 到 HC 或软件读回后，你看见的是「这个页面有时掉帧」。DevTools 里 Raster 变长，但 Dart 火焰图是干净的。排障要看平台侧是否在用 overlay，而不是再减 Widget。

\`toImage\` 一张含 WebView 的图，可能走 GPU readback，在主线程或 Raster 上停几毫秒到几十毫秒。不要在动画里截。

## 6. 设计取舍

- **嵌原生而不是重写 WebView/地图：** 换来生态和系统能力。代价是渲染器不再独占，所有「Flutter 很顺」的假设在这块矩形上作废。
- **HC 保真 View，TLHC 保帧率：** 输入法、无障碍、系统截屏 vs 单 swapchain。没有全赢的方案，所以 Engine 按能力和绘制属性动态选。
- **触摸交给原生内部：** WebView 才能滚。代价是外层 Flutter 滚动要自己让路。
- **每 View 一个 id：** 多 Engine 时 id 不能当进程全局。插件工厂必须按 engine 注册。

产品策略比技术策略更重要：能用 \`InAppWebView\` 的替代方案（自定义 Flutter 浏览器控件）通常仍更贵；能用 Flutter 地图瓦片代替 Google Map 原生 View，帧率会回到你能优化的世界。把 Platform View 当「少数例外」而不是「混排常规手段」。

## 7. 排障

1. **只有嵌了 WebView 的页掉帧：** 先确认当前是 VD / HC / TLHC（日志和 \`debug\` flag）。HC 就减 overlay 上的透明和圆角动画；TLHC 就减 size 动画和同时存在的实例数。
2. **键盘弹不出 / 焦点乱跳：** 怀疑 VD 或纹理路径的 IME 桥。试强制 HC。检查 \`resizeToAvoidBottomInset\` 和原生 \`windowSoftInputMode\` 是否双重处理。
3. **外层列表不能滑：** 原生 eager claim 了。改 gesture policy，或在 WebView 顶部留一段纯 Flutter 拖拽区。
4. **缝、闪、黑块一帧：** fence 没齐或纹理被重建。滚动中不要改 Platform View 的像素大小；用 transform 缩放（清楚代价）或固定 size。
5. **内存直线涨：** dump 原生 View 数量，不是 Dart ImageCache。Android Studio 的 View hierarchy 里能看见没 detach 的 WebView。
6. **截图是黑的：** 纹理/别的进程缓冲不允许 readback。改 HC 或系统截屏 API。
7. **iOS 还行 Android 不行：** 合成路径不同。按上表分开治，不要写一套「优化」两端共用。

## 8. 工程约束清单（不是套话，是不变量的推论）

- 同时存活的 Platform View 设硬上限。
- 动画改 offset / opacity 可以；改 size 不行。
- 不要把 Platform View 放进每帧重建的父级（无 Key 的列表项）。
- 手势策略写进组件文档：谁滚、谁点。
- 销毁路径要测：快速进出页面不应残留 Surface。

## 9. 和 Texture Widget 的差别

\`Texture\`（相机插件常用）不是 Platform View。它没有原生 View 层级，只有一个纹理 id，Flutter 当 \`TextureLayer\` 画。没有 IME，没有原生命中测试，手势全是 Flutter 的。能用 Texture 就不要升级成 Platform View。相机预览、外接播放器解码帧，Texture 是正确档位；需要 DOM、需要系统输入法，才升档。

## 10. 平台 API 怎么选：AndroidView、UiKitView、Texture

Framework 给你的入口已经暗示了汇合路径：

- \`AndroidView\`：老路径，容易落到 VD 或 HC，兼容旧机，性能上限低。
- \`AndroidViewSurface\` / \`PlatformViewLink\` + \`AndroidViewController\`：新路径，优先 TLHC，失败才 HC。
- \`UiKitView\`：iOS 把 \`UIView\` 插进层级，接近 HC。\`UiKitView.viewType\` 对应原生工厂。
- \`HtmlElementView\`：Web 上是 DOM overlay，又一套合成器（浏览器）。不要用移动端的 TLHC 经验套 Web。
- \`Texture\` + \`TextureRegistry\`：没有原生 View。相机、播放器解码帧走这里。

创建参数走 Channel 的 codec。\`creationParams\` 太大（把整份 HTML 当参数）会在主线程编码。WebView 用 url 或后续 \`loadHtml\`，不要把 2MB HTML 塞进创建参数。

\`\`\`dart
PlatformViewLink(
  viewType: 'app.map',
  surfaceFactory: (context, controller) {
    return AndroidViewSurface(
      controller: controller as AndroidViewController,
      gestureRecognizers: const <Factory<OneSequenceGestureRecognizer>>{},
      hitTestBehavior: PlatformViewHitTestBehavior.opaque,
    );
  },
  onCreatePlatformView: (params) {
    return PlatformViewsService.initSurfaceAndroidView(
      id: params.id,
      viewType: params.viewType,
      layoutDirection: TextDirection.ltr,
      creationParams: {'lat': 39.9, 'lng': 116.4},
      creationParamsCodec: const StandardMessageCodec(),
    )
      ..addOnPlatformViewCreatedListener(params.onPlatformViewCreated)
      ..create();
  },
)
\`\`\`

\`gestureRecognizers\` 空集合：Flutter 父级可以抢手势。放入 \`EagerGestureRecognizer\` 的 factory：Platform View 在 down 时 claim。这是嵌列表里的地图「该谁滚」的正式开关，不是 \`IgnorePointer\`。

iOS 的 \`gestureRecognizersBlockingPolicy\` 有 \`eager\` 和 \`waitUntilTouchesEnded\`。后者让 Flutter 有机会先赢，WebView 内部滚动会变钝。产品上选一边写进组件注释。

\`PlatformViewHitTestBehavior.transparent\` 让 HitTest 穿透到后面的 Flutter 控件。看起来像点穿，原生 View 也可能收不到触摸。和 \`Listener\` 一样：资格层的决定，不是竞技场。

## 11. 合成器、OEM、以及「同一页有时卡有时不」

Android 的 Overlay 数量是硬件/OEM 限制。状态栏、导航栏、SurfaceView 播放器、Flutter 拆出来的上下两层 HC Surface、弹出来的 Dialog，都在抢 Overlay。超了就掉到 GPU composition，整页从 60 掉到 40，Dart 火焰图干净。这就是「加了个 WebView 之后动画也卡，但 WebView 不在动画里」——合成器全局变贵。

排查：\`adb shell dumpsys SurfaceFlinger\` 看 composition type。DevTools 看不见 SurfaceFlinger。TLHC 的价值在这里：系统只看见一个 Flutter Surface，Overlay 压力回到开 Flutter 之前。

强制 fallback 的绘制属性要当成「性能开关」：

- 祖先 \`Opacity\` < 1
- \`ClipRRect\` 且抗锯齿
- \`Transform\` 带 perspective
- \`ColorFiltered\`
- 被 \`RepaintBoundary\` 要求一起缓存

能把这些从 Platform View 的祖先上拿掉，就拿掉。圆角切到原生 View 自己的 \`outline\` / \`cornerRadius\`，不要在 Flutter 侧 clip 一块纹理再 fallback 成 HC。

iOS 没有 VD 这段历史，但 \`UIView\` 和 \`CAMetalLayer\`（Flutter）叠层同样有 offscreen 渲染。\`UIVisualEffectView\` 和 Flutter blur 叠在一起是双重离屏。平台 View 上再套 Flutter \`BackdropFilter\`，两端都付费。

WebView 硬件加速在 Android 上和 Flutter 的 GPU 上下文争驱动资源。后台 WebView 仍保活一页游戏或视频，等于第二份 Raster。生命周期里 \`onPause\` 必须传到 WebView，不只传到 Flutter \`paused\`。

### 创建与销毁的时序：第一帧黑块从哪来

\`onCreatePlatformView\` 是异步的：原生 View 可能在下一帧甚至更晚才有第一块像素。Flutter 侧已经按 layout 出的矩形合成，纹理还是空的，于是黑块或透明洞。产品上要占位：同尺寸的 Flutter 骨架、fade-in。不要用「加大延迟再显示」赌原生速度。

销毁时序相反：Element 先 unmount，Dart 侧 Layer 摘掉，原生 View 可能还在主线程排队 \`removeView\`。快速滑动列表，创建/销毁会在主线程排成队，ANR 或掉帧发生在 Platform Runner，FrameTiming 的 build 仍健康。列表里 Platform View 必须虚拟化且 **创建要节流**。同时 \`create\` 三个 WebView 是主线程自杀。

\`PlatformViewCreatedCallback\` 之后才能 \`invokeMethod\` 和这块 view 说话。之前发的消息会 MissingPlugin 或打到错误 id。把「viewId 已创建」当成状态机的一档，不要在 \`initState\` 立刻 invoke。

### 输入法、截屏、无障碍的三处断裂

IME：HC 上 WebView 是真 View，输入法通常正常。TLHC / 纹理路径要 Engine 把焦点和 \`TextInput\` 通道接过去。双重处理（Flutter \`resizeToAvoidBottomInset\` + 原生 \`adjustResize\`）会导致键盘高度算两次，WebView 被顶出屏幕。只留一边。

截屏：系统截屏能抓到 HC 的真 View；抓纹理路径取决于是否在同一合成树。应用内 \`RenderRepaintBoundary.toImage\` 经常把 Platform View 画成黑。需要分享卡片就不要把 WebView 放进截图区域，或用原生截屏 API。

无障碍：Flutter 语义树在 Platform View 矩形上通常一个占位节点。TalkBack 焦点进 WebView 后，由原生树接手。占位节点的 label 应说明「网页」而不是空。空节点会让焦点「吞掉」这块区域又读不出内容。

### 混合手势的最小状态机

推荐显式三态，而不是堆识别器：

1. \`undecided\`：down，两边都不滚动。
2. \`flutter\`：过 slop 且方向是外层主轴，cancel 原生。
3. \`platform\`：命中原生可滚子控件或方向是内部主轴，Flutter 认输。

用 \`PlatformViewGestureMixin\` / \`eager\` 实现 3，用空 \`gestureRecognizers\` 实现 2 的倾向。业务上「地图页外层不能滚」直接 eager，不要做三态。状态机是给 Feed 里嵌小地图这种冲突点用的。写下来，测试用「先竖滑再横滑」各一次，比看日志快。

### 尺寸协议：物理像素还是逻辑像素

Platform View 的 size 从 Flutter layout 来，是逻辑像素。Embedder 乘 dpr 变成物理像素去设 \`View\` 的 layout 或纹理尺寸。自己在原生按逻辑像素建纹理，图会糊；按物理像素但 Flutter 侧用逻辑当物理，图会过大且显存炸。dpr 改变（折叠屏、外接屏）必须重建纹理。动画里 dpr 不变，不要每帧 setLayoutParams。

\`sizedByParent\` 的 RenderBox 用约束最大尺寸当 Platform View 尺寸。父级给 unbounded 约束会失败——\`AndroidView\` 不能放进未约束的 \`ListView\` 横向里而不给宽度。错误信息是盒子约束，不是混合合成。先修 layout 协议。

### 线程亲和：WebView 只能在主线程

Android \`WebView\` 构造必须主线程，且和进程的 WebView 数据目录绑定。多进程（\`Application.onCreate\` 里非主进程）构造 WebView 会炸。Flutter 插件的后台 isolate 里 **不要** 间接触发 WebView 创建。所有 Platform View 工厂跑在 Platform Runner，这是硬亲和。

iOS \`WKWebView\` 类似，必须主线程。它的进程是独立 web content process，像素通过 IOSurface 过来。Flutter 这边看到的延迟包含跨进程。责怪 Flutter 合成之前，先量 WebView 自己的首画时间。

### 何时用截图代替真 Platform View

长列表里每项一个小地图：真 Platform View 会毁滚动。改成静态瓦片图（Texture 或普通 Image），点进去才开真地图。这是架构取舍，不是渲染优化。相机贴纸预览可以用 Texture；贴纸编辑条用 Flutter。能把「活的原生」从滚动热路径拿掉，比调 HC/TLHC 收益大一个数量级。

### 图层调试：看见合成路径

Android：\`debugHybridComposition\` / 引擎日志里会打当前用的 composition 类型。自己在 Debug 用半透明色标出 Platform View 矩形，确认 layout 是否比视觉大（点不中或挡住邻居）。\`FlutterInspector\` 的 select widget 对 Platform View 内部无效，这是预期——内部不是 Flutter。

iOS：Xcode View Debugger 能看见 \`FlutterView\` 层级里插入的 \`UIView\`。若你以为是纹理模式却看见真 UIView，就是 HC。以 View Debugger 为准，不以感觉为准。

### 内存泄漏的典型对象图

泄漏链常见：\`AndroidViewController\` → \`PlatformView\` → \`WebView\` → 页面上下文 → Activity。Flutter Element 已经 unmount，但这条 Java 链还在。用 Android Studio Memory Profiler 看 \`WebView\` 实例数是否随打开次数线性涨。涨就是没 destroy。\`dispose\` 里 \`controller.dispose()\` 必须被调用；\`State.dispose\` 里漏掉、或异步 create 完成后 State 已 dispose，都要处理：create 回调先看 \`mounted\`。

iOS 用 Instruments Leaks 看 \`WKWebView\`。\`FlutterViewController\` 自己被原生导航强引用，Engine 不 destroy，View 也不放——这是容器问题，不是 Dart 问题。

### 与 Impeller / 图片缓存的交叉

Platform View 的纹理不进 ImageCache。但它和 Flutter 图片抢 GPU 内存。Feed 里大图 + WebView 广告同时存在，OOM 的堆栈可能在解码，根因是纹理总和。内存警告时除了 \`imageCache.clear\`，还要暂停离屏 WebView（\`onPause\`、\`pauseTimers\`）。只清 Dart 缓存是半边。

Platform View 的产品原则是 **配额**。给每个 App 定：同时可见的真平台视图 ≤ 1；同时存活（含 offscreen keepAlive）≤ 2；列表项禁止。超过配额用截图/Texture/纯 Flutter 替代。没有配额，技术选型会在业务压力下全面退化成 HC+WebView 瀑布流，帧率和内存一起崩。配额写进设计评审，和「这页要嵌官方地图」一起讨论：地图是否必须可交互？不可交互就瓦片图。

手势配额同样：一页里只允许一个「eager 吃掉手指」的区域。两块 eager（地图+画布）中间的 Flutter 按钮会被饿死。eager 是稀缺资源。

版本差异要进 QA 矩阵：Android 9 VD fallback、Android 10+ TLHC、OEM 的 WebView 内核、iOS 的 WKWebView 进程崩溃（content process 死了，矩形空着，Flutter 还在跑）。WebView 崩溃不是 Flutter 崩溃，不要当成 Engine bug 升级 Flutter。监听原生 WebView 崩溃回调，显示「重新加载」而不是白块。

最后，Platform View 是 Flutter「自绘」叙事的例外，例外就应该 **显眼**。代码里用 \`package:hybrid_view\` 之类专用封装，禁止满项目直接 \`AndroidView\`。封装里集中：gesture 策略、创建节流、dispose、占位骨架、IME 策略。新业务只调封装。例外被集中，成本才可观测；例外被复制粘贴，成本会在三个迭代后以「Flutter 卡」的名义出现在周会上。那时再解释 TLHC，已经晚了。

Platform View 的测试策略和纯 Flutter 不同。黄金截图在 HC 下含原生像素，在 TLHC 下也可能含，但 CI 模拟器的 WebView 渲染不确定，像素测试会闪。对含 Platform View 的页，CI 只测 Flutter 部分几何和「view 已创建」回调，视觉回归放真机农场并允许 WebView 区域 mask。不 mask 会天天红。

无障碍测试同样 mask 内部：只断言占位节点存在且 label 非空。内部用原生测试工具。两端都绿才算这块混合区域完成。只测 Flutter 语义会漏 WebView 里没 label 的按钮。

安全：WebView 是 XSS 和文件域的洞。Flutter 包一层不会让 \`javascript:\` 变安全。URL 白名单、JS bridge 方法白名单，仍按原生 WebView 纪律。Channel 暴露给 JS 的接口要当公开 API，鉴权、限流。混合架构把攻击面从 Dart 扩到了 Web。这不是渲染问题，但常和 Platform View 同一模块出现，必须在同一评审里问。

电量：后台 WebView 播放、定时器、定位。\`onPause\` 传到 WebView，\`onResume\` 再开。Flutter \`paused\` 生命周期要接到封装层。漏接的表现为「杀不掉的广告 WebView 耗电」，用户怪 Flutter。封装层接 \`WidgetsBindingObserver\` 或原生 Activity 回调，两边只接一处，避免 pause 两次。

嵌入地图时还有定位权限、样式夜间模式、与 Flutter 主题不同步等问题，这些不是合成路径，但会表现为「混合页很卡」——夜间模式切换重建地图纹理，等于一次 size 变化。主题切换要节流，或让地图用自己的暗色而不跟 Flutter 每帧 Theme 动画。Theme 动画包着 Platform View 改色，是 HC fallback 和纹理重建的双重打击。能静态切就静态切。

广告 SDK 的 View 往往内部再开 WebView、再开播放器，成本是黑盒。配额上应把一块广告 View 按「≥1 个 WebView」计价，而不是按 1 计价。测 PSS 增量，用实测填配额，不要用 SDK 宣传材料。

旋转：Activity 重建若不保留 Engine，Platform View 全毁重建，用户看见闪。\`configChanges\` 或 Engine 保留策略要和 Group 一起设计。旋转时只换 Surface，不换 View id，WebView 才能保住会话。这是生命周期和混合视图的接缝，两篇文章对上才能做对。

混合页的性能预算应单独列：允许的 Platform View 个数、允许的合成模式、滚动中是否允许存在。超预算的稿子在设计阶段打回。预算数字来自真机：在目标低端机上嵌一个全屏 WebView 后 FPS 掉多少。掉到不可接受，这块业务就不要嵌，或改外链浏览器。用数据挡需求，比用「Flutter 不适合」这种空话挡需求有效。

开发时强制 Debug 横幅显示当前 composition 类型和 view 数量。类型一变（TLHC→HC）横幅变色。测试看到变色就提单，附带当时的祖先 Widget（是否 Opacity）。这比用户反馈「有时候卡」更接近根因。横幅实现十行，价值是把例外路径可视化。例外一旦看不见，就会繁殖。

混合栈导航里，Platform View 页的截图用于缩略最近任务。Android 最近任务截的是系统合成结果，HC 下含 WebView，纹理路径下也可能含。若你用 Flutter 自己截图当缩略图，黑块会出现在多任务界面。用系统截屏，或接受 Flutter 截图不含原生。产品选一个，不要两个都做再叠。多任务界面的黑块会被当成崩溃。其实是截图路径选错。把选择写进封装，业务无感。

混合视图的发布清单加三条：低端机滚动 FPS、IME 弹出、TalkBack 进入离开。三条不过不发。比再讨论一代 TLHC 更接近用户。用户不关心纹理从哪来，关心能不能滑、能不能打字、能不能听。你关心纹理，是为了这三件。三件用真机测，合成路径用日志测。两套测试一起绿，这一页的例外路径才算被驯服。驯服不是消灭。消灭是能不用就不用。能不用，配额就是零，那是最好的优化。

把 Platform View 放回整个专栏的位置：它是渲染独占假设的例外，是手势竞技场的边界，是语义树的占位，是 EngineGroup 里特别贵的可变成本。四篇文章在这块矩形上相交。相交意味着修一个问题要先问在哪条交线。掉帧问合成路径，点不动问手势策略，读不出问占位节点，内存涨问同时存活数。交线问对了，改动才落在封装里正确的开关上。问错了，会在 Dart 里减 Widget 指望 WebView 变快。那不会快。快来自少嵌、小嵌、固定尺寸嵌。封装存在，是为了让「少、小、固定」成为默认值，让例外成为显式参数。默认值比开关重要。开关会被打开；默认值会在忘记的时候保护你。

封装的默认值建议写成：gesture 不 eager、size 动画禁止、同时创建节流 1、dispose 必达、占位骨架必有。业务要改其中任何一项，必须在 PR 里写原因。原因会被未来的掉帧单引用。引用链让例外可追溯。可追溯，配额才不是墙上的纸。纸会被撕。引用链撕不掉，因为它在 git 里。git 比墙硬，和类型系统一样硬。混合视图靠这两硬活下去。

少、小、固定，加上默认不 eager，四条已经够用。够用就停。再加第三代合成名词进业务周报，帮不了 FPS。FPS 认像素和 Surface 数量。数量在配额里。配额在评审里。评审过了，这一页才能嵌。没过，外链或截图。停在这里，是这篇最贵的结论。

嵌得少，才能把独占 GPU 的主路径留给真正的 Flutter 帧。

## 12. 小结

混合视图的原理是「两套渲染器的像素如何汇合、输入如何让路」。VD、HC、TLHC 是三条汇合路径，不是三个 Widget 风格。选路径就是选同步点、合成次数和 IME 保真度。例外路径的成本无法在 Dart 侧用 \`const\` 优化掉。把 Platform View 用少、用小、用固定尺寸，Flutter 的那条独占 GPU 的主路径才能继续成立。`,

  "flutter-engine-group-memory-sharing": `每个 \`FlutterEngine\` 都带一份 Runtime、线程、字体和 GPU 资源。在原生壳里每开一个 Flutter 页面就 \`new FlutterEngine()\`，内存和启动时间都会按页线性涨。\`FlutterEngineGroup\` 要解决的不是「引擎启动优化开关」，而是 **哪些资源在进程里只能有一份，哪些状态必须按页面隔离**。共享错了会串数据，隔离错了会把 RSS 打爆。

读完你应该能独立回答三个问题：Group 到底共享了什么、为什么插件 static 会在第二页出错、销毁 Engine 和销毁 Group 为什么不能当成一回事。

## 1. 先画边界：一份 Engine 有多贵

冷拉起一份孤立 Engine 大致要付：

1. 映射 AOT 快照（\`isolate_snapshot_data/instr\`、vm snapshot）——可以 mmap，但仍占虚拟地址和启动期缺页。
2. 创建 Platform / UI / Raster / IO 四条 Runner，至少两条专用 OS 线程。
3. 启动根 Isolate，跑 \`main()\`，注册插件，挂帧回调。
4. 建 GPU 上下文、字体库、shader/PSO 缓存。
5. 等第一块 Surface 和第一次 Vsync，画出第一帧。

企业混合 App 里「设置、钱包、客服、搜索」四个入口各 new 一次，等于四次点火。RSS 上常见的现象是：每多一个 Flutter 容器，多十几到几十 MB，而业务 Dart 代码根本没那么大。多出来的是 **重复的运行时**。

\`FlutterEngineGroup\`（Android \`io.flutter.embedding.engine.FlutterEngineGroup\`，iOS \`FlutterEngineGroup\`）把「进程级」和「页面级」切开。

## 2. 共享什么、隔离什么

Group 内第一个 Engine 完整初始化。后续 \`spawn\` / \`makeEngine\`：

| 类别 | 共享（进程 / Group） | 隔离（每个 Engine） |
|---|---|---|
| VM / AOT | 快照映射、VM 内部结构 | 根 Isolate、Dart 堆 |
| 线程 | 部分线程池、IO 能力 | 自己的 UI/Raster 调度与 Surface 绑定 |
| 字体 | 字体管理器、文件映射 | 当前用到的段落缓存可能仍按引擎 |
| GPU | 设备、部分管线/上下文 | 自己的窗口 Surface、swapchain |
| 插件 | 类加载、so | Channel 注册表、插件实例状态 |
| 语义 / 恢复 | 无 | 自己的 Semantics、Restoration |

官方数字随版本变，数量级是：第一份 Engine 仍是十几到几十 MB，后续增量可以到 **百 KB 到一两 MB**，而不是再来一份 30MB。启动从「再起 VM」变成「再挂一个 Isolate + 一块 Surface」。

不变量：

- **Dart 堆不共享。** Isolate 内存隔离仍在。你不能在页面 A 的 \`static\` 里指望看见页面 B 的对象——\`static\` 是 Isolate 级，不是进程级。每个 Engine 一个根 Isolate，就有一份自己的 \`static\`。
- **C 全局 / Java static 是进程级。** 插件用 \`static MethodChannel\` 或 C 单例，会在 Group 里串。这是混合架构里第一常见的 bug。
- **GPU 共享不等于可以同时往同一块 Surface 画。** 每个 Engine 仍要自己的渲染目标。
- **Group 活着，共享资源就活着。** 最后一个子 Engine destroy 不会拆 Group。

\`\`\`dart
// Dart 侧：这个 static 只在「当前 Engine 的根 Isolate」里唯一。
// 另一个 Flutter 页面是另一个 Isolate，看不到它。
class Session {
  static String? token;
}
\`\`\`

原生侧 Java \`static String token\` 则两页都能看见。同一名字，两种寿命，这就是串数据的来源。

## 3. 线程与入口：spawn 不是 fork

\`makeEngine\` 不会 fork 进程。它在已有 VM 里创建一个新的根 Isolate（属于同一 Isolate Group 的细节随版本演进，但对外表现是：独立的 Dart 堆、独立的事件循环、独立的 \`main\` 入口）。

入口可以和第一份 Engine 不同：\`FlutterEngineGroupOptions\` / \`DartEntrypoint\` 指定 \`main\` 或 \`settingsMain\`。这允许「设置页只跑设置库」。注意：AOT 里没用到的代码仍可能在快照里，入口不同省的是启动期执行和堆上的单例，不一定省包体。

每份 Engine 仍有自己的 UI Runner 语义。两份 Engine 同时可见（例如原生 ViewPager 里两个 FlutterView）时，会有两套 build/layout/paint 和两套 Raster 工作。Group 省的是固定成本，不是「两页同时画只付一份 GPU 时间」。产品上能离屏的页面应暂停渲染：\`FlutterView\` detach 或 \`lifecycleChannel.appIsPaused\`。

Platform Runner 仍是进程里那条系统主线程。所有 Engine 的插件默认挤在同一条主线程上。四个 Engine 同时 \`invokeMethod\` 做重活，ANR 是共享的。Group 不隔离主线程。

## 4. 插件：按 Engine 实例写，禁止进程单例

\`FlutterPlugin\` 的正确形状：

\`\`\`java
public class DevicePlugin implements FlutterPlugin {
  private MethodChannel channel;

  @Override
  public void onAttachedToEngine(FlutterPluginBinding binding) {
    channel = new MethodChannel(binding.getBinaryMessenger(), "app.device");
    channel.setMethodCallHandler((call, result) -> { /* 用 binding.getApplicationContext() */ });
  }

  @Override
  public void onDetachedFromEngine(FlutterPluginBinding binding) {
    channel.setMethodCallHandler(null);
    channel = null;
  }
}
\`\`\`

错误形状：\`static MethodChannel\`、\`static\` 保存 \`Activity\`、在 \`registerWith\` 里假设永远只有一次调用。第二份 Engine attach 时会覆盖第一份的 handler，或第一份 detach 时把第二份的 handler 清掉。

Activity 感知用 \`ActivityAware\`，并且记住：Group 里多个 Engine 可能对应不同 Activity，也可能同一个 Activity 里两个 \`FlutterView\`。把 Activity 存 static 会泄漏和发错窗口。

Dart 插件同样：\`static const channel = MethodChannel('x')\` 可以，因为 Channel 对象只是句柄，messenger 来自当前 Engine 的 \`window\` / \`ServicesBinding\`。危险的是 Dart \`static\` 缓存「原生已初始化」——那份缓存跨不出 Isolate，会导致第二页再初始化一次，或误以为已经初始化。

## 5. 生命周期：谁 create、谁 destroy、谁 pause

混合容器的典型寿命：

1. 进程启动：创建 **一个** Group（Application / AppDelegate 级单例）。
2. 打开 Flutter 页面：\`group.makeEngine(...)\`，attach 到 \`FlutterView\` / \`FlutterViewController\`。
3. 页面不可见：通知 Engine \`AppLifecycleState.paused\` / 暂停渲染，不要 destroy——回来才快。
4. 页面销毁：\`engine.destroy()\`。Group 留下。
5. 进程退出：Group 才拆。

把 4 写成「destroy Group」等于下一次打开又冷启动，Group 白做。把 3 写成 destroy Engine，等于放弃「百 KB 增量」里最值钱的那部分——Isolate 可以重建，但第一帧仍要走 \`main\` 和首屏 layout。

Android 配置变更（旋转）不要重建 Group。Engine 可以留，Surface 重建。iOS 内存警告时，可以 destroy 不可见的子 Engine，保留 Group 和当前可见的那一份。

多 Flutter 页面共享数据：不要靠 \`static\`。用原生侧的进程级存储（或 Channel 到原生单例），或显式 IPC。Isolate 不共享堆是特性，不是 Group 的缺陷。

## 6. 内存账本：怎么证明 Group 在工作

不要只看 Dart DevTools。DevTools 连的是 **当前 Isolate**，看不见另一份 Engine 的堆，也看不见 GPU。

该看的三张图：

- **RSS / PSS（系统）**：打开第二页，增量应远小于第一页。若仍涨 20MB+，多半没有走 Group，或插件在 native 又建了一份缓存。
- **Java / ObjC 堆：** 插件泄漏的 Activity、WebView、Bitmap。
- **GPU：** 两块 Surface 同时存在时纹理翻倍是正常的；离屏页仍有全屏纹理就不正常。

第一份 Engine 的字体、shader 缓存会留在 Group 里。这是好事（第二页首帧少编译），也意味着 Group 本身不是零成本。进程里永远挂一个 Group + 零个子 Engine，仍可能留着 GPU 上下文。若产品「一年才开一次 Flutter」，可以考虑用完拆 Group；若一周开几次，留着。

## 7. 设计取舍

- **共享 VM/GPU，隔离 Isolate：** 混合 App 能承受「很多 Flutter 入口」。代价是插件必须可重入，Dart \`static\` 不能当跨页总线。
- **一个 Group 单例：** 实现简单。代价是 Group 的 GPU/字体生命周期等于进程，内存基线略高。
- **每页可选不同 entrypoint：** 模块化。代价是仍一份 AOT，包体不一定小；还要维护多入口的初始化顺序。
- **不共享 Element 树：** 不能把「半个 Flutter 页面」挪到另一个 Engine。跨页 UI 状态只能序列化，不能搬对象。

和「单 Engine + 自绘路由」比：单 Engine 更省，适合 Flutter 是主 UI 的 App。Group 适合 **原生是壳、Flutter 是多模块** 的企业应用。用错场景会两边不讨好：主 Flutter App 里再套 Group，多 Isolates 同时跑 UI，得不偿失。

## 8. 排障

1. **第二页 RSS 仍很大：** 确认容器调的是 \`FlutterEngineGroup.makeEngine\`，不是 \`new FlutterEngine\`。老模块、FlutterFragment 默认参数、自己缓存的孤立 Engine，都会绕过 Group。
2. **第二页插件失效 / 第一页突然失效：** 搜插件里的 \`static\`。按实例改 \`onAttachedToEngine\`。
3. **Dart \`static\` 状态「丢了」：** 不是丢，是另一份 Isolate。跨页状态放原生或磁盘。
4. **同时打开两页掉帧：** 两份 Raster 在跑。离屏暂停；不要做并排两个全屏 FlutterView 还各自动画。
5. **销毁后崩溃：** 回调进已 destroy 的 Engine。插件 detach 必须卸 handler；原生异步回包要弱引用 Engine。
6. **iOS 第二次 \`run\` 失败：** 同一 Engine 不能 \`run\` 两次。spawn 新的，或设计成 Engine 复用但不重复 run。
7. **启动仍慢：** Group 只省第二份及以后。第一份仍要看快照大小、首帧字体、插件同步初始化。别把首启问题算到 Group 头上。

## 9. 和 FlutterFragment / 路由的关系

Android \`FlutterFragment\` 可以接收外部 Engine，也可以自己造。自己造时若不传入 Group，就是孤立 Engine。把 Group 放在 \`Application\`，Fragment 只 attach，是混合栈里最不容易写错的结构。

路由：每个 Engine 自己的 \`Navigator\` 栈。原生返回键要决定发给哪一份 Engine。不要假设「只有一个 WidgetsApp」。Restoration id、Channel 名、通知权限回调，全部带 engine / page id。

## 10. 和 FlutterEngineCache、Activity 预热的关系

Group 不是 Android 上唯一的「复用引擎」API。\`FlutterEngineCache\` 是一份手动 Map：你自己 \`put("main", engine)\`，\`FlutterActivity\` 用 \`cachedEngineId\` 取。它 **不** 自动共享 VM 初始化——如果你 cache 的是孤立 Engine，第二份仍要你自己从 Group spawn 再放进 cache。

正确组合：

1. \`Application.onCreate\`（或按需）创建 **一个** \`FlutterEngineGroup\`。
2. 冷启动预热：\`group.createAndRunEngine(...)\` 得到第一份，放进 \`FlutterEngineCache\`，跑完 \`main\` 但不 attach 视图。用户点入口时 attach，首帧只剩 Surface 和 build。
3. 第二入口：\`group.createAndRunEngine\` 再 spawn，不要 \`new FlutterEngine\`。
4. 页面销毁：视产品决定 destroy 还是放回 cache。Cache 里挂着一份已 run 的 Engine，占的是一份 Isolate 堆 + Surface 未 attach 时较少的 GPU。常驻一个预热 Engine 适合「一天打开几十次」的入口；不适合十个入口各挂一份。

\`FlutterActivity.withCachedEngine\` 不会帮你 spawn。传错 id 会崩溃。预热 Engine 的 \`DartEntrypoint\` 必须和将要展示的页面匹配，否则你要在 Dart 里再走一套原生通知来切换根路由——这套要自己做，且必须可重入。

iOS 上 \`FlutterEngineGroup.makeEngineWithEntrypoint\` 类似。\`FlutterViewController\` 可以接收外部 engine。预热时注意：没 attach 的 Engine 默认可能不跑帧，这是省电；第一次 attach 仍有首帧 layout。把预热做到「跑过第一帧并 \`FlutterEngine.sendOnPlatformMessage\` 把首屏数据拉好」，用户感知才是秒开。只 \`run\` 而不 build 首屏，省掉的只是 VM，不是第一帧。

Debug / JIT：Group 的增量优势仍在，但绝对数字难看。不要用 Debug 的 RSS 差去向老板证明 Group 没用。Profile/Release + 真机。

\`dart-entrypoint-args\` 和 \`dartDefines\` 是进程级的。Group 里两份 Engine 想要不同 flavor 配置，靠 args 传进 \`main(List<String> args)\`，不要靠改 defines——defines 编译期就冻了。

## 11. Isolate Group、AOT 快照和「看起来像共享的 static」

Engine 文档里的 isolate group 指 VM 可以共享 **只读** 的程序结构（AOT 代码、部分元数据）。Heap 仍按 isolate 隔离。所以：

- 同一份机器码在内存里一份（mmap）。这是 Group 省 RSS 的大头之一。
- 类的静态字段：每个 isolate 一份。\`static\` 计数器两页互不影响。
- \`native\` 扩展里用 C 全局变量：一份，两页都看见。
- \`File\` / \`mmap\` 只读资源：操作系统页缓存天然共享，这和 Group 无关，孤立 Engine 也共享。

因此「共享」有三层，写进注释才不会被下一任拆错：

1. OS：文件页、GPU 设备。
2. VM/Group：AOT、字体管理、线程池。
3. 你的代码：必须显式。Channel 到原生单例，或磁盘。

错误地以为「Group 了所以 Dart static 共享」，会把会话做在 \`static String? token\` 上，第二页登出第一页还显示已登录——或者反过来。Java \`static\` 才会这样串。Dart 不会。两边的修法相反：Dart 要 **加** 跨页总线；Java 要 **拆** 静态。

后台 isolate（\`Isolate.spawn\` / \`compute\`）挂在 **当前 Engine 的 VM** 下，但不是一个新 Engine。它没有自己的 UI、没有 Channel（除非你 ensure binary messenger）。不要为每个 Flutter 页面 spawn 一套常驻 worker 还不关掉：Group 省下的内存会被 worker 堆吃回去。worker 的寿命跟任务走，不跟页面走，除非它持有该页的指针。

### 预热第一帧：Group 省的和省不了的

Group 把 VM 点火从第二页账单里划掉。第一页仍然要：

- 跑 \`main\` 直到 \`runApp\`
- 注册插件（Dart 和原生）
- 首屏 \`build/layout/paint\`
- 字体 fallback、首图解码、PSO bind

预热若只 \`runEngine\` 而不 attach、不让首屏 build，第二次 attach 仍要付 layout。真正的秒开预热是：在 Application 空闲时 attach 到一块 **1×1 或 offscreen** 的 FlutterView，等到 \`addPostFrameCallback\` 第一帧，再 detach，Engine 留在 cache。注意：offscreen 仍可能触发 GPU 资源分配。测 RSS。部分系统对不可见 Surface 节流，第一帧其实没跑完——要用 \`WidgetsBinding\` 的帧回调确认，不要 \`sleep(500)\`。

多入口预热两份 Engine，内存回到「两份堆」。只预热最高频入口。其它入口走 Group spawn 的「百 KB + 跑 main」，通常可接受。

### 插件里的 Activity 与 Context

\`onAttachedToEngine\` 给的是 \`ApplicationContext\`。\`ActivityAware\` 的 \`onAttachedToActivity\` 才有窗口。Group 下：

- Engine 预热阶段可能 **没有** Activity。插件在 attachToEngine 时碰 \`Activity\` 会 NPE。
- Engine 可以从 Activity A detach 再 attach 到 B（少见但合法）。存 Activity 必须在 \`onDetachedFromActivity\` 清空。
- 两个 Engine 两个 Activity（分屏），Java static Activity 必错。

\`FlutterPluginBinding.getTextureRegistry()\` 也是 **每 Engine 一份**。相机纹理 id 不能跨 Engine 使用。把 id 当 int 塞 SharedPreferences 再给另一页，是野指针的 Flutter 版。

### 销毁崩溃：弱引用和消息队列

\`engine.destroy()\` 之后，UI Isolate 死了，原生还可能有：

- 网络回调 \`result.success\`
- 传感器 EventChannel sink
- 延迟 \`Handler.post\`

这些必须是弱引用 Engine / Channel，失败就 return。Crashlytics 里 \`FlutterJNI\` 在 destroy 后 \`invoke\` 是混合栈第一崩溃。Group 让 Engine 生灭更频繁，这类 bug 从「偶发」变成「必现」。代码审查清单就一条：所有异步回包看 Engine 是否 still attached。

### DartExecutor、JNI、以及「run 只能一次」

Android 上 \`FlutterEngine.getDartExecutor()\` 在 \`run\` 之后才 \`isExecutingDart\`。Channel 在 run 之前注册是合法且推荐的——这样 \`main\` 里第一句 invoke 不会 MissingPlugin。\`run\` 第二次会失败：一份 Engine 一个根 Isolate，不能重新 \`main\`。要换入口就 spawn 新 Engine。热重载是 Debug 服务协议，不是 \`run\` 两次。

\`FlutterJNI\` 是 Java 和 C++ Engine 的边界。destroy 后 JNI 指针置空。任何仍持有 \`FlutterEngine\` 引用的异步回调都要先问 \`engine.getDartExecutor().isExecutingDart()\`。Group spawn 的 Engine 各有各的 JNI。发错 Engine 的 JNI 会把消息送进另一份 Isolate，表现为「偶发状态错乱」而不是立刻崩溃。

iOS 的 \`FlutterEngine\` \`runWithEntrypoint\` 同样一次性。\`FlutterEngineGroup\` 的 \`makeEngine\` 返回的是已经或即将 run 的实例，视 API 而定——以当前版本头文件为准，不要假设和 Android 对称。读头文件比读两年旧博客安全。

### 内存基线怎么写进预算

给技术经理的数字应分三行，而不是一个「Flutter 占 40MB」：

1. 进程里 **第一个** Flutter Engine（含 GPU/字体/AOT）：例如 20～40MB，随包体和首屏变。
2. Group 内 **每个额外** Engine：目标 < 2MB + 该页 Dart 堆 + 该页纹理。
3. 每个可见 \`FlutterView\` 的全屏纹理：\`宽×高×4×缓冲数\`。

第 3 行经常比第 2 行大。两个并排可见的 Flutter 页，贵的是两块 swapchain，不是两份 VM。优化「同时可见」比优化「Group 开关」更值钱。预算表里写「最多同时可见 1 个 Flutter 全屏」，比写「必须用 Group」更能保住 RSS。

### 入口函数的初始化幂等

\`void main() => runApp(MyApp())\` 和 \`void walletMain() => runApp(WalletApp())\` 都可能 \`WidgetsFlutterBinding.ensureInitialized()\`。绑定是 per-isolate 的，两份 Engine 各做一次没问题。危险的是原生侧在 \`main\` 里通过 Channel 做「只该发生一次」的事（初始化崩溃上报、改 \`WebView\` 数据目录）。改成原生 \`Application.onCreate\` 做一次，Dart 只登记。幂等写在有进程寿命的那一层。

### 路由谁来当：原生栈还是 Dart 栈

Group 架构下有两种合法模型，混用会丢返回栈。

模型 A：原生导航为主。每个 Flutter 页面一个 Engine、一个 \`FlutterViewController\` / \`FlutterFragment\`。返回键先问原生。Dart 里尽量单页，不在内部再 push 很深。Restoration 按 Activity。

模型 B：一个常驻 Engine，Dart \`Navigator\` 很深，原生只是壳。Group 用得少。返回键始终交给 Flutter。

错误模型：每个原生页面一个 Engine，同时 Dart 里还有深层 Navigator，返回键有时 pop Dart 有时 pop 原生。用户会卡在「空白 Flutter 页」。写进导航文档：这一页的返回归属。

### 冷启动预加载插件

插件 \`onAttachedToEngine\` 若同步读磁盘，第一份 Engine 和每一份 spawn 都会付。改成懒加载：第一次方法调用再读。Group 的 spawn 才轻。启动期打 log 看 attach 耗时，超过几毫秒的插件列名单治理。

### 如何证明「我们在用 Group」

代码搜 \`new FlutterEngine(\` / \`FlutterEngine(\` 构造。测试里开第二页打 RSS。文档里画「Application 持有 Group」的图。这三件缺一，半年后就会有人复制旧模板 \`new FlutterEngine\` 进来。CI 搜禁止的构造函数，比 code review 记忆可靠。

EngineGroup 落地失败，通常不是 API 不会用，是 **组织问题**：各业务线复制了一份「启动 Flutter」的原生模板，模板里 \`new FlutterEngine\`。治理是提供 **唯一** 的 \`FlutterContainer\` SDK：内部 Group、cache、生命周期、返回键、restoration 前缀、插件注册。业务只 \`open("wallet")\`。SDK 的测试包括：连续打开关闭 50 次 RSS 不线性涨、第二页插件可用、destroy 后无 JNI 崩溃。没有这层 SDK，Group 只存在于你的博客，不存在于仓库。

Dart 侧配套：禁止把跨页状态放 \`static\`；提供 \`NativeSession\` Channel 读进程级会话。文档用「Isolate 级 / 进程级」词汇，不要用「全局」。全局在两种语言里寿命不同，这是本文反复强调的那条不变量。新人入职第一课就讲，能省掉半年的串数据 bug。

性能上，Group 让「Flutter 模块化」在内存上成立，但不让「同时跑三个重动画模块」成立。模块化是代码和启动的切分，不是 GPU 的切分。同时可见的模块数仍要配额。和 Platform View 配额同一思想：共享固定成本之后，可变成本是 Surface 和 Dart 堆。可变成本用产品约束，不是用更多引擎技巧。技巧已经用到 Group 了。再往后是少开、暂停、销毁不可见页。

EngineGroup 与热更新、动态下发 isolate 快照（若业务做了）冲突很大。Group 假设进程内 AOT 一致。动态下发第二份不兼容快照，不能塞进同一 VM。那时应回到孤立 Engine 或独立进程，不要硬塞 Group。能力边界写进架构：Group 用于「同一产物内的多入口」，不是「运行时换引擎版本」。

日志：每份 Engine 的 \`debugLabel\` / \`dartEntrypoint\` 打进崩溃上报自定义键。否则 Crashlytics 里全是 \`main\`，看不出是钱包还是客服。Native 崩溃带 engine id。Dart 错误带 \`Isolate.debugName\`。运维才能把崩溃分到模块负责人，而不是全部飞给基础组。

灰度：新模块用 Group spawn，旧模块仍孤立，RSS 曲线会怪。迁移期接受，但仪表盘按「是否 Group」分维，否则你会以为 Group 无效。迁移完成下线孤立构造函数。留着两个世界，半年后全是孤立的——因为复制粘贴更熟。

与测试：widget 测试不启动 Group。集成测试在 Android 上要用真实 Application 单例。机器人测试反复进出 Flutter 页，盯 PSS。没有这一条，泄漏只会在用户旅程里出现。把「进出 50 次 PSS 斜率」当发布门禁，比看一次打开的绝对值更接近 Group 的目标。

Engine 的 \`destroy\` 是同步还是异步随平台略有差别，但业务必须当「调用后立刻不能再发 Channel」。把 destroy 和页面动画并行（边 pop 边 destroy）会让动画最后一帧的回调打进已死 JNI。先等 Flutter 页 \`paused\` 且动画结束，再 destroy。体感上多 100ms 卸载，换稳定。反过来省这 100ms，换一周一次的崩溃，不划算。

预热过度：Application \`onCreate\` 里同步 makeEngine 会拖长进程启动，系统启动指标变差。预热应 idle 或首帧后。用 \`reportFullyDrawn\` 之后再预热第二入口。启动和预热抢 CPU，两者都难看。错峰是和 Impeller PSO、字体一样的技巧，用在 Engine 上同样成立。

Dart \`main\` 里同步 Channel 等原生配置，会把 spawn 的「快」抵消掉。配置预读进原生内存，\`main\` 里同步读一份已经准备好的 map，或用编译期 define。spawn 路径要像热路径一样审：每一毫秒都在用户点入口到看见页之间。

EngineGroup 的文档要画三张寿命图：进程、Group、Engine。招聘和交接只靠口口相传，三个月后必有人 destroy Group。图挂在仓库 README。代码里 Group 的持有者类型名叫 \`FlutterEngineGroupHolder\` 这种丑但搜得到的名字，不要叫 \`Helper\`。搜得到才能治理。

与灰度发布：原生壳先发、Flutter 模块后发时，entrypoint 可能不存在。spawn 失败要有降级（隐藏入口或跳旧原生页），不要崩溃。失败 code 打点。模块化让版本矩阵变二维，错误处理必须按二维写。Group 不负责这个，壳负责。但文章必须提到，否则落地时会怪 Group 「不稳定」。不稳定的是版本矩阵，不是 spawn API。

EngineGroup 与推送拉起：推送点开要进某 Flutter 页。此时进程可能没有 Group。冷启动路径：Application 建 Group → spawn 对应 entrypoint → 把推送 payload 当初始路由参数。不要先起默认 main 再跳，会闪首页。参数走 \`dartEntrypointArgs\` 或 Channel 一次。和 restoration、深度链接排优先级：推送通常赢。三路进同一页的代码要共用「解析参数 → 建页」，不要三套。Group 只负责 Engine 从哪来，不负责路由语义。路由语义仍是你的导航模块。两者接口是 entrypoint 名 + args 列表。接口稳定，两边才能独立演进。

回到内存数字：第一份 Engine 的几十 MB 是交税，后面每一份只交 Dart 堆和纹理。税交在 Application，不交在每一个 Fragment。谁 new 孤立 Engine，谁就在重复交税。CI 搜构造函数，就是查偷税。这比喻不好听，但好记。好记的纪律才能在业务线复制模板时活下来。Group 的 API 很简单，简单到会被忽略。忽略的代价按页线性出现在 RSS 曲线上。曲线一陡，再来看这篇文章，会发现共享和隔离那张表其实已经把答案写死了。写死的东西，用自动化守，不要用记忆守。

EngineGroup 不是缓存技巧，是混合 App 的内存模型声明：VM 级一份，页面级多份。声明要写进原生 SDK 的类型系统，写成 \`FlutterContainer\` 只能从 Holder 拿 Engine，写不成 \`new FlutterEngine\`。类型系统比 wiki 硬。硬了，RSS 才不会在业务狂奔时按页抬头。抬头时再优化插件 static，已经是第二层问题。第一层是有没有 Group。先有第一层，再清第二层。两层都清，增量内存才会落到百 KB 到一两 MB 那个数量级。数量级对了，产品才敢把更多模块写成 Flutter，而不怕壳被内存打死。敢，是架构的产出。不敢，是孤立 Engine 的遗产。遗产用 CI 扫掉，用 Holder 接住。接住之后，这篇文章的表才变成代码。

Holder 还要负责 restoration 前缀和 debugLabel。两个字符串漏了，状态会串、崩溃会上错门。字符串从页面 id 来，页面 id 从产品模块名来，不要从 class hash 来。hash 会变。模块名稳定。稳定 id 是 Group、Channel、语义、恢复共用的钥匙。一把钥匙开多篇文章里的锁。钥匙乱了，四篇文章的机制会同时表现为「偶发」。偶发是 id 不稳的别名。Holder 把 id 稳住，偶发会少一半。另一半在插件 static。static 清完，偶发才变成可复现。可复现才能修。修完，Group 才从PPT变成 RSS 曲线上的平台阶。台阶是你想要的形状。线性斜坡是孤立 Engine 的形状。看形状，就知道代码走的是哪条路。

看 RSS 形状判断路有没有走对：平台阶是 Group，斜坡是孤立。发版前画一张「打开第 n 个 Flutter 入口后的 PSS」。n=1 可以高，n=2 必须矮很多。矮很多，Holder 才算活着。活着，税才只交一次。一次税，换无数模块。这是混合架构敢继续用 Flutter 的算术。算术写进发布检查，和功能列表并列。并列了，内存才是功能的一部分，不是事后账单。事后账单总是来得太晚，晚到模块已经铺开。铺开再合并 Group，比一开始 Holder 贵十倍。十倍的差，就是这篇要挡的那笔钱。

钱在 RSS 里，不在周报里。周报可以写「已接入 Group」，曲线仍是斜坡。只认曲线。曲线是 Holder 的验收。验收不过，入口不准扩。不准扩，是为了以后还能扩。还能扩，才是这篇算术的正循环。循环从形状来。形状从代码来。代码从搜不到 \`new FlutterEngine\` 来。搜不到，才算完。

搜不到孤立构造，Holder 才算安装完成。

## 12. 小结

EngineGroup 把 VM、字体、GPU 设备变成进程级单例，把 Isolate、Surface、Channel 表、语义树留在页面级。内存模型是「共享不能重复的，隔离必须隔离的」。插件 static 和 Dart static 寿命不同，这是 Group 世界里的第一不变量。销毁 Engine 不等于销毁 Group；暂停渲染不等于销毁 Engine。把这三层寿命画清楚，混合 App 的 RSS 才不会随页面线性上涨。`,

  "flutter-skia-vs-impeller-shader-warmup": `把 Skia 的 shader warmup 和 Impeller 的预编译当成同一件事，优化会做反。一个是 **把已知变体的编译挪到启动或动画开始前**，一个是 **取消运行时变体生成**。前者是缓存策略，后者是着色器架构。缓存会失效；封闭图元集合在构建期编完，原则上不会在动画中间冒出几十毫秒的驱动编译。

读完你应该能独立回答三个问题：为什么换机后 warmup 包失效、Impeller 为什么还能首帧尖刺、\`saveLayer\` 和 shader compile 在 FrameTiming 上如何区分。

## 1. 先画边界：卡顿的两种完全不同的尖刺

移动 GPU 驱动编译一条着色器，常见是几毫秒到几十毫秒，极端上百。它发生在 **Raster 线程**（或驱动线程，结果仍阻塞提交）。UI Isolate 的 \`build\` 火焰图是干净的。用户感觉是「第一次滑到这个效果时顿一下，以后顺了」。

另一种尖刺是填充率、带宽、离屏：模糊、大图、每帧 \`saveLayer\`。它 **每次** 都贵，不会「熟了就好」。用 warmup 解决第二种，是在错误的病上开药。

| | Shader compile jank | Fill-rate / 离屏 jank |
|---|---|---|
| 何时 | 第一次见到某绘制组合 | 每一帧 |
| 线程 | Raster / 驱动 | Raster / GPU |
| 以后会否消失 | 会（缓存在） | 不会 |
| Skia warmup 有用吗 | 有，若录到了 | 无 |
| Impeller 消灭它吗 | 原则上消灭运行时编译 | 否 |

\`FrameTiming.rasterDuration\` 两者都会变长。要区分，看是否「同路径第一次」，以及 Timeline 里有没有 shader compile 事件。

## 2. Skia 路径：开放特化 + 运行时编译

Skia 的 Ganesh（以及部分 Graphite 路径）按绘制状态特化着色器：混合模式、覆盖类型、颜色空间、是否有纹理、是否有圆角……状态空间是组合爆炸。第一次用到某个组合，Skia 生成 SKSL / GLSL / MSL，交给驱动编译，再放进 **持久化缓存**（Android 上常和 GL 程序缓存有关）。

推论：

- 变体空间大，你不可能在 warmup 里录全 App。
- 缓存键和 GPU、驱动、有时还和系统版本绑定。换机、OTA、清缓存，预热包失效。
- 没录到的效果，第一次出现仍会编译。产品上就是「冷门页面第一次进才卡」。
- Debug/Profile 和 Release 的着色器路径不完全一样，不能拿 Debug 判断 compile jank 消失了。

Warmup 的做法：启动或闪屏阶段，用 \`Skia\` 把首屏真实动画里出现的绘制跑一遍（或播放一份录制的 \`warmup.zip\` / shader bundle）。编译发生在用户以为「还在进 App」的时候。它 **不改变** 架构，只改变编译的时间点。

局限是结构性的：录制覆盖率、设备绑定、新效果。把 warmup 当「性能方案」会随着功能迭代不断漏。

## 3. Impeller 路径：封闭图元 + 构建期管线

Impeller 的核心不变量是：**运行时不再根据「没见过的画法」生成新着色器。** 画圆、矩形、路径、模糊、渐变、图像、裁剪，收敛到有限绘制操作。对应的 Metal/SPIR-V/GLES 程序在构建期由 \`impellerc\` 编进包。运行时绑定已经存在的 PSO（管线状态对象），改的是 uniform、顶点缓冲、纹理绑定。

所以「第一次画模糊」不是「编译 blur shader」，是「走已经编译好的 blur 管线 + 不同的 radius uniform」。没有「新形状 → 新 shader」这条边。

和 Skia warmup 的本质差别：

- Warmup：缓存 **已知** 变体。未知变体仍会编译。
- Impeller：变体集合在构建期闭合。未知画法要么走现有管线组合，要么根本画不出来（要扩展 Impeller 本身）。

换 GPU 不会让「着色器没编译过」——包里已经是设备 ISA 或中间表示（Metal library / SPIR-V，GLES 上仍有驱动的余地，这是 Impeller 在老 GLES 设备上不完美的原因之一）。

代价：

- 包体积增加。预编译库按后端切片，仍不是零。
- 自定义着色器不能再指望 Skia 的无限运行时特化，要走 Impeller 的扩展 / runtime effect 路径，且能力面更窄。
- 构建变慢（\`impellerc\`）。CI 要缓存这份产物。

## 4. Impeller 仍然会卡：不要把所有 GPU 问题算到 shader 上

关掉 compile jank 之后，剩下的才是可以按帧优化的：

- **PSO 第一次绑定：** 管线已编译，但驱动可能在首次 bind 时做验证、分配。通常比编译小，仍可能在首帧可见。和 warmup 不同，这更像「缓存冷启动」，且集合有限。
- **纹理上传：** 解码后的 RGBA 上 GPU。大图、列表预加载会打 Raster。见图片缓存那篇。
- **MSAA / 离屏：** \`saveLayer\`、模糊、复杂 clip、\`Opacity\` 动画。Impeller 同样要分配离屏纹理、做两次绘制。
- **路径 tessellation：** 复杂 Path 第一次拆三角形有 CPU 成本，发生在 Raster。之后可能被缓存。这不是 shader compile，但「第一次」的体感像。
- **字形图集扩容：** 第一次见到某 CJK 字，图集扩、上传。UI 线程 shaping + Raster 上传。

iOS 上 Impeller 已默认较久；Android 随版本和设备回退。回退到 Skia 的设备，warmup 仍有意义。不要在「我开了 Impeller」的假设下给所有机型关掉 warmup，先看实际后端。

## 5. 线程、内存、生命周期

着色器编译和 PSO 创建发生在 Raster，**绝不要**想在 Dart 里「预编译一条 shader」。Dart 只能通过真正画一次（Skia warmup）或换渲染器（Impeller）影响它。

内存：

- Skia 程序缓存：原生堆，按变体涨，可被系统清。
- Impeller 着色器库：映射进内存的包内二进制，基线成本，不随页面线性涨。
- 离屏纹理：两者都有，跟 Layer 树走，跟 \`RepaintBoundary\` 走。

生命周期：Engine 销毁会丢部分 GL 缓存；\`FlutterEngineGroup\` 共享 GPU 设备时，第二份 Engine 少付「设备初始化」，不一定共享全部程序缓存。第一页画过的效果，第二页仍可能有一次轻量 bind，但不应再出现几十毫秒编译——前提是真的在用 Impeller 或 Skia 缓存还在。

## 6. 设计取舍

- **Skia 开放特化：** 画什么都能出一种优化过的 shader。代价是编译时间不可预测。桌面和能力强的 GPU 上这很划算；中低端移动上是 jank 源。
- **Impeller 封闭集合：** 帧时间可预测。代价是包体、构建、以及「奇葩画法」要改引擎。
- **Warmup 把编译藏进启动：** 不改架构就能改善首动画。代价是启动变慢、覆盖率游戏、设备绑定。
- **默认 Impeller：** 团队选择「可预测优于极限特化」。这和 Flutter「跨设备一致」的目标一致。

因此：能开 Impeller 就开。还停在 Skia 的设备，warmup 只覆盖 **首屏真实会播放的动画**，不要幻想录全 App。新页面的第一次特效，接受它或改画法减少新变体。

## 7. 排障

1. **只第一次卡、以后顺：** 先假设 shader compile 或图集/路径缓存冷。Timeline 看 raster 线程上的 compile / \`GrGL\` / \`impeller\` 事件。开 Impeller 后若仍如此，更可能是纹理、字形、PSO bind。
2. **每次都卡：** 不是 compile。查 \`saveLayer\`、blur、大图、checkerboard 离屏。Performance overlay 的 GPU 条持续高。
3. **开了 Impeller 更卡：** 个别路径 Impeller 尚未与 Skia 同等优化，或 GLES 后端。用 Impeller 的调试 overlay / frame capture（Metal Frame Capture / RenderDoc）看 pass 数，不要立刻关回去直到你看见 pass 爆炸。
4. **warmup 包越来越大仍漏：** 正常。停用「录全站」，改 Impeller 或减少绘制组合。
5. **换机复现、自家不复现：** Skia 缓存和驱动差异。实验室必须覆盖目标 GPU。
6. **Debug 流畅 Release 卡或相反：** 关闭 checkerboard、关闭 \`debugDisableClipLayers\` 这类调试开关再比。Debug 本身有 JIT 和额外校验。

\`\`\`dart
WidgetsBinding.instance.addTimingsCallback((timings) {
  for (final t in timings) {
    final rasterMs = t.rasterDuration.inMicroseconds / 1000;
    final buildMs = t.buildDuration.inMicroseconds / 1000;
    if (rasterMs > 16 && buildMs < 8) {
      // 病在 GPU/Raster，不是 Dart。再拆「首次 vs 持续」。
    }
  }
});
\`\`\`

## 8. 和 Layer 树的关系

Impeller 消灭编译，不消灭 Layer。\`Opacity\` 包整页、\`ImageFilter.blur\` 全屏、多层 clip，仍是多次离屏 pass。很多人开了 Impeller 期待「所有卡顿消失」，然后把责任推回 Framework。正确顺序：后端确认 Impeller → 仍卡则当填充率问题治 → 用 checkerboard 和 layer dump 减离屏。

\`RepaintBoundary\` 在 Impeller 下同样分配纹理。缓存命中省的是记录和 tessellation，不是着色器编译。

## 9. 构建期你实际要保证什么

- CI 打的包确认 Impeller 着色器库在（iOS \`impeller.framework\` 一类产物、Android 的 blob）。
- 不要在 Release 用 \`--no-enable-impeller\` 做「以防万一」除非有设备黑名单。
- Skia 设备名单维护的是 **GPU/驱动**，不是机型营销名。
- 自定义 \`FragmentProgram\` / \`ImageFilter\` 要在目标后端上测第一次出现的帧，不要只测稳态。

## 10. 后端差异：Metal、Vulkan、GLES 不是同一份「Impeller」

Impeller 的不变量是「封闭图元 + 离线着色器」，落地到后端仍分叉：

- **Metal（iOS / macOS）：** 最成熟。\`impellerc\` 产出 Metal library，驱动编译点基本被挪到构建期。PSO 首次 bind 仍可能有一帧尖刺，幅度通常小于 Skia 的 shader compile。
- **Vulkan（Android 较新设备）：** 同样走 SPIR-V / 预编译管线。驱动质量参差。个别 OEM 的 pipeline cache 行为会让「理论上不编译」变成「第一次仍卡一下」。这是驱动，不是你 Dart 写错。黑名单和 Impeller 的设备回退存在的理由在这里。
- **GLES：** Impeller 也能出 GLES 后端，但 GLES 没有 PSO 这套对象模型，驱动仍可能在链接程序时干活。老设备上回退 Skia 往往更可预测。把「开了 Impeller」当成全机型免编译，会被 GLES 打脸。

Skia 的持久化缓存位置随平台变（Android 上和 \`GL_PROGRAM_BINARY\`、应用 cache 目录有关）。用户清缓存、换机、系统升级都会丢。warmup 包若按 GPU 指纹存，要有淘汰；否则 cache 目录会被无用 blob 塞满。

\`RuntimeEffect\` / \`FragmentProgram.fromAsset\` 是运行时着色器的逃生口。Impeller 和 Skia 都能跑一份 GLSL-like。**它会把「封闭集合」打开一个口。** 第一帧编译/转译成本回来了。用在滤镜实验室可以，用在列表滚动的每一项等于自己把 compile jank 请回来。能用内置 blur/color matrix 就不要 RuntimeEffect。

Impeller 的实体（entity）pass：每个需要离屏的效果一次 render pass。Frame capture 里数 pass 比猜 Widget 有用。全屏 blur 至少：画内容到离屏、模糊水平、模糊垂直、合成回主缓冲。半径变大带宽变大，和是否 Impeller 无关。

## 11. 构建、开关、以及和第一帧的关系

iOS 上 Impeller 默认开。Android 用 metadata / \`ImpellerBackend\` / 命令行 \`--enable-impeller\`。以你目标 Flutter 版本的官方表为准，不要抄两年旧文。Play 分发多 ABI 时，着色器 blob 按 ABI 打进 so 或 asset，包体增量要进 APK analyzer，不要到 16KB 页对齐的设备上才发现 so 变大。

本地验证：

1. Profile 真机，进会模糊/阴影的页，看 Timeline 第一次 vs 第二次 raster。
2. 第一次有几十 ms 的 compile 事件 → 你不在 Impeller，或在 GLES，或用了 RuntimeEffect。
3. 第一次只有几 ms 的 bind/upload → 正常冷缓存。
4. 每次都有几十 ms → 不是 shader，是离屏或解码。

\`impellerc\` 失败会让构建失败，这是好事。Skia warmup 录制失败是静默覆盖率下降，这是坏事。CI 应该：Impeller 构建必须绿；若仍支持 Skia 设备，warmup 只作为额外产物，缺了不能当 Ignored。

宽色域、MSAA、HDR 会加 pass 或改格式。第一次切到 HDR 屏幕可能触发管线切换。这不是「又回到 Skia 编译」，但是用户可感知的第一帧尖刺。在 \`didChangeMetrics\` 后的几帧不要同时再解 4K 图。

和启动路径叠在一起：冷启动第一帧本来就要绑管线、shape 字体、解图。把 Impeller 的 PSO 冷绑定、CJK fallback、首图解码叠在同一帧，P95 会很难看。预热策略是 **错峰**：闪屏阶段先触发字体和首屏 PSO（真正画一次首屏离屏或低优先级帧），再进可交互帧。Group 的第二页可以吃到第一页留下的设备级缓存，这是 Group 和 Impeller 的交叉收益。

### 变体空间：Skia 为什么录不全

Skia 特化键大致包括：后端、是否有纹理、纹理格式、覆盖几何（rect/rrect/path）、混合、颜色空间、是否 AA、是否有 mask filter、是否有 color filter。两两组合就是指数。业务每加一种「卡片上的渐变描边 + 模糊」，就可能是新键。warmup 录制是在特定导航脚本下跑的，脚本没进的设置页、深色模式、动态字体，全是漏网。深色模式单独一套颜色空间/混合，常常让「白天录的包」晚上失效。

所以 warmup 的正确范围是 **启动后 3 秒内用户必见的动画**（闪屏到首页、第一个 hero）。其余接受第一次尖刺，或靠 Impeller 关掉这类事件。

### Impeller 的封闭集合如何扩展

新画法要进 Impeller，得加 entity、加 contents、加预编译着色器、加黄金测试。这是引擎开发，不是 App 开发。App 侧能做的组合是：用现有图元表达，而不是求新 shader。例如虚线边框用 path effect（若后端支持）或预先画好的九宫格图，而不是 RuntimeEffect 写虚线 SDF。

\`Canvas.drawVertices\` / \`drawAtlas\` 在 Impeller 上是一等公民，适合合批。循环 \`drawCircle\` 一万次，即使没有 compile jank，也有 CPU 记录和 draw call 问题。自定义 \`RenderObject\` 那篇的合批，在 Impeller 下同样成立，且更值得：后端可预测后，fill rate 和 draw call 成为唯一账单。

### 如何向非图形同事解释这次卡顿

一句话分类：

- 「只第一次，以后顺」→ 编译或冷缓存，换 Impeller / 错峰预热。
- 「每次经过都卡」→ 像素或离屏，减层减图。
- 「只有某台 Android」→ 驱动或 GLES 回退，查后端开关和 OEM。
- 「开了 Impeller 更卡」→ 数 pass，可能是某效果的实现回归，抓帧，不要立刻全面回退。

把这四句写进性能值班文档，比贴一篇 Impeller 介绍有用。

### DisplayList 与「为什么 Dart 里看不见 shader」

UI 线程 \`paint\` 产出的是 DisplayList（或 Impeller 的等价记录），不是 GL 调用。记录里是「画圆、颜色、模糊半径」这类高级操作。Raster 线程把高级操作映射到后端命令。所以你在 Dart 里搜 shader 找不到；它不在 Framework。\`Canvas.drawPath\` 的贵贱，要到 Raster 才揭晓：简单矩形走 fast path，复杂自交 path 要 tessellate。同一段 Dart，不同 path 数据，rasterDuration 可以差一个数量级。优化要 dump 实际 path 复杂度，不要只看调用次数。

\`saveLayer\` 在记录里就是一个明确的离屏边界。\`debugDisableClipLayers\` 等调试开关能帮你确认是不是它。生产代码里用 \`Paint.saveLayer\` 等价物（\`Opacity\`、\`ImageFilter\`）要知道自己在插入这个边界。

### 预编译覆盖不到的「第一次」

即使 Impeller，下列第一次仍可能尖刺：

- 该设备上第一次创建某种像素格式的纹理（HDR、wide gamut）
- 第一次分配超大离屏（全屏 blur）
- 第一次把 CJK 某段 fallback 字体上传图集（图集扩容可能拷整张）
- 第一次从 iOS 后台回前台，GPU 上下文丢了要重建（系统回收）

这些不是「Impeller 没做好」，是 GPU 资源寿命。后台回前台的第一帧单独统计，不要和滚动 P95 混在一起，否则永远解释不清。

### 包体与多后端

同时带 Metal、Vulkan、GLES 的预编译库，包体会加。按 ABI / 平台切：iOS 不带 Vulkan blob。Android App Bundle 按 ABI 分包。不要为了「包体减 200KB」关掉 Impeller 再把 compile jank 迎回来——那是用用户的帧换你的下载转化，要明确做产品取舍，而不是当技术优化默默做。

### Skia persistent cache 的运维

Android 上程序二进制缓存可被用户「清数据」清掉。清数据后第一次进动画的 compile jank 回来。这不是回归，是缓存空了。Impeller 设备上用户清数据不应引回 compile jank——用来做 A/B 验证：清数据后若仍几十 ms 尖刺，你可能没在 Impeller，或尖刺根本不是 compile。

warmup 包放 asset，启动时加载。它增大包体，且和 GPU 绑定。策略：只对仍走 Skia 的 ABI/机型下载或内置，Impeller 机型不要带。否则双份成本。

### 模糊半径与带宽公式

一次全屏 blur 的大致带宽：\`宽 × 高 × 4 × pass 次数\`。两次可分离高斯再合成，pass ≥ 3。1080×2340 × 4 × 3 ≈ 30MB 每帧读或写。60fps 就是极高带宽。半径从 8 改到 64，采样更远，cache miss 更多。Impeller 不会把 30MB 变成 3MB。产品上：小区域 blur、降分辨率离屏再 blit 回去、动画结束用静态模糊图替换实时 blur。这些才是数量级优化。

### 与 \`saveLayer\` 等价的 Widget 列表

给设计/开发一份黑名单：整页 \`Opacity\` 动画、\`BackdropFilter\`、\`ColorFiltered\` 包列表、\`ShaderMask\`、\`Clip.antiAliasWithSaveLayer\`、多层重叠半透明视频。出现在滚动热路径上就当 raster 超预算的第一嫌疑。不是永远不用，是不要用在每帧全屏。

把渲染后端当成 **设备能力矩阵** 的一列，和 CPU 档、RAM 放在一起。列值：Impeller Metal / Impeller Vulkan / Impeller GLES / Skia GL。启动时打点，性能指标按这列分维。否则你会平均掉真实问题：Vulkan 设备 P95 很好，GLES 设备很差，平均看起来「还能接受」。分维后才能决定黑名单。

开发流程：设计师出的「全屏毛玻璃 + 列表滚动」在评审就要按带宽公式挡回去，而不是做完再优化。Impeller 让这种效果的 **第一次** 不再惨，但 **每一次** 仍然惨。把「第一次」和「每一次」写进评审语言。能让非图形工程师加入讨论，性能才不会只留在图形专家脑子里。

自定义着色器走 RuntimeEffect 要登记：哪些页面、是否滚动路径、有无降级方案（切回 ImageFilter 或静态图）。未登记的 RuntimeEffect 当 bug。封闭集合被打开的口，必须可清点。否则两年后你又在做 Skia warmup 那套覆盖率游戏，只是对象从隐式变体换成了项目里散落的 \`.frag\` 文件。

GPU 抓帧应成为和看 Dart 火焰图同等的技能。iOS Frame Capture、Android GPU Inspector、至少会数 pass、看纹理尺寸。不会抓帧就不要结论「Impeller 不行」。结论必须带 pass 数和纹理分辨率。这是把图形问题从信仰拉回工程的最后一步。

着色器问题的沟通模板：给产品看的是「这类卡顿会否随使用消失」。会消失 → 编译/冷缓存，排期可以靠 Impeller 覆盖率；不消失 → 每帧成本，必须改设计。模板减少「再加一层毛玻璃吧，Impeller 不是修好了吗」这类对话成本。

研发侧维护一张效果表：模糊、阴影、圆角、渐变、blend、RuntimeEffect，各行注明 Impeller 路径是否成熟、是否离屏、滚动中是否允许。表比口头知识可继承。新效果先查表再进视觉稿。

设备实验室至少一台 GLES 回退机、一台 Vulkan Impeller、一台 iOS Metal。三台都跑同一动画脚本，看第一次 raster。缺 GLES 那台，你会在发版后被老设备打脸。实验室名单和分维指标用同一套设备 id。

不要在 Dart 里根据 \`defaultTargetPlatform\` 猜后端。用引擎提供的报告或自己在原生读开关。猜错比不开开关更糟：你以为没 compile jank，实际在 Skia 上录了一堆无用日志。

若必须同时支持 Skia 与 Impeller，绘制代码按「封闭图元」来写，避免依赖 Skia 独有的运行时特化。这样两条后端的视觉差最小，warmup 需求也最小。视觉差要黄金截图分后端存，允许微小 AA 差，不允许一边有阴影一边没有。发现缺失时，是效果不该用，不是再写一套 if。

团队里指定一个「图形值班」角色，负责 Impeller 发行说明跟踪和设备黑名单。后端演进快，两年旧文会害人。值班不是全职，是发版前看一遍 release note 的 shader/impeller 段。比出事故后读源码便宜。

图形问题还要和电量、发热放在同一张表里。持续高 raster 等于持续高 GPU 功耗，降频后 raster 更长，进入正反馈。实验室短测看不出。外场 20 分钟滚动才能看见。性能优化若只看 30 秒脚本，会把「能跑但会烫」的效果放出去。FrameTiming 的持续超帧率和皮肤温度相关， correlating 需要外场。至少在夏天用真机跑一遍主 Feed。这不是小题大做，是中低端 Android 的真实约束。

Impeller 的收益在这种正反馈里特别明显：没有 compile 尖刺，平均负载更平滑，更不容易瞬间把 GPU 拉到降频点。这是「可预测」的另一层含义：不只是用户少感觉一次 hitch，还是热管理更稳。讲给硬件同事听，他们会点头；讲给只看 FPS 的人听，要补这一句。

若发现某 OEM 上 Impeller 画面错（缺字、花屏），黑名单要按 GPU 和驱动版本，不要按手机营销名。同名机可能换过 GPU。上报带 \`GL_RENDERER\` / Metal 设备名。黑名单进远端配置，不必发版就能扩。本地写死名单会在新品上滞后。这是图形问题的运维面。原理文章也要写运维面，否则原理停在开发者电脑上。电脑是 Pixel 和 iPhone，用户是长尾 OEM。长尾才是 shader 历史的重复。Impeller 减少了重复，没有消灭长尾。长尾用黑名单和分维指标收口。

着色器故事的结局不是「永远不卡」，是「卡的种类变了」。从不可预测的编译，变成可预测的填充。可预测才能排期，才能挡设计，才能写预算。Impeller 的价值在这一变。Warmup 仍服务被留下的 Skia 设备，范围收在首屏。两套手段，两种病。以后再看见「第一次卡」，先问会不会消失。会消失的，看后端；不消失的，数像素。问句比工具先到。工具用来回答问句，不是用来代替问句。

回到开篇那三个问题：warmup 换机失效，因为缓存键绑 GPU；Impeller 仍可能首帧尖刺，因为 bind、上传、字形图集不是编译；saveLayer 和 compile 用「是否每次出现」区分。三个答案现在都有了机制和流程。机制在 Raster，流程在分维指标和设备实验室。没有实验室，机制只在文档里。有实验室，机制才能变成黑名单和预算。预算挡住全屏毛玻璃，黑名单挡住花屏 OEM，分维防止平均值撒谎。三件套比再读一遍 impellerc 帮助文档更接近生产。生产要的不是图形学完整性，是帧时间可预测。可预测是 Impeller 的设计目标，也是你选后端、写效果、做评审时唯一需要对齐的目标。对齐了，shader 故事结束。结束之后，去减层。

减层的手法已经在 Layer 树那篇：少 Opacity 整页、少 blur 全屏、少 saveLayer clip。本文只负责告诉你：这些手法在 Impeller 下仍然有效，而且更值得做，因为编译尖刺不再掩盖它们。掩盖消失后，填充率成为唯一的 GPU 语言。学会这门语言，比学会 warmup 包格式重要。格式会过时。填充率不会。像素×pass×帧率，永远是账单。账单在，效果就要买得起。买不起，就换设计。换设计是合法优化。合法，因为物理在。物理不吃 Impeller 的面子。

像素×pass×帧率买不起时，换设计是第一优化，换后端是第二。第一更便宜。便宜的先做。做完再问还要不要黑名单。黑名单是兜底，不是日常。日常是预算。预算是物理。物理读完就可以去改稿。改稿比改引擎快。快，是你真正拥有的杠杆。引擎在上游。稿在手里。手里的先动。

## 12. 小结

Warmup 治标：把 Skia 的运行时编译挪到用户不注意的时间点。Impeller 治本：构建期闭合着色器集合，运行时原则上不再编译。两者都能让「第一次」变好，但只有后者让帧时间分布可预测。剩下的 GPU 账单是离屏、填充、上传，那是 Layer 和图片的问题，换渲染器解决不了。看尖刺是否只出现一次，就能决定你在打哪一场仗。`,

  "flutter-image-cache-and-gpu-texture": `图片占用的不是文件大小，是 **解码后的 RGBA 和 GPU 纹理**。2MB 的 JPEG 可以变成 48MB 的 CPU 像素再加一份 GPU 副本。OOM 和滚动掉帧，经常被写成「ImageCache 太小」或「没加缓存」，真实原因通常是：解码尺寸远大于显示尺寸、同时存活的解码结果太多、纹理在 GPU 侧的寿命和 Widget 对不上。

读完你应该能独立回答三个问题：\`cacheWidth\` 作用在哪一条线程、ImageCache 淘汰的是什么而不是文件、为什么 \`dispose\` 了 Image Widget 显存不一定立刻掉。

## 1. 先画边界：三条寿命，三块内存

一张网图从点击到上屏，至少过三块堆：

1. **压缩文件 / 网络缓冲：** 几 MB。IO Runner 或 HttpClient。和最终显存几乎无关。
2. **解码后的位图（CPU）：** \`宽 × 高 × 4\`（RGBA8888）。活在 Dart 堆的外部 typed data 或原生堆，取决于编解码器。\`ImageCache\` 主要钉的是这一层的 \`ImageStreamCompleter\` / \`ImageInfo\`。
3. **GPU 纹理：** 上传后活在 Raster/GPU。可能还有 mipmap、图集浪费、Impeller 的纹理图集对齐。Widget 释放不等于立刻 \`glDeleteTextures\`。

不变量：

- 文件 KB 数不进入 OOM 公式。公式是 **解码像素数 × 同时存活数 ×（CPU 是否还留着 × GPU 是否还留着）**。
- 解码发生在 **IO Runner**，上传常发生在 **Raster**。UI Isolate 若同步 \`decodeImageFromList\`，会把解码搬到 UI，这是自伤。
- \`ImageCache\` 按 **数量和字节** 设上限，淘汰的是缓存项，不是「磁盘上的 jpeg」。
- 正在屏幕上显示的图是 live，**不会**被 \`maximumSizeBytes\` 踢掉。上限只管「没人听了但仍留着的」。

\`\`\`dart
final bytes = 4000 * 3000 * 4; // 48,000,000
\`\`\`

列表里 10 张未缩小的 1200 万像素图，仅 CPU 位图就是 480MB 量级，GPU 再来一份。这和「ImageCache 默认 100MB」同时成立：live 图不进淘汰，缓存上限帮不上忙。

## 2. ImageCache 实际缓存什么

\`PaintingBinding.imageCache\` 是进程内（当前 Isolate）的 Map：

- key：\`ImageProvider\` 的 \`obtainKey\` 结果（例如 \`NetworkImage\` 的 url + scale）。
- value：\`ImageStreamCompleter\`。它可能还在解码，也可能已经持有一帧或多帧 \`ui.Image\`。

默认 \`maximumSize = 1000\`，\`maximumSizeBytes = 100 << 20\`（100MB）。淘汰近似 LRU。注意：

- **1000 张缩略图** 可能远不到 100MB，先撞数量上限。
- **几张 4K** 先撞字节上限。
- \`Image.network(url, scale: 2)\` 和 \`scale: 1\` 是不同 key，会解码两次。
- \`ResizeImage\` 的目标宽高是 key 的一部分。同一 url 不同 \`cacheWidth\` 是不同项——这是对的，因为位图不同。

\`precacheImage\` 只是提前把 provider 推进缓存。它仍按全尺寸解码，除非 provider 本身带 resize。启动时 \`precache\` 三张开屏大图，等于启动期主动 OOM。

动图（GIF / 多帧 WebP）：completer 持有多帧。每一帧都是一张位图。同时播放的 GIF 数量要当「张数 × 帧数」来估。\`ImageCache\` 的字节统计对多帧是否完整计入随版本，不要假设它帮你把 GIF 算准。

## 3. 解码：cacheWidth 为什么必须在这一步发生

编解码器可以在解码时下采样（JPEG / WebP 尤其友好）。\`Image.network(..., cacheWidth: w, cacheHeight: h)\` 或 \`ResizeImage\` 把目标尺寸传进 \`instantiateImageCodecFromBuffer\` 的 \`targetWidth/Height\`。IO 线程直接产出接近显示大小的位图。

错误路径：全分辨率解码 → 得到 48MB \`ui.Image\` → 绘制时 GPU 再缩放。中间那份 48MB 已经把 Dart/原生堆打爆，还要上传 48MB 纹理。滚动时掉帧是上传和带宽，OOM 是堆。

正确的 \`w\`：

\`\`\`dart
int decodeWidthOf(BuildContext context, double logicalWidth) {
  final dpr = MediaQuery.devicePixelRatioOf(context);
  return (logicalWidth * dpr).round();
}
\`\`\`

逻辑 120pt、dpr 3，解码 360 像素宽足够。再大是把视网膜当 4K 用。不要用原图宽度。不要用 \`double.infinity\`。列表项高度 80，按 80 × dpr 算。

HEIF / 某些 PNG 的解码器不一定支持任意 target 下采样，可能仍全量解码再 CPU 缩放。这时更要限制同时解码数，并避免原图像素级 PNG。

\`ui.Image\` 本身是 GPU/原生资源的 Dart 包装。\`ImageInfo\` 被 cache 和所有 \`Image\` Widget 的 listener 引用。最后一个 listener 离开、且被 cache 淘汰后，\`ui.Image.dispose()\` 才该发生。自己拿着 \`ui.Image\` 不 \`dispose\`，是泄漏的经典路径（\`instantiateImageCodec\` 手动用法）。

## 4. GPU 纹理：Widget 没了，纹理可能还在

上传：Raster 线程把 CPU 位图送进 GPU。Impeller/Skia 可能：

- 按图集打包，实际占用大于像素数（对齐、padding）。
- 延迟删除：一帧或几帧后才回收，避免「这帧还在采样」。
- \`RepaintBoundary\` 再缓存一份离屏，和原图纹理同时存在。

所以 Instruments / GPU profiler 上的纹理内存，会大于 \`ImageCache.currentSizeBytes\`。两套账：cache 是 CPU 侧 completer；纹理是 GPU 侧。只调 \`imageCache.maximumSizeBytes\` 却不管屏幕上同时出现多少张大图，GPU 照样炸。

列表滚动的正确模型：

- 视口内：live，必须在。
- 即将进入：有限预解码，带 \`cacheWidth\`。
- 远离视口：completer 可被淘汰，纹理应释放。

\`ListView.builder\` 默认会 dispose 离开的 Element，这是好事。\`AutomaticKeepAlive\`、自己缓存 \`ImageProvider\` 解析结果、全局 \`Map<url, ui.Image>\` 会把好事关掉。

\`evict(provider)\` 从 cache 拿掉，不保证 GPU 立刻释放，也不清 Http 磁盘缓存。\`imageCache.clear()\` 清的是当前 Isolate 的 cache，清不掉正在显示的 live 图，也清不掉别的 Engine。

## 5. 线程与卡顿形态

| 现象 | 线程 | 原因 |
|---|---|---|
| 滚动时周期性卡一下，以后顺 | IO + Raster | 解码+上传；解码尺寸过大 |
| 滚动全程 GPU 条高 | Raster | 每帧采样太多大纹理 / 没减尺寸 |
| 首屏白一下再出图 | IO | 没 precache，或网络 |
| 突然 GC / 掉帧 | UI | 同步解码或巨大 \`Uint8List\` 进 Dart 堆 |
| 后台内存涨、页面都 pop 了 | 任意 | cache 太大、live 泄漏、原生 Bitmap 没回收 |

不要在 UI Isolate 上 \`decodeImageFromList(await file.readAsBytes())\`。\`readAsBytes\` 已经是一份完整压缩文件进 Dart 堆，再同步解码是第二刀。用 \`instantiateImageCodecFromBuffer\` + \`ImmutableBuffer.fromFilePath\`，让文件映射和解码离开 UI。

并发：IO Runner 不是无限线程。同时解码 20 张 4K 会把 IO 打满，间接让其他图片、字体也排队。自己做「最多 3 个解码」的闸，比加大 cache 有效。

## 6. 生命周期：Provider、Stream、Widget

\`Image\` Widget 并不持有位图。它持有 \`ImageStream\` 的监听。\`didChangeDependencies\` 时可能因为 \`devicePixelRatio\` 变化重新 resolve——旋转、外接屏、折叠屏会触发重新解码。\`cacheWidth\` 若按旧 dpr 算，会糊或过大。

\`ImageProvider\` 应不可变。自己写 provider 时 \`==\` 和 \`hashCode\` 必须和 key 一致，否则 cache 失效或错命中。错命中表现为「A 图出 B 图」，是 key 碰撞，不是 GPU 错乱。

手动 \`ui.Image\`：

\`\`\`dart
final buffer = await ImmutableBuffer.fromFilePath(path);
final descriptor = await ImageDescriptor.encoded(buffer);
final codec = await descriptor.instantiateCodec(
  targetWidth: decodeWidth,
);
final frame = await codec.getNextFrame();
final image = frame.image;
// 用完：
image.dispose();
codec.dispose();
descriptor.dispose();
buffer.dispose();
\`\`\`

漏任何一档都会钉原生内存。\`Image.memory\` 把这件事藏起来，但 \`memory\` 的 \`Uint8List\` 仍在 Dart 堆上整份活着——大文件不要走 \`Image.memory\`。

## 7. 设计取舍

- **默认缓存 100MB / 1000 张：** 中等 App 够用。大图 Feed 必须改策略：减小单张尺寸，而不是只加大上限。加大上限是把 OOM 推迟成更大的 OOM。
- **live 不淘汰：** 正在显示的图不能被踢，否则闪。代价是视口里的错误尺寸无法靠 cache 政策拯救。
- **解码时缩放而不是绘制时缩放：** 省 CPU 堆和上传。代价是同一张图多种显示尺寸会解码多份。列表用缩略图、详情再解大图，是正确的双 key。
- **GPU 延迟释放：** 避免采样已删纹理。代价是 pop 页面后显存曲线下降慢一拍，不要立刻在下一页再塞同等大图。

CDN 出多尺寸是比 \`cacheWidth\` 更省的：解码器读的压缩数据都更少，IO 和 CPU 都轻。\`cacheWidth\` 是客户端最后一道闸，不是图片架构本身。

## 8. 排障

1. **OOM 堆栈在解码：** 打每张图的 \`targetWidth/Height\` 和原图像素。缺 \`cacheWidth\` 是第一嫌疑。
2. **\`currentSizeBytes\` 很小但仍 OOM：** 病在 GPU 或原生 Bitmap，或 live 图。用 Android Profiler Graphics / Xcode GPU 看纹理。
3. **滚动掉帧与图片一一对应：** 解码尺寸、同时解码数、是否同步解码。Timeline 的 IO / Raster 轨道。
4. **页面离开内存不掉：** 全局 cache 引用、\`keepAlive\`、自己的 \`Map<url, ImageProvider>\` 单例、Completer 没人 \`evict\`。
5. **GIF 把机子烫化：** 限同时播放，静止时用首帧，离屏暂停。
6. **同一 url 反复解码：** key 不稳定（url 带变化 token、自定义 provider 没写 \`==\`）、或 cache 上限太小被立刻踢。
7. **\`clear()\` 了还在：** live 图、其他 Engine、磁盘缓存、GPU 延迟删。

\`\`\`dart
assert(() {
  imageCache.maximumSizeBytes = 50 << 20;
  return true;
}());
\`\`\`

Debug 里把上限故意调低，能提前暴露「我依赖无限 cache」的页面。线上再按机型内存设，但永远先缩小解码尺寸。

## 9. 和 Texture / 相机帧的关系

相机、播放器走 \`Texture\` id，不进 \`ImageCache\`。它们的显存由插件和 Engine 的 texture registry 管。每帧更新的纹理不要再 \`toImage\` 转成 \`ui.Image\` 塞进 cache——那会每帧 8MB 分配。需要截图就截一次并立刻 \`dispose\`。

## 10. Provider、Completer、key：一张图为什么会被解两次

\`ImageProvider.resolve\` 的流程：

1. \`obtainKey(configuration)\`：异步得到 key（\`NetworkImage\` 的 key 含 url、scale、headers 吗？默认 headers 不进 key——带 cookie 的不同用户可能错命中。自己加 header 鉴权时要进 key 或不要用全局 cache）。
2. \`imageCache.putIfAbsent(key, () => load())\`：没有才 \`load\`。
3. \`loadImage\` / \`loadBuffer\` 返回 \`ImageStreamCompleter\`。\`MultiFrameImageStreamCompleter\` 管动图，\`OneFrameImageStreamCompleter\` 管静图。
4. Widget 的 \`ImageStreamListener\` 挂上。第一帧就绪就 \`setState\`。

解两次的常见原因：

- 两个 \`Image\` 的 \`configuration\` 不同（dpr、locale 一般不影响 network key，但 \`ImageConfiguration.size\` 影响 \`ResizeImage\`）。
- 一个用 \`cacheWidth: 200\`，一个不用。
- url 带随时间变的 query（签名 URL）。key 每分钟变，cache 废了，还泄漏旧项直到 LRU 踢掉。
- 自定义 provider 没实现 \`==\` / \`hashCode\`，每次 \`putIfAbsent\` 都当新 key。

\`FadeInImage\` / \`cached_network_image\` 在 Framework 的 cache 之外可能再做磁盘 cache。磁盘命中仍要解码。磁盘 cache 解决的是网络，不是 48MB RGBA。插件若把解码后的文件写成 PNG 再读回来，会更慢更大。磁盘只存压缩原图或已经缩好的缩略图。

\`precacheImage(provider, context)\` 需要 \`BuildContext\` 是因为 \`ImageConfiguration\`（dpr、locale、size）。在 \`main()\` 里没有 MediaQuery 时 precache，dpr 可能是 1.0，真机 3.0 上会再解一次，预热白做。放到第一帧有 \`MediaQuery\` 之后，按真 dpr 算 \`cacheWidth\`。

错误处理：\`ImageStreamListener.onError\`。cache 会不会留下失败项，随实现。失败应 \`evict\`，否则短暂网络错误会把「失败」缓存到 LRU 结束。\`errorBuilder\` 只是 UI，不负责 evict。

## 11. 列表、动图、内存上限怎么定

Feed 场景给一组可执行的不变量，而不是「适当设置 cache」：

- 解码宽度 ≤ \`itemWidth * dpr * 1.2\`（1.2 是给轻微放大/过冲）。超过就是浪费。
- 同时解码 ≤ 3。多余的排队。滚动速度高于解码速度时，优先取消已离开视口的请求（\`ImageProvider\` 取消能力有限，至少不要 \`keepAlive\` 它们）。
- 同时解码后的 live 图 ≈ 视口张数 + 1 屏缓冲。十屏之外必须可淘汰。
- 动图：视口内最多 1～2 个在播，其余显示首帧静态 \`ui.Image\`。
- \`maximumSizeBytes\` 设成「大约 2 屏缩略图 + 1 张大图预览」，不要设成 500MB。机器 RAM 2GB 和 12GB 用同一上限是懒。
- 大图预览页 \`push\` 时解大图，\`pop\` 时 \`evict\` 大图 key，留下缩略图 key。

\`\`\`dart
class SizedNetworkImage extends StatelessWidget {
  const SizedNetworkImage({required this.url, required this.logicalWidth});
  final String url;
  final double logicalWidth;

  @override
  Widget build(BuildContext context) {
    final w = (logicalWidth * MediaQuery.devicePixelRatioOf(context)).round();
    return Image.network(
      url,
      cacheWidth: w,
      filterQuality: FilterQuality.low,
      gaplessPlayback: true,
    );
  }
}
\`\`\`

\`gaplessPlayback\` 避免切换 key 时闪白；它会把旧 \`ui.Image\` 多留一会儿。和 \`evict\` 一起用时要理解：旧图可能仍 live。这是闪白和内存之间的取舍。

\`filterQuality\` 影响采样成本，不影响解码尺寸。低质量采样在滚动中更便宜。定住再切高质量是产品策略。

\`PaintingBinding.instance.imageCache.clearLiveImages()\` 是最后手段，会让当前屏闪。用于内存警告回调（\`didHaveMemoryPressure\`）时，先 \`clear()\` 淘汰非 live，仍不够再清 live。不要每进一次后台就清 live——回来全白再解一遍，又是 CPU 尖刺。

### \`ui.Image\` 的 dispose 契约

\`ui.Image\` 实现了显式 dispose。ImageCache 和 \`Image\` Widget 正常路径会处理。你一旦 \`frame.image\` 拿到手，契约就转到你：

- 交给 \`RawImage\` 的 \`image:\` 参数，Widget 并不自动拥有销毁权，除非文档写明。\`RawImage\` 不 dispose 传入的 image。
- \`Canvas.drawImage\` 用完，图像若不再展示，立即 dispose。
- \`toImage\` 得到的每一帧都是新 \`ui.Image\`，截图循环不 dispose 必炸 GPU。
- dispose 后还 \`drawImage\` 是原生崩溃，不是 Dart 异常。

\`clone()\` 增加一份句柄，必须成对 dispose。把 \`ui.Image\` 放进 \`ChangeNotifier\` 当全局封面图，要在替换时 dispose 旧的。这和 ImageCache 淘汰是独立的——全局 notifier 让 image 永远 live。

### HTTP、重定向、内存中的压缩数据

\`NetworkImage\` 下载的 bytes 在解码前是压缩数据，解码后应丢弃。自己写下载时，常把 \`Uint8List bytes\` 留在 repository 里「方便重解」。这等于压缩和 RGBA 同时活。重解用文件或磁盘 cache，内存只留一份 RGBA 或什么都不留交给 ImageCache。

重定向 URL 作为 key：最终 URL 和请求 URL 不同，可能解两份。统一用 canonical url。

HTTP 缓存头和 ImageCache 无关。304 省网络，不省解码。磁盘上的 jpeg 每次进内存仍要解码（除非你缓存的是已解码文件，那更占磁盘且版本难管）。

### 内存警告与多 Engine

\`didHaveMemoryPressure\` 在 Android \`onTrimMemory\` 等路径进来。此时应：

1. \`imageCache.clear()\` 
2. 大图页 \`evict\`
3. 不要指望立刻回收 GPU，下一帧再看

多 Engine：每个 Isolate 一份 ImageCache。A 页清了，B 页的 cache 还在。内存警告要广播到所有 Engine（原生遍历 Group 里的 engine 发消息）。只清当前可见页，RSS 降不下来时去查另一份 Isolate。

### ImageCache 的淘汰不是立即释放

LRU 踢出 completer 后，若还有 \`ImageStreamListener\`（某 Widget 仍显示），completer 继续 live，字节仍计入 \`liveImageCount\` 相关统计（字段名随版本）。\`currentSizeBytes\` 有的版本不含 live。看文档当前实现，调试时把 \`liveImageCount\`、\`currentSize\`、\`currentSizeBytes\` 一起打。只看一个数会误判「cache 已经很小」。

踢出且无 listener 后，\`ui.Image.dispose\` 进入队列。GPU 侧再晚几帧。内存曲线下降是台阶不是悬崖。压测时 \`pump\` 足够帧再采样 RSS。

\`putIfAbsent\` 的 loader 抛错：cache 不应留下永久失败项。若你观察到某 url 永远白图，先 \`evict\`。自己写 provider 时，失败路径 \`completer.setError\` 并确保 cache 可驱逐。

### 颜色空间、HDR、预乘 Alpha

解码得到的像素可能是 sRGB、Display P3、或带预乘 alpha。\`drawImage\` 时引擎会转换。转换可能发生在上传时，格式不一致会多一份缓冲。能在解码参数里指定目标格式就指定。HDR 图在 SDR 屏上的 tone mapping 发生在 GPU，算填充，不算 cache 字节。但 HDR 纹理格式更贵。列表用已经 tone map 过的 SDR 缩略图。

预乘 vs 非预乘搞错，边缘有黑晕。这不是 cache bug。\`decodeImageFromPixels\` 的 \`format\` 参数必须和 C 侧输出一致。

### 磁盘预解码队列

自己做「滚动预加载」时，用一个长度有限的队列：只预加载下一屏 url，带 \`cacheWidth\`，完成的结果进 ImageCache。滑过的 url 取消（HTTP 层取消；解码中的可能取消不了，就让它完成并被 LRU 踢）。无界预加载等于把 Feed 全部解进内存，cache 上限会变成「淘汰刚刚预加载的、留下正在看的」，来回抖动，磁盘和 CPU 打满。有界队列是和 LRU 配套的不变量。

### 解码器选择与 isolate

\`instantiateImageCodec\` 走内置编解码（libjpeg-turbo、libpng、libwebp 等），在 IO Runner。自己用 FFI 解 HEIF，要自己选线程，别放 UI。解完像素再 \`decodeImageFromPixels\`，这一步仍可能上传。量两段时间。

多帧 GIF 的 \`getNextFrame\` 按需。\`Image\` Widget 会按帧调度。离屏仍调度就是耗电。\`TickerMode.of(context)\` 为 false 时应停止。自己写播放器要听 TickerMode。

### 缓存键包含什么：一份检查表

url、scale、cacheWidth/Height、headers 中影响内容的部分、颜色变换若发生在解码前、locale 一般不含。\`ColorFiltered\` 在绘制时发生，不应进 ImageCache key——同一份位图多次滤镜。滤镜很重且结果要复用，才另做一层缓存，注意那是另一份 RGBA。

### OOM 现场怎么取证

java/native heap dump、GPU 纹理列表、\`imageCache\` 三个计数、当前路由、可见 Image url 列表（Debug 自己打）。没有 url 列表你会以为是泄漏，其实是当前屏 20 张未缩小的图。取证包进内部 debug 手势（三击版本号）。线上采样不要带 url 若 url 含隐私 token，打 hash。

图片管线的 SLA 可以写成三条数字，放进客户端基建文档：默认解码宽 ≤ 屏幕宽 × dpr；ImageCache 字节上限 ≤ 设备 RAM 的某个小比例（例如 1/40，并设 50～150MB 夹紧）；滚动中同时解码 ≤ 3。三条都能自动化检查：CI 扫 \`Image.network\` 是否带 cacheWidth（允许白名单大图页）；运行时打点 \`currentSizeBytes\` 和单张解码像素。没有 SLA，每个业务页都会「这一张需要高清」。高清的代价是 48MB，不是「看起来清楚一点」。把 48MB 写进 PR 描述，产品才会一起做决定。

动图 SLA：同时播放 ≤ 1（Feed）或 ≤ 2（详情）。超出显示封面。系统静音/省电模式停播。这些是产品规则，实现只是 \`TickerMode\` 和控制器。把规则推给「系统自己会管」会在低端机上失败。

泄漏排查顺序固定：先列当前 live url 和像素数，再看 cache 计数，再看 GPU 纹理，再看是否 keepAlive / 全局 Map。反了顺序会去「调 cache 上限」而当前屏就已经 400MB。顺序是本文的方法论：**先算正在显示的，再算缓存的，最后才是泄漏。** 正在显示的只能减尺寸或减张数。缓存才能 LRU。泄漏才 evict/dispose。三种药不能串。

图片组件库应成为唯一入口：\`AppImage.network(url, logicalWidth: ...)\` 内部算 cacheWidth、errorBuilder、fade、evict 策略。禁止业务直接 \`Image.network\`。lint 或自定义 lint 扫。唯一入口才能让 SLA 落地，否则总有人复制旧代码不带宽度。

入口内部处理：空 url、data url、资源图、网络图分支。资源图仍要 cacheWidth，包里的 4K 插画一样能 OOM。\`Image.asset\` 不是免费午餐。

缓存统计打到开发者页：当前张数、字节、live 数、最近淘汰 key。内部包打开这一页能在客诉「闪一下」时立刻看到是不是 cache 太小导致反复解码。调上限要有前后对比，不是拍脑袋 500MB。

CDN 协作：输出 \`w\` 参数的缩略图模板。客户端 logicalWidth×dpr 对齐到 CDN 档位（例如 360/720/1080），避免 cache key 无限多。档位太密，cache 碎片化；太疏，浪费像素。三档通常够 Feed。详情用原图或最大档，并在 pop 时 evict 最大档。这是客户端与 CDN 的共同不变量，只改一端会失效。

解码错误要分类：网络 404、解码失败、OOM、格式不支持。UI 上都是裂图，指标上必须分。OOM 要降档重试（更小 cacheWidth）一次，再失败才裂图。降档是保护，不是隐藏 bug——同时打点「发生了降档」，方便发现某 CDN 档位过大。

相册导入的图经常是 4000 边长。导入链路强制最长边上限（例如 1920）再进编辑器。不要让编辑器承担原图。这是产品规则。规则写在导入按钮上，不写在 OOM 崩溃里。

\`RepaintBoundary.toImage\` 导出分享图时指定 \`pixelRatio\`，不要默认到 3 再乘屏幕宽得到一张 4000 边的 PNG。分享图 1080 边够。导出后立刻 dispose。分享链路是 GPU 峰值的常见来源，因为它和当前屏纹理叠在一起。

图片链路还要考虑版权水印、加密图、自定义解码。加密图不能进普通 NetworkImage，因为 cache key 和磁盘可能泄漏明文。解密后的 RGBA 更不能进全局 ImageCache 除非进程内且登出 evict。这类图用一次性 provider，禁止 LRU 跨账号。登出清 cache 是安全动作，不是性能动作。和 restoration 清桶是同一类纪律。

自定义解码（相机 RAW）走 FFI，输出目标尺寸，不要解全尺寸再缩。全尺寸 RAW 能到上百 MB。导入即缩小，编辑器只见工作分辨率。导出再考虑更高分辨率，在 worker 里做。UI 永远不见全尺寸。这是图片内存公式的产品形式：让「同时存活的全尺寸数」恒为 0 或 1，且 1 只出现在导出那几秒。

相册、相机、网络、资源四条导入链，应在进入 ImageCache 之前汇合到「已带目标宽高的 Provider」。汇合点是 \`AppImage\`。四条链各自算 dpr 会算错（相机页全屏、列表项小图）。汇合点只收 logicalWidth，内部统一乘 dpr 并对齐 CDN 档。以后改档位只改一处。这是图片模块的单一真相。没有单一真相，SLA 三条数字会在四条链上各解释一次，等于没有 SLA。

图片问题在生产里反复以三种面具出现：OOM、滚动 hitch、页面离开内存不掉。三张面具对应同一公式的三个变量：单张尺寸、同时张数、该释放没释放。面具不同，变量不同，药不同。遇到面具先还原成变量，再动手。动手顺序永远是：先 cacheWidth，再并发闸，再查泄漏。反了会加 cache 上限，把 OOM 推迟到更大的数字。更大的数字更难复现，更难说服产品减图。所以顺序不能反。公式不能忘。文件 KB 不能再出现在 OOM 讨论里。谁再提文件大小，就把 4000×3000×4 写在白板上。白板比感觉硬。

ImageCache 默认 100MB 像一个安全垫，但它垫的是「没人看的图」，垫不了「正在看的错误尺寸」。正在看的图要在解码那一步变小。这一步发生在 IO Runner，参数叫 cacheWidth。参数从 logicalWidth×dpr 来，从唯一入口 \`AppImage\` 来，从 CDN 档位来。三条来源必须一致，否则 key 爆炸或像素浪费。一致之后，公式里的单张尺寸被钉住。再钉同时解码数，再钉 live 张数（虚拟化列表），再处理泄漏（全局 Map、keepAlive、未 dispose 的 ui.Image）。钉完，OOM 从随机变成可申请的预算。预算可以和产品谈：这一屏允许多少张、每张多少像素。谈得动，是因为白板有公式。没有公式，谈的是「要高清」。高清没有单位。有了宽×高×4，高清有了单位。单位是这篇文章给工程的东西。单位在，内存才可治理。可治理，列表才能继续加图，而不靠碰运气。

\`AppImage\` 落地时加两条断言：logicalWidth 有限且大于 0；算出来的 cacheWidth 不超过屏幕宽×dpr×某系数。断言只在 Debug。线上用打点替代。打点发现超标，说明有人绕过入口或入口算错。绕过用 lint 抓。算错用单测：给定 dpr=3、logical=120，期望 360。单测比肉眼看糊更硬。糊是主观。360 是客观。客观才能把 SLA 钉死。钉死之后，业务要更大的图，是改档位或改白名单，不是在业务页写一个不带宽度的 Image.network。那一行是回归。回归用 lint 红。红了就不能进主分支。主分支上的图，张张有宽度。张张有宽度，公式才对每一张成立。对每一张成立，OOM 才从「某张图」变成「这一屏总和」。总和可谈。某张图不可谈，因为永远有一张要高清。谈总和，是图片治理的政治。政治要有数。数从公式来。

lint 红了不能用 \`// ignore\` 当习惯。忽略要写原因和过期时间。过期后 CI 再红。永久忽略等于没有入口。没有入口，SLA 是假的。假 SLA 比没有更坏，因为它让人以为张张有宽度。以为会放松警戒。放松的时候，4K 图会从「就这一张」进来。就这一张，是 48MB。48MB 乘列表，是事故。事故的入口是一次 ignore。所以 ignore 要贵。贵了，人才会去改 \`AppImage\`。改入口，是正路。正路走完，公式才对生产里每一张图成立。成立，这篇才算从专栏进了仓库。

主分支张张有宽度之后，还要定期看 live 张数是不是随列表长度涨。涨，说明虚拟化失效或 keepAlive 滥用。不涨，公式的第二项才被钉住。两项都钉，第三项泄漏才看得清。看得清，才能谈治理。谈完，列表可以继续加图。加图不再是赌。赌结束，图片内存从玄学变成算术。算术和 4000×3000×4 同一块白板。白板留下，讨论才能短。短讨论，是这篇给团队的速度。

白板留下公式，列表才能继续加图而不赌内存。加图有单位，单位是像素不是文件 KB。

像素有单价，单价乘张数就是这一屏的账单。账单可谈，文件 KB 不可谈。

谈账单时把张数和单价分开写，产品才能选「少一张」还是「每张小一点」。两选都是合法优化。

两选写在 PR 里，比写「尽量高清」能让评审结束。

结束在数字，不在形容词。

## 12. 小结

图片内存 = 解码尺寸 × 同时存活数，再乘 CPU/GPU 是否双份。\`ImageCache\` 只是 Isolate 内对 completer 的 LRU，不管 live 图，不管 GPU 延迟释放，不管文件 KB。从解码那一步按显示像素缩小，限制同时解码和同时播放，列表项离开就让 completer 可淘汰——这三条比任何「加大 cache」都接近根因。文件大小只决定下载时间，不决定会不会 OOM。`,

  "flutter-frame-timing-and-devtools-profiling": `优化没有测量就是玄学。把「感觉卡」直接改成换状态库、加 \`RepaintBoundary\`、开 Impeller，三种药可能都开错。\`FrameTiming\` 把一帧拆成 **UI 用时** 和 **Raster 用时**（以及 vsync 相关的时间戳）。DevTools 的时间线再告诉你时间花在哪类调用。先分类，再下药。两者缺一：只有线上数字不知道函数名，只有本地火焰图不知道用户设备分布。

读完你应该能独立回答三个问题：\`buildDuration\` 超了该减什么、\`rasterDuration\` 超了该减什么、为什么两者之和不是用户可见延迟。

## 1. 先画边界：一帧的时间戳

Engine 在 UI Runner 和 Raster Runner 上打点，经 \`SchedulerBinding\` 汇总成 \`FrameTiming\`。关键字段：

| 字段 | 含义 | 超了说明什么 |
|---|---|---|
| \`vsyncStart\` | 这一拍 Vsync 到来 | 节拍器 |
| \`buildStart\` / \`buildFinish\` | UI 线程做 Animate/Build/Layout/Paint 记账 | Dart / 布局 / 记录绘制太重 |
| \`rasterStart\` / \`rasterFinish\` | Raster 执行 DisplayList、提交 GPU | 层、模糊、大图、着色器、填充 |
| \`buildDuration\` | \`buildFinish - buildStart\` | 同上 |
| \`rasterDuration\` | \`rasterFinish - rasterStart\` | 同上 |
| \`totalSpan\` | 从 vsync 到栅格结束的跨度 | 含排队，不等于两段相加 |
| \`vsyncOverhead\` | 唤醒晚于 vsync 多少 | 上次工作没吃完、线程忙 |

流水线：Raster 画第 N 帧时，UI 可以已经在建第 N+1。所以 **两段可以在时间上重叠**。用户看见的掉帧，是「到了该上屏的那一拍，buffer 还没好」。任一端持续超过帧间隔（16.6ms / 8.3ms），队列堆积，掉帧从尖刺变成持续。

不变量：

- \`buildDuration\` 对 GPU 填充不敏感。
- \`rasterDuration\` 对 Dart 布局不敏感。
- 一次 GC STW 会打进 \`buildDuration\`（发生在 UI Isolate 时）。
- shader compile 打进 \`rasterDuration\`，且「只第一次」。
- Platform View 的系统合成延迟 **不一定** 完整出现在这两个字段里。触控跟手还要加上 SurfaceFlinger / Core Animation。

\`\`\`dart
WidgetsBinding.instance.addTimingsCallback((timings) {
  for (final t in timings) {
    final uiMs = t.buildDuration.inMicroseconds / 1000;
    final gpuMs = t.rasterDuration.inMicroseconds / 1000;
    final budget = 1000 / (t.frameNumber == 0 ? 60 : 60); // 用显示刷新率更准
    if (uiMs > 16 || gpuMs > 16) {
      // 上报：路由、哪一侧、是否连续
    }
  }
});
\`\`\`

不要每帧 \`print\`。回调本身在 UI Isolate，日志 IO 会制造你正在查的卡顿。

## 2. 预算从哪来：60Hz、120Hz、可变刷新

\`16.6ms\` 不是物理常数。120Hz 是 \`8.3ms\`。Android 可变刷新可能在 30～120 之间跳。预算变了，同样的 10ms build 从「安全」变成「危险」。线上应按 \`FrameTiming\` 关联的刷新率或 \`display.refreshRate\` 分桶，不要用 16.6 一刀切。

连续三帧超预算和单帧尖刺是两种病。单帧：第一次 shader、一次老年代 GC、一次同步 IO。连续：每帧都重的 build 或每帧都离屏。优化策略完全不同。后者才能用「减 Widget / 减层」治；前者要找冷启动路径。

\`vsyncOverhead\` 大：UI 线程没在 vsync 时醒来，常见原因是上一帧 build 拖太久、或主 Isolate 被同步调用堵住（Channel 编码、FFI、文件）。它不是独立的第三种病，是「上一帧的债」。

## 3. DevTools：时间线怎么读

CPU Profiler / Timeline 的轨道：

- **UI：** \`vsync\`、\`animate\`、\`build\`、\`layout\`、\`paint\`、\`submit\`。柱子宽就是 \`buildDuration\` 的来源。
- **Raster：** \`GPU\` / Impeller pass、\`upload\`、\`tessellate\`。柱子宽对应 \`rasterDuration\`。
- **IO：** 解码。它不直接进 FrameTiming 两段，但解码完成会在后续帧的 Raster 上传里爆。
- **Platform：** 插件、Platform View。ANR 在这里，不在 FrameTiming。

读火焰图的纪律：

- 先看超的是哪条轨道，再点开函数。不要对着一张「很忙」的图猜。
- \`build\` 里全是你的 \`build()\` 和 \`setState\` 链路；\`performLayout\` 深说明约束传递或固有尺寸测量（\`TextPainter\`、\`Intrinsic\`）。
- \`paint\` 记录太重：过多 \`saveLayer\`、过大 path、每帧 \`new Picture\`。
- 打开 **Track Widget Builds** 才能看见是哪个 Widget rebuild。没开就猜状态库，是在浪费时间。
- **Enhance Tracing**（layout / clip / rebuild）有开销，只在复现时打开。
- Profile 模式才接近 Release。Debug 的 JIT、asserts、逐层 checkerboard 会撒谎。

Performance overlay：UI 条和 GPU 条。UI 红减 Dart；GPU 红减层和像素。棋盘格闪烁 = \`RepaintBoundary\` 缓存每帧失效。

## 4. 分类后的动作，不要交叉开药

**UI 超、Raster 健康**

- 减 rebuild 范围：更细的 \`State\`、\`ListenableBuilder\`、\`const\`、拆 \`InheritedWidget\` 通知面。
- 减 layout：能 \`relayout boundary\` 就钉尺寸；不要在滚动回调里 \`TextPainter.layout\` 整篇文章。
- 重计算离开 Isolate：JSON、加密、排序。\`compute\` 的回包不要大到解码本身卡 UI。
- 查 GC：DevTools Memory 看 scavenge 是否和帧尖刺重合。热路径复用 \`Paint\`/\`Path\`/\`List\`。

**Raster 超、UI 健康**

- 减 \`saveLayer\`：整页 \`Opacity\`、不必要的 \`Clip.antiAliasWithSaveLayer\`、全屏 blur。
- 减像素：图片 \`cacheWidth\`、不要离屏再放大。
- 减层：能合成进同一 Picture 的不要强行 \`RepaintBoundary\`。
- 第一次才超：shader / 字形 / 路径，走 Impeller 或 warmup，见前篇。

**两边都超**

通常是「一棵巨大的树既 layout 又 paint」，例如没有 sliver 的超长列、自定义 \`RenderObject\` 每帧 layout。先让 layout 成为 boundary，再谈 paint。

**两边都不超仍觉得跟手差**

输入延迟、Platform View、系统合成、120Hz 没打开、\`vsync\` 对齐导致的一帧排队。这不是 Dart 优化能抹平的。测 \`pointer\` 到上屏要用系统工具，不是只看 \`buildDuration\`。

## 5. 线上采样：怎么才有统计意义

每帧都上报会打爆自己的 Channel 和磁盘。正确形状：

- 只报超预算帧，或 1% 采样。
- 带：路由、前后台、刷新率、连续超帧计数、设备档、是否 Impeller。
- 分 P50/P95，不要只看平均值——compile jank 会被平均藏掉。
- 把「首次进入某路由的前 30 帧」和「稳态滚动」分成两个指标。

\`addTimingsCallback\` 在 Release 可用。它拿不到函数名。函数名靠：本地用 Timeline 复现同类路由，或极少量的 \`DartDeveloper\` 自定义 \`Timeline\` 事件打在可疑函数上（有开销，用开关）。

不要用 \`Timer\` 每秒 \`debugDumpRenderTree\` 当监控。

## 6. 生命周期与测试陷阱

\`addTimingsCallback\` 要在 \`dispose\` 里卸。热重载会叠加回调，Debug 里越跑越慢。

测试里 \`tester.pump\` 的时间不是真 Vsync。\`pumpAndSettle\` 更不是用户设备。性能测试用 \`integration_test\` + \`Timeline\` 摘要，或真机 Profile。CI 模拟器的 GPU 和真机是两个物种，Raster 数据只能当回归，不能当绝对预算。

Engine 后台（\`paused\`）仍可能有残留回调。后台报的「超帧」不要和前台用户体验混在一个报警里。

多 Engine：每份 Engine 自己的 timings。只连着 DevTools 那一份。线上要按 engine id 分。

## 7. 设计取舍

- **流水线并行：** 吞吐高。代价是至少一拍的显示延迟，\`build+raster\` 不能理解成串行用户等待。
- **两段计时：** 分类便宜。代价是系统合成、输入队列不在里面，跟手问题会误导你继续减 Widget。
- **Profile 接近 Release：** 可测。代价是断言关闭后某些 Debug-only 的 layout 异常消失，要以 Release 为准做最终判断。
- **overlay 和 checkerboard：** 本地立刻看见 GPU 病。代价是它们改变填充和带宽，测完必须关。

把 FrameTiming 当「性能分数」做 KPI 会逼人优化平均值。正确 KPI 是超帧率和连续掉帧，按路由和刷新率分层。

## 8. 排障流程（按层，不按感觉）

1. 超的是 UI 还是 Raster？连续还是单次？
2. 单次：GC、shader、首次解码、首次字体。Timeline 对一下时间点。
3. 连续 UI：Track Widget Builds，找 rebuild 最宽的节点。问它是否必须每帧变。
4. 连续 Raster：checkerboard、layer dump、减 blur/clip/opacity。问像素数。
5. 两边干净：输入路径、Platform View、刷新率、是否在模拟器。
6. 只某机型：驱动、Impeller 回退、热节流（持续 raster 高导致降频，看起来像「越用越卡」）。

\`\`\`dart
void _install() {
  SchedulerBinding.instance.addTimingsCallback(_onTimings);
}

void _onTimings(List<FrameTiming> list) {
  var uiOver = 0, rasterOver = 0;
  for (final t in list) {
    if (t.buildDuration > const Duration(milliseconds: 14)) uiOver++;
    if (t.rasterDuration > const Duration(milliseconds: 14)) rasterOver++;
  }
  if (uiOver + rasterOver == 0) return;
  // 聚合后再上报
}
\`\`\`

阈值用 14 而不是 16.6，是为了在 60Hz 上留余量；120Hz 要再降。不要把阈值写死成魔法数而不带刷新率。

## 9. 自定义 Timeline 事件该打在哪

打在你怀疑的边界，不要打在每个 \`build\`：

- Isolate 回包解码前后
- 一次自定义 \`performLayout\` 的重计算
- FFI 调用
- 「我认为很快」的图片处理

事件会出现在 UI 轨道，宽度即墙钟时间。若它和超帧重合，争论结束。若从不重合，把这段优化从清单里删掉。性能工作最大的浪费是优化不在关键路径上的代码。

## 10. SchedulerPhase、帧策略、以及你在错误的相位做事

\`SchedulerBinding.schedulerPhase\` 告诉你现在在帧的哪一段：\`idle\`、\`transientCallbacks\`（Ticker）、\`midFrameMicrotasks\`、\`persistentCallbacks\`（build/layout/paint）、\`postFrameCallbacks\`。在 \`build\` 里 \`setState\` 会断言或排到下一帧。在 \`layout\` 里读还没 layout 的子节点会脏环。性能问题常是相位用错：在 \`ScrollNotification\`（可能落在 layout 之后或中途）里同步算一遍固有尺寸，等于额外 layout。

\`WidgetsBinding.instance.addPostFrameCallback\` 把活推到本帧 paint 之后、下一 vsync 之前。适合「读 size 再决定」，不适合「每帧重计算」。回调里再 \`setState\` 必打下一帧。动画里 post-frame \`setState\` 是双倍 build。

\`SchedulerBinding.scheduleWarmUpFrame\` 在没有 vsync 的启动阶段强行跑一帧，让第一屏早点出来。warmup 帧的 timings 往往难看，统计时要排除启动后前 N 帧，否则 P95 永远是启动。

帧策略：\`LiveTextInput\`、\`TickerMode\` 关闭时动画不跑，帧可以少。后台 \`paused\` 应停止 Ticker。自己写的 \`Timer.periodic(16ms)\` 不会停，会在后台继续 \`setState\` 失败或积压。这是「上架后耗电」和「回来第一帧巨卡」的来源——积压的帧或积压的微任务。

\`handleBeginFrame\` / \`handleDrawFrame\` 是 Engine 打进 Dart 的入口。中间若你用 \`await\` 卡在 \`persistentCallbacks\` 里，帧无法结束，Raster 拿不到 Scene，屏幕冻结。\`build()\` 必须同步。异步数据用「已有快照 + 以后再 setState」，不要 \`FutureBuilder\` 在每帧新建 Future（那会每帧重启异步，看起来像性能问题，其实是生命周期问题）。

## 11. 火焰图以外：raster cache、shader 时间、系统工具

\`FrameTiming\` 在较新版本还带 \`layerCount\` 一类 hint（以你用的 SDK 为准）。图层数高且 raster 高，比「我感觉 Opacity 多」硬。

Skia 时代 Timeline 上的 \`RasterCache\` 命中/失败：缓存命中省 CPU 记录，费显存。失败还费。Impeller 下这套缓存语义变了，不要用旧文的「加大 raster cache 上限」当通用药。

shader compilation：Timeline 事件名随后端变（\`GrGLProgramBuilder\`、\`impeller\`、\`Precompile\`）。线上没有函数名，只能用「该路由第一次连续 raster 尖刺」当代理指标。代理指标要按版本和是否 Impeller 分维，否则 Impeller 覆盖率一升，这个指标自己降下来，你会误以为某次业务优化成功了。

系统工具补 FrameTiming 看不见的：

- Android \`systrace\` / Perfetto：SurfaceFlinger、Binder、GPU fence。Platform View、主线程 ANR。
- iOS Instruments：Core Animation、Metal System Trace。跟手延迟、离屏。
- \`adb shell dumpsys gfxinfo\`：框架帧、GPU 帧。和 Flutter 的两段不是同一套数，用来交叉验证「系统也认为掉帧」。

把 Flutter timings 和 gfxinfo 对上：Flutter raster 短但 gfxinfo 长 → 病在系统合成。Flutter raster 长 gfxinfo 也长 → 病在 Flutter 提交的内容。只看一边会错怪 OEM 或错怪自己。

\`debugProfilePaintsEnabled\` / \`debugProfileLayoutsEnabled\` 给 Timeline 加色块，有开销。复现完毕关掉。CI 里跑 integration_test 录 timeline JSON，用 \`summarize.dart\` 看 \`build_avg\` / \`raster_worst\`。把阈值当回归门禁时，必须锁设备型号和刷新率，否则 120Hz 机器先红。

### 自定义指标：连续掉帧比单帧最大值重要

单帧 40ms 用户可能无感（一次 hitch）。连续 10 帧 20ms，滚动变「粘」。上报应包括：

- \`overrunStreak\`：连续超预算帧数
- \`maxStreak\` 按会话
- 该 streak 期间 UI/Raster 各自占比
- 路由、是否在滚动（自己用 \`ScrollActivity\` 或滚动通知打标）

滚动中的超帧权重应更高。静止时一次 GC 尖刺可以降权。把所有超帧当同等事件，优化方向会被启动动画带跑。

\`frameNumber\` 可用来算丢失：若 vsync 间隔是 16.6ms，两次回调的时间戳差 33ms，中间丢了一拍。\`totalSpan\` 大而 \`build+raster\` 都小，是排队或唤醒晚，查 \`vsyncOverhead\` 和主 Isolate 同步阻塞。

### 与 GC、日志、网络的耦合

\`print\` / \`debugPrint\` 在真机 USB 上可能阻塞。线上 \`log\` 打到磁盘同理。性能采样回调里做 IO，会制造 raster/ui 双假阳性。采样要：内存聚合、超阈值才入环形缓冲、每 N 秒或每路由 pop 上报一次。

网络回包在 UI Isolate \`jsonDecode\` 大 JSON，打的是 \`buildDuration\` 之外的 idle 时间，但下一帧 vsyncOverhead 会涨。看起来像「这一帧莫名其妙」，原因在上一截同步 decode。\`Timeline\` 上自定义事件包住 decode，就能对上。这是 FrameTiming 的盲区：它只覆盖帧内两段，不覆盖帧间的同步工作。所以「帧间」的重活同样要测。

### 实验室协议

固定：设备、刷新率锁死、充电、关自动亮度、冷启动等 3 秒再操作、同一套手势脚本（\`integration_test\` 或宏）。变：Impeller 开关、图片尺寸、是否打开读屏。一次只变一个。读屏开会让 Platform 线程变忙，Raster 也可能间接受语义几何更新影响。对比实验时读屏必须同开同关。

### 流水线气泡：为什么偶发一帧特别长

UI 和 Raster 并行时，若 Raster 超时，下一帧 UI 可能已经做完，Scene 排队。再下一拍，UI 可能被背压挡住（实现随版本：有的会跳帧、有的会等）。于是你看到：一帧 raster 40ms，后面一帧 \`vsyncOverhead\` 高、\`buildDuration\` 却低。这是气泡，不是 build 变快了。优化应打在那次 40ms raster，不要去「优化」后面那次空的 build。

反过来，build 40ms 时 Raster 在吃老 Scene，GPU 空一拍，然后一次提交。用户感觉是一次卡顿。Timeline 上两轨错开看，不要只看单轨最大值。

\`forceFramesOnWatch\` 一类嵌入式场景会改策略。普通 App 不要拿手表或嵌入式的帧策略套手机。

### 采样代码的线程安全

\`addTimingsCallback\` 在 UI Isolate 调用。把数据放进非同步的 \`List\` 再在 Isolate 里上报，注意回调和上报 Timer 不要并发改 List——同一 Isolate 无数据竞争，但 \`await\` 上报时回调可能插入。用「交换缓冲」：上报时 \`final batch = _buf; _buf = [];\`。不要在回调里 \`await\`。

上报 Channel 自己也耗时。超帧时再 invoke 一个 Channel，可能让下一帧更超。环形内存缓冲 + 闲时上报。闲时用 \`SchedulerBinding.scheduleTask(..., Priority.idle)\` 或路由 pop。

### 和用户体验指标对齐

FrameTiming 是实验室指标。产品指标是滚动 FPS、点击到内容、启动到可交互。三者相关但不等价。启动到可交互包含 Channel、网络、第一帧字体，FrameTiming 只覆盖其中「帧」那一段。不要用平均 \`buildDuration\` 给启动项目结项。启动用 \`TimeToFirstFrame\` / \`TimeToRasterEnd\`（Engine 有报告回调）和自己的业务 ready 点。

### 刷新率切换

游戏进页请求 120Hz，退出恢复。切换瞬间几帧 timings 乱，要排除。\`display.refreshRate\` 变化打点。在 60 和 120 之间来回的设备上，用固定 16ms 阈值会在 120 时误报。阈值 = \`1000/refresh * 0.9\`。

### 与手势、语义同时打开时的测量

打开 Performance overlay 会改填充。打开 Semantics debugger 更改。测帧时这些全关。TalkBack 开是真实用户场景，单独出一条「辅助功能开」的 P95，不要和默认混。手势竞技场本身很少成为 buildDuration 主体，除非 HitTest 极深或回调里 \`setState\` 整页。火焰图看 \`hitTest\` 宽度，深树 + 复杂 path contains 会出现。那是手势篇的病，用 FrameTiming 分类出来再去改 HitTest。

### 回归门禁数字

CI 真机：指定路由滚动脚本，\`raster_worst < 20ms\`（60Hz 设备）、\`build_worst < 20ms\`、超帧率 < 5%。锁 Impeller 开关。数字随设备改，仓库里按 device id 存基线。不要用模拟器 GPU 当门禁。

性能工作的节奏应是 **分类 → 复现 → 单变量改动 → 同一脚本再测**。分类用 FrameTiming；复现用 Profile + 真机 + 锁刷新率；单变量改动禁止同时换状态库、加 Boundary、开 Impeller。再测必须同一脚本。打破节奏的「优化周」会留下一堆无法归因的 diff，下一次卡顿不知道哪些还能留。

把 FrameTiming 接进已有 APM 时，注意采样偏差：只在 Debug 用户开、只在 Wi-Fi 上报、只在高端机，都会让线上看起来很美。采样要包含低端机和 Android 读屏用户。偏差比没有数据更危险，因为它支撑错误的自信。

最后，FrameTiming 不能替代产品体感。有人能感觉 1 帧延迟的跟手，有人对 5 帧无感。跟手问题加测 touch-to-photon：从 \`PointerDown\` 时间戳到该指针效果上屏。那可能要求引擎或系统 trace。若业务是绘画/游戏，这笔测量值得；若是表单，P95 超帧率够了。选指标要匹配交互密度。不要给设置页上触控延迟仪表盘，也不要给画布只用平均 FPS。

APM 看板最少四张图：按路由的 UI 超帧率、Raster 超帧率、首次进入前 30 帧的 raster P95、稳态滚动超帧率。一张「平均 FPS」可以不要。平均会把问题洗掉。

告警：某路由超帧率周环比上升，且分维显示不是刷新率变化、不是 Impeller 覆盖率变化。再去复现。无分维的告警会变成狼来了。

本地复现包：同一路由、同一数据夹具（固定图片尺寸）、Profile、锁 60Hz。数据夹具很重要——线上 4K 图、本地 200px 占位，你永远复现不了 raster 问题。夹具进仓库。

开发者选项：内部包打开帧图例、超帧时震动。测试同学用震动定位「哪一下卡」，再交给研发看 Timeline。没有体感开关，测试只能写「有点卡」，研发无法分类。FrameTiming 是给机器看的；震动是给人看的。两者一起，分类才快。

把「性能预算」写进页面模板：该页静止 build < 8ms，滚动 raster < 8ms（120Hz 则更严），允许的离屏效果列表。超预算的设计不进开发。预算是和设计师共用的语言。FrameTiming 是预算的测量仪。没有预算，测量仪只产生焦虑。

与电池：高刷新率 + 高 raster 会降频，然后更卡，然后你加更多 overlay 调试，更卡。测卡顿要充电、关调试叠加层。热节流单独一维，夏季真机外场测。实验室空调房会低估。

版本对比：发版后看同一路由超帧率，而不是看「我们优化了多少处」。处数是过程，超帧率是结果。结果坏了就回滚那一处效果，不要用十处微优化覆盖一处全屏 blur。FrameTiming 分维能指出是哪条路由坏了，git blame 那条路由的近期 diff，比看优化周报快。

FrameTiming 接入后，禁止再用「感觉流畅了」作为优化结项标准。结项必须是某路由某分维的超帧率下降，且无回归。感觉可以当假说，不能当结论。假说用 Timeline 验证病灶，结论用线上分维验证用户。三步缺一，优化周就是表演。

对管理者：不要下达「FPS 提到 60」这种指标。下达「主 Feed 滚动 Raster 超帧率 < 3%（60Hz 分维）」这种。前者会催生锁 60、关动画、骗平均；后者逼人减离屏。指标形状决定优化形状。本文把 FrameTiming 讲这么细，就是为了让指标能写细。写不细，原理等于没落地。

把 FrameTiming 的分类结果反写进 bug 模板：必填「UI 还是 Raster、连续还是单次、是否首次、路由、刷新率、是否 Impeller、是否读屏」。测试同学填不全就让研发退回。模板强迫分类。不分类的卡顿单是噪声。噪声多了，性能通道会和普通 bug 混在一起被忽略。通道要干净，模板要硬。硬模板是这篇原理文在流程上的落点。原理若不改流程，读完还是玄学。

测量体系一旦按 UI/Raster、首次/持续、路由、刷新率、后端分维，优化就变成可关闭的票：每张票一个分维上的数字，一个 diff，一次复测。关不掉的票说明病灶没找对，回去看 Timeline，不要再堆微优化。堆微优化是玄学的回潮。本文从 FrameTiming 字段讲到流程模板，就是为了把回潮堵住。堵住之后，图形的事归图形，Dart 的事归 Dart，合成器的事归 OEM 或 Platform View。各回各层，和专栏第一篇 Engine 分层是同一张地图。地图已经有了，测量是图上的比例尺。没有比例尺，地图只是装饰。

FrameTiming 是比例尺，DevTools 是显微镜，线上分维是地图图例。三件一起用才能在专栏这张 Engine 地图上定位。只拿显微镜看本地，会优化到没人走的路径。只看线上平均，会看不见 GLES 设备的 compile。只看比例尺不分类，会在 GPU 病上减 setState。分类句是：UI 还是 Raster，首次还是持续。两问之后才允许打开火焰图。火焰图之后才允许改代码。改代码之后必须同一脚本再测。再测之后才允许改线上指标预期。这条链比任何工具配置重要。配置会变，链不应变。链就是这篇的不变量。不变量一旦进 bug 模板，卡顿单才从噪声变成工程。工程能关票。能关票，性能工作才不是无限优化周。无限优化周是没有比例尺的症状。现在比例尺有了。用它。

比例尺还要校准：不同 Flutter 版本 FrameTiming 字段可能增减，刷新率 API 可能变。校准写进 APM 的版本适配层，不要写进每个页面。页面只报「超了」。适配层把超了翻译成分维。翻译错了，全公司看板错。看板错比没有看板危险。所以适配层要有单测：造一份 FrameTiming，断言分维键。键稳定，历史曲线才可比。不可比的曲线会在升级 Flutter 后跳变，引发假胜利或假事故。假事故消耗信任。信任一旦没了，性能通道再干净也没人填模板。模板是信任的下游。上游是校准。校准是这篇读完后基建组该做的第一件事。做了，分类才能跨年版。跨年版，原理才算进了仓库，而不只进了专栏。

基建组做完适配层单测，还要把「超了」的定义写成配置：刷新率函数，而不是字面 16。配置进远程，必要时能放宽某路由以免误报淹掉真问题。放宽要打日志。日志让放宽可逆。可逆，比例尺才不会被一次性的产品活动（例如全屏直播页）永久扭曲。扭曲的比例尺会让主 Feed 的回归被忽略。主 Feed 才是大多数用户的大多数时间。比例尺为大多数校准。活动页单独分维，单独阈值。分维是为了不让特例统治平均数。平均数不统治，模板才值得填。填了，链才转。转了，卡顿单才能关。能关，是测量的终点。终点不是永远优化。永远优化是没有终点的别名。别名不进这篇文章。

活动页单独阈值之后，主 Feed 的门禁才能长期保持严。严，是为了大多数时间。大多数时间的滚动，才是用户对「这个 App 顺不顺」的记忆。记忆不是启动动画，不是一次 hitch。记忆是持续。持续用超帧率抓。抓到了，用链处理。处理完，关票。关票之后不要再为感觉开新的优化周。感觉去对照分维。分维说没有，就相信分维，去查别的（跟手、合成器、读屏）。别的在别的篇。本篇负责帧内两段。两段清了，职责尽了。尽了，才把显微镜还给下一个人。

两段清了，才去查跟手和合成器。别在已经干净的帧内两段上继续堆微优化。

微优化堆在干净的两段上，只会制造不可归因的 diff。diff 要能关票。关不掉就不要堆。

关不掉的票说明分类错了。回到 UI 还是 Raster、首次还是持续那两问，不要在错误的层上继续改。

两问答错，改得越多离病灶越远。先答对，再打开显微镜。

显微镜很贵，问句很便宜。便宜的先问。问完再决定值不值得打开 Timeline。

先问清楚，再测。

## 12. 小结

\`FrameTiming\` 给病种：UI 还是 Raster，尖刺还是持续。DevTools 给病灶：哪个函数、哪一层、哪张图。流水线让两段并行，所以不要把它们加起来当用户等待，也不要在 GPU 病上减 \`setState\`。线上只采样超帧并按路由和刷新率分层，本地用 Profile 时间线复现。能稳定回答「哪一侧、是否第一次、哪个节点」，优化才是工程而不是玄学。`,

  "flutter-accessibility-semantics-tree": `看见的树是 RenderObject；读屏器用的是 **Semantics 树**。两者并行，不是同一棵树的「无障碍模式」。关闭辅助功能时，语义管道几乎零成本；打开 TalkBack / VoiceOver 后，它成为第二条必须与布局同步提交的路径：脏语义 → 合成 \`SemanticsNode\` 树 → Engine 做成 \`SemanticsUpdate\` → 平台无障碍桥映射成 \`AccessibilityNodeInfo\` / \`UIAccessibility\` 元素。自定义绘制如果只画像素不供语义，结果是「能看见、能点到、读屏说没有按钮」。

读完你应该能独立回答三个问题：为什么视觉上的一个滑杆必须在语义上变成 slider、\`MergeSemantics\` 合并的是焦点还是绘制、打开读屏后掉帧该查哪条线程。

## 1. 先画边界：两棵树服务两个消费者

GPU 消费 Layer 树。人与系统服务（读屏、开关控制、输入法辅助、部分自动化测试）消费语义树。映射不是一一对应：

- 一个 \`RenderCustomPaint\` 可以画出整张键盘，语义上必须是多个 key。
- 一个视觉按钮可能由图标 + 文字 + 水波纹三个 RenderObject 组成，语义上应是 **一个** 按钮。
- \`Offstage\` / \`Opacity(0)\` / 零尺寸不一定等于语义消失；\`ExcludeSemantics\` / \`IgnorePointer\` 也不自动互为充要。

不变量：

- 语义更新跟 **UI Runner** 走，提交给 Engine 后，平台桥在 **Platform Runner** 上改系统无障碍节点。打开读屏时，主线程多了一份工作。
- 语义节点有自己的几何（屏幕坐标上的 rect），来自 RenderObject 的 paint bounds 变换。transform / clip / scroll offset 必须反映进语义几何，否则焦点框画在错的地方。
- 没有语义的可点控件，是产品 bug，不是「无障碍没开所以无所谓」。自动化和系统手势也会走这棵树。

\`SemanticsBinding.ensureSemantics()\` 会强制开管道，即使系统读屏没开。测试里常用。生产里不要无故 ensure——你在付第二条提交路径的钱。

## 2. 节点从哪来：Configuration 的合并规则

每个 RenderObject 可贡献 \`SemanticsConfiguration\`：是否成为节点、标签、hint、value、flags（button / focused / selected / hidden / textField…）、actions（tap / longPress / scroll / setValue / copy…）。\`SemanticsOwner\` 在帧末收集脏节点，做一次合成。

合成时的关键开关：

- **\`isSemanticBoundary\`：** 自己成为独立节点。
- **\`isMergingSemanticsOfDescendants\`（\`MergeSemantics\`）：** 子孙的标签和动作收进自己，子孙不再单独露出。图标+文字的按钮靠这个变成一次朗读。
- **\`ExcludeSemantics\`：** 子树对语义消失。装饰性动画、重复的视觉文本用它。排除后读屏完全不知道那里有东西——可点的不要排除。
- **\`BlockSemantics\`：** 挡住后面的兄弟（模态）。和绘制上的 barrier 类似，解决的是「对话框下面的按钮仍能被读到」。
- **\`IgnoreSemantics\` vs 隐藏 flag：** \`hidden\` 仍在树上，只是标记；排除是没有。焦点遍历对两者处理不同。

错误合并的典型后果：焦点顺序乱（三个控件被读成一句）、或一句被拆成三次（没 merge）。合并不是性能优化，是 **身份** 问题，和 Element 的 Key 同一类。

\`\`\`dart
Semantics(
  button: true,
  label: '提交订单',
  onTap: _submit,
  child: const CustomPaint(painter: FancyButtonPainter()),
)
\`\`\`

\`CustomPaint\` 默认几乎不贡献语义。没有这层 \`Semantics\`，读屏在这块矩形上会沉默，尽管 \`GestureDetector\` 能点。

## 3. 动作、焦点、文本：和竞技场不同的输入

语义动作是 **另一条输入路径**。读屏用户的「激活」变成 \`SemanticsAction.tap\`，不一定经过你的 \`TapGestureRecognizer\`。所以只在 \`GestureDetector.onTap\` 里处理、不在 \`Semantics.onTap\` / 按钮的 \`onPressed\` 里处理，读屏会点了没反应。\`ElevatedButton\` 这类控件两边都接好了；自定义 \`RenderBox\` 必须自己在 \`describeSemanticsConfiguration\` 里挂 action，并在 handler 里走同一套业务。

焦点：Flutter 的 \`FocusNode\` 和平台无障碍焦点不是自动同一件事。读屏焦点移动时，平台桥会请求 \`SemanticsAction.focus\`。文本框还要同步 selection、IME。自定义文本如果只用 \`TextPainter\` 画，不提供 \`Semantics\` 的 text field 配置，VoiceOver 转子无法按字符读。

滚动：\`Scrollable\` 暴露 \`scrollUp/Down\`。读屏的「往后翻」走动作，不是拖手指。自己写的列表若不用 \`Scrollable\`，要自己报可滚动和动作，否则用户卡在视口里。

## 4. 几何、裁剪、叠层：焦点框为什么会飘

语义 rect 在屏幕坐标。\`Transform\`、滚动 offset、\`PageView\` 视差，都要进变换链。漏了，朗读内容对、绿框错位——用户以为点的是 A，激活的是 B。

\`Clip\` 后的语义：被裁掉的节点应标记 hidden 或从树上摘掉，取决于是否还可交互。\`OverflowBox\` 画在外面但仍可点，语义也必须在外面。这和 HitTest 一致：语义几何应覆盖可交互区域，而不是「看起来的区域」。

Platform View 是又一次断裂：原生 WebView 有自己的无障碍树。Flutter 这一侧往往只有一个「占位」节点。深度读屏要进 WebView 内部，靠平台桥切换。不要对 Platform View 再 \`MergeSemantics\` 包一层假标签把内部挡死，除非它真的不可达。

## 5. 线程、内存、帧成本

关闭语义：\`RenderObject\` 仍可能做很轻的 configuration 标记，但不组树、不发 update。成本可忽略。

打开后：

- 每帧若有语义脏（动画改 label、进度条改 value、列表滚动改可见窗口），UI 线程要重算节点和几何。
- 提交到 Engine 后，Android \`AccessibilityBridge\` 在主线程上 diff 并更新 \`AccessibilityNodeInfo\`。频繁改 value（每帧进度百分比）会打满 Platform Runner。
- 节点数量近似「可交互控件数」，不是 Widget 数。但错误地让每个装饰图标都成为节点，会让读屏遍历无法使用，也会让 diff 变贵。

不变量：**动画不要每帧改语义字符串。** 进度用 \`value\` 且降频（100ms 一次或只在停时更新）。滚动中的列表靠框架的可见窗口更新，不要自己每像素 \`setSemantics\`。

内存：语义树相对 Layer 很小。真正的成本是主线程 IPC 到系统 \`AccessibilityService\`。测打开 TalkBack 后的 \`vsyncOverhead\` 和 Platform 轨道，不要只看 Dart 堆。

## 6. 生命周期

\`SemanticsHandle\` 的持有者（测试、Inspector、系统读屏）决定管道开关。最后一个 handle 释放，管道关。自己 \`ensureSemantics\` 必须配对 dispose，否则生产里语义一直开——低端机上能测出掉帧。

Element unmount：对应语义节点要从树上摘掉，否则平台侧残留「幽灵焦点」，朗读已经不存在的按钮。这是框架的活；自定义 \`SemanticsOwner\` 才需要自己担心。

热重载后语义树重建。Debug 里读屏顺序偶发错乱，以 Release + 真机为准。

多 Engine：每份 Engine 一份语义桥。系统读屏一次只深度进入一个窗口。混合 App 里 FlutterView 和原生 View 的焦点切换靠 Embedder，不是 Dart 的 \`FocusScope\`。

## 7. 设计取舍

- **独立语义树而不是给 Layer 加标签：** 视觉和辅助可以分叉（一个滑杆、一段 Path）。代价是两套要同步，漏了就是无障碍 bug。
- **默认控件带语义、自定义绘制不带：** 让普通 App 自动可用。代价是游戏、图表、自绘控件作者必须补作业。
- **Merge 以「用户理解的控件」为粒度：** 一次激活一件事。代价是过度 merge 会让内部元素不可达（例如按钮里的「更多」被吞）。
- **打开才组树：** 默认用户不付费。代价是「没开读屏时测不到」——CI 要用 \`SemanticsHandle\` 强制开。

Flutter 选自绘 UI，就必须自己做这棵树。这是 Engine 架构那篇说过的账单：像素跨端一致，无障碍要自己接。

## 8. 排障

1. **能点不能读：** 自定义绘制缺 \`Semantics\`。用 DevTools 的 Semantics 调试器或 \`debugDumpSemanticsTree()\` 看节点在不在。
2. **读三次：** 缺 \`MergeSemantics\`，图标、文字、Ink 各成节点。
3. **读一次但内部不可达：** 过度 merge。把可独立操作的孩子移出 merge。
4. **焦点框错位：** 变换/滚动没进语义几何。看节点 rect 和真实 paint bounds。
5. **打开 TalkBack 掉帧：** 每帧改语义。降频 value，动画不要改 label。查 Platform 线程。
6. **对话框下面还能读到：** 缺 \`BlockSemantics\` / \`ModalBarrier\`。
7. **测试绿、真机红：** 测试没 \`ensureSemantics\`，或只断言了像素。用 \`tester.getSemantics\` / \`matchesSemantics\`。
8. **Platform View 内部读不到：** 期望错了。进原生树，或给占位标签说明「网页区域」。

\`\`\`dart
testWidgets('提交按钮可被读屏激活', (tester) async {
  final handle = tester.ensureSemantics();
  addTearDown(handle.dispose);
  await tester.pumpWidget(const MyForm());
  expect(
    tester.getSemantics(find.byKey(const Key('submit'))),
    matchesSemantics(label: '提交订单', isButton: true, hasTapAction: true),
  );
});
\`\`\`

没有这个测试，语义回归只能靠人听。像素回归测不出它。

## 9. 自定义 RenderObject 必须同步的三件事

\`paint\`、\`hitTest\`、\`describeSemanticsConfiguration\` 是同一个控件的三个面。改一个必须问另两个：

- 画了新的可点区域？hit 和语义 rect 要扩。
- 加了手势？语义要有对应 action，handler 走同一函数。
- 视觉上禁用了？\`enabled\` flag 和 \`IgnorePointer\` 一起改，否则读屏仍说可激活。

漏语义不是「以后再加的 polish」。它是协议缺口。

## 10. Flag、Action、排序：读屏真正用的协议

\`SemanticsFlag\` 和 \`SemanticsAction\` 是平台桥的词典。常用 flag：\`isButton\`、\`isLink\`、\`isHeader\`、\`isTextField\`、\`isFocused\`、\`isSelected\`、\`isEnabled\`、\`isHidden\`、\`isImage\`、\`hasCheckedState\` / \`isChecked\`、\`isToggled\`、\`isLiveRegion\`。flag 决定读屏怎么称呼和转子里有哪些动作。把非按钮标成 button，用户会用「激活」预期导航，你却只做了展示。

\`isLiveRegion\`：内容变了要主动朗读（错误提示、验证码倒计时）。滥用会变成每秒打断用户。倒计时不要 live；错误出现那一次要。

\`SemanticsAction\`：\`tap\`、\`longPress\`、\`scrollLeft/Right/Up/Down\`、\`increase/decrease\`（滑杆）、\`setSelection\`、\`copy/cut/paste\`、\`didGain/LoseAccessibilityFocus\`。滑杆只画不提供 increase/decrease，转子调值会失败。自定义 \`RenderSlider\` 必须把 value、valueMax 和这两个 action 写全，handler 里改同一份状态再 \`markNeedsSemanticsUpdate()\`。

\`SemanticsSortKey\` / \`OrdinalSortKey\` 决定遍历顺序。默认大致是阅读方向 + 几何。复杂仪表盘视觉顺序和阅读顺序不同，必须显式 sortKey，不要靠「把 Widget 写在前面」。\`TraversalGroup\` 把局部顺序包住，避免一个工具栏的按钮插进正文中间。

\`AttributedString\` 给 label 加 locale / 拼写提示。中英混排的按钮，locale 标错会导致 VoiceOver 用错语音库。

\`CustomSemanticsAction\` 注册「自定义转子动作」（例如「标记已读」）。平台能展示的数量有限，不要当普通菜单用。

\`ExcludeSemantics(excluding: !visible)\` 比把 label 设空更干净。空 label 的按钮仍可能停焦点。

## 11. 平台桥、测试、以及动画中的语义风暴

Android：\`AccessibilityBridge\` 把节点 id 映射到 \`AccessibilityNodeInfo\`。id 在树上要稳定，否则 TalkBack 焦点丢失。列表用 index 当语义 id 会在插入一行后焦点跳。框架用的是稳定 node id；自己 \`SemanticsProperties\` 不要每帧 new 不同的 label 导致它以为是新控件——label 变可以，角色变要谨慎。

\`AccessibilityNodeInfo\` 的 \`boundsInScreen\` 来自语义 rect。和 HitTest 不一致时，外接开关设备点的是语义框。所以「能点不能读」的对偶是「读屏焦点在、手指点不中」——两边几何没对齐。

iOS：\`UIAccessibilityElement\`。\`accessibilityTraits\` 来自 flag。系统转子（字符、标题、容器）依赖 \`isHeader\`、\`isTextField\`。标题漏标，转子「标题」会跳过整页。

测试：\`matchesSemantics\` 是回归的最小集。再加一条集成测试：\`tester.tap\` 走手势，\`tester.semantics.simulatedAccessibilityTool\` 或 \`SemanticsOwner.performAction\` 走动作，断言同一 \`onPressed\` 计数。两边不共用 handler 时，这个测试会红。

动画中的语义风暴：\`AnimatedBuilder\` 每帧改 \`Semantics(label: '\${percent}%')\`。打开读屏后 UI 线程组树、主线程 IPC、读屏进程朗读取消再朗读。表现是动画掉帧 + 语音卡成「二十二十一二十二」。改成 \`value\` 数值、\`liveRegion\` 关闭、最多 250ms 节流更新 label。进度条用 \`Semantics(value: '$_p')\` 而不是把数字写进 label 每帧换。

\`debugDumpSemanticsTree()\` 的缩进就是树。看到一堆 \`ignored\` / \`hidden\` 节点，说明排除没做干净，diff 在白做。看到整页一个节点，说明过度 merge。两者都是结构问题，调 label 字符串解决不了。

### 隐式语义：框架已经替你做了什么

\`Text\` 贡献 label（文本本身）。\`Icon\` 默认经常 **没有** 语义——装饰图标要 \`ExcludeSemantics\`，功能图标要 \`Semantics(label: ...)\` 或 \`IconButton\`。\`Image\` 无 \`semanticLabel\` 时读屏可能跳过或读「图像」。有信息的图必须 label，装饰图必须 exclude。漏 exclude 会让用户听一堆「图像图像图像」。

\`InkWell\` / \`ListTile\` / Material 按钮已经 merge + button + tap。自定义再包一层 \`Semantics(button: true)\` 会双重朗读「按钮按钮」。DevTools 里看是否已经有 button flag。能用 Material 控件就用，语义是免费的。

\`Sliver\` 列表只给可见项语义节点。这是性能不变量，也是读屏「滑不到未 build 的项」的原因。读屏滚动动作会驱动 \`Scrollable\` 去 build 下一项。自己的虚拟列表若不接 \`SemanticsAction.scrollDown\`，读屏用户卡死。\`ListView\` 接好了；\`CustomPaint\` 画的列表没有。

### 国际化、数字、日期

label 要已经格式化、已经翻译。把 \`DateTime.toString()\` 当语义，读屏会读一串 ISO。数字用 \`NumberFormat\`。货币不要只靠颜色表示涨跌，flag 或 label 要带「涨/跌」。色盲和读屏同时存在。

\`ExcludeSemantics\` 包掉重复的视觉文本（大号装饰数字 + 下面小号同一数字），只留一份。视觉双写、语义单写。

### 测试之外的手工清单

每次自绘控件合入：TalkBack 线性遍历一遍、VoiceOver 转子「标题/按钮/表单」一遍、外接键盘 Tab 一遍。后一项走 \`Focus\` 系统，和语义有交集但不是同一棵树。焦点可见性（\`FocusHighlightMode\`）在外接键盘下必须有。只测读屏会漏掉键盘用户。

\`SemanticsDebugger\` Widget 用色块把语义矩形画在屏幕上，能立刻看见几何错位和漏节点。它很吵，仅调试。

### SemanticsUpdate 是 diff 不是全量快照

Engine 收到的 \`SemanticsUpdate\` 按节点 id 增删改。Framework 尽量只发脏节点。你每帧改根上的 label，等于整棵相关子树都可能被标脏。脏的粒度是节点，不是字符。把会变的 value 放在叶子，根保持稳定的角色和 label。进度条：叶子改 value，祖先不要每帧 \`Semantics(label: '整个工具栏 \${random}')\`。

id 由框架分配，稳定性和 Element 类似。Key 不稳定导致 Element 重建，语义 id 也换，读屏焦点丢失。列表项用业务 Key，既为 diff 也为读屏。

### 隐式滚动与「读屏焦点请求可见」

节点被聚焦时，框架会 \`showOnScreen\`。自定义 \`RenderObject\` 若不实现 \`showOnScreen\` / 不加入正确的 scrollable，读屏焦点会移到屏幕外。用户听见按钮、看不见它。\`Scrollable.ensureVisible\` 是手动版。嵌在横向+纵向两层滚动里，要两层都确保。这是语义和滚动协议的接缝。

\`ExcludeSemantics\` 包掉的区域，读屏焦点不会进去，但 HitTest 仍可能进去——手指能点、读屏跳过。若这是装饰，OK；若是功能，必须一致地 \`IgnorePointer\` + \`ExcludeSemantics\`，或反过来都暴露。

### 自动化测试误用语义树

部分集成测试用语义找按钮（\`find.bySemanticsLabel\`）。这会倒逼正确语义，是好事。但测试若 \`ensureSemantics\` 后不 dispose，后续测试都在「读屏开」的成本模型下跑，性能用例会红。\`addTearDown(handle.dispose)\` 必写。也不要只靠语义找控件而完全不测 HitTest——那会放过「读屏行、手指不行」的几何 bug。两边各至少一条。

### 动态字体、粗体、系统字号

系统字号变大，视觉树 layout 变，语义 rect 必须跟着变。只改 paint 不 mark semantics，焦点框会小。\`MediaQuery.textScaler\` 变化应走正常 layout 脏路径，框架会更新语义几何。自定义 \`TextPainter\` 绘制若自己 cache 了旧 rect，要在 textScaler 变化时 \`markNeedsSemanticsUpdate\`。

### 自定义动作与确认

破坏性操作（删除）在读屏下应有确认。视觉上可能是滑删，语义上提供 \`customAction\`「删除」再弹 dialog。只靠手势的滑删，读屏用户做不到。这是手势竞技场覆盖不了的产品缺口。

### 与 Platform View、WebView 的焦点切换

焦点从 Flutter 按钮进 WebView 再出来，两端的读屏焦点栈要接。常见 bug：出来后焦点回到页面顶而不是刚才的按钮。保存「上次 Flutter 语义焦点」在离开时，回来 \`requestFocus\`。混合栈必测。测的是系统读屏，不是 \`FocusNode\` 调试高亮。

无障碍的验收应从「能不能用」升级到「能不能高效用」。能不能用：每个可点控件有角色、有名字、能激活，焦点框对齐。能不能高效用：标题层级让转子可跳，列表有 \`header\`，重复装饰被 exclude，liveRegion 不吵，排序符合阅读习惯。第一档没做到是缺陷；第二档没做到是体验债。自绘控件 PR 必须附 \`debugDumpSemanticsTree\` 片段或 SemanticsDebugger 截图，和像素截图并列。没有语义截图的自绘 PR 不合并。这条比培训更有效。

法律和商店审核在部分市场会查无障碍。即便不查，语义树仍是自动化测试的稳定锚：文案变、布局变，label 还可以当 find 句柄。投入语义，测试和读屏用户一起受益。把它当重复劳动的人，通常已经在用坐标点按钮——那种测试更脆。

与动画的关系再强调一次：语义不是每帧的展示层。展示层是 Layer。语义是状态层。状态按事件更新（完成、失败、进度到 10% 的阶梯），不按 vsync 更新。谁把语义当展示层用，谁就在读屏开时掉帧。这条不变量能解决一类「为什么开了 TalkBack 就卡」的争论：不是读屏进程魔法般变慢，是你每帧在主线程做 IPC。

语义节点的命名规范：动词+对象（「提交订单」）而不是「按钮1」。图标按钮必须有名字。关闭按钮叫「关闭」不是「叉」。规范进设计 token 和组件。组件库的 \`AppIconButton\` 强制 \`tooltip\`/\`semanticLabel\` 非空，编译期或 lint 检查。空 label 进不了主分支。

列表项语义包含状态：「已选中、未读、三十一秒」。状态变化要 \`markNeedsSemanticsUpdate\`，不要指望读屏自己猜颜色。未读红点是视觉，语义要「未读」。

多语言：label 走 l10n。硬编码中文 label 在英文读屏上会用错误语音。测试至少一种伪 locale。\`SemanticsProperties\` 的 \`attributedLabel\` 标 locale，中英混排的产品名才读得准。

与自动化：\`find.bySemanticsLabel\` 用正则时注意翻译。用 key 找控件做功能测试，用语义断言做无障碍测试，两条分开。混在一起会在换语言时把功能测试弄红，团队就会删语义断言。删了就回到零。

新同学容易把 \`Semantics(container: true)\` 当性能优化。container 影响的是节点边界和焦点，不是 GPU。乱加 container 会让转子跳得奇怪。语义属性每一个都有无障碍含义，没有「这个 flag 能让树更轻」这种用法。要轻，用 Exclude 掉装饰，而不是加 flag。

文档站的组件页应带「读屏朗读示例」一句。设计师能看见「提交订单，按钮」。比看 flag 列表直观。组件预览模式切到 SemanticsDebugger。投入很小，能挡住一批空 label。

政府/金融类 App 可能有无障碍验收清单。把清单映射到 SemanticsFlag 表，逐条自动化。比每次人工听一遍可重复。人工听仍要做，做抽样，自动化做回归。和像素测试同一结构。

语义工作要进迭代定义：每个迭代至少修一条读屏路径，或保证新自绘控件带测试。完全指望「无障碍专项」会永远排在视觉之后。专项可以做第二档高效用；第一档能不能用必须在日常 PR。日常靠 lint 和测试，专项靠真人听。两条腿。

与国际化团队的接口：新文案进 l10n 时标「也是语义 label」。过长的市场文案不适合朗读，要短名。视觉可以大段，语义要短。双重文案不是浪费，是两个消费者。和 Layer vs Semantics 两棵树同一哲学。产品接受双重文案，无障碍才能在中文营销语气下仍然好用。

语义树还可以当内部调试工具：用读屏走一遍新页，比用眼睛更能发现「能看见但点不中」的几何问题，因为焦点框暴露的是语义 rect。语义 rect 和 HitTest 不一致时，两条输入路径分裂。修到一致，手指用户也受益。无障碍不是额外税，是第二种测试仪。把读屏当测试仪用，投入会自愿发生，而不只发生在验收前夜。前夜才听，修不完。日常当测试仪，修得完。

语义树让「公开协议」四个字有了调试方法：dump、断言、读屏、焦点框。方法在，就可以要求每个自绘控件交出协议。交不出，等于控件没做完。做完的定义从「像素对」扩展到「像素、命中、语义」三面。三面是同一 RenderObject 的三个方法。三个方法一起写，比写完 paint 三个月后补 Semantics 便宜。便宜是因为那时几何还在脑子里。几何离开脑子再补，焦点框必飘。所以语义不是后置。后置是事故的时间表。前置是和 paint 同一天的时间表。同一天，才是同一控件。

无障碍在 Flutter 里贵，是因为自绘。自绘换来了像素一致，账单是自己接语义树和平台桥。账单不能拖到专项。拖到专项，等于承认日常交付的控件是半成品。半成品进生产，读屏用户就进不了生产。进不了，不是他们的设备不行，是协议没交。协议用三个方法交：paint、hitTest、describeSemanticsConfiguration。日常 PR 看三个方法是否同一天改。同一天，几何还在脑子里，焦点框不会飘。这是成本最低的无障碍。最低成本的方案反而要写进长文，因为最低成本不性感，容易被「以后专项」盖掉。盖掉之后成本最高。把最低成本写成测试和 lint，专项才能去做高效用那一档。两档分开，队伍才不会用专项去补日常的洞。洞在日常补。树在帧末提交。读屏在主线程听。你在 Dart 里按事件改状态，不按 vsync 改字符串。事件驱动的语义，才是轻的语义。轻了，打开 TalkBack 才掉得起帧。掉得起，才是真的能用。

组件库的 \`AppIconButton\` 强制 label，是把三面里的语义面抬到和视觉面相同的门禁。门禁在库边界，业务过不了空按钮。空按钮进不了库，也就进不了生产。生产上的按钮，读屏都能叫出名字。叫出名字，第一档「能不能用」就对按钮这一类成立。类成立，比零散修几个页面快。快，是因为杠杆在库。杠杆不在专项。专项修页面，库修类。先搬杠杆。搬完再听一遍主路径。听的时候带着转子跳标题。标题在，高效用那一档也开始成立。成立不是完美。完美没有。成立是可发布。可发布，是工程对无障碍该承诺的线。线画在库和测试上，不画在口号上。

可发布那条线画完，主路径听一遍仍不可少。听，是为了抓库覆盖不到的自绘页。自绘页用 dump 附件进 PR。附件比口号硬。硬了，三面同一天才能被看见。看见了，才能合并。合并了，生产里的读屏才不是抽奖。抽奖结束，才是无障碍工程的开始。开始在日常，不在专项前夜。前夜只做抽样。抽样不能代替门禁。门禁在库。抽样在人。人和库一起，树才既轻又完整。轻且完整，打开 TalkBack 才既可听又掉得起帧。两者同时成立，才算交了自绘那张账单。

## 12. 小结

语义树是 UI 对系统和人的公开协议，Layer 树是对 GPU 的协议。合并规则决定「什么算一个控件」，动作决定读屏如何驱动业务，几何决定焦点框。打开后第二条提交路径走 UI 再走 Platform 线程，所以每帧改语义会掉帧。自定义绘制必须同时提供像素、命中和语义。能 \`debugDumpSemanticsTree\` 并对上读屏焦点，无障碍就从道德要求变成和布局一样可调试的系统。`,

  "flutter-state-restoration-and-engine-lifecycle": `Android 可以在后台杀掉进程。用户回来时期望滚动位置、表单和导航栈还在。\`State\` 活在 Dart 堆上，进程死了堆就没了。状态恢复的原理不是「缓存一下」，而是：**在引擎被杀前，把一棵可序列化的恢复树交给操作系统；新进程里新 Engine 冷启动，再按 key 灌回 Element。** 它和 \`KeepAlive\`、和内存里的 \`static\`、和磁盘数据库，是三种寿命完全不同的机制。

读完你应该能独立回答三个问题：\`restoreState\` 相对 \`initState\` 何时发生、哪些状态绝对不该进 bucket、多 Engine 时 restoration id 为什么不能撞。

## 1. 先画边界：三种「还在」

| 机制 | 活过什么 | 不活过什么 | 典型用途 |
|---|---|---|---|
| \`State\` / 内存 | 重建 Widget | 进程死、Engine destroy | 当前会话 |
| \`AutomaticKeepAlive\` | 滑出视口 | 进程死、路由 pop | Tab / PageView 保状态 |
| Restoration bucket | **进程被杀** | 用户明确退出、卸载、你自己没注册的字段 | 滚动、表单、路由栈 |
| 磁盘 / 服务端 | 重装以外几乎都能 | 用户清数据 | 登录态、草稿内容本身 |

Restoration 解决的是「系统以为你还在后台，其实进程没了」的缝。它不解决「用户昨天填到一半」——那是草稿持久化，该进你自己的存储，带版本和加密。把整个 bloc 塞进 restoration 会撑爆 \`savedInstanceState\` 的预算（Android 上几到十几 MB 量级且要快）。

不变量：

- 恢复数据是 **值**，可编码，按字符串 key 成树。
- 新进程是新 Isolate、新 \`static\`、新插件实例。只有 bucket 里的东西会回来。
- 第一帧 **可以** 已经是恢复后的 UI，条件是 \`restoreState\` 发生在第一帧 build 之前。
- 没有 \`restorationId\` 的子树，整棵不参与。id 是自愿加入。

iOS 对后台杀进程比 Android 保守，但这套 API 两端都在。不要写成 \`if (Platform.isAndroid)\` 才开——开的成本很小，关的是 Android 上真实的差评。

## 2. 恢复树：Bucket 的形状

\`RestorationManager\` 持有根 \`RestorationBucket\`。\`RestorationScope\` 按 \`restorationId\` 开子 bucket，形成和 Widget 树 **相似但不等于** 的一棵树。id 在兄弟间必须唯一，否则覆盖或断言。

\`RestorationMixin\` 在 \`State\` 里：

\`\`\`dart
class _FormState extends State<OrderForm> with RestorationMixin {
  final RestorableTextEditingController name = RestorableTextEditingController();
  final RestorableInt step = RestorableInt(0);

  @override
  String? get restorationId => widget.restorationId;

  @override
  void restoreState(RestorationBucket? oldBucket, bool initialRestore) {
    registerForRestoration(name, 'name');
    registerForRestoration(step, 'step');
  }

  @override
  void dispose() {
    name.dispose();
    step.dispose();
    super.dispose();
  }
}
\`\`\`

\`registerForRestoration\` 把属性挂到当前 bucket 的某个 key 下。\`RestorableProperty\` 知道如何 \`fromPrimitives\` / \`toPrimitives\`。框架提供了 int、string、bool、text controller、scroll offset、page 控制器等。自定义对象要自己写 \`RestorableValue\`，只返回 codec 认识的 primitive（和 StandardMessageCodec 那套类似：num、string、list、map）。

\`oldBucket != null && !initialRestore\` 表示 scope id 变了，状态从旧桶迁到新桶。\`initialRestore == true\` 表示进程恢复。不要在 \`restoreState\` 里做网络请求。

## 3. 和 Engine 生命周期的时序

一次 Android 进程被杀再回来，粗时序：

1. 系统先调 \`onSaveInstanceState\`。Embedder 向 Dart 要当前 bucket 的序列化字节，写入 Bundle。
2. 进程没了。Dart 堆、GPU 纹理、Channel 注册表全没了。
3. 用户回来。新进程、新 \`FlutterEngine\`（或 Group spawn 的新 Isolate）。
4. Embedder 把 Bundle 里的字节交给 \`RestorationManager\`。
5. \`runApp\` → 第一轮 \`initState\` → **\`restoreState\`** → 第一帧 \`build\`。
6. 若 \`WidgetsApp.restorationScopeId\` 和 \`Navigator\` 的 restoration 开了，路由栈按 id 重建，深页直接出现，而不是闪首页再 push。

关键：\`restoreState\` 在 \`initState\` 之后、第一帧之前。在 \`initState\` 里读 \`name.value\` 可能还是默认值；在 \`build\` 里已经是恢复值。把「只做一次」的逻辑放 \`initState\` 且依赖恢复值，会做错。放 \`restoreState\` 或第一帧后的 \`WidgetsBinding.instance.addPostFrameCallback\` 要分清是不是只在 \`initialRestore\` 时跑。

\`AppLifecycleState\`：

- \`resumed\` / \`inactive\` / \`hidden\` / \`paused\`：进程可能还在，bucket 不必写盘，但 \`paused\` 是系统可能随后杀进程的信号。框架会在合适的时机序列化；你要保证此时 Restorable 属性已经是最新值（滚动 offset 通常由 \`Scrollable\` 自己写）。
- \`detached\`：Engine 与视图分离，即将销毁。未注册的内存状态不会有人救。

不要自己在 \`paused\` 里 \`jsonEncode\` 整个 AppState 再走 Channel 存 SharedPreferences 当作 restoration——那是另一套草稿机制，时序、大小、主线程都会打架。

## 4. Navigator、滚动、表单：框架已经接好的

- **\`WidgetsApp.restorationScopeId\`：** 总开关。没有它，下面全空转。
- **\`Navigator\` restoration：** 每个 \`Route\` 要有 id，且能用 \`onGenerateRoute\` / \`pages\` 按名重建。不能序列化的闭包路由（\`builder: (_) => MyPage(obj)\` 里捕获了内存对象）恢复不了。改成「路由名 + primitive 参数」。
- **\`Scrollable.restorationId\`：** 存 offset。列表数据源若恢复后条数变了，offset 可能越界，要能 clamp。
- **\`TextField\` + \`RestorableTextEditingController\`：** 存文本和选择。不存焦点（焦点恢复另说，且不一定符合平台习惯）。
- **\`TabBarView\` / \`PageView\`：** 存 index。

\`ModalRoute\` 上的临时 dialog 要不要恢复，是产品问题。恢复一个已经无意义的「确认删除」对话框，比丢了更糟。显式不给 dialog restorationId。

## 5. 多 Engine、Group、混合栈

每份 Engine 自己的 \`RestorationManager\`。Android 的 \`savedInstanceState\` 是 Activity 级。多个 \`FlutterView\` 共用一个 Activity 时，Embedder 必须用 **不同的 restoration id 前缀** 把多份字节塞进同一 Bundle。撞 id 就是互相覆盖，表现为「打开钱包，设置页的滚动跑到了钱包」。

Group spawn 的新 Isolate 不继承上一份 Isolate 的 bucket，除非 Embedder 把字节传进去。页面 destroy 再开，是新 Engine 还是复用，决定要不要从系统 bundle 恢复。短命的 Flutter 模块若每次 destroy Engine，应把「用户以为还在」的状态放到原生 Activity 的 view model 或磁盘，不要指望 Dart restoration——Engine 都没了，scope 也没了。

插件状态：原生单例活过进程吗？不活。权限、蓝牙连接、相机开着，全部要在新进程重新来。Restoration 只还原 UI 外观，不还原设备占用。

## 6. 内存、大小、线程

序列化发生在 UI Isolate，结果交给 Platform 线程写入 Bundle。大对象会卡最后一帧和 \`onSaveInstanceState\`（Android 上后者超时是直接丢状态或崩溃）。

预算：

- 只存 UI 需要的 primitive：int offset、string 文本、小 map。
- 图片、列表全量数据、下载中的文件，不进 bucket。
- 版本字段必须有。App 升级后旧字节反序列化失败，应丢弃并走默认 UI，而不是抛给 \`runApp\`。

\`\`\`dart
class RestorableCartCount extends RestorableValue<int> {
  @override
  int createDefaultValue() => 0;

  @override
  void didUpdateValue(int? oldValue) => notifyListeners();

  @override
  int fromPrimitives(Object? data) {
    if (data is! Map) return 0;
    if (data['v'] != 1) return 0;
    return data['n'] as int? ?? 0;
  }

  @override
  Object toPrimitives() => {'v': 1, 'n': value};
}
\`\`\`

没有版本号，下次你把 \`n\` 改成 list，老用户一回来就崩在启动路径——那种崩比丢状态更差。

## 7. 设计取舍

- **交给操作系统保管而不是自己写文件：** 和 Activity 生命周期对齐，杀进程后仍能「无缝」。代价是大小和必须是 primitive，以及用户主动 kill 可能不走 \`onSaveInstanceState\`。
- **opt-in id：** 默认不恢复，避免意外把不该活的 dialog 救活。代价是忘写 id 等于没做。
- **第一帧前灌回：** 用户不看到闪回首页。代价是 \`initState\` 时恢复值还没就绪，初始化顺序变复杂。
- **不恢复登录会话：** 安全。代价是进程被杀后要重新走 token 刷新——那是你的会话层，不是 restoration 的活。

和「把一切放 Provider 全局」比：全局内存状态对进程死无能为力。该全局的（主题、已登录用户缓存）用自己的持久化；该跟这一屏走的用 restoration。混在一个 Store 里，要么 Store 大到不能写进 Bundle，要么杀进程丢整店。

## 8. 排障

1. **杀进程回来是首页：** \`restorationScopeId\` 没设、路由是闭包、深页没有 id、\`onGenerateRoute\` 认不出旧名。
2. **文本回来了滚动没回来：** \`Scrollable\` 没 id，或数据源异步到达，第一帧 offset 应用到空列表被夹成 0。数据到达后要再应用一次，或等数据再 build 列表。
3. **偶发崩溃在启动：** \`fromPrimitives\` 没容忍旧版本 / null。永远防御。
4. **两页状态串：** 兄弟 id 重复，或多 Engine 前缀撞。
5. **Debug 正常，线上丢：** Debug 很少被 LMK。用「Don't keep activities」开发者选项强制杀。这是 Android 上测 restoration 的标准方法。
6. **恢复出无意义 dialog：** 给 dialog 关掉 restoration。
7. **EngineGroup 第二页空白：** 字节没传到这份 Engine。查 Embedder 是否按 view id 存取。

\`flutter run\` 加系统「不保留活动」比写再多单测都接近真实。单测用 \`tester.restartAndRestore()\` 覆盖逻辑，真机覆盖 Embedder 和 Bundle 大小。

## 9. 和会话、草稿怎么分工

一张订单页：

- **Restoration：** 当前填到第几步、输入框文本、键盘是否需要（通常不恢复键盘）、滚动位置。
- **草稿存储：** 用户点「保存草稿」或 debounce 写磁盘的完整模型，带用户 id 和版本。
- **会话：** token 在安全存储，进程回来后刷新。失败则登录页，不要让 restoration 把你送进需要鉴权的深页再 401。

三层混一层，会出现「杀进程后带着过期 token 打开了支付页」。恢复导航栈之前先问会话还有没有。

## 10. Navigator 2、RestorableRouteFuture、以及不能捕获的对象

声明式路由（\`Navigator.pages\` / Router）恢复时，必须能从 primitive 重建整个 \`pages\` 列表。典型写法：bucket 里存 \`List<String> stackIds\`，\`build\` 时 \`pages = stackIds.map(idToPage)\`。\`idToPage\` 是纯函数，参数来自 bucket 里另一组 map，不来自被杀前的内存对象。

\`RestorableRouteFuture\` 用来「恢复一个尚未 pop 的 dialog/route」：进程被杀时 dialog 开着，回来还开着。它要求 \`onPresent\` 用 \`restorablePush\`，参数可编码。\`showDialog(builder: (_) => X(myObj))\` 这种捕获 \`myObj\` 的，恢复时 \`myObj\` 是另一个 isolate 里的虚无。改成 \`restorablePush\` + \`arguments: {'id': x}\`，新进程按 id 从 repository 再取。repository 自己要能在冷启动后读盘，这已经超出 restoration，是你的数据层。

\`\`\`dart
late RestorableRouteFuture<void> _confirm;

@override
void restoreState(RestorationBucket? oldBucket, bool initialRestore) {
  registerForRestoration(_confirm, 'confirm');
}

void _open() {
  _confirm.present();
}
\`\`\`

\`onGenerateRoute\` 必须认识你用过的所有名字，包括已经下线但仍可能躺在用户 Bundle 里的旧名。旧名映射到首页或丢弃，不要 throw。Bundle 可能活过好几个 App 版本——用户两周没打开，系统一直持有旧状态。

\`RootRestorationScope\` 包在 \`WidgetsApp\` 之上或之内，决定根桶。测试里 \`tester.restartAndRestore()\` 依赖这套。缺少 scope，测试会绿（因为没恢复可测），真机红。

\`RestorationBucket.claimChild\` 失败（id 冲突）是断言级错误。动态列表里用 index 当 restorationId，插入一项就冲突或错位。用业务 id。和 Element Key 是同一纪律。

## 11. 测法、Bundle 限额、主动退出

Android 开发者选项 **不要保留活动** 是必测，不是可选。另外：

- 从深页按 Home，用 \`adb shell am kill <pkg>\` 杀进程，再从概览页回来。走的是「最近任务恢复」，和「冷点图标」可能不同。两者都要测。
- 旋转、分屏、语言切换会走 \`onSaveInstanceState\` 但不一定杀进程。restoration 和 \`didChangeDependencies\` 会一起发生。\`MediaQuery\` 变了，滚动 offset 仍应按逻辑像素恢复。
- Bundle 过大：\`TransactionTooLargeException\`。症状是「有时能恢复有时进程直接没了」。把 list 全量塞进 bucket 就会。用 \`adb logcat\` 搜这个异常。

iOS：\`stateRestorationActivity\` / scene restoration。用户从多任务划掉，通常 **不** 恢复——这是平台语义，别在 iOS 上强求和 Android LMK 一样。测 iOS 用「模拟内存警告」不如 Android 的 Don't keep activities 硬。两端产品预期要写进 QA 用例，不要当 bug 互抄。

用户从设置里「强制停止」、或你自己 \`exit(0)\`、或登录页点退出：应 \`RestorationManager.rootBucket\` 清空或换 scope id，避免下一个用户（或同一用户登出后）恢复出上一个人的表单。登出是业务事件，要显式 \`ServicesBinding.instance.restorationManager.flush()\` 之前先清敏感 Restorable。token 本就不该在 bucket 里。

\`RestorableProperty\` 的 \`notifyListeners\` 会标脏桶，真正序列化是批量的。在 \`onChanged\` 里同步改 50 个 Restorable 没问题；在动画里每帧改 Restorable 会让序列化逻辑一直认为有活要干。滚动 offset 由 Scrollable 自己节流。你自定义的进度条不要每帧 \`value = t\` 进 Restorable，松手再写。

和 Engine \`detached\`：混合栈里 Activity 还在、FlutterView detach 再 attach，可能是同一 Engine 也可能不是。同一 Engine 不需要 restoration，State 还在。新 Engine 需要。容器作者必须知道这次 attach 是哪一种，不要两种都灌 bucket 导致「恢复到更旧的一份」。

### 第一帧闪烁：数据层比 bucket 慢

bucket 能恢复 offset 和文本，恢复不了「列表的 100 条」。常见闪烁：第一帧空列表（offset 被夹成 0）→ 异步 repository 返回 → 列表出现但停在顶。修法：

- 同步可恢复的数据快照也放磁盘，启动时同步读（注意不要在 UI 线程读大文件，用启动 isolate 或 native 已经 load 的 cache）。
- 或 bucket 里存 \`hasLoaded\` 和 \`itemCount\`，第一帧先建占位高度让 offset 合法，数据到来再替换。占位高度错了会跳，用估算 extent。
- 不要在恢复路径上 \`push\` 一个 loading 路由盖住深页，那等于自己毁掉「第一帧就是深页」。

\`FutureBuilder\` 的 \`ConnectionState.waiting\` 在恢复后仍会走一遍 waiting，除非 \`future\` 已经是 completed。用「内存已有快照则同步出数据」的 repository，恢复才稳。

### 敏感字段

密码、验证码、证件号：不要进 Restorable。系统备份、共享平板、bugreport 都可能带出 \`savedInstanceState\`。\`TextField\` 的 \`obscureText\` 不会自动让 Restorable 加密。显式用普通 \`TextEditingController\` 并在 \`restoreState\` 里不注册。

用户 id 变了（切换账号）必须换 \`restorationScopeId\` 或清根桶。否则账号 B 打开 App 看到账号 A 的草稿。这是安全 bug，不是体验细节。

### 与路由信息、深度链接同时到达

冷启动可能同时：系统要你恢复旧栈，深度链接要你打开新页。产品要定义优先级。常见：深度链接赢，丢弃 bucket 栈；或恢复后再 push 链接。两者都做会栈错乱。在 \`RouteInformationParser\` 里读一个「是否正在 restoration」的标志，只选一条路。这个标志在 \`initialRestore\` 为 true 的那次 \`restoreState\` 设置，第一帧后清掉。

### RestorationManager.flush 与何时写盘

框架在 \`onSaveInstanceState\` 路径上向 Dart 要数据，会 \`flush\` 把脏 Restorable 收成 primitive。你自己改了 Restorable 却在同一调用栈里立刻杀进程（测试里），可能还没 flush。测试用 \`await tester.restartAndRestore()\` 会走正确时序。真机 Home 键通常够时间；\`am kill\` 在 paused 之后，也通常已经 save。\`exit(0)\` 可能不走 save。崩溃（signal）一定不走。restoration **不是崩溃恢复**。崩溃恢复是你的磁盘草稿 + 崩溃前 debounce。

\`BindingBase\` 的 restoration 编码失败会打日志并可能丢整桶。\`fromPrimitives\` 抛错比丢数据更糟——启动失败。所有 \`fromPrimitives\` 包 try，失败回 default。把这件事写成 lint 级别的纪律。

### 多窗口、桌面、Web

桌面多窗口可能多 Engine 或多 \`Window\`。restoration id 要含窗口 id。Web 的「刷新页面」不是 Android LMK，是你自己的 url + 浏览器会话。用 url 表达栈，比 RestorationMixin 更符合 Web。不要在 Web 上期待 \`savedInstanceState\`。\`kIsWeb\` 时把「刷新后回到哪」交给 router path。

### 最小恢复集：写进页面模板

每个会 push 的页面在模板里回答：

- restorationId 是什么（业务名，不是 index）
- 哪些 Restorable（offset、tab、文本）
- 哪些不恢复（密码、一次性 dialog、播放位置是否恢复由产品定）
- 数据层如何在第一帧前给出非空快照
- 登出如何清桶

没有这五行，页面上线后 Android 低内存机就是抽奖。抽奖结果是 1 星评论「怎么又从首页开始」。把五行当 code review 清单，比事后补 \`RestorationMixin\` 便宜。

### Restorable 与动画控制器

\`AnimationController\` 不要进 bucket。恢复后动画应停在终态或静止，而不是从 0 再播一遍开场动画。用 \`RestorableBool shown\` 表示已经做过入场。否则每次 LMK 回来用户都看一次闪屏动画，既烦又慢。

### 测试矩阵

最少：

1. \`tester.restartAndRestore()\` 表单文本、滚动、tab。
2. Don't keep activities + 真机深页 Home 再回。
3. 升级版本：旧 Bundle 新代码，\`fromPrimitives\` 不崩。
4. 登出再进，不见上用户数据。
5. 深度链接与恢复的优先级。

五条里第 2 和第 4 最容易漏。漏 2 是 Android 差评，漏 4 是事故。

### 和 EngineGroup 一起时的保存键

Bundle key = \`activityId + flutterViewId + dartRestorationId\`。漏任何一段都会撞。把 key 打印在 Debug。第二份 Flutter 页恢复出第一份的滚动位置，就是 key 撞了。修 key，不要修业务代码。

状态恢复的验收必须在真机用 Don't keep activities 跑主路径，而不是只靠 widget 测试绿。测试绿证明 \`fromPrimitives\` 对称；真机证明 Embedder、Bundle、Activity、多 Engine 前缀。两层都要。发布清单加一项：低内存 Android 机从支付页 Home 再回，仍在支付页且表单还在，且 token 仍有效或被正确送到登录。这一项比再写一篇 mixin 教程更能保护收入。

数据分级写进架构说明：会话（安全存储）、草稿（磁盘，用户拥有）、UI 恢复（Bundle，系统拥有）、内存（进程拥有）。四种存储四种丢失模型。混用导致「杀进程丢草稿」或「草稿进了 Bundle 超限崩」。评审新页面时问四句：杀进程要回来吗？卸载要在吗？换账号要清吗？能不能进崩溃日志？答案决定落点。

Engine 生命周期上，\`detached\` 不是再跑一遍 \`restoreState\` 的时机，而是保证 **下一次** 冷启动能读到已经 flush 的桶。在 detached 里做耗时编码会和销毁抢主线程。Restorable 应在用户交互时就保持最新，destroy 时只 flush。不要等销毁再从各种 Controller 抠值——那时候树可能已经半拆，\`ScrollController\` 已经 dispose。这是时序不变量：写入分散在生命周期中，序列化集中在系统回调。分散写、集中刷。反过来会丢最后几秒的输入。

恢复数据的隐私审查：Bundle 可能进备份。Android Auto Backup 默认包含 savedInstanceState 相关数据视实现而定，审查时当「可能离开设备」处理。敏感字段已经禁止；半敏感（搜索历史）要产品点头。企业账号可能禁止备份，恢复仍应在 LMK 场景工作——那是 savedInstanceState，不是云备份。两种通路分清。

文档给 QA 的步骤必须具体：打开开发者选项 → 不保留活动 → 进到某页填某字段 → Home → 从最近任务回 → 期望。不要写「测试一下恢复」。步骤进测试用例库，版本升级时回归「旧 Bundle」。

代码生成：页面模板脚手架带 \`RestorationMixin\`、空 \`restoreState\`、\`restorationId\` 参数。比事后教育有效。脚手架里 \`fromPrimitives\` 已有 try/default。工程师只能填字段，不能忘纪律。

与导航 2.0 的 parser 测试：给一份旧 \`RouteInformation\` + 一份 bucket 字节，看 \`pages\` 列表。这是纯单元测试，不启引擎。把曾经生产过的栈形状做成黄金。导航重构时先跑这些黄金，再谈新路由图。恢复是路由系统的一部分，不是 State 的小插件。把它放进路由模块的职责，页面只注册自己的字段。职责清晰，桶的树才会和路由树同构，id 才不会在重构后漂掉。

恢复失败时的产品文案：不要崩溃，要「未能恢复上次进度，已回到首页」。打点 \`restoration_failed\` 带原因（版本、解码、id 冲突）。用户能继续用，你能知道规模。静默丢状态且无打点，会变成无法理解的「有人说闪回首页」。

与账号体系的时序：恢复栈之前先恢复会话。会话异步时，第一帧不要急着 \`Navigator\` 恢复到支付页。可以先亮闪屏，会话成功再灌栈，失败去登录且清桶。闪屏多 200ms 比闪一下支付页再踢出去更可接受。这是体验上的时序不变量，和 \`restoreState\` 在 initState 之后那条技术时序同样硬。

最后，restoration 不是备份。不要用它同步多设备。多设备是你的云。系统桶只服务「这台设备这次被杀」。职责写进架构图，避免有人往桶里塞「用户的全部草稿」指望换机还能看见。换机看不见是正常。看得见反而是隐私事故。

恢复系统的最后一条纪律是：**默认不恢复比错误恢复好。** 不确定的 dialog、过期的活动页、已下线的路由名，丢。丢了用户从上一层进，仍可用。错误恢复把用户送进崩溃或空页，不可用。\`fromPrimitives\` 失败即丢该字段；路由名不认识即丢该层栈。贪婪恢复是事故。克制恢复是设计。把克制写进 mixin 模板的注释，提醒未来的自己不要把整个 bloc 塞进去。能塞不代表该塞。该塞的只有用户会认为「我没离开」的那一小撮像素状态。其余让数据层去做。Engine 生命周期只保证这一小撮能跨过 LMK 这道缝。缝很小，补丁也该小。小才能快，快才能赶在 \`onSaveInstanceState\` 超时之前写完。小、快、克制，三条是同一件事的三个方面。

把「小、快、克制」落实到字段级：每个 Restorable 字段在 PR 里用一句话回答「用户会认为没离开吗？」。答否就删。答是才留下并写版本号。这句话当 review 问题。问题比规范短，短才能每次都问。每次都问，桶才能保持小。桶小，\`onSaveInstanceState\` 才快，快才赶得上 LMK 之前那次写入。写入成功，用户才会觉得 Flutter 混合栈和原生一样「还在」。觉得「还在」，是状态恢复这篇文章唯一的产品结果。其余都是为这一句服务的机制。

进程被杀是 Android 的正常天气，不是异常风暴。把天气当风暴，就不会做 restoration，用户就会在晴天以外骂「怎么又从头来」。把天气当天气，就会在模板里留下 restorationId 和克制的字段。字段克制，写入才快，快才赶得上那次 save。赶得上，混合栈才在 LMK 之后仍像一个 App，而不是像两次冷启动夹着一次失望。失望很贵。机制很便宜。便宜的机制值得写成十二条标题的长文，就是因为贵的失望每天都在低内存设备上发生。发生一次，原理就值回这篇文章的阅读时间。

状态恢复跨过的缝是进程死亡，不是页面 dispose。dispose 用内存对象就够。死亡必须用 primitive 树。树要小，因为写盘窗口短；树要有版本，因为 App 会升级；树要按账号隔离，因为隐私；树要在第一帧前灌好，因为不能闪。四条把 restoration 从「加 mixin」变成「设计字段」。字段设计对了，代码是机械的。机械的东西适合模板。模板里有 try/default、有 restorationId、有「用户会认为没离开吗」这句 review 问题。问题挡住贪婪。贪婪撑爆 Bundle，Bundle 失败比不恢复更糟。不恢复是从首页来。失败是启动崩。启动崩是最高级事故。所以克制是安全，不只是品味。安全、克制、小、快，在 \`onSaveInstanceState\` 这条时间线上是同一个约束。约束写进模板，天气就不再是风暴。Android 还是会杀进程。用户还是会以为没走。以为没走，就是这套机制唯一需要的幻觉。幻觉用字节换。字节要少。少，才能真的换到。

幻觉用少数字节换到之后，还要防幻觉错乱：错账号、错页、错版本。三错比没幻觉更伤。防错靠 scope id、业务 id、版本号、失败即丢。丢是安全默认。默认在模板里。模板在脚手架里。脚手架在每次新建页面时出现。出现，纪律才不靠记性。记性会在赶工时消失。消失时系统杀进程不会消失。杀进程仍是天气。天气里能用的，只有已经写进代码的那一小撮字段。字段不在，首页来。首页来，用户骂。骂完，再加 mixin 来得及补下一次，补不了这一次。这一次已经写进 1 星。所以模板要在第一次写页面时就在。第一次，就是这篇要求的工程位置。位置对了，天气随便来。

第一次写页面就带模板，是把天气响应做成肌肉记忆。记忆不靠人，靠脚手架。脚手架不在，人会忘。忘了，1 星来。来了再补，补的是下一次。下一次还要靠脚手架。所以脚手架不是可选生成器，是这条机制的安装程序。安装在仓库初始化里。初始化过了，每个新页默认克制。默认克制，Bundle 默认小。小，默认赶得上 save。赶得上，默认用户以为没走。默认，是工程对天气的态度。态度写进工具，才写进结果。

## 12. 小结

状态恢复是把 Dart UI 状态映射成系统可保管的 primitive 树，在新 Engine 的第一帧之前按 key 对号入座。它活过进程被杀，活不过你没注册的字段，也活不过用户卸载。\`restoreState\` 的时序、bucket 的 id、Bundle 的大小、多 Engine 的前缀，是四条不变量。登录态和大体量数据不要进这棵树。能在「Don't keep activities」下回到用户离开时的那一屏，混合栈在 Android LMK 上才算闭环。`,
};
