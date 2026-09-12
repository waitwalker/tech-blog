import type { Post } from "./posts";

export const rustPosts: Post[] = [
  {
    slug: "rust-ownership-borrow-checker-in-production",
    title: "所有权与借用检查器：把生产事故挡在编译期",
    excerpt: "用所有权、借用和生命周期把「谁在什么时候能改这块内存」写成类型，而不是写成注释。",
    category: "Rust",
    date: "2026-08-18",
    readTime: "14 min",
    author: "Waitwalker",
    tags: ["Rust", "所有权", "借用检查器", "内存安全"],
    content: `
## 1. 生产里真正会炸的不是语法

Rust 的所有权模型解决的是并发和生命周期，不是「写起来炫」。典型事故：

- 回调里还拿着已经被 \`drop\` 的缓冲区
- 多个任务同时 \`mut\` 同一块连接状态
- \`clone()\` 把热路径变成分配器压力

编译器拒绝的代码，换成别的语言就是线上的 use-after-free 或数据竞争。

## 2. 三条不变量

1. 每个值同一时刻只有一个所有者。
2. 可变借用与其它借用互斥。
3. 借用不能活过所有者。

\`\`\`rust
fn take_buffer(buf: Vec<u8>) { /* 所有权移入 */ }

fn peek(buf: &Vec<u8>) -> usize { buf.len() }

fn append(buf: &mut Vec<u8>, b: u8) { buf.push(b); }
\`\`\`

## 3. 跨 \`await\` 的借用

\`async\` 函数在 \`await\` 点可能被调度走。引用如果跨越 \`await\`，生命周期必须证明任务回来时对象还在。做不到就改成拥有数据（\`Arc\`、\`Bytes\`）或把借用收进同步临界区。
`,
  },
  {
    slug: "rust-tokio-runtime-and-task-scheduling",
    title: "Tokio 运行时：多线程调度、任务取消与背压",
    excerpt: "把 Tokio 当成有界工作队列来用：任务可取消、IO 有超时、阻塞代码不准偷跑进 worker。",
    category: "Rust",
    date: "2026-08-19",
    readTime: "16 min",
    author: "Waitwalker",
    tags: ["Rust", "Tokio", "异步", "调度"],
    content: `
## 1. Worker 不是无限 CPU

多线程 runtime 默认用 work-stealing。你在 \`async\` 函数里跑 \`std::fs::read_to_end\` 或重 CPU 循环，等于占死一个 worker。正确做法：

\`\`\`rust
let bytes = tokio::task::spawn_blocking(|| std::fs::read("dump.bin")).await??;
\`\`\`

## 2. 取消必须传到叶子

\`tokio::select!\` 取消的是当前 future，不一定取消你 spawn 出去的子任务。子任务要拿 \`CancellationToken\` 或 \`JoinHandle::abort()\`。

## 3. 背压

无界 \`mpsc\` 是把内存当队列。生产环境用有界通道，发送失败时明确：丢弃、阻塞还是降级。
`,
  },
  {
    slug: "rust-zero-copy-bytes-and-buffer-strategy",
    title: "零拷贝缓冲策略：Bytes、slice 与协议解析",
    excerpt: "热路径上少一次 memcpy，比微优化 parser 更有效。用 Bytes 做引用计数切片，把所有权留在连接读缓冲里。",
    category: "Rust",
    date: "2026-08-19",
    readTime: "13 min",
    author: "Waitwalker",
    tags: ["Rust", "零拷贝", "Bytes", "性能"],
    content: `
## 1. 为什么 \`Vec<u8>\` 会拖慢网关

每个帧 \`to_vec()\` 一次，QPS 上万时分配器比业务逻辑更忙。\`bytes::Bytes\` 允许：

- 底层一块引用计数缓冲
- \`slice\` 出只读视图，无拷贝
- 跨任务移动只要 bump 计数

\`\`\`rust
fn header(frame: Bytes) -> Bytes {
    frame.slice(0..4)
}
\`\`\`

## 2. 解析时不要过早 \`String::from_utf8\`

先验证边界，再决定要不要变成拥有的 \`String\`。日志、key、路由命中往往只需要 \` &[u8] \`。
`,
  },
  {
    slug: "rust-error-handling-thiserror-anyhow",
    title: "错误处理分层：thiserror 领域错误与 anyhow 边界",
    excerpt: "库用 thiserror 保留类型，应用边界用 anyhow 收口。unwrap 不属于生产路径。",
    category: "Rust",
    date: "2026-08-20",
    readTime: "12 min",
    author: "Waitwalker",
    tags: ["Rust", "错误处理", "thiserror", "anyhow"],
    content: `
## 1. 两套错误，两个方向

- **库 / 领域层**：\`thiserror\` 枚举，调用方能 \`match\`。
- **二进制入口 / 请求边界**：\`anyhow::Result\`，带 context 的调用栈。

\`\`\`rust
#[derive(thiserror::Error, Debug)]
pub enum RouteError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("upstream timeout")]
    Timeout,
}
\`\`\`

## 2. 日志要有错误码

把枚举映射成稳定的对外错误码，不要把 \`Display\` 字符串当协议。
`,
  },
  {
    slug: "rust-ffi-and-c-abi-boundaries",
    title: "FFI 边界：C ABI、panic 隔离与所有权交接",
    excerpt: "跨语言只在边界用 unsafe。约定谁释放内存、panic 不准穿越 FFI，否则对面是未定义行为。",
    category: "Rust",
    date: "2026-08-21",
    readTime: "15 min",
    author: "Waitwalker",
    tags: ["Rust", "FFI", "unsafe", "C ABI"],
    content: `
## 1. 边界清单

1. 只导出 \`extern "C"\`。
2. 入参指针要么可空并检查，要么文档保证非空并在 Rust 侧 \`NonNull\`。
3. \`catch_unwind\` 包住回调，panic 变成错误码，绝不穿越 ABI。
4. 分配与释放同一边负责：Rust 分配就 Rust \`free\`。

\`\`\`rust
#[no_mangle]
pub extern "C" fn buffer_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() { return; }
    unsafe { drop(Vec::from_raw_parts(ptr, len, len)); }
}
\`\`\`
`,
  },
  {
    slug: "rust-async-stream-and-backpressure",
    title: "Stream 与背压：异步管道如何避免内存爆炸",
    excerpt: "Stream 不是无限迭代器。没有背压的 map/buffer 会把上游速度变成 OOM。",
    category: "Rust",
    date: "2026-08-21",
    readTime: "13 min",
    author: "Waitwalker",
    tags: ["Rust", "Stream", "背压", "Tokio"],
    content: `
## 1. 有界才是默认

\`\`\`rust
let mut stream = reader.frames().ready_chunks(32);
while let Some(chunk) = stream.next().await {
    sink.send_all(&mut stream::iter(chunk)).await?;
}
\`\`\`

\`ready_chunks\` 和有界 channel 把内存钉死。不要 \`collect::<Vec<_>>().await\` 再处理。

## 2. 慢消费者

下游慢时，上游必须感知：阻塞 poll、丢帧或断开。静默缓冲是事故。
`,
  },
  {
    slug: "rust-lock-free-vs-mutex-in-servers",
    title: "服务端并发：Mutex、RwLock 和 lock-free 怎么选",
    excerpt: "先测量临界区。短而稀的用 Mutex，读多写少用 RwLock，只有争用证据确凿再上 lock-free。",
    category: "Rust",
    date: "2026-08-22",
    readTime: "14 min",
    author: "Waitwalker",
    tags: ["Rust", "并发", "Mutex", "lock-free"],
    content: `
## 1. 常见反模式

在 \`async\` 里持有 \`std::sync::Mutex\` 越过 \`await\`：可能饿死整个 runtime。异步临界区用 \`tokio::sync::Mutex\`，并且把 await 留在锁外。

## 2. 选择顺序

1. 能不共享就不共享，任务内单所有权。
2. \`parking_lot::Mutex\` / \`std::sync::Mutex\` 保护同步数据结构。
3. 读多写少：\`RwLock\` 或 \`arc-swap\`。
4. 有 profiler 证明的热点：\`crossbeam\` / \`Atomic*\`。

lock-free 的复杂度成本是正确性，不是酷。
`,
  },
  {
    slug: "rust-cargo-workspace-and-release-profile",
    title: "Cargo Workspace 与 Release Profile：把构建和体积当成产品",
    excerpt: "多 crate 工作区、统一 lints、release 下 LTO 与 codegen-units，让二进制体积和运行时速度可复现。",
    category: "Rust",
    date: "2026-08-22",
    readTime: "12 min",
    author: "Waitwalker",
    tags: ["Rust", "Cargo", "Workspace", "工程化"],
    content: `
## 1. 工作区切分

\`\`\`toml
[workspace]
members = ["crates/core", "crates/cli", "crates/net"]
resolver = "2"
\`\`\`

公共依赖版本写在 workspace，避免每个 crate 锁不同 \`tokio\`。

## 2. Release 配置

\`\`\`toml
[profile.release]
lto = "thin"
codegen-units = 1
panic = "abort"
\`\`\`

\`thin\` LTO 对 CI 时间更友好。\`panic = abort\` 适合无 unwinding 的服务端二进制，但库 crate 不要擅自 abort。
`,
  },
];
