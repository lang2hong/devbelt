import { describe, expect, it } from 'vitest';
import { CONN_DECORATION_SCHEME, connectionDecorationSpec, connectionResource } from '../../src/tree/connectionDecoration';

describe('connectionDecoration', () => {
  it('resourceUri 用自定义 scheme，authority 为连接 id', () => {
    expect(connectionResource('c1')).toBe(`${CONN_DECORATION_SCHEME}://c1`);
  });

  it('自定义色优先，且不加徽标', () => {
    expect(connectionDecorationSpec({ environment: 'production', color: '#3b82f6' } as never)).toEqual({ colorToken: 'charts.blue' });
  });

  it('production=P/红、staging=S/橙，其它环境不装饰', () => {
    expect(connectionDecorationSpec({ environment: 'production' } as never)).toEqual({ badge: 'P', colorToken: 'errorForeground' });
    expect(connectionDecorationSpec({ environment: 'staging' } as never)).toEqual({ badge: 'S', colorToken: 'editorWarning.foreground' });
    expect(connectionDecorationSpec({ environment: 'dev' } as never)).toBeUndefined();
    expect(connectionDecorationSpec({} as never)).toBeUndefined();
  });
});