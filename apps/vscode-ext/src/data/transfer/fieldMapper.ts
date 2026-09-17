export interface FieldMapping {
  source: string;
  target?: string;
}

/** Maps identical names first, then case-insensitive matches without duplicates. */
export function autoMapFields(sourceColumns: string[], targetColumns: string[]): FieldMapping[] {
  const available = new Set(targetColumns);
  const used = new Set<string>();
  return sourceColumns.map((source) => {
    let target = available.has(source) ? source : targetColumns.find((candidate) => candidate.toLowerCase() === source.toLowerCase());
    if (target && used.has(target)) target = undefined;
    if (target) used.add(target);
    return { source, target };
  });
}

export function validateMappings(mappings: FieldMapping[]): Required<FieldMapping>[] {
  const selected = mappings.filter((mapping): mapping is Required<FieldMapping> => !!mapping.target);
  if (!selected.length) throw new Error('Map at least one source field to a target column.');
  const targets = selected.map((mapping) => mapping.target);
  if (new Set(targets).size !== targets.length) throw new Error('A target column can only be mapped once.');
  return selected;
}

export function mapRows(
  rows: Record<string, unknown>[],
  mappings: FieldMapping[],
): { columns: string[]; rows: Record<string, unknown>[] } {
  const selected = validateMappings(mappings);
  const columns = selected.map((mapping) => mapping.target);
  return {
    columns,
    rows: rows.map((row) => {
      const mapped: Record<string, unknown> = {};
      for (const mapping of selected) mapped[mapping.target] = row[mapping.source];
      return mapped;
    }),
  };
}
