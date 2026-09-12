export const nestjsB: Record<string, string> = {
  "nestjs-exception-filters-and-global-handling": `把异常过滤器理解成「catch 一下打日志」会在生产里立刻失效。过滤器不是日志中间件，也不是 \`try/catch\` 的语法糖。它是 **错误协议的实现**：哪一种失败对应哪个 HTTP/RPC 状态、对外 JSON 长什么样、对内日志带什么关联 ID。没有它，Express/Fastify 的默认处理器会把 stack 吐给客户端，调用方无法依赖 status，安全审计也会把 SQL 细节当成功能。

Nest 把「业务失败」和「传输失败」拆开：Service 抛领域类型，Filter 在边界翻译。读完你应该能独立回答三个问题：校验失败为什么必须停在 400 而不是进 Service、未知错误对外该不该带 \`message\`、拦截器 \`catchError\` 吞掉异常之后过滤器还能不能看到。

## 1. 先画边界：过滤器不管「该不该失败」，管「失败长什么样」

请求生命周期是一条固定管道：

中间件 → 守卫 → 管道 → 拦截器前半 → handler → 拦截器后半 → **若抛错则过滤器**

过滤器 **不** 决定「余额够不够」（领域），**不** 决定「JWT 有没有」（Guard），**不** 决定「id 是不是 UUID」（Pipe）。这些层已经 throw 了，它只把 throw 变成字节。把鉴权失败写在过滤器里 \`if (!user) 401\`，等于把 Guard 的职责后移，测试和文档都会乱。

不变量有两条：

1. **客户端依赖的是 \`code\`，不是英文句子。** 句子可以改翻译，\`code\` 改了就是破坏性变更。
2. **领域不知道 HTTP。** \`WalletService\` 不该 \`throw new HttpException\`。同一错误在队列里应变成重试或死信，在 HTTP 里才是 409。映射发生在边界。

## 2. 异常怎么冒到过滤器

Handler 可以是 async。返回的 Promise reject、同步 throw、RxJS Observable error，Nest 都会收到。管道在进 handler 前 throw（校验），守卫 throw（401/403），拦截器前半 throw——这些 **都能** 进过滤器，只要没被更内层的拦截器 \`catchError\` 吞掉。

默认若你一个 Filter 都没注册，HTTP 适配器走框架自带的 \`BaseExceptionFilter\`：\`HttpException\` 按它自带的 status 写回，其它东西变成 500。所以「我没写过滤器但 400 还能用」，是因为 \`ValidationPipe\` 抛的就是 \`BadRequestException\`，基类过滤器认识它。你一写 \`@Catch()\` 全捕获却忘了分支 \`HttpException\`，校验错误会全部变成 500——这是最常见的回归。

## 3. 异常是类型，不是字符串

\`throw 'fail'\`、\`throw new Error('db')\` 在 JS 里都能飞，过滤器没法稳定 \`instanceof\`。要让 \`@Catch(X)\` 工作，X 必须是 **值空间里的 class**。

\`\`\`ts
export class InsufficientFundsError extends Error {
  constructor(public readonly accountId: string) {
    super("insufficient funds");
  }
}

@Catch(InsufficientFundsError)
export class FundsFilter implements ExceptionFilter {
  constructor(private readonly http: HttpAdapterHost) {}

  catch(e: InsufficientFundsError, host: ArgumentsHost) {
    const { httpAdapter } = this.http;
    const ctx = host.switchToHttp();
    httpAdapter.reply(
      ctx.getResponse(),
      { code: "BALANCE_LOW", accountId: e.accountId },
      409,
    );
  }
}
\`\`\`

\`@Catch(A, B)\` 可以并列多个类。匹配按 **instanceof**，子类能被父类过滤器接住。因此 \`@Catch(Error)\` 几乎等于全捕获，会抢走更具体的过滤器——注册顺序和「更具体的类」都要设计，不要随手 Catch \`Error\`。

领域错误不要继承 \`HttpException\`。\`HttpException\` 是传输语义（status + payload）。领域一绑 HTTP，微服务和 cron 就得假装自己是浏览器。

## 4. @Catch() 全捕获必须再分支

\`@Catch()\` 不带参数 = 什么都接，包括 \`TypeError\`、\`QueryFailedError\`、第三方 SDK 的怪类型。正确形状：

\`\`\`ts
@Catch()
export class GlobalFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    if (e instanceof HttpException) {
      // 保持它自己的 status 和 payload 形状，必要时只包一层 requestId
      return this.replyHttp(host, e);
    }
    if (e instanceof InsufficientFundsError) {
      return this.replyDomain(host, e);
    }
    this.logUnknown(e, host);
    return this.replyInternal(host);
  }
}
\`\`\`

把所有东西都 \`String(e)\` 回给浏览器，等于把实现细节当成 API，也等于没有协议。全捕获的价值是 **兜底**，不是 **一种形状打天下**。

## 5. ArgumentsHost：同一过滤器，三种传输

\`host.getType()\` 可能是 \`http\`、\`rpc\`、\`ws\`。

- HTTP：\`switchToHttp()\`，用 \`HttpAdapterHost.httpAdapter.reply\` 写回，避免锁死 Express 的 \`res.status\` 或 Fastify 的 \`reply.code\`。
- RPC：\`switchToRpc()\`，抛 \`RpcException\` 或按微服务协议写错误包。直接 \`res.status\` 会炸。
- WS：\`switchToWs()\`，\`client.emit('error', { code })\` 再视情况 disconnect。

一套领域错误、三套序列化，是过滤器存在的理由——否则每个 Service 都要 \`if (isHttp)\`。全局过滤器里假设一定有 \`reply.status\`，是在用 HTTP 实现污染其它传输。

## 6. 洋葱顺序与拦截器抢异常

方法级 \`@UseFilters\` 比控制器级更内层，控制器级比全局更内层。先 \`app.useGlobalFilters(a, b)\` 时，后注册的更靠近 handler（与管道类似，以你当前 Nest 版本文档为准，写集成测试钉死，不要背口诀）。

一旦某过滤器 **已经写出响应**，外层通常看不到原始 throw，除非它再 throw。拦截器 \`catchError\` 若把错误吞成 \`of({ ok: false })\`，Observable 变成功，过滤器 **不会跑**。要明确分工：

- 协议错误（4xx/5xx 形状）→ 过滤器
- 局部补偿、改造成降级成功体 → 拦截器，并且这是有意的成功

两边各写一半，线上就是「有时有 code、有时是 200 包着 error 字符串」。

## 7. 校验错误是协议，不是业务

\`ValidationPipe\` 抛 \`BadRequestException\`，body 里是字段数组。这是 **HTTP 协议**：请求形状不对。过滤器应保持 400，最多加上 \`requestId\`。不要改成 200 再包 \`{ success: false }\`——缓存、网关健康检查、OpenAPI 客户端都会误判。

业务上的「优惠码无效」若是领域规则，用自己的类型 → 422 或 409 + \`code: 'COUPON_INVALID'\`。和 DTO 校验混成一坨 \`message: 'error'\`，前端无法穷举，后端无法打指标。

## 8. 未知错误：对内完整，对外最小

未捕获的 \`QueryFailedError\`、\`TypeError\` 必须：

1. 日志：stack、correlation id、user id（若有）、method+path、耗时。
2. 对外：\`{ code: "INTERNAL", requestId }\`，status 500。生产不回 \`e.message\`。
3. 指标：\`error_type=QueryFailedError\`，好做告警，而不是盯文案。

开发环境可以回 message，**分支要有测试**。有人把 debug 过滤器挂到 prod 模块，是事故不是配置风格。唯一约束冲突、外键失败，若要变成 409，应在基础设施适配器里 **翻译成领域错误再 throw**，而不是在全局过滤器里 \`if (e.code === '23505')\` 解析 Postgres——那会把 SQL 方言写进 HTTP 层。

## 9. 基类过滤器与 HttpException 形状

\`HttpException.getResponse()\` 可能是 string 或 object。全局过滤器若统一包 \`{ code, message, data }\`，要兼容这两种，否则框架自带的 404/405 形状被你拆掉。改形状等于改协议，要升版本并改客户端。

\`NotFoundException\`、\`UnauthorizedException\`、\`ForbiddenException\` 的 status 已经是语义。过滤器不要把 403 改成 401「免得暴露资源存在」——那是 Guard 的策略，应在 Guard 里决定 throw 哪一个，过滤器只忠实翻译。

## 10. 测试钉的是协议，不是句子

集成测试断言：

- status
- \`body.code\`
- 校验错误时 \`body.message\` 或 \`body.fields\` 的结构

不要断言 \`message === 'insufficient funds'\`。换语言包不该红测试。用 \`supertest\` 打真实 HTTP，同时测 Fastify 适配器——\`res.status().json()\` 在 Fastify 下不是同一条链。

## 11. 设计取舍

- **异常当控制流**：写起来快，调用栈清晰。热路径 throw 比返回 Result 贵，也更容易被中间件漏接。
- **Result 类型一路传回**：过滤器变薄。每个 Service 签名膨胀。
- **一个巨型全局 switch**：省文件。每个新错误都改核心模块。

更稳：领域模块带自己的 \`@Catch(DomainError)\`，AppModule 只挂「未知错误 + 透传 HttpException」。

## 12. 排障怎么问

1. 响应里有没有稳定 \`code\`？没有 = 过滤器没接上，或拦截器吞了。
2. status 500 但日志是校验失败？你的 \`@Catch()\` 没把 \`HttpException\` 分支出来。
3. 测试过了、生产堆栈泄漏？跑的是适配器默认处理器，全局 Filter 没 \`useGlobalFilters\` / 没进模块。
4. 微服务客户端收到普通对象？host 类型写死了 HTTP。
5. 偶发 409 变 500？领域错误被包进 \`InternalServerError\` 或 Promise 在拦截器里二次 throw。

## 13. 小结

过滤器把「失败」翻译成「协议」。原理是 **类型 → 状态码 + 对外形状**；对内才是日志和指标。领域不要知道 HTTP，传输不要知道 SQL，全捕获必须再分支，拦截器不要和过滤器抢同一类错误。

能回答「这个 throw 会变成什么 JSON、谁负责映射」，过滤器才算接上。`,


  "nestjs-typeorm-database-integration": `把 TypeORM 理解成「给 class 加 \`@Column\` 就能 CRUD」会在生产里立刻失效。装饰器只是映射。真正决定正确性和容量的是三件事：**连接活多久、事务从哪开始到哪结束、Entity 有没有漏出 HTTP 边界**。\`synchronize: true\` 能让本地表跟上 class，也能在生产把列删掉——这不是配置口味，是「谁拥有 schema」的问题。

Nest 只做一件事：把 TypeORM 的 \`DataSource\` / \`Repository\` 放进 IoC。它不替你开事务，不替你关懒加载，不替你算连接池。读完你应该能独立回答四个问题：为什么连续两个 \`await save\` 不是事务、多实例下池子怎么乘、请求级 QueryRunner 该不该做成 provider、Controller 能不能 \`return entity\`。

## 1. 先画边界：映射层不是领域层

\`@Entity()\`、\`@Column()\`、\`@ManyToOne()\` 描述的是 **表怎么存**。领域里的「订单已支付」可以是状态机；表里可能是 \`status\` 枚举加 \`paid_at\`。两者可以碰巧一对一，但 **没有义务一对一**。

一旦 Controller 直接 \`return orderEntity\`：

- \`passwordHash\`、内部标记位、乐观锁 version 进入 JSON
- 懒加载代理在 \`JSON.stringify\` 时触发查询，而且往往 **已经离开事务**
- 迁移加列变成破坏性 API：Swagger、前端、过滤器全绑在表上

正确形状：Repository 进出 Entity；应用服务返回 DTO / 只读模型；序列化拦截器只看见 DTO。Nest 的 \`ClassSerializerInterceptor\` + \`@Exclude()\` 是补丁，不是边界。补丁会漏。

## 2. DataSource 是进程内单例

\`TypeOrmModule.forRoot\` / \`forRootAsync\` 创建一份 \`DataSource\`（旧文档叫 Connection）。它拥有驱动、连接池、已加载的元数据。热路径上 \`new DataSource().initialize()\` 等于每个请求开池，数据库先死。

\`\`\`ts
TypeOrmModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    type: "postgres",
    url: cfg.getOrThrow("DATABASE_URL"),
    entities: [Order, Payment, User],
    synchronize: false,
    migrationsRun: false,
    extra: { max: 10 },
  }),
})
\`\`\`

连不上应让 **bootstrap 失败**。先 \`listen(3000)\` 再对每个请求 500，等于把未就绪的进程挂进负载均衡。

测试：\`getRepositoryToken(Order)\` override 成内存假仓库。不要让单元测试去连真实 Postgres，除非那是专门的集成任务。

## 3. forFeature：模块看见的仓库

\`TypeOrmModule.forFeature([Order])\` 在 **当前模块** 注册 \`Repository<Order>\`。别的模块要注入，必须 import 这个模块，并且这边 \`exports: [TypeOrmModule]\`（或导出封装过的服务）。这和普通 provider 的 export 规则一样：不 export 就看不见。

\`autoLoadEntities: true\` 会把各处 forFeature 过的实体收进 Root。省事，也容易把测试专用实体、一次性脚本实体扫进生产连接。显式 \`entities: [...]\` 可审。多数据库用第二个 \`forRoot\` + 自定义 name，再 \`forFeature([], 'analytics')\`。不要用全局变量切连接。

## 4. 连续 save 不是事务

默认自动提交下：

\`\`\`ts
await this.orders.save(order);
await this.payments.save(payment);
\`\`\`

两行是 **两次提交**。第一行成功、第二行唯一键冲突，库里会留下无支付的订单。进程在两行之间被杀，结果相同。

必须把两次写放进同一个工作单元：

\`\`\`ts
await this.dataSource.transaction(async (mgr) => {
  await mgr.getRepository(Order).save(order);
  await mgr.getRepository(Payment).save(payment);
});
\`\`\`

\`transaction\` 回调里要用 **回调参数 \`mgr\`**，不能再用注入的 \`this.orders\`——那是另一条连接，不在这事务里。这是最常见的「我包了 transaction 仍不一致」。

## 5. QueryRunner 的寿命

需要更细控制时：

1. \`const qr = dataSource.createQueryRunner()\`
2. \`await qr.connect()\`
3. \`await qr.startTransaction()\`
4. 干活 \`qr.manager.save(...)\`
5. commit 或 rollback
6. **\`await qr.release()\`** —— 把连接还回池

\`release\` 必须进 \`finally\`。泄漏一个 runner，池就少一条连接；泄漏完，全站 \`Timeout acquiring connection\`。

不要把 QueryRunner 存进 **单例** Service 字段。并发两个请求会共用同一事务，数据串了还以为是「偶发」。Request-scoped 的 EntityManager 看起来诱人（一请求一事务），代价是 **每个 GET 也开事务**，只读流量为写语义买单。更常见的纪律：写路径的应用方法显式开事务，读路径不包。

## 6. 身份映射与脏检查

同一 \`EntityManager\` / 同一事务里，\`findOne({ where: { id: 1 } })\` 两次，TypeORM 往往还给你 **同一个对象**。你改了 \`order.status\` 却忘了 \`save\`，commit 时仍可能被 flush 出去——Unit of Work 在跟踪脏字段。

跨请求、跨事务不要缓存 Entity 实例。缓存 id 和不可变快照。把 Entity 放进 \`Map\` 当请求级缓存，下一个请求看见的可能是过期字段，也可能是带懒加载陷阱的代理。

乐观锁：\`@VersionColumn()\`。\`save\` 时 version 对不上抛错。这是并发更新的协议，不是装饰。丢失更新比「偶发覆盖」更难查，版本列要把冲突变成明确失败。

## 7. 关系加载：懒、急、显式

\`eager: true\` 每次 find 都 join，列表接口会被撑爆。\`lazy: true\` 把 \`order.user\` 变成 Promise/代理，序列化时在 **事务外** 再查，于是 N+1 出现在响应阶段，日志里像「JSON 很慢」。

生产默认应关掉隐式懒加载。需要关联就写：

\`\`\`ts
await this.orders.find({
  where: { shopId },
  relations: { user: true, items: true },
  take: 50,
  skip: page * 50,
  order: { id: "DESC" },
});
\`\`\`

或 QueryBuilder 一次 join。\`find\` 不写 \`take\` 会把整表拉进 Node 堆。分页是协议：没有 \`take\` 的列表接口不该合并。

## 8. N+1 长什么样

\`\`\`ts
const orders = await this.orders.find({ take: 50 });
for (const o of orders) {
  o.user = await this.users.findOneByOrFail({ id: o.userId });
}
\`\`\`

1 + 50 次查询。打开 \`logging: true\` 或驱动日志，数 SELECT。修复是 join，不是加 Redis 把 50 次变成 50 次缓存命中。

QueryBuilder 不是「高级写法」，是你要控制 SQL 时的正道。ORM 生成的 SQL 你必须能读；读不懂就不要上生产。

## 9. 连接池怎么乘

公式：

**\`每个进程的 max\` × \`每实例进程数\` × \`实例数\` < \`数据库 max_connections\` − 留给管理任务的余量**

例：\`max: 10\`，每 Pod 1 进程，HPA 到 30 副本 = 300 连接。Postgres 默认 100 就会拒。Serverless 更狠：并发实例不可控。宁可请求排队等连接，也不要「连不上就再 new 一个 DataSource」。

只读副本：第二个 named DataSource，读走 replica，写走 primary。用全局 \`if (read) this.otherDb\` 散落各处，事务里会读到写库看不见的滞后数据——跨库事务你并没有。

池耗尽的症状是超时，不是立刻 500。监控 \`wait count\` 和 \`active connections\`，不要等用户投诉。

开发环境把 \`max\` 开到 50 毫无痛感，因为只有你一个人连。把这个数字原样带进 k8s，是把个人笔记本的舒适当成集群预算。池参数进配置中心，按环境覆盖，代码里写死 50 等于给未来的 oncall 留坑。

SQL 日志在 staging 打开一段时间，对着慢查询日志看 ORM 生成的语句有没有漏条件、有没有 \`IN (巨大列表)\`、有没有 \`SELECT *\`。TypeORM 的 \`logging: ['query', 'error']\` 和参数绑定日志会带密码风险，生产要采样或只打耗时超过阈值的语句，不要全量明文。

## 10. synchronize 与迁移

\`synchronize: true\`：启动时按实体改表。开发图省事。生产等于把 schema 所有权交给进程随机启动顺序——两个版本滚动发布时，A 加列、B 还在跑旧代码，或反过来 drop 列。

生产：\`synchronize: false\`，schema 只由 migration 改。CI：\`migration:run\` 先于或独立于应用发布。破坏性变更分两步：

1. 发布兼容读写（新列可空，旧列还在）
2. 确认无旧代码后再 drop

\`migrationsRun: true\` 让应用启动时自迁移，抢锁失败会成启动抖动。更干净的是 Job/Init Container 跑迁移，成功再起副本。

## 11. 级联与删除

\`cascade: true\` 让 \`save(order)\` 顺手 save items。方便，也容易一次写爆子树、或在未预期的路径上改到关联实体。删除用 \`onDelete: 'CASCADE'\` 还是应用层先删子，要写进设计：数据库级联快，但审计日志可能看不见「删了哪些行」。

软删 \`@DeleteDateColumn()\`：默认 find 会排除。忘记 \`withDeleted\` 的管理接口会「数据丢了」。唯一约束和软删一起用会踩「已删邮箱不能再注册」——需要部分唯一索引。

## 12. 事务隔离

默认 isolation 随驱动（Postgres 常是 Read Committed）。库存扣减、资金流水，要明确：

- 丢失更新：乐观锁或 \`UPDATE ... WHERE stock >= :n\` 看 affected rows
- 幻读：需要可重复读或串行时，显式 \`setIsolationLevel\`，不要假设默认够用

长事务里不要 await 外部 HTTP。连接被占着，池会尽，对方超时你还在 rollback。外调放事务外，用幂等键补。

## 13. save、insert、update 不是同一个动词

\`repository.save(entity)\` 会先看主键在不在：没有 id 就 insert，有 id 可能先 select 再 update（\`save\` 的 upsert 语义随版本和配置变化，你必须读自己锁定的 TypeORM 大版本文档，并写测试钉死）。它还会按级联去碰关联。列表里循环 \`save\` 五十次，就是五十轮脏检查和可能的多余 SELECT。

批量导入用 \`insert()\` / \`createQueryBuilder().insert().values(rows)\`。已知主键的补丁用 \`update({ id }, { status })\`，避免把整棵实体图 load 进来再 save。\`save\` 适合「内存里刚拼好的一棵小对象」。把三种 API 当同义词，日志里会出现「更新一行却扫了关联表」。

\`preload\` + \`save\` 常用来做 PATCH：先按 id 加载，覆盖 DTO 字段，再 save。注意未出现在 DTO 里的字段不要被 \`undefined\` 覆盖成 NULL——显式挑字段，不要 \`Object.assign(entity, dto)\` 无脑合并。

## 14. Subscriber 与实体钩子

\`@BeforeInsert()\` / \`@AfterUpdate()\` 以及 \`EntitySubscriberInterface\` 在同一工作单元里跑。用来填 \`createdAt\`、算哈希可以。用来发邮件、调 HTTP、丢队列，会把副作用绑进事务：rollback 了邮件却发出去，或 HTTP 超时拖死连接。

副作用放应用服务、放事务提交之后。Subscriber 里 throw 会导致当前事务失败，这是特性。不要在 Subscriber 里再开另一个 DataSource 写库，那是两套事务。

## 15. 测试与可替换性

领域测试 mock Repository 接口，不要 mock TypeORM 内部。集成测试起 Postgres（testcontainers 或 compose），跑 migration，测事务回滚和唯一约束。\`getRepositoryToken\` 是单元测试的缝，不是生产的抽象。

封装 \`OrderRepository\` 自己的类，把 QueryBuilder 藏起来，应用服务不 import \`typeorm\`——换 ORM 时改一处。过早封装和从不封装之间，至少不要让 Controller 碰 \`createQueryBuilder\`。

## 16. 排障怎么问

1. 有订单无支付？先看两次 save 是否同一 \`mgr\`，再看有没有 retry。
2. GET 特别慢？开 logging，数 SELECT；查有没有序列化触发懒加载。
3. \`Too many connections\`？用公式乘一遍，再看有没有 runner 没 release。
4. JSON 里出现 \`passwordHash\`？Entity 出了边界。
5. 滚动发布后缺列？synchronize 或迁移顺序反了。
6. 「偶发串数据」？单例上挂了 QueryRunner / EntityManager。

## 17. 设计取舍

- **Entity 当领域**：快。API 和表绑死。
- **每请求一事务**：写路径一致。读路径贵。
- **synchronize**：本地爽。生产把 schema 交给运气。
- **一个巨大 BaseRepository**：少重复。所有查询挤进基类，N+1 更难发现。

## 18. 命名、时区与 JSON 列

列名 \`namingStrategy\` 一旦在中途从默认改成 snake_case，现网列名和实体字段会对不上，迁移必须显式 rename，不能靠「换策略自动对齐」。时间戳统一 \`timestamptz\` + UTC；应用层不要有的地方 \`new Date()\` 有的地方字符串。JSON 列（\`jsonb\`）方便，索引和约束变弱：要查 JSON 里的字段，要么生成列 + 索引，要么承认这是文档，不走关系查询。

把「以后可能变」的结构塞进 jsonb，等于把 schema 藏进值。能用正规列就用正规列。

和 Prisma 那篇将要讲的差别，在这里先钉一句：TypeORM 以 **class 为真相**，运行时靠装饰器元数据拼 SQL；schema 漂移靠你自己的 migration 纪律。没有生成出来的客户端帮你在编译期拦住错字段名——错字段是运行时才炸。这不是谁更高级，是「约束发生在编译期还是运行期」。选 TypeORM 就要接受：SQL 必须可读、事务必须显式、实体必须停在边界内。

## 19. 小结

TypeORM 在 Nest 里是 **单例 DataSource + 模块级 Repository + 可选工作单元**。原理不是装饰器 CRUD，是：谁持有连接、哪几句 SQL 共事务、哪一种对象允许越过 HTTP。事务必须用同一个 manager；实体必须停在适配器内侧；池按「进程 × 副本」乘完小于数据库上限。

能回答「这两次写在不在同一事务里、这个对象会不会被 JSON.stringify 顺带查库」，这一层才算接上。`,


  "nestjs-prisma-orm-modern-data-access": `Prisma 不是「更现代的 TypeORM 语法」。它是 **schema-first 的客户端生成器**：\`schema.prisma\` 是唯一真相，\`prisma generate\` 产出 TypeScript 类型和查询函数，\`prisma migrate\` 产出 SQL 迁移。你在编辑器里点出来的 \`prisma.user.findMany\`，运行时并不存在一份手写的 Repository 类，而是生成物。和 Nest 整合时，框架只负责 **这份客户端的寿命**：何时 \`$connect\`、何时 \`$disconnect\`、怎样注入、怎样在测试里替换。热路径上 \`new PrismaClient()\` 等于每个请求开池，RDS 会先于业务死掉。

上一篇 TypeORM 以 class 为真相，错字段名运行时才炸。Prisma 把约束前移到编译期：schema 没有的字段，TS 会红。代价是动态表、运行时拼 SQL 的自由度更低。读完你应该能独立回答四个问题：为什么 \`PrismaService\` 必须单例且实现 \`OnModuleInit\`、交互式事务里为什么不能 await 外部 HTTP、\`include\` 打满是不是 N+1 的另一种写法、\`db push\` 为什么不能上生产。

## 1. 先画边界：schema 管形状，Nest 管寿命

\`model User { id String @id email String @unique }\` 同时决定表和客户端类型。改字段必须改 schema 再 migrate，不能靠运行时「猜测列」。这和 TypeORM「装饰器 class 是真相」相反。

好处：前后端可以共享生成类型（或至少后端 DTO 从生成类型 \`Pick\`）。坏处：没有 schema 的表 Prisma 看不见；复杂跨库、临时表、极度动态的报表，要承认走 \`\$queryRaw\` 或视图。

Nest 里正确姿势是 **一个** 可注入客户端：

\`\`\`ts
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      log: [{ emit: "event", level: "error" }, { emit: "event", level: "warn" }],
    });
  }
  async onModuleInit() {
    await this.\$connect();
  }
  async onModuleDestroy() {
    await this.\$disconnect();
  }
}
\`\`\`

\`onModuleInit\` 连不上应让 bootstrap 失败。先 listen 再对每个请求 500，等于把未就绪进程挂进负载均衡。\`onModuleDestroy\` 必须还连接，否则滚动发布会留下半开连接直到数据库超时。

## 2. generate、migrate、db push 是三件事

- **\`prisma generate\`**：读 schema，生成 \`node_modules/.prisma/client\`。CI 镜像里必须跑，否则运行时「方法不存在」或类型与二进制不匹配。
- **\`prisma migrate dev\`**：开发时改 schema、生成迁移 SQL、应用到开发库。会写 \`prisma/migrations/\`。
- **\`prisma migrate deploy\`**：生产只应用已有迁移，不改 schema 文件、不交互提问。
- **\`prisma db push\`**：不写迁移历史，直接把 schema 推到库。适合原型。生产用它等于没有可回放的 schema 历史，滚动发布无法推理。

版本必须一致：schema、生成的 client、运行时 \`@prisma/client\` 三个对不上，就会出现「类型有、运行时没有」或反过来。Docker 多阶段构建漏了 generate，是冷启动 \`table does not exist\` / \`undefined is not a function\` 的常见原因。

## 3. 查询按模型走，不是任意 join

\`prisma.order.findMany({ where: { shopId }, include: { items: true } })\` 写错字段名会红。这是编译期约束，不是性能神话。

\`select\` 限制列，避免把 \`passwordHash\`、refresh token 选出来。这和 Nest DTO 同一思想：查询形状就是对外形状的上限。默认 \`findMany\` 不写 \`take\` 会把整表拉进 Node 堆。分页是协议。

复杂报表（六表聚合、窗口函数）不要用 include 树硬拧成一棵图再在内存 group。用 \`\$queryRaw\`、数据库视图或独立读模型。Prisma 擅长「按模型的 OLTP」，不擅长「任意 SQL 的 OLAP」。硬拧的结果是内存和超时，不是类型安全。

## 4. include 打满仍是 N+1 的亲戚

\`include: { items: true, user: true, user: { include: { profile: true } } }\` 看起来一次调用，引擎可能拆成多条 SQL（视版本和关系而定）。列表 50 单、每单 20 行 item、再带 user.profile，就是一张巨大的图进堆。

列表接口：\`select\` 只要卡片字段；详情接口再 include。不要用同一套 \`include\` 打所有 API。循环里 \`for (const o of orders) await prisma.user.findUnique({ where: { id: o.userId } })\` 是经典 N+1，和 TypeORM 懒加载同源，只是写法更诚实。

\`findUnique\` + 唯一索引才是 O(1) 点查。用 \`findFirst\` 当唯一查，会让优化器走扫描，也让「没有唯一约束」的数据静默返回任意一行。

## 5. 事务：批式 vs 交互式

**批式** \`prisma.\$transaction([prisma.a.update(...), prisma.b.create(...)])\`：引擎按数组顺序执行，中间你插不进 JS。适合已知步骤、无分支。失败整批回滚。

**交互式** \`prisma.\$transaction(async (tx) => { ... })\`：回调里多次 \`await tx.order.update\`，能读自己刚写的行、能 if。**占用一条连接直到回调结束。** 因此回调里不要：

- \`await fetch(支付网关)\`
- \`await sleep\`
- 再开一层长事务
- 处理无界循环

超时用 \`timeout\` / \`maxWait\` 显式设。等连接的时间和事务执行时间是两笔账：池满时 \`maxWait\` 先炸。

失败回滚是引擎的事。你在回调里 \`catch\` 掉错误还不 throw，Prisma 可能提交。要让错误冒泡。翻译 Prisma 错误码（\`P2002\` 唯一冲突）应在适配器变成领域错误，不要让 Controller 去 \`if (e.code === 'P2002')\`。

交互式事务里必须用 **\`tx\`，不能用 \`this.prisma\`**。用外层 client 等于跑到事务外，和 TypeORM 里 \`transaction\` 回调仍用 \`this.orders\` 是同一个坑。

## 6. 嵌套写

\`prisma.order.create({ data: { items: { create: [...] } } })\` 一次把聚合根和子行写进去，常包在同一事务。方便，也容易一次写爆校验：子行失败，整单回滚，错误信息要从 \`meta\` 里挖。

更新聚合用 \`deleteMany + create\` 替换子集合时，要清楚这是「先删后插」，id 会变，外键和审计会断。需要稳定子行 id 就用 \`upsert\` / 显式 diff。

## 7. 连接池：乘完必须小于数据库上限

URL 查询串：\`connection_limit\`、\`pool_timeout\`。公式与 TypeORM 相同：

**每个进程的 limit × 每实例进程数 × 实例数 < max_connections − 余量**

HPA 到 30 副本、limit=10，就是 300 连接。Postgres 默认 100 会拒。宁可请求等池，不要「连不上再 new Client」。

Serverless（Lambda）进程复用时 Client 可放在全局，但 **并发实例数不可控**。要 Prisma Accelerate / Data Proxy，或 PgBouncer。

PgBouncer **transaction 模式** 与 Prisma 的 prepared statement 会打架（\`prepared statement already exists\`）。常见解法：连接串加 \`pgbouncer=true\`、或改 statement 模式、或让 Prisma 不用持久 prepared。这不是「换个 URL 就好」，要按官方矩阵选。本地直连 Postgres 绿、预发过 Bouncer 红，优先怀疑这一层，而不是怀疑 schema。

连接泄漏比「limit 设小了」更常见：交互式事务在 \`finally\` 前 throw 到没人管的 Promise、或 Nest 热重载不走 \`onModuleDestroy\`。开发里反复 \`nest start --watch\` 把本地 Postgres 连接打满，看起来像 Prisma 的 bug，其实是进程没把池还回去。度量 \`numbackends\`，不要只看应用日志。

## 8. 只读副本与延迟

第二个 \`PrismaClient\` 指 replica URL，读走它、写走 primary。跨请求的「刚写入立刻读」可能读到滞后。事务里的读必须走 primary。用全局 flag 随手切，会在「下单后立刻查订单」的路径上制造幽灵。

## 9. 扩展与中间件

\`\$extends\` / 旧 \`\$use\` 可做软删（默认 \`where.deletedAt = null\`）、租户隔离（强制 \`tenantId\`）、查询耗时日志。它们跑在每个查询上，写错会静默丢数据（软删漏了管理后台的 \`withDeleted\` 等价物）。

租户中间件不是安全边界的全部：漏掉的 raw query 不会带租户条件。\`\$queryRaw\` 要自己拼 \`tenant_id\`。安全模型不能只活在扩展里。

日志：\`\$on('query')\` 全量会打爆磁盘并带参数（可能有 PII）。生产按耗时阈值采样。

## 10. 错误码是协议的一部分

\`P2002\` 唯一冲突、\`P2025\` 记录不存在、\`P2003\` 外键。适配器把它们变成领域类型，过滤器再变成 409/404。不要把 Prisma 的 \`message\` 直接回给浏览器——里面有表名、约束名。

\`findUniqueOrThrow\` / \`findFirstOrThrow\` 失败即 throw。调用方必须当异常路径测，或改用 \`findUnique\` 自己判断 null。

## 11. 和 Nest 模块怎么切

\`PrismaModule\` global export \`PrismaService\` 很常见，因为几乎每个 Feature 都要用。代价：测试要 override 一个巨型客户端，所有模块耦合同一实现。

更稳：领域模块只依赖自己的 \`OrderStore\` 接口；\`PrismaOrderStore\` 放 infrastructure，\`PrismaModule\` 不必 global。写路径多的团队，这个缝值回测试时间。写路径少、人少，global 单例也能活，但不要让 Controller 直接 \`this.prisma.user.findMany\`。

## 12. 游标分页与稳定顺序

\`skip/take\` 在大 offset 时越来越慢，因为数据库仍要扫过前面的行。公开列表用游标：\`cursor: { id: lastId }, skip: 1, take: 20, orderBy: { id: 'asc' }\`。\`orderBy\` 必须稳定（带唯一列），否则同一页会抖。\`skip: 1\` 是为了不含游标自身。

无限滚动 API 把游标当协议：不透明字符串（id 或 \`id+createdAt\` 编码），不要把 SQL offset 暴露给客户端乱改。

复合唯一：\`@@unique([tenantId, email])\`。\`findUnique\` 必须用生成的复合键名字，漏租户就会变成「全局邮箱唯一」，和产品设计相反。

## 13. Raw 查询的责任

\`\$queryRaw\` 用 tagged template 防注入：\`prisma.\$queryRaw\`\`SELECT * FROM orders WHERE id = \${id}\`\`\`。拼字符串 \`\$queryRawUnsafe\` 把注入交还给你。动态列名、动态表名无法参数化，必须白名单。

Raw 查询绕过 \`\$extends\` 的软删和租户条件。每次 raw 都要自己写 \`deleted_at IS NULL AND tenant_id = ...\`。代码评审把 raw 当敏感点。

## 14. 迁移纪律

发布流水线：\`migrate deploy\` 失败则 **不发** 应用。破坏性变更分两步：先加新列兼容读写，再删旧列。\`migrate resolve\` 是急救，不是日常。多人同时 \`migrate dev\` 会分叉历史，要线性 rebase 迁移文件，和 Git 冲突一样处理。

种子数据 \`prisma db seed\` 只进开发/预发，不要在生产 migrate 时偷偷 insert。

迁移文件是正向历史，不是「现在库的样子」。有人在生产手工 ALTER 再 \`migrate resolve\`，历史和真实库会分叉，下一趟 deploy 可能试图加已经存在的列。纪律是：生产 schema 的每一笔变化都来自仓库里的 SQL。手工急救之后，要把等价迁移补进仓库并 resolve，而不是假装没发生过。

开发库可以重建；生产库不能。\`migrate reset\` 是开发按钮，放到脚本里而不加保护，CI 打错环境就是删库。环境变量和命令要分文件：\`deploy\` 给生产，\`reset\` 只给 local compose。

## 15. 测试

单元：mock \`OrderStore\`，不 mock Prisma 内部。集成：testcontainers Postgres，\`migrate deploy\`，跑唯一约束和事务回滚。不要在单元测试里 \`new PrismaClient()\` 打真实库。CI 用独立 schema 或独立库，避免并行测试互相锁。工厂函数造数据时走 Prisma 客户端而不是 raw INSERT，才能吃到默认值和中间件；两边混用会出现「测试里有 deletedAt、生产查询却看不见」的假绿。

## 16. 排障怎么问

1. 冷启动 \`table does not exist\`？镜像没跑 migrate，或连错库。
2. 类型有、运行时没有？generate 没进镜像，或多版本 \`@prisma/client\`。
3. 偶发 timeout？交互式事务里有外部 IO，或池算超了。
4. 内存涨？\`findMany\` 无 take，或 include 过深。
5. \`P2002\` 变成 500？错误没在适配器翻译。
6. 刚写入读不到？读走了 replica，或事务外 client 与 \`tx\` 混用。
7. PgBouncer 报 prepared statement？模式与 Prisma 不匹配。

## 17. 设计取舍

- **schema-first**：编译期拦住错字段。动态 SQL 要另开门。
- **global PrismaService**：少样板。测试和边界变糊。
- **一切 include**：开发快。列表接口把图拉进堆。
- **交互式事务里调支付**：代码好读。连接被占、超时滚成事故。
- **db push 上生产**：当时能跑。没有可回放历史。

和 TypeORM 比：Prisma 强在生成类型和迁移线性；TypeORM 强在更随意的 QueryBuilder 和现成装饰器生态。选的是约束发生的时刻，不是谁「更 Nest」。

Preview feature（如某些驱动的扩展类型）不要默默开在生产 schema 里还不写进 README。升级 Prisma 大版本时 preview 可能改名或删除，构建会红。把它当契约：和 \`package.json\` 的 Prisma 版本一起锁。

多 schema（\`schemas = ["public", "audit"]\`）能隔离审计表，客户端会生成带 schema 的模型。权限在数据库角色上仍要配，Prisma 不会替你做 RLS；需要行级安全时在 Postgres 策略里写，Prisma 只是路过。

## 18. 小结

Prisma 的原理是 **schema 生成客户端**。Nest 只负责构造、连接、销毁和注入。查询按模型；事务占连接且必须用 \`tx\`；池按集群乘；错误码在适配器翻译；\`migrate deploy\` 拥有生产 schema。能回答「这个查询会生成几条 SQL、这条事务占着连接期间还在等什么、生产 schema 的上一笔变化来自哪条迁移」，这一层才算接上。选 Prisma 是选 **约束发生在编译期和迁移历史里**，不是选一套更短的 CRUD API。`,



  "nestjs-swagger-openapi-documentation": `Swagger 模块能成为契约，也能成为谎言。它扫 Controller 上的装饰器和 DTO 上的元数据，生成一份 OpenAPI JSON。前端用它生成 SDK，网关用它做校验，测试用它当用例。若这份 JSON 和运行时真实响应不一致，三方会一起错，而且错得「有文档为证」——比没有文档更贵。

\`@nestjs/swagger\` 不是「给接口写说明书的 UI」。UI 只是皮肤。原理是 **元数据 → OpenAPI schema**。元数据和 \`ValidationPipe\` 用的 class、过滤器返回的 \`code\` 必须是同一份真相。读完你应该能独立回答四个问题：为什么 Entity 不能当 \`@ApiOkResponse\`、插件推断失败时长什么样、生产要不要挂 Swagger UI、\`openapi.json\` 该不该进 CI 制品库。

## 1. 先画边界：文档是生成物，运行时不会反过来改文档

\`@ApiProperty\` 描述字段。\`@ApiOkResponse({ type: OrderDto })\` 描述 200。\`@ApiBearerAuth\` 描述安全方案。这些是 **编译期/启动期扫到的装饰器**，不是运行时拦截器根据真实 JSON 反推的。

Service 里多 return 一个字段，文档不会自己长出来。过滤器把 409 的 body 改成 \`{ code, accountId }\`，装饰器还写着 \`{ message: string }\`，SDK 就按旧形状解析。

正确流程只有一条链：

**DTO 是唯一形状 → Pipe 校验输入 → 序列化保证输出 → Filter 保证错误形状 → Swagger 描述同一份 DTO 和同一份错误。**

三处各写各的，文档必谎。\`ClassSerializerInterceptor\` + \`@Exclude()\` 不能当这条链的替代：漏一个字段，文档和运行时仍会分叉。

## 2. DocumentBuilder 与 setup 做了什么

启动时 \`SwaggerModule.createDocument(app, config)\` 遍历已注册的路由和元数据，拼出 OpenAPI 对象。\`SwaggerModule.setup('docs', app, document)\` 挂 UI 和 json。这发生在 **进程里**，每次启动或每次调用 createDocument 时。

它看不到「运行时才决定的」字段：根据用户角色多吐一个 \`adminNote\`，schema 表达不了，除非你用 oneOf / 两个 DTO。动态键的 \`Record<string, unknown>\` 会退化成 \`object\`，调用方以为没有字段约定。

\`DocumentBuilder.setTitle/setVersion/addBearerAuth\` 只是封面和 security scheme。scheme 的 **name** 必须和 Guard 读的 header 一致。UI 里填了 token 仍 401，经常是 \`Bearer\` vs \`bearer\` vs 自定义 header 名对不上。多个 scheme（Cookie session + Bearer）要在 operation 上声明实际接受哪一种，全局乱挂会导致 SDK 每次请求带错头。

\`servers\` 列表决定 SDK 默认 baseURL。留着 \`http://localhost:3000\` 进生产制品，移动端会打开发者笔记本。按环境生成三份 json（dev/staging/prod）或用变量替换，不要一份走天下。

## 3. 插件与手写的分工

CLI 插件（\`@nestjs/swagger\` plugin）从 TypeScript 类型和 class-validator 装饰器推断 \`required\`、\`minimum\`、\`nullable\`。省大量 \`@ApiProperty\`。这是生产力，不是准确性保证。

推断失败的典型：

- 循环引用（\`OrderDto.items: OrderItemDto[]\`，item 又指回 order）
- 泛型 \`Paginated<T>\` 没正确展开
- \`PickType\` / \`OmitType\` / \`IntersectionType\` 组合过深
- 联合类型、枚举没 \`@ApiProperty({ enum })\`

失败时长什么样：schema 里是 \`{}\` 或 \`object\`，UI 显示空字段。调用方以为接口没有 body。CI 里应对生成 json 做「空 object 检测」，不要等人在 UI 里发现。

手写 \`@ApiProperty\` 在失败点补刀。不要全项目关插件又不全写装饰器——那是「看起来有文档」。

插件要进 \`nest-cli.json\` 的 compilerOptions，CI 的 \`nest build\` 必须走同一份配置。有人本地开了插件、CI 没开，制品 json 比开发机瘦一圈，联调只在本地绿。反过来 CI 开了、本地没开，你会觉得「文档怎么多了字段」。把 nest-cli.json 当契约，和 tsconfig 一样锁。

## 4. extraModels：嵌套类型必须进文档图

\`@ApiOkResponse({ type: OrderDto })\` 只把 \`OrderDto\` 当根。\`items: OrderItemDto[]\` 若 \`OrderItemDto\` 从未出现在任何 Controller 的 type 上，又没 \`extraModels: [OrderItemDto]\`，生成器可能输出 \`array\` of empty。

嵌套越深越容易漏。分页包装 \`{ items, total, page }\` 必须把 \`PaginatedOrderDto\` 和 \`OrderDto\` 都挂上。宁可 extraModels 写长，不要让 SDK 生成 \`any[]\`。

数组的 \`minItems\` / 元组、字符串 \`format: date-time\` 不写，SDK 会把日期当普通 string，时区问题要到运行时才炸。能在 schema 里表达的约束，不要只写在 Pipe 里或只写在 example 里——三处只有一处严，就是谎。

enum 用 TS enum 或 \`as const\` 数组，并在 \`@ApiProperty({ enum: OrderStatus })\` 显式挂上。纯 union \`'a' | 'b'\` 插件有时收得住、有时收成 string。收成 string 之后，后端改枚举前端无感，直到生产出现新值。

## 5. Entity 当 Response 是最贵的谎

\`@ApiOkResponse({ type: UserEntity })\` 会把 \`passwordHash\`、\`deletedAt\`、内部 version 写进公开文档。就算运行时拦截器剥掉了，文档仍在教攻击者和前端「这些字段存在」。迁移加列，文档自动变，API 承诺跟着表走。

输入同理：\`@Body() user: UserEntity\` 等于允许 mass assignment 的形状出现在文档里。DTO 是协议，Entity 是存储。Swagger 只该看见 DTO。

## 6. 错误码也是契约

只写 200 的文档不配叫契约。401/403/404/409/422 用 \`@ApiResponse({ status, type: ErrorDto })\` 挂上，且 \`ErrorDto\` 必须和全局过滤器写出的 JSON **同一 class**。

前端才能从 SDK union 穷举 \`code\`。过滤器改了形状、装饰器没改，SDK 解析失败或忽略新字段。把错误当「UI 里随便写点说明」的人，会在联调时用 console.log 当契约。

校验错误（400 + 字段数组）和领域错误（409 + \`BALANCE_LOW\`）不要合成一个 \`message: string\`。文档里要两套 schema，和上一篇过滤器的分层一致。

## 7. 生成器表达不了的东西

\`any\`、\`Map\`、\`Buffer\`、函数、循环类型、运行时才知道的键，生成器会退化。文件上传必须 \`@ApiConsumes('multipart/form-data')\` + 手工 \`schema\`。SSE、chunked 流、WebSocket 网关 **不是** 这份 OpenAPI 能完整描述的；硬生成一份假 REST，只会让 SDK 去 GET 一个不存在的流。

承认边界：REST 用 OpenAPI；WS 用 AsyncAPI 或单独文档；流式用散文 + 示例帧。比一份全能但假的 json 好。

## 8. operationId、tags 与 SDK 方法名

生成器靠 \`operationId\` 给函数起名。不写时用 \`Controller_method\` 拼接，重载和版本一多就会 \`orderControllerCreateV2\` 这种噩梦。显式 \`@ApiOperation({ operationId: 'createOrder' })\` 是给 SDK 的稳定符号，改它等于改客户端方法名。

\`@ApiTags('orders')\` 只是文档分组，不是路由前缀。前缀在 Controller \`@Controller('orders')\`。两者不一致时，人看 tags、机器看 path，联调各说各话。

\`summary\` 给列表，\`description\` 给语义（幂等、副作用、限流）。空 description 的突变接口，SDK 用户会当 GET 用。

## 9. example 不是 schema

\`@ApiProperty({ example: '13800001234' })\` 只是 UI 里的示例，**不约束**运行时。约束是 \`@IsMobilePhone()\` 和 schema 的 \`pattern\`。只写 example 不写 validator，文档看起来严，Pipe 却放行任意字符串。

反过来，validator 很严、schema 很松，契约测试按文档放行的请求会被 Pipe 400。example 必须是合法实例，最好从同一套常量来。

## 10. 多态：oneOf 与鉴别字段

\`PaymentDto\` 可能是卡、余额、钱包。TypeScript 联合类型生成器经常退化成 \`object\`。要显式 \`@ApiExtraModels\` + \`oneOf\` / \`discriminator\`（\`type\` 字段）。没有鉴别字段，客户端无法收窄类型，等于没有联合。

返回 201 和 200 不同 body 时，不要只标 200。创建接口漏 201，SDK 会按错误 status 解析。

## 11. Header、Cookie、文件与分页

\`@ApiHeader\`、\`@ApiCookie\` 描述的鉴权/追踪字段，必须和 Guard、拦截器实际读取的名字一致。\`x-request-id\` 文档里有、中间件不写，链路追踪会断。

分页：\`{ items, total, page, pageSize }\` 应是共享 \`PaginatedDto<T>\`，不要每个列表手写一份导致 \`count\` vs \`total\` 混用。文档一乱，前端三种分页组件并存。

文件：\`multipart\` 的字段名、是否多文件、大小上限，OpenAPI 写不全的部分用 description 写死，并在 Pipe 里强制。只信文档不限大小，会变成内存炸弹。

## 12. 版本与破坏性变更

\`DocumentBuilder.setVersion('2.1.0')\` 应和发布版本一起变。字段改名、错误 code 改名、必填变可选，都是破坏性变更，升 major 或走 \`/v2\`。OpenAPI 的 \`servers\` 写出真实网关地址，不要留 \`localhost:3000\` 进生产制品。

多版本并存时，两份 document、两个 setup 路径，或用文档里的 tags 分组但 URL 仍带 \`/v1\`。不要靠「口头告诉前端这次加了字段」。

## 13. 生产开不开 UI

Swagger UI 是攻击面：扫路径、试 payload、看到内部模型。生产可关 \`setup\`，仍在内网或构建时导出 \`openapi.json\`。文档站点用静态 json 部署，不要让生产集群当 Swagger 服务器（还带「Try it out」打真实库）。

若必须在生产开 UI：Basic Auth 或 SSO、关掉 try、限制 IP。token 填进 UI 等于把生产凭证放进浏览器密码管理器，要当事故演练。

内网文档站仍要用 SSO。『只有公司网络』挡不住离职账号和转发截图。json 制品进私有 registry，权限跟代码仓库走，不要扔在公开对象存储里还以为「反正没有 UI」。

字段要删时，先标 \`deprecated: true\` 并保留一个发布周期，SDK 才会警告。直接从 schema 消失，旧客户端仍会发这个字段，Pipe 若 \`forbidNonWhitelisted\` 会突然 400。文档上的 deprecated 必须和运行时策略同一天生效，或明确写「文档先警告、下一版才 forbid」。改名等于删+加。不要指望生成器理解 \`oldName → newName\`。过渡期两个字段都收，响应里只出新名，文档写清楚。

## 14. CI：json 才是制品

流水线跑 \`createDocument\`（或启动后 curl \`/openapi.json\`）把文件存进制品库。前端 \`openapi-generator\` / \`orval\` / \`openapi-typescript\` 用 **同一份文件**，不要各人在本地 \`next dev\` 扫一次后端。

PR 里 diff json。字段消失、类型从 string 变 number，比 diff 装饰器可读。契约测试（Schemathesis、Dredd、自写快照）打这份 json：响应必须符合 schema。文档谎了，CI 红，而不是用户红。

生成器版本要锁。同一份 OpenAPI，generator 大版本不同，发出的客户端类型可能不同。把 \`openapi.json\` 的 hash 写进前端仓库或用包版本发布 \`@org/api-types\`。前端 lock 这份 hash，后端破坏性变更必须 bump 包版本——和改 npm 依赖同一纪律。不要「后端先发、前端明天再生成」。

契约测试不必一上来上大框架。最小可用：启动应用，\`GET /openapi.json\`，对关键 path 做快照；再抽几条真实请求，用 json schema 校验响应。快照变了 PR 必须有人解释，不能默默更新。

## 15. 和 Pipe、Filter、Guard 对齐的检查表

发布前人工或脚本问：

- 每个 \`@Body()\` 的 class 是否出现在 schema
- 每个 \`@ApiOkResponse\` 的 class 是否就是拦截器序列化后的 class
- 每个 Guard 可能 throw 的 status 是否有 \`@ApiResponse\`
- Bearer 名称是否与实际 header 一致
- 文件上传是否有 consumes
- 有没有 \`Entity\` 出现在 Response 类型里（grep）

这张表比「文档页做得漂不漂亮」重要。

公开文档和内部文档应是两份 generate：内部含管理端、含错误细节；公开剥掉内部 path、剥掉示例里的真实手机号。用同一份 json 给外部合作方，等于把后台路由图送人。

## 16. 排障怎么问

1. UI 里字段是空的？嵌套 DTO 没进 extraModels，或插件推断失败成 \`{}\`。
2. 实际 JSON 多字段？return 了 Entity，或拦截器没剥干净。
3. 前端类型和后端不一致？生成器吃的不是这次构建的 json，或本地扫了另一套装饰器。
4. 鉴权在 UI 里试不通？security scheme 的 name 和 Guard 不一致。
5. 校验 400 的结构对不上文档？Filter 改过 payload，装饰器没改。
6. 循环引用导致启动慢或栈溢出？拆 DTO，不要让 schema 图成环还不 \`extraModels\` 处理。

## 17. 设计取舍

- **插件推断**：少装饰器。失败时静默空 object，要用 CI 抓。
- **全手写 @ApiProperty**：可控。和 class-validator 重复，易漏改。
- **Entity 当文档类型**：当时最快。表结构变成公共 API。
- **生产开 UI**：调试爽。攻击面和凭证风险。
- **文档只给人看**：写得好看。机器（SDK/网关/测试）用不上，契约仍靠嘴。

启动时 \`createDocument\` 对超大单体可能要几百毫秒甚至数秒，全量扫元数据。不要每个请求生成一次。缓存 document 对象；测试里可以每次生成以便抓回归。

## 18. 小结

OpenAPI 的原理是 **装饰器与类型元数据在启动时收成一份 schema**。价值来自和运行时 DTO、Pipe、Filter **同源**。UI 是皮肤；\`openapi.json\` 才是协议。空 object、Entity 入文档、只写 200、生产 Try it out，都是在签一份假合同。

能回答「这份 json 是哪次构建扫出来的、和现在线上 JSON 是否同一 class、错误码和 Filter 是否同一份 ErrorDto」，文档才算接上。谎的文档比没有文档更贵：它会通过 SDK 把谎言编译进客户端。`,



  "nestjs-websocket-realtime-gateway": `WebSocket 网关和 HTTP Controller 长得像：装饰器、Guard、方法名。生产里它们完全不是一类系统。HTTP 是短请求，失败有 status；WS 是 **有状态的连接集合**，失败可以静默（半开 TCP、NAT 假活）。扇出是内存和事件循环问题，水平扩展必须面对「房间在哪台机器上」。把「发个通知」写成 \`server.emit\` 而不问连接表在哪，线上会以「偶发收不到」的方式失败，而且很难复现。

Nest 只把事件名映射到方法。适配器（ws 或 socket.io）管帧、upgrade、ping。房间业务表、在线人数、权限、多机同步，框架都不替你做。读完你应该能独立回答四个问题：鉴权为什么必须在 handshake 做、为什么 token 过期连接还可能活着、单进程万人房间会先打满哪条线程、没有 Redis adapter 时两副本之间发生什么。

## 1. 先画边界：传输是长连接，方法只是回调

\`@WebSocketGateway()\` + \`@SubscribeMessage('join')\` 把事件名映射到方法。\`handleConnection\` / \`handleDisconnect\` 是连接寿命钩子，不是 HTTP 的 \`OnModuleInit\`。

\`Server#to(room).emit\` 背后是遍历该房间里的 socket。连接对象活在 **本进程内存**。进程退出、滚动发布、OOM，房间就没了。HTTP 的无状态假设在这里不成立。

用户「在线」是连接寿命，不是 JWT 寿命。token 过期后 TCP 可能还开着，handler 仍会跑。必须自己踢：定时校验、或过期后只读不写、或强制 disconnect。把 session 当 HTTP 那样「下次请求再验」，WS 没有下次请求。

Nest 的 Gateway 默认和 HTTP 应用共用一个进程、一个事件循环。WS 的重活会拖慢 HTTP P99，HTTP 的同步 JSON 大包也会拖慢心跳。流量大时把 Gateway 拆成独立进程甚至独立部署，HTTP 只负责握手鉴权发短时 ticket，WS 进程只认 ticket。混部图省事，容量模型却绑死。

\`@WebSocketGateway({ transports: ['websocket'] })\` 关掉轮询降级，避免容量按 HTTP 算还自以为是长连接。需要穿透老代理再显式打开，并单独监控轮询连接数。

不变量：**谁持有连接表，谁就能广播。** 表在内存，广播就在本机；表要跨机，必须有适配器或外部总线。

## 2. 握手是唯一干净的鉴权点

upgrade 时带 cookie、\`Sec-WebSocket-Protocol\`，或（不推荐）query。失败 **直接断**，不要先连上再等第一条 \`auth\` 消息。连上再鉴权会留下匿名 socket：不发消息也占 fd、占内存，还能对房间灌垃圾。

\`\`\`ts
async handleConnection(client: Socket) {
  const user = await this.auth.fromHandshake(client);
  if (!user) {
    client.emit("error", { code: "UNAUTHENTICATED" });
    return client.disconnect(true);
  }
  client.data.userId = user.id;
  client.data.connectedAt = Date.now();
}
\`\`\`

query token 会进访问日志和 Referer，优先 cookie 或 protocol 头。CORS / 允许的 Origin 在网关配置里钉死，不要 \`*\` 还带凭证。

\`@UseGuards\` 仍可用于 \`SubscribeMessage\`，挡的是「已连接之后的事件」，挡不住「连着不说话」。连接上限、按用户 / IP 限连，要在握手或反代做。同一用户多设备：允许几个 socket，踢最旧还是拒绝最新，是产品决策，要写进 \`handleConnection\`。

## 3. 心跳两层，缺一不可

**协议层** ping/pong：发现死连接、让中间 NAT 保活。socket.io 有自己的 pingInterval/pingTimeout；原生 ws 要自己设。

**业务层** 在线：最后一次活动时间、设备维度、用户维度。只靠 TCP keepalive 不够——NAT 会让半开连接假活，对端已经没了，你还以为在房间里。定时扫 \`lastSeen\`，超时 \`disconnect\`，并从房间集合删除。

心跳不要当业务消息打进房间广播。心跳打满日志会把磁盘和指标打穿。计数用 gauge：连接数、房间数、每房间人数。

## 4. 房间是标签，不是消息队列

\`join(room)\` 把 socket id 放进一个 Set。\`to(room).emit\` 是 O(人数) 遍历。万人房间在单进程会把事件循环打满：心跳延迟、新连接握手变慢，看起来像「服务器没 CPU 了」，其实是同步遍历太长。

该分片（按房间哈希到不同进程）、该用独立广播服务、或该退回「只给当前在线列表走推送，离线走邮件/APNs」。聊天室和「全站公告」不是一种扇出。全站公告更该走队列 + 每连接有界邮箱，而不是 \`server.emit\` 扫所有 socket。

房间名是数据：\`order:123\`、\`user:456\`。不要让客户端随便 \`join('admin')\`。join 必须在服务端校验权限后再 \`client.join\`。客户端声明加入哪个房，等于没有鉴权。

离开房间同样要权限吗？通常允许自己 leave。被踢出（管理员）是另一条事件，必须校验操作者角色，并在所有节点上 leave（经过 adapter）。只在本机 leave，用户在另一副本上的第二台设备还在房里。

空房间要不要删 Redis 键？要。否则房间键永远涨。定期扫人数为 0 的键，或 leave 时计数到零即删。

## 5. 消息：大小、类型、背压

每条消息要有大小上限。二进制帧不经 JSON 解析也要限，否则内存炸弹。JSON.parse 大包会卡住事件循环——和 HTTP body 无限是同一类问题。

handler 里做重 CPU（压缩图、同步加密大文件）等于堵住 **所有连接** 的心跳。丢给 worker 或限制并发。\`await\` 外部 HTTP 时要超时，否则一个慢下游让房间里的 ack 堆积。

socket.io 的 ack 回调：客户端等服务端 \`callback()\`。服务端忘了调，客户端一直 pending。超时要在客户端做，服务端也要保证要么 ack 要么 disconnect，不要悬挂。

有界邮箱：连接慢时不能无限 \`emit\` 缓冲。超过水位：断开、或丢弃并计数。无限缓冲是 OOM 的另一种写法。

## 6. 断开必须对称清理

\`handleDisconnect\` 里：离开所有房间、更新在线表、取消该连接的订阅、拒绝后续 emit。只 \`disconnect\` 不从自己的 \`Map<userId, Set<socketId>>\` 删除，计数会涨到永远。

滚动发布：旧进程 SIGTERM 时应通知客户端重连（或等他们自动重连），并关掉 server。半关闭期间新消息打到正在退出的进程，会丢。和 HTTP 一样：先停握手，再排空，再退出。K8s \`terminationGracePeriodSeconds\` 必须大于排空时间，否则直接 SIGKILL，清理钩子跑不完，Redis 房间键和本地计数会脏。

新副本起来后，adapter 订阅就绪前不要接流量。readiness 探针应等 Redis adapter ready，否则这一小段窗口又是单机内存。

同一用户两个 socket（手机+电脑）：断一个不要把用户标成离线。离线条件是「该用户 socket 集合为空」。

## 7. 水平扩展：适配器与 sticky

两台机器各有自己的连接表。A 上的用户 join \`room:1\`，B 上的 \`to('room:1').emit\` 看不见他。socket.io Redis adapter 把 emit 同步到其它节点。没有 adapter，「偶发收不到」随负载均衡变化，测试单机永远绿。

sticky session（反代按 cookie/ip 把同一用户打回同一进程）减少跨节点跳，但不能替代 adapter：用户仍可能连在不同设备、不同节点。

适配器本身会成为 Redis 热点。全员广播 = Redis 扇出。度量 pub/sub 通道长度和延迟。房间键设计避免一个巨型 \`all-users\` 房间。

Kafka/NATS 当广播总线也可以：WS 节点订阅「发给 user X」的主题，再落到本地 socket。这时房间表仍在本地，权威在总线。比 Redis adapter 更重，适合已经有总线的系统。

## 8. ws 与 socket.io

\`ws\`：接近裸协议，包小，自己管房间和重连。socket.io：房间、ack、自动重连、降级长轮询。降级会让「我以为是 WS」变成 HTTP 轮询，容量模型全变。生产要关掉不需要的 fallback，或承认容量按 HTTP 算。

Nest 的 \`IoAdapter\` 要在 \`main.ts\` 里挂上自定义适配器才能用 Redis。只写 Gateway 装饰器，默认仍是单进程内存。很多人以为「我用了 Nest 所以自动能水平扩展」，这是把框架当中间件用。装饰器解决的是方法映射，扩展解决的是连接表同步，两件事情。

Redis adapter 挂掉时要有明确行为：拒绝新广播并告警，或拒绝新握手。默默退回本机内存，等于在高峰期切换数据模型。健康检查应包含 adapter ping，不要只 ping HTTP \`/health\`。

Namespace 是另一棵连接树（\`/chat\` vs \`/notify\`）。权限、限流、适配器都要按 namespace 想一遍，不要假设共用一个房间表。

## 9. 和 HTTP 共用 Guard / Filter

ExecutionContext 是 \`ws\`，\`switchToHttp()\` 会空。Guard 读 \`client.data.userId\`，不要复制一套 JWT 解析。handshake 解析一次，事件里只读 data。

异常过滤器必须 \`client.emit('error', { code })\`，不能 \`res.status(500)\`。未捕获异常默认可能直接拆连接，客户端只看见 onclose，没有 code。和 HTTP 过滤器同一纪律：对外 code，对内日志。

拦截器可以打点耗时。不要在拦截器里对每条心跳打 info 日志。

管道也可以挂在 Subscribe 上，把 payload 变成 DTO。失败应回 error 事件给这个 socket，不要 throw 到把连接拆掉——校验失败不等于该用户网络坏了。HTTP 400 不断 TCP；WS 上更要克制 disconnect。

「谁在房里」若每次 join/leave 都广播完整名单，人数一多就是二次 O(N) 扇出。正确做法：节流快照（每秒最多一次）、或客户端 HTTP 拉成员、或只广播增量 \`joined/left\` 而不是全量数组。增量必须带 seq，否则重连后名单会对不上。

## 10. 顺序、丢失与「实时」的诚实含义

WS 不保证跨连接的全局顺序。同一 socket 上帧有序；同一用户两个设备、或经过 Redis adapter 之后，房间内事件可能乱序。需要顺序就带 \`seq\`，客户端按 seq 排序或丢弃旧包。不要假设 \`emit\` 的先后等于所有人看见的先后。

也不保证送达。\`emit\` 在对端已断、缓冲满、adapter 丢 pub/sub 时会丢。关键状态（钱包余额、库存）不能只靠 WS；WS 是提示「去拉一次权威 HTTP」。把实时当唯一真相，对账会哭。

重连后要补洞：last seq 或「请推当前快照」。只靠「重连后继续收」会漏掉断线期间的事件。快照接口仍是 HTTP，WS 只通知「该拉了」。

## 11. 限流与滥用

握手限连：每 IP、每用户。事件限流：每 socket 每秒 N 条，超过 disconnect 或静默丢。房间 join 限流，防止扫所有 \`order:*\`。

匿名连上来再断，也能打满 fd。SYN 层有反代；应用层仍要 cap \`server.sockets.size\`。接近上限时拒绝新握手并告警，不要让 OOM killer 当限流器。

payload schema 用 class-validator 或 zod 在 Subscribe 入口校验，和 HTTP Pipe 同一纪律。未知事件名直接忽略并计数，不要当错误广播回房间。

## 12. Cookie、CSRF、网关超时

浏览器 WS 会带 cookie。SameSite 策略和 HTTP 一致。CSRF：跨站页面若能带 cookie upgrade，要 Origin 校验。移动端用 token 头则另一套。

反代 \`proxy_read_timeout\` 必须大于心跳间隔，否则 Nginx 先掐连接，应用还以为客户端走了。WebSocket 和 HTTP 超时不是同一个值。

二进制 vs JSON：位置、音视频帧走二进制；信令走小 JSON。混在一条事件里 base64 大包，CPU 和带宽一起崩。能分 namespace 或分事件类型就分。

CORS 与 cookie：浏览器 Origin 必须白名单。移动端原生 WS 不走 CORS，但 token 仍要鉴权。不要因为「App 不走 Origin」就关掉握手校验。

## 13. 测试

单测 mock \`Socket\` 的 \`emit/join/data\`。集成：起真实网关，用 socket.io-client 连，断言房间广播、断线清理、鉴权失败立即 disconnect。多节点测试至少两进程 + Redis，否则扩展问题测不到。

不要用 HTTP e2e 代替 WS e2e。握手失败、心跳超时、并发 join 是另一类 bug。

Gateway 的 \`afterInit\` 里挂 Redis adapter，不要等第一个连接才懒加载。懒加载会导致启动后第一波广播仍是单机内存，测试很难抓住。adapter 连接失败应让进程起不来，而不是默默退回内存模式——那会在多副本下表现为「有时能收到」。

压测要分开：握手 QPS、房间内广播扇出、单连接吞吐。用 HTTP 压测工具打 upgrade 而不维持连接，测的不是 WS。维持连接后再 emit，才能看到事件循环和内存。

## 14. 排障怎么问

1. 用户掉线了房间计数还在涨？缺 \`handleDisconnect\` 或只清了协议层没清业务 Map。
2. 多副本部署后通知丢失？没有 adapter，或广播打在错误 namespace。
3. 延迟随在线人数线性涨？单进程 \`server.emit\` 扫全表。
4. 连得上但第一条业务消息 401？鉴权放在 Subscribe 而不是握手，或 token 过期没踢。
5. 本地绿、预发断连？反代超时 < 心跳，或 sticky 没开导致 handshake 和帧打到不同机（视实现）。
6. 内存涨？消息无上限、emit 无限缓冲、泄漏的 socket 引用。
7. CPU 打满但 QPS 不高？handler 同步重活，或 JSON.parse 大包。
8. 滚动发布丢消息？grace period 短于排空，或 readiness 没等 adapter。
9. 高峰期突然变成「只有部分人收到」？adapter 掉了却退回内存模式。

指标最少要有：当前连接、握手失败率、每房间人数分布、emit 延迟、adapter 往返、断开原因分类（心跳/限流/鉴权/服务端踢）。没有原因分类，oncall 只能看见「人掉了」。

追踪：每条业务事件带 \`eventId\`，从 HTTP 下单到 WS 推送能串起来。不要期望 WS 帧上有完整 OpenTelemetry 也省事——至少日志字段对齐 requestId。

## 15. 设计取舍

- **连接态当权威**：实现快。多机必丢，进程一死全无。
- **每条消息过队列再落地 WS**：可恢复、可审计。延迟和运维成本高。
- **socket.io 全家桶**：功能全。包和降级路径复杂。
- **裸 ws + 自研房间**：可控。要自己做重连和 ack。
- **客户端随便 join**：省代码。等于没有房间权限。

在线状态对外暴露要节流。每次 join/leave 都广播全房间名单，人数一多就是二次扇出。用节流快照（每秒最多一次）或让客户端自己 HTTP 拉成员列表。

## 16. 小结

WS 的原理是 **有状态连接集合 + 可选的跨进程广播**。网关方法只是事件回调。握手鉴权、双向心跳、房间权限、断开对称清理、消息上限、多机 adapter，才是架构。按 HTTP 无状态思路去写，失败会静默、计数会漂、扩展会丢消息。

能回答「这台机器的连接表里有谁、广播要不要出进程、这条连接凭什么还活着、断线期间的事件谁负责补」，网关才算接上。实时是提示，HTTP 才是权威；顺序要靠 seq，送达要靠补洞，扩展要靠 adapter。`,



  "nestjs-microservices-and-message-queue": `Nest 微服务看起来像「把 HTTP 换成 TCP/Redis/RMQ」。handler 仍是装饰器方法，但语义从 **请求-响应** 变成了 **消息**。默认假设往往是至少一次投递。你的 handler 若不幂等，重试就是重复下单。

这篇文章只讲这一层：\`ClientProxy\` 的 \`send\` / \`emit\`、序列化、重试与死信、背压。读完你应该能独立回答三个问题：为什么不能把微服务当本地函数、消息 id 去重放哪、prefetch 不设会怎样。

## 1. 先画边界：不是 RPC 幻觉

\`client.send('billing.charge', payload)\` 返回 Observable，看起来像函数调用。底下是：序列化 → 网络/总线 → 对端反序列化 → 执行 → 可能再回包。超时、乱序、重复、丢失（视传输）都在这层。本地函数没有这些。

\`emit\` 是事件，不等待结果。\`send\` 是请求-响应，需要相关 id。选错的症状：发了邮件通知还 \`await\` 一个永不回复的 emit。

传输（TCP、Redis、NATS、RMQ、Kafka）决定交付语义，Nest 不替你统一成「恰好一次」。恰好一次要靠幂等 + 存储，不是靠换装饰器。

## 2. 序列化

默认 JSON。日期变成字符串，\`undefined\` 丢掉，\`Map\` 变 \`{}\`。跨语言时这是特性。需要二进制就换自定义 deserializer，但要两端一起换。版本化 payload：\`{ v: 1, ... }\`，不要靠「加字段兼容」一直加到无法读。

契约用共享 types 包，不要共享 Entity。表结构不是消息。

## 3. 幂等

至少一次投递下，同一 \`messageId\` 可能来两次。用数据库唯一约束（\`idempotency_key\`）或 Redis SETNX。处理中、已完成、已失败要能区分，避免第二次请求卡在「第一次还在跑」。

\`\`\`ts
@EventPattern("order.created")
async onCreated(data: OrderCreated) {
  const ok = await this.ids.claim(data.eventId);
  if (!ok) return;
  await this.projections.apply(data);
}
\`\`\`

## 4. 背压与预取

RMQ prefetch、Kafka max.poll.records 限制「未 ack 的在途消息」。不限制时，消费者会把内存当队列，OOM 比处理慢更早出现。处理时间 P99 决定预取：太高则延迟，太低则吞吐。

慢消费者必须让队列堆积可见（lag 指标），而不是在进程里无限 buffer。

## 5. 超时与重试

\`send\` 必须 \`timeout\`。超时后对端可能仍在执行——又是幂等。重试带 backoff 和抖动，避免雷群。毒消息进死信，不要无限重试打爆下游。

## 6. 在 Nest 里的位置

\`ClientsModule.register\` 把 \`ClientProxy\` 注入业务。业务不要 \`if (tcp) else redis\`。换传输改模块配置。本地测试用 in-memory transport，但不要以为 in-memory 的时序等于 Kafka。

混合 HTTP + 微服务的进程：两套生命周期，关闭时先停收消息再关连接，避免半处理。

## 7. 排障怎么问

1. 重复扣款？没有 idempotency key。
2. 超时但钱扣了？\`send\` 当函数用，且对端无超时取消。
3. 内存涨？prefetch 无限 + 慢 handler。
4. 「偶发丢消息」？看是 emit 无持久化，还是消费者挂了没 ack。

## 8. 小结

微服务传输的原理是消息，不是远程函数。幂等、超时、背压、契约版本，比选 Redis 还是 RMQ 更重要。Nest 给你的是 handler 映射；交付语义你必须自己承认。`,

  "nestjs-task-scheduling-and-bullmq": `\`@Cron('0 0 * * *')\` 在单机开发很好用。生产多实例下它会变成「每天跑 N 次」——N 是副本数。Cron 是时钟，不是作业系统。作业系统要 **可重试、可观测、可水平扩展、可幂等**。BullMQ（或同类队列）才是。

这篇文章只讲这一层：谁触发、谁执行、job 数据放什么、失败怎么走、分布式锁什么时候还不够。读完你应该能独立回答三个问题：为什么生产要把 Cron 触发改成「投一条队列」、jobId 去重和业务幂等差在哪、Worker 的 concurrency 不是无限并行。

## 1. 先画边界：时钟 vs 执行

\`@nestjs/schedule\` 的 Cron 跑在 **当前进程** 的定时器上。没有中心调度。三副本就会三倍执行。分布式锁（Redis SETNX）能把 Cron 收成「只有一个跑」，但锁过期、进程 STW、锁续期失败，仍可能双跑。锁解决互斥，不解决重试和可观测。

BullMQ：Producer 把 Job 放进 Redis，Worker 拉取。失败按 backoff 重试。延迟队列用 sorted set。仪表板上能看到 waiting/active/failed。这才是执行系统。

正确形状：Cron（或外部调度）只负责 \`queue.add\`，执行只发生在 Worker。

## 2. Job 是消息，要小、要可序列化

Job data 进 Redis。放 20MB 文件进去会把 Redis 和序列化一起打死。放对象存储 id。类型用 DTO，版本化，和微服务 payload 同一纪律。

\`jobId\` 让同一逻辑 key 不会重复入队（例如 \`reconcile-2026-04-08\`）。这是入队去重，不是业务幂等。Worker 仍可能 at-least-once 执行两次——Redis 重启、ack 前崩溃。业务层还要有自己的「这天对过账了吗」。

## 3. Worker 与并发

\`concurrency: 5\` 是同时处理的 job 数，受单线程事件循环约束。5 个 await IO 可以重叠；5 个同步 CPU 循环会排队。CPU 型任务应进单独队列 + 限制并发，或丢给专门进程。

\`\`\`ts
@Processor("billing")
export class BillingWorker {
  @Process("charge")
  async charge(job: Job<ChargeDto>) {
    await this.billing.chargeIdempotent(job.data);
  }
}
\`\`\`

## 4. 失败、死信、停滞

失败抛错 → 重试。次数耗尽 → failed 列表。要告警。stalled：Worker 死在处理中，锁过期，job 被别人拿走——又是幂等。\`lockDuration\` 必须大于 P99 处理时间，否则活着的 job 也会被当成 stalled。

进度 \`job.progress\` 便于长任务。取消要在循环里看 \`job.isActive\` 或自己的 token，Redis 不会中断你的 await。

## 5. 和 Nest 生命周期

Worker 是长期订阅者。应用 shutdown 要 \`queue.close()\`，等 in-flight 结束或显式失败。和 HTTP server 一起 SIGTERM：先停收新 job 和新 HTTP，再等两套 in-flight。

BullMQ 的连接是 Redis。Redis 抖动时，Worker 会重连；不要在 constructor 里假设队列永远可用。

## 6. 设计取舍

- **全放 Cron**：实现快。多机必错。
- **全放队列**：可观测。多一个 Redis，多一种失败模式。
- **每分钟扫表补单**：能兜底。扫的窗口和索引设计不好会打爆 DB。兜底应存在，但不该是主路径。

## 7. 排障怎么问

1. 任务双倍？Cron 没锁，或锁和队列各跑了一遍。
2. failed 很多但业务已成功？重试无幂等。
3. waiting 堆积？concurrency 太低或 handler 卡住外部 API。
4. stalled 风暴？lockDuration 太短。

## 8. 小结

调度的原理是「把工作变成可重试的消息」。Cron 只是时钟；队列才是执行。入队去重、业务幂等、关闭时排空，三件事比再包一层 \`@Interval\` 更要紧。`,
};
