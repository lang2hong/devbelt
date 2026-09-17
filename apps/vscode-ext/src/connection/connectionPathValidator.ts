import { DatabaseType } from '@devkit/db-core';
import type { SavedConnection } from './connectionStore';
import { isOrganizationConnectionId } from '../sync/entitlementGate';

/**
 * 路径校验 API（阶段 A 附加，无 UI）。
 *
 * 依据 D1/B3 裁定口径：连接的路径字段是「同步源配置」规范值；建连以「本机覆盖优先，
 * 否则同步源值」的有效配置为准。本模块只校验**有效配置**是否可建连——对已配置（非空）
 * 但缺失/不可用的路径做硬拒绝，不静默降级。
 *
 * 阶段 A 仅提供 `validateConnectionPaths(conn)` 可查询 API，供 ConnectionManager 在建连
 * 前强制校验；树 warning 图标 / tooltip / 补齐表单属阶段 B。
 */

export interface PathValidationIssue {
  /** 出问题的字段名（dbPath / caPath / clientCertPath / clientKeyPath / sshPrivateKeyPath / socketPath）。 */
  field: string;
  /** 不可用原因（不含完整路径内容，避免泄漏敏感路径）。 */
  reason: 'missing' | 'not-readable';
}

export interface PathValidationResult {
  valid: boolean;
  issues: PathValidationIssue[];
}

/** 连接使用的路径字段（按引擎/是否 SSH 决定哪些需要校验）。 */
function pathFieldsOf(conn: SavedConnection): { field: string; value: string }[] {
  const fields: { field: string; value: string }[] = [];
  if (conn.dbType === DatabaseType.SQLITE) {
    // SQLite 走 dbPath；sqliteCommand 是命令路径，缺失时可自动探测，但显式配置须可读。
    if (conn.dbPath) fields.push({ field: 'dbPath', value: conn.dbPath });
    if (conn.sqliteCommand) fields.push({ field: 'sqliteCommand', value: conn.sqliteCommand });
  }
  if (conn.useSSL) {
    if (conn.caPath) fields.push({ field: 'caPath', value: conn.caPath });
    if (conn.clientCertPath) fields.push({ field: 'clientCertPath', value: conn.clientCertPath });
    if (conn.clientKeyPath) fields.push({ field: 'clientKeyPath', value: conn.clientKeyPath });
  }
  if (conn.sshHost) {
    if (conn.sshPrivateKeyPath) fields.push({ field: 'sshPrivateKeyPath', value: conn.sshPrivateKeyPath });
  }
  if (conn.socketPath) fields.push({ field: 'socketPath', value: conn.socketPath });
  return fields;
}

/**
 * 校验连接的本地路径是否可用（存在/可读）。组织连接（临时凭据映射、无本机路径）跳过。
 * `fsAccess` 可注入以便测试（真实环境用 fs.access）。
 *
 * connectionUrl 只做非空校验（连接串模式下必须有值；URL 合法性交给驱动报错，不做 fs 校验）。
 */
export async function validateConnectionPaths(
  conn: SavedConnection,
  fsAccess?: (path: string, mode: number) => Promise<void>,
): Promise<PathValidationResult> {
  if (isOrganizationConnectionId(conn.id)) return { valid: true, issues: [] };
  const access = fsAccess ?? defaultAccess;
  const issues: PathValidationIssue[] = [];
  if (conn.useConnectionString && !(conn.connectionUrl && conn.connectionUrl.trim() !== '')) {
    issues.push({ field: 'connectionUrl', reason: 'missing' });
  }
  for (const { field, value } of pathFieldsOf(conn)) {
    if (!value) continue; // 未配置则不校验，交给方言默认行为
    let ok = false;
    try {
      await access(value, 4 /* R_OK */);
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok) {
      issues.push({ field, reason: value.trim() === '' ? 'missing' : 'not-readable' });
    }
  }
  return { valid: issues.length === 0, issues };
}

async function defaultAccess(path: string, mode: number): Promise<void> {
  const { constants } = await import('node:fs');
  const { access } = await import('node:fs/promises');
  await access(path, constants.R_OK);
  void mode;
}