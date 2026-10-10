import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PKG = join(__dirname, '../../package.json');
const ZH = join(__dirname, '../../src/i18n/catalog.zh.ts');
const EN = join(__dirname, '../../src/i18n/catalog.en.ts');

/**
 * P7.1 治理门禁（4A）：PG 跨 schema 同步必须**默认关闭**（fail-closed）。
 *
 * 启用前置链 = 表达式移植层/结构 diff 重构（4B）完成 + D28 真库回归全绿；
 * 本测试机械钉住「默认 false + 菜单受 config 门控 + 门禁文案齐备」，
 * 防止后续把实验功能误设为默认开启。
 */
describe('PG 跨 schema 同步默认门禁（4A 治理）', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as {
    contributes: {
      configuration: { properties: Record<string, { type?: string; default?: unknown }> };
      menus: Record<string, { command?: string; when?: string }[]>;
    };
  };

  it('devbelt.pg.syncEnabled 默认 false', () => {
    const prop = pkg.contributes.configuration.properties['devbelt.pg.syncEnabled'];
    expect(prop?.type).toBe('boolean');
    expect(prop?.default).toBe(false);
  });

  it('schema 节点上的 devbelt.syncDatabase 菜单受 config.devbelt.pg.syncEnabled 门控', () => {
    const menus = pkg.contributes.menus['view/item/context'] ?? [];
    const pgEntry = menus.find(
      (m) => m.command === 'devbelt.syncDatabase' && String(m.when).includes('config.devbelt.pg.syncEnabled'),
    );
    expect(pgEntry).toBeTruthy();
    expect(String(pgEntry!.when)).toContain('schema');
  });

  it('门禁文案中英齐备（sync.pgDisabled）', () => {
    expect(readFileSync(ZH, 'utf8')).toContain("'sync.pgDisabled'");
    expect(readFileSync(EN, 'utf8')).toContain("'sync.pgDisabled'");
  });
});