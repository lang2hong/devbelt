/**
 * 统一时间显示格式：`YYYY-MM-DD HH:mm:ss`（24 小时制，本地时区）。
 * webview 各视图的时间显示一律经本函数输出。
 */
export function formatDateTime(input: string | number | Date | null | undefined): string {
  if (input === null || input === undefined) return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}