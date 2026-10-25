import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface MenuEntry { command?: string; submenu?: string; when?: string; group?: string }

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string }[];
    submenus?: { id: string; label: string }[];
    menus: Record<string, MenuEntry[]>;
  };
};
const declared = new Set(pkg.contributes.commands.map((c) => c.command));
const menus = pkg.contributes.menus;
const context = menus['view/item/context'] ?? [];

describe('树右键菜单分组', () => {
  it('所有 submenu 引用都有定义且非空', () => {
    const defined = new Map((pkg.contributes.submenus ?? []).map((s) => [s.id, s]));
    const referenced = context.map((e) => e.submenu).filter((s): s is string => !!s);
    expect(referenced.length).toBeGreaterThan(0);
    for (const id of referenced) {
      expect(defined.has(id), `未定义 submenu: ${id}`).toBe(true);
      expect((menus[id] ?? []).length, `空 submenu: ${id}`).toBeGreaterThan(0);
    }
  });

  it('子菜单里的命令都已声明，且保留 when 条件', () => {
    for (const s of pkg.contributes.submenus ?? []) {
      const items = menus[s.id] ?? [];
      for (const e of items) {
        expect(e.command && declared.has(e.command), `未声明命令: ${e.command}`).toBe(true);
        expect(e.when, `${e.command} 缺 when`).toBeTruthy();
      }
    }
  });

  it('连接/表/数据库的高级操作已进入对应子菜单', () => {
    const has = (menu: string, cmd: string): boolean => (menus[menu] ?? []).some((e) => e.command === cmd);
    expect(has('devbelt.connectionManage', 'devbelt.cloneConnection')).toBe(true);
    expect(has('devbelt.connectionManage', 'devbelt.deleteConnection')).toBe(true);
    expect(has('devbelt.connectionManage', 'devbelt.refreshConnection')).toBe(false);
    expect(context.some((e) => e.command === 'devbelt.refreshConnection' && e.group === 'inline')).toBe(true);
    expect(context.some((e) => e.command === 'devbelt.copyNodeName' && e.group === 'inline')).toBe(true);
    expect(has('devbelt.connectionTools', 'devbelt.importData')).toBe(true);
    expect(has('devbelt.connectionTools', 'devbelt.manageUsers')).toBe(true);
    expect(has('devbelt.tableStructure', 'devbelt.addColumn')).toBe(true);
    expect(has('devbelt.tableMore', 'devbelt.truncateTable')).toBe(true);
    expect(has('devbelt.databaseData', 'devbelt.restoreDatabase')).toBe(true);
    expect(has('devbelt.databaseData', 'devbelt.syncDatabase')).toBe(true);
  });

  it('侧栏标题栏有 AI 对话图标入口', () => {
    const title = menus['view/title'] ?? [];
    const entry = title.find((e) => e.command === 'devbelt.ai.chat');
    expect(entry, 'view/title 缺 devbelt.ai.chat').toBeTruthy();
    expect(entry!.when).toContain('view == devbelt.explorer');
    const pkgCommands = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
      contributes: { commands: { command: string; icon?: string }[] };
    };
    const command = pkgCommands.contributes.commands.find((c) => c.command === 'devbelt.ai.chat');
    expect(command?.icon, '命令需要 codicon 才能作为标题栏图标').toBeTruthy();
  });
});
