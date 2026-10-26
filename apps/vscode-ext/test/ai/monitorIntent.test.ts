import { describe, expect, it } from 'vitest';
import { wantsMonitorTask } from '../../src/ai/monitorIntent';

describe('monitor intent', () => {
  it('recognises monitoring requests in Chinese and English', () => {
    for (const text of [
      '监控 lc_rule_candidate 每分钟的新增行数',
      '帮我建一个后台任务，盯着 lc_batch',
      '每 10 分钟检查一次订单数，少于 50 提醒我',
      'monitor new rows of lc_data_event every minute',
      'watch new rows in lc_batch',
    ]) expect(wantsMonitorTask(text), text).toBe(true);
  });

  it('ignores ordinary questions', () => {
    for (const text of ['这条 SQL 为什么慢', '把 lc_batch 按 id 排序', '统计最近 24 小时的订单数', ''])
      expect(wantsMonitorTask(text), text).toBe(false);
  });
});
