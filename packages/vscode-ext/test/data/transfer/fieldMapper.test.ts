import { describe, expect, it } from 'vitest';
import { autoMapFields, mapRows, validateMappings } from '../../../src/data/transfer/fieldMapper';

describe('field mapping', () => {
  it('prefers exact names then case-insensitive unused targets', () => {
    expect(autoMapFields(['ID', 'name', 'extra'], ['id', 'name'])).toEqual([
      { source: 'ID', target: 'id' },
      { source: 'name', target: 'name' },
      { source: 'extra', target: undefined },
    ]);
  });

  it('projects only mapped fields into target column names', () => {
    expect(mapRows([{ source_id: 1, title: 'Ada', ignored: true }], [
      { source: 'source_id', target: 'id' },
      { source: 'title', target: 'name' },
      { source: 'ignored' },
    ])).toEqual({ columns: ['id', 'name'], rows: [{ id: 1, name: 'Ada' }] });
  });

  it('requires one unique destination per selected mapping', () => {
    expect(() => validateMappings([{ source: 'a' }])).toThrow('at least one');
    expect(() => validateMappings([{ source: 'a', target: 'id' }, { source: 'b', target: 'id' }])).toThrow('only be mapped once');
  });
});
