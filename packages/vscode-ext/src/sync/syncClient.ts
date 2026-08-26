import { Agent, fetch as undiciFetch } from 'undici';

// 用 undici 包的 fetch + 直连 Agent，绕过两层问题：
//  1) VS Code 把 extension host 的 globalThis.fetch 替换成「走环境代理」的版本，不尊重 init.dispatcher；
//  2) undici 走 HTTP 代理对 http 目标用 CONNECT 隧道，与 Squid 不兼容 → Request was cancelled。
// 改用 undici 包的 fetch（bundled、纯 undici、尊重 dispatcher）+ 直连 Agent，绕过两者。server 为公网可直连。
const directAgent = new Agent();

/**
 * 同步客户端：封装与后端同步服务的 HTTP 通信。
 * 双 token：access(短期) + refresh(长期)；401 自动用 refresh 换新 access 并重试一次。
 * 分节同步：fetchSections/pushSection/listVersions/rollback（方案 A）。
 * 网络错误与 5xx 指数退避重试（最多 3 次）；4xx 业务错误不重试。
 *
 * 两条与 refresh token 一次性语义相关的规则（细节见 refresh / tryRefresh）：
 *  - 刷新**单飞**：并发请求共用同一个刷新 promise，不会拿同一个 refresh token 并发换新
 *  - 刷新**不重试**：重发已消费的 token 会被服务端判为泄露并撤销全部会话
 */

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  userId: number;
  role: string;
  user?: { id: number; email: string; role: string; planCode?: string };
  subscription?: { planCode: string; status: string; periodEndTime?: string };
  /** 兼容旧字段 */
  token: string;
}

/** 设备信息（登录/刷新时通过 header 上报；deviceId 为同设备判同键） */
export interface DeviceInfo {
  deviceName: string;
  deviceId: string;
  machineId: string;
  osMachineId: string;
  hostname: string;
  os: string;
  arch: string;
  osVersion: string;
  appName: string;
  appVersion: string;
  remoteName?: string;
  language: string;
  timezone: string;
}

export interface SectionData {
  section: string;
  encryptedData: string;
  version: number;
  updateTime: string;
}

export interface PullResult {
  sections: SectionData[];
}

export interface PushResult {
  version: number;
}

export interface VersionSummary {
  version: number;
  dataBytes: number;
  createTime: string;
}

export interface PlanInfo {
  code: string;
  name: string;
  priceMonth: number;
  priceYear: number;
  perSeatMaxDevices: number;
  perUserMaxPrivateConnections: number;
  perUserMaxOpenConnections: number;
  perUserPrivateSyncQuotaBytes: number;
  perUserSyncVersionRetention: number;
  perUserHistoryRetentionCount: number;
  features: number;
}

export interface MeResponse {
  user: { id: number; email: string; role: string; status: string };
  plan: PlanInfo;
  plans: PlanInfo[];
  subscription?: { planId: number; status: string; periodEndTime: string };
  usage: { devices: number; connections: number; syncBytes: number; history: number };
}

export interface DeviceItem {
  id: number;
  userId: number;
  deviceId: string;
  hostname?: string;
  os?: string;
  arch?: string;
  osVersion?: string;
  appName?: string;
  appVersion?: string;
  remoteName?: string;
  vsMachineId?: string;
  osMachineId?: string;
  language?: string;
  timezone?: string;
  revokedTime?: string;
  lastSeenTime?: string;
  createTime: string;
  updateTime: string;
}



/** 冲突错误：某 section 远端 version 已变化 */
export class SyncConflictError extends Error {
  constructor(public readonly section: string, public readonly latestVersion: number) {
    super(`sync conflict on section ${section}: remote version ${latestVersion}`);
    this.name = 'SyncConflictError';
  }
}

/** 设备数超限（server 403 DEVICE_LIMIT_EXCEEDED）：当前设备未绑定且配额已满 */
export class DeviceLimitExceededError extends Error {
  constructor() {
    super('Device limit reached. Upgrade to Pro to use this device, or contact the administrator.');
    this.name = 'DeviceLimitExceededError';
  }
}

