import {
  ValidationError,
  EntityNotFoundError,
  OrganizationNotFoundError,
  OrganizationQuotaExceededError,
  OrganizationFeatureRequiredError,
  ResourceNotFoundError,
  ResourceVersionConflictError,
  FolderNotEmptyError,
  FolderMoveCycleError,
} from '../domain/errors.js';
import type { Resource } from '../domain/entities.js';
import type { ResourceType } from '../domain/enums.js';
import type {
  IOrganizationRepo,
  IOrganizationSubscriptionRepo,
  IFolderRepo,
  IResourceRepo,
  FolderDto,
  ResourceSummaryDto,
} from '../repository/interfaces.js';
import type { OrganizationSubscription } from '../domain/entities.js';
import type { TxRunner, Queryable } from '../repository/mysql/db.js';
import { canonicalJsonBytes, validateResourceContent } from './resourceContent.js';

/**
 * 组织目录与资源服务（切片 4）。
 *
 * 锁链：organization -> subscription(+ snapshot 计量) -> folder -> resource，
 * 接在既有锁链之后（§4.3）。祖先链环检测的安全性来自前置的**组织行锁串行化**——
 * 本服务所有写事务先 `lockById(org)`，故目录移动/删除的子树读取与并发写同一组织
 * 天然串行；若未来脱离组织锁复用这段逻辑，必须按 folder id 升序逐级锁定祖先链。
 */
export class OrganizationResourceService {
  constructor(
    private readonly organizationRepo: IOrganizationRepo,
    private readonly organizationSubscriptionRepo: IOrganizationSubscriptionRepo,
    private readonly folderRepo: IFolderRepo,
    private readonly resourceRepo: IResourceRepo,
    private readonly runner: TxRunner,
  ) {}

  // ── 目录 ──

  async listFolders(organizationId: number): Promise<FolderDto[]> {
    const folders = await this.folderRepo.listActive(organizationId);
    return folders.map((f) => ({ folderId: f.id, name: f.name, parentId: f.parentId }));
  }

