import { describe, expect, it } from 'vitest';
import { escapeRedisGlob, groupRedisKeyChildren, redisPrefixPattern, toRedisMatchPattern } from '../../src/result/redisKeyFold';

describe('toRedisMatchPattern（模糊=包含）', () => {
  it('普通子串两侧包 *', () => {
    expect(toRedisMatchPattern('user')).toBe('*user*');
  });

  it('glob 特殊字符被转义为字面', () => {
    expect(toRedisMatchPattern('a*b')).toBe('*a\\*b*');
    expect(toRedisMatchPattern('x?y')).toBe('*x\\?y*');
    expect(toRedisMatchPattern('a[b]c')).toBe('*a\\[b\\]c*');
  });

  it('空/纯空白 → undefined', () => {
    expect(toRedisMatchPattern('')).toBeUndefined();
    expect(toRedisMatchPattern('   ')).toBeUndefined();
  });

  it('首尾空白被修剪', () => {
    expect(toRedisMatchPattern('  user  ')).toBe('*user*');
  });
});

describe('escapeRedisGlob / redisPrefixPattern（glob 转义，防错查/错删）', () => {
  it('转义 glob 元字符为字面', () => {
    expect(escapeRedisGlob('a[1]*?\\^')).toBe('a\\[1\\]\\*\\?\\\\\\^');
    expect(escapeRedisGlob('plain')).toBe('plain');
  });

  it('前缀 pattern 转义后加分隔符 *', () => {
    expect(redisPrefixPattern('a[1]')).toBe('a\\[1\\]:*');
    expect(redisPrefixPattern('a[1]', '-')).toBe('a\\[1\\]-*');
    expect(redisPrefixPattern('user')).toBe('user:*');
  });

  it('含元字符前缀在 toRedisMatchPattern 中也被转义', () => {
    expect(toRedisMatchPattern('a[1]')).toBe('*a\\[1\\]*');
  });
});

describe('groupRedisKeyChildren（S5-3 树懒加载分组）', () => {
  it('根级：按首段拆文件夹，无分隔符为叶子', () => {
    const g = groupRedisKeyChildren(['standalone', 'user:1', 'user:2', 'cache:a']);
    expect(g.folders.map((f) => f.name)).toEqual(['cache', 'user']);
    expect(g.folders.find((f) => f.name === 'user')!.prefix).toBe('user');
    expect(g.keys).toEqual(['standalone']);
  });

  it('前缀下：相对拆分并给出绝对前缀', () => {
    const g = groupRedisKeyChildren(['a:b:c', 'a:b:d', 'a:e'], 'a');
    expect(g.folders.map((f) => f.name)).toEqual(['b']);
    expect(g.folders[0].prefix).toBe('a:b');
    expect(g.keys).toEqual(['a:e']);
  });

  it('排序稳定；空输入为空', () => {
    const g = groupRedisKeyChildren(['z:1', 'a:2', 'm']);
    expect(g.folders.map((f) => f.name)).toEqual(['a', 'z']);
    expect(g.keys).toEqual(['m']);
    expect(groupRedisKeyChildren([], '')).toEqual({ folders: [], keys: [] });
  });

  it('自定义分隔符', () => {
    const g = groupRedisKeyChildren(['a-b-c', 'a-d'], 'a', '-');
    expect(g.folders.map((f) => f.name)).toEqual(['b']);
    expect(g.folders[0].prefix).toBe('a-b');
    expect(g.keys).toEqual(['a-d']);
  });
});
