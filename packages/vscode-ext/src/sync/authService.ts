import * as vscode from 'vscode';
import { SyncClient, AuthResult } from './syncClient';

/**
 * 认证服务：管理登录态（token、用户信息）的持久化。
 * token 存 SecretStorage（VSCode 安全存储，操作系统密钥库）。
 */
export class AuthService {
  private static readonly TOKEN_KEY = 'dbclient.auth.token';
  private static readonly USER_EMAIL_KEY = 'dbclient.auth.email';
  private static readonly SERVER_URL_KEY = 'dbclient.sync.serverUrl';

  /** 同步客户端（token 通过 getter 实时读取） */
  readonly client: SyncClient;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    serverUrl: string,
  ) {
    this.client = new SyncClient(serverUrl, () => this.token);
  }

  /** 初始化：从安全存储恢复登录态 */
  async init(): Promise<void> {
    this.token = await this.secrets.get(AuthService.TOKEN_KEY);
  }

  /** 是否已登录 */
  isLoggedIn(): boolean {
    return !!this.token;
  }

  /** 读取服务器地址（供 SyncManager 使用） */
  static getServerUrl(config: vscode.WorkspaceConfiguration): string {
    return config.get<string>(AuthService.SERVER_URL_KEY) || 'http://localhost:3000';
  }

  /** 移除服务器地址设置（供重建客户端） */
  static clearServerUrl(config: vscode.WorkspaceConfiguration): void {
    void config.update(AuthService.SERVER_URL_KEY, undefined, vscode.ConfigurationTarget.Global);
  }

  private token?: string;

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

  /** 登出 */
  async logout(): Promise<void> {
    this.token = undefined;
    await this.secrets.delete(AuthService.TOKEN_KEY);
    await this.secrets.delete(AuthService.USER_EMAIL_KEY);
  }

  /** 获取当前登录邮箱（用于展示） */
  async getEmail(): Promise<string | undefined> {
    return this.secrets.get(AuthService.USER_EMAIL_KEY);
  }

  private async saveSession(result: AuthResult, email: string): Promise<void> {
    this.token = result.token;
    await this.secrets.store(AuthService.TOKEN_KEY, result.token);
    await this.secrets.store(AuthService.USER_EMAIL_KEY, email);
  }
}