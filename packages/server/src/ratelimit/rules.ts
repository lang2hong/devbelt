/**
 * 限流分桶与默认阈值。
 *
 * ## 为什么按 IP 分桶而不是按用户
 *
 * 限流跑在根作用域的 `onRequest`，早于 `authScope` 里的 `jwtVerify` —— 那时
 * `req.user` 还是空的，拿不到用户身份。而且真正需要挡的恰恰是**未认证**的
 * 请求（暴力登录、注册轰炸），它们本来就没有用户。所以只能按 IP。
 *
 * 代价是共用出口 IP 的用户会被算成一个人。这是固有缺陷（v2 无 DB 白名单，IP 豁免改由路由豁免表表达）。
 *
 * ## 默认阈值是怎么来的
 *
 * 不是拍脑袋，是从客户端代码推的。一次自动同步（`AutoSyncService.trigger` →
 * `SyncManager.tryAutoSync`）的实际请求数：
 *
 *   pull → 1 个 GET /api/sync
 *   push → 5 个 PUT /api/sync（SECTION_TYPES 有 5 个 section，逐个推，同一路由打 5 次）
 *   合计 6 个请求
 *
 * 触发点三个，其中防抖那个是流量大头：`extension.ts` 把 `history.onChanged`
 * 也并进了 `storeChanged`，而用户每执行一条查询就会变更 history。所以
 * `sync.auto=silent` 时，在 SQL 编辑器里连续跑查询会变成「每 3 秒一次完整同步」
 * ≈ 140 req/min，**单设备**。多人共用出口 IP 时还要乘人数。
 *
 * 于是阈值分两类：
 *
 * - **auth 类可以定得很紧**：合法流量确实极少（一天登录几次），而安全价值
 *   是实打实的（scrypt 每次十几毫秒 CPU，既是暴力破解面也是 DoS 放大面）。
 * - **sync/default 类只能当 DoS 天花板**：合法峰值本身就高且不可预测，
 *   定紧了就是在锁自己人。真正的收紧要靠真实流量数据再校正。
 */

/** 限流桶标识 */
export type RateLimitBucket =
  | 'auth-strict'
  | 'auth-refresh'
  | 'sync-write'
  | 'admin'
  | 'default';

export interface RateLimitRule {
  /** 时间窗内允许的最大请求数 */
  maxRequests: number;
  /** 时间窗长度（秒） */
  windowSeconds: number;
  /** 该桶是否启用。关掉等于该桶不限流 */
  enabled: boolean;
  /** 展示用说明，后台直接显示，省得管理员去翻代码 */
  description: string;
}

export const RATE_LIMIT_BUCKETS: readonly RateLimitBucket[] = [
  'auth-strict',
  'auth-refresh',
  'sync-write',
  'admin',
  'default',
] as const;

/**
 * 代码内置基线。
 *
 * 阈值回归代码常量：v2 无 DB 覆盖，改阈值需改码重部署。
 */
export const DEFAULT_RULES: Readonly<Record<RateLimitBucket, RateLimitRule>> = {
  'auth-strict': {
    maxRequests: 20,
    windowSeconds: 300,
    enabled: true,
    description:
      '登录/注册/改密。合法用户一天登录几次；20 次 scrypt 只烧约 0.3s CPU，' +
      '既挡暴力破解也挡 CPU 耗尽。',
  },
  'auth-refresh': {
    maxRequests: 120,
    windowSeconds: 300,
    enabled: true,
    description:
      'Token 续期。比登录宽松：多设备各自续期，且客户端遇 401 会重试，' +
      '容易出现短时突发。',
  },
  'sync-write': {
    maxRequests: 1200,
    windowSeconds: 60,
    enabled: true,
    description:
      '同步写入（push/rollback）。DoS 天花板，不是精确控制 —— 单设备实测' +
      '上限约 140 req/min，这里留了 8 倍余量给共用出口 IP。',
  },
  admin: {
    maxRequests: 600,
    windowSeconds: 60,
    enabled: true,
    description:
      '管理后台 API。用户详情页会并发拉取会话/设备/连接/同步/用量 5 个列表，' +
      '翻页时容易连打。',
  },
  default: {
    maxRequests: 1200,
    windowSeconds: 60,
    enabled: true,
    description: '其余端点的兜底桶。同样是 DoS 天花板。',
  },
};

/**
 * `METHOD 路由模板` → 桶。
 *
 * 键的两半都不能凭印象写：
 *
 * - **路径是 Fastify 的路由模板**（`req.routeOptions.url`），不是实际请求路径。
 * - **必须带 method**，因为 `/api/sync` 上 GET 是读、PUT 是写，共用一个模板。
 *   少了 method 这一维，要么把读也算进写的配额（读被挤掉），要么把写算成读
 *   （sync-write 完全不生效）。
 *
 * 这张表是手写字符串，没有任何编译期约束 —— 拼错一个键不会报错，只会让那个桶
 * 恒不命中并静默退化到 `default`。第一版就是这么错的（写了不存在的
 * `/api/sync/:section`，sync-write 从未生效）。`test/ratelimit/routeCoverage.test.ts`
 * 用 `onRoute` 钩子从真实 app 实例抓路由表来比对，专门守这件事。
 *
 * 未列出的走 `default`；`EXEMPT_ROUTES` 里的完全不限流。
 */
const ROUTE_BUCKETS: Readonly<Record<string, RateLimitBucket>> = {
  'POST /api/auth/login': 'auth-strict',
  'POST /api/auth/register': 'auth-strict',
  'POST /api/auth/change-password': 'auth-strict',
  'POST /api/auth/refresh': 'auth-refresh',
  'PUT /api/sync': 'sync-write',
  'POST /api/sync/rollback': 'sync-write',
};

/** 供 routeCoverage 测试比对真实路由表用 */
export const ROUTE_BUCKET_KEYS: readonly string[] = Object.keys(ROUTE_BUCKETS);

/**
 * 完全豁免限流的路由。
 *
 * `/health` 被监控探针高频轮询，挡它等于把自己的健康检查打成红色。
 * 静态资源（`/admin/*`）是前端 chunk，一次页面加载就十几个请求。
 */
const EXEMPT_ROUTES: readonly string[] = ['/health'];

/**
 * `method` + 路由模板归到哪个桶；返回 undefined 表示豁免。
 *
 * route 为空表示没匹配上任何路由（404 探测），归 `default` —— 扫描器同样要限。
 */
export function bucketForRoute(
  method: string | undefined,
  route: string | undefined,
): RateLimitBucket | undefined {
  if (!route) return 'default';
  if (EXEMPT_ROUTES.includes(route)) return undefined;
  // 静态资源：@fastify/static 注册的通配路由
  if (route.startsWith('/admin/') && route.includes('*')) return undefined;
  // HEAD 是 Fastify 给每个 GET 自动补的，与 GET 同桶
  const m = (method ?? 'GET').toUpperCase();
  const mapped = ROUTE_BUCKETS[`${m === 'HEAD' ? 'GET' : m} ${route}`];
  if (mapped) return mapped;
  if (route.startsWith('/admin')) return 'admin';
  return 'default';
}
