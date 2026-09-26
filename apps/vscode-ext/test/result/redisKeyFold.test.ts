import { describe, expect, it } from 'vitest';
import { foldRedisKeys, toRedisMatchPattern } from '../../src/result/redisKeyFold';

describe('foldRedisKeys', () => {
  it('无分隔符 key 作为根叶子', () => {
    const tree = foldRedisKeys(['alpha', 'beta']);
    expect(tree.keys).toEqual(['alpha', 'beta']);
    expect(tree.folders).toEqual([]);
    expect(tree.count).toBe(2);
  });

  it('一层折叠与计数', () => {
    const tree = foldRedisKeys(['user:1', 'user:2', 'cache:x']);
    expect(tree.keys).toEqual([]);
    const names = tree.folders.map((f) => f.name);
    expect(names).toEqual(['cache', 'user']);
    const user = tree.folders.find((f) => f.name === 'user')!;
    expect(user.count).toBe(2);
    expect(user.keys).toEqual(['user:1', 'user:2']);
    expect(user.path).toBe('user');
  });

  it('多层嵌套与递归计数', () => {
    const tree = foldRedisKeys(['a:b:c', 'a:b:d', 'a:e']);
    const a = tree.folders.find((f) => f.name === 'a')!;
    expect(a.count).toBe(3);
    const b = a.folders.find((f) => f.name === 'b')!;
    expect(b.path).toBe('a:b');
    expect(b.count).toBe(2);
    expect(b.keys).toEqual(['a:b:c', 'a:b:d']);
    expect(a.keys).toEqual(['a:e']);
  });

  it('混合：根叶子 + 文件夹', () => {
    const tree = foldRedisKeys(['standalone', 'user:1']);
    expect(tree.keys).toEqual(['standalone']);
    expect(tree.folders.map((f) => f.name)).toEqual(['user']);
    expect(tree.count).toBe(2);
  });

  it('去重', () => {
    const tree = foldRedisKeys(['user:1', 'user:1']);
    expect(tree.count).toBe(1);
    expect(tree.folders[0].keys).toEqual(['user:1']);
  });

  it('自定义分隔符；空分隔符不折叠', () => {
    const tree = foldRedisKeys(['a-b', 'a-c'], '-');
    expect(tree.folders[0].name).toBe('a');
    const flat = foldRedisKeys(['user:1', 'user:2'], '');
    expect(flat.keys).toEqual(['user:1', 'user:2']);
    expect(flat.folders).toEqual([]);
  });

  it('排序稳定（文件夹与叶子各自升序）', () => {
    const tree = foldRedisKeys(['z:1', 'a:2', 'm:3']);
    expect(tree.folders.map((f) => f.name)).toEqual(['a', 'm', 'z']);
  });
});

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
