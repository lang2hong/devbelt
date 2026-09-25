/** Redis 面板共享类型（webview 侧）。 */
export interface CommandResult {
  id: string;
  command: string;
  ok: boolean;
  result: string;
  costMs: number;
  error: string | null;
}

export interface SlowlogEntry {
  id: number;
  timestamp: number;
  durationMicros: number;
  command: string;
  clientAddr: string;
  clientName: string;
}
