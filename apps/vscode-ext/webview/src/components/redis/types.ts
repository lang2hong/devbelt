import type { RedisKeyFolder, RedisNewKeyValue, RedisValueData } from '../../../../src/result/protocol';

export type { RedisKeyFolder, RedisNewKeyValue, RedisValueData };

export interface CommandResult {
  id: string;
  command: string;
  ok: boolean;
  result: string;
  costMs: number;
  error: string | null;
}

export interface SlowlogEntry {
  id: number;
  timestamp: number;
  durationMicros: number;
  command: string;
  clientAddr: string;
  clientName: string;
}

/** 选中 key 的值快照（host → webview）。 */
export interface ValueInfo {
  key: string;
  keyType: string;
  ttl: number;
  tooLarge: boolean;
  size: number | null;
  data: RedisValueData | null;
}

/** 扁平化后的键树行。 */
export interface KeyRow {
  kind: 'folder' | 'key';
  name: string;
  path: string;
  depth: number;
  count?: number;
}

/** 是否渲染键浏览器（三栏）；db 为 null 表示服务器状态视图。 */
export function isKeyBrowser(db: number | null): boolean {
  return db !== null;
}
