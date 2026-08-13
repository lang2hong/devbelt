import * as vscode from 'vscode';
import { SyncClient, AuthResult } from './syncClient';

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
  private cachedPlan?: { code: string; name: string; features: number; maxDevices: number; maxConnections: number; syncQuotaBytes: number; maxPats: number };

  /** 读取缓存套餐 */
  getCachedPlan() {
    return this.cachedPlan;
  }

  /** 设置缓存套餐（SyncStatusBar getMe 后调用） */
  setCachedPlan(plan: { code: string; name: string; features: number; maxDevices: number; maxConnections: number; syncQuotaBytes: number; maxPats: number }): void {
    this.cachedPlan = plan;
  }

  constructor(
    private readonly secrets: vscode.SecretStorage,
    serverUrl: string,
  ) {
    this.client = new SyncClient(
      serverUrl,
      () => this.accessToken,
      () => this.refreshToken,
      (access, refresh) => {
        this.accessToken = access;
        this.refreshToken = refresh;
        void this.secrets.store(AuthService.ACCESS_TOKEN_KEY, access);
        void this.secrets.store(AuthService.REFRESH_TOKEN_KEY, refresh);
      },
    );
  }

  /** 初始化：从安全存储恢复 token */
  async init(): Promise<void> {
    this.accessToken = await this.secrets.get(AuthService.ACCESS_TOKEN_KEY);
    this.refreshToken = await this.secrets.get(AuthService.REFRESH_TOKEN_KEY);
  }

  /** 是否已登录（有 access token） */
  isLoggedIn(): boolean {
    return !!this.accessToken;
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
