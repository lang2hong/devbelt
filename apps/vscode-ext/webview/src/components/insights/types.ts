/** Human-readable duration: `850 ms`, `1.25 s`, `2m 05s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export type RelativeUnit = 'justNow' | 'minutes' | 'hours' | 'days';

/** Bucket an age into an i18n unit + count; the view renders the label. */
export function relativeAge(time: number, now: number): { unit: RelativeUnit; n: number } {
  const diff = Math.max(0, now - time);
  if (diff < 60_000) return { unit: 'justNow', n: 0 };
  if (diff < 3_600_000) return { unit: 'minutes', n: Math.floor(diff / 60_000) };
  if (diff < 86_400_000) return { unit: 'hours', n: Math.floor(diff / 3_600_000) };
  return { unit: 'days', n: Math.floor(diff / 86_400_000) };
}

/** Single-line SQL preview for table rows. */
export function sqlPreview(sql: string, max = 160): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}