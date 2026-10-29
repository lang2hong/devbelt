import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { hostname, platform, arch, release } from 'os';
import { SyncClient, AuthResult, DeviceInfo, MeResponse } from '@devbelt/db-host/sync/syncClient';
import { eventBus, AuthEvent } from '@devbelt/db-host/utils/event';
import {
  DEFAULT_FREE_ENGINES,
  DEFAULT_FREE_MAX_CONNECTIONS,
  DEFAULT_FREE_MAX_AUTH_ENTRIES,
  DEFAULT_FREE_MAX_DEVICES,
  DEFAULT_FREE_MAX_CONCURRENT_CONNECTIONS,
} from '@devbelt/db-host/sync/entitlementGate';

// 由 esbuild 构建时从 .env / .env.production 注入（见 esbuild.js 的 define）；测试环境由 vitest.config.ts 提供同名字段
declare const __SYNC_SERVER_URL__: string;

/** 默认同步服务器地址（构建时由 esbuild 从 .env / .env.production 注入） */
export const DEFAULT_SERVER_URL = __SYNC_SERVER_URL__;

// CachedEntitlement 定义已下沉到 @devbelt/db-host（宿主无关）；此处 re-export 保持旧导入路径可用。
import type { CachedEntitlement } from '@devbelt/db-host/sync/entitlementGate';
export type { CachedEntitlement };


let _osMachineId: string | undefined;

/** 操作系统级 machine id（跨 VSCode 重装稳定，重装系统才变），作为 device 判同依据。
 *  Linux: /etc/machine-id；macOS: IOPlatformUUID；Windows: MachineGuid（注册表）。 */
function getOsMachineId(): string {
  if (_osMachineId !== undefined) return _osMachineId;
  try {
    const id = (() => {
      switch (platform()) {
        case 'linux': return readFileSync('/etc/machine-id', 'utf8').trim();
        case 'darwin': {
          const out = execSync('ioreg -d2 -c IOPlatformExpertDevice', { encoding: 'utf8' });
          const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
          return m ? m[1] : '';
        }
        case 'win32': {
          const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf8' });
          const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/);
          return m ? m[1] : '';
        }
        default: return '';
      }
    })();
    _osMachineId = id || '';
  } catch {
    _osMachineId = '';
  }
  return _osMachineId;
}

function timezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** 组装设备信息：deviceId = osMachineId（跨 VSCode 重装稳定的判同键）；
 *  machineId 为 VSCode 原始值（可随重装变化，仅追溯）。 */
function buildDeviceInfo(): DeviceInfo {
  const name = `${hostname()} · ${platform()}/${arch()} · VSCode ${vscode.version}`;
  const osMachineId = getOsMachineId();
  return {
    deviceName: name.length > 120 ? name.slice(0, 120) : name,
    deviceId: osMachineId,
    machineId: vscode.env.machineId,
    hostname: hostname(),
    os: platform(),
    arch: arch(),
    osVersion: release(),
    appName: vscode.env.appName,
    appVersion: vscode.version,
    remoteName: vscode.env.remoteName || undefined,
    language: vscode.env.language,
    timezone: timezoneName(),
  };
}

/**
 * 认证服务：管理双 token（access + refresh）的持久化。
 * access token：短期 JWT（内存 + secrets 缓存）
 * refresh token：长期随机 token（secrets 持久化，用于续约）
 * 401 时 SyncClient 自动用 refresh 换新 access（onTokensRefreshed 回调存回）。
 */
export class AuthService {
  private static readonly ACCESS_TOKEN_KEY = 'devbelt.auth.accessToken';
  private static readonly REFRESH_TOKEN_KEY = 'devbelt.auth.refreshToken';
  private static readonly USER_EMAIL_KEY = 'devbelt.auth.email';
  /** 规范 userId：解锁时用它定位本地 sync state/DEK，避免重启后必须联网拉 /api/db/me。 */
  private static readonly USER_ID_KEY = 'devbelt.auth.userId';
  private static readonly ENTITLEMENT_CACHE_KEY = 'devbelt.sync.cachedEntitlement';
  /**
   * 跨窗口权益刷新哨兵（SecretStorage）：值只在**套餐字段**变化时改变。
   * 多窗口宿主的 globalState 没有变更事件，用 SecretStorage 的 onDidChange 作为
   * "另一个窗口刷新了权益"的唯一可靠信号。
   */
  private static readonly ENTITLEMENT_GEN_KEY = 'devbelt.sync.cachedEntitlement.gen';

