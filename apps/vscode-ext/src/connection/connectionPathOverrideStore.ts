import { DatabaseType } from '@devkit/db-core';
import type { SavedConnection } from './connectionStore';

/**
 * 本机路径覆盖（B3 · needsConfig）。
 *
 * 依据 D1/B3 裁定口径（规格「六」）：连接记录中的路径/串字段是「同步源配置」规范值，
 * 随 E2EE 密文跨设备同步；用户在本机「补齐」的值是覆盖，**优先于源值**，仅存本机
 * (globalState)、永不回传、不修改同步 record、不更新 revision、不产生出站 mutation、不
 * 触发同步事件。
 *
 * 覆盖字段（allowlist，与「六」对齐）：
 *   dbPath / caPath / clientCertPath / clientKeyPath / sshPrivateKeyPath / socketPath /
 *   connectionUrl / useConnectionString / sqliteCommand
 *
 * 规则：
 * - `set` 为 merge：只更新提供的字段，空串/空白视为清除该字段覆盖（不持久化空值）。
 * - `applyOverrides` 按源 conn 的条件裁剪（SQLite-only / SSL-only / SSH-only），不适用字段
 *   静默忽略；始终返回**新对象**，绝不原地修改同步源 SavedConnection。
 */
export interface PathOverrideFields {
  dbPath?: string;
  caPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  sshPrivateKeyPath?: string;
  socketPath?: string;
  connectionUrl?: string;
  useConnectionString?: boolean;
  sqliteCommand?: string;
}

export type PathOverrideFieldName = keyof PathOverrideFields;

type MementoLike = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
};

const STRING_FIELDS = [
  'dbPath', 'caPath', 'clientCertPath', 'clientKeyPath',
  'sshPrivateKeyPath', 'socketPath', 'connectionUrl', 'sqliteCommand',
] as const;
const BOOL_FIELDS = ['useConnectionString'] as const;

export class ConnectionPathOverrideStore {
  private static readonly KEY = 'dbclient.connectionPathOverrides';

  constructor(private readonly memento: MementoLike) {}

  /** 读取某连接的覆盖（已按 allowlist 清洗，去掉空值）。 */
  get(connId: string): PathOverrideFields {
    const raw = this.readAll()[connId];
    if (!raw || typeof raw !== 'object') return {};
    const out: PathOverrideFields = {};
    for (const f of STRING_FIELDS) {
      const v = (raw as Record<string, unknown>)[f];
      if (typeof v === 'string' && v !== '') out[f] = v;
    }
    for (const f of BOOL_FIELDS) {
      const v = (raw as Record<string, unknown>)[f];
      if (typeof v === 'boolean') out[f] = v;
    }
    return out;
  }

  /** merge 覆盖：空串/空白清除该字段；仅 allowlist 字段被接受。 */
  async set(connId: string, overrides: PathOverrideFields): Promise<void> {
    const data = this.readAll();
    const existing = { ...this.get(connId) };
    let changed = false;
    for (const f of STRING_FIELDS) {
      const v = overrides[f];
      if (v === undefined || typeof v !== 'string') continue;
      if (v.trim() === '') {
        if (existing[f] !== undefined) { delete existing[f]; changed = true; }
      } else if (existing[f] !== v) {
        existing[f] = v; changed = true;
      }
    }
    for (const f of BOOL_FIELDS) {
      const v = overrides[f];
      if (v === undefined || typeof v !== 'boolean') continue;
      if (existing[f] !== v) { existing[f] = v; changed = true; }
    }
    if (!changed) return;
    if (Object.keys(existing).length === 0) delete data[connId];
    else data[connId] = existing;
    await this.memento.update(ConnectionPathOverrideStore.KEY, data);
  }

  /** 清除单字段覆盖。 */
  async clearField(connId: string, field: PathOverrideFieldName): Promise<void> {
    const data = this.readAll();
    const existing = { ...this.get(connId) };
    if (existing[field] === undefined) return;
    delete existing[field];
    if (Object.keys(existing).length === 0) delete data[connId];
    else data[connId] = existing;
    await this.memento.update(ConnectionPathOverrideStore.KEY, data);
  }

  /** 清除整连接的全部覆盖（恢复同步源值）。 */
  async clear(connId: string): Promise<void> {
    const data = this.readAll();
    if (!(connId in data)) return;
    delete data[connId];
    await this.memento.update(ConnectionPathOverrideStore.KEY, data);
  }

  /**
   * 有效配置：覆盖优先，按源 conn 条件裁剪，返回新对象（不原地改源 conn）。
   * 无覆盖时同样返回浅拷贝，保证调用方拿到的是可安全替换字段的新对象。
   */
  applyOverrides(conn: SavedConnection): SavedConnection {
    const o = this.get(conn.id);
    const effective = { ...conn };
    if (conn.dbType === DatabaseType.SQLITE) {
      if (o.dbPath !== undefined) effective.dbPath = o.dbPath;
      if (o.sqliteCommand !== undefined) effective.sqliteCommand = o.sqliteCommand;
    }
    if (conn.useSSL) {
      if (o.caPath !== undefined) effective.caPath = o.caPath;
      if (o.clientCertPath !== undefined) effective.clientCertPath = o.clientCertPath;
      if (o.clientKeyPath !== undefined) effective.clientKeyPath = o.clientKeyPath;
    }
    if (conn.sshHost) {
      if (o.sshPrivateKeyPath !== undefined) effective.sshPrivateKeyPath = o.sshPrivateKeyPath;
    }
    if (o.socketPath !== undefined) effective.socketPath = o.socketPath;
    if (o.connectionUrl !== undefined) effective.connectionUrl = o.connectionUrl;
    if (o.useConnectionString !== undefined) effective.useConnectionString = o.useConnectionString;
    return effective;
  }

  private readAll(): Record<string, Record<string, unknown>> {
    return this.memento.get<Record<string, Record<string, unknown>>>(ConnectionPathOverrideStore.KEY) ?? {};
  }
}