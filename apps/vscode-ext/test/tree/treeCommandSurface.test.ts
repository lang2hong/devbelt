import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const TREE_FILES = [
  'src/tree/dbTreeDataProvider.ts',
  'src/tree/metadataNodeBuilder.ts',
  'src/tree/redisKeyTreeState.ts',
];
const TREE_COMMANDS = [
  'devbelt.openConnection',
  'devbelt.es.index',
  'devbelt.es.cluster',
  'devbelt.es.indices',
  'devbelt.openQuery',
  'devbelt.viewTrigger',
  'devbelt.jumpToRefTable',
  'devbelt.previewTable',
  'devbelt.previewView',
  'devbelt.openRoutine',
  'devbelt.openEvent',
  'devbelt.redis.keyBrowser',
  'devbelt.redis.loadMoreKeys',
  'devbelt.redis.loadMoreFolderKeys',
  'devbelt.redis.loadAllKeys',
];

describe('树节点命令参数（防 VS Code 命令缓存失效）', () => {
  it('树节点 TreeItem.command 不再携带 arguments', () => {
    for (const file of TREE_FILES) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text, `${file} 仍含 arguments`).not.toContain('arguments:');
    }
  });

  it('树里出现的命令都在 TREE_COMMANDS 注入白名单中', () => {
    const shared = readFileSync(join(ROOT, 'src/commands/shared.ts'), 'utf8');
    const ids = new Set<string>();
    for (const file of TREE_FILES) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const m of text.matchAll(/command:\s*'([^']+)'/g)) ids.add(m[1]!);
    }
    expect([...ids].sort()).toEqual([...TREE_COMMANDS].sort());
    for (const id of ids) expect(shared).toContain(`'${id}'`);
  });

  it('空树欢迎页存在且给出新建连接入口', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const welcome = (pkg.contributes.viewsWelcome ?? []) as Array<{ view: string; contents: string; when?: string }>;
    expect(welcome.some((w) => w.view === 'devbelt.explorer' && w.contents.includes('welcome.noConnections'))).toBe(true);
    expect(welcome.some((w) => w.when?.includes('devbelt.hasConnections'))).toBe(true);
    const nls = JSON.parse(readFileSync(join(ROOT, 'package.nls.zh-cn.json'), 'utf8')) as Record<string, string>;
    expect(nls['welcome.noConnections.loggedIn']).toContain('command:devbelt.addConnection');
    expect(nls['welcome.noConnections.loggedOut']).toContain('command:devbelt.login');
  });
});