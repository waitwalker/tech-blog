export const nestjsArticles: Record<string, string> = {
  "nestjs-architecture-and-ioc-di": `NestJS 看起来像 Angular 搬到服务端，真正值钱的是 **IoC 容器如何用类型把对象图拼起来**。没有容器，每个 \`new\` 都是一处耦合；有了容器，生命周期和替换策略才是一等公民。

## 问题从哪里来

\`new UsersService(new UsersRepository(new Db()))\` 把实现写进调用方。测试要换假仓库，只能改生产代码。Nest 把「谁依赖谁」写成构造函数类型，把「怎么造」交给容器。

## 原理：依赖图

启动时扫描 \`@Module\` 的 providers。对每个 class：

1. \`Reflect.getMetadata('design:paramtypes', Ctor)\` 读构造参数类型（要 \`emitDecoratorMetadata\`）。
2. 在容器里解析这些类型，递归直到叶子（配置对象、连接）。
3. 按作用域缓存实例：默认 singleton，整个进程一份。

\`\`\`ts
@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}
\`\`\`

容器不是魔法：它是一张「token → 工厂 + 缓存」表。class 本身常当 token。重名、循环依赖、接口被擦除，都会让图断掉。

## 循环依赖

A 需要 B、B 需要 A 时，元数据在一边还是 \`undefined\`。\`forwardRef(() => B)\` 推迟查找。仍应优先拆模块，循环是结构坏味道。

## 作用域

- **singleton**：无状态服务、连接池。有状态会串请求。
- **request**：每个 HTTP 请求一份，适合当前用户。别把重对象放 request 除非必要。
- **transient**：每次注入都 new。

## 工程上怎么用

测试用 \`Test.createTestingModule().overrideProvider().useValue()\`。生产 token 用字符串/symbol 只在多实现时。不要在构造函数做 IO，放到 \`onModuleInit\`。

## 小结

IoC 的原理是「类型当钥匙，容器当工厂」。DI 让调用方依赖抽象，生命周期让资源可预测。`,

  "nestjs-modules-and-dynamic-modules": `模块是 Nest 的封装边界：不 export 的 provider，外面看不见。DynamicModule 让同一模块在不同 import 点带不同配置，这是库作者和中台配置的核心。

## 原理：静态图 + 运行时补边

\`@Module({ imports, controllers, providers, exports })\` 描述静态图。\`exports\` 是唯一的对外窗口。\`imports\` 只是「我能看见对方 export 的东西」，不是「对方所有 provider 都变成我的」。

\`DynamicModule\` 是函数返回的模块字面量：

\`\`\`ts
static forRoot(opts: DbOptions): DynamicModule {
  return {
    module: DatabaseModule,
    global: false,
    providers: [{ provide: DB_OPTIONS, useValue: opts }, DbService],
    exports: [DbService],
  };
}
\`\`\`

\`forRoot\` 通常注册连接；\`forFeature\` 注册某实体的 Repository。根模块 import 一次 Root，业务模块 import Feature。

## global 的代价

\`global: true\` 等于污染全局命名空间，测试和多租户配置会乱。能显式 import 就不要 global。ConfigModule 常 global，是因为几乎人人需要，不是范例。

## 工程上怎么用

异步配置用 \`forRootAsync({ inject, useFactory })\`，等 ConfigService。不要在工厂里读散落的 \`process.env\`。循环 import 用 \`forwardRef\` 只当急救。

## 小结

模块边界 = export 集合。DynamicModule 是带参数的模块工厂。配置进工厂，实例进容器。`,

  "nestjs-controllers-routing-and-params": `Controller 是 HTTP 到方法的映射，不是业务层。路由、管道、守卫跑完之后，方法里应该只剩「调用应用服务」。参数装饰器决定 **从哪取数据、先经过谁**。

## 原理：适配器 + 元数据

Nest 在 Express/Fastify 适配器上注册路径。\`@Get(':id')\` 只是元数据。请求来时：

1. 中间件
2. 守卫
3. 管道（含 \`ParseIntPipe\`、\`ValidationPipe\`）
4. 拦截器 \`intercept\` 前半
5. 方法体
6. 拦截器后半 / 异常过滤器

\`@Param('id')\` 从路由取字符串。不经 Pipe 就是 string，\`id === '10'\` 这种 bug 由此而来。\`ParseIntPipe\` 失败抛 400，这是协议，不是业务异常。

DTO 是输入形状。不要把 Entity 当 DTO：输出字段和存储字段会绑死。

## 工程上怎么用

版本放在路径或 Header，别在方法里 if。状态码用装饰器声明。文件上传走独立拦截器，不要和 JSON DTO 混。

## 小结

Controller 的原理是「把 HTTP 语义翻译成一次函数调用」。翻译过程（pipe/guard）比函数体更重要。`,

  "nestjs-providers-and-custom-providers": `Provider 不只是 \`@Injectable() class\`。token 可以是类、字符串、symbol。工厂可以同步或异步。自定义 provider 是容器的逃逸舱：对接老库、条件实现、测试替身。

## 四种 use*

- **useClass**：token 映射到另一个类。接口多实现时用。
- **useValue**：塞进现成对象。配置、时钟、假数据。
- **useFactory**：函数里 new。可 \`inject\` 其它 token。异步工厂等连接连上再继续启动。
- **useExisting**：别名，两个 token 同一实例。

\`\`\`ts
{
  provide: CLOCK,
  useFactory: () => ({ now: () => Date.now() }),
}
\`\`\`

## 原理：token 相等性

类 token 靠引用。字符串 token 必须同一常量。写两处 \`'DB'\` 魔法字符串会注册两套。导出 \`const DB = Symbol('DB')\`。

异步工厂失败会让整个应用 bootstrap 失败，这是好事：依赖没就绪不该对外服务。

## 工程上怎么用

第三方 SDK 包一层 factory，便于超时和 mock。不要在 factory 闭包里捕获请求级数据——那是 singleton 泄漏。

## 小结

Provider 是「token + 如何得到实例」。class 只是最常见的一种工厂。`,

  "nestjs-middleware-request-lifecycle": `中间件在守卫之前，最靠近原生 Request。适合：关联请求 ID、IP 限流、静态资源、改 header。不适合：鉴权业务（用 Guard）、改返回体（用 Interceptor）。

## 生命周期顺序

中间件 → 守卫 → 管道 → 拦截器(前) → handler → 拦截器(后) → 过滤器（若抛错）

中间件拿的是 Express/Fastify 对象，没有 Nest 的 ExecutionContext 那么干净。它也不进 DI 的方法级拦截。想注入服务，写成 class middleware 并在模块里 \`configure(consumer)\`。

## 全局 vs 路由

\`app.use\` 全局。\`consumer.apply(Xxx).forRoutes('cats')\` 绑定路径。排除用 \`exclude\`。顺序就是注册顺序，调试时把请求 ID 中间件放第一。

## 工程上怎么用

日志 correlation id 在这里生成，放进 AsyncLocalStorage，后面的 Guard/Service 都能读。不要在中间件里碰业务库。

## 小结

中间件是适配器世界的钩子。生命周期靠前，能力也更「脏」。能后移的逻辑就后移。`,

  "nestjs-pipes-and-validation-class-validator": `Pipe 把「进来的原始值」变成「方法签名想要的值」。校验失败应该 400，而不是进服务再 throw 500。\`ValidationPipe\` + class-validator 是把 DTO 类当 schema。

## 原理

管道实现 \`transform(value, metadata)\`。\`ParseUUIDPipe\` 失败抛 \`BadRequestException\`。\`ValidationPipe\` 对 DTO：

1. 普通对象转 class 实例（class-transformer）
2. 跑装饰器校验
3. 可选 whitelist：剥掉未声明字段（防 mass assignment）
4. forbidNonWhitelisted：多字段直接 400

这是安全边界，不是礼貌。

## 为何不在 Service 校验

Service 可能被 CLI、队列、其它 handler 调用。HTTP 形状的校验应停在管道。领域规则（余额不足）才是业务异常。

## 工程上怎么用

全局 \`ValidationPipe({ whitelist: true, transform: true })\`。复杂条件用自定义 pipe。文件和 JSON 不要共用一个 DTO。

## 小结

管道的原理是「类型和约束在进业务前落地」。DTO 是协议，Entity 是存储。`,

  "nestjs-guards-and-rbac-authentication": `Guard 回答一个问题：这个请求 **能不能进 handler**。它不负责怎么登录，只负责拿已解析的身份做判决。JWT 策略、Passport、RBAC 都是 Guard 前后的插件。

## 原理

\`canActivate(context): boolean | Promise<boolean>\`。false 或抛 \`UnauthorizedException\` / \`ForbiddenException\`。ExecutionContext 能取 request、rpc、ws，所以同一套 Guard 可跨传输层。

认证（你是谁）和授权（你能不能）要拆：

- AuthGuard：没 token / token 无效 → 401
- RolesGuard：有用户但角色不够 → 403

RBAC：用户 → 角色 → 权限点。权限点用自定义装饰器贴在方法上，Guard 读 metadata。不要在 Guard 里写死路径字符串。

## 和中间件的差别

中间件先跑，但没有标准的「装饰器元数据」。角色写在 \`@Roles('admin')\` 上，只有 Guard 能干净地读到。

## 工程上怎么用

Passport 策略只负责把 token 变成 user 对象，挂到 request。Guard 读 user。单测 mock user，不要真签 JWT。

## 小结

Guard 是授权切面。身份解析与权限判决分开，错误码才能稳定。`,

  "nestjs-interceptors-aspect-oriented-programming": `拦截器是 AOP：在 handler 两边包一层 RxJS 流。适合：映射响应、计时、缓存、事务边界、包装 \`{ data }\`。不适合：鉴权（太晚）、改路由（太晚）。

## 原理

\`\`\`ts
intercept(ctx, next) {
  const t = Date.now();
  return next.handle().pipe(
    map((data) => ({ data, ms: Date.now() - t })),
  );
}
\`\`\`

\`next.handle()\` 返回 Observable。HTTP 适配器会订阅它。你能 \`tap\`、\`catchError\`、\`timeout\`。异常若在这里吞掉，过滤器就看不到——要明确设计。

多个拦截器是洋葱模型：先注册的在外层。

## 和管道/过滤器

管道处理输入。拦截器处理调用本身和输出。过滤器处理未捕获异常。计时放拦截器，校验放管道，映射错误码放过滤器。

## 工程上怎么用

超时用 \`timeout(ms)\` 转成自己的异常。缓存拦截器必须带上用户维度的 key，避免串数据。

## 小结

拦截器让「每次调用都要做的事」离开业务方法。原理是 Observable 包装，不是装饰器好玩。`,

  "nestjs-exception-filters-and-global-handling": `过滤器是最后一道：把任意异常变成 **稳定的 HTTP/RPC 错误体**。没有它，Express 会吐一堆 stack，客户端无法依赖 status。

## 原理

\`@Catch(HttpException)\` 或 \`@Catch()\` 全捕获。\`catch(exception, host)\` 里用 ArgumentsHost 拿到 response。未知错误要打日志和 correlation id，对外只给 \`code + message\`，不要把 SQL 细节给出去。

分层：

- 领域：\`InsufficientFundsError\`
- 应用：Filter 映射 409 / 业务码 \`BALANCE_LOW\`
- 基础设施：连接失败映射 503，并触发告警

全局 Filter 注册一次。模块内 Filter 只处理该模块的领域异常，避免一个巨型 switch。

## 工程上怎么用

\`HttpException\` 带 object 响应。校验错误保持 400 和字段数组。不要 \`throw 'string'\`。测试断言的是 code，不是英文句子。

## 小结

过滤器是错误协议的实现。原理是「异常类型 → 状态码 + 对外形状」，对内才是日志。`,

  "nestjs-typeorm-database-integration": `TypeORM 在 Nest 里通常以 \`forRoot\` + \`forFeature([Entity])\` 出现。原理上要盯三件事：连接生命周期、Repository 与事务边界、实体和表的映射是否泄漏进领域。

## 原理

\`forRoot\` 创建 DataSource/Connection，应是 singleton。\`forFeature\` 为实体注册 Repository token。Service 注入 \`@InjectRepository(User)\`。

事务不能靠「多个 await 的 save 碰巧成功」。要用 \`QueryRunner\` 或 \`dataSource.transaction(async mgr => ...)\`，同一 runner 上的操作才共事务。

实体装饰器是 ORM 细节。API 直接 return Entity 会把 password hash、内部列暴露出去，也让迁移变成破坏性 API 变更。

## 工程上怎么用

生产关 \`synchronize\`，用 migration。连接池大小按进程数 × 实例数算，别让 RDS 被打满。N+1 用 \`relations\` 或 QueryBuilder 显式 join。

## 小结

ORM 是带生命周期的连接 + 工作单元。事务和列暴露，比 CRUD 语法更要紧。`,

  "nestjs-prisma-orm-modern-data-access": `Prisma 用 schema 生成类型和客户端，查询的可空性和字段集合在编译期就能查。和 Nest 整合的关键是：**PrismaClient 单例、连接池、事务 API、以及不要在热路径上 new client**。

## 原理

\`schema.prisma\` 是真相。\`prisma generate\` 产出类型。Nest 里做一个 \`PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy\`，\`onModuleInit\` 时 \`$connect\`，destroy 时 \`$disconnect\`。

事务：\`\$transaction([...])\` 交互式或批量。交互式事务里不要做长时间外部 HTTP，会占连接。

Prisma 的查询是按模型的，不是按 SQL 随意 join。复杂报表仍应走原始 SQL 或视图，不要硬拧。

## 和 TypeORM

Prisma 迁移更线性，类型更准；动态查询和复合 unique 的灵活性略不同。选哪个取决于团队对 schema-first 的接受度，不是性能神话。

## 工程上怎么用

连接池在 URL 的 \`connection_limit\`。Serverless 要防进程复用导致的过多连接。日志用 \`\$on('query')\` 采样，不要全量。

## 小结

Prisma 的原理是「schema 生成客户端」。Nest 负责它的生命周期。事务和连接数是生产问题。`,

  "nestjs-swagger-openapi-documentation": `Swagger 模块扫装饰器和 DTO 元数据，生成 OpenAPI 文档。它能成为契约，也能成为谎言——如果 DTO 和真实响应不一致。

## 原理

\`@ApiProperty\`、\`@ApiOkResponse({ type: Xxx })\` 描述字段。class-validator 装饰器有的能映射到 schema（必填、最小长度）。插件可以减少手写。

文档是生成物，不是手写 Markdown。CI 应把 openapi.json 当制品，前端用同一份生成 SDK。

## 陷阱

\`any\`、循环类型、\`Map\`、文件上传，生成器会退化。Response 用 Entity 会把不该公开的列写进文档。

## 工程上怎么用

生产可关 UI，保留 json。版本进文档。错误码用 \`@ApiResponse\` 写全 401/403/409。

## 小结

OpenAPI 是机器可读的协议。原理是装饰器 → schema。让它和运行时 DTO 同源，才有价值。`,

  "nestjs-websocket-realtime-gateway": `Gateway 把 socket 事件映射成方法，和 HTTP Controller 同构，但 **连接是长的、失败是静默的、扇出是内存和心跳问题**。

## 原理

适配器（socket.io / ws）管传输。\`@WebSocketGateway\` + \`@SubscribeMessage\` 注册事件。房间是服务端标签，广播是遍历连接。Guard/Interceptor 也能用于 WS，但 ExecutionContext 类型不同。

心跳：协议层 ping/pong，业务层还要有「用户级在线」。只靠 TCP 半开检测不够。

水平扩展：房间状态在单进程内存里。多实例必须 sticky 或用 Redis adapter，否则进同一房间的人连的不是同一进程。

## 工程上怎么用

鉴权在握手时做，失败直接断。消息要有大小上限。不要在消息 handler 里 CPU 空转。断开时从房间表删掉，防泄漏。

## 小结

WS 的原理是「有状态的连接集合」。网关方法只是事件回调；房间、心跳、多机同步才是架构。`,

  "nestjs-microservices-and-message-queue": `Nest 微服务把传输换成 TCP/Redis/RMQ/Kafka，handler 仍是带装饰器的方法。原理是 **消息 + 序列化 + 至少一次投递的假设**，不是「远程函数」。

## 原理

ClientProxy \`emit\`（事件，不等待）和 \`send\`（请求响应）。服务端 \`@EventPattern\` / \`@MessagePattern\`。默认 JSON 序列化。失败重试会导致 **重复消费**，所以 handler 必须幂等：用消息 id 去重或用数据库唯一约束。

队列提供缓冲和背压。没有预取限制时，消费者会把内存当队列。RMQ prefetch、Kafka consumer lag 都要看。

## 工程上怎么用

跨服务不要共享 Entity。契约用版本化的 payload。超时显式设。死信队列接告警。本地用同一抽象，测试用 in-memory transport。

## 小结

微服务传输是消息，不是 RPC 幻觉。幂等、超时、背压，三条比选 Redis 还是 RMQ 更重要。`,

  "nestjs-task-scheduling-and-bullmq": `定时任务和队列解决两类问题：Cron 是「到点执行」，BullMQ 是「现在或延迟执行，可重试、可观测」。生产里后者通常才是作业系统。

## 原理

\`@Cron\` 跑在 **当前进程**。多实例会重复执行，除非加分布式锁。适合单实例运维任务，不适合支付补单。

BullMQ：Job 进 Redis，Worker 拉取。失败按 backoff 重试。延迟队列用 sorted set。并发度是 worker 的 \`concurrency\`，不是 Node 默认单线程能无限并行 IO 的借口——CPU 仍一份。

Job 数据要可序列化、要小。大文件放对象存储，队列里只放 id。

## 工程上怎么用

幂等 key。重复 job 用 jobId。监控 waiting/active/failed。Cron 触发的工作也丢进队列，避免多机重复。

## 小结

调度的原理是「把工作变成可重试的消息」。Cron 只是时钟；队列才是执行系统。`,
};
