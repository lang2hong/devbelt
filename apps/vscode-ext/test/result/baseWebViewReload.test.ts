import { beforeEach, describe, expect, it, vi } from 'vitest';

let messageHandler: ((msg: any) => void) | undefined;

vi.mock('vscode', () => ({
  env: { language: 'en' },
  workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
  Uri: { file: (s: string) => ({ toString: () => s }), parse: (s: string) => ({ toString: () => s }) },
  ViewColumn: { Active: 1 },
  window: {
    createWebviewPanel: () => ({
      webview: {
        html: '',
        cspSource: '',
        asWebviewUri: (u: unknown) => u,
        onDidReceiveMessage: (h: (msg: any) => void) => { messageHandler = h; return { dispose() {} }; },
        postMessage: vi.fn(async () => true),
      },
      onDidDispose: () => ({ dispose() {} }),
      dispose: vi.fn(),
    }),
  },
}));

vi.mock('../../src/webview/html', () => ({ getWebviewHtml: () => '<html></html>' }));
vi.mock('../../src/i18n', () => ({ isZh: () => false }));

import { BaseWebView } from '../../src/result/baseWebView';

class Probe extends BaseWebView {
  public seen: boolean[] = [];
  constructor() { super('test.view', 'Test'); }
  protected async handleMessage(msg: any): Promise<void> {
    if (msg?.type !== 'ready') return;
    // 复刻两次 ready 协议：首个 ready 置位，后续视为「第二次」。
    this.seen.push(this.initSent);
    if (!this.initSent) this.initSent = true;
  }
}

describe('BaseWebView 面板重载', () => {
  beforeEach(() => { messageHandler = undefined; });

  it('新一轮 webview 加载会重置两次 ready 状态', async () => {
    const view = new Probe();
    // 首轮：ready#1 未初始化 → ready#2 已初始化。
    messageHandler!({ type: 'ready', __load: 'load-a' });
    await Promise.resolve();
    messageHandler!({ type: 'ready', __load: 'load-a' });
    await Promise.resolve();
    expect(view.seen).toEqual([false, true]);

    // 面板重载：新的 load id。第一个 ready 必须重新视为「第一次」，
    // 否则扩展会直接给尚未挂载的目标视图推数据 → 丢失并卡死。
    messageHandler!({ type: 'ready', __load: 'load-b' });
    await Promise.resolve();
    expect(view.seen).toEqual([false, true, false]);
  });
});