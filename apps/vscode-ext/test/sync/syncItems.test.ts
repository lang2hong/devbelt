import { describe, expect, it } from 'vitest';
import type { SyncEntityType } from '@devbelt/db-host/sync/e2e/syncEntity';
import {
  DEFAULT_SYNC_ITEMS,
  parseSyncItems,
  readSyncItems,
  typeEnabledOf,
  type SyncItems,
} from '../../src/sync/syncItems';

const ALL_TYPES: SyncEntityType[] = [
  'connection', 'group', 'queryFolder', 'query',
  'authenticatorEntry', 'authenticatorGroup', 'authenticatorTag',
  'schemaNotes', 'aiModelAccess',
];

describe('parseSyncItems（设置解析，缺省回退为开）', () => {
  it('缺省/非对象/数组 → 全开（默认值）', () => {
    expect(parseSyncItems(undefined)).toEqual(DEFAULT_SYNC_ITEMS);
    expect(parseSyncItems(null)).toEqual(DEFAULT_SYNC_ITEMS);
    expect(parseSyncItems('x')).toEqual(DEFAULT_SYNC_ITEMS);
    expect(parseSyncItems([true])).toEqual(DEFAULT_SYNC_ITEMS);
  });
  it('仅显式 false 关闭；其余值视为开', () => {
    expect(parseSyncItems({ connections: false })).toEqual({ ...DEFAULT_SYNC_ITEMS, connections: false });
    expect(parseSyncItems({ queries: 0, notes: 'off' })).toEqual(DEFAULT_SYNC_ITEMS);
  });
});

describe('typeEnabledOf（类型映射 + 依赖级联）', () => {
  it('全开 → 所有类型启用', () => {
    for (const t of ALL_TYPES) expect(typeEnabledOf(DEFAULT_SYNC_ITEMS, t)).toBe(true);
  });
  it('关连接 → 连接/分组停，查询/注记随停（级联），其余不受影响', () => {
    const items: SyncItems = { ...DEFAULT_SYNC_ITEMS, connections: false };
    const enabled = ALL_TYPES.filter((t) => typeEnabledOf(items, t));
    expect(enabled).toEqual(['authenticatorEntry', 'authenticatorGroup', 'authenticatorTag', 'aiModelAccess']);
  });
  it('只关查询/注记：连接不受影响', () => {
    const items: SyncItems = { ...DEFAULT_SYNC_ITEMS, queries: false, notes: false };
    expect(typeEnabledOf(items, 'connection')).toBe(true);
    expect(typeEnabledOf(items, 'query')).toBe(false);
    expect(typeEnabledOf(items, 'schemaNotes')).toBe(false);
  });
  it('关验证器 / 关 AI 模型接入：仅各自类型停', () => {
    const noAuth: SyncItems = { ...DEFAULT_SYNC_ITEMS, authenticator: false };
    expect(typeEnabledOf(noAuth, 'authenticatorEntry')).toBe(false);
    expect(typeEnabledOf(noAuth, 'connection')).toBe(true);
    const noAi: SyncItems = { ...DEFAULT_SYNC_ITEMS, aiModelAccess: false };
    expect(typeEnabledOf(noAi, 'aiModelAccess')).toBe(false);
    expect(typeEnabledOf(noAi, 'query')).toBe(true);
  });
});

describe('readSyncItems（配置读取）', () => {
  it('透传 devbelt.sync.items；缺省用默认', () => {
    const fake = { get: (k: string, d: unknown) => (k === 'sync.items' ? { notes: false } : d) };
    expect(readSyncItems(fake as never)).toEqual({ ...DEFAULT_SYNC_ITEMS, notes: false });
    const missing = { get: (_k: string, d: unknown) => d };
    expect(readSyncItems(missing as never)).toEqual(DEFAULT_SYNC_ITEMS);
  });
});
