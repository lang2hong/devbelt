/**
 * 组织资源内存缓存（§6.2）。
 *
 * - 只在内存中，按 `${userId}:${organizationId}` 分区，跨组织/跨用户互不可见。
 * - 失效规则由调用方（OrgWorkspace）按错误驱动调用：
 *     - 401 → clearForUser（清认证，整用户清空）
 *     - 403/404 → invalidateOrg / invalidateResource（清无权/失效资源）
 *     - 409 → 不驱逐（保留本地编辑，调用方用 currentVersion 继续）
 *     - 成员角色/状态变更、退出、移除、关闭 → invalidateOrg
 */
import type { FolderDto, ResourceDetailDto, ResourceSummaryDto } from './types';

interface OrgPartition {
  folders?: FolderDto[];
  resources?: ResourceSummaryDto[];
  details: Map<string, ResourceDetailDto>;
}

export class OrgCache {
  private readonly partitions = new Map<string, OrgPartition>();

  /** 分区键：userId + organizationId。 */
  private key(userId: string, organizationId: string): string {
    return `${userId}:${organizationId}`;
  }

  private partition(userId: string, organizationId: string): OrgPartition {
    const k = this.key(userId, organizationId);
    let p = this.partitions.get(k);
    if (!p) {
      p = { details: new Map() };
      this.partitions.set(k, p);
    }
    return p;
  }

  hasOrganization(userId: string, organizationId: string): boolean {
    return this.partitions.has(this.key(userId, organizationId));
  }

  /** 目录列表缓存。 */
  getFolders(userId: string, organizationId: string): FolderDto[] | undefined {
    return this.partitions.get(this.key(userId, organizationId))?.folders;
  }

  setFolders(userId: string, organizationId: string, folders: FolderDto[]): void {
    this.partition(userId, organizationId).folders = folders;
  }

  /** 资源列表（摘要，不含 content）。 */
  getResources(userId: string, organizationId: string): ResourceSummaryDto[] | undefined {
    return this.partitions.get(this.key(userId, organizationId))?.resources;
  }

  setResources(userId: string, organizationId: string, resources: ResourceSummaryDto[]): void {
    this.partition(userId, organizationId).resources = resources;
  }

  /** 资源详情（含 content）。 */
  getDetail(userId: string, organizationId: string, resourceId: string): ResourceDetailDto | undefined {
    return this.partitions.get(this.key(userId, organizationId))?.details.get(resourceId);
  }

  setDetail(userId: string, organizationId: string, detail: ResourceDetailDto): void {
    this.partition(userId, organizationId).details.set(detail.resourceId, detail);
  }

  /**
   * 驱逐单个组织分区（成员状态/角色/退出/移除/关闭、403/404 组织级）。
   * 返回是否存在过该分区（供调用方判断是否需要触发重拉）。
   */
  invalidateOrg(userId: string, organizationId: string): boolean {
    return this.partitions.delete(this.key(userId, organizationId));
  }

  /** 驱逐单个资源（403/404 资源级：无权或已失效）。 */
  invalidateResource(userId: string, organizationId: string, resourceId: string): boolean {
    const p = this.partitions.get(this.key(userId, organizationId));
    if (!p) return false;
    let changed = p.details.delete(resourceId);
    const res = p.resources;
    if (res) {
      const idx = res.findIndex((r) => r.resourceId === resourceId);
      if (idx >= 0) {
        res.splice(idx, 1);
        changed = true;
      }
    }
    return changed;
  }

  /** 清空某用户的全部分区（登出 / 401）。 */
  clearForUser(userId: string): number {
    const prefix = `${userId}:`;
    let removed = 0;
    for (const k of [...this.partitions.keys()]) {
      if (k.startsWith(prefix)) {
        this.partitions.delete(k);
        removed++;
      }
    }
    return removed;
  }

  /** 清空全部（扩展停用 / 全量失效）。 */
  clearAll(): void {
    this.partitions.clear();
  }

  /** 测试/调试：返回当前分区数。 */
  get size(): number {
    return this.partitions.size;
  }
}