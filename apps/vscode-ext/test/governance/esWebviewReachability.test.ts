import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * N1 可达性回归：按 _id 跳转必须走专用 esGetDoc 链路。
 * 上轮教训：host 处理器与测试都在，但 webview 无调用方（死代码）——
 * 直接调 handleMessage 的测试不构成可达性断言，这里钉住三处接线。
 */
describe('ES webview 可达性（N1：_id 跳转链路）', () => {
  const documentsTab = read('webview/src/components/elasticsearch/DocumentsTab.vue');
  const view = read('webview/src/views/ElasticsearchView.vue');
  const host = read('src/result/elasticsearchView.ts');

  it('DocumentsTab.jump 发专用 jump 事件，不再经 REST op 管线', () => {
    expect(documentsTab).toContain("emit('jump'");
    expect(documentsTab).not.toContain("emit('op', { method: 'GET'");
  });

  it('主视图：@jump 接线 + jumpDoc 发送 esGetDoc', () => {
    expect(view).toContain('@jump="jumpDoc"');
    expect(view).toContain('function jumpDoc');
    expect(view).toContain("type: 'esGetDoc'");
  });

  it('host：esGetDoc 处理器存在（链路闭环）', () => {
    expect(host).toContain("'esGetDoc'");
    expect(host).toContain("type: 'esDoc'");
  });
});
