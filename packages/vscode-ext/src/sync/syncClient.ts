import { Agent, fetch as undiciFetch } from 'undici';

// 用 undici 包的 fetch + 直连 Agent，绕过两层问题：
//  1) VS Code 把 extension host 的 globalThis.fetch 替换成「走环境代理」的版本，不尊重 init.dispatcher；
//  2) undici 走 HTTP 代理对 http 目标用 CONNECT 隧道，与 Squid 不兼容 → Request was cancelled。
// 改用 undici 包的 fetch（bundled、纯 undici、尊重 dispatcher）+ 直连 Agent，绕过两者。server 为公网可直连。
const directAgent = new Agent();

/**
 * 同步客户端：封装与后端同步服务的 HTTP 通信。
 * 双 token：access(短期) + refresh(长期)；401 自动用 refresh 换新 access 并重试一次。
 * 网络错误与 5xx 指数退避重试（最多 3 次）；4xx 业务错误不重试。
 *
 * 两条与 refresh token 一次性语义相关的规则（细节见 refresh / tryRefresh）：
 *  - 刷新**单飞**：并发请求共用同一个刷新 promise，不会拿同一个 refresh token 并发换新
 *  - 刷新**不重试**：重发已消费的 token 会被服务端判为泄露并撤销全部会话
 */

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
}

/** 设备信息（登录/刷新时通过 header 上报；deviceId 为同设备判同键） */
export interface DeviceInfo {
  deviceName: string;
  deviceId: string;
  machineId: string;
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

/** 个人权益快照（personal_plans entitlement_snapshot）。 */
export interface PersonalEntitlement {
  allowedDatabaseTypes: string[];
  maxDevices: number;
}

export interface MeResponse {
  user: { userId: string; email: string; displayName: string | null; emailVerified: boolean; status: string; lastLoginTime: string | null };
  subscription: {
    planCode: string | null;
    status: string | null;
    entitlement: PersonalEntitlement | null;
    periodStartTime: string | null;
    periodEndTime: string | null;
  } | null;
}

export interface DeviceItem {
  deviceId: string;
  devicePlatform: string;
  deviceName: string;
  clientVersion: string;
  status: 'active' | 'revoked';
  lastUsedTime: string | null;
  createTime: string;
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

  /**
   * 注册：创建账号并发送验证邮件，201 不返回 token。
   * 后续须经 confirmEmail 验证邮箱，再 login 取得 token。
   */
  async register(email: string, password: string): Promise<{ ok: boolean }> {
    return (await this.postJson('/api/auth/register', { email, password }, false)) as { ok: boolean };
  }

  /** 消费初始邮箱验证 token（§5.1 单次消费）。 */
  async confirmEmail(token: string): Promise<{ ok: boolean }> {
    return (await this.postJson(`/api/auth/email-verifications/${encodeURIComponent(token)}/confirm`, undefined, false)) as { ok: boolean };
  }

  /** 匿名重发验证邮件（§5.1：不区分邮箱是否存在，响应恒成功，防枚举）。 */
  async resendVerification(email: string): Promise<{ ok: boolean }> {
    return (await this.postJson('/api/auth/email-verifications', { email }, false)) as { ok: boolean };
  }

  /** 登录 */
  async login(email: string, password: string): Promise<AuthResult> {
    return this.postForm('/api/auth/login', { email, password, ...this.deviceFields() });
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt, ...this.deviceFields() }),
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

