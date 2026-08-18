import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { hostname, platform, arch, release, networkInterfaces, cpus } from 'os';
import { SyncClient, AuthResult, DeviceInfo } from './syncClient';

let _fingerprint: string | undefined;

/** 硬件指纹（确定性，不依赖本地存储；同硬件同值，卸载重装不变） */
function machineFingerprint(): string {
  if (_fingerprint) return _fingerprint;
  const cpu = cpus()[0]?.model ?? '';
  const raw = `${hostname()}|${cpu}|${firstMac()}|${platform()}/${arch()}`;
  _fingerprint = createHash('sha256').update(raw).digest('hex');
  return _fingerprint;
}

function firstMac(): string {
  const ifs = networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] ?? []) {
      if (ni && ni.mac && ni.mac !== '00:00:00:00:00:00' && !ni.internal) return ni.mac;
    }
  }
  return '';
}

function timezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** 组装设备信息：deviceId 为硬件指纹（判同键），machineId 为 VSCode 原始值（仅追溯） */
function buildDeviceInfo(): DeviceInfo {
  const name = `${hostname()} · ${platform()}/${arch()} · VSCode ${vscode.version}`;
  return {
    deviceName: name.length > 120 ? name.slice(0, 120) : name,
    deviceId: machineFingerprint(),
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
  private static readonly ACCESS_TOKEN_KEY = 'dbclient.auth.accessToken';
  private static readonly REFRESH_TOKEN_KEY = 'dbclient.auth.refreshToken';
  private static readonly USER_EMAIL_KEY = 'dbclient.auth.email';
  private static readonly SERVER_URL_KEY = 'dbclient.sync.serverUrl';

  /** 同步客户端（token 通过 getter 实时读取） */
  readonly client: SyncClient;

  private accessToken?: string;
  private refreshToken?: string;
  /** 缓存的套餐（SyncStatusBar 刷新时填，requireFeature 用） */
  private cachedPlan?: { code: string; name: string; features: number; maxDevices: number; maxConnections: number; syncQuotaBytes: number };

  /** 读取缓存套餐 */
  getCachedPlan() {
    return this.cachedPlan;
  }

  /** 设置缓存套餐（SyncStatusBar getMe 后调用） */
  setCachedPlan(plan: { code: string; name: string; features: number; maxDevices: number; maxConnections: number; syncQuotaBytes: number }): void {
    this.cachedPlan = plan;
  }

  /** SecretStorage 变更订阅（多窗口同步），dispose 时取消 */
  private readonly secretsSub?: vscode.Disposable;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    serverUrl: string,
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
    });
  }

  /** 初始化：从安全存储恢复 token */
  async init(): Promise<void> {
    this.accessToken = await this.secrets.get(AuthService.ACCESS_TOKEN_KEY);
    this.refreshToken = await this.secrets.get(AuthService.REFRESH_TOKEN_KEY);
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

  /** 读取服务器地址 */
  static getServerUrl(config: vscode.WorkspaceConfiguration): string {
    return config.get<string>(AuthService.SERVER_URL_KEY) || 'http://localhost:3000';
  }

  /** 移除服务器地址设置（供重建客户端） */
  static clearServerUrl(config: vscode.WorkspaceConfiguration): void {
    void config.update(AuthService.SERVER_URL_KEY, undefined, vscode.ConfigurationTarget.Global);
  }

  /** 注册并登录 */
  async register(email: string, password: string): Promise<AuthResult> {
    const result = await this.client.register(email, password);
    await this.saveSession(result, email);
    return result;
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
    await this.secrets.delete(AuthService.ACCESS_TOKEN_KEY);
    await this.secrets.delete(AuthService.REFRESH_TOKEN_KEY);
    await this.secrets.delete(AuthService.USER_EMAIL_KEY);
  }

  /** 修改账号密码（需当前已登录） */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.client.changePassword(oldPassword, newPassword);
  }

  /** 刷新 token：用 refresh 换新 access + 轮换 refresh */
  async refreshTokens(): Promise<void> {
    await this.client.refresh();
  }

  /** 获取当前登录邮箱（用于展示） */
  async getEmail(): Promise<string | undefined> {
    return this.secrets.get(AuthService.USER_EMAIL_KEY);
  }

  private async saveSession(result: AuthResult, email: string): Promise<void> {
    this.accessToken = result.accessToken;
    this.refreshToken = result.refreshToken;
    await this.secrets.store(AuthService.ACCESS_TOKEN_KEY, result.accessToken);
    await this.secrets.store(AuthService.REFRESH_TOKEN_KEY, result.refreshToken);
    await this.secrets.store(AuthService.USER_EMAIL_KEY, email);
  }
}
