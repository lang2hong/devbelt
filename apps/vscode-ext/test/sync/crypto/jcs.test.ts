import { describe, expect, it } from 'vitest';
import { jcs } from '@devkit/db-host/sync/crypto/jcs';
import { INVALID_JCS_VALUES, JCS_VECTORS, NORMALIZED_JCS_VECTORS } from '@devkit/db-core/testing';

describe('jcs（镜像服务端，共享向量双向锚定）', () => {
  it.each(JCS_VECTORS)('$name', ({ value, expected }) => {
    expect(jcs(value)).toBe(expected);
  });

  it.each(NORMALIZED_JCS_VECTORS)('$name（域外归一，与服务端一致）', ({ value, expected }) => {
    expect(jcs(value)).toBe(expected);
  });

  it.each(INVALID_JCS_VALUES)('$name（非有限拒绝，与服务端一致）', ({ value }) => {
    expect(() => jcs(value)).toThrow(/non-finite/);
  });
});