  /** 修改密码，成功后撤销全部会话。 */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const res = await this.request('POST', '/api/auth/change-password', { currentPassword: oldPassword, newPassword }, true);
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(errBody.message || `Change password failed: ${res.status}`);
    }
  }

  /**
   * 通用鉴权请求（供组织 Workspace 复用）：自动 401 单飞刷新 + 5xx 退避重试，
   * 返回原始状态码 + 已解析的 JSON body（空 body 为 undefined）。
   *
   * 不在此处做业务错误码归因，
   * 组织侧的错误映射由 OrgClient 依据 `code`/`status` 完成。
   */
  async requestRaw(method: string, path: string, body?: unknown, opts?: { retry?: boolean }): Promise<{ status: number; body: unknown }> {
    const res = await this.request(method, path, body, true, opts?.retry);
    const text = await res.text();
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  }

  /** 当前用户 + 套餐 + 订阅 + 配额用量 */
  async getMe(): Promise<MeResponse> {
    const res = await this.request('GET', '/api/me', undefined, true);
    if (!res.ok) throw new Error(`Get me failed: ${res.status}`);
    return res.json() as Promise<MeResponse>;
  }

  /** 列当前用户全部设备。 */
  async listDevices(): Promise<{ devices: DeviceItem[] }> {
    const res = await this.request('GET', '/api/personal/devices', undefined, true);
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(errBody.message || `List devices failed: ${res.status}`);
    }
    return res.json() as Promise<{ devices: DeviceItem[] }>;
  }

  /** 撤销本人设备（§5.2 /api/personal/devices；Free 无配额，撤销恒允许）。 */
  async revokeDevice(deviceId: string): Promise<void> {
    const res = await this.request('DELETE', `/api/personal/devices/${encodeURIComponent(deviceId)}`, undefined, true);
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(errBody.message || `Revoke failed: ${res.status}`);
    }
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
   * 匿名 POST（无鉴权、无刷新），body 可缺省（如 confirm 仅 URL 携带 token）。
   *
   * `retry=false` 用于幂等性敏感的一次性操作（confirm/resend）：token 单次消费 /
   * 重发会作废旧 token，服务端已成功但响应在传输中失败时，重试会造成
   * 「已消费 token 被再次提交 → 401」而误报失败。与 refresh 同理，不走重试。
   */
  private async postJson(path: string, body: unknown, retry = true): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const init: RequestInit = { method: 'POST', headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = retry
      ? await this.fetchWithRetry(url, init)
      : await this.fetchImpl(url, { ...init, dispatcher: directAgent } as any);

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      const code = errBody.code ? ` [${errBody.code}]` : '';
      throw new Error(errBody.message ? `${errBody.message}${code}` : `Request failed: ${res.status}`);
    }
    return res.json().catch(() => ({}));
  }

  /**
   * 带重试 + 401 自动刷新的 HTTP 请求。
   * 401 且 needsAuth：尝试 refresh 换新 access，成功则重试一次。
   */
  private async request(method: string, path: string, body: unknown, needsAuth: boolean, retry = true): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    // body 为空时（GET / DELETE）不带 Content-Type，否则 fastify 的 content-type-parser
    // 会尝试解析空 body 报 FST_ERR_CTP_EMPTY_JSON_BODY（如 free 用户撤销设备应返回 403，
    // 却被 400 拦在 handler 之前）。
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const init: RequestInit = { method, headers };
    const tokenBefore = needsAuth ? this.getAccessToken() : undefined;
    if (tokenBefore) headers.Authorization = `Bearer ${tokenBefore}`;
    if (body !== undefined) init.body = JSON.stringify(body);

    // retry=false 仅关闭 5xx 指数退避重试（写操作幂等边界）；401 的单飞刷新+重发仍是
    // token 续期的正常语义，不受 retry 控制。
    const doFetch = (i: RequestInit): Promise<Response> =>
      retry ? this.fetchWithRetry(url, i) : this.fetchImpl(url, { ...i, dispatcher: directAgent } as any);

    let res = await doFetch(init);
    if (res.status === 401 && needsAuth) {
      const ok = await this.tryRefresh(tokenBefore);
      if (ok) {
        const newToken = this.getAccessToken();
        if (newToken) (init.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
        res = await doFetch(init);
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

  /**
   * login/refresh 请求体必填的设备字段。
   *
   * deviceKey 取 os machine id（跨重装稳定），缺失回退 vscode machineId，
   * 并清洗为 `[A-Za-z0-9_-]`、长度收敛到 16..128（不足用同字符集补齐兜底，
   * 避免登录被 400 拦下）。
   */
  private deviceFields(): { deviceKey: string; devicePlatform: string; deviceName: string; clientVersion: string } {
    const d = this.device;
    const raw = (d?.deviceId || d?.machineId || '').replace(/[^A-Za-z0-9_-]/g, '');
    const deviceKey = (raw.length >= 16 ? raw : raw.padEnd(16, '0')).slice(0, 128);
    return {
      deviceKey,
      devicePlatform: (d?.os ?? '').slice(0, 100),
      deviceName: (d?.deviceName ?? '').slice(0, 100),
      clientVersion: (d?.appVersion ?? '').slice(0, 100),
    };
  }
}
