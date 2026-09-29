import { describe, expect, it } from 'vitest';
import { splitRedisArgs } from '../../src/redis/redisSplitArgs';

describe('splitRedisArgs（移植 ARDM splitargs 语义）', () => {
  it('空行/纯空白返回空数组', () => {
    expect(splitRedisArgs('')).toEqual([]);
    expect(splitRedisArgs('   \t  ')).toEqual([]);
  });

  it('按空白切分基本命令（含上游 isspace 的 \\v/\\f）', () => {
    expect(splitRedisArgs('SET foo bar')).toEqual(['SET', 'foo', 'bar']);
    expect(splitRedisArgs('  PING  ')).toEqual(['PING']);
    expect(splitRedisArgs('SET\tfoo\nbar')).toEqual(['SET', 'foo', 'bar']);
    expect(splitRedisArgs('a\vb')).toEqual(['a', 'b']);
    expect(splitRedisArgs('a\fb')).toEqual(['a', 'b']);
  });

  it('双引号保留内部空白', () => {
    expect(splitRedisArgs('SET k "hello world"')).toEqual(['SET', 'k', 'hello world']);
  });

  it('双引号内转义序列', () => {
    expect(splitRedisArgs('SET k "a\\nb"')).toEqual(['SET', 'k', 'a\nb']);
    expect(splitRedisArgs('SET k "a\\tb"')).toEqual(['SET', 'k', 'a\tb']);
    expect(splitRedisArgs('SET k "a\\"b"')).toEqual(['SET', 'k', 'a"b']);
  });

  it('双引号内 \\xHH hex', () => {
    expect(splitRedisArgs('SET k "\\x41"')).toEqual(['SET', 'k', 'A']);
    expect(splitRedisArgs('SET k "\\xzz"')).toEqual(['SET', 'k', 'xzz']);
  });

  it('\\xHH 单字节按码点解码（>=0x80 不再是替换符）', () => {
    const [, , v] = splitRedisArgs('SET k "\\xE4"');
    expect(v).toBe(String.fromCharCode(0xE4));
    expect(v).not.toContain('\uFFFD');
  });

  it("单引号内 \\' 为字面单引号", () => {
    expect(splitRedisArgs("SET k 'it\\'s'")).toEqual(['SET', 'k', "it's"]);
    expect(splitRedisArgs("SET k 'a b'")).toEqual(['SET', 'k', 'a b']);
  });

  it('未闭合引号抛错', () => {
    expect(() => splitRedisArgs('SET k "abc')).toThrow(/Unterminated/);
    expect(() => splitRedisArgs("SET k 'abc")).toThrow(/Unterminated/);
  });

  it('闭合引号后必须跟空白或行尾', () => {
    expect(() => splitRedisArgs('SET k "a"b')).toThrow(/followed by a space/);
    expect(() => splitRedisArgs("SET k 'a'b")).toThrow(/followed by a space/);
  });

  it('引号可与未加引号片段相连', () => {
    expect(splitRedisArgs('SET k ab"c d"')).toEqual(['SET', 'k', 'abc d']);
  });
});
