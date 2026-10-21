import { describe, expect, it } from 'vitest';
import { buildSparklinePath, filterCommandLog, filterSlowlog, formatDurationMicros, isNearBottom, parseRedisInfoSections, pushCommandHistory, redisInfoValue } from '../../webview/src/components/redis/types';

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

describe('parseRedisInfoSections / redisInfoValue（ServerStatus）', () => {
  const info = [
    '# Server',
    'redis_version:7.2.0',
    'executable:/usr/bin/redis-server',
    '',
    '# Clients',
    'connected_clients:3',
    'global_clients:3',
    'uptime_in_seconds:3661',
  ].join('\n');

  it('按 # 分节并保留冒号后的完整值', () => {
    const sections = parseRedisInfoSections(info);
    expect(sections.map((s) => s.name)).toEqual(['Server', 'Clients']);
    expect(sections[0].rows[1]).toEqual(['executable', '/usr/bin/redis-server']);
    expect(sections[1].rows).toContainEqual(['uptime_in_seconds', '3661']);
  });

  it('跨节查找字段，缺失返回 null', () => {
    const sections = parseRedisInfoSections(info);
    expect(redisInfoValue(sections, 'connected_clients')).toBe('3');
    expect(redisInfoValue(sections, 'missing')).toBeNull();
  });
});

describe('filterSlowlog / formatDurationMicros（SlowLog）', () => {
  const entries = [
    { command: 'GET foo', clientAddr: '127.0.0.1:1', clientName: 'app' },
    { command: 'SET bar 1', clientAddr: '127.0.0.1:2', clientName: 'worker' },
  ];

  it('按命令或客户端过滤，空查询返回副本', () => {
    expect(filterSlowlog(entries, 'get')).toEqual([entries[0]]);
    expect(filterSlowlog(entries, 'worker')).toEqual([entries[1]]);
    expect(filterSlowlog(entries, '')).toEqual(entries);
    expect(filterSlowlog(entries, '')).not.toBe(entries);
  });

  it('微秒原值 + 毫秒可读值；非法值 —', () => {
    expect(formatDurationMicros(1234)).toBe('1,234 µs (1.23 ms)');
    expect(formatDurationMicros(0)).toBe('0 µs (0.00 ms)');
    expect(formatDurationMicros(Number.NaN)).toBe('—');
  });
});