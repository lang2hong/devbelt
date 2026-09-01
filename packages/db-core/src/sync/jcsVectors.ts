/**
 * JCS（RFC 8785 风格）共享测试向量 —— 单一源。
 *
 * 服务端 `syncCrypto.jcs` 与服务端扩展端 `crypto/jcs` 双向断言到同一 `expected`，
 * 禁止各包各拷一份（拷贝必然漂移）。域外值两侧必须同样拒绝或同样归一。
 *
 * 服务端实现（packages/server/src/service/syncCrypto.ts:jcs）是权威：排序键 +
 * `JSON.stringify` 字符串转义 + `String(number)` 数字输出 + `-0 → "0"` + 拒绝非有限数。
 */

export interface JcsVector {
  name: string;
  value: unknown;
  expected: string;
}

/** 合法 DTO 域内向量（域内仅 null/bool/整数(number)/字符串/数组/对象）。 */
export const JCS_VECTORS: JcsVector[] = [
  { name: 'empty object', value: {}, expected: '{}' },
  { name: 'null', value: { a: null }, expected: '{"a":null}' },
  { name: 'boolean', value: { a: true, b: false }, expected: '{"a":true,"b":false}' },
  { name: '整数 + 键排序', value: { z: 0, a: 1, m: 2 }, expected: '{"a":1,"m":2,"z":0}' },
  { name: '负整数', value: { n: -5 }, expected: '{"n":-5}' },
  { name: '字符串（引号 + 反斜杠转义）', value: { s: 'a"b\\c' }, expected: '{"s":"a\\"b\\\\c"}' },
  { name: '控制字符', value: { s: '\u0000\n' }, expected: '{"s":"\\u0000\\n"}' },
  { name: 'BMP Unicode', value: { s: '中文' }, expected: '{"s":"中文"}' },
  { name: '代理对字符', value: { s: '😀' }, expected: '{"s":"😀"}' },
  { name: '嵌套对象 + 数组', value: { a: { b: [1, 2, { c: 3 }] } }, expected: '{"a":{"b":[1,2,{"c":3}]}}' },
  { name: '嵌套键排序', value: { b: 2, a: { d: 4, c: 3 } }, expected: '{"a":{"c":3,"d":4},"b":2}' },
  {
    name: 'signingInput record.put 结构',
    value: {
      domain: 'dbclient/sync/v1',
      action: 'record.put',
      userId: '7',
      keyEpoch: '1',
      recordId: 'rcid',
      baseVersion: '0',
      mutationId: 'AAAAAAAAAAAAAAAAAAAAAA',
      requestDigest: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
    expected:
      '{"action":"record.put","baseVersion":"0","domain":"dbclient/sync/v1","keyEpoch":"1","mutationId":"AAAAAAAAAAAAAAAAAAAAAA","recordId":"rcid","requestDigest":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","userId":"7"}',
  },
  {
    name: 'signingInput state.change-key 结构',
    value: {
      domain: 'dbclient/sync/v1',
      action: 'state.change-key',
      userId: '7',
      keyEpoch: '1',
      expectedStateVersion: '3',
      mutationId: 'AAAAAAAAAAAAAAAAAAAAAA',
      requestDigest: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
    expected:
      '{"action":"state.change-key","domain":"dbclient/sync/v1","expectedStateVersion":"3","keyEpoch":"1","mutationId":"AAAAAAAAAAAAAAAAAAAAAA","requestDigest":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","userId":"7"}',
  },
];

/** 域外值：被 jcs 正常归一化的输入。两侧必须同样归一，不得一侧抛错一侧放行。 */
export const NORMALIZED_JCS_VECTORS: JcsVector[] = [
  { name: '负零归一为 0', value: { x: -0 }, expected: '{"x":0}' },
  { name: '浮点按 String(number) 输出', value: { x: 1.5 }, expected: '{"x":1.5}' },
];

/** 域外值：必须被 jcs 拒绝（非有限数）。 */
export const INVALID_JCS_VALUES: Array<{ name: string; value: unknown }> = [
  { name: 'NaN', value: { x: Number.NaN } },
  { name: 'Infinity', value: { x: Number.POSITIVE_INFINITY } },
  { name: '-Infinity', value: { x: Number.NEGATIVE_INFINITY } },
];