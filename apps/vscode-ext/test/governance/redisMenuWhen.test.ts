import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const menus: Array<{ command: string; when?: string }> = pkg?.contributes?.menus?.['view/item/context'] ?? [];
const commands: Array<{ command: string }> = pkg?.contributes?.commands ?? [];

/**
 * P7 S2：连接节点的 SQL-only when 必须显式限定引擎，否则会误命中 Redis 连接节点；
 * Redis 专属命令必须存在对应菜单项。
 */
describe('Redis 菜单 when 收紧（P7 S2）', () => {
  it('不存在未限定引擎的 connectionOpen/connectionClosed 宽匹配', () => {
    const wide = menus.filter((m) => m.when && /connection(Open|Closed)\\.\/(?!\()/.test(m.when));
    expect(wide.map((m) => m.command)).toEqual([]);
  });

  it('Redis 专属命令已声明且有 connectionOpen.REDIS 菜单项', () => {
    const declared = new Set(commands.map((c) => c.command));
    for (const cmd of ['devbelt.redis.serverStatus', 'devbelt.redis.console', 'devbelt.redis.slowlog', 'devbelt.redis.commandLog']) {
      expect(declared.has(cmd)).toBe(true);
      expect(menus.some((m) => m.command === cmd && m.when?.includes('connectionOpen.REDIS'))).toBe(true);
    }
    // 键浏览器经 DB 节点入口（S5）。
    expect(declared.has('devbelt.redis.keyBrowser')).toBe(true);
    expect(menus.some((m) => m.command === 'devbelt.redis.keyBrowser' && m.when?.includes('redisDb.REDIS'))).toBe(true);
  });

  it('连接表单 dbType 下拉含 Redis 选项（否则 Redis 表单段不可达）', () => {
    const vue = readFileSync(join(process.cwd(), 'webview/src/views/ConnectionFormView.vue'), 'utf8');
    expect(vue).toMatch(/<option value="REDIS"/);
  });

  it('Redis 逻辑库节点有键浏览器/刷新/复制菜单', () => {
    for (const cmd of ['devbelt.redis.keyBrowser', 'devbelt.refreshNode', 'devbelt.copyNodeName']) {
      expect(menus.some((m) => m.command === cmd && m.when?.includes('redisDb.REDIS'))).toBe(true);
    }
  });

  it('通用连接命令（打开/关闭/刷新）对 REDIS 可见', () => {
    for (const cmd of ['devbelt.openConnection', 'devbelt.closeConnection', 'devbelt.refreshConnection']) {
      const entry = menus.find((m) => m.command === cmd && m.when?.includes('REDIS'));
      expect(entry, cmd).toBeTruthy();
    }
  });
});
