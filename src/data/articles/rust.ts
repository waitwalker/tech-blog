export const rustArticles: Record<string, string> = {
  "rust-ownership-borrow-checker-in-production": `把所有权理解成「Rust 多出来的语法税」会在生产里立刻失效。借用检查器卡住你，不是风格问题，是你正在引入一条非法别名：同一块内存上同时存在可变写和其它观察者。C++ 把这条规则写在注释和 code review 里；Go 写在 race detector 的抽样里；Rust 写进类型。每个值同一时刻一个所有者、可变别名与其它别名互斥、引用不能比所有者活得长——这三条在编译期排除 use-after-free 和数据竞争。它们不是偏好。

这篇文章只讲生产代码里的所有权：move 如何改变类型状态、借用如何限制别名、生命周期如何命名范围、内部可变性如何把检查推迟到运行时、跨 \`await\` 为什么把栈引用变成未定义。读完你应该能独立回答三个问题：这段 API 该不该拿走所有权、跨任务共享该用 \`Arc\` 还是该用 channel、为什么这段看起来无害的 \`clone()\` 会把热路径打穿。

## 1. 所有权管的是别名，不是「有没有 malloc」

栈上的 \`i32\` 和堆上的 \`Vec<u8>\` 都有所有者。区别只在 \`Drop\` 时要不要释放堆。把所有权理解成「RAII 的另一种写法」，会漏掉更硬的那一半：**同一时刻谁可以观察这块内存**。

别名（alias）是：两个路径能碰到重叠的字节。读-读通常无害；读-写或写-写，在没有同步的前提下，对优化器和 CPU 都是未定义或至少不可推理。Rust 的类型系统把「可变 XOR 共享」做成默认。能编过的安全代码，优化器可以假定 \`&mut T\` 期间没有其它指针伸进来——这和 C 的 \`restrict\` 是同一类承诺，只不过 Rust 强制你兑现。

所以生产里画所有权图，不是画「谁 free」，是画「谁能读、谁能写、写的时候还有没有别人在看」。\`Box\`、\`Vec\`、\`String\`、文件句柄、socket，都只是这张图上的节点。堆只是 \`Drop\` 的账单。

一个直观对照：\`let s = String::from("ok"); let t = s;\` 之后 \`s\` 不能再用，不是因为字节从栈搬到了另一处栈槽那么简单——LLVM 对该 move 经常直接改名。失效的是**名字**。类型状态从「这个绑定拥有 \`String\`」变成「这个绑定已失效」。你再写 \`s.len()\`，碰到的是一个不存在的所有者，不是一块还在但「被借走」的内存。

## 2. 三条不变量，对应三类事故

把规则写成事故语言，比背教科书有用：

1. **单一所有者**。对应 double-free、忘记 free、在已经 move 走的值上再跑析构。\`Vec\` 的缓冲区指针只该出现在一个 \`Vec\` 头里；第二个头如果也认为自己该 \`dealloc\`，进程就在分配器里炸掉。
2. **可变与共享互斥**。对应数据竞争、迭代时修改容器、把 \`&T\` 当成可以偷偷改。迭代器拿着指向元素的指针时，\`push\` 可能重分配，指针变悬空——所以 \`for x in &v { v.push(1); }\` 直接拒绝。
3. **借用不长于所有者**。对应 use-after-free、返回指向局部的指针、把引用存进结构体却把结构体活得比数据源更长。

\`\`\`rust
fn take(buf: Vec<u8>) { /* 所有权移入，调用方名字失效 */ }

fn peek(buf: &[u8]) -> usize {
    buf.len()
}

fn append(buf: &mut Vec<u8>, b: u8) {
    buf.push(b);
}

fn demo() {
    let mut buf = vec![1, 2, 3];
    let n = peek(&buf);
    append(&mut buf, 4);
    take(buf);
    // peek(&buf); // 所有者已走，再借是无意义的名字
    let _ = n;
}
\`\`\`

这三段函数签名就是三种契约。\`take\` 说「我之后负责 drop」；\`peek\` 说「我只看，立刻还」；\`append\` 说「这段时间只有我能写」。生产 API 的第一问不是「要不要用泛型」，是「这三种里哪一种」。选错的症状很具体：要么调用方被逼 \`clone\`，要么你在结构体里存了 \`&[u8]\` 却发现请求结束缓冲已经还回连接池。

## 3. Move：类型状态被转走，不是口号里的 memcpy

\`Copy\` 类型（整数、共享引用、不含析构的小结构）赋值是按位复制，两边都能用。非 \`Copy\` 赋值是 move：源绑定进入「已移动」状态，析构只会发生在目的地。\`Vec\`、\`String\`、\`File\`、几乎所有带资源的类型都是这条路。

部分移动更容易在生产里踩：

\`\`\`rust
struct Conn {
    addr: String,
    fd: std::fs::File,
}

fn steal_addr(c: Conn) -> String {
    c.addr
    // c.fd 在函数结束时 drop；c 作为整体不能再被使用
}
\`\`\`

从 \`Conn\` 里拿出 \`addr\` 之后，剩余字段仍要按 \`Drop\` 跑完。你不能既把 \`addr\` 还回去，又假装 \`Conn\` 完整。这就是为什么「拆包再拼回去」经常要 \`mem::take\` / \`Option::take\`：用 \`None\` 占住那个槽，让结构体在类型上仍然完整，值上已经把资源让出去。

\`Drop\` 的顺序是：先跑你写的 \`Drop::drop\`，再按字段声明的**逆序**析构。结构体里先声明 \`buf: Vec<u8>\` 再声明 \`mmap: Mmap\`，析构时 mmap 先走、buf 后走。依赖「另一个字段还活着」的 drop 逻辑，必须把这个依赖写成类型（包进同一个字段、或用 \`ManuallyDrop\` 自己调），不能靠声明顺序的运气。panic 展开同样会跑 drop。\`catch_unwind\` 能拦住 panic，拦不住「半初始化结构体」——这就是为什么 \`Vec::push\` 的实现要先写完槽再改 len：中途 panic 时 len 仍覆盖已初始化的前缀，析构才安全。生产里自己写缓冲或对象池，先把这条 panic safety 画出来，再写 unsafe。

\`mem::take(&mut x)\` 留下 \`Default\`；\`mem::replace\` 留下你指定的值；\`Option::take\` 留下 \`None\`。网关里把请求体从 \`Option<Bytes>\` 拿走、把连接从 \`Option<TcpStream>\` 拿走，都是同一手法。不要 \`clone\` 只为了让编译器闭嘴——那是在用分配换一个你还没想清楚的所有权边界。

Move 跨线程是 \`Send\` 的含义：这个值可以换一只手拿。不是「可以同时被两只手拿」。后者是 \`Sync\`，下一节借用和再下一节 \`Arc\` 会碰到。

## 4. 借用：共享与独占是同一条别名规则的两端

\`&T\` 可以有很多个，只要期间没有 \`&mut T\`。\`&mut T\` 只能有一个，且期间不能有 \`&T\`。NLL（non-lexical lifetimes）让借用在**最后一次使用**处结束，而不是在作用域的花括号处结束，所以下面能编过：

\`\`\`rust
fn nll_ok(v: &mut Vec<u8>) {
    let first = v.get(0).copied();
    v.push(9); // first 已经不再借用 v
    let _ = first;
}
\`\`\`

编译器做的是：看每次借用覆盖哪些路径、覆盖到哪一次使用。重叠且冲突就报错。它不是在模拟你的运行时，更不会「大概觉得没问题就放行」。

结构体字段可以分裂借用：\`&mut s.a\` 和 \`&mut s.b\` 同时存在是合法的，因为路径不重叠。这直接决定了你怎么拆状态。一个巨大的 \`State { conn, buf, stats }\`，三个字段总是一起 \`&mut\`，调用方会互相卡住。拆成 \`conn\` 自己的结构、\`stats\` 用原子或独立锁，借用冲突会少一个数量级。**借用检查器在惩罚过大的可变表面。** 这是设计反馈，不是噪音。

再借用（reborrow）是 \`&mut\` 能传进函数的原因：调用 \`f(&mut *x)\` 时，外层 \`&mut\` 被临时冻结，内层借出去，回来再解冻。你写 \`f(&mut x)\` 时几乎总在发生再借用。理解它，才能读懂「为什么我把 \`&mut self\` 传进去，回来还能继续用 \`self\`」。

切片和迭代器是借用规则的日常形态。\`&v[i]\` 借的是元素；\`v.iter_mut()\` 借的是每一个元素的独占，但通过迭代器协议保证不同 \`next()\` 不重叠。你自己用裸索引写两个 \`&mut v[i]\` 和 \`&mut v[j]\`，编译器不信 \`i != j\`——它没有值域分析来给这条别名开例外。要同时可变地碰两个元素，用 \`split_at_mut\`：它在库里用 unsafe 证明两半不重叠，再把安全的两个 \`&mut [T]\` 交给你。

## 5. 生命周期：给引用的有效范围起名

\`'a\` 不是对象，不是 GC 根，不是运行时时钟。它是编译器用来比较「这段借用最多能活到哪」的名字。\`fn longest<'a>(x: &'a str, y: &'a str) -> &'a str\` 说的是：返回值的有效范围不长于 \`x\` 和 \`y\` 中较短的那个。调用方拿到的 \`&str\` 不能在 \`x\` 或 \`y\` 失效之后还用。

省略规则（elision）只覆盖常见形状：输入引用的生命周期能唯一地推到输出上。结构体里存引用，省略帮不上忙，必须写出来：

\`\`\`rust
struct View<'a> {
    head: &'a [u8],
    payload: &'a [u8],
}

fn split_header(frame: &[u8]) -> Option<View<'_>> {
    if frame.len() < 4 {
        return None;
    }
    Some(View {
        head: &frame[..4],
        payload: &frame[4..],
    })
}
\`\`\`

\`View<'a>\` 把「这两片都指向 \`frame\` 的缓冲」写成类型。\`frame\` 一还回连接池，\`View\` 就不能再存在。这就是为什么协议解析的热路径要么当场用完 \`View\`，要么把需要留下的字节变成 \`Bytes\`（引用计数的拥有切片，见零拷贝那篇）。

生命周期参数出现在错误信息里时，先不要改标注来「骗过」。问：这个引用指向的数据，活在哪个所有者上？那个所有者会不会在引用还在时被 drop、被 move、被重新填充？答不上来，改标注只是把报错挪到另一个调用点。

高阶生命周期（\`for<'a>\`）会在回调和 \`Fn\` trait 上冒出来：\`fn(&str) -> &str\` 其实是「对任意短生命周期都能成立」，不是「存在某一个 \`'a\`」。闭包若把输入引用存到自己的环境里，就不再满足 \`for<'a>\`。生产里这常表现为「我把闭包传给 \`tokio\` 的 \`spawn\` 就不行」——环境里藏了指向栈上缓冲的指针。

生命周期还有方差：\`&'a T\` 对 \`'a\` 协变——短的可以当长的用吗？反过来。\`&'a T\` 可以从「活得更长」的引用缩短成「活得更短」的引用，所以 \`&'static str\` 能传给要 \`&'a str\` 的函数。\`&'a mut T\` 对 \`'a\` 协变、对 \`T\` 不变。不变的直观原因：若 \`&mut Vec<&'static str>\` 能当成 \`&mut Vec<&'a str>\`，你就能塞一个短生命周期的 \`&'a str\` 进去，原持有者再按 \`'static\` 读，悬空。报错看起来像生命周期，根因是你在可变别名上做了不安全的缩短。不必背完方差表，但看到 \`mut\` 和生命周期缠在一起时，先问「我是不是把短的写进了长的容器」。

## 6. 内部可变性：把别名检查从编译期挪到运行时

有些共享是算法需要的：缓存、一次写入的配置、引用计数内部的计数器。类型系统给了一条受控的后门：外层是 \`&T\`，内层在运行时检查或用原子保证互斥。

- \`Cell<T>\`：只适用于 \`Copy\` 或通过 \`replace\` 整颗换掉。没有别名出去的 \`&T\` 指向内部，所以可以在 \`&Cell<T>\` 上改。单线程、小状态。
- \`RefCell<T>\`：运行时借计数。\`borrow_mut\` 时若已有借出会 panic。单线程图结构、测试替身常用。生产热路径上 panic 不是错误处理，是你的别名假设写错了。
- \`Mutex<T>\` / \`RwLock<T>\`：跨线程的互斥。锁本身是 \`Sync\`，\`MutexGuard\` 不是 \`Send\`（\`std\` 的守卫跨 \`await\` 会把运行时卡住，见调度和争用两篇）。
- \`UnsafeCell<T>\`：上面那些的底层。自己写等于自己证明别名。

\`\`\`rust
use std::cell::RefCell;

struct Cache {
    hits: RefCell<u64>,
}

impl Cache {
    fn bump(&self) {
        *self.hits.borrow_mut() += 1;
    }
}
\`\`\`

\`bump\` 拿 \`&self\` 却改了计数。类型上这是共享；事实上同一时刻只有一个 \`borrow_mut\`。单线程里这是便宜的。多线程里 \`RefCell\` 不是 \`Sync\`，你会被逼换成原子或锁——这正是类型系统把「内部可变性的半径」画出来。

\`OnceCell\` / \`OnceLock\` / \`std::sync::OnceLock\` 解决「先写一次，以后只读」。配置、正则、全局客户端走这条，不要用 \`Mutex\` 包一个写完再也不改的值。

循环引用是 \`Rc\`/\`Arc\` 的经典坑：两个节点互相持有强引用，计数永远到不了零。\`Weak\` 是「观察但不负责存活」。图、观察者列表、缓存回指，该用 \`Weak\` 的地方用强引用，就是泄漏。泄漏不是内存不安全，但在生产里一样能把 RSS 拉成一条斜线。

原子也是内部可变性：\`AtomicU64\` 的 \`load/store/fetch_add\` 都收 \`&self\`。它不提供 \`&mut\` 指向那个整数，所以别名规则在类型上仍成立；互斥由 CPU 的原子指令保证。适合计数、开关、epoch、状态机的小枚举。不适合「改完这个字段还要改那个字段，两者要一起被看到」——那是锁或单任务所有权的活。\`Relaxed\` 只保证这个位置的原子性，不保证和其它内存的顺序；跨线程发布一个指针必须配 \`Release\`/\`Acquire\` 或更强。生产里把所有原子都写成 \`SeqCst\` 能先换正确性，测出热再收紧。不要在没测的情况下用 \`Relaxed\` 发布配置指针。

## 7. Send / Sync：跨线程的别名许可

\`Send\`：值可以 move 到别的线程。\`Sync\`：\`&T\` 可以送到别的线程，等价于 \`T\` 可以同时被多线程只读（或内部自己同步）。

推论：

- \`Arc<T>: Send\` 当且仅当 \`T: Send + Sync\`（简化记忆：内层既要能在别的线程 drop，也要能同时读）。
- \`Rc<T>\` 不是 \`Send\`，也不是 \`Sync\`。单线程共享所有权用它，跨任务不要碰。
- \`RefCell<T>\` 不是 \`Sync\`。\`Mutex<T>\` 是。
- \`&mut T\` 是 \`Send\` 如果 \`T\` 是 \`Send\`——独占引用换线程仍然独占。
- 裸指针既不是 \`Send\` 也不是 \`Sync\`，除非你自己 \`unsafe impl\`。

\`tokio::spawn\` 要求 \`Future + Send + 'static\`。报错 \`*mut u8 cannot be sent\` 或 \`RefCell cannot be shared\`，不是 spawn 的毛病，是你把单线程别名模型带进了多线程调度器。修法是：改成 \`Arc<Mutex<_>>\`、改成每个任务自己的状态、或者用 \`spawn_local\` 并证明这个 runtime 永不把任务挪走。

\`'static\` 在 spawn 里的意思常常被读成「这个值要活到进程结束」。它真正说的是：future 不从调用栈上借东西。任务可能在调用 \`spawn\` 的栈帧已经没了之后才跑完，引用会悬空。拥有数据（\`String\`、\`Bytes\`、\`Arc\`）就满足 \`'static\`，哪怕这个 \`Arc\` 下一秒就被 drop——\`'static\` 约束的是借用，不是「对象永生」。

\`Send\` 漏掉的典型现场是 \`async\` 块里捕获了 \`&mut\` 某个 \`!Send\` 的东西，或者用了 \`std::rc::Rc\` 当缓存。错误信息会指向 \`spawn\` 那一行，真正的捕获在几十行之外。把 async 块改成显式 \`async move\`，把捕获的变量在块前列出来，\`not Send\` 会立刻指出是哪一个。\`tokio::spawn\` 的约束写在签名上：\`F: Future + Send + 'static\`。你无法用注释说服它。想跑 \`!Send\` 就 \`LocalSet\` + \`spawn_local\`，并接受这些任务钉在一条线程上。

另一个生产细节：\`MutexGuard\`、\`RwLockReadGuard\` 通常是 \`!Send\`。持着 \`std\` 锁跨 \`await\`，多线程 runtime 会拒绝（守卫可能在另一条线程上解锁，而 \`std::sync::Mutex\` 要求谁锁谁解）。这看起来像生命周期或 Send 的玄学，其实是在保护操作系统 mutex 的契约。修法不是 \`unsafe impl Send\`，是把锁的范围缩回同步代码。

## 8. 跨 await：Future 被放到堆上之后

\`async fn\` 被编译成状态机。每个 \`.await\` 是一个可能暂停的点。暂停时，仍然活着的局部变量会成为状态机的字段。这个状态机会被 \`spawn\` 放到堆上，可能在另一条 worker 上被唤醒。

所以：\`async fn\` 里对栈上 \`Vec\` 的 \`&mut\` 跨过 \`await\`，等于把指向「可能已被调度走、甚至已被 drop 的栈槽」的指针存进堆上的 future。借用检查器拒绝，是因为它无法证明唤醒时那块栈还在。

\`\`\`rust
async fn wrong(buf: &mut Vec<u8>) {
    buf.extend_from_slice(&[1, 2, 3]);
    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    buf.push(4); // buf 的借用跨过 await
}

async fn right(mut buf: Vec<u8>) -> Vec<u8> {
    buf.extend_from_slice(&[1, 2, 3]);
    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
    buf.push(4);
    buf
}
\`\`\`

\`wrong\` 的签名把调用方的缓冲借进一段不确定何时结束的未来。连接池、请求作用域、取消，都会让这个未来比缓冲活得更长。\`right\` 把所有权带进任务，结束时还回去——契约在类型上闭合。

生产里更常见的形状是：同步代码里把 \`&[u8]\` 解析完，把需要留下的部分 \`Bytes::copy_from_slice\` 或 \`frame.slice(..)\` 成拥有视图，再 \`await\` 下游。借用缩进同步块，跨 \`await\` 只移动拥有的值或 \`Arc\`。

锁守卫跨 \`await\` 是同一问题的加锁版。\`std::sync::MutexGuard\` 不是 \`Send\`，跨 \`await\` 往往直接编不过；即便用 \`parking_lot\` 或 \`tokio::sync::Mutex\` 编过了，你也在持锁时把任务挂起，别的任务来抢这把锁只能排队，worker 还可能被这个挂起的任务占着调度语义。正确形状：锁里只做内存操作，I/O 留在锁外。

\`Pin\` 出现在自引用 future 上：状态机字段里有指向自己另一个字段的引用，move 这个 future 会让内部引用失效。\`Pin<&mut Fut>\` 承诺不再把 \`Fut\` 从内存里搬走。你几乎不必自己 \`unsafe impl Unpin\`；把跨 \`await\` 的引用改成拥有数据，自引用往往自己消失。

## 9. 生产 API：谁该拥有，谁该只看一眼

签名是契约。几个反复出现的选择：

**输入缓冲。** 解析、校验、计算哈希：收 \`&[u8]\`。要存储、要跨任务、要回复下游：收 \`Bytes\` 或 \`Vec<u8>\`。不要收 \`&Vec<u8>\`——那比 \`&[u8]\` 更窄，还没带来所有权。不要无故收 \`String\` 再立刻 \`as_bytes()\`。

**配置和上下文。** 请求级上下文用引用或 \`Arc<Ctx>\`。\`Arc\` 的含义是「我不知道谁最后一个用完」。如果生命周期能绑在 \`&Request\` 上，就不要 \`Arc\`。每个 \`Arc\` 都是一次原子计数和一次间接。

**返回值。** 能返回 \`impl Iterator<Item = &T> + '_\` 就不要返回 \`Vec<T>\`。调用方只遍历一次时，你的 \`collect\` 是多余分配。需要拥有的快照（要跨锁释放后还读）才 \`clone\` 出来。

**错误。** 见错误处理那篇。这里只强调所有权侧面：\`thiserror\` 的枚举若包含 \`String\` 或 \`Box<dyn Error>\`，等于错误路径也在分配。热路径上的可恢复错误，优先静态变体和 \`&'static str\`。

**资源。** \`File\`、\`TcpStream\`、数据库连接必须有清晰的单一所有者。连接池把所有权租出去，归还时再收回。不要 \`clone\` 一个连接对象——\`TcpStream\` 的 \`try_clone\` 是复制 fd，语义是两个所有者关两次，和 \`Arc<Mutex<Conn>>\` 完全不同。

一个网关 handler 的常见形状：

\`\`\`rust
struct Request {
    method: Method,
    path: Bytes,
    body: Bytes,
}

async fn handle(req: Request, peers: Arc<PeerMap>) -> Response {
    let route = parse_path(req.path.as_ref()); // 借用，同步，立刻结束
    match route {
        Route::Get(id) => lookup(&peers, id).await,
        Route::Put(id) => write_body(id, req.body).await, // body 所有权进入写任务
    }
}
\`\`\`

\`path\` 只需要看一眼，但因为 \`Request\` 本身要跨 \`await\`，它已经是 \`Bytes\` 而不是 \`&str\`。\`body\` 可能很大，move 进写路径，避免再拷一份。\`peers\` 是进程级共享，\`Arc\` 名正言顺。

类型状态（typestate）把「这扇门能不能写」编进类型，而不是编进运行时的 \`if self.closed\`。典型形状：\`File<Closed>\` 没有 \`write\` 方法；\`open\` 把所有权吃掉，吐出 \`File<Open>\`。非法状态不可表示，比文档里写「先 open 再 write」硬。代价是泛型和类型爆炸，以及跨 FFI/序列化时状态被擦掉。适合连接握手、协议阶段、一次性地消耗的 token。不适合每两个字段就拆一个类型参数——那是把借用检查器没问你的问题提前问了。

## 10. 取舍：clone、Arc、channel 各买什么

三条路都能让借用检查器闭嘴，买到的东西不一样。

**\`clone()\`。** 买独立副本。对 \`Arc\`/\`Bytes\` 是 bump 计数（浅）；对 \`Vec\`/\`String\`/\`HashMap\` 是分配加 memcpy（深）。热路径上深 clone 的火焰图长得很认：分配器、\`memcpy\`、然后 GC 式的 drop 浪潮。可以 clone 的信号：副本很小、频率低、你确实需要独立生命周期。不要为了「过编译」clone 整个请求体。

**\`Arc<T>\`。** 买共享所有权。适合只读的大对象、配置、连接池、下游客户端。可变状态要再加 \`Mutex\`/\`RwLock\`/原子，否则 \`T\` 不是 \`Sync\`。代价是：间接、缓存不友好、循环引用要 \`Weak\`、调试时「谁还握着最后一票」不直观。\`Arc<Mutex<HashMap<..>>>\` 是共享可变的默认形状，也是争用的默认形状——下一层优化往往是拆分所有权，而不是换一把更快的锁。

**channel。** 买「所有权随消息走」。任务 A 不再碰这块数据，任务 B 独占。这是并发里最接近单所有权的模型。有界 channel 还顺手买到背压。代价是延迟和拷贝（或 move）边界；消息里不要塞大锁和大缓冲，塞 id 或 \`Bytes\`。

还有一条常被忽略：**把可变表面变小**。一个 \`Session\` 里同时塞 socket、解析器状态、用户信息、限流计数，任何方法都是 \`&mut self\`，异步和借用会一起爆炸。拆成 \`IoHalf\`、\`ParseState\`、\`Arc<User>\`，每个任务只拿自己那一份，借用检查器会安静很多。安静不是因为它被绕过，是因为别名本来就不该那么宽。

\`split\` 出读写半边（\`TcpStream::split\` / \`into_split\`）就是这个原则的 IO 版：读任务独占读半边，写任务独占写半边，不再为了「同一条连接」去抢一把 \`Mutex<TcpStream>\`。内核的 tcp socket 本来就能同时 read/write；把这个事实反映到所有权上，比在用户态加锁更接近硬件。代价是两个半边的生命周期要一起管理，一边 drop 要让另一边知道连接没了。

\`Cow<'a, str>\` 和 \`Cow<'a, [u8]\`>\` 买的是「大多只读，偶尔要拥有」。配置覆盖、路径规范化、小写化这种「可能改一个副本」的路径适合它。它不是万能缓冲。协议热路径用 \`Bytes\` 更直接。

## 11. 排障：编译器在说哪条不变量破了

遇到借用错误，按层问，不要先加 \`clone\`：

1. **是 move 还是 borrow？** \`use of moved value\` 是所有权被转走；\`cannot borrow as mutable\` 是别名冲突。两种修法完全不同。前者考虑 \`Option::take\`、改签名拿走或只借；后者考虑缩小借用范围、拆字段、改成内部可变性。
2. **冲突的两条路径是什么？** 读错误里的 \`first borrow\` / \`second borrow\`。画出两个路径是否真的重叠。不重叠却报错，通常是因为你借的是整个 \`self\` 而不是 \`self.a\`。把方法改成关联函数 \`fn bump(stats: &mut Stats)\` 往往立刻好。
3. **是否跨了 \`await\`？** 把 \`await\` 前后切开：前面同步解析，后面只拿拥有的值。\`spawn\` 报 \`not Send\` 或 \`lifetime\`，先看闭包环境里有没有 \`&\`、\`RefCell\`、裸指针。
4. **是否把锁守卫、迭代器、切片和 \`self\` 同时活过一次可变调用？** 三个典型写法：\`let n = self.map.len(); self.map.insert(..)\`（len 的借用该结束却被你写成了长借）；\`for k in self.map.keys() { self.map.remove(k); }\`；\`let g = lock.lock(); foo().await; drop(g)\`。
5. **生命周期标注是不是在撒谎？** 结构体上的 \`'a\` 必须能指回一个真正的所有者。若所有者在堆上、在连接池里、在另一个任务里，\`'a\` 写不对。改成拥有 \`Bytes\`/\`Arc\`，标注会自己消失。

编译器附带的 \`help: consider cloning\` 是机械建议，不是架构建议。每次接受它之前问：我需要的是独立副本，还是我还没找到那个该结束的借用？

一段会反复出现的报错：\`cannot borrow \`*self\` as mutable because it is also borrowed as immutable\`，出现在 \`self.inner.do_x(); self.metrics.bump();\` 这种看起来无害的连续调用上。原因是 \`do_x\` 的 \`&mut self\` 把整个 \`self\` 借走，不是只借 \`inner\`。把 \`bump\` 改成关联函数，或先把需要的字段拆出来：

\`\`\`rust
fn record(inner: &mut Inner, metrics: &Metrics) {
    inner.do_x();
    metrics.bump();
}
\`\`\`

调用处 \`record(&mut self.inner, &self.metrics)\`。字段分裂借用是合法的，方法接收者 \`&mut self\` 不是。这不是风格，是别名粒度。结构体越大，\`&mut self\` 的杀伤力越大。拆方法接收者，往往比拆 crate 更能让生产代码编过。

再看一类和生产事故直接相关的错误：\`cannot return value referencing local variable\`。你在函数里读完 socket 到局部 \`Vec\`，再返回指向它的 \`&[u8]\`。编译器拒绝，是第三条不变量：借用不能活过所有者。修法不是 \`transmute\` 拉长寿命，是把 \`Vec\` 或 \`Bytes\` 一起返回。另一个变种是把引用存进 \`lazy_static\` / \`OnceLock\`：全局的寿命是 \`'static\`，局部缓冲不是。缓存要拥有键和值。自引用结构（结构体里既有 \`buf: Vec<u8>\` 又有 \`view: &'self [u8]\`）在安全 Rust 里几乎写不成，这是 \`Pin\` 和 ouroboros 一类库存在的原因。生产里宁可 \`view\` 改成偏移量 \`start/end: usize\`，用方法临时切 \`&self.buf[start..end]\`。偏移量是拥有的整数，不引入别名；切片在方法返回时结束。这比自引用少一个数量级的 unsafe。

\`Cow<'a, str>\` 在 API 边界上的正当用法是：调用方多数时候能借，少数时候你必须改（小写化、去空格）才分配。内部存储仍应决定是长期借还是长期拥有——\`Cow\` 只是这一次调用的形状。把它塞进结构体当字段，等于结构体有时借有时拥有，生命周期参数会污染所有方法。字段用 \`String\`/\`Bytes\`，参数用 \`impl AsRef<str>\` 或 \`Cow\`，是更稳的分层。

工具：\`cargo expand\` 看 async 状态机长什么样；\`RUSTFLAGS=-Zprint-type-sizes\`（nightly）看 future 有多大——跨 \`await\` 的大 \`Vec\` 会把任务结构撑到几 KB，缓存和分配都受伤。\`Arc::strong_count\` 在调试泄漏时有用，但不要在热路径上当逻辑。

## 12. 小结

所有权是别名的类型系统。所有者决定谁 drop；借用决定谁能同时看；生命周期给「能看到何时」起名；\`Send\`/\`Sync\` 把同一套规则延伸到线程；内部可变性是受控的例外；跨 \`await\` 只是「这份状态机会被挪到堆上」的推论。

生产里值钱的不是把生命周期标注写得更花，是把可变表面收小、把跨任务的数据改成拥有或引用计数切片、把 \`clone\` 留给我确实需要副本的地方。借用检查器逼你把这些话说清楚。说清楚之后，use-after-free 和数据竞争就不再是「线上再看一眼」的问题。下一篇把「任务被挪到另一条线程」展开：Tokio 的调度、取消，以及为什么阻塞 worker 等于偷走别人的 IO。`,

  "rust-tokio-runtime-and-task-scheduling": `把 Tokio 理解成「async/await 语法糖」会在生产里立刻失效。\`async fn\` 不是线程，是一台可被暂停的状态机；runtime 也不是线程池那么简单，是 **work-stealing 调度器 + IO 驱动 + 计时器 + 阻塞池** 的合体。你在 worker 上跑 \`std::fs::read\` 或 \`std::thread::sleep\`，等于把别人的 \`epoll\` 完成通知也一起停掉。语法能跑通，吞吐和尾延迟会先告诉你错了。

这篇文章只讲多线程 runtime 这一层：任务怎么排队、怎么被偷、IO 怎么把 Waker 挂上、取消在哪一个 await 点生效、阻塞代码该去哪。读完你应该能独立回答三个问题：这段同步代码该不该 \`spawn_blocking\`、\`JoinHandle::abort\` 为什么杀不死正在 \`sleep\` 的代码、无界 channel 为什么会在流量尖峰时先把内存打爆而不是把 CPU 打满。

## 1. 先画边界：任务不是线程，await 不是系统调用

线程是操作系统的调度单位，有栈、有时间片、可被抢占。Tokio 任务是堆上的状态机，只在 \`.await\` 点主动让出。两套调度叠在一起：OS 调度 worker 线程，runtime 调度任务到 worker。

推论立刻变得具体：

- 没有 \`.await\` 的死循环会独占一个 worker。协作式调度没有时间片来救你。
- \`.await\` 不等于进入内核。已经 Ready 的 future 会在当前 worker 上一直 poll，直到 Pending 或完成。
- \`spawn\` 不是「开一条线程」。它是把状态机装箱、挂到调度器上。创建成本是一次分配加几次原子，不是 \`clone\` 一个 OS 栈。

\`\`\`rust
#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    let h = tokio::spawn(async {
        1 + 1 // 这个任务可能从未让出，在某个 worker 上一次 poll 完
    });
    let _ = h.await;
}
\`\`\`

\`current_thread\` runtime 只有一条线程跑所有任务，适合嵌入、测试、和 \`!Send\` 的 \`spawn_local\`。生产网关、RPC、代理默认是 \`multi_thread\`。选错的症状：单线程上一个阻塞 syscall 让全部 HTTP 停摆；或者 \`spawn_local\` 在多线程 runtime 上根本没有 LocalSet。

## 2. Worker、本地队列、注入队列、偷窃

多线程 runtime 默认：每个 worker 一条 OS 线程、一个本地队列。\`spawn\` 出的新任务通常进当前 worker 的本地队列（LIFO：刚 spawn 的孩子很可能马上被同一条线程跑，缓存友好）。另外有全局注入队列，处理从非 worker 线程 spawn 来的任务，以及窃取时的公共来源。

当一个 worker 的本地队列空了，它去别的 worker 的队列 **偷一半**（FIFO 从队列另一端）。这就是 work-stealing：让空闲 CPU 去填满，而不是让任务钉死在出生的那条线程上。本地队列容量是有限的（实现里是固定槽位，满了会溢出到注入队列）。突发 \`spawn\` 一万个子任务，多出来的不会「无限贴在本核上」，会进入可被立刻偷走的公共路径。这是好事（别的核能帮忙），也是坏事（缓存局部性被主动丢掉）。扇出之前用信号量把 in-flight 钉在几百而不是几万，既是背压，也是在保护队列形态。

几条生产推论：

- **不要假设任务亲和性。** 这次 poll 在 worker 2，下次可能在 worker 5。线程局部的 \`!Send\` 缓存、\`thread_local!\` 连接、\`Rc\`，都不能进 \`spawn\`。
- **不要假设公平。** LIFO 本地队列对「spawn 一棵很深的任务树」很友好，对「先来的请求要先服务」不保证。尾延迟敏感的路径要自己做队列和并发上限。
- **偷的是任务，不是线程。** 一个卡住的任务不会被偷走——它正占着那个 worker 跑同步代码。能被偷的是还在别人队列里、还没 poll 的那些。

\`tokio::task::yield_now().await\` 把当前任务重新入队，让出这一次 poll。CPU 密集但可切分的循环（校验和、JSON 大数组）应当隔一段 yield，否则协作式调度退化成「谁先跑谁占满」。runtime 还有合作预算（coop budget）：一次 poll 里连续 Ready 太多次会被强制让出，避免饿死旁路任务。这不是你可以依赖去写热循环的借口，它是安全带。预算耗尽时的让出对调用方不可见——你的 \`Stream\` 会突然 Pending 一次，Waker 马上再叫醒你。自己实现 \`Future\` 时如果假设「只要底层 Ready 我就一直 Ready」，会和合作预算打架，表现为莫名其妙的调度间隙。正确态度：把每一次 \`poll\` 当成可能是最后一次连续执行，状态必须落在可恢复的边界上。

## 3. 一次 poll 到底发生了什么

Future 的接口是 \`poll(self: Pin<&mut Self>, cx: &mut Context) -> Poll<T>\`。\`Context\` 里是 \`Waker\`。任务被 poll 时：

1. 调度器从队列取出任务，在当前 worker 上调用 \`poll\`。
2. 若返回 \`Ready\`，任务结束，\`JoinHandle\` 一侧被唤醒。
3. 若返回 \`Pending\`，任务必须保证：**以后有人会调用 \`waker.wake()\`**。否则它会永远睡死。这就是「忘记唤醒」的死锁。

IO 资源（\`TcpStream\`、\`AsyncFd\`）把 Waker 注册到 mio/epoll/kqueue/iocp。内核说这个 fd 可读了，驱动找到对应 Waker，把任务重新注入调度器。计时器同理，只是源是时间轮而不是 socket。

\`\`\`rust
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

async fn echo(mut s: TcpStream) -> std::io::Result<()> {
    let mut buf = vec![0u8; 4096];
    loop {
        let n = s.read(&mut buf).await?; // Pending：Waker 挂在 fd 上
        if n == 0 {
            return Ok(());
        }
        s.write_all(&buf[..n]).await?;
    }
}
\`\`\`

\`read\` 未就绪时，这个 echo 任务不占 CPU，但占着任务槽和那块 \`buf\`。一万个空闲连接就是一万个状态机加一万块缓冲——这是内存账单，不是调度账单。缓冲策略见零拷贝那篇；这里只提醒：挂起的任务不是免费的。

自己写 \`Future\` 时，最常见的两种 bug：返回 \`Pending\` 却没 clone \`Waker\`；以及就绪了却没 \`wake\`，等下一次碰巧被 poll。\`tokio::sync\` 的 channel、Mutex、Notify 内部都在维护等待者列表。你用 \`poll_fn\` 手写协议状态机时，要把「谁会唤醒我」写进注释，最好写进类型。

任务在堆上的形状大致是：一个引用计数的 Header（状态位、Waker、vtable）加上 Future 本体。\`spawn\` 一次分配把它们放在一起。Header 上的状态机负责「正在跑 / 已唤醒 / 已完成 / 已取消」。\`JoinHandle\` 是另一份引用；drop handle 且任务还在跑，任务变成 detached，panic 只能进 runtime 的全局 hook。这就是为什么「我 spawn 了但没 await」时，错误会从你以为的调用栈消失。生产里要么把 handle 收进 \`JoinSet\`，要么明确接受 detached 并装 \`tokio::spawn\` 的 panic 监控。

## 4. IO 驱动、计时器、阻塞池是三条不同的路

把 runtime 拆开，生产问题几乎都能归到其中一条路走错：

**IO 驱动。** 一条（或按配置）事件循环，等 \`epoll_wait\`。就绪的 fd 对应的任务被 wake。所有 \`AsyncRead\`/\`AsyncWrite\` 最终依赖它。在异步代码里调用 \`std::net::TcpStream::read\`，绕过了驱动，既阻塞 worker，又让 Tokio 的 \`TcpStream\` 和标准库的 fd 语义搅在一起。

**计时器。** \`sleep\`、\`timeout\`、\`interval\` 走时间轮。大量短定时器是一笔 CPU；超时必须包在真正的 IO future 上才有取消意义。\`timeout(dur, std::future::ready(x))\` 毫无意义。\`timeout(dur, blocking_call())\` 更糟：blocking 听不到超时。

**阻塞池。** \`spawn_blocking\` 把闭包送到专门的线程池（默认有上限，可配置）。适合：一次 CPU 很重但你不想自己切 yield 的活、同步文件系统、会阻塞的第三方 FFI。不适合：每个请求都 \`spawn_blocking\` 去跑 50μs 的活——队列和线程切换比活本身贵。

\`\`\`rust
async fn read_dump(path: &str) -> std::io::Result<Vec<u8>> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || std::fs::read(path)).await?
}

async fn hash_cpu(bytes: bytes::Bytes) -> u64 {
    tokio::task::spawn_blocking(move || {
        // 假设这是毫秒级以上的 CPU
        bytes.iter().fold(0u64, |a, b| a.wrapping_mul(16777619) ^ *b as u64)
    })
    .await
    .expect("blocking pool closed")
}
\`\`\`

文件系统：\`tokio::fs\` 内部就是 \`spawn_blocking\` 包 \`std::fs\`。小文件、启动时读配置，可以。热路径上每请求读盘，先问是不是该走缓冲、mmap、或根本不该在这个进程里读。

\`block_in_place\` 更危险：它在当前 worker 上跑同步代码，同时把 runtime 的其它任务「挪」到别的 worker，避免这条线程停死 IO。代价是重新平衡、可能死锁（持着 runtime 锁再 \`block_in_place\`）、在 \`current_thread\` 上行为不同。生产默认用 \`spawn_blocking\`，把 \`block_in_place\` 留给「不得不在这段栈上跑同步回调」的嵌套场景，并且写清楚为什么。

Runtime 的构造本身也是产品参数，不是样板：

\`\`\`rust
let rt = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(4)
    .max_blocking_threads(32)
    .thread_name("svc-worker")
    .enable_io()
    .enable_time()
    .build()
    .unwrap();
\`\`\`

忘记 \`enable_io\` 或 \`enable_time\`，\`TcpStream\` / \`sleep\` 会在运行时 panic，而不是编译期拒绝。测试里用 \`Builder::new_current_thread().enable_time()\` 再 \`Runtime::block_on\`，不要在单元测试里拉起和线上一样的 16 worker——那会把测试变成调度竞态抽奖。\`Handle::current()\` 依赖「当前线程已 enter 某个 runtime」。在普通 std 线程里调 \`tokio::spawn\` 会 panic。从阻塞池、从 \`thread::spawn\` 的回调里再进 Tokio，要把 \`Handle\` 显式 clone 过去，用 \`handle.spawn\` / \`handle.enter()\`。不要靠「碰巧在 worker 上」这种隐式上下文。

## 5. 取消：下一个 await 点，不是 SIGKILL

Rust 的取消默认是 **drop future**。\`tokio::select!\` 某个分支完成，其它分支的 future 被 drop；\`timeout\` 到期，内部 future 被 drop；\`JoinHandle::abort\` 在任务上设取消标志，**下一次 poll** 时注入 panic（\`JoinError::is_cancelled\`）。

听不到取消的代码：

- \`std::thread::sleep\`、同步 \`read\`、重 CPU 循环、不 poll 的 FFI。abort 只能等到它自己回到 await。
- 已经 \`spawn\` 出去的子任务。父 future 被 drop 不会级联取消孩子，除非你把 \`JoinHandle\` 留下来 abort，或显式传 \`CancellationToken\`。
- \`spawn_blocking\` 里的闭包。阻塞池没有 await 点。需要取消必须自己在闭包里看原子标志或 \`CancellationToken\`。

\`\`\`rust
use tokio_util::sync::CancellationToken;

async fn worker(token: CancellationToken, mut rx: tokio::sync::mpsc::Receiver<u32>) {
    loop {
        tokio::select! {
            _ = token.cancelled() => return,
            msg = rx.recv() => {
                let Some(msg) = msg else { return };
                if let Err(_) = do_one(msg).await {
                    return;
                }
            }
        }
    }
}
\`\`\`

\`select!\` 默认对每个分支的 future 在每次循环 **重新构造**。计时器写成 \`sleep(d)\` 而不是先 \`let sleep = sleep(d); tokio::pin!(sleep);\`，会导致每次别的分支就绪都把计时器重置。这是生产里超时「怎么也等不到」或「永远立即超时」的常见原因。

Drop 时的清理也要可取消意识：\`AsyncDrop\` 还不是稳定现实，析构里不能 \`await\`。连接要在 drop 里做的是同步或 spawn 一个独立的关闭任务，并且那个关闭任务自己有超时。不要在 \`Drop\` 里 \`Handle::current().block_on(...)\`——死锁和 panic 都常见。

超时和取消要配在**会让出的 future** 上。\`tokio::time::timeout(d, spawn_blocking(|| std::fs::read(p)).await?)\` 看起来设了超时，其实 \`spawn_blocking\` 的闭包听不到；timeout 只会让你在 \`await\` JoinHandle 时放弃等待，闭包继续在阻塞池里跑完，还占着池里的槽。要可取消的磁盘或 FFI，闭包内部自己看 \`AtomicBool\` 或用带超时的 syscall。否则超时只是「调用方不等了」，资源仍在烧。

取消安全（cancel safety）：\`select!\` 取消某分支时，该分支已经完成的副作用还在不在。\`mpsc::recv\` 是取消安全的（消息不会丢在半路）；某些 \`read_exact\` 风格的操作不是——取消时可能已经从 socket 啃了几个字节。协议解析要自己把「半包」留在缓冲里，而不是假设每次 \`select!\` 回去缓冲是干净的。这和零拷贝缓冲策略是同一张图。

## 6. 任务树、JoinSet、结构化并发

随手 \`spawn\` 是非结构化并发：任务飞出去，错误和取消要自己追。生产默认应能从根砍掉整棵树。

\`JoinSet\` 把一组孩子收在一起：\`join_next\` 收割、\`abort_all\` 全取消、drop \`JoinSet\` 也会 abort 剩余任务（具体语义以你用的版本为准，写测试钉死）。请求级的「扇出三个下游，谁先回来用谁」用 \`select!\`；「扇出 N 个必须都结束或都取消」用 \`JoinSet\`。

\`\`\`rust
use tokio::task::JoinSet;

async fn fanout(ids: Vec<u64>) -> Vec<u64> {
    let mut set = JoinSet::new();
    for id in ids {
        set.spawn(async move { fetch(id).await.unwrap_or(0) });
    }
    let mut out = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(v) = res {
            out.push(v);
        }
    }
    out
}
\`\`\`

注意 \`unwrap_or(0)\` 把错误吞了——扇出路径上要决定：一个失败是否取消其余。需要 fail-fast 就在第一次 \`Err\` 时 \`abort_all\` 并返回。需要部分成功就记录错误计数，不要静默。

\`JoinHandle\` 本身不 await 会让任务「脱离」：它继续跑，panic 变成「任务 panicked, no JoinHandle」。生产里要么 await，要么显式 \`detach\` 语义并配监督任务。监督者自己要有预算：无限重启加紧密集是放大故障，不是恢复。

## 7. 背压从调度器这一层就开始

调度器能吞下的任务数只受内存限制。\`spawn\` 没有内置上限。流量尖峰时无界 \`spawn\` + 无界 \`mpsc\` 的形状是：上游继续 accept，任务和消息堆在堆上，延迟先崩，然后 OOM。CPU 可能看起来还不忙——都在等下游。

有界才是默认：

- accept 循环和处理之间用有界 channel，满了就不要再 \`accept\`，让内核 TCP backlog 承担短抖动。
- 每个请求内部的扇出有并发上限（信号量或 \`JoinSet\` 大小）。
- \`buffer_unordered(n)\` 的 \`n\` 是飞在天上的 future 数，不是「尽量快」。

\`\`\`rust
use tokio::sync::{mpsc, Semaphore};
use std::sync::Arc;

async fn accept_loop(mut listener: tokio::net::TcpListener) {
    let (tx, rx) = mpsc::channel::<tokio::net::TcpStream>(1024);
    tokio::spawn(run_workers(rx));
    let sem = Arc::new(Semaphore::new(512));
    loop {
        let permit = sem.clone().acquire_owned().await.unwrap();
        match listener.accept().await {
            Ok((s, _)) => {
                if tx.try_send(s).is_err() {
                    drop(permit);
                    // 队列满：丢掉或停 accept，计一次 metric
                } else {
                    tokio::spawn(async move { drop(permit); });
                }
            }
            Err(_) => drop(permit),
        }
    }
}
\`\`\`

上面是示意：信号量和有界队列要和 worker 收包对齐，不要两套账。真正的 accept 循环通常是「获得 permit 再 accept」或「accept 完 try_send，失败则立刻关掉连接并打点」。关键是 **满了必须有行为**：拒绝、减速、丢弃，并度量。静默 \`spawn\` 到内存里不是行为。

无界 \`mpsc\` 的唯一正当理由是：生产者慢、消费者快、且你能证明峰值深度有界（例如「最多 N 个 in-flight 请求，每个一消息」）。证明不了就当它会 OOM。

## 8. 度量：worker 在干什么，比 QPS 先看

QPS 和平均延迟掩盖调度问题。至少要能回答：

- **worker 忙还是在 park？** park 多说明 IO 在等或没活；busy 且延迟高，可能是 CPU 或阻塞。Tokio 的 \`runtime.metrics()\`（需要 \`tokio_unstable\` 或对应 feature）能看 \`worker_park_count\`、\`injection_queue_depth\`、\`blocking_queue_depth\`。
- **阻塞池队列深度。** 持续增长说明 \`spawn_blocking\` 太多或闭包太慢。线程数加到上限之后就是排队，表现和 worker 被堵类似，只是 IO 还在跑。
- **任务数、channel 长度。** 任务数随流量线性涨且不回落，是泄漏或取消没传到叶子。channel 长期顶满，是下游慢，不是调度器慢。
- **单任务 poll 时间。** tracing 的 spans 打在业务 \`await\` 周围。某 span 数毫秒且里面没有 \`await\`，就是同步代码偷跑进了 worker。

本地复现：用 \`tokio-console\` 看任务谁在等锁、谁没被 poll。它吃的是 tracing 仪器，生产要抽样，不要每个任务全开。任务名（\`task::Builder::new().name("http-worker")\`）在 console 里值回票价，匿名 \`spawn\` 一万个长得一样，你只能数数。

IO 驱动本身也会成为瓶颈：单线程 \`epoll_wait\` 要把就绪事件分发给任务。连接数到十万、每条都是短包，wake 风暴会打在驱动和注入队列上。这时要看的不是业务 CPU，是 \`epoll\` 的 syscall 频率和 \`injection_queue_depth\`。分流（多 runtime、SO_REUSEPORT、或把连接按核钉住）是这一层的招，不是再加几个 worker 能自动好的。worker 加多了，偷和注入更热闹，驱动仍是一条。

压测时区分三种假象：\`current_thread\` 上测多连接；在 Debug 未优化下测调度；用 \`std::net\` 客户端把双方都堵在同步栈上。Release、多线程、真实的 keep-alive 连接数，三者缺一都不是你线上的调度器。

测试时间：\`tokio::time::pause()\`（test-util）让 \`sleep\` 变成逻辑时间，单测不必真等三秒。没开 test-util 就在 CI 里 \`sleep\`，测试既慢又抖。反过来，生产代码路径里不要依赖 pause；用依赖注入的 \`Clock\` 只在你需要「业务时间」的地方，runtime 的计时器仍走墙钟。混淆两者会出现「单测全绿、线上超时全错」——因为单测从未走过真正的时间轮。

## 9. 取舍：多线程、单线程、每个核一个 runtime

**多线程 work-stealing（默认）。** 吞吐好，\`Send\` 约束硬，偷任务带来的跨核缓存失效可测但通常可接受。适合 IO 为主、任务短、数量大。

**\`current_thread\`。** 没有偷，\`!Send\` 可用 \`spawn_local\`，延迟更可预测，一个阻塞点死全场。适合：嵌入其它框架的事件循环、单测、有大量 \`Rc\` 的单线程状态机。不要用它撑 C10k 然后奇怪为什么一处 \`fs::read\` 全局卡死。

**每个 CPU 一个单线程 runtime，用 SO_REUSEPORT 把连接分核。** 买到的是缓存局部和「这条连接的任务永不离开这颗核」。代价是负载不均、实现复杂、共享状态要走跨 runtime 的 channel。这是代理类产品在 profiler 证明跨核偷窃是热点之后的招，不是起步默认。

**worker 数量。** 默认等于 CPU 数。纯 IO 服务加线程很少能加吞吐，反而增加偷和上下文切换。CPU 密集该离开 worker，而不是加 worker。阻塞池大小按「同时阻塞的 syscall 数」估，按队列深度调，不要和 worker 数绑死。

**\`LocalSet\`。** 在多线程 runtime 的某条线程上跑 \`!Send\` 任务。必须保证这些任务不会被偷到别的线程——\`LocalSet\` 就是这个保证。用它夹第三方只提供 \`!Send\` 的回调。不要把整个请求链路放进 LocalSet 只为了偷懒不改 \`Rc\`。

还有一条容易忽略的边界：在 runtime 里再 \`Runtime::new().block_on()\`。嵌套 runtime 会制造两套 IO 驱动、两套计时器，死锁模式完全不同。正确做法是拿 \`Handle\`，或把这段代码改成 async 由外层驱动。库 crate 尤其不要在 \`Drop\` 或同步函数里偷偷 \`block_on\`——调用方可能已经在 Tokio 里，你在内部再造一个，等于在别人的房子里再打一口井。

## 10. 排障：卡顿、饿死、取消无效、内存涨

按症状选层，不要先改业务算法：

1. **所有请求一起慢，CPU 一条线程 100%。** 某个任务在 worker 上跑同步死循环或重计算。火焰图会指到你的代码而不是 \`epoll_wait\`。切开，\`yield_now\` 或 \`spawn_blocking\`。
2. **所有请求一起慢，CPU 接近 0。** 在等锁、等下游、等 \`std\` 锁跨 await 的经典死锁。\`tokio-console\` 看谁握着 \`Mutex\`。也可能是有界 channel 打满形成环形等待：A 等 B 的槽，B 等 A 的处理——画依赖。
3. **尾延迟尖刺，平均还行。** 合作预算耗尽前的长 poll、计时器风暴、GC 式的集中 drop（一次取消一万个任务）、阻塞池偶尔排队。看 p99 和 \`blocking_queue_depth\` 是否同跳。
4. **abort 之后任务还在跑。** 叶子在同步代码或 FFI 里。传 \`CancellationToken\` 进叶子，syscall 用带超时的版本，或把叶子改成可 poll 的异步。
5. **RSS 随流量涨不回。** 无界 spawn/channel、任务没结束（没人 poll 也没人 drop）、\`JoinHandle\` 没人要但也没结束、泄漏的 \`Arc\` 循环。先看任务数和 channel 长度，再看 heap。
6. **\`spawn_blocking\` 之后变慢。** 池满。要么减少阻塞调用，要么提高上限并接受线程数，要么把活移出进程。

一个具体反例：在 \`async\` 里用 \`std::sync::Mutex\`，锁里 \`await\` 下游 HTTP。某请求拿到锁后挂起，worker 继续跑别的任务；那些任务也来抢这把锁，阻塞 worker——\`std::sync::Mutex\` 的抢锁是同步的。结果是 runtime 的一部分线程睡在内核锁上，IO 驱动还在，表现像「随机卡死」。修法：锁内不做 IO；必须跨 await 的互斥用 \`tokio::sync::Mutex\`，并接受它更贵；最好还是把状态改成每个任务一份。

## 11. 和所有权叠在一起的那几条硬约束

调度器把任务搬走，所以所有权篇里的 \`Send + 'static\` 在这里变成运行时事实。几条不要分开记：

- 跨 \`await\` 的数据必须拥有或 \`Arc\`，因为下一次 poll 可能在另一条线程、另一个栈。
- 锁守卫跨 \`await\` 要么编不过（\`!Send\`），要么编过了但把互斥范围拉成「整个下游 RTT」。
- \`spawn\` 出去的孩子不共享父栈。要共享就显式 \`Arc\`，要取消就显式 token 或 \`JoinSet\`。
- 阻塞 syscall 不经过 poll，取消、超时、偷窃对它无效。

把这四条当代码评审清单，比争论「要不要用 actix 还是 axum」更能避免事故。框架只是在这些约束上面再铺一层 HTTP。

生产里还有几条调度器不会写进报错、但会写进延迟直方图的约束。\`join!(a, b)\` 是并发 poll 两个 future，不是开两条线程；两者都 Ready 之前不会往下走，取消时两个一起 drop。\`try_join!\` 在第一个错误处返回，另一个被取消——这是 fail-fast，要确认 \`a\` 的副作用可接受被丢掉。\`select!\` 带 \`biased;\` 时按书写顺序优先，公平性被你显式放弃，适合「取消 token 永远优先于业务 recv」。不带 biased 时内部有轻微轮转，不要依赖「哪个分支更可能赢」。

\`Notify\` / \`watch\` 用来发信号，不是用来传数据。\`notify_waiters\` 叫醒当前所有等待者，之后才注册的人看不到这次通知——这是「丢失的唤醒」，和 Future 忘了存 Waker 同类。状态变化要用 \`watch\` 的版本值或自己在 Mutex 里留一个条件标志，等待方被叫醒后重新读，不能假设「被叫醒 = 条件已成立」。经典的 condvar 用法在异步里同样适用：锁里改条件，解锁后 notify，等待方循环检查。

多 runtime 同进程：测试框架、嵌入式脚本、某些插件会再拉起一个 Tokio。\`Handle::current()\` 拿到的是 enter 栈顶的那个，不一定是你以为的那个。跨 runtime 的 \`spawn\` 会把任务投到另一套 IO 驱动上，timer 和 fd 不能混用。明确把 \`Handle\` 当依赖注入，初始化时存进结构体，所有 \`spawn\` 走 \`self.rt.spawn\`。隐式 current 是单 runtime 进程的便利，不是库代码的合同。

阻塞池的线程不是无限的。默认上限大约 512，但真正能同时跑的受机器和 \`max_blocking_threads\` 限制。池满之后 \`spawn_blocking\` 的任务在队列里等，调用方的 \`await\` 表现为延迟，火焰图上看不到你的闭包——它还没开始。度量 \`blocking_queue_depth\` 就是为了这个盲区。把每请求 JSON 解析丢进阻塞池，请求一多，池和队列先于 CPU 饱和。JSON 解析若是百微秒级，留在 worker 上并偶尔 \`yield_now\` 更合适；毫秒级以上或会调用阻塞 FFI，再进池。阈值用测量，不要用感觉。

IO 就绪风暴和任务惊群是调度器在高连接数下的另一种病。一万个 socket 同时可读（例如上游恢复、心跳对齐），驱动会在一轮 \`epoll_wait\` 里拿出大量事件，把对应任务全部注入。短时间里注入队列深度尖刺，worker 来回切任务，缓存被冲掉，尾延迟跳一档。应用层对策是：不要让所有连接的超时对准同一时刻（加抖动）；读循环一次不要贪太多帧再让出；用令牌桶限制从就绪变为「正在处理」的连接数。这不是调度器的 bug，是你把自然并发赤裸裸地交给了注入队列。

\`select!\` 和 \`JoinHandle\` 混用时，被丢掉的分支如果是 \`handle.await\`，任务继续跑，只是你不再收结果。这是隐式 detach。想取消，\`abort\` 或 drop 一个会 abort 的 \`JoinSet\`。想保留，就把 handle 存起来。评审里看到 \`select! { _ = timeout => ..., r = handle => ... }\` 必须问超时之后那个任务的命运。命运没有写明的 \`select!\` 是资源泄漏的温床。

本地开发用 \`RUST_LOG=tokio=trace\` 会把你淹没。更有效的是在可疑任务上打 \`tracing::instrument\`，看 span 的持续时间是否远大于内部 await 之和——差值就是同步代码或等待锁。差值大且 CPU 低，是等；差值大且 CPU 高，是算。两种修法相反。

信号和优雅退出也走调度器。\`ctrl_c().await\` 只是一个 future，真正的退出要把取消传到每一棵任务树：停止 accept、排空 in-flight、等一个截止时间、然后 abort 剩余。截止时间内阻塞在 \`std\` 锁或 FFI 上的任务听不到。所以优雅退出的预算里要包含「听不到取消的叶子」的最坏 syscall 时间，否则你会在 SIGTERM 之后被 kube 的强制 SIGKILL 打死，半写的文件和未发送的响应就留在那里。把退出当成一次全图取消来测，不要只测 \`ctrl_c\` 能返回。

优雅退出测的是整棵任务树，不是 \`ctrl_c\` 这个 future 能不能返回。流量还在进的时候发取消，断言 accept 停、在途请求在截止前结束、没有任务在取消之后还碰已经 drop 的状态。截止必须短于编排系统的强制杀死窗口。听不到取消的叶子要么换成带超时的 syscall，要么接受被杀并由上层重试把状态修回。

## 12. 小结

Tokio 多线程 runtime 的原理是协作式 poll + work-stealing。正确性靠三条工程约束：**await 点可取消、阻塞进专用池、队列有界**。任务能被偷，所以 \`Send + 'static\`；任务不会被抢占，所以 worker 上不能跑死循环；取消是 drop/下一次 poll，所以叶子必须能被 poll 到。

把 QPS 当调度健康度，会在无界队列里自我感觉良好直到 OOM。先看 worker 在 park 还是在跑同步代码，再看阻塞池和 channel 深度。调度器是管道的节拍器，不是无限 CPU。下一篇把任务里搬来搬去的那块字节拿出来：什么叫零拷贝，什么时候 memcpy 其实是诚实的。`,

  "rust-zero-copy-bytes-and-buffer-strategy": `把「零拷贝」理解成「内核 \`sendfile\` 那种不经过用户态」会在业务网关里立刻失效。应用层说的零拷贝，绝大多数时候是另一件事：**同一块已经在用户态的字节，不要为了换一个所有者再 \`memcpy\` 一次**。socket 读进一块缓冲，协议头和 payload 用切片指向它，跨任务移动只改引用计数。内核到用户态那一次 copy（或一次 page flip）已经付过了；后面每一层 \`to_vec()\`、\`String::from_utf8\`、\`Bytes::copy_from_slice\` 才是你真正能砍掉的账。

这篇文章只讲用户态缓冲：\`Bytes\`/\`BytesMut\` 怎么用计数共享一块分配、解析器如何把视图和所有权分开、\`readv\`/\`writev\` 在减少什么、什么时候拷贝反而是诚实的。读完你应该能独立回答三个问题：这段 \`to_vec\` 是在买独立可变副本还是在交税、头部和 body 为什么能指向同一块堆、连接级读缓冲为什么不能直接把引用交给下游任务。

## 1. 先把「拷贝」画在正确的层

一次 HTTP 请求体从网卡到业务 handler，可能经过这些拷贝：

1. 网卡 DMA 到内核 sk_buff（你几乎管不着）。
2. \`read\` / \`recvmsg\` 从内核拷到用户态缓冲（常规 socket 的默认税；\`io_uring\` 固定缓冲、\`mmap\`、\`splice\` 能减，但换来的是生命周期和硬件约束）。
3. 协议栈把缓冲 \`to_vec\` 成「请求体所有物」。
4. JSON 库再拷成 \`String\` 字段。
5. 下游 RPC 再 \`clone\` 一份发出去。
6. 日志再 \`format!\` 一份。

1 和 2 是操作系统的活。3 到 6 是应用层习惯。把火焰图上的 \`memcpy\` / \`memmove\` / \`alloc\` 当成「解析器不够快」，会去微优化 parser，而真正的乘数在第 3 层：每个请求一份新 \`Vec\`，QPS 上万时分配器比状态机更忙。

内核零拷贝（\`sendfile\`、\`splice\`、\`MSG_ZEROCOPY\`）解决的是「文件或用户缓冲如何进网卡队列」。它和 \`bytes::Bytes\` 不互相替代。静态文件网关该研究 \`sendfile\`；RPC 网关、多路复用代理、需要把同一包切给多个下游的服务，该研究用户态共享切片。两套词共用「零拷贝」这个名字，账不能混。

还有一类「看起来像拷贝、其实是搬所有权」：\`Vec\` 的 move、\`BytesMut::split\`、\`Cursor\` 往前走。它们改的是指针和长度，不碰有效载荷。优化时先问每一次「拷」落在上面哪一类。答错就会出现「我已经用了 Bytes，为什么分配器还在喷」——因为你在 Bytes 之上又 \`to_vec\` 了。

## 2. 所有权在计数上，不在每一层的新 Vec 上

\`bytes::Bytes\` 是一个胖指针：指向某段字节，外加一块共享的引用计数头（或静态/\`Vec\` 的特化路径）。\`clone()\` 只增加计数，不复制载荷。\`slice(start..end)\` 再得到一个指向同一分配、更短范围的 \`Bytes\`。最后一个 \`Bytes\` drop 时计数归零，底层缓冲才释放。

\`BytesMut\` 是可变侧：在唯一所有者（计数为 1、且没有只读视图活着）时可以 \`put\` / \`reserve\` / 改字节。\`freeze()\` 把它变成不可变的 \`Bytes\`，之后只能切片不能改。\`split_to(n)\` 把前 n 字节拆成另一段 \`BytesMut\`，剩下的仍可变——这是读缓冲「切走一个完整帧、留下半包」的原语。

\`\`\`rust
use bytes::{BufMut, Bytes, BytesMut};

fn take_frame(buf: &mut BytesMut) -> Option<Bytes> {
    if buf.len() < 4 {
        return None;
    }
    let n = u32::from_be_bytes(buf[0..4].try_into().unwrap()) as usize;
    if buf.len() < 4 + n {
        return None;
    }
    buf.advance(4);
    Some(buf.split_to(n).freeze())
}
\`\`\`

\`take_frame\` 没有为载荷分配。长度不够就返回 \`None\`，调用方继续 \`read\` 往同一个 \`BytesMut\` 尾部填。够了就把这一帧的所有权切走，半包留在原缓冲。连接上的读循环只拥有**一块**可变缓冲；飞出去的帧是只读视图。这张图一旦画清，后面的解析器、下游发送、日志，都应该吃 \`Bytes\` 而不是再要一份 \`Vec<u8>\`。

\`Bytes::from(vec)\` 会接管这个 \`Vec\` 的堆，不再拷载荷。\`Bytes::copy_from_slice\` 才是显式拷贝。代码评审里看到后者，要问：源缓冲的生命周期是否短于我需要的视图？短，才该拷；源是 \`Bytes\` 或能 \`freeze\` 的 \`BytesMut\`，就不该拷。

## 3. 解析器返回视图，调用方决定要不要拥有

解析的输入应该是 \`&[u8]\` 或 \`Bytes\`。输出如果只在当前函数用，返回 \`&[u8]\` / 结构体里带生命周期。输出如果要跨 \`await\`、跨任务、进队列，返回 \`Bytes\` 切片。

调用方拿到视图之后，第一件事是决定哪些字段要脱离共享块。连接 id、方法、状态码、路径里那一小段路由键，拷成整数或小 \`String\`；真正的 payload 继续用 \`Bytes\`。这个决定一旦做错，就会出现「我明明 slice 了 16 字节，为什么这块 64KB 缓冲还不释放」——因为计数钉的是整块分配。解析器文档应当写明：返回的 \`Bytes\` 可能钉住多大的底层块，调用方有没有责任在边界上拷小字段。
热路径上不要为了「接口好看」把 \`Head\` 改成全 \`String\` 字段。好看的代价是每一帧几次分配，QPS 上万时比解析本身还贵。类型设计在这里就是缓冲策略：字段类型决定以后还能不能零拷贝传给下游。

\`\`\`rust
use bytes::Bytes;

struct Head {
    ty: u8,
    flags: u8,
    payload: Bytes,
}

fn parse_head(mut frame: Bytes) -> Option<Head> {
    if frame.len() < 2 {
        return None;
    }
    let ty = frame[0];
    let flags = frame[1];
    let payload = frame.split_off(2);
    Some(Head { ty, flags, payload })
}
\`\`\`

\`split_off\` 之后 \`frame\` 持有前缀、返回值持有后缀，底层仍是一块。\`ty\`/\`flags\` 是拷贝两个字节——小且要脱离缓冲，这是诚实的。不要把整个 payload \`String::from_utf8(payload.to_vec())\` 只为了 \`println!\`。日志用 \`String::from_utf8_lossy(payload.as_ref())\` 或直接 \`log\` 十六进制前 N 字节。路由、header 名字、方法枚举，能做成 \`&'static str\` 或小枚举就不要保有原文切片。

过早 \`String\` 还有正确性问题：协议字段未必是 UTF-8。二进制协议里 \`from_utf8\` 失败被你写成 \`unwrap\`，等于把一个畸形包变成进程崩溃。先当 \`[u8]\` 验证，需要文本时再在边界转换，并且失败是错误类型，不是 panic。

JSON / protobuf 反序列化常常是隐藏的全量拷贝：每个 \`String\` 字段一份。热路径上的网关如果只做转发，不要解码成领域对象再编码回去——透传 \`Bytes\`，只解析你路由需要的那几个字节。必须解码时，看库是否支持借用反序列化（\`serde\` 的 \`&str\` / \`Cow\`、protobuf 的 \`bytes\` 字段映射到 \`Bytes\`）。默认 \`String\` 是库作者图省事，不是物理定律。

## 4. 连接级缓冲不能把引用借出连接

这是所有权和零拷贝交界上最容易翻的地方。连接任务拥有 \`BytesMut\` 读缓冲。一个完整帧切出去之后，**这帧的 \`Bytes\` 可以发给别的任务**；指向缓冲内部的 \`&[u8]\` 不行，因为下一轮 \`read\` 可能 \`reserve\` 导致重分配，旧指针悬空。即便不重分配，连接关闭时缓冲 drop，引用也死。

所以：连接循环和下游之间的契约是 \`Bytes\`（或 \`Vec<u8>\`），不是 \`&[u8]\`。看起来多了一次计数，买到的是「下游的 \`await\` 不再绑在连接的栈上」。这和所有权篇里「跨 await 只移动拥有的值」是同一条规则，只是这里的「拥有」碰巧是共享只读的计数切片。

反例：

\`\`\`rust
async fn bad(buf: &BytesMut, tx: tokio::sync::mpsc::Sender<&[u8]>) {
    let _ = tx.send(&buf[..]).await; // 生命周期无法越过连接任务
}
\`\`\`

正例：\`tx.send(buf.split_to(n).freeze()).await\`。有界 channel 满了，发送方 await——背压自然作用在读循环上，读循环不再疯狂 \`read\`。这和 Stream 那篇是同一根管子，缓冲策略提供的是管子里流动的**物件形状**。

写路径对称：多个 \`Bytes\` 要写出，用 \`writev\` / \`Buf::chunks_vectored\` 一次 syscall 写多个不连续片段，而不是先 \`copy_to_vec\` 拼成连续再 \`write\`。拼连续是为了对齐、为了 C API、为了哈希整包——不是为了 \`write\` 本身。

## 5. 读循环：reserve、fill、切帧、回收

一个能在生产里跑的读循环，状态比「read 到 EOF」多：

1. \`buf.reserve(min_needed)\`。容量不够会重分配；重分配时如果还有活着的 \`Bytes\` 视图指向旧块，\`BytesMut\` 会先把唯一所有权拿回来（必要时拷贝）。这就是「视图活得太久会逼出一次拷贝」的机制。切走的帧尽快送走、不要在连接上囤积未 freeze 的别名。
2. 从 socket \`read\` 进 \`buf.chunk_mut()\` 或 \`read_buf\`，再 \`advance_mut\`。用 \`AsyncReadExt::read_buf\` 比先 \`read(&mut [u8])\` 再 \`put\` 少一次中间拷。
3. 循环 \`take_frame\` 直到半包。一包都切不出来就回到 1。
4. 帧大小设上限。长度字段说 2GB 就 \`reserve(2GB)\` 是攻击面。超过上限切断连接并打点，不要指望分配器拒绝来救你。
5. 空闲连接把容量还回去。长期 keep-alive、偶发大包，会把 \`BytesMut\` 的容量钉在峰值。\`BytesMut::new()\` 替换或 \`truncate\` + 适当 \`shrink\`，按策略，不要每个连接永占 1MB。

\`\`\`rust
use bytes::BytesMut;
use tokio::io::{AsyncRead, AsyncReadExt};

async fn read_loop<R: AsyncRead + Unpin>(
    mut r: R,
    tx: tokio::sync::mpsc::Sender<bytes::Bytes>,
) -> std::io::Result<()> {
    let mut buf = BytesMut::with_capacity(8 * 1024);
    loop {
        if tx.capacity() == 0 {
            tx.reserve().await.map_err(|_| std::io::ErrorKind::BrokenPipe)?;
        }
        let n = r.read_buf(&mut buf).await?;
        if n == 0 {
            return Ok(());
        }
        while let Some(frame) = take_frame(&mut buf) {
            if frame.len() > 1024 * 1024 {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
            }
            if tx.send(frame).await.is_err() {
                return Ok(());
            }
        }
        if buf.capacity() > 64 * 1024 && buf.len() < 4096 {
            buf = BytesMut::from(&buf[..]); // 小半包搬到小分配，旧峰值释放
        }
    }
}
\`\`\`

\`take_frame\` 见第 2 节。容量回收那一行是拷贝——半包通常很小，这是用一次小拷贝换回大容量。这就是「诚实的拷贝」。

## 6. 何时必须拷贝（以及如何只拷该拷的）

必须拷贝的常见原因：

- **要改几个字节，但其它视图还活着。** 改 \`Bytes\` 只能先 \`copy_to_bytes\` / \`to_vec\` 成自己的 \`BytesMut\`。不要为了改一个 flags 位把 2MB payload 一起拷——切开，只拷头部那几个字节，payload 继续共享。
- **要对齐、合并给 C API 或硬件。** DMA、某些加密库、\`iovec\` 数量有上限时，不连续片段必须收成连续。先 \`writev\` 试，不够再合并。
- **所有权必须唯一且对端会 \`free\`。** FFI 那篇会展开。交给 C 的缓冲如果对方用 \`free\`，你得用 libc 分配器分配并放弃 Rust 析构。这不是 \`Bytes\` 能直接表达的。
- **加密/压缩输出和输入重叠不安全。** in-place 算法有的允许，有的不允许。允许时才 in-place，默认当需要独立输出缓冲。
- **要持有一份不受上游回收影响的快照。** 审计日志、重放、失败重试。这时拷贝是产品需求。限制快照大小，不要把整个流量镜像进内存。

\`clone()\` 在 \`Bytes\` 上便宜，在 \`Vec<u8>\` 上昂贵。代码里看到 \`clone\` 先看类型。\`Arc<Vec<u8>>\` 也能共享，但切片要自己做偏移；\`Bytes\` 把偏移和计数打成一个类型。已经在用 \`Bytes\` 就不要再套一层 \`Arc\`。

小对象不要零拷贝原教旨：16 字节的 id 直接 \`Copy\` 进数组，比共享切片更甜。零拷贝的收益和载荷大小、拷贝次数、缓存行有关。对 20 字节的 header 谈引用计数，计数本身可能更贵。

## 7. 池化：先去掉明显的 to_vec，再谈对象池

缓冲池（\`BytesMut\` 回收、slab、\`Pool<Vec<u8>>\`）减少的是分配器压力和缓存不命中。它不减少逻辑错误：你把池里的缓冲发给下游、下游还没还、上游又从池里拿同一块来写，就是 use-after-free 的用户态版。Rust 的所有权在这里仍然有效——池的 \`acquire\` 必须把唯一 \`BytesMut\` 交出去，\`release\` 只接受所有权回来的那块。不要用 \`unsafe\` 把池做成共享可变数组然后靠注释保证。

顺序应当是：

1. 热路径消灭 \`to_vec\` / \`copy_from_slice\` / 无谓 \`String\`。
2. 读缓冲按连接复用一块 \`BytesMut\`（上一节的循环已经在做）。
3. profiler 仍显示分配热点，再引入跨连接的池。
4. 池有容量上限、有单块大小上限、有泄漏检测（借出超时打点）。

过早上池的典型症状：代码充满 \`unsafe\` 和生命周期谎言，性能和「每连接一块 BytesMut」差不多，因为瓶颈根本不在分配。\`jemalloc\` / \`mimalloc\` 对多线程小分配比系统 allocator 友好，有时换分配器比写池更便宜。先测。

\`with_capacity\` 是最便宜的池：你知道 99% 的帧小于 8KB，就不要让 \`BytesMut\` 从 0 一次次倍增。倍增会留下 7KB 的中间分配垃圾。预分配不是浪费，是把峰值变成稳态。

## 8. 内核侧：writev、sendfile、以及不要假装

用户态切片共享解决不了「数据还在文件里、我不想读进进程」。静态资源、大文件下载走 \`sendfile\` / \`tokio-uring\` / 平台对应 API，让内核把页送到 socket。这时进程里甚至没有 \`Bytes\`。混用的错误形状是：先 \`read\` 整个文件进 \`Vec\`，再 \`write_all\`——两份拷贝，内存按文件大小涨。

\`writev\` 把多段用户缓冲一次交给内核。HTTP 响应「状态行 + 若干 header + body」天然是多段。拼成一个 \`Vec\` 再写，是为了代码好看。\`Vec<IoSlice>\` 或 \`Buf\` 的 vectored 写，能保住 header 小分配和 body 的 \`Bytes\` 共享。注意 \`writev\` 部分写：返回值可能只写了前几段的一部分，要自己推进 iovec。\`AsyncWriteExt::write_all_buf\` 一类 API 帮你做推进，手写 syscall 就要处理短写。

\`io_uring\` 固定缓冲、注册文件，是另一套所有权：缓冲被内核借用期间，用户态不能改、不能释放。这和借用检查器想表达的是同一件事，只是发生在 syscall 边界。封装库如果把这块做成 \`Future\`，必须在 future 完成前钉住缓冲（\`Pin\` + 拥有）。自己用 \`unsafe\` 把栈上数组提交给 uring，然后 \`await\` 别的东西——这是 use-after-free，编译器救不了你。

## 9. 取舍：Vec、Bytes、&[u8]、mmap 各买什么

- **\`&[u8]\`**：最便宜的视图。不能跨 \`await\` 除非所有者还在栈上且被借用检查器承认。解析、校验、哈希的输入默认它。
- **\`Vec<u8>\`**：唯一可变所有权，API 无处不在，和 C 交接简单（\`as_mut_ptr\`）。切片共享要自己搞。适合构建中的消息、必须独占改的缓冲。
- **\`Bytes\`**：只读共享切片，跨任务便宜。生态（hyper、h2、tonic、多数代理）把它当硬币。适合已经成形的帧、请求体、RPC 消息。
- **\`BytesMut\`**：连接读侧、编码器写侧。freeze/split 是和 \`Bytes\` 的边界。
- **\`mmap\`**：把文件当切片。巨大只读、随机访问、生命周期绑在 \`Mmap\` 对象上。注意 SIGBUS（文件被截断）、和 fork 的相互作用、以及异步运行时里 mmap 缺页会堵 worker——大范围缺页该当阻塞活。
- **\`Cow<[u8]>\`**：偶尔改、多数不改。不是网络热路径的第一选择。

选类型就是选以后能不能零拷贝传给下游。入口已经 \`Vec\`，后面每层再转 \`Bytes\` 会有一次接管或拷贝。入口用 \`Bytes\`，要唯一可变时再 \`try_into_mut\` / 拷贝。公共库的 API 若强制 \`Vec<u8>\`，等于强迫所有调用方放弃共享。能收 \`impl Buf\` 或 \`Bytes\` 就不要收 \`Vec\`。

## 10. 排障：分配器、RSS、错把共享当拷贝

1. **火焰图上 \`malloc\`/\`memcpy\` 占比高。** 先 grep \`to_vec\`、\`to_owned\`、\`Bytes::copy_from_slice\`、\`String::from_utf8\`、\`clone()\` 在 \`Vec\`/\`String\`/\`HashMap\` 上。不要先写池。
2. **RSS 随连接数线性涨。** 每条连接的 \`BytesMut\` 容量钉在峰值；或切出去的 \`Bytes\` 被下游（日志、access log、慢消费者）长期握着，底层整块缓冲无法释放——因为计数切片共享的是**整块分配**，不是你 slice 出来的那 16 字节。一条 64KB 读缓冲上切出 16 字节 header 送到慢队列，这 64KB 会活到那 16 字节被 drop。修法：小字段拷贝出来（诚实的小拷贝），大 payload 才共享。
3. **延迟尖刺伴随分配。** 某条消息异常大，\`reserve\` 一次翻倍；或 jemalloc 从中心刷 dirty page。对帧长做直方图，不要只看平均。
4. **以为用了 Bytes 仍然在拷。** \`hyper\` 的 body 聚合成 \`to_bytes().await\` 会把所有 chunk 收成一块——这是一次合并拷贝。能流式处理就不要聚合。gRPC 默认有消息大小上限，超大消息会在这一层爆炸。
5. **数据错乱。** 池或 \`unsafe\` 复用缓冲、切帧长度算错、\`advance\` 和 \`split_to\` 混用导致半包错位。先用单测喂粘包/拆包/最大长度，再谈性能。错的零拷贝比慢的 \`Vec\` 贵得多。

度量：每请求分配次数和字节（dhat、heaptrack、\`ALLOCATOR\` 计数器）、帧大小直方图、连接上 \`BytesMut.capacity\`、channel 里待处理 \`Bytes\` 的数量。后一项能直接看到「慢消费者握着多少整块读缓冲」。

## 11. 设计上为什么是引用计数切片，而不是全局缓冲池加下标

\`Bytes\` 把偏移、长度、释放策略（\`Vec\` / 静态 / 自定义析构）收进一个值类型。你可以把它送进 channel、放进结构体、跨 crate 传递，接收方不需要知道这块内存来自哪一个池。全局池加下标的模型更「零开销」，但所有权变成了整数，借用检查器帮不上忙，跨组件的释放约定会回到注释里。

这是和 Rust 整体一致的取舍：用一个薄薄的计数，换回类型系统对「谁最后释放」的证明。计数的原子操作在热路径上可测，但通常低于一次 \`malloc\`+\`memcpy\`。只有在 profiler 指出 \`Bytes\` clone 的原子是热点时，才考虑对那一段改回单所有权 \`Vec\` 或线程局部池。先共享，测，再收紧——和锁那篇的顺序一样。

再把「半包」说透。TCP 是字节流，不是消息流。一次 \`read\` 可能得到半个帧、一个帧、一个半帧、或十个帧粘在一起。\`take_frame\` 必须能在这四种输入下都不丢字节、不重分配出错误的切片。测试至少覆盖：正好一帧、两帧粘连、长度字段跨两次 read、长度字段声称的大小超过上限、长度为 0、对端在半包时关闭。关闭时缓冲里若还有半包，那是协议错误，不要把半包当一帧送下去。二进制协议用大端长度很常见，解析时不要 \`as u32\` 截断 \`usize\`，也不要在 32 位目标上让 \`u32\` 长度直接 \`reserve\` 到 OOM——上限检查在 \`reserve\` 之前。

编码器对称：先写长度占位，再写 payload，再回填长度。\`BytesMut\` 在 \`reserve\` 后指针稳定（没有并发视图时），可以先 \`split_to\` 出头部槽。不要为了回填把已经写好的 payload \`clone\` 到新缓冲。HTTP/1 的 chunked 编码每次 chunk 一个长度行，适合小 \`Bytes\` 列表 vectored 写出；不要先拼成一个大 \`String\`。

压缩和加密是拷贝的高发区。多数 zlib/tls 实现吃 \`&[u8]\` 吐新 \`Vec\`。输入侧仍可零拷贝喂 \`Bytes.as_ref()\`；输出侧新分配通常不可避免。有的库支持 \`write\` 到 \`BufMut\`，让你预留 \`BytesMut\` 当输出，少一次中间 \`Vec\`。TLS 的记录层还有自己的缓冲，应用层再缓冲一层要知道总深度。终端用户看到的延迟是各层缓冲之和，不是你这一层的 \`ready_chunks\`。

调试零拷贝 bug 时，在 \`Bytes\` drop 时打日志没有用——共享的是整块，你不知道谁还握着。更好的办法是在切帧处记录 \`ptr\` 和 \`len\`，在可疑的下游打印同一 \`ptr\`。同一指针出现在「连接已关闭」之后，就是有人把视图活过了连接。这不是 Rust 的 use-after-free（计数还在，内存还在），而是逻辑泄漏：大块缓冲被一个 16 字节的 header 视图钉在堆上。把小字段拷走之后，ptr 就不该再出现在下游。

HTTP 和 RPC 框架里的 body 类型是缓冲策略能否贯彻的试金石。\`hyper\` 的 \`Incoming\` 是一串 chunk 的 Stream；\`to_bytes().await\` 把它们收成一块 \`Bytes\`，中间可能发生一次合并拷贝。网关若只是把 body 转给下游，应当 \`forward\` 这个 Stream，并设置帧大小和总大小上限，而不是先聚合再转发。聚合的正当理由是：下游 API 要求完整消息、要算签名、要反序列化。即便如此，上限必须在聚合之前，否则恶意的无限 chunk 会把内存吃光——这是背压在 HTTP 层的具体化。gRPC 的消息大小上限、HTTP 的 \`content-length\` 检查、chunked 的累计字节，都是同一类墙。

编解码器（\`tokio-util::codec::Decoder\`）把「切帧」做成 trait：\`decode(&mut BytesMut) -> Result<Option<Item>>\`。返回 \`None\` 表示半包，\`Some\` 表示切出一项。你自己维护的 \`take_frame\` 和它是同一个函数。\`Item\` 里如果包含 \`Bytes\`，就是零拷贝切帧；如果包含 \`Vec<u8>\` 或 \`String\`，每一帧一份分配。能用 \`Bytes\` 就不要在 codec 里 \`to_vec\`。长度检查、最大帧、reserve 策略都应该在 decoder 里，而不是在业务 handler 里补。handler 看到的应当已经是合法的、有界的项。

文件上传和下载不要经过「整个 \`Vec\`」。上传：把 \`Stream<Item = Bytes>\` 直接 \`write_all_buf\` 到文件或对象存储 SDK 的分片接口。下载：\`sendfile\` 或按块 \`read\` 成 \`BytesMut\` freeze 后写出。中间若要算哈希，用流式 hasher 喂每一块，不要等全部到齐。内存峰值应接近块大小，而不是文件大小。谁在路径上偷偷 \`collect\`，谁就把峰值变回文件大小。代码评审 grep \`collect\`、\`to_bytes\`、\`read_to_end\` 在上传下载路径上应当是红色的。

缓存层常破坏零拷贝：把 \`Bytes\` 放进 LRU，条目的寿命变成「缓存策略」，底层那块读缓冲就活到 LRU 驱逐。小 key 拷贝、大 value 才共享，并且 value 最好是已经独立分配的 \`Bytes\`（\`copy_from_slice\` 或 \`freeze\` 时恰好唯一所有者），而不是某个 64KB 读缓冲上的 2KB 切片。缓存条目的真实成本是它钉住的分配大小，不是 \`slice.len()\`。度量缓存字节数时按底层分配估，否则你会觉得缓存只有 100MB，RSS 却多了 1GB。

 scatter-gather 写（\`writev\`）失败时的推进容易写错。内核可能写完第一段和一半第二段就返回。你的 \`IoSlice\` 数组要切掉已写前缀，而不是从头再写一遍——重写会把已经到对端的字节再发一次，协议就乱。\`write_all_buf\` 一类封装帮你做这件事，手写 syscall 就必须测短写。读侧 \`readv\` 同理：半包可能落在第 i 段的中间，切帧逻辑仍应建立在逻辑字节流上，而不是「一段刚好一帧」的幻想。测试里用一次只吐一个字节的 \`AsyncRead\` mock，能把这类假设打碎。

 还有一类「假装零拷贝」：\`mmap\` 后再 \`Vec::from\` 整段。mmap 的意义是按页缺页，不把文件一次读进进程；立刻拷进 \`Vec\` 就把意义取消了，还加上了 SIGBUS 和生命周期。对文件做解析，能用 \`&[u8]\` 从 mmap 切就切，要跨 await 再拷需要的那一段。巨大 JSON 文件用 mmap + 借用反序列化，峰值内存接近文件大小的映射而不是两倍拷贝；但缺页会堵 worker，大文件解析仍该进阻塞池，映射对象的所有权跟着闭包走。

 对象存储 SDK、TLS、压缩中间层经常在内部藏缓冲。你在应用层已经零拷贝了，SDK 仍可能把 body \`collect\` 再发。选 SDK 时看它吃 \`Stream<Bytes>\` 还是吃 \`Vec<u8>\`。吃 \`Vec\` 的，你的 Bytes 策略在边界上结束，这是诚实的拷贝点，记在文档里，不要在更外层再怪自己「没做好零拷贝」。能换吃流的 API 就换；不能换，就把拷贝算进预算，限制并发上传数，让这份拷贝的内存有界。

解析状态机应把「还差多少字节」告诉读循环，\`reserve\` 才能刚好。盲目倍增会把容量钉在 2 的幂峰值上，小半包长期占着它。还差 8 字节时去 \`read\` 64KB，是用超前读取换 RSS 乘法器。按帧长分布选一次读的目标大小。
\`String::from_utf8_unchecked\` 接在 \`to_vec\` 后面是假零拷贝：既拷了，又关掉 UTF-8 检查。要文本且已验证，用 \`from_utf8\` 借；要拥有再 \`to_owned\`。未验证就 unchecked，畸形包会变成更晚才炸的内存问题。二进制字段默认保持 \`[u8]\` 直到出口。
scatter-gather 必须测短写。内核写完一段加半段就返回时，要从 \`IoSlice\` 里切掉已写前缀，从头重写会把已到对端的字节再发一遍。用一次只吐一个字节的 mock \`AsyncRead\`/\`AsyncWrite\` 把「一段刚好一帧」的假设打碎。
SDK 和 TLS 内部常藏 \`collect\`。应用层 Bytes 策略在吃 \`Vec<u8>\` 的边界上结束，把这次拷贝写进预算并限制并发，比在更外层责怪自己没做好零拷贝诚实。

## 12. 小结

应用层零拷贝的原理是：**共享底层分配 + 切片表达子范围 + 用引用计数而不是 memcpy 转移只读所有权**。连接拥有可变读缓冲，切出去的帧是 \`Bytes\`，解析器在同步代码里借 \`&[u8]\`，跨 \`await\` 只移动计数切片。小字段、要对齐的 C 边界、需要独立可变的副本，拷贝是诚实的；热路径上的 \`to_vec\` 往往不是。

先画字节从 fd 到 handler 经过几次分配，再决定池和内核零拷贝值不值得上。下一篇把另一类「过早拥有」拿掉：错误值的类型。库把错误做成可 match 的枚举，应用边界再决定怎么汇报。`,

  "rust-error-handling-thiserror-anyhow": `把 \`unwrap()\` 理解成「错误处理的快捷方式」会在生产里立刻失效。它是断言：这里不可能失败，失败就崩。库把错误擦成 \`String\` 或一律 \`anyhow\`，调用方就失去 \`match\` 的权利，只能把内部故障当成同一句 500。错误类型是 API 的一部分，和返回的 \`User\` 一样，决定谁能决策、谁只能汇报。

这篇文章只讲错误的类型形状：\`Result\` 如何强迫处理、\`thiserror\` 如何把 IO 收进领域、\`anyhow\` 在哪一层才该出现、panic 和错误的边界、如何映射到 HTTP/RPC 而不泄漏内部。读完你应该能独立回答三个问题：这个 crate 的公开 \`E\` 该不该是 \`anyhow::Error\`、\`?\` 传出去之前丢了什么上下文、为什么测试里的 \`expect\` 写了不变量而生产路径上的 \`unwrap\` 没有。

## 1. Result 是控制流，不是装饰

\`Result<T, E>\` 把失败做成值。\`?\` 是「失败就返回」，不是「失败就忽略」。类型上，调用方必须写 \`match\`、\`?\`、或显式 \`unwrap\`。这和异常的差别不在「漂不漂亮」，在于**失败路径是签名的一部分**，重构时编译器会追上每一个调用点。

\`E\` 选什么，决定调用方能做什么：

- 具体枚举：能区分 \`NotFound\` 和 \`PermissionDenied\`，能决定重试、降级、404。
- \`io::Error\`：能看 \`ErrorKind\`，但丢失「当时在做什么」。
- \`Box<dyn Error + Send + Sync>\`：能打印和 \`source()\` 链，不能稳定 \`match\`。
- \`anyhow::Error\`：同上，外加 \`context\` 和 backtrace 便利，仍然不能当领域决策。

生产事故里一类经典是：底层是 \`Connection reset\`，中间层 \`map_err(|_| "failed")\`，最外层日志只有 \`failed\`。你不是没有错误处理，是把决策信息在每一层剥掉。\`?\` 很便宜，剥信息也很便宜。要的是 \`?\` 之前把「做什么」留在类型或 context 里。

\`\`\`rust
fn load_user(id: u64) -> Result<User, anyhow::Error> {
    let raw = std::fs::read(format!("users/{id}"))?;
    let user = serde_json::from_slice(&raw)?;
    Ok(user)
}
\`\`\`

这个函数能跑。失败时你分不清是没这个文件、JSON 坏了、还是权限。应用边界可以暂时靠 anyhow 的 context 补「当时在 load_user」；库不能把这个签名公开出去——调用方无法 \`match\` 出 404。

## 2. 两层错误，两个方向

稳定的分层是：

- **库 / 领域层**：\`thiserror\` 生成的枚举（或手写 \`enum\` + \`Display\` + \`Error\`）。每个变体是调用方可能做出不同决策的一种失败。\`From\` 把底层错误收进来，但只收那些你打算保留或包装的。
- **二进制入口、请求边界、批处理主循环**：\`anyhow::Result\` 或等价物（\`eyre\`、\`color-eyre\`）。这里的任务是汇报：带上 context、打印链、退出码、Sentry。不再做领域 \`match\`。

\`\`\`rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("user {0} not found")]
    NotFound(u64),
    #[error("busy, try later")]
    Busy,
    #[error("io")]
    Io(#[from] std::io::Error),
}

fn load_user(id: u64) -> Result<User, StoreError> {
    let path = format!("users/{id}");
    let raw = match std::fs::read(&path) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(StoreError::NotFound(id));
        }
        Err(e) => return Err(e.into()),
    };
    serde_json::from_slice(&raw).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, e).into()
    })
}
\`\`\`

\`NotFound\` 和 \`Busy\` 是领域。IO 被收进 \`Io\`，调用方若只关心「要不要重试」，可以再提供 \`fn is_retryable(&self) -> bool\` 而不是让每个人去 \`match Io(e)\` 的 \`ErrorKind\`。JSON 在这里被收成 \`InvalidData\`——这是一种选择：库认为损坏的文件和坏 IO 对调用方是同类。若调用方必须区分，就再加 \`Corrupt\` 变体，不要偷懒全进 \`Io\`。

\`thiserror\` 干的是脏活：\`Display\`、\`Error::source\`、\`From\`。它不替你设计变体。变体设计是产品问题：调用方到底有几种不同的反应？反应相同的失败，不该是不同变体。反应不同却被收成一个 \`Other(String)\`，类型系统帮不上忙。

## 3. 不要把字符串当错误协议

\`Err("oops".into())\`、\`anyhow!("something {}", x)\`、\`Box<dyn Error>\` 从 \`String\` 造出来，都是把协议写成散文。散文适合人读，不适合机器决策。重试器不能 \`if err.to_string().contains("timeout")\`——文案一改，重试策略就静默失效。

稳定的对外协议是：错误码 / 枚举 / gRPC status / HTTP 状态 + 机器可读的 \`code\` 字段。\`Display\` 给日志和人。两者不要用同一根字符串走完全程。

把错误当协议来演一次版本升级：你把 \`Timeout\` 的文案从「上游超时」改成「网关超时」，如果客户端或重试器在 \`contains("上游")\` 上做判断，行为会静默改变。\`code()\` 仍是 \`timeout\`，机器路径不应受文案影响。这就是为什么 Display 和 code 必须分开，以及为什么 code 的changelog 要当 breaking 来写。
错误里携带的动态数据（用户 id、路径、对端地址）用结构化字段，不要拼进 Display 当唯一来源。日志系统按字段检索；拼进句子里的 id 很难再被仪表盘分组。字段还要分级：对端地址进日志，不一定进对用户的响应。泄漏不是只有 SQL 才算，内部主机名和磁盘路径同样是泄漏。
\`thiserror\` 的 \`#[error("... {0}")]\` 会把内部错误的 Display 嵌进来。嵌底层 \`io::Error\` 的操作系统文案可能是英文、可能含路径。对外响应不要直接用这个 Display。对外用稳定中文或稳定英文短句，对内用链。两套文案，两套读者。
重试器、熔断器、限流器都是错误类型的消费者。它们不该知道 HTTP。给它们 \`is_retryable()\`、\`is_overload()\`、\`retry_after()\` 就够。在 axum 层再把同一枚举映射成状态码。两层都 match 同一枚举，比一层转字符串另一层再解析健壮。缺方法时加方法，不要让基础设施去猜。
测试里对每个变体断言四件事：status、code、retryable、日志级别。一张表，二十行，能挡住八成「全是 500」和「告警被 404 淹没」。这张表比任何错误处理框架都值钱。

\`\`\`rust
#[derive(Debug, Error)]
pub enum RouteError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("upstream timeout")]
    Timeout,
    #[error("unavailable")]
    Unavailable,
}

impl RouteError {
    pub fn http_status(&self) -> u16 {
        match self {
            RouteError::NotFound(_) => 404,
            RouteError::Timeout => 504,
            RouteError::Unavailable => 503,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            RouteError::NotFound(_) => "not_found",
            RouteError::Timeout => "timeout",
            RouteError::Unavailable => "unavailable",
        }
    }
}
\`\`\`

对客户端只给 \`code\` + 安全的消息。内部 \`source\` 链、路径、SQL、对端主机名，写进日志和 tracing span，不写进响应体。把 \`Display\` 直接塞进 HTTP 是信息泄漏，也是不稳定协议——你改了句中文文案，客户端解析就碎。

\`non_exhaustive\` 用在库的公开错误枚举上：你以后加变体，旧的调用方 \`match\` 必须有 \`_\`。这是在承认错误集合会演化。应用内部的枚举不必如此，漏掉一个变体让编译器提醒你更新 HTTP 映射，反而是好事。

## 4. anyhow 的正当位置，以及它擦掉了什么

\`anyhow::Error\` 是带 vtable 的错误对象，外加 context 栈。\`with_context(|| format!("loading user {id}"))\` 在失败路径上才分配那句字符串。它适合：

- \`main\`、CLI、批处理任务；
- HTTP 请求的最外层 handler，已经决定只记日志 + 500 分类；
- 胶水代码，把三个不同库的错误收口。

它不适合：

- 库的公开签名；
- 需要 \`match\` 决定 404/409/429 的那一层；
- 热路径上作为「可能失败」的常见分支（每次失败都装箱、都可能抓 backtrace）。

\`anyhow\` 和 \`thiserror\` 不是互斥宗教。同一进程里，\`store\` crate 返回 \`StoreError\`，\`axum\` handler 里 \`map_err\` 成 HTTP，或 \`anyhow::Context\` 包一层再在边界转换成状态码。转换发生的那一层叫反腐败层，不要把 anyhow 往下渗透到仓库实现里「图省事」。

\`eyre\` / \`color-eyre\` / \`snafu\` 是同一设计空间的不同口味。\`snafu\` 更强调上下文枚举，适合想保持类型又想自动加 context 的库。选一个，写进工程约定。不要每个 crate 一种，错误链会在日志里变成三种格式。

## 5. From、map_err、context：三层不同的丢失

\`?\` 依赖 \`From\`。\`From<io::Error> for StoreError\` 意味着所有 IO 失败在这个边界上语义相同。这很方便，也很危险：超时、拒绝、未找到，都会变成同一个 \`Io\`。需要区分时，不要实现笼统 \`From\`，写显式 \`match\` 再 \`?\`。

\`map_err\` 是一次性转换。适合「这里的 IO 失败就是 NotFound」。写完要看是否丢了 \`source\`。\`thiserror\` 的 \`#[from]\` / \`#[source]\` 会把底层留在链上，\`map_err(|_| RouteError::Unavailable)\` 会把底层扔掉。扔掉之前确认日志已经记过，或你把底层放进变体。

\`context\` 不改类型（对 anyhow），只在链上加一层「当时在做什么」。它解决的是 \`Display\` 不够、但类型已经擦掉的那一层。领域层优先加变体或字段（\`user_id\`），不要用散文 context 替代 \`NotFound(u64)\`。数字能 \`match\`，句子不能。

失败路径的分配：\`format!\` 一条 context、\`Box\` 一个 dyn、backtrace 展开，在错误罕见时无所谓。把错误当控制流（「文件不存在是常态」）时，这些都会进热路径。常态失败应该是枚举变体，不装箱，不抓栈。\`NotFound\` 不是异常。

把「失败」和「没找到」在类型上分开之后，调用方的代码会干净很多：缓存层返回 \`Option\`，仓库层在「按 id 读取必须存在」的 API 上才抬成 \`NotFound\`。同一底层查找，两个签名，两种语义。不要图省事只提供 \`Result\` 版，让所有调用方都走错误通道，日志和 SLO 会被「正常的没有」填满。
错误路径的测试数据要像生产：超长字符串、非 UTF-8、磁盘满的 \`ErrorKind\`、被取消的 \`JoinError\`。只用 \`anyhow!("boom")\` 当假错误，测不到映射表，也测不到泄漏的 Display。注入真实 kind，断言对外 code 和日志字段，这才是错误类型的契约测试。


## 6. panic、unwrap、expect、unreachable

panic 是进程级的「不变量破了」。栈展开、drop、可能 abort（见构建篇的 \`panic = abort\`）。跨 FFI 的 panic 是未定义行为。在 tonic/axum 的请求任务里 panic，默认会把这个任务打死，不一定崩进程——于是你得到一个 500 和一个「task panicked」日志，没有类型化错误。这不是策略，是漏网。

- **\`unwrap\`**：生产路径禁止，除非你能用一行注释证明此处数学上不可能 \`Err\`/\`None\`，并且失败意味着内存损坏或编程错误。即便如此，\`expect("队列只在 drop 后关闭")\` 更好，因为它留下不变量。
- **\`expect\`**：测试、构建器、进程启动时的必有配置。消息写不变量，不写「出错了」。
- **\`unreachable!\` / \`todo!\`**：前者给编译器证明这个分支关了；后者不许进生产二进制。
- **\`unwrap_or_default\`**：失败被静默成空值。配置解析失败变成空配置，比 panic 更阴险。

启动路径上 \`expect\` 是正当的：端口绑定失败、必填环境变量缺失，进程就不该进就绪探针。请求路径上同样的 \`expect\` 是放大故障——一个坏请求不该带走 worker 上碰巧共享的状态。请求路径返回 \`Result\`，由边界映射。

\`debug_assert!\` 只在 debug 活着。不要用它检查必须在 release 也成立的协议不变量。恶意输入不是 debug-only 的。

## 7. 错误与并发、取消、部分失败

异步和扇出让错误从「一个 \`Result\`」变成「一组」。

- 一个子任务失败，其它怎么办：fail-fast 取消剩余（\`JoinSet::abort_all\`），还是收集全部 \`Result\` 再汇总。产品语义，不是风格。
- 取消不是错误。\`JoinError::is_cancelled()\`、\`select!\` 丢掉的分支，不要记成 \`ERROR\`。否则告警系统会被部署和超时淹没。
- 部分写：先写磁盘再写索引，中间失败要有补偿或事务。错误类型要能表达「可能已经产生副作用」——这和函数式的纯 \`Err\` 不一样。签名里用 \`CommitError { written: u64 }\` 这种变体，比一句 \`failed\` 值钱。
- 通道关闭：\`SendError\` 表示接收方没了，通常是正常关闭路径，不一定是故障。\`match\` 它，不要 \`?\` 到最外层变成 500。

\`\`\`rust
async fn write_both(a: &Path, b: &Path, bytes: &[u8]) -> Result<(), CommitError> {
    std::fs::write(a, bytes).map_err(CommitError::First)?;
    std::fs::write(b, bytes).map_err(|e| CommitError::Second { first_ok: true, source: e })?;
    Ok(())
}
\`\`\`

调用方看到 \`Second { first_ok: true }\` 知道要清理 \`a\`。类型把补偿信息留下来。这就是「错误类型是 API」。

## 8. 映射到 HTTP / RPC / 退出码

边界上的映射表应该穷尽领域错误，而不是 \`to_string()\`：

- \`NotFound\` → 404 / gRPC \`NotFound\`
- \`Busy\` / 限流 → 429 / \`ResourceExhausted\`，带 \`Retry-After\`
- \`Timeout\` → 504 / \`DeadlineExceeded\`
- \`Unavailable\` → 503
- 校验失败 → 400 / \`InvalidArgument\`
- 未预期的 \`Io\` / 内部 → 500 / \`Internal\`，**日志记满链，响应只给 correlation id**

退出码同理：配置错误、用法错误、真正的内部故障，对 systemd/K8s 是不同的重启策略。一律 \`exit(1)\` 会让探针和崩溃循环分不清。

不要用 HTTP 状态当内部错误类型。领域层不知道 HTTP。否则你的仓库 crate 依赖 axum，测试和复用都脏。映射表住在 \`http\` 适配层，一层 \`match\`，可以测。

tracing：失败时 \`error!(error = %e, code = e.code(), user_id, "load_user failed")\`。把 \`user_id\` 放字段里，不要只放进字符串。后续检索、告警分组、采样都靠字段。\`Display\` 链用 \`error!(?e)\` 或 \`source\` 循环打，保证底层 \`io::ErrorKind\` 还在。

## 9. 取舍：类型精度、样板、分配、演化

精度和样板是一对：变体越多，\`match\` 越有价值，每个调用点越烦。收口成 \`Other\` 越早，决策越早消失。经验：按调用方的**不同反应**来拆，不按底层 errno 来拆。十个 errno 若都是「重试或 503」，一个 \`Unavailable\` 加 \`source\` 就够。

分配：枚举不含 \`String\` 就不在成功路径分配。变体里的 \`String\`/\`Box\` 只在失败时构造。热路径上的可预期失败（cache miss 不要当错误；\`Option\` 不是 \`Result\`）不要走错误通道。\`cache miss\` 是 \`Option::None\`，不是 \`Err\`。

演化：库的公开错误加变体是 breaking（除非 \`non_exhaustive\`）。把会变的细节放进 \`source\` 或内部结构，公开只暴露稳定的分类方法 \`is_not_found()\` / \`is_retryable()\`。调用方依赖方法而不是穷尽 \`match\`，你内部就能改。

\`thiserror\` vs 手写：变体少、要精确控制 \`source\`，手写也没几行。变体多、要 \`From\`，\`thiserror\` 减少复制粘贴。不要因为「不用宏更纯洁」手写二十个 \`Display\`。

## 10. 排障：丢失的上下文、被吞的错误、把常态当异常

1. **日志只有 \`error\` 两个字。** 某层 \`map_err(|_| ...)\` 或 \`to_string()\` 后丢了 source。从边界往下找第一个转换，补 \`#[source]\` 或 \`context\`。
2. **全是 500。** 领域错误在中间被收成 anyhow，handler 不再 \`match\`。在 handler 或专门的 \`IntoResponse\` 里对领域枚举映射，anyhow 只承接未预期。
3. **重试了不可重试的。** 校验失败、NotFound 被 \`is_retryable\` 误标。用测试钉映射表：每个变体是否可重试、对应哪个状态码。
4. **错误洪水。** 把取消、正常关闭、客户端断开当 \`ERROR\`。降到 \`debug\`/\`info\`，告警只留真正的内部故障。
5. **偶发 panic。** \`unwrap\` 在「我认为不会」的切片、锁中毒、解析上。锁中毒（\`Mutex::lock().unwrap()\`）是另一任务已经 panic 过——先修那个 panic，再决定中毒策略（\`into_inner\` 还是传播）。
6. **性能测试里错误路径很重。** backtrace 在 anyhow 里默认某些 feature 会抓。关闭或只在边界抓。热失败改枚举。

单测：对每个公开变体测一次映射。集成测：故意让下游 500/超时/断开，看你的服务返回码和日志字段。不要只测成功 JSON。

## 11. 和所有权、调度的交界

错误值也会被 move 进 channel、跨 \`await\`。\`E: Send + 'static\` 才能进 \`spawn\`。在错误里塞 \`&str\` 指向局部缓冲，和在成功值里塞一样，编不过或成为悬空。错误里需要的标识（id、路径）在失败那一刻拷进 \`String\` 或用已有的 \`Bytes\`，不要借。

\`spawn\` 的 \`JoinError\` 要把子任务的 \`E\` 和「任务 panic / 取消」分开。\`? \` 一个 \`JoinError\` 到 HTTP 层，会把取消变成 500。显式 \`match\`。

持锁时返回 \`Err\` 要先想守卫 drop 的顺序：\`? \` 会 drop 守卫，这通常是对的。不要把 \`MutexGuard\` 放进错误变体带出去。

把错误当 API 来设计时，还要决定哪些失败对调用方是**可预期的控制流**。打开文件不存在、缓存未命中、CAS 竞争失败，这些在领域里是日常。用 \`Result\` 还是 \`Option\` 取决于调用方要不要看原因：未命中没有原因，用 \`Option\`；未命中可能是「没有」或「后端超时」，用 \`Result\`。不要把 \`Option\` 当错误处理，也不要把所有 \`None\` 抬成 \`Err\`。\`ok_or(NotFound)\` 是显式抬升，发生在你确实决定「没有」对这个 API 是错误的那一层，而不是在每一层防御性抬升。

错误链的打印顺序要统一。\`Display\` 写本层，\`source()\` 指下一层。日志里从外往内走：\`while let Some(s) = err.source()\`。anyhow 的 \`{:#}\` 会打出链。不要每层 \`Display\` 都把底层 \`e\` 再格式化一遍，否则同一句 IO 错误出现三次，检索时像三件事。thiserror 的 \`#[error("io: {0}")]\` 若 \`0\` 已经是 \`io::Error\`，再加 \`#[from]\` 和 \`#[source]\` 时注意不要重复。只 \`#[from]\` 通常已经把 \`source\` 接好。

\`Box<dyn Error + Send + Sync + 'static>\` 是库不想暴露细节、应用又还没引入 anyhow 时的折中。它能跨线程、能进 spawn，不能稳定 match。一旦你发现调用方在 \`downcast_ref\` 上写了一堆 if，就是在用运行时反射补类型——该回到枚举了。downcast 对插件边界偶尔正当（对岸真的是未知类型），对自家的三个 crate 不正当。

文档里每个公开 \`Err\` 变体要写：是否可重试、是否可能已有副作用、对应的稳定 \`code\`。这比写「失败时返回错误」有用。示例代码展示 \`match\`，不要只展示 \`?\`。\`?\` 教不会调用方决策。

重试不是错误类型的一部分，但错误类型必须能支撑重试器。重试器要问：可不可重试、建议等多久、已经有没有副作用。\`is_retryable()\` 和 \`retry_after()\` 比让重试器去解析 \`Display\` 稳定。幂等的 \`GET\` 超时可重试；非幂等的 \`POST\` 在「不确定有没有到达」时重试会双写——错误变体要能区分 \`Timeout { maybe_committed: bool }\` 这类含糊失败和确定的 \`Unavailable\`。含糊失败走查询、去重键或人工，不走盲目重试。把这套规则写成函数，用表驱动测试钉住每一个变体，比在三个调用点各写一套 \`match\` 安全。

观测性上，错误要当字段，不当一整段文本。\`tracing::error!(code = err.code(), retryable = err.is_retryable(), error = %err, "request failed")\` 让告警按 \`code\` 分组。同一 \`code\` 的突发才是事故；\`Display\` 里每次不同的 id 会把告警系统打成「全是独一无二的错误」。correlation id / trace id 进响应，原文进日志。用户看到「请求失败，id=…」，运维用这个 id 把链捞出来。不要让用户看到 \`Os { code: 2, kind: NotFound, message: "No such file or directory" }\`——这既泄漏又无用。

\`From\` 实现的方向只能是「更底层 → 更靠近领域」。\`From<StoreError> for anyhow::Error\` 可以；\`From<anyhow::Error> for StoreError\` 几乎永远不该有，因为它在用被擦掉的类型重建决策，只能变成 \`Other\`。一旦有 \`Other(anyhow::Error)\`，调用方又回到字符串协议。胶水层用 \`map_err\` 显式写转换，比双向 \`From\` 诚实。孤儿规则会阻止你给外部类型实现外部 trait，这是好事——转换函数放在你的适配层，名字叫 \`to_http\` / \`to_store_error\`，审查时能搜到。

panic hook 和错误处理是另一条边。\`std::panic::set_hook\` 把 panic 打进 tracing，便于任务 panic 时留下字段。hook 里不要做重 IO、不要抢可能已经损坏的锁。\`catch_unwind\` 只包你能恢复的半径：单个请求的处理函数可以包，进程级的运行时初始化不要包。包了却在半初始化的全局上继续，比崩掉更糟。FFI 边界必须包，那是正确性；请求边界可选包，那是隔离。两者不要用同一套「全能 hook」糊弄过去。

测试策略按层：单元测试覆盖每个变体的 \`Display\`、\`source\`、\`http_status\`、\`is_retryable\`。属性测试随机生成嵌套的 \`From\` 转换，断言链上总能找到某类 source。集成测试注入真实的 IO 失败（文件权限、连接重置、超时），看边界映射而不是看 mock 返回的字符串。没有失败注入的测试套件，等于只测了 \`Ok\` 路径，错误类型写得再精致也是没上过战场。

错误与日志级别的映射要稳定。可预期的客户端错误（4xx 对应的那些变体）走 \`warn\` 或 \`info\`，否则一次扫描器就能把错误率和 on-call 打爆。真正的内部故障（磁盘满、对端协议破坏、不变量破）走 \`error\`。取消和断开走 \`debug\`。级别写在变体旁边，和 \`http_status\` 一起测。谁在 handler 里一律 \`error!(%e)\`，谁就把这个表作废。采样：高频的 \`NotFound\` 可以记计数不记全文，低频的 \`Io\` 记全文加链。存储和检索成本是错误处理的一部分，不是运维以后再想的事。

\`must_use\` 用在返回 \`Result\` 的函数上，防止调用方丢弃失败。\`let _ = foo();\` 是显式忽略，评审要问为什么。异步函数返回的 future 本身也是 \`must_use\`，不 await 也不 spawn 的 \`do_x();\` 是「以为执行了其实没执行」。这不是错误类型的问题，但症状一样：失败路径从未存在。clippy 的 \`unused_must_use\`、\`let_underscore_future\` 应当在 workspace lints 里打开。

领域错误不要继承基础设施的分类法。\`io::ErrorKind::NotFound\` 是内核的「没有这个文件」；业务的 \`NotFound\` 是「没有这个用户」。中间层把前者翻译成后者必须显式，因为「配置文件缺失」不该变成 HTTP 404 给终端用户。翻译发生的位置就是反腐败层。测试这个翻译：临时文件删掉，断言返回的是 500 或启动失败，而不是 404。分类看起来相同、语义不同，是错误设计里最阴险的一类。

版本演化时，旧客户端可能不认识新 \`code\`。公开 API 加变体要么 major，要么 \`non_exhaustive\` 加 \`Unknown\` 兜底。线协议上的错误码用稳定整数或短字符串，不要用 Rust 枚举的 Debug 名。Debug 名重构时会变，客户端的 \`if code == "StoreError::NotFound"\` 会静默失效。\`code() -> &'static str\` 的字符串是协议，改它等于改 API。文档和 changelog 要当协议变更来写。

错误类型一旦进入 \`match\`、重试器和告警分组，再合并变体或改 \`code()\` 字符串就是协议破坏。内部改名只动 Rust 标识符，\`code()\` 不要用 \`stringify!\` 偷懒。第三方错误直接出现在公开枚举里，等于公开 API 绑死那个 crate 的版本——包一层。收的时候问：调用方会不会对这个底层失败做出不同反应、要不要 source 链、会不会把对岸细节冻成我们的 API。三个都否就 \`Internal\` 加 source。
\`map\` / \`and_then\` 长链的失败点只能靠 backtrace，\`panic = abort\` 时可能没有展开。生产优先 \`?\` 加少量 \`match\`。启动期缺配置应当让进程非零退出，请求期同样的 IO 失败返回 503。把启动期 \`expect\` 抄到请求路径，坏请求会把探针打死；把请求期「记日志继续」用到启动期，你会带着半初始化全局跑。分界就是 \`run().await\` 之前和之后。
SLO 若说 5xx 低于千分之一，枚举必须能区分 4xx 和 5xx。校验失败算进 5xx，SLO 永远达不到，然后有人放宽阈值，真故障一起被放宽。映射表是 SLO 的实现。客户端错误走 warn/info，内部故障走 error，取消走 debug，和 \`http_status\` 一起测。高频 NotFound 记计数不记全文。\`must_use\` 防止丢弃 \`Result\`；异步函数不 await 也不 spawn 是另一类「失败路径从未存在」。
领域 \`NotFound\` 不是 \`io::ErrorKind::NotFound\`。配置文件缺失翻译成给用户的 404，是分类看起来相同、语义不同。翻译发生在反腐败层，用注入真实 IO 失败的测试钉住。

## 12. 小结

错误处理的原理是 **类型保留决策权**。谁能决策（重试、404、补偿），谁就拿具体 \`E\`；谁只负责汇报，谁就在边界 \`context\` 收口。\`unwrap\` 是断言不变量，不是快捷方式；字符串不是协议；常态失败不是 panic。

库用 \`thiserror\` 把反应不同的失败写成变体，应用用 anyhow 或一层 \`match\` 把变体变成状态码和日志字段。

一个可以立刻落地的检查表：公开 crate 的 \`E\` 能不能被 \`match\`；应用边界有没有把 source 链留下；请求路径有没有 \`unwrap\`；映射表是否每个变体都有测试；取消和客户端断开有没有被当成 ERROR。五项里有一项否，错误处理就还停留在「我们用了 thiserror」的口号上。口号过不了 on-call。错误处理做完的标志，是一次故障里你能用 code 分组、用字段检索、用映射表解释为什么是 503 而不是 500。做不到这三件事，类型写得再漂亮也还没进生产。

下一篇跨过语言边界：C ABI 上没有 \`Result\`，也没有 panic 的合法通道，所有权必须写在注释和安全封装里，再由类型在 Rust 这一侧重新闭合。

如果只能带走一条：把错误当成公开 API 来做 code review。变体是不是对应不同反应、code 会不会随文案改、请求路径有没有 unwrap、取消有没有被记成 ERROR。这四问比「我们要不要换 snafu」更接近事故。换框架不修分层，分层错了换什么都是字符串协议。
`,

  "rust-ffi-and-c-abi-boundaries": `把 \`unsafe\` 理解成「关掉借用检查器的开关」会在 FFI 边界上立刻失效。\`unsafe\` 只是把几条编译器不肯帮你证明的契约交给人：指针有效、别名不打架、调用约定一致、生命周期在对岸仍成立。C 不承认 \`Result\`，不承认 \`Drop\`，不承认 panic 展开。两边能对话，是因为同意了同一套 **ABI**（二进制接口）：参数怎么放寄存器、结构体怎么垫字节、谁分配谁释放。写错的不是风格问题，是未定义行为，症状可以隔着几秒、几条线程才出现。

这篇文章只讲这条边界：哪些类型能过 C ABI、所有权如何交接、panic 为什么不能穿越、安全封装该有多厚。读完你应该能独立回答三个问题：为什么不能把 \`Vec<u8>\` 直接扔给 C、\`catch_unwind\` 包的是哪一层、一块由 Rust 分配的缓冲凭什么必须由 Rust 释放。

## 1. ABI 是合同，不是源码兼容

两个编译单元能互相调，靠的不是头文件看起来像，是生成的机器码对「第几个参数在哪个寄存器、返回值怎么回来、栈谁清」意见一致。\`extern "C"\` 选用平台的 C 调用约定。\`extern "Rust"\` 是 Rust 自己的，不稳定，不能当跨语言合同。\`#[no_mangle]\` 关掉名字修饰，让 C 能按符号名找到函数。没有它，链接器看到的是一串哈希过的 Rust 符号，C 侧 \`extern void foo()\` 会 undefined reference。

类型布局是合同的另一半。Rust 默认 \`repr(Rust)\`：字段顺序、填充、判别值都可以被编译器重排，为了对齐和空间。这个布局**没有**跨编译版本的保证，更没有对 C 的保证。要过边界，结构体必须 \`#[repr(C)]\`，枚举若要当 C 的整数必须 \`#[repr(C)]\` 或 \`#[repr(u32)]\` 并确认无 payload，或者干脆不要把带数据的枚举传过去。

\`\`\`rust
#[repr(C)]
pub struct FrameHeader {
    pub len: u32,
    pub flags: u16,
    pub ty: u8,
    pub _pad: u8,
}

#[no_mangle]
pub extern "C" fn frame_header_size() -> usize {
    std::mem::size_of::<FrameHeader>()
}
\`\`\`

\`_pad\` 写出来是为了和 C 头文件的填充对齐，并提醒读代码的人：这里的空洞是合同的一部分。用 \`#[repr(C, packed)]\` 能去掉填充，但未对齐访问在部分架构上是 CPU 异常，在 x86 上只是慢。除非硬件协议逼你 packed，否则用显式填充字段，两边 \`sizeof\` 用测试钉死。

胖指针过不了 C ABI。\`&[u8]\`、\`&str\`、\`dyn Error\`、\`Box<dyn Trait>\` 都是「指针 + 长度或 vtable」。C 的 \`char*\` 只有指针。你传 \`&str\` 当 \`*const c_char\`，对岸会把长度字段当成地址去解引用。这是 FFI 里最常见的一类静默内存破坏。切片必须拆成 \`ptr + len\` 两个整数参数；字符串必须变成以 \`\\0\` 结尾的 \`CString\`，或同时传长度。

## 2. 能过边界的值和绝对不能过的值

能过：整数、\`f32\`/\`f64\`、\`bool\`（作为 1 字节时要和 C 的 \`_Bool\` 确认）、裸指针、\`repr(C)\` 且字段也全是能过的结构体、函数指针（\`extern "C" fn\`）。\`Option<extern "C" fn()>\` 在 Rust 里和可空函数指针同布局，这是少数几个稳定保证。\`Option<NonNull<T>>\` 同理。

不能过：\`Vec\`、\`String\`、\`HashMap\`、\`Rc\`/\`Arc\`（除非只传裸指针并放弃安全）、带生命周期的引用（对岸没有 \`'a\`）、带 Drop 胶水的类型（对岸不会在栈展开时跑你的析构）。\`String\` 的内部是指针、长度、容量三个字；C 的 \`char*\` 只有一个。即便你把 \`as_ptr()\` 给了 C，容量和所有权仍在 Rust 这边——C 若 \`free\` 这个指针，分配器就进错堆。

整数宽度要写死。Rust 的 \`usize\`/\`c_int\`、C 的 \`int\`/\`long\`/\`size_t\` 在 LP64 和 LLP64 上不是同一套。Windows 的 \`long\` 是 32 位，Linux x86_64 是 64 位。跨平台 FFI 用 \`i32\`/\`u32\`/\`u64\` 和 \`*mut u8\` 加 \`usize\` 长度，不要用 \`c_long\` 当「够大的整数」。回调里的 \`size_t\` 对 \`usize\`。

布尔和枚举：C 的 \`enum\` 宽度实现定义。不要把 Rust \`enum\` 直接当 C \`enum\` 用，除非 \`repr(u32)\` 且 C 侧也固定为 \`uint32_t\`。标志位用独立的 \`u32\`，不要用 bitfield 结构体——两边编译器的 bitfield 布局几乎一定拧。

## 3. 所有权交接：谁分配，谁释放，长度的单位是什么

边界上每一块内存都要能回答三问：谁 \`alloc\`、谁 \`free\`、长度是字节还是元素。混用 Rust 全局分配器和 libc \`malloc\` 是未定义的。Rust 分配的 \`Vec\` 必须 \`Vec::from_raw_parts\` 回来再 drop；C \`malloc\` 的必须 \`libc::free\`。不要「看起来都是堆」就互相释放。

长度单位写进函数名和头文件：\`foo_write(ptr, len_bytes)\` 而不是两个都叫 \`n\`。元素数组过边界要同时约定元素大小和对齐。C 侧用 \`sizeof(*ptr)\`，Rust 侧用 \`size_of::<T>()\`，CI 里用一个导出函数返回 \`size_of\` 让 C 测试来比。单位错一次，就是按元素数当字节数去 \`from_raw_parts\`，分配器在远方崩溃。
只读借出和移交所有权不要用同一个函数。\`foo_view\` 约定调用期间指针有效、返回后失效；\`foo_take\` 约定对岸负责 free。文档和符号名都要分开。一个函数「有时借有时给」是双重释放和 UAF 的温床。Rust 侧对应两个安全函数：一个收 \`&[u8]\`，一个收 \`Vec<u8>\` 并 \`forget\`。
错误返回时已经分配的资源要回到安全封装的 Drop，而不是在 \`extern "C"\` 里手写五路释放。失败路径最容易漏。把已经移交的指针先放进一个本地的 \`CBuf\`，成功时 \`mem::forget\` 再把裸指针返回，失败时让 \`CBuf\` 析构。这是 RAII 在边界上的最后一次发挥作用。
对外函数的线程模型写进头文件：可重入否、可并发否、是否要求同一线程。Rust 的 \`Send\` 只在安全侧生效。C 调用约定里没有 \`Send\`，你只能用文档和 debug 断言。生产上曾经「单线程用好好的」库被丢进 Tokio 阻塞池，第一次并发就在 C 的全局状态上毁掉。这不是 Tokio 的错，是 FFI 合同没写线程。

典型的 Rust 拥有、借给 C 看：

\`\`\`rust
use std::os::raw::c_char;
use std::ffi::CString;
use std::ptr;

#[no_mangle]
pub extern "C" fn rust_version() -> *const c_char {
    static S: &str = "1.0.0\\0";
    S.as_ptr() as *const c_char
}

#[no_mangle]
pub extern "C" fn copy_to_c(src: *const u8, len: usize) -> *mut u8 {
    if src.is_null() {
        return ptr::null_mut();
    }
    let slice = unsafe { std::slice::from_raw_parts(src, len) };
    let mut v = slice.to_vec();
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn buffer_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    unsafe { drop(Vec::from_raw_parts(ptr, len, len)); }
}
\`\`\`

\`copy_to_c\` 把所有权放弃给对岸（\`forget\` 免得 drop），并要求对岸稍后用 \`buffer_free\` 还回来。长度参数必须是当时的 len，且 cap 在这个简化例子里被当成等于 len——如果你 \`reserve\` 过，必须把 cap 也传出去，否则 \`from_raw_parts\` 用错容量会在 dealloc 时毁掉分配器。**三个字一起走：ptr、len、cap。** 合同写进头文件，最好写成一个 \`repr(C)\` 结构体一次传。

C 拥有、Rust 只借：函数期间指针有效，返回后 Rust 不再碰。把这个写进文档和安全封装的生命周期——安全侧应当是 \`fn with_c_buf(buf: &[u8], f: impl FnOnce(*const u8, usize))\`，让 \`&\` 的寿命盖住整个回调。不要把 C 指针存进全局再在下次请求用。

空指针：C 用 \`NULL\` 表示可选。Rust 侧立刻检查 \`is_null()\`，再 \`slice::from_raw_parts\`。\`from_raw_parts(null, 0)\` 在当前实现里对零长度常常能忍，但规范要求指针非空或来自正确分配；用 \`NonNull\` 或显式分支，不要靠实现细节。

## 4. panic 不能过边界，异常也不能

Rust panic 默认栈展开，跑 drop。C 没有对应的展开表来配合 Rust 的 landing pad。panic 穿过 \`extern "C"\` 是未定义行为：可能直接 abort，可能把 C 的栈拆烂，可能在几帧之后才崩。C++ 异常穿过 Rust 同理。合同是：**边界上的函数要么正常返回，要么返回错误码，绝不抛。**

正确形状：对外函数 \`catch_unwind\`，把 panic 变成错误码或记日志后返回。\`AssertUnwindSafe\` 要审：闭包里如果改了一半状态，catch 之后那半状态仍然坏着。能 catch 不等于能恢复。服务进程里对外 FFI 失败后，优先把这个会话丢弃，而不是继续在半初始化对象上跑。

\`panic = abort\` 的二进制里没有展开，panic 直接杀进程。

这对纯 Rust 服务常常正当：不变量破了，展开过程本身可能再坏。嵌进别人进程的 \`cdylib\` 则相反——你的 assert 不该带走宿主。所以同一份库代码面对两种最终二进制时，对外 \`extern "C"\` 仍然必须 \`catch_unwind\`：在 unwind 的宿主里它把 panic 变成错误码，在 abort 的宿主里它几乎不会被走到，但源码同一份。不要用 \`cfg\` 把 catch 去掉图省事，那会让库在两种产品里行为分叉。
边界上返回错误码的同时，用 thread-local 或显式 out 参数留下最近一次 panic 的消息，方便宿主打日志。消息要在 catch 时立刻格式化成拥有的 \`String\` 或固定缓冲，不要把 \`&str\` 指向已经在展开中死去的栈。长度截断，编码 UTF-8，宿主用你提供的 free 释放。
这对纯 Rust 服务常常是正当的（见构建篇）；对嵌进别人进程的 cdylib 通常不正当——你的 assert 不该带走整个 Python/Java/游戏引擎。嵌入学库用 \`catch_unwind\` + 明确的 abort 策略文档。测试里用 \`should_panic\` 测内部不变量，用 C 测试程序测边界返回码，两套都要有。

从 C 调回来的回调里，Rust 若 panic，同样炸。回调是另一条边界。给 C 的函数指针必须是 \`extern "C" fn\`，内部再 \`catch_unwind\`。不要把 Rust 闭包直接当 C 函数指针——环境指针要自己做成 \`userdata: *mut c_void\`，类型擦除，回来再转，并证明 C 不会在 userdata 释放之后还调。

## 5. 安全封装：unsafe 的半径等于边界的厚度

公开 API 应当是安全的。\`unsafe\` 只出现在 \`mod ffi\` 或 \`unsafe fn\` 的薄薄一层，外面用类型把契约重新闭合：

- 指针变成 \`&[u8]\` / \`&mut [u8]\` / \`NonNull\` 包在结构体里，构造函数检查对齐和空。
- C 资源变成带 \`Drop\` 的句柄，\`Drop\` 里调 C 的 free。不要让用户手动配对。
- 错误码变成 \`Result\`。不要把负数 errno 当成功路径上的 usize 返回。
- 线程约定写成 \`Send\`/\`Sync\` 或显式不实现。C 库若要求「只能在创建它的线程上用」，句柄就不要 \`Send\`。

\`\`\`rust
pub struct CBuf {
    ptr: *mut u8,
    len: usize,
}

impl CBuf {
    pub fn as_slice(&self) -> &[u8] {
        if self.ptr.is_null() {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(self.ptr, self.len) }
        }
    }
}

impl Drop for CBuf {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe { buffer_free(self.ptr, self.len); }
        }
    }
}

unsafe impl Send for CBuf {}
unsafe impl Sync for CBuf {}
\`\`\`

这里 \`Send\`/\`Sync\` 是一句声明：你认为对岸的缓冲可以跨线程读。如果 C 库内部有线程局部，这句声明就是漏洞。\`unsafe impl\` 必须写在紧挨着的注释里：凭什么。没有注释的 \`unsafe impl Send\` 在代码评审里应当直接打回。

封装还要处理重入。C 回调里再进 Rust，Rust 再调 C，锁顺序会和纯 Rust 时不同。文档写明「这个回调里不能再调 xxx」。能用类型禁止的就禁止：把回调期间的句柄做成 \`&CallbackCtx\`，不提供会重入的 \`&mut\` 方法。

## 6. 字符串、编码、路径

C 字符串是 \`\\0\` 结尾的字节，编码经常是「本地」或「我也不知道」。Rust 的 \`String\` 是 UTF-8。\`CString::new\` 会在内部发现 \`\\0\` 时失败——二进制数据不是 C 字符串。路径在 Windows 上是 UTF-16，在 Unix 上是任意字节。\`CString\` 从 \`Path\` 转，在 Windows 上会走有损或宽字符 API，必须选对 \`u16\` 版本。

不要把 \`String::as_ptr()\` 给 C 当 C 字符串：Rust \`String\` 不保证尾随 \`\\0\`，也不保证之后没人改它。需要 \`CString\`，并保证 C 用完之前 \`CString\` 还活着。返回给 C 的字符串要么静态，要么堆分配并给 free 函数，要么拷进调用方提供的缓冲（带长度，返回写入的字节或截断标志）。第三种最不容易泄漏，也最麻烦，嵌入式和系统 API 常用。

日志和错误信息过边界，优先错误码 + 调用方自己格式化。传堆上的错误字符串就要规定谁 free，还要规定编码。少一条合同，就多一次 double-free 或乱码。

## 7. 异步、运行时和 FFI 合不来的那部分

C 函数默认是同步、阻塞、不知道 Waker。在 Tokio worker 上调一个可能堵 200ms 的 C 压缩库，效果和 \`std::fs::read\` 一样：偷走 worker。规则不变：可能阻塞的 FFI 进 \`spawn_blocking\`，并且取消听不到——见调度那篇。

反过来，把 Rust async 暴露给 C：C 没有 \`await\`。常见做法是完成回调（\`userdata + extern "C" fn(code, *mut u8, usize)\`），或 C 侧提供的 event loop 注册 fd。把 \`Waker\` 塞给 C 几乎总是错的——Waker 是 Rust runtime 的对象，C 不知道怎么 \`clone\` 和 \`wake\`。要接，就在 Rust 侧保持任务活着，C 只在 fd 就绪时调一个 \`extern "C"\` 入口，入口里 \`waker.wake()\`。所有权：Waker 必须活到 wake 之后或明确取消。

不要在 \`extern "C"\` 里 \`Runtime::block_on\`。嵌套 runtime、死锁、和调用方已有的事件循环打架，三位一体。库若需要异步，把 runtime 句柄作为初始化参数传进来，或只提供同步 API 让调用方自己绑。

## 8. 构建：cdylib、cbindgen、头文件测试

\`crate-type = ["cdylib"]\` 产出 C 能 \`dlopen\` 的动态库。\`staticlib\` 给 C 静态链。符号默认除了 \`#[no_mangle] pub extern "C"\` 都该隐藏，避免把 Rust 标准库内部符号漏出去撞车。\`#[no_mangle]\` 太多等于没有命名空间，前缀用项目名。

头文件用 \`cbindgen\` 从 Rust 生成，或手写后用测试比较 \`sizeof\`/\`offsetof\`。生成物进版本控制还是 CI 生成，选一个：进版本控制能 review ABI 变化；CI 生成能防手改头文件和源分叉。ABI 变化是 breaking，该打版本号，不能只当内部重构。

测试不能只测 Rust 侧。最小 C 程序或 \`cc\` crate 编一个 C 文件来调导出函数：空指针、零长度、错误码、free 两次（第二次应是安全的 no-op 或明确 abort，不要静默把堆打烂）。Miri 测不了真实 C，但能测你封装里那些 \`from_raw_parts\` 的 Rust 侧。AddressSanitizer 对边界另一侧特别有用，CI 里至少一条 asan 构建。

## 9. 取舍：直接 FFI、bindgen、cbindgen、 Diplomat、protobuf

手写 \`extern "C"\` 最薄，适合五个函数的小边界。函数一多，类型容易和头文件分叉。\`bindgen\` 从 C 头生成 Rust，适合吃现成 C 库；生成代码脏，要在 build.rs 里收白名单，不要把整份 POSIX 头吸进来。\`cbindgen\` 反向，适合 Rust 做实现、C 做宿主。

更厚的工具（ Diplomat、cxx、UniFFI）用代码生成维持两边类型，减少手写 \`repr(C)\`。代价是构建图变复杂、调试要看生成物、不是所有类型都能表达。对象生命周期仍要人想清楚：生成器不会把「谁 free」变成魔法。

protobuf / FlatBuffers 是另一条路：不共享内存，只共享序列化合同。拷贝换来版本演化和语言无关。热路径上的共享内存 FFI 更快，也更脆。先问这份边界是不是性能关键、是不是同进程。同进程且热，FFI；跨进程或要演化，用字节协议。不要用 FFI 模拟 RPC，也不要用 RPC 模拟一次函数调用。

## 10. 排障：崩在对岸、泄漏、双重释放、偶然能跑

1. **崩在 C 里、栈上全是 \`??\`。** 先查 ABI：\`repr(C)\` 丢了、参数顺序、调用约定（stdcall vs C）、32/64 位混链。再查字符串是否缺 \`\\0\`、切片是否把胖指针当瘦指针传。
2. **双重释放或分配器断言。** 两边都认为自己该 free。画一次所有权：每个指针从出生到死亡只出现一个析构。\`forget\` 和 \`from_raw_parts\` 必须成对。
3. **泄漏。** 只 \`forget\` 不 free；C 回调里分配的 Rust 对象没人 drop；panic 在 catch 之外提前返回忘了释放已经移交的指针。失败路径用 \`defer\` 式的 RAII 封装，不要在 \`extern "C"\` 里手写五路 \`goto cleanup\` 而不包类型。
4. **偶然能跑。** 未定义行为的典型。优化级别一变、多一个字段、换了 allocator 就炸。用 asan/valgrind/Miri 抓，不要用「多试几次」。
5. **死锁。** C 持锁调进 Rust，Rust 再调回 C 抢另一把锁。把回调能调的子集写进文档，最好写成窄 trait。
6. **\`Send\` 过宽。** 句柄被 spawn 到别的线程，C 库内部炸。去掉 \`unsafe impl Send\`，用类型把句柄钉在线程上，或在文档和运行时检查线程 id。

版本：C 库用 \`SONAME\` 和符号版本；Rust 侧 \`links\` 键让 Cargo 拒绝链两份。同一进程链两份 openssl 的事故足够多。\`pkg-config\` 和 vendored 特性要在工作区里统一，见构建篇。

## 11. 和所有权模型如何重新闭合

FFI 并没有废除所有权，它只是在边界上把证明交给人。过了边界，立刻用安全类型把三条不变量捡回来：单一所有者（\`Drop\` 句柄）、别名（切片而不是到处飞的裸指针）、寿命（回调期间借用，不存全局）。\`unsafe\` 块应当短到可以在脑子里模拟执行，并且有相邻的注释写明假设。假设在 C 侧文档改版时会过期——封装测试要当合同测试来跑。

合同测试至少包括：空指针、零长度、最大长度、错误码、free 两次、错误路径是否释放已分配资源、回调恰好一次。C 小程序或 \`cc\` 编出来的测试和 Rust 侧 Miri 互补：Miri 看不到真正的 C，C 测试看不到 Rust 的别名模型。两边都绿，才敢说边界闭合。缺一边，就是在用「目前没崩」当证明。


跨语言的错误用整数码，再在 Rust 侧变成 \`thiserror\` 枚举。不要把 C 的 \`errno\` 直接泄漏给上层业务。这和错误处理那篇的反腐败层是同一位置，只是对岸从「另一个 crate」换成了「另一种语言」。

对齐和端序是 ABI 合同里最容易被「能跑」掩盖的部分。\`repr(C)\` 按 C 规则对齐：\`u8\` 后面跟 \`u32\` 会垫 3 字节。Rust 侧用 \`offset_of!\` 和 C 侧 \`offsetof\` 写成测试，在 CI 里对每个过边界的结构体跑一遍。端序：网络协议大端，Intel 小端，整数过 FFI 若两边各解一次，中间不要再 \`to_be_bytes\` 一次。把「谁负责换端」写进函数名：\`write_u32_be\` 比 \`write_u32\` 诚实。

回调里的重入和锁构成死锁温床。C 库在持有内部锁时调你的 \`extern "C"\` 回调，回调里再调这个库的另一个函数，对方再抢同一把锁——经典。Rust 侧看起来只是「在回调里调了一个安全封装」。封装必须文档化：哪些函数在回调中禁止。更好的形状是回调只 \`try_send\` 到有界队列，真正的工作回到 Rust 任务里做，那时 C 库的锁已经释放。这和异步篇、背压篇又接上：FFI 回调是不能阻塞、不能重入的生产者。

动态加载（\`dlopen\` / \`libloading\`）比直接链接多一个失败模式：符号缺失、版本不匹配、两个库各带一份 allocator。不要跨 \`dlopen\` 边界传递 \`Box\` 或 \`Vec\`——两边的 drop 可能链到不同的 jemalloc。只传 C 认识的布局，释放函数和分配函数从**同一份**动态库导出。插件 ABI 用版本号握手，先调 \`plugin_abi_version()\`，不对就拒绝加载，不要在第一次业务调用时 SIGSEGV。

和 Python/Java/Go 的边界常常不是手写 \`extern "C"\`，而是一层生成器：PyO3、JNI、cgo。生成器替你做了一部分 ABI 和转换，但所有权问题一个都没消失。PyO3 的 \`PyBuffer\` 在 Python 对象活着时指向它的内存，你不能把切片 \`spawn\` 到 Tokio 任务里再回去释放 GIL——寿命绑在 GIL 和对象上。JNI 的 \`jbyteArray\` 可能被 JVM 搬走，\`GetByteArrayElements\` 有的实现会拷贝。Go 的 \`cgo\` 有自己的栈和 P，回调进 Rust 再进 Go 的开销和重入规则更严。选生成器是为了少写样板，不是为了少想寿命。每一层仍然要回答：这块内存现在算谁的，跨过这次调用之后还能不能碰。

WASM 是另一种 ABI：线性内存、\`wasm32\` 指针是 32 位偏移，不是宿主指针。\`extern "C"\` 在 wasm 里仍然有效，但 \`Vec\` 的指针传给宿主必须先放到线性内存里，宿主看到的是偏移。\`wasm-bindgen\` 用生成代码藏这件事，失败模式变成 JS 侧的类型错误，而不是 SIGSEGV。宿主和 wasm 之间不要共享原生锁；各自的运行时、各自的分配器。\`panic = abort\` 在 wasm 里往往更干净，因为展开表贵而且和 JS 异常模型合不来。

安全性：FFI 是攻击面。对岸传来的长度当 \`usize\` 用之前检查溢出和上限；传来的指针要非空、对齐、且你有理由相信指向的是约定的对象（不透明指针用 cookie 或世代号防 UAF）。不要把 Rust 的 \`enum\` 判别值暴露成 C 可以随便写的整数再 \`transmute\` 回来——非法判别值是未定义行为。用 \`repr(u32)\` 加显式 \`match\`，未知值当错误码。签名校验、版本握手、把 \`unsafe\` 留在薄层，这些比在业务里写「C 侧保证合法」有用。C 侧保证在恶意输入或内存损坏之后不成立。

不透明指针是跨语言对象的正当形状。Rust 侧 \`Box::into_raw\` 把所有权交给 C 当 \`*mut Foo\`，C 只保存和传回，不解读内存。方法都是 \`extern "C" fn foo_bar(p: *mut Foo, ...)\`，第一件事检查空，转回 \`&mut Foo\`。销毁函数 \`foo_free\` 里 \`drop(Box::from_raw(p))\`。不要给 C 一份 \`repr(C)\` 的内部字段让它自己改——字段一加，ABI 就破。不透明指针的 ABI 是指针宽度，稳定得多。文档写明线程：这个 \`*mut Foo\` 是否 \`Send\`。C 不会帮你 \`Send\` 检查，把句柄做成只能通过函数用，并在 debug 构建里用线程 id 断言。

\`cbindgen\` 生成的头文件要当制品来 review。结构体字段顺序、\`#include\`、\`#ifdef __cplusplus\` 的 \`extern "C"\` 包裹，少一层就会在 C++ 里被名字修饰。生成配置里把 \`usize\` 映射成 \`size_t\`，把 \`u8\` 映射成 \`uint8_t\`，不要让 cbindgen 写出 \`unsigned long long\` 这种在 Windows 上拧的类型。CI 比较生成头和仓库里的头，不一致就失败——这是 ABI 回归测试。人 review 的是「这次差异是不是一次 breaking」。

和信号安全、fork、allocator 的交叉很少写进教程，但会在生产里炸。\`malloc\` 在持锁时进程被信号打断，信号处理函数里再进 Rust 分配，死锁。fork 之后只安全 \`async-signal-safe\` 的调用，Rust 的全局分配器和锁几乎都不是。嵌入到会 \`fork\` 的宿主（某些 web 服务器、语言运行时）时，初始化要在 fork 之后，或彻底避免在 FFI 里碰锁和堆。这些约束写进封装的安全文档，而不是等 hang 了再猜。

不透明指针比暴露 \`repr(C)\` 字段稳：\`Box::into_raw\` 交给 C，方法都是 \`foo_bar(p, ...)\` 先查空再转 \`&mut\`，销毁 \`from_raw\` 恰好一次。字段一加 ABI 就破；指针宽度当 ABI，稳定得多。debug 构建用线程 id 断言「只能在创建线程上用」，C 不会帮你做 \`Send\` 检查。
Windows 上多个 CRT 各有 malloc，Debug/Release 也不能混。Linux 上静态 jemalloc 的 Rust 和 glibc 的 C 同样不能互相 \`free\`。释放函数和分配函数来自同一模块，符号写成 \`foo_alloc\` / \`foo_free\`。
回调 userdata 是类型擦除的所有权。完成回调可能零次、一次、两次。封装用 \`Option<*mut T>\` 第一次 \`take\`，第二次空操作并打日志。测试覆盖成功、失败、取消三条路径恰好一次释放。
信号处理函数和 fork 之后几乎不能进 Rust 堆和锁。嵌入会 fork 的宿主时，初始化放 fork 之后，或避免 FFI 里碰锁。union 过边界除非硬件逼你，tag 和 payload 必须一起传，合法 tag 集合用生成代码两边共享。\`cbindgen\` 头文件当制品 review，CI 比较生成结果，\`usize\` 映射成 \`size_t\`，C++ 包裹 \`extern "C"\`。

## 12. 小结

FFI 的原理是 **ABI 合同 + 所有权交接 + panic 隔离**。能过边界的是 C 认识的瘦类型；\`Vec\`/\`String\`/胖指针必须拆。分配和释放同一边负责。\`unsafe\` 的半径等于边界的厚度，越薄越好，外面用 \`Drop\` 和 \`Result\` 重新变成 Rust。下一篇回到异步管道内部：Stream 的拉取节奏，以及没有背压时内存如何先于 CPU 爆炸。

落地时从最小边界做起：先把导出函数缩到五个以内，每个函数写明指针空值、长度单位、谁 free、线程、错误码。五个函数的合同能写清，五十个才能复制。合同写不清就不要加第五十一个。\`unsafe\` 行数不是勇气指标，是需要人证明的表面积。表面积越大，Miri 和 asan 越难罩住。每加一个导出函数，先加一条 C 测试再合入。没有对岸测试的 FFI，只是在 Rust 侧自己和自己玩。对岸测试不过，等于合同没签字。签字之前不要把符号暴露给生产宿主。合同测试不过关，就还没有 FFI，只有一堆未定义行为的入口。



`,

  "rust-async-stream-and-backpressure": `把 \`Stream\` 理解成「异步版的 \`for\` 循环」会在生产管道里立刻失效。迭代器是拉取的：下游不 \`next\`，上游不生产。\`Stream\` 同样是拉取的：下游不 \`poll_next\`，上游不该把数据推进内存里堆着。很多包装看起来像在「处理流」，实际上在 \`buffer\`、\`collect\`、无界 channel 里把拉取变成了无限推送。CPU 还没忙过来，RSS 先到顶。

这篇文章只讲异步管道的节奏：\`poll_next\` 如何把控制权交给下游、有界队列和并发上限如何把内存钉死、慢消费者时该阻塞、丢弃还是断开。读完你应该能独立回答三个问题：为什么 \`collect::<Vec<_>>().await\` 等于取消背压、\`buffer_unordered(n)\` 的 \`n\` 限制的是什么、通道满了却还在 accept 的服务会先死在哪。

## 1. 背压是「不 pull 就不生产」，不是再开一个缓冲区

TCP 自己有窗口：接收方窗口缩小，发送方就慢下来。应用层管道常常把这个性质弄丢——中间用无界队列「解耦」，等于告诉上游：你能造多快造多快，我用内存当窗口。窗口一旦变成堆，背压就从「让生产者等待」变成「让 OOM killer 等待」。

有界才是默认。界可以是：channel 容量、\`ready_chunks\` 的块大小、信号量许可数、\`buffer_unordered\` 的 in-flight 数、连接 accept 的 backlog。界的单位要选对：按条数在大消息下会炸内存，按字节数在小消息下会让并发过低。生产里常常两个都要：最多 N 条 **且** 最多 M 字节。

缓冲的正当用途是平滑抖动：下游偶发 2ms 的停顿，上游不必每次都卡住 syscall。缓冲深度按「抖动 × 速率」估，再加很小的余量。按「尽量不让上游等」来设，你会得到一个事实上无界的队列，只是有一个永远达不到的数字写在配置里。

丢弃也是一种背压应答，但必须显式：度量丢弃率、决定丢最旧还是最新、让调用方能感知（计数器、标志位、关闭）。静默 \`try_send\` 失败后 \`continue\`，等于把丢失写进产品行为却不告诉任何人。

丢最旧还是最新取决于项的时效。行情、指标、位置：最新更有价值，队列满时丢掉队头。审计、支付、复制日志：每一项都有价值，不能丢，只能等或断。用错策略比没有背压更危险——你以为系统在保护自己，其实在丢不可丢的东西。策略写进类型或配置枚举，不要写进某次代码评审的口头同意。
有界队列的「等」要有超时。永远等会在下游死掉时把上游全部挂起，最后从入口开始连不上。超时后走丢或断，并打点。超时时间小于客户端超时，才能让调用方收到明确错误而不是自己先放弃。这三层超时（应用等队列、客户端等你、编排等进程）必须排好序，乱序会出现重试风暴。


## 2. Stream 的 poll 节奏由下游决定

\`Stream\` 的核心是 \`poll_next(self: Pin<&mut Self>, cx) -> Poll<Option<Item>>\`。返回 \`Pending\` 时必须登记 Waker；返回 \`Ready(Some)\` 是一项；\`Ready(None)\` 是结束。下游的 \`while let Some(x) = s.next().await\` 就是在循环 poll。下游去干别的、不 poll 你，你的 \`poll_next\` 根本不会被调用——这就是背压的机械来源。

对比 \`Sink\`：\`poll_ready\` 问下游能不能再收，\`start_send\` 把项交给它，\`poll_flush\` 刷出。正确的管道是：Sink 未 ready 时，上游 Stream 不被 poll（或 poll 了也要把项留在手里）。\`forward\` 一类组合子就是在做这件事。自己手写 \`loop { let x = s.next().await; sink.send(x).await; }\` 时，\`send\` 的 await 本身就是背压；若 \`send\` 前面先 \`s.next()\` 吃了一项，这一项已经离开上游。有界的话，一项的在途通常可接受；若你先 \`ready_chunks(10_000)\` 再 send，背压的粒度就变成一万项。

\`\`\`rust
use futures::{StreamExt, SinkExt};

async fn pump<S, K>(mut src: S, mut sink: K) -> Result<(), K::Error>
where
    S: StreamExt<Item = bytes::Bytes> + Unpin,
    K: SinkExt<bytes::Bytes> + Unpin,
{
    while let Some(item) = src.next().await {
        sink.send(item).await?;
    }
    sink.close().await?;
    Ok(())
}
\`\`\`

这个循环一次只在途一项。要提高吞吐，用有界的并发，而不是先 \`collect\`。

\`FusedStream\` 防止结束后还 poll。组合 \`select!\` 时，结束的那一侧若不 fuse，会反复 Ready(None) 打转。这不是背压，是忙等。生产管道里 \`fuse()\` 是默认，不是优化。

## 3. 组合子里哪些在囤积，哪些在限制

\`futures\` / \`tokio_stream\` / \`StreamExt\` 的名字经常比行为温和：

读组合子源码里「内部缓冲」那几行，比读文档标题重要。\`buffer(n)\` 会在内部堆到 n 个已完成项；\`chunks\` 会堆到 n 项或超时；\`fold\` 会把整个流收成一个值。名字里没有 buffer 的，也可能在闭包的 \`Vec\` 里囤积——那是你自己写的。评审组合子链时，沿途把每一段的最大在途项数写在旁边，乘以每项字节，得到这条链的内存上界。写不出来的链，就是没有背压的链。
\`n\` 从配置来，不要从代码常量来，并且要有上限钳制。配置被改成 100 万时，程序应当拒绝启动或把 n 钳到预算内，而不是默默变成无界。启动时用「n × 平均项大小 × 管道条数」估 RSS，超过容器 limit 的某个比例就失败。这是把背压预算前移到部署时刻。
组合子链过长时，中间某段的错误类型被 \`map\` 丢掉，失败会从链的另一头冒出来，很难定位。宁可拆成命名的异步函数，每段有自己的 \`Result\` 和 span。调试一条匿名链的成本，通常高于多写两个函数。背压和错误处理在这里是同一条可读性要求。

- \`map\` / \`filter\`：同步、一项进一项出，不囤积。闭包里不要做重 CPU，否则堵在下游的 poll 里，等于堵 worker。
- \`then\` / \`and_then\`：对每项起一个 future，默认串行。背压仍在，吞吐受每项延迟限制。
- \`buffer_unordered(n)\` / \`for_each_concurrent(n)\`：最多 n 个 in-flight future。\`n\` 是内存和下游负载的旋钮。\`n = usize::MAX\` 或「CPU 核数乘一个拍脑袋的 32」会在下游变慢时把飞行中的请求堆成山。
- \`buffered(n)\`：有序，完成了也要等前面的，额外的完成项会停在组合子内部。有序的代价是队头阻塞。
- \`ready_chunks(n)\`：下游一次拿一批。批大小是延迟和吞吐的交换：太大，一项很慢也能拖着一大批内存。
- \`collect::<Vec<_>>\`：把流读完。无限流或长度等于流量的流上，这就是取消背压的标准写法。
- \`unfold\` / 自己 \`poll_fn\`：你自己就是上游。没有人强迫你尊重 Pending。可以在 poll 里狂读 socket 填 Vec——编译器不管。纪律在人。

\`\`\`rust
use futures::StreamExt;

async fn fanout<S>(src: S) -> anyhow::Result<()>
where
    S: futures::Stream<Item = u64> + Unpin,
{
    src.for_each_concurrent(32, |id| async move {
        let _ = fetch(id).await;
    })
    .await;
    Ok(())
}
\`\`\`

\`32\` 必须来自下游真实容量：数据库连接池大小、对端 QPS 上限、本进程内存预算除以每项大小。写死 32 和写死 32_000 的差别只在事故来得早晚。配置化，并打 in-flight 的当前值。

## 4. Channel 是最常见的 Stream 边界

\`tokio::sync::mpsc\` 有界通道：\`send.await\` 在满时挂起发送方——这就是背压传到上游任务。\`try_send\` 满了立即失败，把决策交给调用方。\`unbounded\` 从不挂起发送方，只在内存上记账。

选择顺序：

1. 有界 \`send.await\`。上游是你控制的任务，可以慢下来。
2. 有界 \`try_send\` + 明确策略（丢、断开、降级）。上游是 accept 循环或不可阻塞的回调。
3. 无界。仅当生产者速率有硬上限（例如「最多 N 个 in-flight 请求，每个一条消息」）并且你能用类型或信号量证明这个上限。

\`broadcast\` 给多个消费者同一份数据。慢消费者会丢（lagged），这是显式丢弃。不要用 broadcast 当工作队列——工作队列每条消息只该被一个工人拿走，那是 \`mpsc\`。\`watch\` 只保留最新值，适合配置。\`oneshot\` 一次结果。四种结构四种背压：mpsc 阻塞或有界拒绝，broadcast 丢旧，watch 丢所有中间值，oneshot 没有流。

通道里的物件形状决定内存。塞 \`Vec<u8>\` 大包，有界 1024 也能是数 GB。塞 \`Bytes\` 仍可能钉住整块读缓冲（零拷贝那篇第 10 节）。更好的形状是 id、小结构、或已经切成需要大小的 \`Bytes\`。大包走单独的路径和更小的界。

## 5. 慢消费者：三种合法反应

下游处理变慢时，上游必须感知。三种合法反应：

**阻塞（反压）。** 发送方 await，生产减速。TCP 窗口、有界 mpsc、Sink 的 \`poll_ready\` 都是这个。适合「最终要处理完、延迟可以涨」。链路要避免环：A 等 B 的槽，B 等 A 的处理，没有超时就会死锁。超时和断开是环的出口。

**丢弃。** 采样、最新值覆盖、随机丢。适合指标、日志、视频帧。必须有计数。丢弃策略写进 SLA：指标允许 1% 丢失，支付流水不允许。

**断开。** 拒绝新连接、关掉最老的连接、对调用方返回 503。适合已经没有意义再收的输入。比无界排队更尊重进程。负载均衡器看到 503 或连接失败，才能把流量切走；看到你还在 accept 但内部排队三分钟，它会以为你很健康。

非法反应：继续 accept、继续 \`spawn\`、继续往无界队列塞，同时用日志说「下游有点慢」。这是在用内存把慢翻译成更慢，直到崩。

## 6. 取消如何沿着流向下传

流的上游常常是 socket、定时器、子任务。下游 drop 这个 \`Stream\` 或 \`select!\` 切走，当前 \`poll_next\` 内部的 future 会被 drop。若 \`poll_next\` 里只是在等有界 recv，drop 会解除一次发送方的等待——发送方得到接收端关闭，这是干净的。若 \`poll_next\` 内部 \`spawn\` 了孩子去拉数据，孩子不会自动死。和调度那篇同一条：取消要传到叶子。

\`Stream\` 上的 \`take_until(token.cancelled())\`、循环里 \`select! { cancelled, next }\` 是显式做法。HTTP 请求被客户端断开，handler drop，内部的下游 RPC Stream 应该停。做不到就会出现「客户端都走了，我们还在打下游」的放大。

取消安全：\`next().await\` 拿到的项已经离开上游。若在处理这项时被取消，项可能丢。需要至少一次交付，就不要在「已经 recv、尚未 ack」之间放无保护的 await；或把项先放到本地，取消时再塞回（注意顺序和死锁）。消息队列语义（at-most-once / at-least-once）在这里落地，不是在注释里落地。

## 7. 批处理、时间与内存的三角

\`chunks_timeout(n, dur)\` 一类：满 n 条或等到超时就吐一批。这是用延迟换吞吐（更少 syscall、更好的向量化）。三角是：

- n 太大：一项卡住整批内存，尾延迟变差。
- dur 太大：空闲时最后几条要等很久才刷出。
- 两者都小：退化成逐条，批的意义没了。

按下游的最优批次和 SLA 的延迟预算来设，并在超载时降 n——超载还坚持大批次，是在用更大的内存换已经不存在的吞吐。刷出失败要有策略：重试会让批在内存里更久；丢掉要计数；断开要让上游停。

时间源用 Tokio 的计时器，不要在 Stream 的 poll 里 \`std::thread::sleep\`。poll 里睡眠是堵 worker，背压会变成全局卡顿。

## 8. 和零拷贝、调度叠在一起

流里流动的如果是大 \`Bytes\`，背压的界要按字节。流里流动的如果是 id，工人再去共享存储取载荷，存储那一侧也要有界——否则 id 队列看起来很瘦，工人手里的载荷把内存打爆。

\`spawn\` 每个项一个任务，等于把 Stream 的拉取变成无界任务队列。\`for_each_concurrent(n)\` 已经给了 n 个槽，再在闭包里 \`spawn\` 就把 n 变成了无限。闭包里应当直接 \`await\` 工作，而不是再扔出去。

worker 上做重 CPU 的 \`map\`，背压表现为整颗核停在这一条流上，其它任务饿。CPU 重的变换 \`spawn_blocking\` 或专门的线程池，并且那个池的队列也要有界——否则背压只是从 Tokio 挪到池的无界队列。

## 9. 取舍：拉取、推送、混合

纯拉取（Stream）适合下游速率决定系统速率：消费数据库行、读文件、读 socket。纯推送（回调、无界）适合不能阻塞的生产者：中断、某些 FFI 回调。混合是生产现实：回调里 \`try_send\` 到有界队列，一个拉取任务在另一侧 \`recv\`。回调侧满了只能丢或在文档允许时阻塞极短时间。不要在中断里 \`send.await\`——那里没有 runtime。

响应式流的「request(n)」学分是明确的信用。Rust 生态较少把信用做成类型，常用有界队列近似。需要精确信用（一次请求 128 项）时，自己在协议里做 window，不要指望 \`mpsc(128)\` 完全等于窗口——隐藏的缓冲（Nagle、codec、ready_chunks）会额外囤积。

## 10. 排障：OOM、延迟单调涨、丢了却没人知道

1. **RSS 随 QPS 线性涨。** 找 \`unbounded\`、\`collect\`、\`buffer_unordered\` 过大、accept 和 worker 之间没有界。打每个队列的 length 直方图。
2. **延迟单调涨，CPU 不高。** 队列在堆里，工作没有被处理。慢消费者 + 缓冲。缩小界，让延迟在界满时变成拒绝，而不是无限变慢。
3. **偶发丢数据。** \`try_send\` / broadcast lagged / watch 覆盖。补计数和告警。确认产品允许丢。
4. **死锁。** 两个有界队列互相等待。加超时，或合并成单队列，或规定锁/队列顺序。
5. **取消后下游仍在跑。** 子任务没接到 token。用 \`JoinSet\` 或显式 abort。
6. **吞吐上不去。** 界太小，或串行 \`then\` 本该并发。看 in-flight 是否经常掉到 0（上游慢）还是经常顶满（下游慢或界太小）。顶满且下游 CPU 闲，是界以外的地方串行了（锁、单连接）。

压测要带慢下游：故意把处理 \`sleep\` 10ms，看内存是否封顶、是否开始拒绝。只压快下游，永远测不出背压缺陷。

## 11. 设计清单：每条管道三个数

对每一条生产管道写下三个数：最大 in-flight 项数、最大 in-flight 字节、满了时的行为（等 / 丢 / 断）。三个数进配置和度量。缺任何一个，这条管道在评审里就不该过。

数字来自预算：内存上限除以每项大小、下游池大小、延迟 SLA 反推的深度。拍脑袋的 1024 比无界好，因为它给了一面能被顶到的墙；墙顶到时必须有告警和行为（等、丢、断）。没有告警的墙等于没有墙——你只会在 RSS 图上事后看见它曾经存在。把三个数和告警规则一起提交，管道才算设计完。
数字来自预算：内存上限除以每项大小、下游池大小、SLA。拍脑袋的 1024 比无界好，但仍然是拍脑袋——至少它给了你一个能被顶到的墙，墙顶到时要有告警。

把这个清单从入口（accept）写到出口（下游 HTTP/磁盘），中间每一跳都有界，才叫端到端背压。中间任何一跳无界，墙就建在那一跳的堆上。

流量整形和控制面要分开。数据面的 Stream 处理字节和消息；控制面的「暂停消费」「调整 n」「切断某条上游」走 \`watch\` 或单独的命令通道。不要在热路径上每次 poll 都读一遍全局配置锁。\`watch::Receiver\` 在配置变了才唤醒，平时 load 一个 \`Arc<Config>\`。把背压旋钮做成可运行时改的：下游开始 503 时把 \`for_each_concurrent\` 的 n 降下来，比崩了再扩容更像服务。改 n 的实现可以是外层循环重建流，或自己写一个带 \`AtomicUsize\` 上限的并发槽。重建流要注意取消和 inflight 排空，不要两个世代的工人同时打下游。

公平性：一条热流把 worker 打满，其它流的 \`poll_next\` 变稀。合作预算是安全带，不是公平调度器。多租户系统要在应用层做每租户的并发槽和每租户队列，否则背压会变成「谁流量大谁占满，小客户被饿死」。这和锁那篇的不公平饥饿是同一现象，只是队列换成了任务。每租户一个有界 channel + 全局 worker 数上限，是最朴素的隔离。

测试背压不要只测功能正确。写一个生产者比消费者快十倍的测试，断言内存峰值低于某条线、断言开始出现拒绝或等待。再写一个消费者挂掉的测试，断言生产者在有界 \`send\` 上及时收到关闭而不是永远卡住。这两条比「能把 100 项 collect 出来」更能保住生产。

HTTP/2 和 gRPC 自带流控窗口，这是协议层的背压。你在应用层再无界缓冲，等于把窗口的信号吞掉：对端以为你还能收，其实堆在你的 \`mpsc\` 里。正确的衔接是：应用层队列深度逼近上限时，停止 \`poll\` HTTP/2 的 DATA，让窗口缩小。\`hyper\` / \`h2\` 在你不读 body Stream 时就会这样做——所以「先把 body \`to_bytes\` 再处理」不仅拷贝，还把协议窗口拉满。流式处理 body 是在把 TCP 窗口、HTTP/2 窗口、应用队列连成一条链。任何一节变成无限桶，链就断。

消息系统（Kafka、NATS、自己写的 replica log）里，offset 提交是背压和至少一次交付的交界。先处理再提交：崩溃会重复，消费者必须幂等。先提交再处理：崩溃会丢。缓冲一批再提交：延迟和重复窗口都变大。无论哪种，处理侧的有界并发决定了「未提交的 in-flight」上限，这个上限必须能用内存预算算出来。把 poll 到的消息丢进无界任务池再异步提交，offset 和实际处理就会乱序，重复和丢失同时发生。\`JoinSet\` 或信号量把 in-flight 钉死，完成后再推进 offset，顺序才说得清。

「推送」接口（webhook、回调、消息监听器）常常不能阻塞。这时背压的第一跳必须是 \`try_send\` 到有界队列，满了返回 429 或对监听器返回错误。把 200 先回给对端再慢慢处理，是在对对端撒谎：它会按你还能吃的假设继续推。撒谎的窗口等于你的无界队列。能诚实地说「现在满了」，对端或中间的重试/窗口才能起作用。产品上怕 429 不如怕 OOM，OOM 之后你什么状态码都回不了。

度量除了队列长度，还要有「满了多久」和「因满拒绝的次数」。长度长期顶满说明界太小或下游太慢；拒绝次数上升说明背压在工作——这是健康信号，不要一看到拒绝就盲目加容量。加容量之前看下游：下游 CPU 闲着，是锁或串行化；下游 CPU 满着，加你的队列只是加延迟。把拒绝做成对入口可见（503/429），负载均衡才能把流量切走。内部消化到内存里，负载均衡仍觉得你活着，会继续喂。

\`Stream\` 的生命周期经常和连接绑在一起。返回 \`impl Stream<Item = T> + '_\` 的函数，流活着时借用着连接或缓冲。调用方 \`collect().await\` 还好；调用方把流 \`send\` 到另一个任务，借用过不了 \`'static\`。要跨任务，流必须拥有它的源（\`TcpStream\` move 进去）或源是 \`Arc\`。这是所有权篇在管道上的投影。\`async_stream::stream!\` 宏写出的生成器同样捕获环境，\`spawn\` 时一样要 \`Send + 'static\`。看起来像「只是 yield 几项」，类型上是一个藏着捕获的状态机。

背压测试要注入时间。用 \`tokio::time::pause\` 让 \`chunks_timeout\` 的超时在逻辑时间里触发，断言批次边界。用人工的慢 \`Sink\`（\`poll_ready\` 隔若干毫秒才 Ready）断言上游 \`poll_next\` 的次数不会在 Ready 之前狂飙——如果次数狂飙，上游在没有下游信用时仍在生产，背压断了。这项测试比压测更早抓住组合子用错（例如先 \`collect\` 再发）。

多路复用时，一条慢流不应堵住同连接上的其它流。HTTP/2 多流、gRPC 多 RPC 共享窗口又各有自己的。应用层若用一把全局有界队列收所有流的消息，慢消费者会让快流的项排在后面——队头阻塞从 \`buffered(n)\` 挪到了你的全局队列。按流分队列、全局再加总 in-flight 上限，两级界。实现成本更高，但是多租户和多路复用的默认。单队列只适合单消费者、同质项。

「有界」的界要能在运行时被看见。\`tx.max_capacity()\`、当前 \`tx.capacity()\`、信号量 \`available_permits()\` 导出成 metric。没有这些数，你无法区分「界太小」和「下游死了」。告警打在 \`capacity == 0\` 的持续时间上，而不是打在 QPS 上。QPS 下降可能是上游没流量，也可能是你自己把入口堵住了——后者必须用队列满的信号来说话。

\`Sink\` 只 \`start_send\` 不 \`flush\`，数据可能还在编码器里，上游却以为交出去了。关连接前 \`close().await\`，否则半包留在本地。\`flush\` 失败可能已经送出部分字节，重试语义和「从未发送」不同。测试覆盖正常 close、flush 失败、close 时仍有 in-flight。
复杂协议用阶段枚举的状态机，比三层 \`select!\` 夹组合子更容易把取消和半包落在明确阶段上。无限流没有 \`Ready(None)\`，和有限流混用时，有限流结束后要关掉 tick 分支，否则空转会把下游打出 4xx 风暴。
有界队列的深度不只是内存：最坏额外延迟约等于深度除以处理速率。按延迟预算反推深度，再和内存预算取小。只按内存把 1024 改成 102400，会在 SLA 上先爆。突增的记忆效应是：堆满之后即使输入恢复，消化堆积仍要一段时间，界越大记忆越长。
多路复用不要用一把全局队列收所有流，慢流会堵住快流。按流分队列，全局再加总 in-flight。推送回调不能 \`send.await\`，第一跳 \`try_send\`，满了诚实返回 429，让对端的窗口起作用。先 200 再慢慢处理是在撒谎，撒谎的窗口等于无界队列。
HTTP/2 窗口和应用队列必须连成一条链。\`to_bytes()\` 聚合 body 会把窗口拉满。度量导出 \`capacity\` 和「满了多久」，告警打在满的持续时间上。拒绝次数上升说明背压在工作，不是一看到拒绝就加容量。

## 12. 小结

Stream 的原理是拉取。背压就是下游不 poll 就不生产，用有界的队列、并发和信用把这个性质保住。缓冲只能平滑抖动，不能当无限窗口。满了必须等、丢或断，并且被度量。下一篇处理管道中间那些不得不共享的可变状态：Mutex、RwLock、以及只有争用证据确凿才该碰的 lock-free。

把三条管道（入口 accept、内部 worker、出口下游）的三个数贴到仪表盘上：in-flight 项、in-flight 字节、满了的行为计数。一周里如果「满了」从未发生，界可能过大，延迟记忆会在真正的尖峰时才被你看见。从未满过的有界队列和无限队列，在你见过的流量下无法区分。故意压一次慢下游，确认墙会顶上，确认拒绝或等待会发生。这才叫验证过背压。
`,

  "rust-lock-free-vs-mutex-in-servers": `把 lock-free 理解成「更快的锁」会在服务端立刻失效。无锁结构买的是某种进度保证和某种争用下的可扩展性，代价是 ABA、内存序、重试循环，以及几乎无法用类型证明的正确性。错误的 lock-free 比一把粗 \`Mutex\` 更慢，也更容易在负载尖峰以数据损坏的方式失败。共享状态的默认假设仍是：**先不要共享；非共享不可时用互斥；测出争用再拆锁；拆不动再考虑原子和无锁队列。**

这篇文章只讲服务进程里的争用：临界区怎么变短、异步代码为什么不能拿着 \`std\` 锁去 \`await\`、读多写少时 RwLock 会不会更差、原子能覆盖哪类问题。读完你应该能独立回答三个问题：这段共享状态能不能改成每个任务一份、持锁跨 \`await\` 会卡住谁、profiler 上的锁等待高是该换 lock-free 还是该先分片。

## 1. 争用是缓存行和临界区的病，不是原语名字的病

多核上两颗 CPU 写同一缓存行，行会在核之间来回作废。一把全局 \`Mutex<HashMap>\` 保护的不只是逻辑互斥，还有这行缓存的所有权来回飞。lock-free 的 \`AtomicU64\` 如果大家都在打同一个计数器，同样会打满这条行。换原语不换布局，争用还在。

所以第一步不是选 Mutex 还是 CAS，是问：**必须共享吗？** 每条连接的状态放在连接任务里，汇总用定时器或带界的 channel 把计数刷到全局，全局几乎不在热路径上被写。会话表按 id 分片，十六把锁比一把锁的缓存行少十六倍冲突（在访问均匀时）。假共享：两个无关原子挤在同一行，也会一起飞——\`CachePadded\` 或对齐填充是布局问题。

Amdahl 定律在这里很具体：临界区占 5% 的 CPU 时间，把这部分加速十倍，整体几乎不动。先用 profiler 看锁等待是否真的在前几名。不在，去做分配、拷贝、下游延迟。在，再看等待的是哪一把、临界区里在干什么。临界区里有 IO、有分配、有解析，先把这些挪出去，往往锁就不热了。

把 profiler 的看法当成门禁：没有争用证据的 lock-free PR，默认不合并。证据至少包括：锁等待占总 CPU 或占 p99 的比例、临界区长度、核数增加时 QPS 是否已经不再线性。缺这三项，所谓「无锁会更快」是猜测。猜测在低负载下通常成立（未争用的 CAS 也很快），在高争用下经常反过来变成重试风暴。用生产采样或压测复现，再换原语。


## 2. 单所有权仍然是最快的并发

任务 A 拥有 \`Session\`，任务 B 不碰。要让 B 做事，把消息 move 过去。没有锁，没有原子，缓存行只在这条核上待着。这就是 actor / 每连接一任务的模型。它的上限是：有些状态天生是全局的（连接表、限流器、路由表），有些操作要跨会话（广播、踢人）。

全局读多写少：\`Arc<Snapshot>\`，写的人造一份新快照再原子换指针（\`arc-swap\` / \`RwLock\` 写很少）。全局写多：分片，或接受这不是这条进程该扛的热点，拆服务。

\`\`\`rust
struct Worker {
    local_hits: u64,
    flush: tokio::sync::mpsc::Sender<u64>,
}

impl Worker {
    fn hit(&mut self) {
        self.local_hits += 1;
        if self.local_hits >= 1024 {
            let n = self.local_hits;
            self.local_hits = 0;
            let _ = self.flush.try_send(n);
        }
    }
}
\`\`\`

热路径只打任务私有的 \`u64\`。满了才向全局刷。丢几次刷（try_send 失败）对指标可接受，对账本不可接受——账本就不要走这条。模式的要点：把争用频率从「每请求」降到「每 N 请求」。

## 3. Mutex：短临界区里最便宜的正确性

\`std::sync::Mutex\` / \`parking_lot::Mutex\` 保证：同一时刻一个写者（对 Mutex 来说就是唯一持有者）。实现上，未争用时是一次原子，争用时把线程挂起。\`parking_lot\` 通常更瘦、更快、没有毒化；\`std\` 的毒化告诉你另一个线程已经在临界区里 panic——这是信息，不是麻烦。服务里中毒后继续 \`into_inner\` 等于在损坏的状态上跑。优先让进程或至少让这个会话死掉，并修那个 panic。

未争用路径的成本决定你能不能把锁放进每请求热路径。\`std::sync::Mutex\` 未争用在 Linux 上通常是一次原子；一旦争用，就要进内核。热到需要每请求加锁的状态，先问能不能改成任务本地再汇总。能，锁从热路径消失，比换一把更快的锁有效。不能，再看临界区里是不是只改几个字——是，原子或分片；不是，先把临界区剪短。
\`parking_lot\` 没有毒化，临界区 panic 之后其它线程继续看到半更新。因此 parking_lot 的临界区更不能跑可能 panic 的代码：不要 \`vec[index]\` 不检查、不要 \`unwrap\` 一个 Option。\`std\` Mutex 至少能把「这里崩过」传给后来者。选 parking_lot 是为了瘦和快，就要用更严的临界区纪律来补丢失的毒化信号。
异步运行时里「等锁」和「等 IO」在指标上要能分开。一把锁上等了 50ms，和下游 RTT 50ms，优化方向完全相反。没有分开的直方图，你会把锁问题当成下游问题去扩容对端。\`TimedMutex\` 或 tracing 的 lock_wait span 是为了这个分叉。没有它，争用是 anecdata。
跨分片的操作（要从 shard 3 挪到 shard 7）会引入锁顺序。规定小号先拿，永远不要反过来。操作失败要能回滚已经改过的那一 shard，否则你会在两个 shard 里看到同一条或零条。这已经接近事务。能避免跨分片就避免：让 key 的哈希稳定，迁移用离线重建快照替换，而不是在线逐条搬。

临界区规则：

- 只碰内存。计算哈希、拼字符串、等 IO，都在锁外。
- 拿锁、改、放，函数最好短到一眼看见。
- 不要在锁里调用户回调——回调会再抢另一把锁。
- 多把锁有固定顺序，写进注释，最好用类型（先 \`shards[i]\` 再 \`global\`，永远不要反过来）。

异步代码用 \`std::sync::Mutex\` 是合法的，**只要守卫不跨 \`await\`**。短短地取一个快照 \`let n = *lock.lock();\` 然后 await，完全正确，而且比 \`tokio::sync::Mutex\` 便宜——后者为了能在 await 时让出，实现更重，未争用成本也更高。\`tokio::sync::Mutex\` 的正当理由只有：临界区必须跨 await（极少是好设计）或等待者必须是任务而非线程。先改设计把 await 拿出去。

\`\`\`rust
async fn add_session(map: &std::sync::Mutex<HashMap<u64, Arc<Sess>>>, s: Arc<Sess>) {
    {
        let mut g = map.lock().unwrap();
        g.insert(s.id, s.clone());
    } // 守卫在这里 drop
    advertise(&s).await;
}
\`\`\`

花括号是产品。没有它，\`advertise().await\` 会把守卫带过 await。多线程 runtime 上 \`std\` 守卫 \`!Send\`，通常直接编不过；编过了（parking_lot 某些配置、或 tokio mutex）就是把互斥范围拉成一次网络 RTT。

## 4. RwLock：读并行的条件很窄

\`RwLock\` 允许并行读、独占写。读多写极少（配置、路由表、几乎不变的元数据）时，它比 Mutex 能让更多核同时读。写一多，读者要等写、写要等读者，读者之间的锁缓存行同样会撞。写多时 RwLock **比 Mutex 更差**：锁本身更复杂，还没有互斥那么干脆的进度。

饥饿：写者可能一直等持续到来的读者。有的实现写优先，有的不保证。不要在「读侧每请求都拿读锁」的路径上假设写还能在 1ms 内完成。更好的读多模型常常是 \`Arc<T>\` 快照 + 原子替换：读者只 \`load\` 一个指针，不进锁；写者分配新 \`T\`，swap。读者可能看到旧快照——这是语义选择，配置更新晚一毫秒通常可以，账户余额不行。

\`std::sync::RwLock\` 在写者上也可能毒化。parking_lot 的 RwLock 没有毒化、实现更快，语义要自己读文档（是否写优先）。异步 RwLock 同样：不要持读守卫跨 await，否则写者要等一个 RTT，读守卫把「读并行」变成「读着的人去睡觉」。

## 5. 原子：只覆盖你真正理解的那几个操作

计数、开关、epoch、状态机的小枚举，用 \`AtomicU64\` / \`AtomicBool\` / \`AtomicU8\`。成功路径是 \`fetch_add\`、\`load\`、\`store\`、\`compare_exchange\`。失败是你以为两个原子一起构成了事务——它们没有。\`hits\` 和 \`bytes\` 两个原子分别加，读取的人会看到一个加了、另一个还没加。需要一起被看到，就回到锁或单任务所有权。

内存序：

- \`Relaxed\`：这个位置原子，不管别人。计数器常用。
- \`Acquire\` / \`Release\`：配对发布。写者 \`Release\` store 指针，读者 \`Acquire\` load 后能看见指针所指对象的初始化。
- \`AcqRel\`：CAS 同时有两种角色。
- \`SeqCst\`：全序，最贵，也最好推理。先 SeqCst 换正确，热了再收。

不要在发布「配置指针」时用 Relaxed。读者可能看到新指针，却看不到指针指向的字段已经被写完。这是经典的「偶发读到未初始化」。

ABA：CAS 期望值是 A，中间别人改成 B 再改回 A，你的 CAS 成功，但世界已经不是你以为的那个 A。节点复用的无锁链表会踩这个。修复是指针打 tag、epoch 回收（crossbeam）、或干脆不要复用节点。能被 ABA 碰到的结构，不要自己写，用经过验证的 crate，并承认你买的是依赖而不是「几行 CAS」。

## 6. lock-free 队列和「进度」到底保证什么

lock-free 的定义是：系统中至少有一个线程能在有限步内完成操作，即使其它线程被调度走。它不保证无等待，不保证更快，不保证简单。某个线程可以一直 CAS 失败（活锁边缘），只要另一些在前进。wait-free 更强，服务端几乎不需要自己提供 wait-free 队列。

无锁 MPSC/SPSC 队列在「单生产者单消费者」或「多生产者单消费者」下有成熟实现（crossbeam、\`tokio::sync::mpsc\` 内部）。它们把锁争用换成了原子和缓冲。有界无锁队列满了仍然要有策略：等待（这就有了锁或 park）、丢、扩容（扩容往往要停或锁）。无锁没有把背压变没，只是把互斥换了形态。

自己写无锁双向链表、无锁哈希表，在生产服务里几乎总是错的。正确性依赖的场景组合（抢占、弱内存模型的 ARM、重试、回收）测不完。论文实现和工业实现之间隔着十年的 bug。需要并发哈希：用 \`DashMap\`、分片 \`Mutex<HashMap>\`、或 \`flurry\`/\`papaya\` 这类有人维护的。然后仍然要测，因为它们在写多时可能并不比分片 Mutex 好。

## 7. 分片、arc-swap、seqlock：中间地带

分片锁：\`Vec<Mutex<HashMap<..>>>\` 按 key 哈希取模。争用从一把变成 N 把。N 太大，内存和缓存都差；N 太小，热点 key 仍挤在同一把。热点 key（某个大客户 id）分片救不了——那要把热点再拆，或接受单 key 的串行。

\`arc-swap\`：原子替换 \`Arc<T>\`。读者 \`load\` 便宜。写者构造完整新对象。适合整表替换、配置、路由。不适合每秒万次小更新——每次写都分配整份快照。

seqlock：写者加版本，读者读两遍版本看有没有被打断。读无锁、写要短且不能在写时让读者看到撕裂的中间态。payload 必须能容忍读到垃圾再重试（不能是指针，除非你能证明指针始终有效）。适合时钟、计数快照，不适合拥有堆对象的结构。

RCU 风格（epoch-based reclamation）让读者无锁，写者等所有读者过完 epoch 再释放旧对象。crossbeam::epoch 提供原语。自己做 RCU 很容易把对象释放早了。这已经是「专家结构」档，代码评审要按那个标准。

## 8. 异步锁、公平性、优先级反转

\`tokio::sync::Mutex\` 的等待者是任务，会让出 worker。适合必须跨 await 的互斥（例如对某个协议状态机逐步读写，且中间必须 IO）。即便如此，持锁时间仍是下游 RTT，其它人全部排队。能拆成「锁外 IO + 锁内改状态」就拆。

公平性：有的锁 FIFO，有的不公平（刚释放的线程更容易再拿到，缓存友好但可能饿死旁人）。尾延迟敏感的路径要知道你用的锁会不会让某个任务饿几百毫秒。不公平锁在吞吐上好看，在 p99 上可能很难看。

优先级反转在服务端以另一种面目出现：持锁的任务被调度去跑别的 CPU 活（或被阻塞池拖住），等高优先级的短请求在锁上排队。协作式调度下，持锁任务若不及时 await 让出，等于把锁的释放推迟到它下一次让出。又一条理由：临界区禁止重计算和 IO。

## 9. 取舍顺序：一张该钉在墙上的表

1. 不共享。任务内所有权，channel 汇总。
2. 不可变共享。\`Arc<T>\`，T 无内部可变。
3. 极少更新的快照。\`Arc\` swap / \`RwLock\` 写很少。
4. 短临界区互斥。\`parking_lot::Mutex\` 或 \`std::sync::Mutex\`，守卫不跨 await。
5. 分片。按 key 打散。
6. 读多且读路径极热。考虑 arc-swap 或成熟并发 map，**带着你的写比例去测**。
7. 单计数器/标志。原子。
8. profiler 证明队列或特定结构是热点，且分片无效。才考虑无锁 crate，不自己发明。

每一步都有人想跳到第 8 步。跳步的代码在低负载下「更快」的错觉来自未争用路径，一到多核打满就变成重试风暴。评审时要看的是争用证据，不是博客标题。

## 10. 排障：锁等待、死锁、缓存行、错误的无锁

1. **锁等待在火焰图前几名。** 看临界区里有什么。有 IO/分配/回调，先挪。没有，看是否该分片或改单所有权。
2. **死锁。** 两把锁顺序、持锁 await 再抢另一把、channel 与锁组成环。tokio-console 能看任务在等哪把异步锁。std 锁死锁会把 worker 线程钉在内核，console 里它们只是不 poll 了。
3. **p99 尖刺，平均好。** 不公平锁饥饿、持锁任务偶尔做了重活、锁中毒恢复、GC 式的集中 drop 打在同一把锁上。
4. **CPU 打满在 CAS 循环。** 无锁结构在高争用下自旋。这比 Mutex 把线程挂起更吃电、更吃缓存。退回锁或分片。
5. **偶发数据损坏。** 内存序过弱、ABA、把 \`Relaxed\` 用于发布指针、自己写的无锁表。立刻换成熟实现或退回 Mutex。损坏比慢更贵。
6. **异步 Mutex 很慢。** 未争用也贵。检查是否本可以用 std mutex 的短临界区。

度量：每把锁的等待时间直方图（自己在 RAII 守卫里打点，或用 tracing）、争用次数、分片的热点分布（是否 80% 请求打在 1 个 shard）。没有分片分布，你会把 N 加到 256 仍然被一个热点 key 嘲讽。

## 11. 和所有权、调度、背压的关系

锁是共享可变别名的运行时证明，对应所有权篇里 \`Mutex<T>\` 把 \`&T\` 变成内部可变。调度篇要求这个证明的守卫不要跨 await，否则别名的互斥范围变成时间上的「整个下游」。背压篇要求争用下的等待有界：锁上无限排队和 channel 无限排队是同一种病。三者一起看：能不共享就不共享；共享就短持锁；等锁也要能超时或失败，让背压冒泡到入口。

\`Send\`/\`Sync\` 在这里再次出现。\`Mutex<T>: Sync\` 要求 \`T: Send\`（守卫可能在另一线程 drop 那个 T 的内容——对 std 来说谁解锁谁持有）。\`T\` 不是 \`Send\` 就不要放进跨线程 Mutex。类型又一次把「这个状态能不能离开这条线程」写死。不要 \`unsafe impl\` 来图省事。

锁的粒度还和数据结构内部布局绑在一起。\`HashMap\` 在扩容时会移动所有桶，持锁时间随元素数涨。热路径上插入导致扩容，p99 就会出现和「偶发大锁」一样的尖刺。预分配容量、或改用不会整体搬迁的结构（slab、分代槽），是在缩短临界区，不是提前优化。同样，\`clone\` 整个 \`HashMap\` 出来再在锁外读，临界区短了，但分配和拷贝可能比锁等待更贵——这要测。小表 clone 出去往往赢；大表用快照指针或只拷需要的键。

 condvar 在异步世界里对应 \`Notify\` + 条件标志，或 \`watch\`。不要用 \`std::sync::Condvar\` 在 async 里 \`wait\`，那会睡死 worker。异步等待必须让出。写「等某个会话出现」这类逻辑，用 \`HashMap\` + \`Notify\`，等待方被叫醒后重新查表，查不到再等。不要假设一次 notify 对应一次插入，notify 可能多余、也可能在你注册前已经发过——丢失的唤醒要用状态来补，不能只用边沿触发。

读写比例会随时间变。上线初期路由表几乎不改，\`RwLock\` 或 arc-swap 很合适；后来做成每秒多次的动态配置，写者开始排队，读者也被拖累。这时不是「RwLock 骗了你」，是工作负载变了。度量写次数和等待时间，允许自己把实现从 RwLock 换成分片 Mutex 或反过来。把选择写进注释：我们假设写 < 1% 。假设失效时，代码评审有依据去改。

假共享值得单独当一次事故看。两个 \`AtomicU64\` 在结构体里相邻，分别被不同核每请求自增，这一行缓存会在两核之间来回。profiler 上看到原子指令占比高、QPS 加核几乎不涨，就是它。\`repr(align(64))\` 或 \`crossbeam::utils::CachePadded\` 把它们拆开。不要给所有计数器都垫 64 字节——那是在用内存换不知道存不存在的争用。先测相邻热计数，再垫。NUMA 上还有更远的跳：跨 socket 的原子比同 socket 的锁还慢。把任务和它的状态钉在同一 NUMA 节点，是代理类产品在机器变大之后的招，不是起步默认。起步默认是减少共享。

锁中毒策略要写成代码而不是口头。\`std::sync::Mutex\` 在临界区 panic 后，后续 \`lock()\` 返回 \`Err\`。选项：\`unwrap\` 把恐慌传播成下一请求也崩；\`into_inner\` 忽略毒继续用可能损坏的表；重启进程或丢掉这个分片。对内存里的会话表，损坏后继续可能比崩更糟（给错用户数据）。对纯指标计数，\`into_inner\` 可以接受。把选择和数据结构的「损坏是否可观测到错误结果」绑在一起。\`parking_lot::Mutex\` 没有毒化，panic 之后锁释放、状态可能半更新——你失去了「曾经坏过」这个信号。用它就要用别的方式保证临界区不 panic：临界区里只做不会失败的内存操作。

读多写少的快照还有一个陷阱：读者长期握着旧 \`Arc\`，写者已经 swap 了几十代，旧快照占着内存。\`Arc\` 的释放取决于最慢的那个读者。请求处理如果把快照 \`clone\` 进一个长时间的 \`await\`（下游超时 30s），这 30s 内的旧表都不能释放。短请求路径上 \`load\` 用完即丢；必须跨 await 时，只把需要的字段拷出来，不要把整表 \`Arc\` 带过 IO。这和 Bytes 钉住整块读缓冲是同一个计数泄漏，只是对象从字节变成了表。

批量持锁是另一类临界区膨胀。循环里对每个元素 \`lock(); update; unlock;\` 看起来碎，但缓存行反复获取；反过来整表一把锁更新一万个元素，其它核全停。中间形态是：按分片聚桶，每个分片锁一次更新一批。批量大小和分片数一起调。不要在循环里调用会分配的 \`format!\` 还握着锁——把要写的字符串在锁外造好。这条规则简单，火焰图上却经常看到 \`malloc\` 在 \`pthread_mutex\` 下面，原因就是它。

无锁结构的测试要包含：单线程语义等价、多线程随机交错、miri（如果你没碰平台相关原子）、以及「暂停一个线程再恢复」（模拟调度）。CAS 循环在恢复后必须仍然正确。漏了暂停场景，ABA 和 use-after-reclaim 会在生产的 STW 式延迟里才出现——例如一次长时间的 GC 式 drop 或一次 CPU steal。自己写的无锁队列若没有这套测试，就还不是生产组件。用 crate 时也看它有没有这类测试，没有的当实验。

\`std::sync::atomic::fence\` 和原子操作上的 order 不是一回事。需要「这之前的所有写对那之后的读可见」而手头是 Relaxed 计数时，才考虑 fence。多数业务代码不该直接 fence。能用 \`Release\` store / \`Acquire\` load 表达的，用配对表达，意图更清楚。代码里出现 fence，评审按「为什么原子 order 不够」来问，而不是按「看起来很底层所以很快」来过。

假共享会让加核不涨 QPS：两个热原子挤同一缓存行。只给测过的相邻热计数垫 64 字节，不要给所有计数器垫。NUMA 上跨 socket 原子可能比同 socket 的锁还慢，钉节点是机器变大之后的招，起步仍是减少共享。
\`OnceLock\` 保证初始化一次，不是互斥更新，更不要在请求路径第一次才编正则。读者优先的 RwLock 在读风暴下会饿死写者，流量打到已经下线的地址；能接受旧快照就用 arc-swap，不要用 RwLock 硬保证读到最新。旧 \`Arc\` 被一个 30s 的 await 握着，写者 swap 几十代也释放不了——跨 await 只拷字段。
诊断死锁靠锁的名字、持有时间直方图、持有者任务 id。自己包一层 \`TimedMutex\`，看见谁拿了 40ms，比上 lock-free 更常解决问题。临界区循环里 \`format!\` 会在火焰图里把 \`malloc\` 放进 \`pthread_mutex\` 下面。Drop 里不要抢可能被别人持有的锁，析构顺序叠加锁顺序是夜间死锁。
无锁结构的测试要包含暂停一个线程再恢复。漏了这个，ABA 会在一次长时间 drop 或 CPU steal 里才出现。代码里出现 \`fence\`，评审问为什么配对的 Release/Acquire 不够。批量更新按分片聚桶，不要整表一把锁扫一万行，也不要每个元素加一次锁把缓存行打飞。

## 12. 小结

服务端并发的原理是 **争用下的正确性**。先减少共享和临界区，再用最朴素的互斥，测到热点再分片或换快照，最后才是原子和无锁。lock-free 不是奖章。没有争用证据就上无锁，是在用正确性风险换一篇好看的技术分享。服务端默认的英雄路径是：不共享、短 Mutex、分片、快照、原子计数。走到无锁 crate 时，代码评审按实验项目的标准：测试含暂停线程、有生产采样、有回退方案。回退写在开关里，比写在「出了事再改」的口头计划里可靠。
下一篇离开运行时，看把这些 crate 拼成产品时的构建图：workspace 边界、feature 统一、release profile 如何决定体积和尾延迟。

争用优化的验收标准不是「换成了无锁」，是 p99 和核数扩展性在同一份压测脚本下变好，且正确性测试（含暂停线程、含 panic 注入）仍然绿。任何一项变差，回退开关要能在一次部署内打回 Mutex。没有回退的 lock-free 上线，等于没有刹车的下坡。
`,

  "rust-cargo-workspace-and-release-profile": `把 \`cargo build --release\` 理解成「打开优化」会在上线后立刻失效。Release profile 决定内联、LTO、codegen 切分、panic 策略、符号剥离——每一项都改生成代码的形状，从而改体积、改启动、改尾延迟。Workspace 决定的是另一张图：crate 边界、依赖统一、feature 如何被无意打开。这两张图是架构，不是个人口味。CI 时间和二进制大小一样，都是产品参数。

这篇文章只讲构建：workspace 如何把多 crate 收进同一份依赖解析、feature 统一如何把 \`tokio\` 的多余能力编进你以为很瘦的二进制、profile 里每一旋钮买什么。读完你应该能独立回答三个问题：为什么内部库改一行会导致看似无关的二进制变慢、\`thin\` LTO 和 \`codegen-units = 1\` 各砍的是什么、库 crate 为什么不该把 \`panic = abort\` 强加给下游。

## 1. 构建图就是架构图

Cargo 的单元是 crate。crate 边界决定编译单元、可见性和重编译范围。一个 20 万行的 \`src/lib.rs\` 改一行，整库重编。拆成 \`core\` / \`net\` / \`api\` / \`bin\`，改 \`api\` 不必重编 \`net\` 的机器码——除非你让它们的类型缠在一起，或开了 LTO 把边界又焊上。

Workspace 把多个 crate 放进同一份 \`Cargo.lock\`（对虚拟 workspace 和 resolver 版本要看你用的 Cargo 契约）和同一次 \`cargo test --workspace\`。内部依赖用 \`path\`，版本号在发布时才有意义。\`workspace.dependencies\` 把 \`tokio\`、\`bytes\`、\`serde\` 的版本写在一个地方，避免 A crate 用 tokio 1.36、B crate 用 1.37 被解析成两份或一份但 feature 并集爆炸。

\`\`\`toml
[workspace]
members = ["crates/core", "crates/net", "crates/api", "crates/cli"]
resolver = "2"

[workspace.dependencies]
tokio = { version = "1.40", features = ["rt-multi-thread", "macros", "net", "time"] }
bytes = "1"
anyhow = "1"
thiserror = "2"

[workspace.package]
edition = "2021"
rust-version = "1.82"
license = "MIT"
\`\`\`

\`rust-version\` 统一 MSRV。CI 用这一个版本编，文档写这一个版本。每个 crate 自己写不同 edition 可以，但 rustc 版本分叉会让「我这边编过」在另一台机器上变成语法错误。

虚拟 workspace（根包没有 \`[package]\`）适合纯多 crate 仓。根包同时是二进制时，根会参与 feature 统一，根 \`Cargo.toml\` 随手加一个 feature 会改变所有依赖的并集。这是「我只是在根上试了一个 feature」导致发布体积涨的原因。

## 2. Feature 统一：并集，不是你写的那一行

Cargo 对同一份依赖的多份引用，会把 feature **取并集**。\`net\` crate 声明 \`tokio = { features = ["net"] }\`，\`cli\` 声明 \`features = ["full"]\`，最终这份 tokio 带着 \`full\` 编进两个 crate。\`full\` 里的 process、fs、signal、io-util 就这样进了你以为只做网络的二进制。体积、编译时间、甚至 \`cfg\` 代码路径都会变。

打开 \`tokio/fs\` 只因为某测试读了一次文件，生产二进制就会带上阻塞池相关代码路径。dev-dependency 在 resolver 2 下不该泄漏 feature，但仍可能通过 workspace 里另一个 crate 的正常依赖泄漏。查泄漏用 \`cargo tree -e features -i tokio\`，把每一行 feature 的来源看完。来源是测试或示例，就给它们单独的 feature 或单独的 crate，不要污染默认图。
\`macros\` feature 看起来无害，它拉进 \`tracing\` 或 syn 的重量取决于版本。\`rt-multi-thread\` 和 \`rt\` 决定二进制里有没有 work-stealing 代码。嵌入式或 sidecar 若只想 \`current_thread\`，被并集打开 multi-thread，体积和线程名都会变。这些不是微优化，是你在调度那篇里做的选择会不会被构建图悄悄改掉。构建评审要问：这份二进制里的 tokio feature 列表，和我们设计的 runtime 是否一致。
CI 里把 \`cargo tree -e features -i tokio\` 的输出存成快照，feature 集一变 PR 就显示 diff。人不一定记得「谁打开了 fs」，diff 会记得。体积和编译时间的回归，经常第一次出现在这份 diff 里，而不是在基准里。


resolver = "2" 改善了「dev-dependencies 的 feature 泄漏进正常构建」等旧行为，但并集规则仍在。生产纪律：

- 禁止对常用依赖写 \`features = ["full"]\`。列出你用到的。
- workspace.dependencies 里给出默认最小集，个别 crate 用 \`features = ["parking_lot"]\` 追加。
- 可选功能用 crate 自己的 feature 往下传：\`rt-tokio = ["dep:tokio", "tokio/rt-multi-thread"]\`，不要让叶子直接打开上游的大包。
- \`cargo tree -d\` 看重复；\`cargo tree -e features -i tokio\` 看谁打开了什么。

\`default-features = false\` 对 \`tokio\`、\`reqwest\`、\`image\` 这类默认很肥的库几乎是必须。忘记关默认，image 可能把 png/jpeg/gif 全编进来，而你只解码一种。

## 3. 内部 crate 怎么切：按变化率和依赖方向

切 crate 不是按文件夹美感，是按：

变化率、依赖方向、编译时间、发布边界这四条里，编译时间是最容易在仓变大之后突然炸开的。\`core\` 一旦依赖一个重过程宏，所有下游的增量编译都要等宏。把宏留在叶子：生成 protobuf 的 crate 只被 \`net\` 依赖，\`cli\` 不碰它。反向依赖用抽出共享类型解决，不要用 feature 互开后门形成「逻辑循环、编译勉强通过」。
内部 crate 的 \`pub\` 默认应当比你想象的更少。\`pub(crate)\` 和 \`pub(super)\` 能把可改面收小。\`pub use\` 把内部路径稳定成外部 API，等于承诺以后不改。workspace 内部互相 path 依赖时，这个承诺看起来无害，一旦要拆仓发布就会变成 semver 地狱。现在少导出，以后少 major。
\`default-members\` 控制你在根目录敲 \`cargo build\` 会编谁。把重的示例、基准、fuzz 从 default 拿掉，日常循环才快。它们仍在 members 里，CI 显式 \`-p\` 或 \`--workspace\` 才编。\`exclude\` 给确实不属于这张图的目录（生成物、第三方 vendored 源）。不要 exclude 只是为了暂时编过，那会让「workspace 测试」变成假门禁。
依赖方向还可以用架构测试固定：\`core\` 的 \`Cargo.toml\` 里不允许出现 \`axum\`、\`reqwest\`、\`tonic\`。用 \`cargo metadata\` 扫一遍比 code review 眼睛扫可靠。破了就 CI 红。这是构建图版的「领域层不认识 HTTP」，和错误处理那篇的反腐败层是同一条边界在不同阶段的投影。
profile 与 crate 切分叠加：LTO 会把你精心切的编译防火墙在发布时焊回去，这是要的——运行时内联。开发时防火墙仍在，增量才快。所以「为了运行时性能把所有东西放进一个 crate」是在用每次敲键的时间换 LTO 已经会做的事。保持切分，发布开 thin LTO，两边都拿到。
Docker 构建用 cargo-chef 一类方案缓存依赖层，把 \`Cargo.lock\` 和 \`Cargo.toml\` 的拷贝放在源码之前，依赖没变时不重编 crates.io 的包。缓存 key 含 rustc 版本和 profile。忘了 rustc 版本，升工具链后用旧 LLVM 产物链接，错误会非常难看。构建图的时间维（缓存）和空间维（crate 边界）要一起设计。

- **变化率。** 稳定的协议类型、错误枚举放 \`core\`，少改，大家依赖它。常改的 HTTP 适配放 \`api\`。
- **依赖方向。** \`core\` 不依赖 \`axum\`。领域错误不认识 HTTP。反向依赖是循环，workspace 编不过或逼你抽出第三个 crate。
- **编译时间。** 过程宏、生成代码、重依赖（如 \`tonic-build\`）放在叶子，不要放进被十个 crate 依赖的 \`core\`。\`core\` 一碰过程宏，全家重编。
- **发布边界。** 要独立发 crates.io 的，版本和 API 稳定性单独谈。只在仓内用的，\`publish = false\`。

循环依赖用抽出共享类型来拆，不要用 \`features\` 互开后门。\`core\` 里放 \`Bytes\` 和新错误枚举，\`net\` 和 \`api\` 都依赖 \`core\`，彼此不依赖。这和运行时的「依赖图」是同一张图在编译期的投影。

测试 crate：重集成测试放 \`tests/\` 或单独 \`crate-tests\`，免得 \`dev-dependencies\` 的肥库影响 IDE 在库代码上的分析时间。\`[dev-dependencies]\` 里的 tokio features 在 resolver 2 下不应泄漏，但仍会让 \`cargo test\` 更慢——测试也是产品，值得用 workspace 的 profile.test 管。

## 4. Release profile：每一项都是交换

\`\`\`toml
[profile.release]
opt-level = 3
lto = "thin"
codegen-units = 1
panic = "abort"
strip = "debuginfo"
debug = 1
\`\`\`

**\`opt-level\`。** \`3\` 偏速度，\`s\`/\`z\` 偏体积。服务端默认 \`3\`。对体积敏感的 wasm 或嵌入式才 \`z\`。\`opt-level = 0\` 的 --release 没有意义。注意依赖可以用 \`[profile.release.package.huge_crate] opt-level = 2\` 做例外，很少需要。

**LTO。** 链接时优化让内联和消死码跨 codegen unit、跨 crate。\`false\`：最快编译，最差跨 crate 内联。\`thin\`：并行 LTO，通常是服务端的甜点，体积和速度都明显好于不开，CI 时间可接受。\`fat\` / \`true\`：更彻底，链接更慢，收益递减。开 LTO 之后，crate 边界作为「编译防火墙」变弱——改 \`core\` 的一个内联函数，下游的优化后代码也会变。这是用更好的代码换更重的链接。

**\`codegen-units\`。** 默认大于 1，并行生成，优化视野变窄。\`1\` 让 LLVM 看见整个 crate（再叠加 LTO 看见更多），更好优化，更慢编译。发布制品用 \`1\`；日常开发不要放在 \`dev\` profile 里。

**\`panic\`。** \`unwind\` 保留展开表和 drop 路径，二进制更大，能 \`catch_unwind\`。\`abort\` 去掉展开，体积更小，panic 即死。服务端二进制常用 abort：panic 已经是不变量破坏，展开过程本身可能再坏。**库 crate 不要在自己的 Cargo.toml 里写 \`panic = abort\`**——这会强加给下游，让下游无法 catch。panic 策略是最终二进制的选择。

**\`strip\` / \`debug\`。** 完全剥符号，崩溃时栈不可读。\`debug = 1\` 或 \`line-tables-only\` 保留行号，体积增加有限，换回能读的 panic 栈。线上用独立 debuginfo 文件（split debuginfo）是更完整的做法：二进制瘦，出事故时拿符号表来符号化。不要在「体积」名义下把栈变成 \`0x1234\`。

**\`incremental\`。** release 默认关。不要为了 CI 缓存强行打开 release incremental，产物可复现性更差，收益不稳定。

## 5. Dev、CI、发布是三条 profile，不要混

\`dev\`：快编译，\`opt-level = 0\`，debug 全开。跑功能测试。不要拿它压吞吐。

\`release\`：上面那套，产出部署制品。

\`bench\` / \`profiling\` 自定义 profile：

\`\`\`toml
[profile.profiling]
inherits = "release"
debug = true
strip = "none"
\`\`\`

火焰图用 profiling profile。用纯 release 剥干净的二进制，perf 只能看到 \`unknown\`。用 dev，你看到的热点是未优化的噪音。

CI 里 \`cargo test\` 默认 dev，太慢就 \`[profile.ci] inherits = "dev" opt-level = 1\` 或对依赖 \`opt-level = 2\`（\`[profile.dev.package."*"] opt-level = 2\`）让依赖优化、自己的代码保持可调试。这能把测试时间砍一大截，代价是依赖的断点不好下。选一边。

\`--locked\` 在 CI 必须：按 \`Cargo.lock\` 编，拒绝解析漂移。应用仓提交 lock；纯库仓是否提交 lock 有争论，但 workspace 里有二进制，就提交。

## 6. 依赖审计、deny、供应和重复

\`cargo deny\` / \`cargo audit\` 查许可证、漏洞、重复 crate。同一份 \`bytes\` 出现 0.4 和 1.x 是两份代码、两份类型，不能互传。\`cargo tree -d\` 列重复。重复常常来自没有 workspace.dependencies、或某个传递依赖钉死旧版本。

\`vendor\` 和 git 依赖：git 依赖让可复现变差（tag 被 force push）。生产钉 crate.io 版本或精确 git rev。\`[patch]\` 用来临时修上游，不要变成永久的第二条依赖图。

\`links\` 原生库：同一进程不能链两份 openssl。workspace 统一 \`vendored\` 或统一系统库。FFI 那篇的符号冲突，很多是构建图没统一。

过程宏和 build.rs 是隐藏的编译时间税。\`build.rs\` 里跑重活（编译 C、生成 protobuf）要做增量：输入没变不要重跑。CI 缓存 \`target\` 时按 profile、按 \`Cargo.lock\` 的哈希分 key，避免 debug/release 互踩。

## 7. 体积：从并集和死码开始，不是从 LLVM 开始

二进制胖，先看：

1. \`cargo bloat\` / \`cargo llvm-lines\`：哪类单态化炸了。泛型 \`HashMap<K,V,S>\` 的很多实例、\`async\` 状态机每个 spawn 一份。
2. feature 并集：tokio full、reqwest native-tls + rustls 双栈、serde 的多余格式。
3. 静态链接的原生库。
4. 未 strip 的 debug。

单态化是 Rust 性能的来源，也是体积的来源。热路径上的泛型保持单态；边界上用 \`dyn Error\` / \`dyn Future\`（\`Box\`）收口，少生成 50 份只调用一次的状态机。这和运行时分配是交换：多一次间接，少一份机器码。测了再收。

\`RUSFLAGS=-C target-cpu=native\` 让本机更快，制品不能发到旧 CPU。发布用基线 CPU 或分发多份。Docker 里 native 等于「构建机是什么就编什么」，CI 机器一换，线上 illegal instruction。

## 8. 工作区 lints、格式、MSRV

统一 \`[workspace.lints.rust]\` / \`clippy\`：\`unsafe_code\` 在叶子允许、在 \`core\` 拒绝；\`unwrap_used\` 在库路径警告。各 crate \`[lints] workspace = true\`。没有统一 lints，就会出现有的 crate 满地 unwrap、有的 crate 禁 unsafe，代码评审没有共同语言。

格式：\`rustfmt.toml\` 放根上。edition、imports 顺序、换行宽度是团队合同。CI \`cargo fmt --check\`。不要每个 crate 一份 rustfmt。

MSRV：\`rust-version\` 写了就要在 CI 用那个版本编一次。只用 nightly 的功能必须 \`cfg\` 或单独 crate，不能让默认构建依赖 nightly。依赖升级时看它们的 MSRV，被依赖拖到比你声明更新的编译器，是在静默提高门槛。

## 9. 取舍：拆 crate vs 单 crate、LTO vs CI 时间、abort vs unwind

单 crate 简单，编译图简单，改一行重编全世界。适合一个人、几万行以下。多人、多二进制、编译已过分钟级，拆。拆过头（三十个一百行的 crate）让 IDE 和 Cargo 解析本身变慢，类型满世界 \`pub use\`。目标是「改这里不必重编那里」对得上真实变化率。

LTO thin + codegen-units=1 是发布甜点。开发者本机 \`cargo build --release\` 若因此慢到不想用，提供 \`profile.release-fast\`（无 LTO、默认 codegen-units）给本地验证，CI 和真正发布走完整 profile。两套制品不要混着部署。

abort 给最终服务二进制；需要在进程内隔离 panic 的（插件、教学、某些 FFI 宿主）留 unwind。选择写在根二进制的 profile，不写在库。

## 10. 排障：编不过、编太慢、体积暴涨、运行变慢

1. **feature 冲突 / 重复类型。** \`A\` 和 \`B\` 各带一份 \`rand\` 主版本。workspace.dependencies 钉住，\`cargo update -p\` 有意识地做。
2. **改一行编三分钟。** 过程宏在 \`core\`；LTO 开在 dev；没开增量；\`target\` 在慢盘。把重依赖下移，dev 关掉 LTO。
3. **体积翻倍。** \`cargo bloat\` 看新进来的 crate 和单态。检查是否不小心 \`full\` 了。
4. **release 比 dev 还慢（运行时）。** 极罕见，通常是测错了 profile，或 \`opt-level=z\` 加无 LTO 把热循环弄碎。确认 \`cargo build --release\` 的 \`target/release\`，不要跑到 \`target/debug\`。
5. **线上非法指令 / 缺符号。** target-cpu=native 或 strip 了不该剥的动态符号。容器里用和构建一致的 glibc。
6. **CI 不可复现。** 没 \`--locked\`，或缓存了错误的 \`target\`。缓存 key 必须含 lock 哈希和 profile 名。

\`cargo build -Z timings\`（或稳定后的 timings）看哪个 crate 占编译时间。优化编译时间先打最重的那几个，不要平均用力。

## 11. 和运行时行为如何互相决定

\`codegen-units\` 和 LTO 改变内联，从而改变异步状态机大小、从而改变分配和缓存。\`panic=abort\` 改变错误路径能不能 \`catch_unwind\`，从而改变 FFI 边界策略。feature 并集可能把 \`tokio\` 的 \`rt-multi-thread\` 编进一个你想保持 \`current_thread\` 的嵌入场景。构建旋钮不是在「编译器设置」页面里孤立存在，它们会漏进调度、错误处理、FFI。

反过来，crate 边界会引诱人把本该是模块的东西做成动态分发，只为了少重编。先量编译时间，再决定是否值得用 \`dyn\` 换增量编译。多数服务端二进制，发布时 LTO 会把 \`dyn\` 的「编译防火墙」部分再焊回去，只留下运行时间接。不要为了编译时间牺牲热路径；为了编译时间牺牲冷路径和适配层，可以谈。

Workspace 里的版本升级是一次显式的架构动作。\`cargo update\` 会在 lock 允许的范围内浮动。大版本（tokio 1 → 2，或某个 \`0.x\` 的 minor）要单独 PR，跑测试、看 \`cargo tree -d\`、看 bloat。把 \`cargo update\` 放进无人看的 Dependabot 自动合并，等于让 feature 并集和 MSRV 在你睡觉时变。依赖的 changelog 里「opened default feature foo」对你的体积可能比「fixed panic」影响更大。升级 rustc 同样：新的 LLVM 会改内联和向量化，release 性能可能变好也可能某个热循环变差。升编译器后跑一遍基准，不要假设单调变快。

缓存是构建图的时间维。本地 \`target/\`、CI 的 sccache / 缓存目录、registry 缓存，三层。\`target\` 按 job 的 profile 和 lock 哈希隔离。两份 job 共享同一 \`target\` 目录，debug 和 release 会互相弄脏增量状态，表现为「偶发编不过」或「增量编译比全量还慢」。sccache 对 \`build.rs\` 产出和过程宏的缓存命中不稳定，命中率要度量，不要假设开了就快。\`CARGO_INCREMENTAL=0\` 在 CI 的 release 构建是常态，避免增量状态进制品。

文档和示例也是构建图的一部分。\`[[example]]\` 若依赖 \`full\` feature，会在 \`cargo test --all-targets\` 时把那份并集拉进来，把你的库测试时间翻倍。示例用单独 feature \`examples\` 或放在 \`examples/\` 并在 CI 里显式 \`--features\`。\`cargo test --workspace --all-features\` 会打开所有 feature 的笛卡尔积式并集，能抓到互斥 feature 的问题，也会把编译时间推到峰值。CI 分两列：默认 feature 的测试，和 \`all-features\` 的编译检查。两列都要，但不要都当每次提交的热路径。

交叉编译是构建图的空间维。\`--target aarch64-unknown-linux-gnu\` 从 x86 CI 产出 ARM 制品，链接器、sysroot、原生依赖（openssl、protobuf）都要按目标来。\`build.rs\` 里用 \`CARGO_CFG_TARGET_OS\` 判断，不要用 \`std::env::consts\`——那是宿主。

\`\`\`rust
// build.rs
fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap();
    println!("cargo:rerun-if-changed=build.rs");
    if let Ok(hash) = std::env::var("GIT_HASH") {
        println!("cargo:rustc-env=GIT_HASH={hash}");
    }
    println!("cargo:rustc-cfg=target_os_is_{target_os}");
}
\`\`\`FFI 的 \`cc\` 编译 C 代码必须用目标编译器。Docker 里 qemu 跑测试可以，跑基准不行。发布矩阵：x86_64 和 aarch64 的 musl 或 gnu 要明确，musl 静态编体积和启动路径都不同，某些 DNS / 用户库行为和 glibc 有差。选 musl 是为了容器里少依赖，不是为了「更 Linux」。

\`[patch.crates-io]\` 和 \`[replace]\` 是临时绕过上游的刀。patch 在整个 workspace 生效，能把一个 git 分支替进所有依赖。忘记拿掉就会让生产钉在你的 fork 上，fork 的 CI 和安全更新都不会自动来。纪律：patch 必须带 issue 链接和移除条件；\`cargo deny\` 可以扫 git 依赖。内部 fork 不如给上游发 PR 或把真正需要改的部分用封装绕过。

二进制的确定性：同一份 lock、同一份 rustc、同一份 profile，应得到可比较的制品。LTO 和并行链接在部分平台上仍可能有非确定性。需要可复现构建时，钉 rustc 版本（\`rust-toolchain.toml\`）、关增量、固定 \`SOURCE_DATE_EPOCH\`、小心 \`build.rs\` 把时间戳编进代码。安全团队要哈希制品时，这些才开始值钱。日常服务端不必从第一天可复现，但不要在 \`build.rs\` 里 \`SystemTime::now()\` 写进二进制，那会让每次编都不同，缓存全废。

工作区变大之后，\`cargo test --workspace\` 会变成三十分钟。分层：\`core\` 的测试每次提交跑；集成测试和端到端按路径过滤或 nightly 跑。\`cargo test -p api --lib\` 比全仓快十倍，预提交钩子用它。CI 全仓是门禁，开发者循环不是。\`cargo-nextest\` 并行和重试不稳定测试，能把墙钟时间压下去，但不该用来掩盖顺序依赖的脏测试。测试要自己有界、自己不抢固定端口，否则并行只是把偶发失败变成必发。

最后，profile 和运行时选项要对着看。\`panic=abort\` 的二进制里，库文档写的 \`catch_unwind\` 恢复策略是空的，FFI 篇的隔离要改成「panic 即进程死，所以对外函数更不能让 Rust 侧 assert 落到用户输入上」。\`lto=thin\` 可能把一个你以为跨 crate 的虚调用内联掉，热路径变了，基准要在发布 profile 下跑。构建图改了，运行时文章里的数字都可能改。把「用哪份 profile 跑的基准」写进基准报告，否则你在比较两种算法，实际上在比较有没有 LTO。

链接器选择会改 CI 时间和体积。\`lld\` / \`mold\` 比默认的 bfd 快一截，尤其在开 LTO 时。\`RUSTFLAGS="-C link-arg=-fuse-ld=lld"\` 或 \`[target.*] linker\` 写在 \`.cargo/config.toml\`。这是工程参数，进仓库，不要只在某台开发者机器上生效。split debuginfo（\`split-debuginfo = "packed"\` 或平台对应选项）让二进制瘦、调试文件单独走制品库。崩溃时用 build id 把符号对上。没有 build id 的 strip 二进制，等于放弃事后分析。

\`cargo hakari\` 一类 workspace hack 把公共依赖的 feature 并集收成一个中间 crate，减少「每个 crate 一份不同并集导致重复编译」。工作区到几十个 crate、tokio 的 feature 组合开始爆炸时，它能把 CI 从几十分钟拉回来。代价是多一个生成的 crate 和一套约定。先用 \`cargo build -Z timings\` 确认痛点在重复编译，再上 hack。更早的步骤仍是：不要 \`full\`，workspace.dependencies 给出最小集。

发布顺序和 semver：内部 path 依赖在 workspace 里无所谓版本，要 publish 时必须先发被依赖的 crate，版本号对得上。\`core\` 改了公开类型，\`net\` 和 \`api\` 都是 breaking。能保持 \`core\` 的公开面小，发布才不至于每次全家 major。\`pub use\` 把内部模块全部倒出去，等于没有边界。公开的类型应当能用一页纸列完。

\`rust-toolchain.toml\` 把 rustc 版本钉在仓库里，开发者和 CI 用同一份。nightly 只给需要的 job（miri、bench 的某个 flag），默认 job 走 stable。混用而不钉，会出现「我这边编过」——对方 rustc 旧一个点，edition 或库 API 不同。工具链文件是构建图的根配置，和 profile、lock 并列，缺一不可复现。

链接器用 lld 或 mold，写进仓库的 \`.cargo/config.toml\`，不要只在某台笔记本上快。split debuginfo 让二进制瘦、符号单独存，崩溃用 build id 对上符号。没有 build id 的 strip 等于放弃事后分析。
过程宏和 build.rs 用 \`build-override\` 较低优化即可，它们只在编译期跑；生成出来的代码跟最终 profile。不要给过程宏 crate 开 fat LTO。\`incremental\` 留在本地 dev，CI release 关掉，避免脏增量表现为「删 target 就好了」。
\`cargo metadata\` 上写机器可执行的约束：禁止叶子依赖 axum、禁止 \`full\`、强制 workspace.dependencies。约束只在 wiki 上三个月后必破。sys crate 的 vendored 与系统库必须全仓统一，否则最后链两份原生库。对 LLVM 极慢的巨型生成 crate 单独降 \`opt-level\`，例外写注释。
制品注入 git sha 和 profile 名。事故时「这是哪一次编译」必须能答。交叉编译看 \`CARGO_CFG_TARGET_*\` 不要看宿主 consts。\`[patch]\` 必须带移除条件和 issue 链接。hakari 一类 hack 只在 timings 证明重复编译是痛点之后再上，更早的步骤仍是不要 \`full\`。
\`rust-toolchain.toml\` 与 lock、profile 并列，是可复现的第三根柱子。nightly 只给 miri 那些 job。发布顺序按依赖图：\`core\` 公开面越小，全家 major 越少。\`pub use\` 倒出内部模块等于没有边界。基准报告写明 profile，否则比较的是有没有 LTO，不是两种算法。
分层测试：预提交只跑被改 crate 的 \`--lib\`，CI 跑 workspace。nextest 不能用来掩盖抢固定端口的脏测试。\`all-features\` 当编译检查，不当每次提交的热路径。

## 12. 小结

Workspace 管边界和依赖并集，profile 管生成代码的形状。feature 取并集，所以 \`full\` 是传染病；LTO 和 codegen-units 是发布性能的正经旋钮，不是神话；panic 策略属于最终二进制。把构建图当架构来评审：谁依赖谁、谁打开哪些 feature、发布制品用哪份 profile。运行时的所有权、调度、零拷贝、错误、FFI、背压、争用，最终都要被编进这个二进制里——编的方式会改写它们在机器上的成本。

一份最小发布检查单：\`cargo tree -d\` 无意外重复；tokio/reqwest 的 feature 快照无 \`full\`；profile 是 thin LTO + 你选好的 panic 策略；制品带 git sha 和 debuginfo 的对应关系；CI 用 \`--locked\` 和声明的 rust-toolchain。五项里任何一项漂移，前面七篇的结论都会在机器上变味。构建图不是收尾步骤，是那七篇文字变成 CPU 指令时必须经过的关口。把检查单放进 CI，而不是放进发版前夜的 wiki。

还可以再加两条很容易漏的：\`RUSTFLAGS\` 里有没有只在某台机器存在的 \`target-cpu=native\`；Docker 缓存有没有按 rustc 版本分 key。前者会让线上旧 CPU 非法指令，后者会让升工具链后链到旧 LLVM 产物。它们不在 Cargo.toml 里，所以 cargo deny 看不见。写进构建脚本的自检：拒绝 native，拒绝不明 rustc 的 cache hit。构建图的边界在仓库外还有半截，半截也要管。
本地 \`cargo build --release\` 若慢到没人愿意跑，提供一份不带 LTO 的 \`release-fast\` 给开发者验证逻辑，完整 profile 留给 CI 和真正发布。两套制品严禁混部。混部之后的「我本机是好的」没有任何信息量，因为本机根本不是那份二进制。把「CI 的 release 制品」当成唯一真相，本机的 release-fast 只用来看逻辑是否通。性能数字、体积数字、panic 行为，一律以 CI 那一份为准。否则构建图上的所有旋钮都会在口头上存在、在机器上缺席。发版记录里贴上这次制品的 profile 名、toolchain 哈希、feature 快照，事故时才能把「代码」和「真正跑着的指令」对上号。对不上号的优化讨论，都是在讨论另一份二进制。把制品哈希写进发布单，讨论才有对象。没有哈希的发布，等于没有构建图。

`,
};
