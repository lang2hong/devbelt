import * as vscode from 'vscode';
import type { StoredModelAccessFields } from './aiModelAccessStore.js';

/**
 * 把模型接入配置落到运行时设置（`readAiConfig` 的数据源）：用户级（Global）写入。
 * 注意：若用户在工作区级显式覆盖了这些设置，工作区值优先（VS Code 设置层级语义）。
 */
export async function applyModelAccessRuntime(fields: Pick<StoredModelAccessFields, 'mode' | 'baseUrl' | 'model'>): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('devbelt');
  await cfg.update('ai.provider', fields.mode, vscode.ConfigurationTarget.Global);
  if (fields.mode === 'openai-compatible') {
    await cfg.update('ai.baseUrl', fields.baseUrl, vscode.ConfigurationTarget.Global);
    await cfg.update('ai.model', fields.model, vscode.ConfigurationTarget.Global);
  }
}
