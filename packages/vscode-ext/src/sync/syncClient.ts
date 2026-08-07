/**
 * 同步客户端：封装与后端同步服务的 HTTP 通信。
 * 使用 Node 18+ 全局 fetch，无需额外依赖。
 */
export class SyncClient {
  constructor(
    private readonly baseUrl: string,
    private getToken: () => string | undefined,
  ) {}

  /** 注册新账号，返回 token 与用户信息 */
  async register(email: string, password: string): Promise<AuthResult> {
    return this.postForm('/api/auth/register', { email, password });
  }

  /** 登录，返回 token 与用户信息 */
  async login(email: string, password: string): Promise<AuthResult> {
    return this.postForm('/api/auth/login', { email, password });
  }

  /** 拉取当前用户同步数据 */
  async fetch(): Promise<SyncData> {
    const res = await fetch(`${this.baseUrl}/api/sync`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return res.json() as Promise<SyncData>;
  }

  /** 推送当前用户同步数据（带乐观锁 version） */
  async push(data: string, baseVersion: number): Promise<{ version: number }> {
    const res = await fetch(`${this.baseUrl}/api/sync`, {
      method: 'PUT',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, baseVersion }),
    });
    if (res.status === 409) {
      throw new SyncConflictError(await res.text());
    }
    if (!res.ok) throw new Error(`Push failed: ${res.status}`);
    return res.json() as Promise<{ version: number }>;
  }

  private async postForm(path: string, body: object): Promise<AuthResult> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(errBody.message || `Request failed: ${res.status}`);
    }
    return res.json() as Promise<AuthResult>;
  }

  private authHeaders(): Record<string, string> {
    const token = this.getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}

/** 认证/登录结果 */
export interface AuthResult {
  token: string;
  userId: number;
  role: string;
}

/** 同步数据响应 */
export interface SyncData {
  data: string | null;
  version: number;
}

/** 冲突错误：远端版本已变化，需手动合并或重新拉取 */
export class SyncConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncConflictError';
  }
}