import { describe, expect, it } from 'vitest';
import { syncKindLabel } from './syncLabels';

describe('syncKindLabel', () => {
  it('映射当前协议类型', () => {
    expect(syncKindLabel('connection')).toBe('数据库连接');
    expect(syncKindLabel('authenticatorEntry')).toBe('验证器条目');
    expect(syncKindLabel('schemaNotes')).toBe('表结构备注');
    expect(syncKindLabel('aiModelAccess')).toBe('AI 模型配置');
  });

  it('兼容历史类名', () => {
    expect(syncKindLabel('SavedConnection')).toBe('数据库连接');
    expect(syncKindLabel('SavedQuery')).toBe('保存查询');
  });

  it('空值与未知值有明确兜底', () => {
    expect(syncKindLabel(null)).toBe('历史记录（类型未标注）');
    expect(syncKindLabel(undefined)).toBe('历史记录（类型未标注）');
    expect(syncKindLabel('futureKind')).toBe('其他类型（futureKind）');
  });
});