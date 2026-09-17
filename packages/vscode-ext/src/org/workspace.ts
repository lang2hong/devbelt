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

/** 客户端本地 UI 概念（非服务端 DTO）：role 由 /api/db/organizations 的 role 派生，仅供展示，不做授权。 */
export type WorkspaceRef =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string; role: 'admin' | 'member' };

export class OrgWorkspace {
  private readonly cache = new OrgCache();
  private readonly changed = new EventEmitter<void>();
  private readonly authFailed = new EventEmitter<void>();
  private readonly roleChanged = new EventEmitter<void>();

  /** 缓存/失效时触发（树刷新、状态栏更新）。 */
  readonly onDidChange: Event<void> = this.changed.event;

  /** 401 会话过期时触发（扩展层据此弹「登录已过期」并清 role context）；主动 logout 不触发。 */
  readonly onAuthFailure: Event<void> = this.authFailed.event;

  /** 仅当前 workspace 角色变化时触发（树选择同步角色；不触发 changed，避免全树刷新塌缩）。 */
  readonly onRoleChanged: Event<void> = this.roleChanged.event;

  private current: WorkspaceRef = { kind: 'personal' };
  private userId?: string;
  /** 单飞凭据清理 chain：每次清理排在前一次完成后执行，绝不覆盖在途清理。 */
  private cleanup: Promise<void> = Promise.resolve();
  /** 已从「已认证」转到「会话过期」且尚未重新认证时为 true，用于并发 401 只弹一次窗。 */
  private authFailureActive = false;

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

  /** 切换 Workspace。silent 时仅同步角色（fire onRoleChanged），不触发 onDidChange（避免树塌缩）。 */
  select(ws: WorkspaceRef, opts?: { silent?: boolean }): void {
    this.current = ws;
    this.roleChanged.fire();
    if (!opts?.silent) this.changed.fire();
  }

  /**
   * 登录后选择默认组织：取 listOrganizations 的第一个 active 组织；
   * 无活跃组织或请求失败时回退 personal，并触发已有的 onDidChange（树自动刷新）。
   */
  async selectDefaultOrg(): Promise<void> {
    try {
      const orgs = await this.listOrganizations();
      const active = orgs.find((o) => o.status === 'active');
      if (active) {
        this.select({ kind: 'organization', organizationId: active.organizationId, role: active.role });
      } else {
        this.select({ kind: 'personal' });
      }
    } catch {
      this.select({ kind: 'personal' });
    }
  }

  /** 401/登出：清认证，回退 personal；返回的 promise 在本次及此前所有清理完成后 resolve。 */
  clearAuth(): Promise<void> {
    this.userId = undefined;
    this.cache.clearAll();
    this.current = { kind: 'personal' };
    this.changed.fire();
    // 串行化：新清理排在前一次完成后执行，绝不覆盖在途清理（否则慢清理会在重新
    // 登录写入新凭据后再次 delete，删掉新密码）。waitForCleanup/调用方 await 该完整链。
    this.cleanup = this.cleanup.then(() => this.vault.clearAll()).catch(() => {});
    return this.cleanup;
  }

  /** 等待尚未完成的凭据清理链（连接模板在读/写 vault 前调用，避免清理竞态）。 */
  async waitForCleanup(): Promise<void> {
    await this.cleanup;
  }

  /** 401：清认证 + 通知「会话过期」；并发 401 只发射一次。 */
  private handleAuthFailure(): void {
    if (this.authFailureActive) return; // 状态已清理且清理已入链，无需重复 clearAuth。
    this.authFailureActive = true;
    void this.clearAuth();
    this.authFailed.fire();
  }

  /** 成员状态/角色变更、退出、移除、关闭 → 立即失效该组织缓存并触发重拉。 */
  invalidateOrganization(organizationId: string): void {
    if (this.userId) this.cache.invalidateOrg(this.userId, organizationId);
    this.changed.fire();
  }

  // ── 带缓存的读取 ──

  /** 列组织（不走持久缓存：角色/状态须实时反映，成员状态变更后立即重拉）。 */
  async listOrganizations(): Promise<OrganizationSummaryDto[]> {
    try {
      const orgs = await this.client.listOrganizations();
      // 认证恢复（重新登录/首登成功）后，允许再一次 401 触发「会话过期」提示。
      this.authFailureActive = false;
      return orgs;
    } catch (e) {
      // 树加载遇到 401 时清认证，避免保留旧 workspace 状态（否则树仍显示旧组织）。
      if (e instanceof OrgApiError && e.isAuthFailure()) this.handleAuthFailure();
      throw e;
    }
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
      this.handleAuthFailure();
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
