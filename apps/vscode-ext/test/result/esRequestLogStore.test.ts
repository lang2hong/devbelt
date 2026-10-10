import { describe, expect, it } from 'vitest';
import { clearEsRequestLog, getEsRequestLog, recordEsRequest, subscribeEsRequestLog } from '../../src/result/esRequestLogStore';

describe('esRequestLogStore（M2 回收）', () => {
  it('记录/快照/订阅增量', () => {
    clearEsRequestLog('c1');
    const seen: unknown[] = [];
    const off = subscribeEsRequestLog('c1', (e) => seen.push(e));
    recordEsRequest('c1', { method: 'GET', path: '/', status: 200, tookMs: 1, time: 1 });
    expect(getEsRequestLog('c1')).toHaveLength(1);
    expect(seen).toHaveLength(1);
    off();
    recordEsRequest('c1', { method: 'GET', path: '/x', status: 200, tookMs: 1, time: 2 });
    expect(seen).toHaveLength(1);
  });

  it('clearEsRequestLog：缓冲与订阅一并回收（连接关闭路径）', () => {
    clearEsRequestLog('c2');
    recordEsRequest('c2', { method: 'GET', path: '/', status: 200, tookMs: 1, time: 1 });
    const seen: unknown[] = [];
    const off = subscribeEsRequestLog('c2', (e) => seen.push(e));
    clearEsRequestLog('c2');
    expect(getEsRequestLog('c2')).toEqual([]);
    recordEsRequest('c2', { method: 'GET', path: '/after-clear', status: 200, tookMs: 1, time: 2 });
    expect(seen).toHaveLength(0); // 订阅已被回收，不再回调
    off();
  });
});
