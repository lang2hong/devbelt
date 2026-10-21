import * as vscode from 'vscode';
import type { ConnectionStore, SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { makeSub } from './shared.js';
import type { AiContextStore } from '../ai/aiContextStore.js';
import type { AiKeyStore } from '../ai/aiKeyStore.js';
import { readAiConfig, type AiService } from '../ai/aiService.js';
import { l10n } from '../i18n';

export interface AiCommandDeps {
  context: vscode.ExtensionContext;
  connectionStore: ConnectionStore;
  contextStore: AiContextStore;
  keyStore: AiKeyStore;
  service: AiService;
  /** 打开/聚焦 AI Chat 单例面板（装配在组合根）。 */
  openChat: () => void;
}

/**
 * AI 命令注册（P9 S3）：
 * - `devbelt.ai.chat`：打开/聚焦 Chat 面板（工具视图入口也走此命令）；
 * - `devbelt.ai.setApiKey` / `.clearApiKey`：SecretStorage 读写（Key 永不进设置 JSON）；
 * - `devbelt.ai.testConnection`：发一条最小请求验证当前 provider 配置；
 * - `devbelt.ai.domainContext` / `.defaultDirectives`：连接级自由文本编辑（Memento）。
 */
export function registerAiCommands(deps: AiCommandDeps): void {
  const sub = makeSub(deps.context);

  sub('devbelt.ai.chat', () => {
    deps.openChat();
  });

  sub('devbelt.ai.setApiKey', async () => {
    const value = await vscode.window.showInputBox({
      prompt: l10n('ai.apiKey.prompt'),
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return;
    await deps.keyStore.setApiKey(value);
    void vscode.window.showInformationMessage(l10n('ai.apiKey.saved'));
  });

  sub('devbelt.ai.clearApiKey', async () => {
    await deps.keyStore.clearApiKey();
    void vscode.window.showInformationMessage(l10n('ai.apiKey.cleared'));
  });

  sub('devbelt.ai.testConnection', async () => {
    const config = readAiConfig();
    try {
      await deps.service.chat(
        { model: config.model || 'default', messages: [{ role: 'user', content: 'ping' }], maxTokens: 8, feature: 'chat' },
        { feature: 'chat' },
      );
      void vscode.window.showInformationMessage(l10n('ai.test.ok'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showWarningMessage(l10n('ai.test.failed', { msg: message }));
    }
  });

  sub('devbelt.ai.domainContext', (node?: { conn?: SavedConnection }) =>
    editConnectionText(deps, 'domain', node?.conn),
  );
  sub('devbelt.ai.defaultDirectives', (node?: { conn?: SavedConnection }) =>
    editConnectionText(deps, 'directives', node?.conn),
  );
}

async function editConnectionText(
  deps: AiCommandDeps,
  kind: 'domain' | 'directives',
  conn?: SavedConnection,
): Promise<void> {
  const target = conn ?? (await pickConnection(deps));
  if (!target) return;
  const current =
    kind === 'domain' ? deps.contextStore.getDomainContext(target.id) : deps.contextStore.getDefaultDirectives(target.id);
  const value = await vscode.window.showInputBox({
    prompt: l10n(kind === 'domain' ? 'ai.domainContext.prompt' : 'ai.defaultDirectives.prompt', { name: target.name }),
    value: current,
    ignoreFocusOut: true,
  });
  if (value === undefined) return;
  const currentRules = deps.contextStore.getBusinessRules(target.id);
  await deps.contextStore.setBusinessRules(target.id, {
    ...currentRules,
    ...(kind === 'domain' ? { domainContext: value } : { defaultDirectives: value }),
  });
  void vscode.window.showInformationMessage(l10n('ai.context.saved'));
}

async function pickConnection(deps: AiCommandDeps): Promise<SavedConnection | undefined> {
  const items = deps.connectionStore.list().map((conn) => ({ label: conn.name, conn }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: l10n('ai.pickConnection') });
  return picked?.conn;
}