  /** 同步客户端（token 通过 getter 实时读取） */
  readonly client: SyncClient;

  private accessToken?: string;
  private refreshToken?: string;
  /** 缓存的个人权益，持久化到 globalState 供重启后弱网回退。 */
  private cachedEntitlement?: CachedEntitlement;
  /** 缓存的规范 userId（来源 GET /api/db/me），登出清空。 */
  private cachedUserId?: string;
  /** 认证身份变更计数：login/logout 递增。用于丢弃飞行中 /api/db/me 的过期结果（换号/登出竞态）。 */
  private authGeneration = 0;
  /** 刷新被拒后的清理幂等标记：并发 401 只清一次、只广播一次 logout。 */
  private authExpiredHandled = false;
  /**
   * 本窗口已知的 userId（"我自己写入的"或"启动时读到的"）。SecretStorage 的 onDidChange 在
   * 写入方窗口自己也会触发，靠它区分「本窗口的回声」和「另一窗口换了账号」。
   */
  private knownUserId?: string;
  private readonly externalIdentityListeners = new Set<(change: { from?: string; to?: string }) => void>();

  /**
   * 另一个窗口把登录身份换成了不同的 userId（换号 / 登出）。
   *
   * 本窗口已解锁的同步会话仍持有旧账号的密钥，却会带着新账号的 token 去请求，服务端只会
   * 拒绝，表现为一个没有解释的停摆图标。调用方据此停掉同步会话并提示用户重新加载窗口。
   * 本窗口自己的登录/登出不会触发（它们走 AuthEvent）。
   */
  onExternalIdentityChange(listener: (change: { from?: string; to?: string }) => void): { dispose(): void } {
    this.externalIdentityListeners.add(listener);
    return { dispose: () => { this.externalIdentityListeners.delete(listener); } };
  }

  private emitExternalIdentityChange(change: { from?: string; to?: string }): void {
    for (const l of [...this.externalIdentityListeners]) {
      try { l(change); } catch { /* 监听方异常不影响其他监听方 */ }
    }
  }

  /** 本窗口写 userId：先更新「已知值」再写盘，这样 onDidChange 回声不会被当成别的窗口。 */
  private async storeUserId(userId: string): Promise<void> {
    this.knownUserId = userId;
    await this.secrets.store(AuthService.USER_ID_KEY, userId);
  }

  private async deleteUserId(): Promise<void> {
    this.knownUserId = undefined;
    await this.secrets.delete(AuthService.USER_ID_KEY);
  }

