import * as vscode from 'vscode';
import { OrgWorkspace } from '../org/workspace';
import type { OrganizationRole, ResourceSummaryDto } from '../org/types';
import { l10n } from '../i18n';

export type OrgNodeKind = 'organization' | 'folder' | 'resource' | 'info';

/**
 * 组织 Workspace 树节点。
 * 与个人 `DbTreeNode` 完全分离：组织资源不进入个人 `ConnectionStore`（§2 个人与组织边界）。
 */
export class OrgTreeNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsible: vscode.TreeItemCollapsibleState,
    public readonly kind: OrgNodeKind,
    /** 所属组织 id */
    public readonly orgId?: string,
    /** 目录 id */
    public readonly folderId?: string,
    /** 资源摘要（resource 节点） */
    public readonly resource?: ResourceSummaryDto,
    /** 当前用户在该组织内的角色（仅 UX，非授权；从组织根节点向下传播）。 */
    public readonly role?: OrganizationRole,
  ) {
    super(label, collapsible);
    this.contextValue = this.computeContextValue();
    if (kind === 'organization') {
      this.iconPath = new vscode.ThemeIcon('organization');
    } else if (kind === 'folder') {
      this.iconPath = new vscode.ThemeIcon('folder');
    } else if (kind === 'resource') {
      this.iconPath = new vscode.ThemeIcon(resource?.resourceType === 'connection_template' ? 'server' : 'code');
    }
  }

  private computeContextValue(): string {
    switch (this.kind) {
      case 'organization': return `dbclient.org.organization.${this.role ?? 'unknown'}`;
      case 'folder': return `dbclient.org.folder.${this.role ?? 'unknown'}`;
      case 'resource': return `dbclient.org.resource.${this.resource?.resourceType ?? 'unknown'}.${this.role ?? 'unknown'}`;
      default: return 'dbclient.org.info';
    }
  }
}

export class OrgTreeDataProvider implements vscode.TreeDataProvider<OrgTreeNode> {
  private readonly emitter = new vscode.EventEmitter<OrgTreeNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<OrgTreeNode | undefined> = this.emitter.event;

  constructor(private readonly workspace: OrgWorkspace) {
    workspace.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: OrgTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: OrgTreeNode): Promise<OrgTreeNode[]> {
    if (!element) {
      return this.roots();
    }
    if (element.kind === 'organization' && element.orgId) {
      return this.orgChildren(element.orgId, element.role);
    }
    if (element.kind === 'folder' && element.orgId && element.folderId) {
      return this.folderChildren(element.orgId, element.folderId, element.role);
    }
    return [];
  }

  private async roots(): Promise<OrgTreeNode[]> {
    try {
      const orgs = await this.workspace.listOrganizations();
      if (!orgs.length) return [new OrgTreeNode(l10n('org.tree.noOrganizations'), vscode.TreeItemCollapsibleState.None, 'info')];
      return orgs.map((o) => new OrgTreeNode(
        o.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        'organization',
        o.organizationId,
        undefined,
        undefined,
        o.role,
      ));
    } catch {
      return [new OrgTreeNode(l10n('org.tree.signInFirst'), vscode.TreeItemCollapsibleState.None, 'info')];
    }
  }

  private async loadOrg(orgId: string): Promise<{ folders: import('../org/types').FolderDto[]; resources: ResourceSummaryDto[] }> {
    const [folders, resources] = await Promise.all([
      this.workspace.listFolders(orgId).catch(() => []),
      this.workspace.listResources(orgId).catch(() => []),
    ]);
    return { folders, resources };
  }

  private async orgChildren(orgId: string, role?: import('../org/types').OrganizationRole): Promise<OrgTreeNode[]> {
    const { folders, resources } = await this.loadOrg(orgId);
    return this.buildNodes(orgId, folders, resources, null, role);
  }

  private async folderChildren(orgId: string, folderId: string, role?: import('../org/types').OrganizationRole): Promise<OrgTreeNode[]> {
    const { folders, resources } = await this.loadOrg(orgId);
    return this.buildNodes(orgId, folders, resources, folderId, role);
  }

  private buildNodes(
    orgId: string,
    folders: import('../org/types').FolderDto[],
    resources: ResourceSummaryDto[],
    parentId: string | null,
    role?: import('../org/types').OrganizationRole,
  ): OrgTreeNode[] {
    const nodes: OrgTreeNode[] = [];
    for (const f of folders) {
      if (f.parentId !== parentId) continue;
      const collapsible = folders.some((x) => x.parentId === f.folderId) || resources.some((r) => r.folderId === f.folderId);
      nodes.push(new OrgTreeNode(f.name, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None, 'folder', orgId, f.folderId, undefined, role));
    }
    for (const r of resources) {
      if (r.folderId !== parentId) continue;
      const node = new OrgTreeNode(r.name, vscode.TreeItemCollapsibleState.None, 'resource', orgId, r.folderId ?? undefined, r, role);
      node.description = `${r.resourceType === 'connection_template' ? 'template' : 'query'} · v${r.version}`;
      nodes.push(node);
    }
    return nodes;
  }
}