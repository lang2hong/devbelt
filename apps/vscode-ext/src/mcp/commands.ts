import * as vscode from 'vscode';
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { l10n } from '../i18n';
import type { McpServerHost } from './server';
import type { McpTokenStore } from './tokenStore';

export interface McpCommandDeps {
  host: McpServerHost;
  tokens: McpTokenStore;
  getConnection(): SavedConnection | undefined;
}

export function registerMcpCommands(deps: McpCommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('devbelt.mcp.enable', async () => {
      const conn = deps.getConnection();
      if (!conn) {
        void vscode.window.showErrorMessage(l10n('mcp.needConnection'));
        return;
      }
      await vscode.workspace.getConfiguration('devbelt').update('mcp.connectionId', conn.id, vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('devbelt').update('mcp.enabled', true, vscode.ConfigurationTarget.Global);
      try {
        const endpoint = await deps.host.start();
        void vscode.window.showInformationMessage(l10n('mcp.enabled', { endpoint }));
      } catch (err) {
        void vscode.window.showErrorMessage(l10n('mcp.startFailed', { message: err instanceof Error ? err.message : String(err) }));
      }
    }),
    vscode.commands.registerCommand('devbelt.mcp.disable', async () => {
      await vscode.workspace.getConfiguration('devbelt').update('mcp.enabled', false, vscode.ConfigurationTarget.Global);
      await deps.host.stop();
      void vscode.window.showInformationMessage(l10n('mcp.disabled'));
    }),
    vscode.commands.registerCommand('devbelt.mcp.copyClientConfig', async () => {
      if (!deps.host.running) {
        void vscode.window.showErrorMessage(l10n('mcp.notRunning'));
        return;
      }
      const name = await vscode.window.showInputBox({ prompt: l10n('mcp.clientName'), value: 'MCP client' });
      if (name === undefined) return;
      const { token } = await deps.tokens.create(name);
      const config = {
        mcpServers: {
          devbelt: {
            type: 'http',
            url: deps.host.endpoint,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      };
      await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
      void vscode.window.showInformationMessage(l10n('mcp.copied'));
    }),
    vscode.commands.registerCommand('devbelt.mcp.revokeClient', async () => {
      const clients = deps.tokens.list();
      if (clients.length === 0) {
        void vscode.window.showInformationMessage(l10n('mcp.noClients'));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        clients.map((c) => ({ label: c.name, description: new Date(c.createdAt).toLocaleString(), id: c.id })),
        { placeHolder: l10n('mcp.pickClient') },
      );
      if (!picked) return;
      await deps.tokens.revoke(picked.id);
      void vscode.window.showInformationMessage(l10n('mcp.revoked', { name: picked.label }));
    }),
  ];
}