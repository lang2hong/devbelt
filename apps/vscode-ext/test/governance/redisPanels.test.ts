import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PANELS = ['keyBrowser', 'serverStatus', 'console', 'slowlog', 'commandLog'] as const;
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const menus: Array<{ command: string; when?: string }> = pkg?.contributes?.menus?.['view/item/context'] ?? [];
const viewCommands = readFileSync(join(process.cwd(), 'src/commands/viewCommands.ts'), 'utf8');
const vue = readFileSync(join(process.cwd(), 'webview/src/views/RedisView.vue'), 'utf8');

/**
 * S5 面板拆分机械断言（源自 P7 教训：host 全绿但 webview 分支不可达）。
 * 每个面板必须：有命令注册点、有树菜单入口、webview 有渲染分支。
 */
describe('Redis S5 面板可达性', () => {
  it('每个面板都有 RedisView.open 注册点', () => {
    for (const p of PANELS) {
      expect(viewCommands, `缺少 open: ${p}`).toContain(`manager, '${p}'`);
    }
  });

  it('每个面板都有树菜单入口（连接节点或 DB 节点）', () => {
    const byPanel: Record<string, string> = {
      keyBrowser: 'devbelt.redis.keyBrowser',
      serverStatus: 'devbelt.redis.serverStatus',
      console: 'devbelt.redis.console',
      slowlog: 'devbelt.redis.slowlog',
      commandLog: 'devbelt.redis.commandLog',
    };
    for (const p of PANELS) {
      const cmd = byPanel[p];
      expect(menus.some((m) => m.command === cmd && m.when?.includes('REDIS')), `缺少菜单: ${p}`).toBe(true);
    }
  });

  it('webview 对每个面板有渲染分支', () => {
    expect(vue).toContain('isKeyBrowserPanel(');
    for (const p of ['serverStatus', 'console', 'slowlog', 'commandLog'] as const) {
      expect(vue, `缺少分支: ${p}`).toContain(`panel === '${p}'`);
    }
  });
});