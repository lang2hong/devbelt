/**
 * 后台筛选时间范围归一（P4，配合 <input type="datetime-local">）。
 *
 * 控件默认只到分钟，值为 `YYYY-MM-DDTHH:mm`。而服务端对结束时间用闭区间
 * （audit `event_time <= ?`、user `create_time <= ?`），若直接把 `10:30` 当作
 * `10:30:00.000Z` 上送，会漏掉该分钟内 `10:30:00.001` 起的记录。
 *
 * - 起点（from）保持所选分钟的起始时刻（`>=` 语义，无需补偿）。
 * - 结束点（to）在仅到分钟精度时归一为该分钟最后一毫秒（`:59.999`）；
 *   若值已含秒（如 `YYYY-MM-DDTHH:mm:ss`）则原样转换，不做扩展。
 */
export function toFromIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function toInclusiveEndIso(local: string): string | undefined {
  if (!local) return undefined;
  const hasSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(local);
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return undefined;
  if (!hasSeconds) d.setSeconds(59, 999);
  return d.toISOString();
}