import { describe, expect, it } from 'vitest';
import {
  canUseNativePicker,
  classifyTemporal,
  formatHintFor,
  inputTypeFor,
  toInputValue,
  toSqlValue,
  type TemporalKind,
} from '../../webview/src/utils/temporal';

describe('classifyTemporal', () => {
  it('识别仅日期类型', () => {
    expect(classifyTemporal('date')).toBe('date');
    expect(classifyTemporal('DATE')).toBe('date');
  });

  it('识别仅时间类型（含 PG 写法）', () => {
    expect(classifyTemporal('time')).toBe('time');
    expect(classifyTemporal('TIME')).toBe('time');
    expect(classifyTemporal('time(3)')).toBe('time');
    expect(classifyTemporal('time without time zone')).toBe('time');
    expect(classifyTemporal('time with time zone')).toBe('time');
    expect(classifyTemporal('timetz')).toBe('time');
  });

  it('识别日期时间类型', () => {
    expect(classifyTemporal('datetime')).toBe('datetime');
    expect(classifyTemporal('datetime(6)')).toBe('datetime');
    expect(classifyTemporal('timestamp')).toBe('datetime');
    expect(classifyTemporal('timestamptz')).toBe('datetime');
    expect(classifyTemporal('timestamp without time zone')).toBe('datetime');
    expect(classifyTemporal('timestamp with time zone')).toBe('datetime');
  });

  /**
   * 回归：旧实现用 `t.includes('time') && !t.includes('date')` 判 time，
   * `timestamp` 含 time 不含 date，被错判为「仅时间」。
   */
  it('timestamp 不会被误判为仅时间', () => {
    expect(classifyTemporal('timestamp')).not.toBe('time');
    expect(classifyTemporal('timestamptz')).not.toBe('time');
  });

  it('识别 year', () => {
    expect(classifyTemporal('year')).toBe('year');
    expect(classifyTemporal('year(4)')).toBe('year');
  });

  it('非时间类型返回 null', () => {
    for (const t of ['int', 'varchar(64)', 'text', 'json', 'decimal(10,2)', 'blob', 'enum(\'a\',\'b\')']) {
      expect(classifyTemporal(t)).toBeNull();
    }
  });

  it('空值返回 null', () => {
    expect(classifyTemporal(undefined)).toBeNull();
    expect(classifyTemporal(null)).toBeNull();
    expect(classifyTemporal('')).toBeNull();
  });

  it('PG 数组写法退化到首词', () => {
    expect(classifyTemporal('timestamp[]')).toBe('datetime');
    expect(classifyTemporal('date[]')).toBe('date');
  });
});

describe('inputTypeFor / formatHintFor', () => {
  const cases: Array<[TemporalKind, string, string]> = [
    ['date', 'date', 'yyyy-MM-dd'],
    ['time', 'time', 'HH:mm:ss'],
    ['datetime', 'datetime-local', 'yyyy-MM-dd HH:mm:ss'],
    ['year', 'number', 'yyyy'],
  ];

  for (const [kind, inputType, hint] of cases) {
    it(`${kind} → ${inputType} / ${hint}`, () => {
      expect(inputTypeFor(kind)).toBe(inputType);
      expect(formatHintFor(kind)).toBe(hint);
    });
  }
});

