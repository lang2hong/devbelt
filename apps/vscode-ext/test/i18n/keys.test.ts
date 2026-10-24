import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { zh } from '../../src/i18n/catalog';

const SRC = path.resolve(__dirname, '../../src');
const NLS = path.resolve(__dirname, '../../package.nls.json');
const NLS_ZH = path.resolve(__dirname, '../../package.nls.zh-cn.json');

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('i18n keys', () => {
  it('every literal l10n key used in source exists in the catalog', async () => {
    const missing: string[] = [];
    for (const file of await walk(SRC)) {
      const text = await fs.readFile(file, 'utf8');
      for (const m of text.matchAll(/\bl10n\(\s*['"]([^'"]+)['"]/g)) {
        if (!(m[1]! in zh)) missing.push(`${path.relative(SRC, file)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('package.nls.json and package.nls.zh-cn.json have the same keys', async () => {
    const en = JSON.parse(await fs.readFile(NLS, 'utf8')) as Record<string, string>;
    const cn = JSON.parse(await fs.readFile(NLS_ZH, 'utf8')) as Record<string, string>;
    expect(Object.keys(cn).sort()).toEqual(Object.keys(en).sort());
  });

  it('command titles referenced by package.json exist in both nls files', async () => {
    const pkg = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { commands: Array<{ title: string }> };
    };
    const en = JSON.parse(await fs.readFile(NLS, 'utf8')) as Record<string, string>;
    const cn = JSON.parse(await fs.readFile(NLS_ZH, 'utf8')) as Record<string, string>;
    for (const command of pkg.contributes.commands) {
      const m = /^%(.+)%$/.exec(command.title);
      if (!m) continue;
      expect(en[m[1]!], m[1]).toBeTruthy();
      expect(cn[m[1]!], m[1]).toBeTruthy();
    }
  });
});