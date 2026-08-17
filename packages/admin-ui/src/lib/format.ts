export function fmt(d: unknown): string {
  if (!d) return '—';
  const t = new Date(d as string | number);
  if (isNaN(t.getTime())) return '—';
  return t.toLocaleString();
}

export function bytes(n: unknown): string {
  const v = Number(n || 0);
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
  return (v / 1073741824).toFixed(2) + ' GB';
}

export const FEATURES: Array<[string, number]> = [
  ['basic', 1],
  ['er_export', 2],
  ['excel', 4],
  ['datatransfer', 8],
  ['team_share', 16],
  ['audit_log', 32],
];

export function featNames(f: number): string {
  const out = FEATURES.filter(([, bit]) => (f & bit) !== 0).map(([name]) => name);
  return out.length ? out.join(', ') : '—';
}