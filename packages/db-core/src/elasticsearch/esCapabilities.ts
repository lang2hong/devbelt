/**
 * ES 能力声明（P8 S1）。
 *
 * 对齐 P7 Redis 的能力面约定：host/webview 通过它判定可用的 tab/操作，
 * 不散落布尔判断。`readOnly` 反映连接级只读（写操作在 EsClient 请求层仍会 fail-closed）。
 */
export interface EsCapabilities {
  engine: 'elasticsearch';
  cluster: boolean;
  indices: boolean;
  documents: boolean;
  crud: boolean;
  dsl: boolean;
  rest: boolean;
  aliases: boolean;
  readOnly: boolean;
  ssh: boolean;
  tls: boolean;
}

export function esCapabilities(readOnly = false): EsCapabilities {
  return {
    engine: 'elasticsearch',
    cluster: true,
    indices: true,
    documents: true,
    crud: true,
    dsl: true,
    rest: true,
    aliases: true,
    readOnly,
    ssh: true,
    tls: true,
  };
}