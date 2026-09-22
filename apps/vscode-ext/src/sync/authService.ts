import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { hostname, platform, arch, release } from 'os';
import { SyncClient, AuthResult, DeviceInfo, MeResponse } from '@devbelt/db-host/sync/syncClient';
import { eventBus, AuthEvent } from '@devbelt/db-host/utils/event';
import { DEFAULT_FREE_ENGINES, DEFAULT_FREE_MAX_CONNECTIONS, DEFAULT_FREE_MAX_AUTH_ENTRIES } from '@devbelt/db-host/sync/entitlementGate';

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
  private static readonly ENTITLEMENT_CACHE_KEY = 'devbelt.sync.cachedEntitlement';

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

  /** 读取当前用户规范 userId；缓存到内存，登出清空。 */
  async getUserId(): Promise<string> {
    if (this.cachedUserId) return this.cachedUserId;
    const me = await this.getMe();
    return me.user.userId;
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
    this.cachedEntitlement = entitlement;
    try {
      this.memento?.update(AuthService.ENTITLEMENT_CACHE_KEY, entitlement);
    } catch { /* memento 写失败不影响本次判断 */ }
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
      maxDevices: sub?.entitlement?.maxDevices ?? 0,
      maxSavedConnections: sub?.entitlement?.maxSavedConnections ?? DEFAULT_FREE_MAX_CONNECTIONS,
      allowConnectionImport: sub?.entitlement?.allowConnectionImport === true,
      maxConcurrentConnections: sub?.entitlement?.maxConcurrentConnections ?? 0,
      allowConnectionExport: sub?.entitlement?.allowConnectionExport !== false,
      allowErDiagram: sub?.entitlement?.allowErDiagram !== false,
      allowDataSync: sub?.entitlement?.allowDataSync !== false,
      maxAuthenticatorEntries: sub?.entitlement?.maxAuthenticatorEntries ?? DEFAULT_FREE_MAX_AUTH_ENTRIES,
    });
    this.cachedUserId = me.user.userId;
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
        // 必须 await：轮换结果要在下一次刷新读取之前落盘，否则另一个窗口
        // 仍可能读到旧值。原实现用 void，存在写入未完成的窗口。
        await this.secrets.store(AuthService.ACCESS_TOKEN_KEY, access);
        await this.secrets.store(AuthService.REFRESH_TOKEN_KEY, refresh);
      },
      buildDeviceInfo(),
    );

    // 每个 VS Code 窗口是独立扩展宿主进程，各有一份 AuthService，共享同一个
    // SecretStorage。没有这个订阅时，A 窗口轮换后 B 窗口内存里仍是旧 refresh
    // token；B 下次刷新拿旧 token 打过去 → 服务端判定泄露 → revokeAllForUser
    // → 用户所有设备被登出。
    this.secretsSub = this.secrets.onDidChange?.((e) => {
      if (e.key === AuthService.ACCESS_TOKEN_KEY) {
        void this.secrets.get(AuthService.ACCESS_TOKEN_KEY).then((v) => { this.accessToken = v; });
      } else if (e.key === AuthService.REFRESH_TOKEN_KEY) {
        void this.secrets.get(AuthService.REFRESH_TOKEN_KEY).then((v) => { this.refreshToken = v; });
      }
      // 跨窗口 token 变更可能代表换号（另一窗口 A→B）：使飞行中的 /api/db/me 失效并清除
      // 派生身份缓存，避免账户 A 的权益/ userId 落进已持账户 B token 的本实例。
      if (e.key === AuthService.ACCESS_TOKEN_KEY || e.key === AuthService.REFRESH_TOKEN_KEY) {
        this.invalidateCachedIdentity();
      }
    });
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
    if (stored !== undefined) this.refreshToken = stored;
    return stored ?? this.refreshToken;
  }

  /** 是否已登录（有 access token） */
  isLoggedIn(): boolean {
    return !!this.accessToken;
  }

  /** 读取当前 access token（供管理员面板外部打开时注入） */
  getAccessToken(): string | undefined {
    return this.accessToken;
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
    this.invalidateCachedIdentity();
    await this.secrets.delete(AuthService.ACCESS_TOKEN_KEY);
    await this.secrets.delete(AuthService.REFRESH_TOKEN_KEY);
    await this.secrets.delete(AuthService.USER_EMAIL_KEY);
    void eventBus.publish(new AuthEvent('logout'));
  }

  /** 修改账号密码（需当前已登录） */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.client.changePassword(oldPassword, newPassword);
  }

  /** 手动刷新 token（测试用；生产路径由 401 自动刷新处理） */
  async refreshTokens(): Promise<void> {
    await this.client.refresh();
  }

  /** 获取当前登录邮箱（用于展示） */
  async getEmail(): Promise<string | undefined> {
    return this.secrets.get(AuthService.USER_EMAIL_KEY);
  }

  private async saveSession(result: AuthResult, email: string): Promise<void> {
    this.authGeneration += 1;
    this.accessToken = result.accessToken;
    this.refreshToken = result.refreshToken;
    await this.secrets.store(AuthService.ACCESS_TOKEN_KEY, result.accessToken);
    await this.secrets.store(AuthService.REFRESH_TOKEN_KEY, result.refreshToken);
    await this.secrets.store(AuthService.USER_EMAIL_KEY, email);
    void eventBus.publish(new AuthEvent('login'));
  }
}
