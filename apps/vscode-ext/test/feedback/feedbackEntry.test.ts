import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

vi.mock('vscode', () => ({}));

const { OPEN_FEEDBACK_COMMAND } = await import('../../src/feedback/feedbackView');
const { FEEDBACK_ITEMS } = await import('../../src/feedback/feedbackPanel');

const ROOT = join(__dirname, '../..');

describe('反馈入口命令', () => {
  it('侧边栏用的常量、package.json 声明、extension.ts 注册三处命令名一致', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      contributes: { commands: { command: string; title: string }[] };
    };
    const declared = pkg.contributes.commands.find((c) => c.command === OPEN_FEEDBACK_COMMAND);
    expect(declared?.title).toBe('%cmd.feedback.open%');

    const ext = readFileSync(join(ROOT, 'src/extension.ts'), 'utf8');
    expect(ext).toContain(`registerCommand('${OPEN_FEEDBACK_COMMAND}'`);
  });

  it('命令标题在中英文 nls 中都有定义', () => {
    for (const f of ['package.nls.json', 'package.nls.zh-cn.json']) {
      const nls = JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as Record<string, string>;
      expect(nls['cmd.feedback.open'], f).toBeTruthy();
    }
  });

  it('GitHub 链接指向 package.json 声明的仓库，而不是旧名字', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { repository: { url: string } };
    const repo = pkg.repository.url.replace(/\/$/, '');
    const github = FEEDBACK_ITEMS.filter((i) => i.url.startsWith('https://github.com/'));
    expect(github.map((i) => i.id).sort()).toEqual(['bug', 'docs', 'feature']);
    for (const i of github) {
      expect(i.url.startsWith(`${repo}/`), i.id).toBe(true);
      expect(i.url).not.toContain('vscode-db-client');
    }
  });
});
