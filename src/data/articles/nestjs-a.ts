export const nestjsA: Record<string, string> = {
  "nestjs-architecture-and-ioc-di": `把 NestJS 理解成「Angular 搬到 Node」会在生产里立刻失效。装饰器不是风格，元数据不是注释。真正值钱的是 **IoC 容器如何用类型把对象图拼起来，并按作用域缓存实例**。没有容器，每个 \`new\` 都是一处耦合，测试替身只能改生产代码；有了容器，生命周期和替换策略才是一等公民。HTTP 只是这张图上的一种触发方式。

这篇文章只讲容器这一层：token 怎么当钥匙、启动时图怎么扫、\`InstanceWrapper\` 缓存什么、三条作用域各自对应哪类事故、循环依赖为什么是元数据断了而不是语法坏了。读完你应该能独立回答三个问题：接口为什么注不进去、request 作用域为什么会把单例树打出一棵子图、测试里 \`overrideProvider\` 换掉的到底是工厂还是已经 new 出来的对象。

## 1. 先画边界：容器管对象图，不管路由

Nest 启动后内存里有两张图，职责必须互斥。

- **模块图**：谁 import 谁、谁 export 哪个 token。这是可见性，下一篇讲。
- **对象图**：token → 实例。这是容器。本篇只讲这一张。

容器 **不** 解析 URL，**不** 跑 Guard，**不** 写响应。\`RouterExplorer\` 问容器要 Controller 实例，再把方法挂到 Express/Fastify。把 404、鉴权失败、DTO 校验失败归到「DI 坏了」，是在错的层找原因。

日常写的 \`@Injectable()\` / 构造函数参数，属于 **声明依赖**。真正完成「类型 → 实例」翻译的，是 \`@nestjs/core\` 里的 \`Injector\`：它读 \`design:paramtypes\` 和 \`@Inject()\`，在宿主 \`Module\` 的 providers 表里查找 \`InstanceWrapper\`，必要时递归创建，再按 scope 放进缓存。

不变量：**调用方不该 \`new\` 自己的依赖。** 一旦你在 Service 里 \`new HttpService()\` 或 \`new Logger()\`，容器对这条边失明，override、作用域、\`OnModuleInit\` 全绕开。看起来少写了几行模块配置，付的是不可替换。

Controller、Guard、Pipe、Interceptor 能被注入，是因为它们也被登记成 wrapper，不是因为装饰器「激活了魔法」。没进任何模块 \`providers\` / \`controllers\` 数组的类，构造函数写得再标准也进不了图。

## 2. 类型当钥匙：reflect-metadata 实际读到什么

TypeScript 默认擦除类型。Nest 能自动注入，靠的是 \`tsconfig\` 里 \`experimentalDecorators\` + \`emitDecoratorMetadata\`，以及运行时的 \`reflect-metadata\`。编译器在每个被装饰的构造函数上挂一份：

\`\`\`ts
Reflect.defineMetadata("design:paramtypes", [OrdersRepository, Object], OrdersService);
\`\`\`

\`Injector\` 启动时 \`Reflect.getMetadata("design:paramtypes", Ctor)\`，得到的是 **构造函数引用**（\`Function\`），不是类型名字字符串。类 token 的相等性是引用相等：同一个类从 \`./orders.repository\` 和从 barrel 再转 export 一次，如果打包成了两份模块，就会变成两个类、两把钥匙，报 \`Nest can't resolve dependencies\`。Monorepo 里 \`paths\` 配错、Jest 和运行时各解析一份，是这条事故的高发地。

接口在编译后消失。\`constructor(private pricing: PricingPort)\` 若 \`PricingPort\` 是 \`interface\`，对应位置的 paramtypes 是 \`Object\`，容器无法查找。必须把钥匙写成值：

\`\`\`ts
export const PRICING = Symbol("PRICING");

export interface PricingPort {
  quote(sku: string): Promise<number>;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly repo: OrdersRepository,
    @Inject(PRICING) private readonly pricing: PricingPort,
  ) {}
}
\`\`\`

\`@Inject(token)\` 写入的是 Nest 自己的元数据，优先级高于 \`design:paramtypes\`。**能用类当 token 就用类；接口、多实现、第三方对象，才上 Symbol。** 字符串 \`"PRICING"\` 能工作，但两处手滑写成 \`"Pricing"\` 就是两把钥匙。Symbol 按引用相等，还避免和别人的字符串撞车。

属性注入 \`@Inject(FOO) foo: Foo\` 在实例 \`new\` 出来之后才赋值，时序晚于构造函数。构造里读 \`this.foo\` 是 \`undefined\`。能构造注入就不要属性注入；属性注入是给基类、mixin、循环补丁用的逃逸舱。

\`emitDecoratorMetadata\` 只给 **被装饰的** 类发元数据。抽象基类没挂 \`@Injectable()\`，子类构造若用 \`super\` 传依赖，不要指望基类那一侧还有 paramtypes。把依赖声明在实际会被容器 \`new\` 的那一层。

## 3. 启动路径：扫描 → 加载 → 创建

\`NestFactory.create(AppModule)\` 不是 \`new AppModule()\`。粗分三步：

1. **DependenciesScanner** 从根模块出发，递归走 \`imports\`（含 \`DynamicModule\` 和 \`forwardRef\`），登记每个 \`Module\`：controllers、providers、exports、imports。这步只建目录，不 \`new\` 业务对象。重复 import 同一模块（同一引用）会被去重；\`forRoot()\` 每次返回新对象字面量，去重规则不一样，这是动态模块篇的事。
2. **InstanceLoader** 按模块创建 \`InstanceWrapper\`。遇到异步 \`useFactory\`，这里会 \`await\`。工厂抛错，bootstrap 失败——依赖没就绪不该对外听端口，这是故意的。
3. **Injector** 解析每个 wrapper 的依赖，递归到叶子（\`useValue\`、无参构造、已缓存的单例），调用构造函数，再跑生命周期钩子。

顺序细节：先把内部核心模块（\`InternalCoreModule\`：\`ModuleRef\`、\`Reflector\`、\`HttpAdapterHost\`）放进全局；再实例化 provider；再 controller。所以 Controller 构造里注入 Service 时，单例 Service 已经存在。你在 \`OnModuleInit\` 里再取别的模块，比在构造函数里做 IO 安全：构造阶段别的 wrapper 可能还是 \`isPending\`。

构造函数不能 \`async\`。硬在构造里做同步 IO（读文件、连库、调同步 SDK），启动阶段的事件循环被堵住，其它模块的 init、日志、指标全部排队。打开 socket、读密钥、warm cache，放 \`onModuleInit\`。需要「端口已听」再探活，放 \`onApplicationBootstrap\` 或 \`listen\` 返回之后。

测试里 \`TestingModule.compile()\` 不等于跑了 hooks。\`createNestApplication()\` + \`init()\` 才会。只 \`compile()\` 然后 \`get()\`，\`onModuleInit\` 没跑，连库逻辑会表现为「单测绿、启动挂」。

## 4. InstanceWrapper：一张「token → 工厂 + 缓存」表

容器不是魔法，是每模块一张 Map。键是 token，值是 \`InstanceWrapper\`，上面大致有：token / name / metatype、scope、durable、所属 \`host\` 模块、单例字段 \`instance\`、以及 \`isResolved\` / \`isPending\`（防止创建环上的重入）。

解析算法（简化）：

1. 当前模块 providers 有这个 token？有则用。
2. 没有，则看 imports 进来的模块的 **exports**（不是对方全部 providers）。
3. 再没有，看全局模块。
4. 仍没有：抛 \`UnknownDependenciesException\`。错误信息里的 \`?\` 就是某一层 paramtypes 是 \`undefined\`。

\`\`\`ts
@Module({
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService],
})
export class OrdersModule {}
\`\`\`

\`OrdersRepository\` 没 export，隔壁模块 import 了 \`OrdersModule\` 也看不见它。这不是 DI 坏了，是封装。把所有东西标 \`global: true\`，等于拆掉第 2 步。

\`ModuleRef.get(OrdersService)\` 走同一套查找，可 \`strict: false\` 跨模块。生产代码里到处 \`moduleRef.get\` 是在用服务定位器打回耦合；正当用途是动态 token、插件、在已知边界外拿可选依赖。\`ModuleRef.resolve\` 按 context 解析 request-scoped，和 \`get\` 不是同一个缓存槽。

可选依赖用 \`@Optional()\`：找不到时注入 \`null\`，而不是启动失败。适合特性开关、没有就降级的缓存。不要用它掩盖「这个模块忘记 import」——那会把配置错误推迟到 NPE。

## 5. 三条作用域，对应三类事故

| Scope | 实例数 | 适合 | 典型事故 |
|---|---|---|---|
| singleton（默认） | 进程内一份 | 无状态服务、连接池、SDK 客户端 | 把「当前用户」塞进字段，串请求 |
| request | 每个 HTTP/RPC 请求一份（按 ContextId） | 当前用户、事务、请求级 Unit of Work | 重对象放 request，QPS 一高就炸堆 |
| transient | 每次注入都 new | 带可变缓冲的短命帮手 | 误以为能缓存连接；每次注入都开一条 socket |

不变量：**单例依赖 request-scoped 时，单例本身会被提升成带代理的 request 解析。** Nest 让表面仍是构造注入，实际每次请求查到不同实例。这不是免费的：调用变成一次延迟查找，调用链上所有「碰过 request 依赖」的节点都离开单例缓存。你在本想单例的 \`OrdersService\` 里注入 \`@Inject(REQUEST) req\`，整个 Service 按请求 new。连接池若活在这个 Service 的字段里，你会按请求建池。

正确拆法：无状态 Service 保持单例，请求级数据当 **方法参数** 传入，或只让真正的 \`RequestContext\` 用 request scope。不要图省事把 \`req.user\` 藏进单例字段——并发下那是别人的用户。

\`TRANSIENT\` 在同一构造函数里出现两次，得到两个实例。不要用它模拟「prototype 但共享连接」。连接是单例资源，状态机才是 transient。

DEFAULT 作用域在文档里叫 singleton，实现上是 \`Scope.DEFAULT\`。和 \`Scope.REQUEST\` 写错一个词，症状是「偶发串数据」而不是启动报错，所以作用域必须出现在 code review 的提问里，不能靠感觉。

## 6. 循环依赖：断的是元数据，不是感情

\`\`\`ts
@Injectable()
export class A {
  constructor(private readonly b: B) {}
}
@Injectable()
export class B {
  constructor(private readonly a: A) {}
}
\`\`\`

TS 编译这两个类时，有一边在 emit 元数据的时刻对方还处于暂时性死区，\`design:paramtypes\` 里会出现 \`undefined\`。容器看到 \`undefined\`，报 \`cannot resolve dependencies of A (?)\`。\`forwardRef(() => B)\` 把查找推迟到双方类声明都完成之后：

\`\`\`ts
constructor(@Inject(forwardRef(() => B)) private readonly b: B) {}
\`\`\`

模块之间的循环 import 同样要 \`imports: [forwardRef(() => OtherModule)]\`。这是急救。图上 A↔B 往往意味着缺第三种东西：一个事件、一个接口、一个共享的无环内核。生产里 \`forwardRef\` 一多，启动顺序和 \`overrideProvider\` 都会变脆——解析时刻被推迟，错误从「启动立刻炸」变成「第一次调用才炸」。

属性注入也能打破构造环：两边构造都不引对方，再 \`@Inject() a: A\`。环还在，只是 new 的顺序改了。优先拆图。\`ModuleRef\` 在 \`onModuleInit\` 里再 \`get\` 对方，是第三条逃逸舱，代价是类型上不再声明依赖，静态分析看不见这条边。

## 7. 请求作用域：ContextId 长出子图

HTTP 请求进入适配器之后，Nest 给这次调用分配 \`ContextId\`（可用 \`ContextIdFactory\` 自定义，比如按租户）。\`Injector\` 以 \`(wrapper, contextId)\` 为键缓存 request-scoped 实例。\`REQUEST\` provider 在这个 context 里解析成当前 \`req\`。

同一请求内，多次注入同一 request-scoped token 得到同一实例；下一请求是另一棵子图。WebSocket 和微服务也走 ContextId，但「请求」的边界是消息而不是 HTTP。把 ALS（\`AsyncLocalStorage\`）当 request scope 用可以，但那是你自己的上下文，不是容器的 wrapper 缓存。ALS 适合 logger 的 correlation id；事务和 UoW 更适合显式参数或 request-scoped provider。两者混用要画清楚：ALS 丢了只是日志断链，容器 scope 丢了是实例串台。

Durable providers 是中间态：host 按某个 durable 键（如租户）缓存，而不是每个 HTTP 请求都 new。用来挂贵的按租户客户端。键选错（用了 userId 而不是 tenantId）会变成另一种泄漏——用户数涨，客户端数跟着涨。

请求结束时，这棵子图应当变得不可达，交给 GC。你若在单例里保存了 request-scoped 实例的引用（缓存、数组、订阅未退），子图就钉在进程里。这是 Nest 里最像「内存泄漏」的写法，根因仍是作用域边画错。

## 8. 生命周期钩子与测试替身

容器会调这些钩子（实现对应接口即可）：\`OnModuleInit\` / \`OnModuleDestroy\`、\`OnApplicationBootstrap\` / \`OnApplicationShutdown\`、\`BeforeApplicationShutdown\`。被依赖的模块先 init；destroy 大致相反。SIGTERM 时 \`NestApplication.close()\` 跑 shutdown 再关 HTTP。K8s \`preStop\` 要给 \`close\` 留出时间，否则钩子跑一半 pod 被杀，连接池来不及还。

测试替身换的是 **工厂**，不是已经 new 出来的对象：

\`\`\`ts
const moduleRef = await Test.createTestingModule({
  imports: [OrdersModule],
})
  .overrideProvider(PRICING)
  .useValue({ quote: async () => 42 })
  .overrideProvider(OrdersRepository)
  .useClass(InMemoryOrdersRepository)
  .compile();

const svc = moduleRef.get(OrdersService);
\`\`\`

\`overrideProvider\` 必须发生在 \`compile\` 之前。编译后再改 Map，图已经建完。\`useValue\` 塞现成对象；\`useClass\` 仍走容器 new，还可以再注入。单测不要 \`new OrdersService(fakeRepo)\` 除非这个类的全部意义就是纯函数——一旦它以后加依赖，所有手写 \`new\` 都会漏。

\`useMocker\` 能给未登记依赖填自动 mock，适合宽测试。它也会把你本该发现的「漏了 export」填掉。契约测试用显式 override，探索性测试才用 mocker。

## 9. 设计取舍（为什么是现在这样）

- **用构造函数类型当默认 token**：少写配置。代价是接口被擦除、循环时元数据变 \`undefined\`、打包双份模块会变成两把钥匙。
- **默认单例**：服务端进程里连接和线程预算都贵，共享是合理默认。代价是状态会串请求，必须靠纪律把「当前用户」赶出字段。
- **按模块查找而不是全局服务定位器**：封装。代价是忘记 export 时错误信息像 DI 坏了，新人会把模块标 global。
- **异步工厂阻塞 bootstrap**：错误的依赖配置不能带病上线。代价是 Config 读不到值时整个进程起不来——这通常是好事，但探活要区分「没起来」和「起来了但下游挂了」。

这些取舍决定了什么优化有意义。把所有 Service 改成 request-scoped 不会让代码更「纯」，只会让分配器过热；在业务方法里 \`new\` 一个 Repository，容器再精巧也帮不上测试。

## 10. 怎么把原理用到排障上

遇到 \`Nest can't resolve dependencies\`，按层提问，不要先改业务方法：

1. **问号在第几个参数？** 那个位置是 \`undefined\`（循环/接口）还是一个你没注册的类（漏 provider / 漏 export）。
2. **token 是不是同一引用？** 打印 \`token === TheClass\`，查 barrel 和重复打包。字符串 token 对一下常量导出。
3. **在哪个模块的查找范围？** 当前 providers → imports 的 exports → global。Repository 没 export 就会在这一步失败。
4. **是启动失败还是第一个请求失败？** 后者常是 request-scoped 或 \`forwardRef\` 把错误推迟了。
5. **单例是否被 request 依赖污染？** 日志里同一 Service 每请求 new，去查它或它的依赖链有没有注入 \`REQUEST\`。

能回答这五问，容器对你就不再是装饰器魔法，而是一张有查找规则的表。

## 11. 小结

IoC 的原理是「类型或 Symbol 当钥匙，InstanceWrapper 当工厂加缓存」。DI 让调用方依赖抽象，模块边界决定钥匙在哪张表上能查到，作用域决定实例活多久。HTTP、Guard、Pipe 都只是这张图上的客户。把问题归到 token、查找范围、作用域三件事，后面讲模块图、自定义 provider、请求生命周期才有落点。`,

  "nestjs-modules-and-dynamic-modules": `把 \`@Module()\` 理解成「文件夹的别名」会在生产里立刻失效。模块不是目录，不是 namespace，是 **可见性边界**：不 export 的 provider，外面的 Injector 查找规则到此为止。DynamicModule 让同一份代码在不同 import 点带不同配置，这是库作者和中台配置的核心，不是 \`forRoot\` 这种命名习惯。

这篇文章只讲模块图：静态边怎么画、export 到底导出什么、\`forRoot\` / \`forFeature\` / \`forRootAsync\` 各自往图上补哪一类节点、\`global: true\` 买到的是什么。读完你应该能独立回答三个问题：为什么 import 了模块仍然注不进它的 Repository、为什么两次 \`forRoot\` 会注册两套连接、异步配置里 \`inject: [ConfigService]\` 失败时错误出在哪张图上。

## 1. 先画边界：模块图不是对象图

上一篇的对象图回答「这个 token 的实例是谁」。模块图回答「**允许在哪张表里查这个 token**」。两张图同时存在：

- 一个 \`Module\` 实例持有自己的 \`providers\` Map、\`controllers\`、\`imports\` 集合、\`exports\` 集合。
- \`Injector\` 解析某 token 时，**先问宿主模块**，再问 imports 的 exports，再问 global。

所以「我 import 了 \`OrdersModule\`」只保证你能看见它 **export 过的** token。它内部的 \`OrdersRepository\`、某个内部 \`useFactory\`，默认仍是私有的。这和语言层面的 \`export\` 关键字无关——TS 的 export 只管编译单元，Nest 的 exports 管运行时查找。

不变量：**可见性只沿 export 边走，不沿「文件在同一个文件夹」走。** 把 Service 和 Repository 放在同一目录却忘了登记、忘了 export，容器不会因为路径近就网开一面。

Controller 登记在 \`controllers\` 数组里，通常不 export。HTTP 适配器按模块挂路由，别的模块不该注入你的 Controller。要复用的是应用服务，不是控制器实例。

## 2. 四元组：imports / controllers / providers / exports

\`\`\`ts
@Module({
  imports: [CustomersModule, PricingModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService],
})
export class OrdersModule {}
\`\`\`

四段的职责必须互斥：

- **imports**：把别的模块的 export 集合并进本模块的查找范围。不是「把对方的 providers 复制一份」。
- **controllers**：本模块对外的传输入口。会被扫进路由表。
- **providers**：本模块私有对象图的节点。
- **exports**：本模块对外的窗口。可以 export 一个 provider token，也可以 export 一个 imported 模块（再导出），形成传递。

\`exports: [CustomersModule]\` 的含义是：谁 import 我，谁也能看见 \`CustomersModule\` 的 export。这是「桶模块」的做法。传递过长，查找范围变成一张网，\`UnknownDependencies\` 会变得很难指出是哪一跳漏了。能精确 export 一个 token，就不要 re-export 整个模块。

重复列出同一 provider 在 \`providers\` 和 \`exports\` 里，不是重复实例化：export 引用的是同一 wrapper。漏写 exports、却在别的模块构造函数里要它，才会 new 失败。

## 3. 根模块只是扫描起点，不是上帝对象

\`NestFactory.create(AppModule)\` 以 \`AppModule\` 为根做 DFS。根模块的职责是 **装配**：import 各限界上下文、挂全局增强器、挂配置。它不该拥有全部业务 provider。把几十个 Service 塞进 \`AppModule.providers\`，模块图退化成一张表，封装名存实亡，循环依赖也失去「先拆模块」这条退路。

一个可运转的根通常长这样：

\`\`\`ts
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({ url: cfg.getOrThrow("DATABASE_URL") }),
    }),
    OrdersModule,
    PaymentsModule,
  ],
})
export class AppModule {}
\`\`\`

\`isGlobal: true\` 出现在 Config，是因为几乎每个工厂都要读配置，不是因为「全局是默认风格」。业务模块继续显式 import。测试时可以替换根上的 \`DatabaseModule\`，而不必改 \`OrdersModule\` 的源码——这才是根模块存在的理由。

## 4. DynamicModule：运行时往图上补边

静态 \`@Module({...})\` 在装饰器求值时就冻住了。库无法知道调用方的 URL、密码、实体列表。\`DynamicModule\` 是一个普通对象，在 \`forRoot\` / \`forFeature\` **调用时** 才返回：

\`\`\`ts
export interface DynamicModule {
  module: Type<unknown>;
  global?: boolean;
  imports?: Array<Type<unknown> | DynamicModule | Promise<DynamicModule>>;
  controllers?: Type<unknown>[];
  providers?: Provider[];
  exports?: Array<string | symbol | Function | DynamicModule>;
}
\`\`\`

\`module\` 字段指出「这是哪个模块类的动态形态」，扫描器用它做身份。\`providers\` 在这里可以按参数生成。这就是 \`forRoot(options)\` 能把 \`options\` 变成 \`useValue\` 的原因：

\`\`\`ts
@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        { provide: DATABASE_OPTIONS, useValue: options },
        DatabaseService,
      ],
      exports: [DatabaseService],
    };
  }
}
\`\`\`

调用 \`DatabaseModule.forRoot(opts)\` 得到的是对象字面量，不是类。每次调用一份新对象。扫描器默认 **不会** 把两次 \`forRoot\` 当同一模块去重——于是你可能拿到两套连接。\`forRoot\` 约定在根上调用一次；需要按领域切分的，用 \`forFeature\`。

## 5. forRoot / forFeature / forRootAsync 不是三种语法糖

三者往图上补的节点种类不同：

- **forRoot**：进程级资源。连接、客户端、SDK、全局选项 token。应出现一次。
- **forFeature**：在已经有 Root 的前提下，登记本模块需要的切片。TypeORM 的 \`forFeature([Order])\` 注册的是 \`Order\` 的 Repository token，不是再开一条连接。
- **forRootAsync**：Root 的选项本身还要注入别的 token（通常是 \`ConfigService\`）。工厂可以 async，InstanceLoader 会等。

\`\`\`ts
static forRootAsync(opts: {
  imports?: any[];
  inject?: any[];
  useFactory: (...args: any[]) => Promise<DatabaseOptions> | DatabaseOptions;
}): DynamicModule {
  return {
    module: DatabaseModule,
    imports: opts.imports ?? [],
    providers: [
      {
        provide: DATABASE_OPTIONS,
        useFactory: opts.useFactory,
        inject: opts.inject ?? [],
      },
      DatabaseService,
    ],
    exports: [DatabaseService],
  };
}
\`\`\`

异步失败发生在 **对象图加载期**，但根因经常在 **模块图**：\`inject: [ConfigService]\` 而本动态模块没 \`imports: [ConfigModule]\`，且 Config 也不是 global。错误信息看起来像 DI，修的是 import 边。

\`useClass\` 异步配置把「怎么造 options」收到一个 \`createOptions()\` 类里，便于测试替换。\`useExisting\` 则是「已经有一个能当 options 工厂的 token」。选哪一种，看 options 的计算要不要独立成可测单元，不是看哪行更短。

Nest 9 之后的 \`ConfigurableModuleBuilder\` 把上面这套样板收成：

\`\`\`ts
const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
  new ConfigurableModuleBuilder<DatabaseOptions>().setClassMethodName("forRoot").build();

@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule extends ConfigurableModuleClass {}
\`\`\`

它仍是 DynamicModule，没有新的运行时模型。好处是 \`forRoot\` / \`forRootAsync\` 签名统一，options token 不再手写拼写错误。库作者该用它；应用里只有一处 \`forRoot\` 时，手写对象字面量更直。

## 6. global 的代价是查找规则被短路

\`global: true\`（以及 \`ConfigModule.forRoot({ isGlobal: true })\`）把该模块的 exports 放进全局表。之后任何模块都能注入这些 token，即使没 import。

买到的是少写 imports。付的是：

- 测试必须记得提供这些全局 token，否则和单模块测试的失败模式不一致。
- 两份带相同 token 的全局模块会互相覆盖或冲突，错误更晚。
- 模块图在脑中不再能被画出——任何类都可能在用一份你看不见的 import。

Config、日志这类「几乎人人要、且只有一份」可以 global。业务的 \`OrdersService\` 不要 global。能显式 import 就不要 global。发现自己把十个业务模块都标了 global，等于宣布模块系统对你无效。

## 7. 循环 import 与模块身份

模块 A import B、B import A，扫描器会在一边拿到未完成的模块。\`forwardRef(() => BModule)\` 推迟到双方都登记完。和对象图的 \`forwardRef\` 是同一类急救，只是边的种类不同：一边是模块边，一边是构造参数边。

更常见的生产循环是「订单要支付状态、支付要订单金额」。解法不是双向 import，是把「金额、状态」降成事件或共享内核模块（只含 DTO 和端口接口，不含两边的 Service）。内核模块被两边 import，自己不 import 两边，图重新变成 DAG。

模块身份：静态 \`@Module\` 类按引用去重。\`DynamicModule\` 若没提供能稳定相等的身份，两次调用就是两个模块。某些版本/配置下可用 \`module\` + 额外元数据去重，但不要依赖「我写了两次 forRoot，框架会合并连接」。**Root 一次，Feature 多次**，这条纪律比去重算法可靠。

## 8. 共享模块、核心模块、桶模块

三种正当形态：

- **共享内核**：只 export 无副作用的东西——token、接口、纯函数式的 Guard/Pipe、公共 DTO。不在这里连库。
- **基础设施模块**：\`DatabaseModule\`、\`CacheModule\`。Root 建资源，Feature 取切片。副作用集中在 Root 工厂。
- **桶（Barrel）模块**：\`InfrastructureModule\` re-export 一堆 Feature，根模块 import 一次。适合启动装配，不适合领域之间互相桶来桶去，否则又变网。

错误形态：\`CommonModule\` 里塞 \`UserService\`、\`Mailer\`、\`Pdf\`、\`Auth\`。它会变成所有循环的中转站。名字叫 Common 不是架构。

\`internal\` 目录加「不要从外面 import」的 lint，是模块边界的编译期投影。Nest 的 exports 是运行时投影。两道都要，只靠其中一道，打包和测试会从另一道漏。

## 9. 设计取舍（为什么是现在这样）

- **默认私有、显式 export**：可替换、可测。代价是样板，以及「明明 import 了却注不进」这种第一周必踩的坑。
- **DynamicModule 是数据，不是新语言**：库能参数化。代价是身份和去重变难，\`forRoot\` 调用两次就两套资源。
- **global 作为逃逸舱**：减少噪音。代价是模块图不可见。
- **异步工厂挂在模块上而不是挂在应用主函数**：配置仍在图里，测试能 override。代价是错误发生在 bootstrap，堆栈穿过扫描器，读起来不像你写的业务代码。

这些取舍决定了什么重构有意义。把所有模块合成一个 \`AppModule\` 能让 DI 错误暂时消失，同时让测试和替换策略一起消失。拆模块若只按文件夹拆、不画 export，图上仍是一团。

## 10. 怎么把原理用到排障上

1. **能 \`get\` 到但别的模块 \`get\` 不到？** 漏 export，不是 token 写错。
2. **\`inject: [ConfigService]\` 在 forRootAsync 里失败？** 动态模块自己的 imports 没有 Config，且 Config 非 global。先补模块边，再看工厂。
3. **启动了两份 Redis / 两份 DataSource？** 搜 \`forRoot(\`，看是不是被两个根路径各调一次。Feature 误写成 Root 也会。
4. **测试里单独 \`imports: [OrdersModule]\` 挂了？** 它依赖的 Root 资源（数据库、配置）没在测试模块里提供。这是模块图在提醒你：Orders 的测试边界要不要用 sqlite 的 \`forRoot\` 替身。
5. **循环报错指向模块而不是类？** 先画 import 边，不要先加 \`forwardRef\`。能拆出内核模块就拆。

能回答这五问，模块对你就不再是 \`@Module\` 装饰器清单，而是一张带可见性的图。

## 11. 小结

模块边界 = export 集合。对象图在边界里面长，查找规则沿 export 走。DynamicModule 是带参数的模块工厂：Root 放资源，Feature 放切片，Async 把配置再变成图上的节点。\`global\` 短路查找，只留给真正的单例基础设施。下一篇离开装配，看 Controller 怎样把 HTTP 翻译成一次函数调用。`,

  "nestjs-controllers-routing-and-params": `把 Controller 理解成「写业务的地方」会在生产里立刻失效。路由、版本、状态码、参数从哪来、先经过谁——这些是 **HTTP 到函数调用的翻译**。翻译完成之后，方法体里应该只剩「调用应用服务」。翻译过程（适配器、元数据、管道、守卫）比函数体更重要；函数体膨胀，说明翻译层在偷懒，业务规则被按 URL 切碎了。

这篇文章只讲这层翻译：Nest 怎样把装饰器变成适配器上的一条路由、参数装饰器从哪取原始值、版本和路径怎么组合、DTO 为什么不能是 Entity。读完你应该能独立回答三个问题：\`@Param('id')\` 为什么默认是 string、自定义参数装饰器该不该碰业务库、同一路径在 Express 和 Fastify 下行为分歧时该查适配器还是查方法体。

## 1. 先画边界：Controller 不是应用层

三层职责必须互斥：

- **Controller**：HTTP 语义。路径、动词、状态码、从 request 取数据、调用一个应用服务、把结果交给拦截器。
- **应用服务**：用例。事务边界、权限已经由 Guard 判定之后的领域动作。
- **领域 / 仓储**：不变规则和持久化。

Controller 注入十个 Repository 自己拼用例，测试必须起 HTTP 才能测折扣规则——那是翻译层吞了应用层。反过来，应用服务里读 \`req.headers\`，传输换 RPC 时用例一起废。

Nest 允许多个 Controller 属于同一模块，也允许一个 Controller 只挂查询、另一个只挂命令。这不是 REST 教条，是让路由表按变更频率切开。查询端的缓存拦截器和命令端的幂等 Guard 本来就不该缠在同一个类上。

不变量：**方法签名上的参数，必须能从 ExecutionContext 推导出来。** 需要「当前用户」就 \`@CurrentUser()\`，不要 \`@Req() req\` 再在方法里翻字段——翻字段是每个方法重复翻译。

## 2. 元数据 + 适配器：路由是挂上去的，不是 if 出来的

\`@Controller('orders')\`、\`@Get(':id')\` 在运行时只是元数据。\`RouterExplorer\` 扫原型上的方法，拼出路径，调用 \`HttpAdapter\` 的 \`get/post/...\`。ExpressAdapter 和 FastifyAdapter 实现同一份 \`AbstractHttpAdapter\`，但底层路由引擎不同：

- Express 的 \`path-to-regexp\`：\`/orders/:id\` 是字符串模式。
- Fastify 的 find-my-way：对静态路径更友好，约束写法（\`:id(^\\\\d+$)\`）和 Express 不完全同构。

所以「在 Express 正常、换 Fastify 404」优先查 **路径模式和插件封装**，不是查 Service。\`rawBody\`、\`multipart\`、\`prefix\` 的行为也按适配器分叉。项目选定一个适配器，测试就对着它跑；两套都要支持时，契约测试要覆盖路径和文件上传，而不是只覆盖 JSON 快乐路径。

全局前缀 \`app.setGlobalPrefix('api')\` 和版本前缀是适配器上的二次拼接。\`@Controller({ path: 'orders', version: '1' })\` 在 URI 版本策略下变成 \`/api/v1/orders\`。方法上再写 \`@Version('2')\` 覆盖类默认。版本不是 \`if (req.headers)\` 里的分支，是路由表里的另一条边。把版本 if 写进方法，等于放弃框架替你做的那张表。

## 3. 一次请求怎样落到方法

适配器匹配到路径之后，Nest 的执行上下文大致是：

1. 已注册的中间件（在适配器管道里，比 Guard 早）
2. Guards
3. Interceptors 的 \`intercept()\` 前半（洋葱外层）
4. 解析参数：每个参数装饰器取值，再跑该参数上的 Pipes
5. 调用方法
6. Interceptors 后半（\`map\` / \`tap\` 等）
7. 异常则 Exception Filter

第 4 步是 Controller 作为翻译层的核心。\`@Param('id')\` 从路由参数取 **字符串**。\`id === 10\` 永远假，\`id === '10'\` 才真。不经 \`ParseUUIDPipe\` / \`ParseIntPipe\` 就把 \`id\` 丢进仓储，数据库层会隐式转换或直接报错，错误码从 400 变成 500。

\`\`\`ts
@Controller({ path: "orders", version: "1" })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get(":id")
  findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.orders.findById(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthUser) {
    return this.orders.create(user.id, dto);
  }
}
\`\`\`

\`@HttpCode\` 声明协议，不要在方法里 \`res.status(201)\` 除非你在流式写出。一旦你拿了 \`@Res({ passthrough: false })\`，Nest 不再帮你把返回值交给拦截器，统一包装、计时、缓存拦截器会全部失效。能不碰底层 \`res\` 就不碰。

## 4. 参数装饰器：取值地点是契约

框架自带的取值地点：

| 装饰器 | 原始值 | 典型 Pipe |
|---|---|---|
| \`@Param(key)\` | 路径段，string | ParseUUID / ParseInt |
| \`@Query(key)\` | 查询串，string / string[] | 可选 ParseBool / 自定义 |
| \`@Body()\` | 已解析的 JSON 对象 | ValidationPipe |
| \`@Headers(key)\` | 头，string | 小写化已发生在部分适配器 |
| \`@Req()\` / \`@Request()\` | 整个 request | 尽量不用 |
| \`@Ip()\`、\`@Session()\` | 快捷方式 | 注意反向代理下的 IP |

查询参数在 HTTP 里没有类型。\`?page=2\` 是字符串 \`"2"\`。\`ValidationPipe({ transform: true })\` 能按 DTO 的 \`@Type(() => Number)\` 转；不转就在服务里 \`page + 1\` 变成 \`"21"\`。这不是 JS 的幽默，是翻译层没把协议落地。

\`@Query()\` 无 key 时拿到整个对象；有 key 时拿到一个字段。不要两个都写然后在方法里 merge。文件字段和 JSON 字段不要塞进同一个 DTO：multipart 的取值地点不是 \`body\` 解析器那条路。

## 5. 自定义参数装饰器：只取，不判

\`createParamDecorator\` 拿到 \`data\` 和 \`ExecutionContext\`，返回一个值，随后仍可接 Pipe。

\`\`\`ts
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as AuthUser | undefined;
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  },
);
\`\`\`

它 **可以** 抛 HTTP 异常，但不要在这里查数据库、不要在这里算 RBAC。取值地点一旦做授权，Guard 和装饰器会各判一次，错误码和日志会分叉。身份从哪来（JWT Guard 挂到 \`req.user\`）和从哪读（\`CurrentUser\`）要拆开。

\`ExecutionContext\` 能 \`switchToHttp/Rpc/Ws\`。写装饰器时不要假设一定有 \`req.params\`。同一个 \`CurrentUser\` 若要跨传输，应走 \`ctx.getType()\` 分支，或干脆分成两个装饰器。强行统一会把 HTTP 的 cookie 语义带进消息队列。

工厂返回的函数是按请求调用的，不是单例方法。闭包里捕获可变的模块级缓存，等于自己实现了一份不安全的单例。要缓存，注入服务，不要在装饰器文件顶层塞 Map。

## 6. DTO 是协议，Entity 是存储

\`CreateOrderDto\` 描述 **调用方允许提交的形状**。\`Order\` 实体描述 **怎么存**。两者重合时图省事会把实体直接 \`@Body()\`：于是密码哈希字段、内部状态机、乐观锁 version 都变成了 API。迁移加列变成破坏性 API 变更；Swagger 把不该公开的列写进契约。

输出同样。\`return this.repo.find()\` 把实体甩给拦截器，等于让表结构当响应协议。查询侧用只读模型或显式 mapper。代价是多一次映射；买到的是存储可以改列而不改契约。

校验属于 Pipe，本篇只强调边界：Controller 方法参数的类型应当是 DTO 类，这样 \`ValidationPipe\` 才知道用哪套装饰器。写成 \`Record<string, unknown>\` 或 \`any\`，管道只能原样放过。

版本演进：v1 和 v2 可以是两个 DTO、两个方法、同一应用服务。不要在一个 DTO 里用可选字段模拟两套协议——\`whitelist\` 和文档都会说谎。

## 7. 路由冲突、顺序、静态段

Express 风格下，\`@Get(':id')\` 会吃掉 \`@Get('export')\`，如果你把参数路由登记在静态路由前面。Nest 按方法在类上声明的顺序挂。静态段写在参数段上面。Fastify 对静态优先更友好，但不要靠引擎差异当设计。

\`@All()\`、\`@UseGuards\` 在类上时对所有方法生效。排除某一个方法，用方法级覆盖，不要在方法里 \`if (path === ...)\`。空路径 \`@Controller()\` 挂在前缀根上，容易和健康检查、静态资源抢。健康检查应走独立 Controller 或适配器级路由，不要塞进业务控制器的 \`@Get('health')\` 再靠文档保证没人定义 \`health\` 资源。

路由参数名和 DTO 字段名是两套空间。\`@Param('orderId')\` 和 body 里的 \`orderId\` 不会自动合并。需要两者时显式写两个参数，让管道分别校验。

## 8. 返回值、流、状态码

方法返回普通对象、Promise、Observable，适配器都会订阅/await，然后写 JSON。返回 \`StreamableFile\` 走文件路径。返回 \`undefined\` 且没声明 \`@HttpCode(204)\`，客户端可能拿到 200 空体，契约不稳定。

不要为了「RESTful」在 Controller 里根据结果 \`if\` 出一堆状态码。创建失败是应用异常，该由 Filter 映射 409/422；成功路径的 201/204 用装饰器固定。状态码是协议的一部分，应出现在方法的元数据上，Swagger 才能读到。

异常：\`NotFoundException\` 在应用服务抛或在 Controller 抛都可以，但要统一。Controller 里 \`if (!row) throw\` 意味着「HTTP 资源不存在」；领域里「订单状态不允许取消」不是 404。把后者写成 404，客户端会重试 GET 而不是改命令。

## 9. 设计取舍（为什么是现在这样）

- **装饰器元数据驱动路由**：和模块、DI 同一套反射。代价是路径拼错要到启动后才发现，编译器不认 \`@Get\`。
- **适配器模式**：换引擎不必换 Controller。代价是 multipart、前缀、错误形状在引擎之间有细缝，必须锁定适配器或锁定契约测试。
- **参数装饰器 + Pipe 管道**：取值和校验可组合。代价是自定义装饰器容易偷做授权和 IO。
- **不把 \`res\` 交给你**：拦截器才能统一包装。代价是流式、SSE、需要底层特性时必须显式退出这条路。

这些取舍决定了什么优化有意义。把业务 if 从 Service 搬进 Controller 不会更快；把 \`ParseUUIDPipe\` 拿掉只会把 400 变成 500。

## 10. 怎么把原理用到排障上

1. **404 但日志里方法没进？** 先打印实际注册路径（\`app.getHttpAdapter()\` 或启动 debug）。查全局前缀、版本、静态段顺序、适配器差异。
2. **id 比较总失败？** 类型还是 string。查有没有 Pipe，以及 \`transform\` 是否只对 \`@Body\` DTO 生效（对 \`@Param\` 要显式 Parse*）。
3. **拦截器没包上这层响应？** 方法是不是直接写了 \`res.json\`。
4. **自定义装饰器里偶发连库超时？** 它不该连库。挪到 Guard 或 Service。
5. **换 Fastify 后 body 空？** Content-Type、parser 插件、rawBody 配置在适配器，不在 DTO。

能回答这五问，Controller 对你就是一张路由表加一组取值函数，而不是「类里写业务的地方」。

## 11. 小结

Controller 的原理是「把 HTTP 语义翻译成一次函数调用」。路径和版本进路由表，参数装饰器决定取值地点，Pipe 决定类型和约束，方法体只调用用例。DTO 是协议，Entity 是存储。下一篇回到容器，看除了 \`@Injectable() class\` 之外，provider 还能以哪些工厂形态存在。`,

  "nestjs-providers-and-custom-providers": `把 provider 理解成「加了 \`@Injectable()\` 的 class」会在生产里立刻失效。容器认的是 **token + 如何得到实例**。class 只是最常见的一种工厂。对接老 SDK、按配置切换实现、异步连库、测试替身，全部靠另外三种 \`use*\`。自定义 provider 是容器的逃逸舱；逃逸舱当主通道用，模块图会变成配置垃圾场。

这篇文章只讲工厂这一层：四种 \`use*\` 各自买什么、token 相等性、异步工厂为什么阻塞 bootstrap、单例工厂里捕获请求数据为什么是泄漏。读完你应该能独立回答三个问题：接口多实现时 token 该是类还是 Symbol、\`useExisting\` 和再 \`useClass\` 一次差在哪、异步工厂失败为什么不应该被 \`try/catch\` 吃掉改成半启动。

## 1. 先画边界：provider 是登记，不是文件

一个 provider 最小是：

\`\`\`ts
{ provide: Token, useClass | useValue | useFactory | useExisting, ... }
\`\`\`

\`@Injectable() class Foo {}\` 写进 \`providers: [Foo]\` 时，Nest 把它展开成 \`{ provide: Foo, useClass: Foo }\`。展开之后和手写的自定义 provider 走同一套 \`InstanceWrapper\`。所以：**类能被注入，是因为被登记了，不是因为装饰器长得像 Java。** 没登记的 \`@Injectable()\` 只是一份没人读的元数据。

边界：

- **模块** 决定这个登记在哪张表、是否 export。
- **provider** 决定这个 token 怎么造。
- **作用域** 决定造出来活多久。

把「怎么造」写进业务方法（\`new Stripe()\`），登记表里没有 Stripe，测试无法 override。把「活多久」写进工厂闭包（自己做 Map 缓存），就和容器的 scope 打起来，泄漏时两套工具都看不到全貌。

## 2. 四种 use*：契约不同，不是风格不同

**useClass**。token 映射到一个类，容器负责 \`new\` 并解析该类的构造依赖。接口多实现、测试替换实现，用它。

\`\`\`ts
{ provide: PAYMENT_GATEWAY, useClass: StripeGateway }
\`\`\`

\`StripeGateway\` 自己仍要 \`@Injectable()\`（或显式列出它的依赖），否则下一层 \`design:paramtypes\` 缺失。

**useValue**。已经造好的对象塞进去。配置、时钟、假数据、启动时算死的常量。容器不再调用构造。对象的生命周期由你保证：进程级常量没问题；把 \`req\` 塞进 useValue 则所有请求共享这一份。

**useFactory**。函数里 \`new\` 或 \`await\`。可 \`inject\` 其它 token。条件实现、把非 Nest 库包一层、异步连接，用它。工厂返回值就是实例；返回 \`undefined\` 时，下游注入到的就是 \`undefined\`，错误会推迟到第一次方法调用。

**useExisting**。别名。两个 token 指向 **同一 wrapper 的同一实例**，不是再 new 一次。\`{ provide: Logger, useExisting: AppLogger }\` 让旧代码要 \`Logger\`、新代码要 \`AppLogger\` 时拿到同一个对象。写成 \`useClass: AppLogger\` 会得到两个实例，日志传输和缓冲会裂成两份。

\`\`\`ts
const CLOCK = Symbol("CLOCK");

const clockProvider = {
  provide: CLOCK,
  useFactory: () => ({ now: () => Date.now() }),
};
\`\`\`

时钟用 useFactory 而不是在业务里 \`Date.now()\`，是为了测试能 \`useValue({ now: () => 0 })\` 把时间钉死。这不是过度设计；这是把不可控的 IO 变成可替换的端口。

## 3. token 相等性：引用，不是名字

类 token：引用相等。打包双份、Jest 与 src 各一份，表现为「明明提供了却解析不到」。

字符串 token：内容相等。\`"DB"\` 和 \`"DB"\` 是一把钥匙。代价是全局扁平命名空间。约定用 \`const DB = "DB" as const\` 导出，禁止字面量散落。

Symbol token：引用相等。\`Symbol("DB")\` 写两次是两把钥匙。必须 \`export const DB = Symbol("DB")\` 单点导出。这是接口和多实现的默认选择。

Injection token 在错误信息里会 \`toString\`。Symbol 的描述字符串会出现在日志里，值得写清楚 \`"PAYMENT_GATEWAY"\` 而不是 \`"x"\`。

\`@Inject(DB)\` 的参数必须是 **值**。写成 \`@Inject("DB")\` 而 provider 用的是 Symbol，查找失败。TS 不会报。把 token 放进 types 文件再到处 import，比在装饰器里写字面量安全。

同一模块登记两个相同 token，后写的覆盖先写的，不一定警告。动态模块的 \`forRoot\` 和业务模块都提供 \`DATABASE_OPTIONS\` 时，查的是查找规则下「谁先被看见」，不是「谁更对」。token 命名要带限界上下文，不要人人都叫 \`"CONFIG"\`。

## 4. 异步工厂：失败应当阻止 listen

\`\`\`ts
{
  provide: DATABASE,
  useFactory: async (cfg: ConfigService) => {
    const url = cfg.getOrThrow("DATABASE_URL");
    const pool = await createPool({ url, max: 10 });
    return pool;
  },
  inject: [ConfigService],
}
\`\`\`

\`InstanceLoader\` 在启动路径上 \`await\` 这个工厂。连接被拒、URL 空、密钥服务超时，进程不该带着半套依赖去 \`listen(3000)\`。有人用 \`try/catch\` 返回 \`null\` 让启动「成功」，把失败推迟到第一个请求 500——探活会说就绪，流量进来再死。这是在推翻异步工厂的设计意图。

工厂 \`inject\` 的顺序就是参数顺序。写反，类型还可能因为 \`any\` 过编译，运行时把 ConfigService 当 URL 用。给工厂参数写具体类型，能挡一部分。

异步工厂里不要读散落的 \`process.env\`。那样 ConfigModule 的校验、schema、覆盖策略全部绕开，测试也难以替换。工厂只从已注入的 token 取数。

启动时间：五个异步工厂串行连五个下游，冷启动等于五段超时之和。能并行的，用一个工厂里 \`Promise.all\`，或接受「一个 DatabaseModule 连一套」。不要为每个 Repository 开一个异步连接工厂。

## 5. 作用域写在 provider 上，不是写在类心情上

\`\`\`ts
{
  provide: UnitOfWork,
  useClass: TypeormUnitOfWork,
  scope: Scope.REQUEST,
}
\`\`\`

类上 \`@Injectable({ scope: Scope.REQUEST })\` 和登记处的 \`scope\` 都能设。不一致时以 wrapper 为准，但不要设两次还设成不同值。自定义 provider 容易忘写 scope：\`useFactory\` 默认仍是单例。工厂闭包里若读了「第一次调用时的用户」，所有请求共享这个用户。

不变量：**单例工厂的闭包只允许捕获进程级数据。** 配置、环境、客户端选项可以。\`req\`、\`userId\`、ALS 里当前值不行——工厂在启动时跑一次（同步工厂）或每个 scope 实例跑一次。你在单例工厂里调用 \`als.getStore()\`，启动阶段 store 是空的，之后也不会再跑。

request-scoped 的工厂会每请求执行。里面 \`await\` 重操作，等于给每个请求加一段串行启动。连库仍然放单例；请求级工厂只组装轻量 UoW。

## 6. 多实现、条件实现、默认实现

端口 + 多个适配器是自定义 provider 的主场。

\`\`\`ts
{
  provide: PAYMENT_GATEWAY,
  useFactory: (cfg: ConfigService): PaymentGateway => {
    const kind = cfg.get("PAYMENT_KIND");
    if (kind === "stripe") return new StripeGateway(cfg.getOrThrow("STRIPE_KEY"));
    if (kind === "sandbox") return new SandboxGateway();
    throw new Error(\`unknown PAYMENT_KIND: \${kind}\`);
  },
  inject: [ConfigService],
}
\`\`\`

未知 kind 要在启动时抛。静默落到 sandbox 会在生产把真钱打到空实现。\`new StripeGateway\` 出现在工厂里是正当的——这里就是对接非 Nest 类的边界。\`StripeGateway\` 若自己还有依赖（logger、metrics），不要 \`new\`，改 \`useClass\` 或工厂里 \`inject\` 后再 \`new\`。

\`useExisting\` 适合「测试时把端口指到已登记的假实现」。\`overrideProvider(PAYMENT_GATEWAY).useExisting(SandboxGateway)\` 要求 Sandbox 已经是容器里的一个 token。更常见是 \`useValue(fake)\`。

默认实现不要靠「没配置就 new 真客户端」。没有密钥就启动失败。本地开发用明确的 \`PAYMENT_KIND=sandbox\`，让配置成为可审查的边，而不是隐式分支。

## 7. 第三方 SDK：包一层，再登记

不要把 SDK 客户端类型直接当 token 散落各处。SDK 升级改构造，你的 inject 点会炸一片。包一个薄工厂：

\`\`\`ts
export const S3 = Symbol("S3");

export const s3Provider = {
  provide: S3,
  useFactory: (cfg: ConfigService) => {
    const client = new S3Client({ region: cfg.getOrThrow("AWS_REGION") });
    return client;
  },
  inject: [ConfigService],
};
\`\`\`

业务只注入 \`@Inject(S3) private readonly s3: S3Client\`。超时、中间件、mock，全改这一处。测试 \`useValue\` 一个内存实现，不要 mock 模块路径。

销毁：SDK 若有 \`destroy()\`，在 \`OnModuleDestroy\` 里调。工厂只负责 create。把 destroy 忘了，测试 \`app.close()\` 之后仍占着 socket，Jest 不退出。这不是 Jest 的问题。

## 8. APP_* 增强器是特殊 token

\`APP_GUARD\`、\`APP_PIPE\`、\`APP_INTERCEPTOR\`、\`APP_FILTER\` 是核心模块认的多提供者 token。用它们登记全局增强器，**参与 DI 和模块导出**，比 \`app.useGlobalGuards(new AuthGuard())\` 能注入依赖。

\`\`\`ts
{
  provide: APP_GUARD,
  useClass: AuthGuard,
}
\`\`\`

登记多次 \`APP_GUARD\` 会得到多个全局 Guard，按登记顺序跑。不要既 \`useGlobalGuards\` 又 \`APP_GUARD\` 同一份，重复鉴权。这些 token 的查找不走你的业务模块 exports，它们被核心扫进去。仍然建议放在 \`AuthModule\` 的 providers 里并被根 import，这样测试可以不 import Auth 就没有全局 Guard。

## 9. 设计取舍（为什么是现在这样）

- **token 与实现分离**：替换策略是一等公民。代价是钥匙的相等性要你自己保证。
- **四种工厂而不是一种 \`new\`**：能表达值、类、函数、别名。代价是同一模块里混用时，读者要先问「这个 token 怎么造」。
- **异步工厂阻塞启动**：不会带病 listen。代价是配置错误表现为进程起不来，需要把日志打在工厂内部。
- **默认单例**：工厂闭包容易被当成「请求间的缓存」。代价是捕获错数据时非常安静。

这些取舍决定了什么优化有意义。给每个类都写 \`useFactory\` 不会更灵活，只会让依赖从构造函数逃到 \`inject\` 数组，类型检查变弱。能 \`useClass\` 就 \`useClass\`。

## 10. 怎么把原理用到排障上

1. **提供了却解析不到？** token 引用是否同一份。打印双方 \`Symbol\` 描述和 \`===\`。
2. **两个实例？** 本该 \`useExisting\` 写成了第二次 \`useClass\` / \`useFactory\`。
3. **启动成功但第一个请求才连库失败？** 工厂被写成同步返回了「稍后 connect 的对象」，或 \`try/catch\` 吞了错误。
4. **串用户？** 单例工厂或单例 class 捕获了请求数据。查闭包和字段，不要先查 HTTP。
5. **测试 override 无效？** override 发生在 compile 之后，或 override 的 token 和运行时不是同一引用。

能回答这五问，provider 对你就是「钥匙 + 工厂 + 缓存」，class 只是其中一种工厂。

## 11. 小结

Provider 是 token 加上得到实例的方法。\`useClass\` / \`useValue\` / \`useFactory\` / \`useExisting\` 四种契约对应四类问题：可注入的类、现成值、条件或异步构造、别名。异步失败应阻止启动；单例闭包禁止捕获请求。下一篇把时间轴拉到一次 HTTP 调用，看中间件在这张对象图之外、却在适配器管道之内做了什么。`,

  "nestjs-middleware-request-lifecycle": `把中间件理解成「Express 那套 \`app.use\` 的别名，想插哪层插哪层」会在生产里立刻失效。Nest 的请求路径是一条 **固定顺序的管道**，中间件只占据最靠近原生 Request 的那一段。它能改 header、挂 correlation id、挡明显的坏流量；它看不见装饰器元数据，也不该做鉴权和改响应体。把 JWT 校验写进中间件，RBAC 的 \`@Roles()\` 就成了摆设。

这篇文章只讲生命周期：每一段谁先跑、中间件怎样登记、为什么它拿不到干净的 ExecutionContext、请求 ID 如何用 ALS 传到后面的 Guard 和 Service。读完你应该能独立回答三个问题：Guard 里读不到的 header 是谁没挂上、拦截器计时为什么比中间件少一截、异常发生在 Guard 之前和之后分别谁能接住。

## 1. 先画边界：中间件属于适配器世界

Nest 同时活在两套坐标系：

- **适配器世界**：Express / Fastify 的请求对象、中间件函数、\`next()\`、插件。
- **增强器世界**：Guard / Pipe / Interceptor / Filter，靠 \`ExecutionContext\` 和容器。

中间件是第一套的钩子。class middleware 虽然能被注入，执行时仍是 \`(req, res, next) => void\`。没有 \`getHandler()\`，没有 \`Reflector.get(ROLES_KEY)\`，没有「这个方法标了 \`@Public()\`」除非你自己解析路由——而自己解析等于重写一半 RouterExplorer。

不变量：**需要读方法级元数据的逻辑，不能放中间件。** 鉴权判决、角色、限流按 handler 的例外，全部后移到 Guard。中间件只做与「哪一个 handler」无关的事：协议层的 request id、IP 接入、原始 body 缓存、CORS 已由适配器处理之后你仍要补的头。

把响应包装成 \`{ data }\` 也不是中间件的活。中间件在 handler 返回之前就把 \`res.end\` 包一层会和拦截器、异常过滤器抢写响应，表现为偶发 \`Cannot set headers after they are sent\`。

## 2. 黄金时序：谁包着谁

一次成功的 HTTP 调用，顺序是：

\`\`\`
Incoming request
  → 全局 app.use / 适配器插件
  → Nest MiddlewareConsumer 登记的中间件（按模块 configure 顺序）
  → Guards（全局 APP_GUARD → 控制器 → 方法）
  → Interceptors.intercept 前半（先登记的在外层）
      → Pipes（参数取值后的 transform）
      → Controller method
      → Service
  → Interceptors 后半（Observable pipe）
  → 写响应
\`\`\`

异常时：从抛出点跳到 **已经进入增强器世界之后** 的 Exception Filter。中间件里 \`throw\` 或 \`next(err)\` 走的是适配器的错误通道，**不一定** 进 Nest 的 \`@Catch()\`。这是最容易误诊的缝：你以为全局 Filter 能统一错误体，结果中间件抛的错被 Express 打成 HTML。

若干推论：

- Guard 失败（401/403）时，Pipe 和 handler 不跑，拦截器后半通常也不跑（具体取决于异常是否发生在 \`next.handle()\` 之前）。计时拦截器若只 \`tap\` 成功路径，会漏掉被拒的请求。
- Pipe 400 时 handler 不跑，拦截器已经进入，可以记「校验失败」。
- 拦截器 \`catchError\` 若吞掉异常并返回值，Filter 看不到。

官方文档把拦截器画在管道前面，实现上拦截器 **包着** 管道和 handler：\`intercept()\` 被调用之后，\`next.handle()\` 才去跑 pipes + method。所以「前半」早于管道，「后半」晚于方法。画成线性列表时不要忘了洋葱。

## 3. 函数中间件与 class 中间件

函数中间件和 Express 完全同构：

\`\`\`ts
export function helmetCompat(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
}
\`\`\`

它进不了容器。要注入 \`ConfigService\`、\`Metrics\`，写成 class：

\`\`\`ts
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  constructor(private readonly clock: Clock) {}

  use(req: Request, res: Response, next: NextFunction) {
    const id = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
    req.headers["x-request-id"] = id;
    res.setHeader("x-request-id", id);
    als.run({ requestId: id, startedAt: this.clock.now() }, () => next());
  }
}
\`\`\`

\`NestMiddleware.use\` 可以 async。rejected promise 若没落到 \`next(err)\`，Fastify 和 Express 的行为又分叉。async 中间件要么内部 \`try/catch\` 后 \`next(err)\`，要么明确你的适配器会把 rejection 当错误。不要假设 Nest Filter 会接。

\`configure\` 登记：

\`\`\`ts
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware, LoggerMiddleware)
      .exclude({ path: "health", method: RequestMethod.GET })
      .forRoutes("*");
  }
}
\`\`\`

\`apply\` 的顺序就是执行顺序。request id 必须在日志中间件之前，否则第一段日志没有 id。\`exclude\` 按路径，注意全局前缀：有的版本 exclude 要写带前缀的路径，有的不带。对一下实际匹配，不要凭文档记忆。

## 4. 全局 app.use 与 consumer.apply 不是同一张表

\`app.use(cors())\` 发生在 \`NestFactory.create\` 之后、\`listen\` 之前，挂在适配器最外层，对所有路径生效，包括你没写进任何模块的。第三方 Express 中间件（helmet、compression、raw body）走这里。

\`consumer.apply\` 走 Nest 的 \`MiddlewareModule\`，可以按路由、按方法、按模块切开，并且 class 中间件能注入。能用 consumer 表达的，不要退回 \`app.use\`——后者在测试里 \`createTestingModule\` 不会自动复现，除非你手动再挂一次。

反向：把 helmet 改写成 NestMiddleware 没有额外收益，还要自己维护。适配器级插件（Fastify 的 \`@fastify/helmet\`）应在适配器上注册，不要用 Express 中间件硬套 Fastify。

\`rawBody\` 必须在 JSON parser **之前** 挂。Parser 已经把流读完，中间件再读 body 是空的。支付回调验签失败，根因经常是这一层顺序，而不是算法写错。顺序属于适配器世界，查 \`NestFactory.create\` 附近，不查 Controller。

## 5. 请求 ID 与 AsyncLocalStorage

中间件是挂 ALS 的正确地点：此时请求已存在，Guard 还没跑，后续所有增强器和 Service 都能 \`als.getStore()\`。

\`\`\`ts
import { AsyncLocalStorage } from "node:async_hooks";

export type RequestStore = { requestId: string; startedAt: number };
export const als = new AsyncLocalStorage<RequestStore>();
\`\`\`

Logger 读 store 打 id，不必把 \`req\` 传入每一个方法。这和 request-scoped provider 互补：ALS 传的是 **值**（id、租户号），容器 scope 传的是 **对象图**（UoW）。不要用 ALS 塞整个 \`req\`——生命周期和序列化都不清楚，还容易在请求结束后被异步任务读到已经回收的对象。

丢失 store 的典型原因：在 \`als.run\` 之外 \`setImmediate\` / 某些原生回调里继续跑业务；或中间件忘记 \`als.run\` 直接 \`next()\`。队列消费者没有 HTTP 中间件，要在 Worker 入口自己 \`als.run\`。否则同一套 Logger 在 HTTP 有 id、在 Job 里没有，排障时对不上。

## 6. 中间件不该做的三件事

**鉴权。** 你可以在中间件里拆 Bearer，但判决必须留给 Guard，否则 \`@Public()\`、\`@Roles()\` 读不到。中间件一律要求登录，公开的 health、webhook 就要在 exclude 里堆路径字符串——路径一改就漏。

**改响应体。** 包装 \`{ code, data }\` 是拦截器。中间件劫持 \`res.write\` 会拆掉流式响应和 Filter 的 \`res.status().json()\`。

**业务 IO。** 中间件里查库「这个 IP 是不是用户」把适配器线程/事件循环和领域混在一起，超时错误还不进领域 Filter。IP 限流用专门组件（或网关），要状态就走 Guard + 注入的计数器。

这三条不是品味。是生命周期位置决定的能力边界。中间件早，脏，强；增强器晚，干净，能读元数据。能后移就后移。

## 7. Fastify 下的缝

Fastify 的 hook 是 \`onRequest\` / \`preHandler\` / \`onSend\`，和 Express 中间件不是一一对应。Nest 的 FastifyAdapter 把 NestMiddleware 映射进去，但：

- 你不能假设 \`req.query\` 的类型和 Express 相同。
- 插件必须 \`app.register\`，不能 \`app.use\` 一个 Express 函数就完。
- 错误处理器是 Fastify 的 \`setErrorHandler\`，和 Nest Filter 的衔接点在适配器。中间件 \`next(err)\` 的形状要符合适配器期望。

选定 Fastify 之后，第三方中间件优先找 Fastify 插件。硬套 \`express\` 中间件，等于在适配器里再嵌一个假 Express，性能和错误通道一起变差。

生命周期图在两种适配器上 **增强器世界那一段相同**，中间件那一段不同。排障先问「我在哪一套坐标系」。

## 8. 和 Guard / Interceptor 的分工表

| 需求 | 放哪 | 原因 |
|---|---|---|
| 生成 / 透传 request id | 中间件 + ALS | 最早，且与 handler 无关 |
| CORS、压缩、helmet | 适配器 / app.use | 第三方已成熟 |
| JWT 解析并挂 \`req.user\` | Guard（或 Passport 策略被 Guard 调用） | 要读 \`@Public()\` |
| 角色 / 权限点 | Guard + Reflector | 方法级元数据 |
| DTO 校验 | Pipe | 参数级，失败 400 |
| 计时、包装响应、缓存 | Interceptor | 包着 handler 的 Observable |
| 稳定错误体 | Filter | 最后一道，且只处理异常 |

同一需求写进两层，日志会双份、失败会双份。code review 只问这一张表，不问「有没有用中间件」。

## 9. 设计取舍（为什么是现在这样）

- **中间件留在适配器世界**：能复用整个 Express/Fastify 生态。代价是与元数据、DI 执行上下文断开，错误通道也可能断开。
- **固定增强器顺序**：推理简单，团队不必争论「Guard 和 Pipe 谁先」。代价是你无法把 Pipe 挪到 Guard 前面「先校验再鉴权」——要先鉴权后校验，这是刻意的（避免未认证用户靠 400 探测字段）。
- **拦截器包着管道**：AOP 能看到校验失败。代价是线性示意图和实现洋葱不一致，画错图就会把计时器挂错位置。
- **Filter 默认不管中间件 throw**：适配器错误先行。代价是统一错误体必须在中间件里自己 \`next\` 成 Nest 认识的异常，或避免在中间件 throw。

这些取舍决定了什么优化有意义。把鉴权前移到中间件「为了快一点」通常省不下一次 JWT verify 的量级，却拆掉了 \`@Public()\`。真要挡在更外，用网关或适配器插件做 TLS/IP，不要用业务 JWT。

## 10. 怎么把原理用到排障上

1. **Filter 没接到错误？** 看抛出点是不是中间件 / \`next(err)\`。先把它改成 Guard 抛 \`UnauthorizedException\`，或在中间件把错误转成 Nest 异常再抛进后续。
2. **Guard 读不到 request id？** 中间件顺序、ALS \`run\` 是否包住 \`next\`、是否被 exclude 掉了这条路由。
3. **计时比接入层少几十毫秒？** 少的是中间件和适配器插件。拦截器只包增强器世界。
4. **health 被鉴权拦了？** 全局 Guard 没有 \`@Public()\`，且 health 若只在中间件 exclude，Guard 仍会跑。exclude 中间件 ≠ 跳过 Guard。
5. **\`headers already sent\`？** 中间件和拦截器/Filter 抢着写 \`res\`。只留一层写响应。

能回答这五问，生命周期对你就是一条有缝的管道，缝在适配器世界和增强器世界之间。

## 11. 小结

中间件是适配器世界的钩子，生命周期最早，能力最脏。请求管道的顺序是固定的：中间件 → Guard → 拦截器（包着 Pipe 和 handler）→ Filter（仅增强器世界的异常）。能后移的逻辑就后移。下一篇专讲管道：原始值怎样变成方法签名想要的类型，以及 class-validator 怎样把 DTO 类当成 schema。`,

  "nestjs-pipes-and-validation-class-validator": `把校验理解成「在 Service 里 if 一下字段」会在生产里立刻失效。HTTP 进来的是 **未经信任的原始值**：字符串、任意 JSON、多出来的字段、类型谎言。Pipe 的职责是把原始值变成方法签名想要的值，失败用 400 拒绝，而不是进领域再炸 500。\`ValidationPipe\` + class-validator 是把 DTO 类当 schema；schema 若和运行时不是同一份，Swagger 和安全都在说谎。

这篇文章只讲输入这一层：Pipe 的 \`transform\` 契约、内置 Parse* 为什么抛 HTTP 异常、ValidationPipe 的四步、whitelist 防的是哪类事故、为什么领域规则不要写进 DTO 装饰器。读完你应该能独立回答三个问题：\`transform: true\` 没开时 \`page + 1\` 为什么变成字符串拼接、多余字段是被剥掉还是 400、Service 被队列调用时 HTTP 的 \`@IsEmail()\` 还在不在。

## 1. 先画边界：Pipe 处理输入，不处理输出

Pipe 实现：

\`\`\`ts
export interface PipeTransform<T = any, R = any> {
  transform(value: T, metadata: ArgumentMetadata): R | Promise<R>;
}
\`\`\`

它挂在参数上（\`@Param('id', ParseUUIDPipe)\`）、方法上、控制器上、或全局。执行点在拦截器已经 \`intercept()\` 之后、方法体之前。输出包装、计时、缓存不是它的活。

\`ArgumentMetadata\` 告诉你：这个参数是 body / param / query / custom，以及 \`metatype\`（DTO 类）。\`ValidationPipe\` 靠 metatype 决定用哪套 class-validator 装饰器。写成 \`any\` 或接口，metatype 退化，校验被跳过。**DTO 必须是类。**

不变量：**Pipe 失败 = 客户端请求不合法，默认 400。** 余额不足、状态机不允许，是业务异常，走领域 throw + Filter 映射 409。把业务规则写成 \`@IsIn(['DRAFT','PAID'])\` 可以表达协议枚举；把「库存够不够」写成自定义 class-validator constraint 并在装饰器里查库，Pipe 就变成了隐藏的应用服务，事务和鉴权都错位。

## 2. Parse*：单个原始值的类型落地

路径和查询永远是字符串。\`ParseIntPipe\`、\`ParseBoolPipe\`、\`ParseUUIDPipe\`、\`ParseEnumPipe\`、\`ParseArrayPipe\` 把一个字符串变成一个标量，失败抛 \`BadRequestException\`。

\`\`\`ts
@Get()
list(
  @Query("page", new ParseIntPipe({ min: 1 })) page: number,
  @Query("status", new ParseEnumPipe(OrderStatus, { optional: true })) status?: OrderStatus,
) {
  return this.orders.list({ page, status });
}
\`\`\`

\`ParseIntPipe\` 对 \`"10"\` 得到 \`10\`，对 \`"10abc"\`、\`""\`、\`undefined\`（非 optional）拒绝。不要自己 \`Number(id)\`：\`Number('')\` 是 \`0\`，\`Number('  ')\` 是 \`0\`，零号资源会被误打。

这些 Pipe 不读 class-validator。它们是标量工具。对象形状用 ValidationPipe。两者叠在同一参数上时按登记顺序执行，一般标量 Parse 在前或只挂一个。

自定义标量 Pipe 很薄：正则、白名单、trim。抛 \`BadRequestException\` 并带稳定 \`message\` / \`errorCode\`，Filter 才能保持协议。抛 \`Error("bad")\` 会变成 500。

## 3. ValidationPipe 的四步，一步都不能靠感觉

对 DTO 类，全局 \`ValidationPipe\` 实际在做：

1. **class-transformer** 把普通对象变成类实例（\`plainToInstance\`）。\`@Type(() => NestedDto)\` 决定嵌套和数组元素的类型。没 \`@Type\`，嵌套校验可能对原始字面量失效。
2. **class-validator** 跑装饰器：\`@IsString()\`、\`@IsEmail()\`、\`@ValidateNested()\` 等。
3. **whitelist**：剥掉 DTO 上没有装饰器的字段。防 mass assignment：客户端多传 \`role: 'admin'\`、\`balance: 999\`，进不了实例。
4. **forbidNonWhitelisted**：多字段直接 400，而不是静默剥离。审计更严的 API 用这个，客户端能立刻发现拼写错误的字段。

\`\`\`ts
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
  }),
);
\`\`\`

\`transform: true\` 让方法拿到类实例而不是 \`Object\` 字面量。\`instanceof CreateOrderDto\` 为真，嵌套类上的方法才能调。不开 transform，你以为的 DTO 只是 JSON。

\`enableImplicitConversion: true\` 会按 TS 设计类型乱转：\`"?page=2"\` 变数字，但 \`"on"\` 变布尔的规则并不直观。生产更稳的是显式 \`@Type(() => Number)\`，禁止隐式。隐式转换把协议错误吃成错误数据，比 400 更难查。

## 4. DTO 怎么写才是 schema 而不是愿望清单

\`\`\`ts
export class OrderItemDto {
  @IsUUID()
  skuId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity: number;
}

export class CreateOrderDto {
  @IsUUID()
  customerId: string;

  @Type(() => OrderItemDto)
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  items: OrderItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(140)
  note?: string;
}
\`\`\`

要点：

- 嵌套必须 \`@Type\` + \`@ValidateNested\`。漏一个，子对象等于没校验。
- 数组要 \`each: true\` 以及长度上限。没有上限的数组是内存炸弹。
- 可选字段 \`@IsOptional()\` 放在其它约束前面。空字符串 \`""\` 对 \`@IsOptional()\` 不是 \`undefined\`，\`@IsString()\` 仍会跑。要接受「没传」不接受「传空」，在协议上禁止空串，或 \`@Transform\` 把空串变 \`undefined\`。
- 不要给每个字段只写 \`@IsString()\` 了事。长度、格式、枚举才是边界。

\`@Transform(({ value }) => value.trim())\` 是输入规范化，可以留在 DTO。\`@Transform\` 里查数据库不是规范化。

class-validator 默认用一份全局元数据存储。两个 DTO 类名冲突（打包双份）会串装饰器。和 DI token 一样，类引用必须唯一。

## 5. 为什么不在 Service 里做 HTTP 形状校验

Service 会被 HTTP、CLI、队列、别的模块调用。HTTP 的形状（字段名、可选、字符串长度）是 **传输协议**。队列里的 payload 可能已经是内部命令对象，再跑一遍 \`@IsEmail()\` 没有意义，缺的是另一套 schema。

分层：

- **传输校验**（Pipe + DTO）：类型、必填、长度、格式、未知字段。失败 400。
- **领域校验**（实体方法 / 领域服务）：库存、余额、状态机、幂等键。失败是领域异常，映射 409/422。
- **存储约束**（唯一索引）：最后一道，不能当唯一一道。只靠 DB 唯一，错误码和字段路径对不齐前端。

在 Service 开头 \`if (!dto.email)\` 会让 CLI 也吃 HTTP 的规则。要复用，抽纯函数 \`assertCreateOrderShape\`，HTTP 侧用 DTO，队列侧用命令 schema，而不是让 Service 依赖 class-validator。

\`validate(dto)\` 手写调用可以出现在非 HTTP 入口。不要为了「统一」把 ValidationPipe 的 HTTP 异常直接扔进 Job——队列需要重试策略，400 语义的坏消息应进死信而不是 backoff。

## 6. 自定义 Pipe：组合，而不是再造一套校验器

当约束跨字段（「折扣码出现则必须有 couponId」）或依赖配置（「最大数量读自 Config」）时，class-validator 的自定义 constraint 能做，但注入容器不顺手。用自定义 Pipe：

\`\`\`ts
@Injectable()
export class MaxItemsPipe implements PipeTransform {
  constructor(private readonly cfg: ConfigService) {}

  transform(value: CreateOrderDto, meta: ArgumentMetadata): CreateOrderDto {
    const max = this.cfg.get("ORDER_MAX_ITEMS", 50);
    if (value.items.length > max) {
      throw new BadRequestException({
        error: "TOO_MANY_ITEMS",
        max,
      });
    }
    return value;
  }
}
\`\`\`

它假定 ValidationPipe 已经跑过，\`value\` 是合法实例。登记顺序：全局 ValidationPipe 先，方法上的 MaxItemsPipe 后。反过来，\`items\` 可能还是 \`undefined\`。

跨字段规则也可以 \`@ValidatorConstraint\` + \`@Validate\`。选 Pipe 还是 constraint：要注入 Nest 服务用 Pipe；纯同步、无依赖用 constraint，DTO 自包含，Swagger 插件更容易读到。

## 7. whitelist 防的事故叫 mass assignment

客户端 POST \`{ "email": "...", "role": "admin" }\`。如果 User 实体或 DTO 上有 \`role\` 且你 \`Object.assign(entity, dto)\`，用户给自己提权。whitelist 剥掉未声明字段，是这条链的第一刀。第二刀是 DTO 根本不声明 \`role\`。第三刀是应用服务显式挑字段赋值，而不是整包 assign。

\`forbidNonWhitelisted: true\` 让多字段变成 400。前端多发一个调试字段，接口就失败——这是好事，契约测试会立刻红。对公开的宽松 API（webhook 第三方会加未知字段），用剥掉而不 forbid，并在文档写明。默认在内部 API 上 forbid。

\`skipMissingProperties\`、\`skipNullProperties\` 会改变「没传」和 \`null\` 的含义。PATCH 和 POST 不该共用一个 DTO 配置：PATCH 常用 \`@IsOptional()\` 全场；POST 必填。两个类，不要一个类加一堆开关。

## 8. 文件、原始 body、和 JSON 不要共用一条 Pipe

multipart 的字段有的是文件，有的是字符串。\`ValidationPipe\` 对 \`File\` 没有默认语义。文件大小、mimetype 用专门的解析拦截器或平台管道，JSON 部分单独 DTO。

原始 body（验签）必须在 parser 之前留下 Buffer。ValidationPipe 看到的是已经 \`JSON.parse\` 的对象，签名已经无法对原始字节重算。验签不是 Pipe 的活，是中间件；Pipe 只校验 **验签通过之后** 的形状。

\`@Body('field')\` 取单字段时，metatype 可能是 \`String\` 而不是 DTO，ValidationPipe 会跳过对象规则。要校验对象，\`@Body() dto: CreateOrderDto\` 整包进。

## 9. 设计取舍（为什么是现在这样）

- **DTO 类当 schema**：和 TS、Swagger、transformer 同源。代价是装饰器噪音，以及接口/type 不能当 schema。
- **失败即 400**：协议错误和领域错误分开。代价是有人把领域规则塞进 DTO，400 变得语义含混。
- **whitelist 默认要你打开**：向后兼容旧代码。代价是忘记打开就等于没有 mass assignment 防护。
- **Pipe 可注入**：自定义规则能读配置。代价是顺序敏感，全局和参数级叠在一起时要明确谁先。

这些取舍决定了什么优化有意义。把 class-validator 换成 Zod 可以，但仍然要停在管道层，仍然要 whitelist 等价物。换库不是把校验搬回 Service 的理由。

## 10. 怎么把原理用到排障上

1. **校验完全没跑？** metatype 是不是类；全局 Pipe 是否注册；参数是不是 \`any\`；自定义装饰器有没有把 metatype 弄丢。
2. **嵌套对象没校验？** 缺 \`@Type\` 或 \`@ValidateNested\`。
3. **\`page + 1\` 变成 \`"11"\`？** \`transform\` 没开，或 Query 没用 ParseInt / \`@Type(() => Number)\`。
4. **多传字段进了数据库？** whitelist 没开，且服务 \`assign\` 了整包。
5. **队列消费同样 payload 却不过校验？** 那是 HTTP DTO 被误用在内部命令上。换 schema，或不要在这一层校验。

能回答这五问，管道对你就是「原始值 → 类型 + 约束」的边界，而不是装饰器清单。

## 11. 小结

Pipe 的原理是在方法调用前把输入变成签名想要的值。Parse* 管标量，ValidationPipe 管对象 schema。whitelist 是安全边界，transform 是类型边界，领域规则留在领域。DTO 是协议，Entity 是存储。下一篇讲 Guard：在管道之前，先回答「这个请求能不能进 handler」。`,

  "nestjs-guards-and-rbac-authentication": `把 Guard 理解成「登录中间件的 Nest 写法」会在生产里立刻失效。Guard 只回答一个问题：这个调用 **能不能进 handler**。它不负责怎么登录，不负责怎么签发 JWT，不负责改响应体。身份解析（你是谁）和授权判决（你能不能）必须拆开：混在一起时，401 和 403 会乱，\`@Public()\` 会失效，测试也只能真签 token。

这篇文章只讲判决这一层：\`canActivate\` 与 ExecutionContext、Passport 策略把 token 变成 \`req.user\`、Reflector 读方法上的权限点、RBAC 和更细的 permission、为什么中间件做不了同样的事。读完你应该能独立回答三个问题：未登录和没权限分别该 401 还是 403、\`@Roles()\` 写在类上和方法上谁覆盖谁、request-scoped 的当前用户为什么不该塞进单例 Guard 的字段。

## 1. 先画边界：Guard 在中间件之后、管道之前

时序上 Guard 已经进入增强器世界：能注入，能读 \`Reflector\`，能 \`switchToHttp()\`。它 **早于** Pipe。未认证用户甚至看不到「邮箱格式错误」的 400——这是刻意的，避免未登录探测字段。若产品要求「先校验再登录」，那是在推翻这条安全默认，需要自己写，不要抱怨框架。

\`canActivate\` 返回：

- \`true\`：放行
- \`false\`：框架转成 403（历史行为，语义含混）
- 抛 \`UnauthorizedException\`：401
- 抛 \`ForbiddenException\`：403

生产代码 **不要返回 false**，要显式抛。401 和 403 的客户端动作完全不同：401 去刷新 token / 跳登录，403 去停手。用 false 一律 403，前端会把过期登录显示成「没有权限」。

不变量：**Guard 可以读请求、读元数据、读已注入的鉴权服务；不要在这里开事务、不要写审计到业务表（审计用拦截器更合适）、不要改 body。** 判决应当近似纯：同一 \`user + 元数据 + 资源\` 多次调用同一结果（除非你故意做时间窗口限流）。

## 2. ExecutionContext：同一套 Guard 跨传输

\`\`\`ts
canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
  const type = context.getType<"http" | "rpc" | "ws">();
  if (type === "http") {
    const req = context.switchToHttp().getRequest();
    return this.decide(req.user, context);
  }
  if (type === "rpc") {
    const data = context.switchToRpc().getData();
    return this.decide(data.user, context);
  }
  throw new UnauthorizedException();
}
\`\`\`

\`getHandler()\` 和 \`getClass()\` 指向将要调用的方法和控制器类。Reflector 靠这两处读元数据。WebSocket 的握手鉴权和消息鉴权不是同一点：握手失败应直接断连接；消息级 Guard 跑在已连接之后。不要用 HTTP 的 Cookie 语义套 WS。

Guard 可以 async。里面 \`await this.users.find(id)\` 能工作，但每个请求多一次库往返。JWT 里放齐判决所需的 claims（角色、权限点、租户），Guard 只读 claims，把「用户被封禁」这类必须实时的检查留到短 TTL 或显式黑名单。每次请求查库的 Guard 会把鉴权变成数据库 QPS。

## 3. 认证：策略把凭证变成 user，Guard 只问有没有

Passport 在 Nest 里通常包成 \`AuthGuard('jwt')\`。策略的 \`validate()\` 返回值被挂到 \`req.user\`。这条链要拆开看：

1. 从 header / cookie 取出凭证（策略）
2. 验签、过期、issuer（策略 + 密钥）
3. 得到 \`user\` 对象（策略）
4. 没有 \`user\` 则 401（AuthGuard）
5. 有 \`user\` 再交给授权 Guard

\`\`\`ts
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(cfg: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: cfg.getOrThrow("JWT_SECRET"),
      issuer: cfg.get("JWT_ISSUER"),
    });
  }

  validate(payload: AccessTokenPayload): AuthUser {
    return {
      id: payload.sub,
      roles: payload.roles,
      permissions: payload.perms,
      tenantId: payload.tid,
    };
  }
}
\`\`\`

\`validate\` 不要做重 IO。它在每个需认证请求上跑。密钥轮换、audience 校验，属于策略配置，不是业务 Guard。

Cookie 会话和 Bearer 是两种凭证。混用时拆两个策略，不要一个 Guard 里 if。测试认证：\`overrideGuard(AuthGuard('jwt')).useValue({ canActivate: (ctx) => { ctx.switchToHttp().getRequest().user = fake; return true; } })\`，不要在单测里真签 JWT，除非你在测策略本身。

## 4. @Public()：默许拒绝，显式放行

全局 \`APP_GUARD\` 挂上 JwtAuthGuard 之后，每个路由默认要登录。公开端点必须显式标记，否则 health、登录、webhook 全 401。

\`\`\`ts
export const IS_PUBLIC = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
\`\`\`

\`getAllAndOverride\` 的参数顺序是 **方法优先于类**：方法上 \`@Public()\` 覆盖类上的「要登录」。\`getAllAndMerge\` 则合并数组。选错 API，类上 \`@Roles('admin')\` 和方法上 \`@Roles('user')\` 会变成并集或被覆盖，授权结果完全不同。权限点用 Override（方法写了就以方法为准）还是 Merge（叠加），必须在项目里定一条，写在 Guard 旁边，不要每个开发自己选。

webhook 的「公开」不是真公开：它跳过 JWT，但仍要验签中间件。\`@Public()\` 只跳过 JWT Guard，其它 Guard 仍跑。验签失败应 401/403，由专门 Guard 或中间件表达，不要把 webhook 当成普通 Public 页面。

## 5. RBAC：角色是权限的桶，判决应对齐权限点

用户 → 角色 → 权限点。API 上贴的应是 **权限点**（\`order.cancel\`），不是角色名。贴角色名 \`@Roles('admin')\` 图快，产品加一个「客服可取消」时你只能把客服并进 admin，或改一堆装饰器。

\`\`\`ts
export const PERMS = "perms";
export const RequirePerms = (...perms: string[]) => SetMetadata(PERMS, perms);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const need = this.reflector.getAllAndOverride<string[]>(PERMS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!need?.length) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as AuthUser | undefined;
    if (!user) throw new UnauthorizedException();

    const have = new Set(user.permissions ?? []);
    const ok = need.every((p) => have.has(p));
    if (!ok) throw new ForbiddenException({ error: "FORBIDDEN", need });
    return true;
  }
}
\`\`\`

没有 \`@RequirePerms\` 的方法：这个 Guard 放行。它假定前面的 JwtAuthGuard 已经拦过匿名用户。两个 Guard 的顺序：先认证，后授权。登记反了，授权 Guard 先跑，匿名用户会被当成 403。

角色仍可存在，作为签发 token 时展开权限点的输入。展开发生在登录/发牌，不发生在每个请求的 Guard 里查角色表——除非权限必须实时收回。实时收回用短 TTL + 黑名单，或每请求查缓存，不要每请求 join 三张表。

## 6. 资源级授权：Guard 还是领域？

「能不能取消 **这个** 订单」依赖资源归属。Guard 此时还没跑 Pipe，\`@Param('id')\` 可能仍是字符串，订单还没加载。两种拆法：

- **粗 Guard**：只判 \`order.cancel\` 权限点。归属在应用服务里判，失败 403。
- **细 Guard**：自己读 param、自己查库。能在进 handler 前挡掉，代价是和 Pipe 重复解析、和 Service 重复查库，缓存不一致时会出现「Guard 过了、Service 403」。

默认用粗 Guard + 领域判决。资源级判断和事务、聚合根在一起，才不会出现「权限过了但状态机不允许」和「状态对了但不是你的单」两套 if。只有极端敏感、且 handler 极重时，才在 Guard 预查。

不要在 Guard 里 \`new ParseUUIDPipe().transform(id)\` 复制管道。需要合法 id 才能判的，接受「先 400 后 403」或把资源级检查放进 Service。

## 7. 和中间件、拦截器的差别再钉一次

中间件先跑，但没有标准元数据。路径字符串 exclude 会腐烂。拦截器太晚：\`next.handle()\` 之前虽然也能抛，但管道可能已经跑过（取决于你是否在 \`next.handle()\` 前抛）。鉴权放拦截器，未登录用户能靠校验错误探测 DTO——正好违反 Guard 的时序。

Passport 的 Express 中间件模式（\`passport.authenticate\`）在 Nest 里被 Guard 包住，是为了进入 ExecutionContext。不要再 \`app.use(passport.initialize())\` 一套平行通道，否则 \`req.user\` 的时序和测试替身会有两份。

单例 Guard 是默认。不要把「当前 user」存 \`this.user\`。并发下这是别人的身份。user 只存在 \`req\` 上，或 request-scoped 的 \`AuthContext\`。Guard 自己保持无状态。

## 8. 多租户与上下文污染

\`tenantId\` 应来自已验签的 claims，而不是客户端 header 里随便一个 \`X-Tenant\`。header 只在网关已经绑死租户时可信。Guard 可以把 \`tenantId\` 写进 ALS 或 request-scoped 上下文，供仓储自动加约束。漏这一步，查询只按 \`id\` 会串租户。

超级管理员跨租户是一条显式权限点，不是 \`if (user.id === 1)\`。硬编码超级用户，测试和生产共用同一后门。

## 9. 设计取舍（为什么是现在这样）

- **Guard 只做布尔判决**：和管道、拦截器切开。代价是资源级授权不自然，需要和领域分工。
- **元数据 + Reflector**：授权规则贴在路由旁边。代价是字符串权限点和代码里的枚举会漂移，需要单测扫一遍「每个非 Public 方法都有权限点」。
- **JWT claims 带权限**：Guard 无 IO。代价是收回权限有延迟，必须接受 TTL 或上黑名单。
- **全局认证 + 显式 Public**：默认安全。代价是新路由忘记 Public 或忘记权限点，一个 401、一个裸奔，需要约定和扫描，而不是靠记忆。

这些取舍决定了什么优化有意义。把 Guard 里的 \`findUser\` 缓存可以减库压，但不如把判决所需数据放进 token。把所有方法标 \`@Roles('admin')\` 能过演示，过不了第二个角色。

## 10. 怎么把原理用到排障上

1. **登录用户一直 403？** 先看是返回 false 还是 Forbidden；再看 Reflector 用的 Override 还是 Merge；再看 token 里到底有没有那个权限点。
2. **过期 token 被前端当成没权限？** 你抛了 403 而不是 401。AuthGuard 必须先于 PermissionsGuard。
3. **\`@Public()\` 无效？** 全局 Guard 没有读 IS_PUBLIC，或另一个 Guard 仍在要 user。
4. **单测要起密钥？** 你在测错误的层。override Guard，单元测判决函数，契约测策略。
5. **偶发串用户？** 单例 Guard/Service 存了 user。查字段，不要先查 JWT 库。

能回答这五问，Guard 对你就是「在管道之前的授权切面」，身份解析和权限判决各司其职。

## 11. 小结

Guard 的原理是 \`canActivate(ExecutionContext)\`：读凭证留下的身份、读方法上的权限点、给出 401 或 403。Passport 策略只负责把 token 变成 \`user\`。RBAC 的角色在发牌时展开成权限点，请求路径上判权限点。资源归属默认留给领域。下一篇讲拦截器：在 handler 两边用 RxJS 包一层切面，处理输出、计时、缓存和失败观测。`,

  "nestjs-interceptors-aspect-oriented-programming": `把拦截器理解成「另一种中间件」会在生产里立刻失效。中间件拿不到方法元数据，也包不住返回值；Guard 只能说 yes/no。拦截器是 AOP：用 RxJS 在 **调用两边** 各切一刀。适合映射响应、计时、缓存、超时、事务边界。不适合鉴权（太晚，管道可能已跑）、不适合改路由（已经进来了）。

这篇文章只讲这层切面：\`next.handle()\` 为什么返回 Observable、多个拦截器怎样成洋葱、\`map\` / \`tap\` / \`catchError\` / \`timeout\` 各自该不该吞异常、缓存 key 为什么必须带用户维度。读完你应该能独立回答三个问题：全局包装 \`{ data }\` 之后 Filter 的错误体为什么不该再包一层 data、超时发生在哪条管道上、拦截器里 \`subscribe\` 一次会怎样把响应写两遍。

## 1. 先画边界：拦截器包着管道和 handler

实现契约：

\`\`\`ts
export interface NestInterceptor<T = any, R = any> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<R> | Promise<Observable<R>>;
}
\`\`\`

\`intercept\` 被调用时，Guard 已经放行，**管道还没跑**。你在 \`next.handle()\` **之前** 的同步代码，早于 Pipe；\`next.handle()\` 返回的流，发射的是 handler 的成功值，或在管道/handler 抛错时进入 error channel。

所以拦截器天然有两段：

- **前半**：读 ExecutionContext、打点、决定是否短路（缓存命中可以直接 \`of(cached)\` 而不调 \`next.handle()\`）。
- **后半**：对 Observable \`pipe(...)\`。

不变量：**必须返回这条（或派生的）Observable，且不要自己再 subscribe。** HTTP 适配器才是订阅者。你 \`next.handle().subscribe()\` 再返回另一条，handler 跑两次，响应写两次，第二次 \`headers already sent\`。

短路缓存：

\`\`\`ts
const hit = this.cache.get(key);
if (hit !== undefined) return of(hit);
return next.handle().pipe(tap((v) => this.cache.set(key, v)));
\`\`\`

短路意味着 Pipe 和 handler 都不跑。缓存的是 **已经过 Guard 的调用**。key 若不带用户，A 的命中会发给 B。这不是缓存库的问题。

## 2. 洋葱：先登记的在外层

两个拦截器 A、B，登记顺序 A 然后 B：

\`\`\`
A 前半
  B 前半
    pipes + handler
  B 后半
A 后半
\`\`\`

计时放外层（A），才能包含内层包装和内层缓存。包装 \`{ data }\` 放外层还是内层，决定缓存存的是裸对象还是包装后对象。两边必须一致，否则命中时多包一层或少包一层。

全局 \`APP_INTERCEPTOR\`、控制器 \`@UseInterceptors\`、方法级，由外到内叠在一起。项目应约定：全局只放计时/tracing/错误观测；包装响应要么全局一律，要么不要；业务缓存放方法级，避免所有 GET 都被同一套 key 规则套用。

顺序一旦靠「试试看」，洋葱会在下一次加拦截器时悄悄改语义。把顺序写进模块旁边的注释没有用，写进测试：断言包装后的形状、断言缓存存的是哪一层。

## 3. RxJS 操作符：每个都有错误语义

\`\`\`ts
@Injectable()
export class ObserveInterceptor implements NestInterceptor {
  constructor(private readonly metrics: Metrics) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const started = Date.now();
    const req = ctx.switchToHttp().getRequest();
    return next.handle().pipe(
      timeout(3000),
      tap({
        next: () => this.metrics.timing(req.route?.path, Date.now() - started, "ok"),
        error: () => this.metrics.timing(req.route?.path, Date.now() - started, "err"),
      }),
      catchError((err) => {
        if (err instanceof TimeoutError) {
          return throwError(() => new RequestTimeoutException());
        }
        return throwError(() => err);
      }),
    );
  }
}
\`\`\`

- \`map\`：改成功值。包装 \`{ data }\` 用它。不要在 \`map\` 里抛业务异常当流程控制，除非你清楚会进 error channel。
- \`tap\`：旁路，不改值。打点、日志。\`tap\` 里 throw 会把成功变成失败。
- \`timeout\`：成功值到达过晚则 error。超时的是 **Observable 的发射**，包含管道+handler+下游 IO。把超时写在网关和写在拦截器是两层；两边都写要统一预算。
- \`catchError\`：能吞。返回 \`of(fallback)\` 则 Filter **看不到** 异常，客户端拿到 200。返回 \`throwError(() => err)\` 则交给 Filter。观测性拦截器应当 rethrow；「降级空列表」必须显式产品决策，并打指标。

\`finalize\` 在成功失败取消时都会跑，适合结束 span。HTTP 客户端断开时，订阅被拆掉，handler 里的 Promise 仍可能继续——拦截器不能取消已经发出的 SQL，除非你把 AbortSignal 传进仓储。这是 Node 的现实：Observable 取消 ≠ 数据库取消。

## 4. 统一响应形状：成功和失败是两条协议

\`\`\`ts
@Injectable()
export class WrapDataInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<{ data: unknown }> {
    return next.handle().pipe(map((data) => ({ data })));
  }
}
\`\`\`

成功：\`{ data: T }\`。失败：Filter 输出 \`{ error: string, message, statusCode }\`。不要让拦截器在 \`catchError\` 里也包成 \`{ data: null, error }\` 还返回 200——客户端无法用 HTTP 状态做分支，重试策略全部失效。

文件下载、SSE、\`StreamableFile\` 被 \`map(data => ({ data }))\` 会毁掉流。包装拦截器要认返回类型，或这些方法 \`@SkipWrap()\`。全局包装看起来干净，遇到第一个导出 CSV 的接口就会脏。

\`undefined\` 返回值被包装成 \`{ data: null }\` 还是 204，属于协议，要在拦截器和 \`@HttpCode\` 之间选一个真相。两个都做，客户端一会儿空对象一会儿无 body。

## 5. 缓存拦截器：key 是安全边界

缓存切面只对 **纯查询** 有意义。带副作用的 POST 走缓存，是在随机丢掉命令。

key 至少包括：租户、用户（若结果因人而异）、路径、规范化后的 query、资源版本。不要只用 URL：同一 URL，管理员和用户看到的字段不同。不要把 Authorization 头整个当 key：token 每次刷新，缓存全失效，还把凭证写进 Redis key。

TTL 短于权限收回时间。用户被踢后 JWT 仍在 TTL 内，缓存会继续吐数据——这和 Guard 用 claims 的延迟是同一类问题，要一起设计。

\`cache.get\` 命中则短路管道。开发环境觉得「校验怎么没跑」：因为没进 Pipe。这是特性。对必须每次校验的端点不要挂缓存，或缓存放在更外的 CDN，由它处理未登录。

## 6. 事务边界：可做，但要认账

有人用拦截器在 \`next.handle()\` 外包 \`dataSource.transaction\`。能工作的条件是：handler 和仓储用 **同一** 管理器/QueryRunner，且 request-scoped UoW 从拦截器放进 ALS 或 Context。

条件不满足时：拦截器开了事务，Service 注入的却是默认 EntityManager，语句跑在事务外，提交空事务，看起来「切面很美」。

更直的做法：应用服务显式 \`transaction(async () => ...)\`。拦截器做事务只适合「所有写方法都遵守同一 UoW 约定」的代码库，并且有测试证明回滚真的回滚。不要作为第一选择。

## 7. 和 Filter、Pipe、Guard 抢责任

| 切面 | 拦截器该不该 |
|---|---|
| 输入类型/校验 | 否，Pipe |
| 能不能进 | 否，Guard |
| 成功值形状 | 是 |
| 计时 / tracing | 是 |
| 超时 | 可以，注意与网关重叠 |
| 异常 → HTTP 形状 | 否，Filter；拦截器只 rethrow 或转成领域异常 |
| 降级默认值 | 显式、可观测，否则否 |

拦截器 \`catchError\` 把 \`QueryFailedError\` 变成 \`ConflictException\` 再 throw，等于在切面做映射。可以，但会和 Filter 的映射表重复。选一层做「基础设施异常 → HTTP」，另一层不要再 switch。重复映射的症状是状态码对了、errorCode 变了，或反过来。

## 8. 测试拦截器：不要起全应用才知道洋葱

拦截器是函数：给定 Context 和 \`CallHandler\`，返回流。单元测试：

\`\`\`ts
const next: CallHandler = { handle: () => of({ id: "1" }) };
const out = await firstValueFrom(interceptor.intercept(ctx, next));
\`\`\`

测包装、测超时（\`handle\` 返回 \`NEVER\` 或延迟）、测 \`catchError\` 是否 rethrow。洋葱顺序用 e2e 断言最终 JSON 形状，不要用 e2e 断言内部 tap 调用次数——那会和实现绑死。

\`overrideInterceptor\` 在测试模块里换掉全局包装，让断言直接对裸对象。不要为了测试去改生产拦截器加 \`if (process.env.NODE_ENV)\`。

## 9. 设计取舍（为什么是现在这样）

- **Observable 而不是 Promise**：能表达多值、取消、超时操作符。代价是团队要懂「返回流、适配器订阅」；误 subscribe 事故很具体。
- **洋葱而不是线性列表**：外层能包含内层。代价是顺序成为语义的一部分。
- **不自动取消下游 IO**：实现简单。代价是超时拦截器只能让客户端先收到 408，SQL 仍可能跑完。
- **与 Filter 分家**：成功和失败两条协议。代价是有人用 catchError 统一成 200，把分家废掉。

这些取舍决定了什么优化有意义。把业务 if 搬进拦截器不会更 AOP，只会让切面依赖领域；把鉴权搬进拦截器不会更安全，只会让未登录用户看到 400。

## 10. 怎么把原理用到排障上

1. **响应包了两层 \`data\`？** 全局和方法级各包装一次，或缓存存的是已包装值又被 map 一次。
2. **错误也被包进 \`data\` 且 200？** \`catchError\` 吞了。拿掉，让 Filter 写错误体。
3. **handler 执行了两次？** 拦截器内部 subscribe，加上适配器再订一次。
4. **超时了 SQL 还在跑？** 预期行为。要取消必须把 signal 传到驱动。
5. **缓存串数据？** key 没有用户/租户维度。先修 key，不要先加大 Redis。

能回答这五问，拦截器对你就是包着调用的 Observable 切面，而不是「还能再挂一个 hook」。

## 11. 小结

拦截器的原理是洋葱状的 RxJS 包装：前半在管道之前，后半在 handler 之后，适配器才是订阅者。用它做成功路径的形状、时间、缓存和观测；用 Guard 做能不能进，用 Pipe 做输入，用 Filter 做失败形状。切面一旦吞异常或自己订阅，协议和生命周期一起坏。对象图、模块图、请求管道到这里合成一套可推理的运行时；再往后的异常过滤器、ORM 和消息，都只是这套运行时上的客户。`,
};
