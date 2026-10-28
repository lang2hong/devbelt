import type * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

/**
 * 匿名安装标识：每台机器/每个 VS Code Profile 一个随机 UUID。
 *
 * - 不绑定账号、不含 PII；账号切换不重置。
 * - 反馈与安装心跳共用同一个 ID，便于把反馈和安装统计关联到同一安装。
 * - 首次使用时生成并写入 `globalState`；之后稳定复用。
 */
export const INSTALL_ID_KEY = 'devbelt.installId';

export function getOrCreateInstallId(globalState: vscode.Memento): string {
  const existing = globalState.get<string>(INSTALL_ID_KEY);
  if (existing) return existing;
  const id = randomUUID();
  void globalState.update(INSTALL_ID_KEY, id);
  return id;
}