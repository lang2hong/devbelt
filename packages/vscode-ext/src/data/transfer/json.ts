export interface JsonData {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Serializes tabular values as readable JSON without changing column order. */
export function serializeJson(columns: string[], rows: Record<string, unknown>[]): string {
  return JSON.stringify(rows.map((row) => {
    const projected: Record<string, unknown> = {};
    for (const column of columns) projected[column] = row[column] ?? null;
    return projected;
  }), null, 2) + '\n';
}

/** Accepts an object or an array of objects, matching common Navicat JSON exports. */
export function parseJson(text: string): JsonData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${(error as Error).message}`);
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (!values.every((value) => value !== null && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error('JSON import requires an object or an array of objects.');
  }
  const rows = values as Record<string, unknown>[];
  const columns: string[] = [];
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!columns.includes(column)) columns.push(column);
    }
  }
  return { columns, rows };
}
