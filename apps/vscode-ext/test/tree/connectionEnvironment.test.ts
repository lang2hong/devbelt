import { describe, expect, it } from 'vitest';
import { connectionEnvironmentLabel } from '../../src/tree/connectionEnvironment';

describe('connectionEnvironmentLabel', () => {
  it('四种环境映射到小写短标签', () => {
    expect(connectionEnvironmentLabel('development')).toBe('dev');
    expect(connectionEnvironmentLabel('test')).toBe('test');
    expect(connectionEnvironmentLabel('staging')).toBe('stage');
    expect(connectionEnvironmentLabel('production')).toBe('prod');
  });

  it('兼容历史数据里的 dev', () => {
    expect(connectionEnvironmentLabel('dev')).toBe('dev');
  });

  it('缺失或未知环境不显示标签', () => {
    expect(connectionEnvironmentLabel(undefined)).toBeUndefined();
    expect(connectionEnvironmentLabel('')).toBeUndefined();
    expect(connectionEnvironmentLabel('staging2')).toBeUndefined();
  });
});