describe('toInputValue', () => {
  it('date 正常值', () => {
    expect(toInputValue('date', '2024-01-15')).toBe('2024-01-15');
  });

  it('date 零日期回退（原生控件无法表达 0000-00-00）', () => {
    expect(toInputValue('date', '0000-00-00')).toBeNull();
    expect(toInputValue('date', '2024-00-01')).toBeNull();
    expect(toInputValue('date', '2024-01-00')).toBeNull();
  });

  it('date 非法格式回退', () => {
    expect(toInputValue('date', 'not-a-date')).toBeNull();
    expect(toInputValue('date', '2024/01/15')).toBeNull();
    expect(toInputValue('date', '2024-01-15 10:00:00')).toBeNull();
  });

  /** 核心场景：TIME 列必须保留秒 */
  it('time 保留秒', () => {
    expect(toInputValue('time', '10:30:45')).toBe('10:30:45');
    expect(toInputValue('time', '00:00:00')).toBe('00:00:00');
    expect(toInputValue('time', '23:59:59')).toBe('23:59:59');
  });

  it('time 缺秒时补 00', () => {
    expect(toInputValue('time', '10:30')).toBe('10:30:00');
  });

  it('time 补齐小时前导零', () => {
    expect(toInputValue('time', '9:05:00')).toBe('09:05:00');
  });

  it('time 超范围/负值回退为文本（MySQL TIME 可达 838:59:59）', () => {
    expect(toInputValue('time', '838:59:59')).toBeNull();
    expect(toInputValue('time', '24:00:00')).toBeNull();
    expect(toInputValue('time', '-01:00:00')).toBeNull();
  });

  it('time 零小数秒可丢弃，非零小数秒回退', () => {
    expect(toInputValue('time', '10:30:45.000')).toBe('10:30:45');
    expect(toInputValue('time', '10:30:45.0')).toBe('10:30:45');
    expect(toInputValue('time', '10:30:45.123')).toBeNull();
  });

  it('datetime 保留秒并用 T 分隔', () => {
    expect(toInputValue('datetime', '2024-01-15 10:30:45')).toBe('2024-01-15T10:30:45');
    expect(toInputValue('datetime', '2024-01-15T10:30:45')).toBe('2024-01-15T10:30:45');
  });

  it('datetime 缺秒补 00', () => {
    expect(toInputValue('datetime', '2024-01-15 10:30')).toBe('2024-01-15T10:30:00');
  });

  it('datetime 零小数秒可丢弃，非零回退', () => {
    expect(toInputValue('datetime', '2024-01-15 10:30:45.000')).toBe('2024-01-15T10:30:45');
    expect(toInputValue('datetime', '2024-01-15 10:30:45.500')).toBeNull();
  });

  /** PG timestamptz 带偏移，datetime-local 承载不了，硬塞会改变时刻 */
  it('datetime 带时区偏移回退为文本', () => {
    expect(toInputValue('datetime', '2024-01-15 10:30:45+08')).toBeNull();
    expect(toInputValue('datetime', '2024-01-15T10:30:45Z')).toBeNull();
    expect(toInputValue('datetime', '2024-01-15 10:30:45-05:30')).toBeNull();
  });

  it('datetime 零日期回退', () => {
    expect(toInputValue('datetime', '0000-00-00 00:00:00')).toBeNull();
  });

  it('year 只接受 1-4 位数字', () => {
    expect(toInputValue('year', '2024')).toBe('2024');
    expect(toInputValue('year', '99')).toBe('99');
    expect(toInputValue('year', '20240')).toBeNull();
    expect(toInputValue('year', 'abc')).toBeNull();
  });

  it('空值/null/undefined 的处理', () => {
    expect(toInputValue('date', '')).toBe('');
    expect(toInputValue('time', '   ')).toBe('');
    expect(toInputValue('date', null)).toBeNull();
    expect(toInputValue('date', undefined)).toBeNull();
  });

  it('接受非字符串输入（驱动可能给 Date/number）', () => {
    expect(toInputValue('year', 2024)).toBe('2024');
  });
});

describe('toSqlValue', () => {
  it('date 原样输出', () => {
    expect(toSqlValue('date', '2024-01-15')).toBe('2024-01-15');
  });

  it('time 补齐秒', () => {
    expect(toSqlValue('time', '10:30')).toBe('10:30:00');
    expect(toSqlValue('time', '10:30:45')).toBe('10:30:45');
  });

  it('datetime 用空格分隔并补齐秒', () => {
    expect(toSqlValue('datetime', '2024-01-15T10:30')).toBe('2024-01-15 10:30:00');
    expect(toSqlValue('datetime', '2024-01-15T10:30:45')).toBe('2024-01-15 10:30:45');
  });

  it('year 原样输出', () => {
    expect(toSqlValue('year', '2024')).toBe('2024');
  });

  it('空串保持空串（由调用方决定是否写 NULL）', () => {
    for (const kind of ['date', 'time', 'datetime', 'year'] as TemporalKind[]) {
      expect(toSqlValue(kind, '')).toBe('');
      expect(toSqlValue(kind, '   ')).toBe('');
    }
  });
});

describe('往返转换', () => {
  const roundTrips: Array<[TemporalKind, string]> = [
    ['date', '2024-01-15'],
    ['time', '10:30:45'],
    ['time', '00:00:00'],
    ['time', '23:59:59'],
    ['datetime', '2024-01-15 10:30:45'],
    ['datetime', '2024-12-31 23:59:59'],
    ['year', '2024'],
  ];

  for (const [kind, value] of roundTrips) {
    it(`${kind}: ${value} 往返不变`, () => {
      const input = toInputValue(kind, value);
      expect(input).not.toBeNull();
      expect(toSqlValue(kind, input as string)).toBe(value);
    });
  }
});

describe('canUseNativePicker', () => {
  it('可表达的值返回 true', () => {
    expect(canUseNativePicker('time', '10:30:45')).toBe(true);
    expect(canUseNativePicker('datetime', '2024-01-15 10:30:45')).toBe(true);
    expect(canUseNativePicker('date', '2024-01-15')).toBe(true);
  });

  it('超出表达范围的值返回 false（走文本回退，原样保留）', () => {
    expect(canUseNativePicker('time', '838:59:59')).toBe(false);
    expect(canUseNativePicker('datetime', '2024-01-15 10:30:45+08')).toBe(false);
    expect(canUseNativePicker('date', '0000-00-00')).toBe(false);
    expect(canUseNativePicker('datetime', '2024-01-15 10:30:45.500')).toBe(false);
  });

  it('空值可用（新建行需要能直接选）', () => {
    expect(canUseNativePicker('date', '')).toBe(true);
  });

  it('NULL 走文本回退', () => {
    expect(canUseNativePicker('date', null)).toBe(false);
  });
});
