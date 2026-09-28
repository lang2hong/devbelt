import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 机械把关：自动同步只能由「开关开启」或「显式命令」触发。
 * 聚焦/config 两处 `session.scheduleNow()` 之前必须有 `isAutoSyncEnabled()` 守卫；
 * 本地 store 变更要落诊断日志（trigger + autoSync），便于证伪「关了还在同步」。
 */
describe('同步自动触发门控', () => {
  const ext = readFileSync(join(process.cwd(), 'src/extension.ts'), 'utf8');

  it('每个 scheduleNow() 调用之前都有 isAutoSyncEnabled() 守卫', () => {
    const idxs = [...ext.matchAll(/session\.scheduleNow\(\)/g)].map((m) => m.index ?? 0);
    expect(idxs.length).toBeGreaterThanOrEqual(2);
    for (const i of idxs) {
      expect(ext.slice(Math.max(0, i - 320), i)).toContain('isAutoSyncEnabled()');
    }
  });

  it('本地 store 变更写诊断日志（trigger/autoSync）', () => {
    expect(ext).toContain("diagInfo('sync trigger'");
    expect(ext).toContain("'store-change'");
    expect(ext).toContain("'focus'");
    expect(ext).toContain("'config-enable'");
  });

  it('每轮同步结果写诊断日志', () => {
    expect(ext).toContain("diagInfo('sync run'");
  });
});