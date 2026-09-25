import { describe, expect, it } from 'vitest';
import { connectionColorToken } from '../../src/utils/connectionColor';

describe('connectionColorToken', () => {
  it('按色相归一：红/绿/蓝/紫', () => {
    expect(connectionColorToken('#e15759')).toBe('charts.red');
    expect(connectionColorToken('#59a14f')).toBe('charts.green');
    expect(connectionColorToken('#4e79a7')).toBe('charts.blue');
    expect(connectionColorToken('#b07aa1')).toBe('charts.purple');
    expect(connectionColorToken('#f28e2b')).toBe('charts.orange');
    expect(connectionColorToken('#edc948')).toBe('charts.yellow');
  });

  it('无 # / 大小写皆可', () => {
    expect(connectionColorToken('e15759')).toBe('charts.red');
    expect(connectionColorToken('#E15759')).toBe('charts.red');
  });

  it('近灰 / 非法 / 缺省 → undefined', () => {
    expect(connectionColorToken('#888888')).toBeUndefined();
    expect(connectionColorToken('abc')).toBeUndefined();
    expect(connectionColorToken('')).toBeUndefined();
    expect(connectionColorToken(undefined)).toBeUndefined();
  });
});
