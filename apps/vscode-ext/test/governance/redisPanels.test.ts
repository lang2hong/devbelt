import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PANELS = ['keyBrowser', 'serverStatus', 'console', 'slowlog', 'commandLog', 'monitor'] as const;
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
      monitor: 'devbelt.redis.monitor',
    };
    for (const p of PANELS) {
      const cmd = byPanel[p];
      expect(menus.some((m) => m.command === cmd && m.when?.includes('REDIS')), `缺少菜单: ${p}`).toBe(true);
    }
  });

  it('webview 对每个面板有渲染分支', () => {
    expect(vue).toContain('isKeyBrowserPanel(');
    for (const p of ['serverStatus', 'console', 'slowlog', 'commandLog', 'monitor'] as const) {
      expect(vue, `缺少分支: ${p}`).toContain(`panel === '${p}'`);
    }
  });

  it('DB 节点：展开键树（无默认点击命令），右击含控制台/搜索/新建', () => {
    const tree = readFileSync(join(process.cwd(), 'src/tree/dbTreeDataProvider.ts'), 'utf8');
    // C-2：DB 节点不再有默认点击命令（避免打开空值面板），点击即展开。
    expect(tree).not.toContain("node.command = { command: 'devbelt.redis.keyBrowser'");
    expect(menus.some((m) => m.command === 'devbelt.redis.console' && m.when?.includes('connectionOpen.REDIS'))).toBe(true);
    expect(menus.some((m) => m.command === 'devbelt.redis.console' && m.when?.includes('redisDb.REDIS'))).toBe(true);
    // 键浏览器菜单只应在键节点上（DB 节点不再有）。
    expect(menus.some((m) => m.command === 'devbelt.redis.keyBrowser' && m.when?.includes('redisDb.REDIS'))).toBe(false);
  });

it('S5-3 树内只读键导航：键节点有打开菜单 + 懒加载注册点', () => {
    expect(menus.some((m) => m.command === 'devbelt.redis.keyBrowser' && m.when?.includes('redisKey.REDIS'))).toBe(true);
    expect(menus.some((m) => m.command === 'devbelt.copyNodeName' && m.when?.includes('redisKey.REDIS'))).toBe(true);
    expect(viewCommands).toContain('devbelt.redis.loadMoreKeys');
    expect(viewCommands).toContain("manager, 'keyBrowser'");
  });

  it('D* 键树：唯一 load more + 显式加载完整文件夹/载入全部（确认/进度/取消）', () => {
    // 命令注册
    expect(viewCommands).toContain("registerCommand('devbelt.redis.loadFolderKeys'");
    expect(viewCommands).toContain("registerCommand('devbelt.redis.loadAllKeys'");
    // 进度 + 取消 + 二次确认
    expect(viewCommands).toContain('withProgress');
    expect(viewCommands).toContain('cancellable: true');
    expect(viewCommands).toContain('loadAllConfirm');
    // 菜单入口：文件夹「加载完整文件夹」、DB「载入全部」
    expect(menus.some((m) => m.command === 'devbelt.redis.loadFolderKeys' && m.when?.includes('redisKeyFolder.REDIS'))).toBe(true);
    expect(menus.some((m) => m.command === 'devbelt.redis.loadAllKeys' && m.when?.includes('redisDb.REDIS'))).toBe(true);
    // provider 侧：根扁平折叠 + 完整文件夹快照 + 定向失效
    const tree = readFileSync(join(process.cwd(), 'src/tree/dbTreeDataProvider.ts'), 'utf8');
    expect(tree).toContain('loadFullFolder');
    expect(tree).toContain('loadAllRedisKeys');
    expect(tree).toContain('groupRedisKeyChildren');
    expect(tree).toContain('completeBadge');
  });

  it('C-1 树内搜索/写操作：命令注册 + 菜单 when', () => {
    const cmds = [
      'devbelt.redis.searchKeys', 'devbelt.redis.clearSearchKeys', 'devbelt.redis.newKey',
      'devbelt.redis.renameKey', 'devbelt.redis.setKeyTtl', 'devbelt.redis.deleteKey', 'devbelt.redis.deleteFolder',
    ];
    for (const c of cmds) expect(viewCommands, `缺注册: ${c}`).toContain(`registerCommand('${c}'`);
    for (const c of ['devbelt.redis.searchKeys', 'devbelt.redis.clearSearchKeys', 'devbelt.redis.newKey']) {
      expect(menus.some((m) => m.command === c && m.when?.includes('redisDb.REDIS')), `缺菜单: ${c}`).toBe(true);
    }
    for (const c of ['devbelt.redis.renameKey', 'devbelt.redis.setKeyTtl', 'devbelt.redis.deleteKey']) {
      expect(menus.some((m) => m.command === c && m.when?.includes('redisKey.REDIS')), `缺菜单: ${c}`).toBe(true);
    }
    expect(menus.some((m) => m.command === 'devbelt.redis.deleteFolder' && m.when?.includes('redisKeyFolder.REDIS'))).toBe(true);
  });

  it('C-3（B）按 pattern 删除：命令注册 + 菜单 + 模块（cluster 逐 master/逐键）', () => {
    expect(viewCommands).toContain("registerCommand('devbelt.redis.deleteByPattern'");
    expect(menus.some((m) => m.command === 'devbelt.redis.deleteByPattern' && m.when?.includes('redisDb.REDIS'))).toBe(true);
    expect(menus.some((m) => m.command === 'devbelt.redis.deleteByPattern' && m.when?.includes('redisKeyFolder.REDIS'))).toBe(true);
    // 计数/删除走共享模块（cluster 逐 master）；审计记执行 pattern。
    expect(viewCommands).toContain('countPatternKeys');
    expect(viewCommands).toContain('runPatternDelete');
    expect(viewCommands).toContain('UNLINK ${pattern}');
    const mod = readFileSync(join(process.cwd(), 'src/commands/redisPatternDelete.ts'), 'utf8');
    expect(mod).toContain('redisScanOnNode');
    expect(mod).toContain('redisUnlink(client, [key])');
  });
});