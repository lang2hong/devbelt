/**
 * 组织资源 API 客户端（实施规格 §6.4）。
 *
 * 复用 SyncClient 的传输层（requestRaw：401 单飞刷新 + 5xx 退避重试），
 * 这里只做组织资源路径封装与错误码到类型化错误的映射。
 * 不触碰个人 sync 语义。
 */
import type {
  FolderDto,
  OrganizationSummaryDto,
  ResourceContent,
  ResourceDetailDto,
  ResourceSummaryDto,
  ResourceType,
} from './types';

/** 传输抽象：生产环境由 AuthService.client（SyncClient）提供；测试用替身。 */
export interface RawTransport {
  requestRaw(method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/** 组织 API 错误：保留 status + code + message + 可选 currentVersion。 */
export class OrgApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly message: string,
    readonly currentVersion?: number,
  ) {
    super(message);
    this.name = 'OrgApiError';
  }

  isAuthFailure(): boolean {
    return this.status === 401;
  }

  isForbidden(): boolean {
    return this.status === 403;
  }

  isNotFound(): boolean {
    return this.status === 404;
  }

  isVersionConflict(): boolean {
    return this.status === 409 && this.code === 'RESOURCE_VERSION_CONFLICT';
  }
}

interface ListOrganizationsResponse { organizations: OrganizationSummaryDto[]; }
interface FoldersResponse { folders: FolderDto[]; }
interface ResourcesResponse { resources: ResourceSummaryDto[]; }
interface FolderResponse { folder: FolderDto; }
interface ResourceResponse { resource: ResourceDetailDto | ResourceSummaryDto; }
interface MeResponse { user: { userId: string; email: string; displayName?: string | null; status: string } }

export interface CreateFolderInput { name: string; parentId?: string | null; }
export interface UpdateFolderInput { name?: string; parentId?: string | null; }
export interface CreateResourceInput { resourceType: ResourceType; name: string; folderId?: string | null; content: ResourceContent; }
export interface UpdateResourceInput { baseVersion: number; name?: string; folderId?: string | null; content?: ResourceContent; }

export class OrgClient {
  constructor(private readonly transport: RawTransport) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, body: payload } = await this.transport.requestRaw(method, path, body);
    if (status >= 200 && status < 300) return (payload ?? {}) as T;
    throw this.toError(status, payload);
  }

  private toError(status: number, payload: unknown): OrgApiError {
    const b = (payload ?? {}) as { code?: string; message?: string; currentVersion?: number };
    return new OrgApiError(status, b.code ?? String(status), b.message ?? 'request failed', b.currentVersion);
  }

  /** 当前登录用户 id（用于缓存分区键）。 */
  async getUserId(): Promise<string> {
    const me = await this.req<MeResponse>('GET', '/api/me');
    return me.user.userId;
  }

  /** 列当前用户可见的 active 组织（含角色）。 */
  async listOrganizations(): Promise<OrganizationSummaryDto[]> {
    return (await this.req<ListOrganizationsResponse>('GET', '/api/organizations')).organizations;
  }

  // ── 目录 ──
  async listFolders(organizationId: string): Promise<FolderDto[]> {
    return (await this.req<FoldersResponse>('GET', `/api/organizations/${encodeURIComponent(organizationId)}/folders`)).folders;
  }

  async createFolder(organizationId: string, name: string, parentId?: string | null): Promise<FolderDto> {
    return (await this.req<FolderResponse>('POST', `/api/organizations/${encodeURIComponent(organizationId)}/folders`, { name, parentId })).folder;
  }

  async updateFolder(organizationId: string, folderId: string, input: UpdateFolderInput): Promise<FolderDto> {
    return (await this.req<FolderResponse>('PATCH', `/api/organizations/${encodeURIComponent(organizationId)}/folders/${encodeURIComponent(folderId)}`, input)).folder;
  }

  async deleteFolder(organizationId: string, folderId: string): Promise<void> {
    await this.req('DELETE', `/api/organizations/${encodeURIComponent(organizationId)}/folders/${encodeURIComponent(folderId)}`);
  }

  // ── 资源 ──
  async listResources(organizationId: string): Promise<ResourceSummaryDto[]> {
    return (await this.req<ResourcesResponse>('GET', `/api/organizations/${encodeURIComponent(organizationId)}/resources`)).resources;
  }

  async getResource(organizationId: string, resourceId: string): Promise<ResourceDetailDto> {
    return (await this.req<ResourceResponse>('GET', `/api/organizations/${encodeURIComponent(organizationId)}/resources/${encodeURIComponent(resourceId)}`)).resource as ResourceDetailDto;
  }

  async createResource(organizationId: string, input: CreateResourceInput): Promise<ResourceSummaryDto> {
    return (await this.req<ResourceResponse>('POST', `/api/organizations/${encodeURIComponent(organizationId)}/resources`, input)).resource as ResourceSummaryDto;
  }

  async updateResource(organizationId: string, resourceId: string, input: UpdateResourceInput): Promise<ResourceSummaryDto> {
    return (await this.req<ResourceResponse>('PATCH', `/api/organizations/${encodeURIComponent(organizationId)}/resources/${encodeURIComponent(resourceId)}`, input)).resource as ResourceSummaryDto;
  }

  async deleteResource(organizationId: string, resourceId: string): Promise<void> {
    await this.req('DELETE', `/api/organizations/${encodeURIComponent(organizationId)}/resources/${encodeURIComponent(resourceId)}`);
  }
}
