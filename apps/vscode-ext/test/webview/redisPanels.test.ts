import { describe, expect, it } from 'vitest';
import { buildSparklinePath, filterCommandLog, isNearBottom, pushCommandHistory } from '../../webview/src/components/redis/types';

describe('pushCommandHistory（Console 命令历史）', () => {
  it('忽略空白与连续重复，按时间正序保留最近 N 条', () => {
    let h: string[] = [];
    h = pushCommandHistory(h, 'PING');
    h = pushCommandHistory(h, 'PING');
    h = pushCommandHistory(h, '  GET foo  ');
    h = pushCommandHistory(h, ' ', 2);
    h = pushCommandHistory(h, 'INFO', 2);
    expect(h).toEqual(['GET foo', 'INFO']);
  });
});

describe('isNearBottom（自动跟随阈值）', () => {
  it('距底部 24px 内视为接近底部', () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 80 })).toBe(true);
    expect(isNearBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 80 })).toBe(false);
  });
});

describe('filterCommandLog（命令日志过滤）', () => {
  const entries = [
    { command: 'GET', args: ['foo'], ok: true, error: null },
    { command: 'SET', args: ['bar', '1'], ok: false, error: 'READONLY' },
  ];

  it('按命令/参数/错误文本过滤', () => {
    expect(filterCommandLog(entries, 'readonly', false)).toHaveLength(1);
    expect(filterCommandLog(entries, 'foo', false)[0].command).toBe('GET');
  });

  it('只看失败', () => {
    expect(filterCommandLog(entries, '', true)).toEqual([entries[1]]);
  });
});

describe('buildSparklinePath（空值断点）', () => {
  it('普通两点生成路径', () => {
    expect(buildSparklinePath([1, 2], 100, 28)).toBe('M0.00,28.00 L100.00,0.00');
  });

  it('空值处断线，不把 null 画成 0', () => {
    const path = buildSparklinePath([1, null, 2, 3], 100, 28);
    expect(path).not.toContain('NaN');
    expect(path.startsWith('M66.67,14.00')).toBe(true);
  });

  it('无足够有效点时不生成路径', () => {
    expect(buildSparklinePath([null, null], 100, 28)).toBe('');
    expect(buildSparklinePath([1], 100, 28)).toBe('');
  });
});