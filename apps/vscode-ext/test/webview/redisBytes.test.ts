import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  bytesToAscii,
  bytesToBase64,
  bytesToHex,
  decodeUtf8,
  encodeUtf8,
  hexToBytes,
  hexToBytesLimited,
} from '../../webview/src/components/redis/bytes';

describe('redis 字节工具（二进制安全）', () => {
  it('base64 往返保留任意字节（含 0x00/0xff）', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x80, 0x41, 0x0a, 0x7f]);
    const b64 = bytesToBase64(bytes);
    expect(b64).toBe(Buffer.from(bytes).toString('base64'));
    expect([...base64ToBytes(b64)]).toEqual([...bytes]);
  });

  it('空数组 base64/hex 往返', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('');
    expect([...base64ToBytes('')]).toEqual([]);
    expect(bytesToHex(new Uint8Array())).toBe('');
    expect([...hexToBytes('')]).toEqual([]);
  });

  it('hex 往返（空白分隔，两位补零）', () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xa5, 0xff]);
    expect(bytesToHex(bytes)).toBe('00 0f a5 ff');
    expect([...hexToBytes('00 0f a5 ff')]).toEqual([...bytes]);
    // 大写与单位 token 也接受
    expect([...hexToBytes('A5 f')]).toEqual([0xa5, 0x0f]);
  });

  it('非法 hex 抛错（保存前校验）', () => {
    expect(() => hexToBytes('zz')).toThrow(/invalid hex/);
    expect(() => hexToBytes('0f 123')).toThrow(/invalid hex/);
  });

  it('hexToBytesLimited：小输入不截断且等效 hexToBytes', () => {
    const hex = '00 0f a5 ff 10';
    const lim = hexToBytesLimited(hex, 1024);
    expect(lim.truncated).toBe(false);
    expect([...lim.bytes]).toEqual([...hexToBytes(hex)]);
  });

  it('hexToBytesLimited：超过上限即截断，长度等于上限且边界 token 完整', () => {
    const hex = Array.from({ length: 100 }, (_, i) => (i % 256).toString(16).padStart(2, '0')).join(' ');
    const lim = hexToBytesLimited(hex, 10);
    expect(lim.truncated).toBe(true);
    expect(lim.bytes.length).toBe(10);
    expect([...lim.bytes]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('hexToBytesLimited：恰好等于上限不截断；空输入为空', () => {
    expect(hexToBytesLimited('00 01 02', 3)).toEqual({ bytes: new Uint8Array([0, 1, 2]), truncated: false });
    const empty = hexToBytesLimited('', 10);
    expect(empty.bytes.length).toBe(0);
    expect(empty.truncated).toBe(false);
  });

  it('hexToBytesLimited：上限之外不校验非法 token（预览容错）', () => {
    const lim = hexToBytesLimited('00 zz', 1);
    expect(lim.truncated).toBe(true);
    expect([...lim.bytes]).toEqual([0]);
  });

  it('ASCII 预览：可打印原样，其余占位', () => {
    expect(bytesToAscii(new Uint8Array([0x41, 0x00, 0x0a, 0x7f, 0x20]))).toBe('A... ');
  });

  it('UTF-8 编解码：合法文本无损，非法字节有损占位', () => {
    const text = '中文abc';
    expect(decodeUtf8(encodeUtf8(text))).toBe(text);
    expect(decodeUtf8(new Uint8Array([0xff, 0x41]))).toContain('A');
  });
});