/** 付费功能（server 403 PRO_FEATURE_REQUIRED）：free 套餐不可用 */
export class ProFeatureRequiredError extends Error {
  constructor() {
    super('Device management requires a paid plan. Upgrade to Pro.');
    this.name = 'ProFeatureRequiredError';
  }
}

/** 配额超限（server 403 QUOTA_EXCEEDED）：连接数 / 同步存储超限 */
export class QuotaExceededError extends Error {
  constructor(message?: string) {
    super(message || 'Plan quota exceeded. Upgrade to continue syncing.');
    this.name = 'QuotaExceededError';
  }
}

export class SyncClient {
  private static readonly MAX_ATTEMPTS = 3;
  /** 正在进行的刷新（单飞，见 tryRefresh） */
  private refreshInFlight?: Promise<boolean>;

  constructor(
    private readonly baseUrl: string,
    private readonly getAccessToken: () => string | undefined,
    /**
     * 取当前 refresh token。**允许返回 Promise**：调用方（AuthService）会实时
     * 从 SecretStorage 读最新值，而不是返回进程内存里的快照 —— 多窗口场景下
     * 内存快照可能是别的窗口已经轮换掉的旧 token，用它刷新会命中服务端的
     * 重用检测并导致全设备登出。
     */
    private readonly getRefreshToken: () => string | undefined | Promise<string | undefined>,
    private readonly onTokensRefreshed?: (access: string, refresh: string) => void | Promise<void>,
    private readonly device?: DeviceInfo,
    /** fetch 实现可注入（测试 mock 用；默认 undici 包 fetch，绕过 VS Code 对 globalThis.fetch 的代理包装） */
    private readonly fetchImpl: typeof undiciFetch = undiciFetch,
  ) {}

  /** 注册 */
  async register(email: string, password: string): Promise<AuthResult> {
    return this.postForm('/api/auth/register', { email, password });
  }

  /** 登录 */
  async login(email: string, password: string): Promise<AuthResult> {
    return this.postForm('/api/auth/login', { email, password });
  }

