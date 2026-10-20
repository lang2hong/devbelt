import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * change_sequence 是 BIGINT UNSIGNED。`ORDER BY change_sequence + 0` 是表达式排序，
 * 会让 (user_id, key_epoch, change_sequence) 索引无法用于排序而退化为 filesort。
 * 这里做机械断言，防止性能回归。
 */
describe('同步 feed 排序', () => {
  it('change_sequence 直接排序，不使用 + 0 表达式', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/modules/db/repository/syncRecordRepo.ts'),
      'utf8',
    );
    expect(src).not.toContain('ORDER BY change_sequence + 0');
  });
});