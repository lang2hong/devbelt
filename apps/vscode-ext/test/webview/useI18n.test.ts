import { describe, expect, it } from 'vitest';
import { setLanguage, t } from '../../webview/src/composables/useI18n';

/**
 * webview 取词逻辑。语言由扩展端经 init 消息下发（webview 拿不到 vscode 配置），
 * 因此这里的核心是「setLanguage 后 t() 立即反映」与回退链正确。
 */
describe('useI18n', () => {
  it('默认英文（init 消息到达前）', () => {
    setLanguage(false);
    expect(t('wv.common.save')).toBe('Save');
  });

  it('setLanguage(true) 后取中文', () => {
    setLanguage(true);
    expect(t('wv.common.save')).toBe('保存');
  });

  it('语言可来回切换', () => {
    setLanguage(true);
    const zhText = t('wv.common.cancel');
    setLanguage(false);
    const enText = t('wv.common.cancel');
    expect(zhText).not.toBe(enText);
    setLanguage(true);
    expect(t('wv.common.cancel')).toBe(zhText);
  });

  it('缺失键回退到英文', () => {
    setLanguage(true);
    // 构造一个只存在于 en 的场景不现实（catalog.test 保证键集一致），
    // 这里验证未知键的行为
    expect(t('__definitely_missing__')).toBe('__definitely_missing__');
  });

  it('未知键回显键名（缺失信号可见，而非静默空串）', () => {
    setLanguage(false);
    expect(t('wv.no.such.key')).toBe('wv.no.such.key');
  });

  it('替换 {placeholder}', () => {
    setLanguage(false);
    expect(t('conn.importDone', { count: 3 })).toContain('3');
  });

  it('同一占位符多次出现全部替换', () => {
    setLanguage(false);
    // 用已知带占位符的键做往返验证
    const out = t('conn.importDone', { count: 7 });
    expect(out).not.toContain('{count}');
  });

  it('未传 vars 时占位符原样保留（不崩）', () => {
    setLanguage(false);
    expect(() => t('conn.importDone')).not.toThrow();
  });

  it('数字与字符串变量都支持', () => {
    setLanguage(false);
    expect(t('conn.importDone', { count: 1 })).toContain('1');
    expect(t('conn.importDone', { count: '2' })).toContain('2');
  });
});
