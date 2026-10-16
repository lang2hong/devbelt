import { describe, expect, it } from 'vitest';
import {
  BUSINESS_RULES_MAX_CHARS,
  parseBusinessRulesPayload,
  summarizeBusinessRules,
} from '../../src/ai/businessRules';

describe('parseBusinessRulesPayload（保存载荷校验/规整）', () => {
  it('两段字符串合法：裁剪首尾空白、统一换行', () => {
    expect(parseBusinessRulesPayload({ domainContext: '  GMV=已完成订单总额\r\n活跃=30天登录  ', defaultDirectives: '\n排除软删除\n' })).toEqual({
      domainContext: 'GMV=已完成订单总额\n活跃=30天登录',
      defaultDirectives: '排除软删除',
    });
  });

  it('空串合法（表示清除该段）', () => {
    expect(parseBusinessRulesPayload({ domainContext: '', defaultDirectives: '   ' })).toEqual({
      domainContext: '',
      defaultDirectives: '',
    });
  });

  it('超长按上限截断', () => {
    const out = parseBusinessRulesPayload({ domainContext: 'a'.repeat(BUSINESS_RULES_MAX_CHARS + 50), defaultDirectives: 'b' });
    expect(out!.domainContext).toHaveLength(BUSINESS_RULES_MAX_CHARS);
  });

  it('非对象 / 缺字段 / 非字符串 → undefined', () => {
    expect(parseBusinessRulesPayload(undefined)).toBeUndefined();
    expect(parseBusinessRulesPayload(null)).toBeUndefined();
    expect(parseBusinessRulesPayload('x')).toBeUndefined();
    expect(parseBusinessRulesPayload({ domainContext: 'a' })).toBeUndefined();
    expect(parseBusinessRulesPayload({ domainContext: 1, defaultDirectives: 'b' })).toBeUndefined();
    expect(parseBusinessRulesPayload({ domainContext: 'a', defaultDirectives: null })).toBeUndefined();
  });
});

describe('summarizeBusinessRules（侧栏状态摘要）', () => {
  it('统计两段字数；任一非空即 configured', () => {
    expect(summarizeBusinessRules('GMV=订单', '')).toEqual({ domainChars: 6, directivesChars: 0, configured: true });
    expect(summarizeBusinessRules('', '排除软删除')).toEqual({ domainChars: 0, directivesChars: 5, configured: true });
  });

  it('全空/纯空白 → 未配置', () => {
    expect(summarizeBusinessRules('', '  \n ')).toEqual({ domainChars: 0, directivesChars: 0, configured: false });
  });
});
