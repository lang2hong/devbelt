import * as vscode from 'vscode';
import { OrgWorkspace } from '../org/workspace';
import type { ResourceSummaryDto } from '../org/types';

export type OrgNodeKind = 'organization' | 'folder' | 'resource' | 'info';

/**
 * 组织 Workspace 树节点。
 * 与个人 `DbTreeNode` 完全分离：组织资源不进入个人 `ConnectionStore`（§6.2）。
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
      case 'organization': return 'dbclient.org.organization';
      case 'folder': return 'dbclient.org.folder';
      case 'resource': return `dbclient.org.resource.${this.resource?.resourceType ?? 'unknown'}`;
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
      return this.orgChildren(element.orgId);
    }
    if (element.kind === 'folder' && element.orgId && element.folderId) {
      return this.folderChildren(element.orgId, element.folderId);
    }
    return [];
  }

  private async roots(): Promise<OrgTreeNode[]> {
    try {
      const orgs = await this.workspace.listOrganizations();
      if (!orgs.length) return [new OrgTreeNode('No organizations (not signed in, or not a member)', vscode.TreeItemCollapsibleState.None, 'info')];
      return orgs.map((o) => new OrgTreeNode(
        o.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        'organization',
        o.organizationId,
        undefined,
        undefined,
      ));
    } catch {
      return [new OrgTreeNode('Sign in to view organizations', vscode.TreeItemCollapsibleState.None, 'info')];
    }
  }

  private async loadOrg(orgId: string): Promise<{ folders: import('../org/types').FolderDto[]; resources: ResourceSummaryDto[] }> {
    const [folders, resources] = await Promise.all([
      this.workspace.listFolders(orgId).catch(() => []),
      this.workspace.listResources(orgId).catch(() => []),
    ]);
    return { folders, resources };
  }

  private async orgChildren(orgId: string): Promise<OrgTreeNode[]> {
    const { folders, resources } = await this.loadOrg(orgId);
    return this.buildNodes(orgId, folders, resources, null);
  }

  private async folderChildren(orgId: string, folderId: string): Promise<OrgTreeNode[]> {
    const { folders, resources } = await this.loadOrg(orgId);
    return this.buildNodes(orgId, folders, resources, folderId);
  }

  private buildNodes(
    orgId: string,
    folders: import('../org/types').FolderDto[],
    resources: ResourceSummaryDto[],
    parentId: string | null,
  ): OrgTreeNode[] {
    const nodes: OrgTreeNode[] = [];
    for (const f of folders) {
      if (f.parentId !== parentId) continue;
      const collapsible = folders.some((x) => x.parentId === f.folderId) || resources.some((r) => r.folderId === f.folderId);
      nodes.push(new OrgTreeNode(f.name, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None, 'folder', orgId, f.folderId));
    }
    for (const r of resources) {
      if (r.folderId !== parentId) continue;
      const node = new OrgTreeNode(r.name, vscode.TreeItemCollapsibleState.None, 'resource', orgId, r.folderId ?? undefined, r);
      node.description = `${r.resourceType === 'connection_template' ? 'template' : 'query'} · v${r.version}`;
      nodes.push(node);
    }
    return nodes;
  }
}