  /**
   * 读取当前用户规范 userId；内存 → 持久化 → /api/db/me。
   *
   * 持久化这一层是离线/弱网解锁的前提：本地 DEK 以 `<userId>.<epoch>` 为 key，
   * 重启后若必须先联网拿 userId，断网时即使 DEK 还在也解不了锁。
   */
  async getUserId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId;
    const stored = await this.secrets.get(AuthService.USER_ID_KEY);
    if (stored) {
      this.cachedUserId = stored;
      this.knownUserId ??= stored;
      return stored;
    }
    const me = await this.getMe();
    return me.user.userId;
  }

  /** 当前设备判同 id（OS machine id），用于账户中心标记“当前设备”。 */
  currentDeviceId(): string {
    return getOsMachineId();
  }

  /** 读取缓存权益：优先内存，回退 globalState；无 allowedDatabaseTypes 的无效缓存直接忽略。 */
  getCachedEntitlement(): CachedEntitlement | undefined {
    if (this.cachedEntitlement) return this.cachedEntitlement;
    if (this.memento) {
      const stored = this.memento.get<CachedEntitlement>(AuthService.ENTITLEMENT_CACHE_KEY);
      if (stored && typeof stored.planCode === 'string' && Array.isArray(stored.allowedDatabaseTypes) && typeof stored.maxDevices === 'number') {
        this.cachedEntitlement = stored;
      } else if (stored) {
        this.memento.update(AuthService.ENTITLEMENT_CACHE_KEY, undefined);
      }
    }
    return this.cachedEntitlement;
  }

  /** 设置缓存权益，同步写 globalState。 */
  setCachedEntitlement(entitlement: CachedEntitlement): void {
    const previous = this.cachedEntitlement;
    this.cachedEntitlement = entitlement;
    try {
      this.memento?.update(AuthService.ENTITLEMENT_CACHE_KEY, entitlement);
    } catch { /* memento 写失败不影响本次判断 */ }
    // 套餐字段变化（升级/降级）时写跨窗口哨兵，让其它窗口丢弃内存缓存并重新拉取。
    const planChanged =
      previous === undefined ||
      previous.planCode !== entitlement.planCode ||
      JSON.stringify(previous.allowedDatabaseTypes ?? []) !== JSON.stringify(entitlement.allowedDatabaseTypes ?? []);
    if (planChanged) void this.pushEntitlementGen();
  }

  /** 写权益哨兵；值未变化则不写（避免跨窗口互相触发刷新风暴）。 */
  private async pushEntitlementGen(): Promise<void> {
    const ent = this.cachedEntitlement;
    if (!ent) return;
    const next = `${ent.planCode}|${(ent.allowedDatabaseTypes ?? []).join(',')}`;
    try {
      if ((await this.secrets.get(AuthService.ENTITLEMENT_GEN_KEY)) === next) return;
      await this.secrets.store(AuthService.ENTITLEMENT_GEN_KEY, next);
    } catch { /* 哨兵写失败只影响多窗口即时性，不影响本窗口判定 */ }
  }

  /**
   * 拉取 /api/db/me、写权益缓存并返回规范化结果。所有 me 拉取点应走本方法，
   * 由它统一落盘权益（旧实现各调用方只 getMe 不写缓存导致权益恒空）。
   *
   * 身份一致性：请求前捕获 authGeneration，响应返回时若身份已变（登出/换号）
   * 则丢弃结果并抛错，避免账户 A 的权益被写成账户 B 的缓存。
   */
  async getMe(): Promise<MeResponse> {
    const generation = this.authGeneration;
    const me = await this.client.getMe();
    if (generation !== this.authGeneration) {
      throw new Error('session changed during /api/db/me');
    }
    const sub = me.subscription;
    this.setCachedEntitlement({
      planCode: sub?.planCode ?? 'free',
      allowedDatabaseTypes: sub?.entitlement?.allowedDatabaseTypes ?? Array.from(DEFAULT_FREE_ENGINES),
      // 缺省一律按 **Free 套餐**（未登录/权益缺失）：Pro 能力 fail-closed，
      // Free 能力按允许；不要沿用「0 = 不限」的旧默认，否则会反向放开。
      maxDevices: sub?.entitlement?.maxDevices ?? DEFAULT_FREE_MAX_DEVICES,
      maxSavedConnections: sub?.entitlement?.maxSavedConnections ?? DEFAULT_FREE_MAX_CONNECTIONS,
      allowConnectionImport: sub?.entitlement?.allowConnectionImport !== false,
      maxConcurrentConnections: sub?.entitlement?.maxConcurrentConnections ?? DEFAULT_FREE_MAX_CONCURRENT_CONNECTIONS,
      allowConnectionExport: sub?.entitlement?.allowConnectionExport === true,
      allowErDiagram: sub?.entitlement?.allowErDiagram === true,
      allowDataSync: sub?.entitlement?.allowDataSync === true,
      maxAuthenticatorEntries: sub?.entitlement?.maxAuthenticatorEntries ?? DEFAULT_FREE_MAX_AUTH_ENTRIES,
      // P9：AI 月额度（0 = 拒绝，无"不限"档）；缺省 fail-closed 0。
      maxAiTokensMonthly: sub?.entitlement?.maxAiTokensMonthly ?? 0,
    });
    this.cachedUserId = me.user.userId;
    try {
      await this.storeUserId(me.user.userId);
    } catch { /* 缓存失败不影响本次请求；下次 me 会再写 */ }
    return me;
  }

  /**
   * 拉取 /api/db/me 并刷新权益缓存。登录态建立后（init）、账户/设备面板打开时调用。
   *
   * 未登录直接返回；失败（网络/鉴权/换号）静默降级：不阻塞登录，权益缓存保持原值
   * （无缓存即 fail-closed 到 Free）。
   */
  async refreshEntitlement(): Promise<void> {
    if (!this.isLoggedIn()) return;
    try {
      await this.getMe();
    } catch { /* 网络/鉴权/换号失败：降级到 Free，保持现状 */ }
  }

  /** SecretStorage 变更订阅（多窗口同步），dispose 时取消 */
  private readonly secretsSub?: vscode.Disposable;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    readonly serverUrl: string,
    private readonly memento?: vscode.Memento,
  ) {
    this.client = new SyncClient(
      serverUrl,
      () => this.accessToken,
      // 刻意从 SecretStorage 实时读，而不是返回内存字段：见下方 onDidChange 注释。
      // 这是防止跨窗口重用检测误判的第一道（也是最关键的一道）保障 ——
      // 即使 onDidChange 因某些宿主实现没有触发，这里也一定拿到最新值。
      () => this.readRefreshToken(),
      async (access, refresh) => {
        this.accessToken = access;
        this.refreshToken = refresh;
        this.authExpiredHandled = false;
        await this.persistTokens(access, refresh);
      },
      buildDeviceInfo(),
      undefined,
      (failedRefreshToken) => this.handleAuthExpired(failedRefreshToken),
    );

    // 每个 VS Code 窗口是独立扩展宿主进程，各有一份 AuthService，共享同一个
    // SecretStorage。没有这个订阅时，A 窗口轮换后 B 窗口内存里仍是旧 refresh
    // token；B 下次刷新拿旧 token 打过去 → 服务端判定泄露 → revokeAllForUser
    // → 用户所有设备被登出。
    this.secretsSub = this.secrets.onDidChange?.((e) => {
      if (e.key === AuthService.ACCESS_TOKEN_KEY) {
        void this.secrets.get(AuthService.ACCESS_TOKEN_KEY).then((v) => { this.accessToken = v; });
      } else if (e.key === AuthService.REFRESH_TOKEN_KEY) {
        void this.secrets.get(AuthService.REFRESH_TOKEN_KEY).then((v) => {
          this.refreshToken = v;
          // 另一窗口重新登录/轮换后，本窗口应允许再次在 401 时执行清理
          if (v) this.authExpiredHandled = false;
        });
      }
      // 跨窗口 token 变更可能代表换号（另一窗口 A→B）：使飞行中的 /api/db/me 失效并清除
      // 派生身份缓存，避免账户 A 的权益/ userId 落进已持账户 B token 的本实例。
      if (e.key === AuthService.ACCESS_TOKEN_KEY || e.key === AuthService.REFRESH_TOKEN_KEY) {
        this.invalidateCachedIdentity();
      }
      // userId 变了而本窗口并没有写它 = 另一窗口换号 / 登出。
      if (e.key === AuthService.USER_ID_KEY) {
        void this.secrets.get(AuthService.USER_ID_KEY).then((current) => {
          const from = this.knownUserId;
          if (current === from) return; // 本窗口自己的写入回声，或没有实质变化
          this.knownUserId = current;
          this.cachedUserId = current;
          this.emitExternalIdentityChange({ from, to: current });
        });
      }
      // 另一窗口刷新到的套餐已变化（升级/降级）：本窗口丢弃过期内存缓存并重拉，
      // 否则医生面板/引擎门限会继续按旧套餐判断。
      if (e.key === AuthService.ENTITLEMENT_GEN_KEY) {
        // 连持久化缓存一起清掉：否则 getCachedEntitlement() 会回退到 memento 里的旧套餐，
        // 刷新失败（离线）时本窗口仍按已知过期的权益放行。
        this.invalidateEntitlementCache();
        if (this.accessToken) void this.refreshEntitlement();
      }
    });
  }

  /** 只清权益缓存（内存 + memento），保留 userId/token；下次读取 fail-closed 到 Free。 */
  private invalidateEntitlementCache(): void {
    this.cachedEntitlement = undefined;
    try {
      this.memento?.update(AuthService.ENTITLEMENT_CACHE_KEY, undefined);
    } catch { /* 忽略 */ }
  }

  /** 使认证身份缓存失效：任何飞行中 /api/db/me 结果作废，已缓存的 userId/权益清空。 */
  private invalidateCachedIdentity(): void {
    this.authGeneration += 1;
    this.cachedUserId = undefined;
    this.cachedEntitlement = undefined;
    try {
      this.memento?.update(AuthService.ENTITLEMENT_CACHE_KEY, undefined);
    } catch { /* 忽略 */ }
  }

  /** 初始化：从安全存储恢复 token */
  async init(): Promise<void> {
    this.accessToken = await this.secrets.get(AuthService.ACCESS_TOKEN_KEY);
    this.refreshToken = await this.secrets.get(AuthService.REFRESH_TOKEN_KEY);
    this.knownUserId = await this.secrets.get(AuthService.USER_ID_KEY);
    // 只有 access、没有 refresh：无法续期，不能算登录态。旧版本/半写残留会在
    // 15 分钟后变成「界面已登录、所有请求 401」的僵尸态。只清内存、不删存储：
    // 另一窗口可能正处在「先存 access、再存 refresh」之间，删掉会破坏它的登录。
    if (!this.refreshToken) {
      this.accessToken = undefined;
      return;
    }
    this.authExpiredHandled = false;
    if (this.accessToken) void this.refreshEntitlement();
  }

  /** 取消 SecretStorage 订阅（扩展 deactivate 时调用） */
  dispose(): void {
    this.secretsSub?.dispose();
  }

  /**
   * 读取当前 refresh token，优先取 SecretStorage 的最新值。
   *
   * refresh token 是一次性的：服务端收到就撤销旧的、签发新的。所以"用哪个 token
   * 去刷新"必须是全局最新的那个，不能是本进程内存里的快照。
   */
  private async readRefreshToken(): Promise<string | undefined> {
    const stored = await this.secrets.get(AuthService.REFRESH_TOKEN_KEY);
    // 必须把 undefined 也写回内存：另一窗口登出会删除该 key，若这里回退到内存值，
    // 休眠/Remote-SSH 等错过 onDidChange 的窗口会一直用已删除的 token 刷新，
    // 服务端判定复用后整个 family 被吊销 —— 这就是「隔几天必须重新登录」的根因。
    this.refreshToken = stored;
    return stored;
  }

  /** 是否已登录（access + refresh 同时存在；只有 access 无法续期，不算登录态） */
  isLoggedIn(): boolean {
    return !!this.accessToken && !!this.refreshToken;
  }

  /** 读取当前 access token（供管理员面板外部打开时注入） */
  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  /**
   * refresh 被服务端拒绝（401/403）或本地已无 refresh token：会话不可恢复。
   *
   * 清掉本地凭据并广播 logout，让状态栏/同步会话立即失效。网络错误不会走到这里，
   * 因此不会把临时断网误判成登录过期。幂等：并发 401 只处理一次。
   */
  private async handleAuthExpired(failedRefreshToken?: string): Promise<void> {
    if (this.authExpiredHandled) return;
    // 另一窗口可能已经轮换或重新登录：存储里已不是失败的那个 token 时，
    // 只同步内存，不删除刚签发的新会话。
    // failedRefreshToken 缺省代表「本窗口读到无 token」：此时存储里若有值，必然是
    // 另一窗口刚写入的新会话，也不能删（旧条件会在这个窗口误删它）。
    const [storedAccess, stored] = await Promise.all([
      this.secrets.get(AuthService.ACCESS_TOKEN_KEY),
      this.secrets.get(AuthService.REFRESH_TOKEN_KEY),
    ]);
    if (stored && stored !== failedRefreshToken) {
      this.refreshToken = stored;
      if (storedAccess) this.accessToken = storedAccess;
      // token 变化可能代表换号（本窗口可能错过了 onDidChange）：丢弃派生身份缓存，
      // 避免把上一个账户的 userId/权益用于新 token。
      this.invalidateCachedIdentity();
      return;
    }
    this.authExpiredHandled = true;
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.invalidateCachedIdentity();
    try {
      await this.secrets.delete(AuthService.ACCESS_TOKEN_KEY);
      await this.secrets.delete(AuthService.REFRESH_TOKEN_KEY);
      await this.secrets.delete(AuthService.USER_EMAIL_KEY);
      await this.deleteUserId();
    } catch { /* SecretStorage 删除失败不应阻断登出 */ }
    void eventBus.publish(new AuthEvent('logout'));
  }

  /**
   * 用 refresh token 换新 access（P9 修复：AI 请求 401 时自动续期一次）。
   * 走 `SyncClient.refreshOnce` 的单飞路径：AI/同步/显式刷新并发时只轮换一次。
   * 失败返回 undefined，调用方按"需重新登录"处理。
   */
  async refreshAccessToken(): Promise<string | undefined> {
    const ok = await this.client.refreshOnce(this.accessToken);
    return ok ? this.accessToken : undefined;
  }

  /** 注册并登录 */
  async register(email: string, password: string): Promise<{ ok: boolean }> {
    return this.client.register(email, password);
  }

  /** 消费初始邮箱验证 token（注册后经邮件链接/输入 token 验证）。 */
  async confirmEmail(token: string): Promise<{ ok: boolean }> {
    return this.client.confirmEmail(token);
  }

  /** 匿名重发验证邮件。 */
  async resendVerification(email: string): Promise<{ ok: boolean }> {
    return this.client.resendVerification(email);
  }

  /** 登录 */
  async login(email: string, password: string): Promise<AuthResult> {
    const result = await this.client.login(email, password);
    await this.saveSession(result, email);
    return result;
  }

  /** 登出：撤销当前 refresh token + 清本地 */
  async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // 忽略网络错误，仍清本地
    }
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.authExpiredHandled = false;
    this.invalidateCachedIdentity();
    await this.secrets.delete(AuthService.ACCESS_TOKEN_KEY);
    await this.secrets.delete(AuthService.REFRESH_TOKEN_KEY);
    await this.secrets.delete(AuthService.USER_EMAIL_KEY);
    await this.deleteUserId();
    void eventBus.publish(new AuthEvent('logout'));
  }

  /** 修改账号密码（需当前已登录） */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.client.changePassword(oldPassword, newPassword);
  }

  /** 手动刷新 token（测试用；生产路径由 401 自动刷新处理） */
  async refreshTokens(): Promise<void> {
    await this.client.refreshOnce(this.accessToken);
  }

  /** 获取当前登录邮箱（用于展示） */
  async getEmail(): Promise<string | undefined> {
    return this.secrets.get(AuthService.USER_EMAIL_KEY);
  }

  /**
   * 落盘一次轮换/登录结果：**refresh 先写**。
   *
   * refresh token 是一次性凭据：服务端已消费旧 token 后才返回新 token。若先写
   * access 而后写 refresh 失败，存储里仍是被消费的旧 refresh，下一次刷新会命中
   * 复用检测（60s 宽限后吊销整族）；refresh-first 让半写态变成「新 refresh + 旧
   * access」，下一次刷新仍可自愈。
   *
   * refresh 写失败时删除旧值：宁可让后续刷新走「无 token → 清本地登录态」，
   * 也不要拿已被消费的旧 token 去触发服务端的安全事件。
   */
  private async persistTokens(access: string, refresh: string): Promise<void> {
    try {
      await this.secrets.store(AuthService.REFRESH_TOKEN_KEY, refresh);
    } catch (err) {
      try { await this.secrets.delete(AuthService.REFRESH_TOKEN_KEY); } catch { /* 尽力而为 */ }
      throw err;
    }
    // access 是短期凭据：写失败不阻断本次会话，下一次 401 会用新 refresh 重建。
    try { await this.secrets.store(AuthService.ACCESS_TOKEN_KEY, access); } catch { /* access 可重建 */ }
  }

  private async saveSession(result: AuthResult, email: string): Promise<void> {
    this.authGeneration += 1;
    this.authExpiredHandled = false;
    // userId 先于 token 落盘：另一窗口在轮换/换号时先看到新 userId，再看到新 token，
    // 避免「新 token + 旧 userId」把同步会话建到上一个账户。
    if (result.user?.userId) {
      this.cachedUserId = result.user.userId;
      try {
        await this.storeUserId(result.user.userId);
      } catch { /* 下次 getMe 会补写 */ }
    }
    this.accessToken = result.accessToken;
    this.refreshToken = result.refreshToken;
    try {
      await this.persistTokens(result.accessToken, result.refreshToken);
    } catch (err) {
      // 登录 token 未落盘：不留下「内存已登录、重启即失效」的半态。
      this.accessToken = undefined;
      this.refreshToken = undefined;
      throw err;
    }
    await this.secrets.store(AuthService.USER_EMAIL_KEY, email);
    void this.refreshEntitlement();
    void eventBus.publish(new AuthEvent('login'));
  }
}
