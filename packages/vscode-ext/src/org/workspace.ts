/**
 * 组织 Workspace 协调层（实施规格 §6）。
 *
 * 职责：
 *  - 维护当前 Workspace（personal / organization）
 *  - 把 OrgClient 的读取经 OrgCache 缓存（分区键 userId:organizationId）
 *  - 按错误驱动缓存失效：
 *      401 清认证（整用户清空 + 回退 personal）
 *      403/404 清无权/失效资源（org 级或 resource 级）
 *      409 不驱逐（保留本地编辑，currentVersion 由调用方消化）
 *  - 成员角色/状态变更、退出、移除、关闭 → invalidateOrganization（立即重拉）
 */
import { OrgCache } from './cache';
import { OrgApiError, OrgClient, UpdateFolderInput, CreateResourceInput, UpdateResourceInput } from './client';
import { CredentialVault } from './credentialVault';
import type { FolderDto, OrganizationSummaryDto, ResourceDetailDto, ResourceSummaryDto } from './types';
import { EventEmitter, type Event } from '../utils/event';

/** 客户端本地 UI 概念（非服务端 DTO）：role 由 /api/organizations 的 role 派生，仅供展示，不做授权。 */
export type WorkspaceRef =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string; role: 'admin' | 'member' };

export class OrgWorkspace {
  private readonly cache = new OrgCache();
  private readonly changed = new EventEmitter<void>();

  /** 缓存/失效时触发（树刷新、状态栏更新）。 */
  readonly onDidChange: Event<void> = this.changed.event;

  private current: WorkspaceRef = { kind: 'personal' };
  private userId?: string;

  constructor(
    private readonly client: OrgClient,
    readonly vault: CredentialVault,
  ) {}

  get workspace(): WorkspaceRef {
    return this.current;
  }

  /** 只读暴露缓存（测试/诊断）。 */
  get visibleCache(): OrgCache {
    return this.cache;
  }

  /** 获取并缓存当前用户 id（分区键前半段）。 */
  async ensureUserId(): Promise<string> {
    if (!this.userId) this.userId = await this.client.getUserId();
    return this.userId;
  }

  /** 切换 Workspace。 */
  select(ws: WorkspaceRef): void {
    this.current = ws;
    this.changed.fire();
  }

  /** 401/登出：清认证，回退 personal。 */
  clearAuth(): void {
    this.userId = undefined;
    this.cache.clearAll();
    this.current = { kind: 'personal' };
    this.changed.fire();
  }

  /** 成员状态/角色变更、退出、移除、关闭 → 立即失效该组织缓存并触发重拉。 */
  invalidateOrganization(organizationId: string): void {
    if (this.userId) this.cache.invalidateOrg(this.userId, organizationId);
    this.changed.fire();
  }

  // ── 带缓存的读取 ──

  /** 列组织（不走持久缓存：角色/状态须实时反映，成员状态变更后立即重拉）。 */
  async listOrganizations(): Promise<OrganizationSummaryDto[]> {
    return this.client.listOrganizations();
  }

  async listFolders(organizationId: string, force = false): Promise<FolderDto[]> {
    const uid = await this.ensureUserId();
    if (!force) {
      const hit = this.cache.getFolders(uid, organizationId);
      if (hit) return hit;
    }
    try {
      const folders = await this.client.listFolders(organizationId);
      this.cache.setFolders(uid, organizationId, folders);
      return folders;
    } catch (e) {
      this.applyError(e, organizationId);
      throw e;
    }
  }

  async listResources(organizationId: string, force = false): Promise<ResourceSummaryDto[]> {
    const uid = await this.ensureUserId();
    if (!force) {
      const hit = this.cache.getResources(uid, organizationId);
      if (hit) return hit;
    }
    try {
      const resources = await this.client.listResources(organizationId);
      this.cache.setResources(uid, organizationId, resources);
      return resources;
    } catch (e) {
      this.applyError(e, organizationId);
      throw e;
    }
  }

  async getResource(organizationId: string, resourceId: string, force = false): Promise<ResourceDetailDto> {
    const uid = await this.ensureUserId();
    if (!force) {
      const hit = this.cache.getDetail(uid, organizationId, resourceId);
      if (hit) return hit;
    }
    try {
      const detail = await this.client.getResource(organizationId, resourceId);
      this.cache.setDetail(uid, organizationId, detail);
      return detail;
    } catch (e) {
      this.applyError(e, organizationId, resourceId);
      throw e;
    }
  }

  // ── 写操作：成功后失效重拉，失败按策略失效 ──

  async createFolder(organizationId: string, name: string, parentId?: string | null): Promise<FolderDto> {
    try {
      const folder = await this.client.createFolder(organizationId, name, parentId);
      this.invalidateOrganization(organizationId);
      return folder;
    } catch (e) {
      this.applyError(e, organizationId);
      throw e;
    }
  }

  async updateFolder(organizationId: string, folderId: string, input: UpdateFolderInput): Promise<FolderDto> {
    try {
      const folder = await this.client.updateFolder(organizationId, folderId, input);
      this.invalidateOrganization(organizationId);
      return folder;
    } catch (e) {
      this.applyError(e, organizationId);
      throw e;
    }
  }

  async deleteFolder(organizationId: string, folderId: string): Promise<void> {
    try {
      await this.client.deleteFolder(organizationId, folderId);
      this.invalidateOrganization(organizationId);
    } catch (e) {
      this.applyError(e, organizationId);
      throw e;
    }
  }

  async createResource(organizationId: string, input: CreateResourceInput): Promise<ResourceSummaryDto> {
    // 秘密字段绝不出现在请求体：结构上 input 只含服务端 schema 字段（无凭据）。
    try {
      const resource = await this.client.createResource(organizationId, input);
      this.invalidateOrganization(organizationId);
      return resource;
    } catch (e) {
      this.applyError(e, organizationId);
      throw e;
    }
  }

  async updateResource(organizationId: string, resourceId: string, input: UpdateResourceInput): Promise<ResourceSummaryDto> {
    try {
      const resource = await this.client.updateResource(organizationId, resourceId, input);
      this.invalidateOrganization(organizationId);
      return resource;
    } catch (e) {
      // 409（版本冲突）不驱逐缓存，保留本地编辑，currentVersion 由调用方消化。
      this.applyError(e, organizationId, resourceId);
      throw e;
    }
  }

  async deleteResource(organizationId: string, resourceId: string): Promise<void> {
    try {
      await this.client.deleteResource(organizationId, resourceId);
      this.invalidateOrganization(organizationId);
    } catch (e) {
      this.applyError(e, organizationId, resourceId);
      throw e;
    }
  }

  // ── 错误 → 失效策略 ──

  private applyError(err: unknown, organizationId: string, resourceId?: string): void {
    if (!(err instanceof OrgApiError)) return;
    if (err.isAuthFailure()) {
      this.clearAuth();
      return;
    }
    if (!this.userId) return;
    if (err.isForbidden()) {
      this.cache.invalidateOrg(this.userId, organizationId);
      return;
    }
    if (err.isNotFound()) {
      if (resourceId !== undefined && err.code === 'RESOURCE_NOT_FOUND') {
        this.cache.invalidateResource(this.userId, organizationId, resourceId);
      } else {
        this.cache.invalidateOrg(this.userId, organizationId);
      }
    }
    // 409 不驱逐。
  }
}