  /**
   * 用 refresh token 换新 access + 轮换 refresh。
   *
   * **刻意不走 fetchWithRetry。** refresh token 是一次性的：服务端收到就撤销旧的、
   * 签发新的。重发一个已经被消费掉的 token 会命中重用检测（服务端把它当成 token
   * 泄露的信号），后果是 `revokeAllForUser` —— 用户在所有设备上被登出。
   *
   * 而 fetchWithRetry 会在网络异常和 5xx 时重发同一个 body。5xx 尤其危险：
   * 服务端很可能已经撤销了旧 token 才失败的，重发必然踩雷。宁可让这次刷新失败
   * （调用方会把 401 冒泡给用户，重新登录一次即可），也不能把人从所有设备踢掉。
   */
  async refresh(): Promise<{ accessToken: string; refreshToken: string }> {
    // await：getRefreshToken 会去读 SecretStorage，拿的是跨窗口的最新值
    const rt = await this.getRefreshToken();
    if (!rt) throw new Error('no refresh token');
    const res = await this.fetchImpl(`${this.baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.deviceHeaders() },
      body: JSON.stringify({ refreshToken: rt }),
      dispatcher: directAgent,
    } as any);
    if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
    const body = (await res.json()) as { accessToken: string; refreshToken: string };
    // await：轮换结果必须在本次调用返回前落盘，否则其他窗口仍会读到旧 token
    await this.onTokensRefreshed?.(body.accessToken, body.refreshToken);
    return body;
  }

  /** 登出（撤销当前 refresh token） */
  async logout(): Promise<void> {
    const rt = await this.getRefreshToken();
    if (rt) await this.request('POST', '/api/auth/logout', { refreshToken: rt }, true);
  }

  /** 修改密码（改密后撤销全部会话） */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const res = await this.request('POST', '/api/auth/change-password', { oldPassword, newPassword }, true);
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(errBody.message || `Change password failed: ${res.status}`);
    }
  }

  /** 当前用户 + 套餐 + 订阅 + 配额用量 */
  async getMe(): Promise<MeResponse> {
    const res = await this.request('GET', '/api/me', undefined, true);
    if (!res.ok) throw new Error(`Get me failed: ${res.status}`);
    return res.json() as Promise<MeResponse>;
  }

  /** 上报用量累计计数（连接打开 / 查询执行）。v2 服务端无此路由，404 静默不阻塞同步。 */
  async reportUsage(usage: { connectionOpens: number; queryExecutes: number }): Promise<void> {
    const res = await this.request('POST', '/api/usage', usage, true);
    if (!res.ok && res.status !== 404) throw new Error(`Report usage failed: ${res.status}`);
  }

  /** 拉取同步分节（section 可选，无则全节） */
  async fetchSections(section?: string): Promise<PullResult> {
    const path = section ? `/api/sync?section=${encodeURIComponent(section)}` : '/api/sync';
    const res = await this.request('GET', path, undefined, true);
    await this.throwIfDeviceLimit(res);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return res.json() as Promise<PullResult>;
  }

  /** 推送单节（乐观锁 baseVersion；附带明文 itemCount + 连接元数据供服务端计量） */
  async pushSection(section: string, encryptedData: string, baseVersion: number, itemCount?: number, meta?: unknown[]): Promise<PushResult> {
    const res = await this.request('PUT', '/api/sync', { section, encryptedData, baseVersion, itemCount, meta }, true);
    await this.throwIfDeviceLimit(res);
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { version?: number };
      throw new SyncConflictError(section, body.version ?? 0);
    }
    if (!res.ok) throw new Error(`Push failed: ${res.status}`);
    return res.json() as Promise<PushResult>;
  }

  /** 列历史版本 */
  async listVersions(section: string): Promise<VersionSummary[]> {
    const res = await this.request('GET', `/api/sync/versions?section=${encodeURIComponent(section)}`, undefined, true);
    if (!res.ok) throw new Error(`List versions failed: ${res.status}`);
    const body = (await res.json()) as { versions: VersionSummary[] };
    return body.versions;
  }

  /** 回滚到指定版本 */
  async rollback(section: string, toVersion: number): Promise<PushResult> {
    const res = await this.request('POST', '/api/sync/rollback', { section, toVersion }, true);
    if (!res.ok) throw new Error(`Rollback failed: ${res.status}`);
    return res.json() as Promise<PushResult>;
  }

  /** 列当前用户全部设备（含绑定状态） */
  async listDevices(): Promise<{ devices: DeviceItem[]; currentDeviceId?: string }> {
    const res = await this.request('GET', '/api/devices', undefined, true);
    if (!res.ok) throw new Error(`List devices failed: ${res.status}`);
    return res.json() as Promise<{ devices: DeviceItem[]; currentDeviceId?: string }>;
  }

  /** 撤销设备（释放配额位；free 由服务端 403 兜底） */
  async revokeDevice(deviceId: string): Promise<void> {
    const res = await this.request('DELETE', `/api/devices/${encodeURIComponent(deviceId)}`, undefined, true);
    await this.throwIfDeviceLimit(res);
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(errBody.message || `Revoke failed: ${res.status}`);
    }
  }

  /** 识别服务端 403（设备数超限 / 付费功能 / 配额超限），转成客户端可判定的错误类型 */
  private async throwIfDeviceLimit(res: Response): Promise<void> {
    if (res.status !== 403) return;
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    if (body.code === 'DEVICE_LIMIT_EXCEEDED') throw new DeviceLimitExceededError();
    if (body.code === 'PRO_FEATURE_REQUIRED') throw new ProFeatureRequiredError();
    if (body.code === 'QUOTA_EXCEEDED') throw new QuotaExceededError(body.message);
  }

  private async postForm(path: string, body: object): Promise<AuthResult> {
    const res = await this.request('POST', path, body, false);
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(errBody.message || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<AuthResult>;
  }

  /**
   * 带重试 + 401 自动刷新的 HTTP 请求。
   * 401 且 needsAuth：尝试 refresh 换新 access，成功则重试一次。
   */
  private async request(method: string, path: string, body: unknown, needsAuth: boolean): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    // body 为空时（GET / DELETE）不带 Content-Type，否则 fastify 的 content-type-parser
    // 会尝试解析空 body 报 FST_ERR_CTP_EMPTY_JSON_BODY（如 free 用户撤销设备应返回 403，
    // 却被 400 拦在 handler 之前）。
    const headers: Record<string, string> = { ...this.deviceHeaders() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const init: RequestInit = { method, headers };
    const tokenBefore = needsAuth ? this.getAccessToken() : undefined;
    if (tokenBefore) headers.Authorization = `Bearer ${tokenBefore}`;
    if (body !== undefined) init.body = JSON.stringify(body);

    let res = await this.fetchWithRetry(url, init);
    if (res.status === 401 && needsAuth) {
      const ok = await this.tryRefresh(tokenBefore);
      if (ok) {
        const newToken = this.getAccessToken();
        if (newToken) (init.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
        res = await this.fetchWithRetry(url, init);
      }
    }
    return res;
  }

  /**
   * 尝试刷新 token；失败返回 false（不抛，由调用方处理 401）。
   *
   * ## 为什么需要单飞
   *
   * 并发请求会同时撞上 access token 过期。若各自去刷新，就是**多个请求带着同一个
   * refresh token 打 /api/auth/refresh** —— 而 refresh token 是一次性的，服务端的
   * 「查 → 撤销 → 签发」三步还不是原子的。两种时序都很糟：
   *
   *  - 都在撤销前读到未撤销 → 各自签发新 token，客户端只留下后写入的那个，
   *    另一个成了没人管的有效 token（凭据泄露）
   *  - 后到的读到 revokedTime 已置位 → 服务端认为 token 泄露，
   *    revokeAllForUser → **用户在所有设备上被登出**
   *
   * 所以同一时刻只允许一次刷新在飞，其余调用等同一个 promise。
   *
   * @param tokenAtRequestTime 发起该请求时用的 access token。若刷新已由别人完成
   *        （当前 token 已经变了），说明这个 401 是拿旧 token 打出来的，直接重试
   *        就行，不需要再刷一次。
   */
  private async tryRefresh(tokenAtRequestTime: string | undefined): Promise<boolean> {
    // 已经有人刷新过了：当前 token 与发请求时不同 → 直接用新的重试
    const current = this.getAccessToken();
    if (current && current !== tokenAtRequestTime) return true;

    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh()
        .then(() => true)
        .catch(() => false)
        // finally 保证无论成败都清掉，否则一次失败就把刷新能力永久锁死
        .finally(() => { this.refreshInFlight = undefined; });
    }
    return this.refreshInFlight;
  }

  /** fetch + 5xx 指数退避重试（1s/2s）；4xx 立即返回 */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < SyncClient.MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchImpl(url, { ...init, dispatcher: directAgent } as any);
        if (res.status >= 500) throw new Error(`server error ${res.status}`);
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < SyncClient.MAX_ATTEMPTS - 1) {
          await this.delay(1000 * 2 ** attempt);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('request failed after retries');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** 设备标识头（登录/刷新时上报设备信息） */
  private deviceHeaders(): Record<string, string> {
    const d = this.device;
    if (!d) return {};
    const headers: Record<string, string> = {
      'X-Device-Name': d.deviceName,
      'X-Device-Id': d.deviceId,
      'X-Device-Machine-Id': d.machineId,
      'X-Device-Hostname': d.hostname,
      'X-Device-Os': d.os,
      'X-Device-Arch': d.arch,
      'X-Device-Os-Version': d.osVersion,
      'X-Device-App': d.appName,
      'X-Device-App-Version': d.appVersion,
      'X-Device-Language': d.language,
      'X-Device-Timezone': d.timezone,
    };
    if (d.remoteName) headers['X-Device-Remote'] = d.remoteName;
    return headers;
  }
}