  async createFolder(organizationId: number, name: string, parentId?: number | null): Promise<FolderDto> {
    const trimmed = validateName(name);
    const created = await this.runner(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      await this.requireSubscription(tx, organizationId);
      const parent = parentId == null ? null : await this.resolveFolder(tx, organizationId, parentId);
      return this.folderRepo.create(tx, { organizationId, parentId: parent ? parent.id : null, name: trimmed });
    });
    return { folderId: created.id, name: created.name, parentId: created.parentId };
  }

  async updateFolder(organizationId: number, folderId: number, input: { name?: string; parentId?: number | null }): Promise<FolderDto> {
    const name = input.name !== undefined ? validateName(input.name) : undefined;
    if (name === undefined && input.parentId === undefined) throw new ValidationError('at least one folder field is required');

    const current = await this.runner(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      await this.requireSubscription(tx, organizationId);
      const folder = await this.requireFolder(tx, organizationId, folderId);

      if (name !== undefined) await this.folderRepo.updateName(tx, folderId, name, organizationId);

      if (input.parentId !== undefined) {
        const newParentId = input.parentId;
        if (newParentId !== null) {
          if (newParentId === folderId) throw new FolderMoveCycleError();
          await this.resolveFolder(tx, organizationId, newParentId);
          const descendants = await this.folderRepo.collectDescendantIds(tx, organizationId, folderId);
          if (descendants.includes(newParentId)) throw new FolderMoveCycleError();
        }
        await this.folderRepo.updateParent(tx, folderId, newParentId, organizationId);
      }
      return { id: folderId, name: name ?? folder.name, parentId: input.parentId !== undefined ? input.parentId : folder.parentId };
    });
    return { folderId: current.id, name: current.name, parentId: current.parentId };
  }

  async deleteFolder(organizationId: number, folderId: number): Promise<{ ok: true }> {
    await this.runner(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      await this.requireSubscription(tx, organizationId);
      await this.requireFolder(tx, organizationId, folderId);
      const children = await this.folderRepo.countActiveChildren(tx, organizationId, folderId);
      const resources = await this.folderRepo.countActiveResources(tx, organizationId, folderId);
      if (children > 0 || resources > 0) throw new FolderNotEmptyError();
      await this.folderRepo.softDelete(tx, folderId, organizationId, new Date());
    });
    return { ok: true };
  }

  // ── 资源 ──

  async listResources(organizationId: number): Promise<ResourceSummaryDto[]> {
    return this.resourceRepo.listActiveByOrganization(organizationId);
  }

  async createResource(
    organizationId: number,
    input: { resourceType: ResourceType; name: string; folderId?: number | null; content: Record<string, unknown> },
    membershipId: number,
  ): Promise<ResourceSummaryDto> {
    const name = validateName(input.name);
    validateResourceContent(input.resourceType, input.content); // 纯函数，事务外（§5）

    const created = await this.runner(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      const subscription = await this.requireSubscription(tx, organizationId);
      this.assertEngineAllowed(subscription, input.resourceType, input.content);

      const folderId = input.folderId == null ? null : (await this.resolveFolder(tx, organizationId, input.folderId)).id;
      await this.assertResourceQuota(tx, organizationId, subscription, { countDelta: 1, bytesDelta: canonicalJsonBytes(input.content) });

      return this.resourceRepo.create(tx, {
        organizationId,
        folderId,
        resourceType: input.resourceType,
        name,
        content: input.content,
        version: 1,
        createdByMembershipId: membershipId,
      });
    });
    return toSummary(created);
  }

  async getResource(organizationId: number, resourceId: number): Promise<Resource> {
    const resource = await this.resourceRepo.findById(organizationId, resourceId);
    if (!resource || resource.deleteTime) throw new ResourceNotFoundError();
    return resource;
  }

  async updateResource(
    organizationId: number,
    resourceId: number,
    input: { baseVersion: number; name?: string; folderId?: number | null; content?: Record<string, unknown> },
    membershipId: number,
  ): Promise<ResourceSummaryDto> {
    const name = input.name !== undefined ? validateName(input.name) : undefined;
    if (name === undefined && input.folderId === undefined && input.content === undefined) {
      throw new ValidationError('at least one resource field is required');
    }

    // 预读拿 resourceType（不可变）供事务外 content 校验，以及是否存在性快速失败
    const hint = await this.resourceRepo.findById(organizationId, resourceId);
    if (!hint || hint.deleteTime) throw new ResourceNotFoundError();
    if (input.content !== undefined) validateResourceContent(hint.resourceType, input.content);

    const updated = await this.runner(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      const subscription = await this.requireSubscription(tx, organizationId);

      // 锁序（§4.3）：folder 先于 resource。显式移动到目录时先锁定并校验目标 folder。
      let resolvedFolderId: number | null | undefined;
      if (input.folderId !== undefined) {
        resolvedFolderId = input.folderId === null ? null : (await this.resolveFolder(tx, organizationId, input.folderId)).id;
      }

      const existing = await this.resourceRepo.findByIdForUpdate(tx, organizationId, resourceId);
      if (!existing || existing.deleteTime) throw new ResourceNotFoundError();

      const newContent = input.content ?? existing.content;
      const newName = name ?? existing.name;
      const newFolderId = resolvedFolderId !== undefined ? resolvedFolderId : existing.folderId;

      if (input.content !== undefined) this.assertEngineAllowed(subscription, existing.resourceType, newContent);
      await this.assertResourceQuota(tx, organizationId, subscription, {
        countDelta: 0,
        bytesDelta: canonicalJsonBytes(newContent) - canonicalJsonBytes(existing.content),
      });

      // 乐观锁数据库契约（§4.3）：WHERE version=baseVersion；0 行受影响说明版本已变。
      const affected = await this.resourceRepo.update(tx, {
        id: resourceId,
        organizationId,
        name: newName,
        folderId: newFolderId,
        content: newContent,
        baseVersion: input.baseVersion,
        updatedByMembershipId: membershipId,
      });
      if (!affected) throw new ResourceVersionConflictError(existing.version);

      return { ...existing, name: newName, folderId: newFolderId, content: newContent, version: input.baseVersion + 1 };
    });
    return toSummary(updated);
  }

  async deleteResource(organizationId: number, resourceId: number, membershipId: number): Promise<{ ok: true }> {
    await this.runner(async (tx) => {
      await this.lockOrganization(tx, organizationId);
      await this.requireSubscription(tx, organizationId);
      const existing = await this.resourceRepo.findByIdForUpdate(tx, organizationId, resourceId);
      if (!existing || existing.deleteTime) throw new ResourceNotFoundError();
      await this.resourceRepo.softDelete(tx, resourceId, organizationId, new Date(), membershipId);
    });
    return { ok: true };
  }

  // ── 私有 ──

  private async lockOrganization(tx: Queryable, organizationId: number): Promise<void> {
    const org = await this.organizationRepo.lockById(tx, organizationId);
    if (!org || org.status !== 'active') throw new OrganizationNotFoundError();
  }

  private async requireSubscription(tx: Queryable, organizationId: number): Promise<OrganizationSubscription> {
    const subscription = await this.organizationSubscriptionRepo.findByOrganizationIdForUpdate(tx, organizationId);
    if (!subscription || subscription.status !== 'active') throw new OrganizationNotFoundError();
    return subscription;
  }

  private async requireFolder(tx: Queryable, organizationId: number, folderId: number) {
    const folder = await this.folderRepo.findByIdForUpdate(tx, organizationId, folderId);
    if (!folder || folder.deleteTime) {
      throw new EntityNotFoundError('folder', folderId);
    }
    return folder;
  }

  private async resolveFolder(tx: Queryable, organizationId: number, folderId: number) {
    return this.requireFolder(tx, organizationId, folderId);
  }

  private assertEngineAllowed(subscription: OrganizationSubscription, resourceType: ResourceType, content: Record<string, unknown>): void {
    if (resourceType !== 'connection_template') return;
    const allowed = subscription.entitlementSnapshot?.allowedTemplateDatabaseTypes;
    const list = Array.isArray(allowed) ? (allowed as string[]) : [];
    if (!list.includes(content.databaseType as string)) {
      throw new OrganizationFeatureRequiredError(`database engine not allowed: ${String(content.databaseType)}`);
    }
  }

  /** §4.2：数量与字节配额在锁内按快照计量；0 表示无限（跳过对应维度）。 */
  private async assertResourceQuota(
    tx: Queryable,
    organizationId: number,
    subscription: OrganizationSubscription,
    delta: { countDelta: number; bytesDelta: number },
  ): Promise<void> {
    const maxRes = subscription.entitlementSnapshot?.maxSharedResources;
    const maxBytes = subscription.entitlementSnapshot?.sharedStorageQuotaBytes;
    const resourceCap = typeof maxRes === 'number' && maxRes > 0 ? maxRes : 0;
    const byteCap = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 0;
    if (resourceCap === 0 && byteCap === 0) return;

    const contents = await this.resourceRepo.listActiveContent(tx, organizationId);
    if (resourceCap > 0 && contents.length + delta.countDelta > resourceCap) {
      throw new OrganizationQuotaExceededError('resource count quota exceeded');
    }
    if (byteCap > 0) {
      const bytes = contents.reduce((sum, c) => sum + canonicalJsonBytes(c), 0) + delta.bytesDelta;
      if (bytes > byteCap) throw new OrganizationQuotaExceededError('storage quota exceeded');
    }
  }
}

function validateName(nameRaw: string): string {
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
  if (!name || Array.from(name).length > 200) {
    throw new ValidationError('name must be 1..200 characters');
  }
  return name;
}

function toSummary(r: Resource): ResourceSummaryDto {
  return {
    resourceId: r.id,
    resourceType: r.resourceType,
    name: r.name,
    folderId: r.folderId,
    version: r.version,
    createdByMembershipId: r.createdByMembershipId,
    updatedByMembershipId: r.updatedByMembershipId,
  };
}