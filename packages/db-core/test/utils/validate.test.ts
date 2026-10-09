import { describe, expect, it } from 'vitest';
import { validateIdent, validateSchemaIdent } from '../../src/utils/validate';

describe('validateIdent — 放行', () => {
  it('接受 ASCII 标识符并原样返回', () => {
    expect(validateIdent('users')).toBe('users');
    expect(validateIdent('user_name')).toBe('user_name');
    expect(validateIdent('_private')).toBe('_private');
    expect(validateIdent('$dollar')).toBe('$dollar');
    expect(validateIdent('t1')).toBe('t1');
    expect(validateIdent('MixedCase99')).toBe('MixedCase99');
  });

  it('接受非 ASCII 标识符（中文/日文表名在 MySQL、PG 均合法）', () => {
    expect(validateIdent('用户表')).toBe('用户表');
    expect(validateIdent('订单_2026')).toBe('订单_2026');
    expect(validateIdent('ユーザー')).toBe('ユーザー');
    expect(validateIdent('naïve')).toBe('naïve');
    expect(validateIdent('Ünïcodé')).toBe('Ünïcodé');
    expect(validateIdent('таблица')).toBe('таблица');
  });

  it('接受连字符标识符（库里既存对象名）', () => {
    expect(validateIdent('happy-crewman')).toBe('happy-crewman');
    expect(validateIdent('user_1-v2')).toBe('user_1-v2');
  });

  it('接受长度正好 64 的标识符', () => {
    const name = 'a'.repeat(64);
    expect(validateIdent(name)).toBe(name);
  });
});

describe('validateIdent — 拒绝注入相关字符', () => {
  const injectionCases: Array<[string, string]> = [
    ['单引号', "users'"],
    ['双引号', 'users"'],
    ['反引号', 'users`'],
    ['分号', 'users;'],
    ['空格', 'user table'],
    ['制表符', 'user\ttable'],
    ['换行', 'users\nDROP TABLE x'],
    ['行注释', 'users--'],
    ['块注释开', 'users/*'],
    ['块注释闭', 'users*/'],
    ['括号', 'count(1)'],
    ['逗号', 'a,b'],
    ['点号（应由调用方拆分库名与表名）', 'db.users'],
    ['星号', '*'],
    ['等号', 'a=1'],
    ['反斜杠', 'users\\'],
    ['百分号', 'a%'],
    ['经典注入串', "x'; DROP TABLE users; --"],
    ['UNION 注入', '1 UNION SELECT 1'],
    ['NUL 字节', 'users\u0000'],
  ];

  for (const [label, value] of injectionCases) {
    it(`拒绝${label}`, () => {
      expect(() => validateIdent(value)).toThrow('Invalid SQL identifier');
    });
  }
});

describe('validateIdent — 其他边界', () => {
  it('拒绝空字符串', () => {
    expect(() => validateIdent('')).toThrow('Invalid SQL identifier');
  });

  it('拒绝以数字开头', () => {
    expect(() => validateIdent('1users')).toThrow('Invalid SQL identifier');
    expect(() => validateIdent('9')).toThrow('Invalid SQL identifier');
  });

  it('允许非首位出现数字（含全角数字属于 \\p{N}）', () => {
    expect(validateIdent('t2026')).toBe('t2026');
    expect(validateIdent('表１')).toBe('表１');
  });

  it('拒绝超过 64 长度，报的是长度错误而非格式错误', () => {
    expect(() => validateIdent('a'.repeat(65))).toThrow('SQL identifier too long');
  });

  it('PG 上限 63：validateIdent(name, 63) 拒绝 64 字符、放行 63 字符', () => {
    expect(() => validateIdent('a'.repeat(64), 63)).toThrow('SQL identifier too long');
    expect(validateIdent('a'.repeat(63), 63)).toBe('a'.repeat(63));
  });

  it('拒绝纯 emoji（不属于 \\p{L}）', () => {
    expect(() => validateIdent('🔥')).toThrow('Invalid SQL identifier');
  });
});

describe('validateSchemaIdent — 放宽 schema 名（A6）', () => {
  it('放行含空格/点/引号/连字符的合法 schema 名', () => {
    expect(validateSchemaIdent('public')).toBe('public');
    expect(validateSchemaIdent('my schema')).toBe('my schema');
    expect(validateSchemaIdent('tenant.v2')).toBe('tenant.v2');
    expect(validateSchemaIdent('we"ird')).toBe('we"ird');
    expect(validateSchemaIdent("o'brien")).toBe("o'brien");
    expect(validateSchemaIdent('happy-crewman')).toBe('happy-crewman');
    expect(validateSchemaIdent('用户 schema')).toBe('用户 schema');
  });

  it('仍拒绝控制字符（引用层无法安全承载）', () => {
    expect(() => validateSchemaIdent('')).toThrow('Invalid SQL schema identifier');
    expect(() => validateSchemaIdent('a\u0000b')).toThrow('Invalid SQL schema identifier');
    expect(() => validateSchemaIdent('a\nb')).toThrow('Invalid SQL schema identifier');
    expect(() => validateSchemaIdent('a\tb')).toThrow('Invalid SQL schema identifier');
  });

  it('保留长度上限（PG 63）', () => {
    expect(() => validateSchemaIdent('a'.repeat(64), 63)).toThrow('SQL schema identifier too long');
    const exactly63 = 'a'.repeat(62) + ' ';
    expect(validateSchemaIdent(exactly63, 63)).toBe(exactly63);
  });
});
