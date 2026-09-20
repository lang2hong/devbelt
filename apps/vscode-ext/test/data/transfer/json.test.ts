import { describe, expect, it } from 'vitest';
import { parseJson, serializeJson } from '../../../src/data/transfer/json';

describe('JSON transfer codec', () => {
  it('projects the requested columns and represents missing values as null', () => {
    expect(serializeJson(['id', 'name'], [{ id: 1, ignored: true }, { id: 2, name: 'Ada' }])).toBe(
      '[\n  {\n    "id": 1,\n    "name": null\n  },\n  {\n    "id": 2,\n    "name": "Ada"\n  }\n]\n',
    );
  });

  it('accepts a single object and keeps the union of array object keys', () => {
    expect(parseJson('{"id":1,"name":"Ada"}')).toEqual({
      columns: ['id', 'name'], rows: [{ id: 1, name: 'Ada' }],
    });
    expect(parseJson('[{"id":1},{"name":"Ada"}]')).toEqual({
      columns: ['id', 'name'], rows: [{ id: 1 }, { name: 'Ada' }],
    });
  });

  it('rejects scalar and array values', () => {
    expect(() => parseJson('[1, 2]')).toThrow('array of objects');
    expect(() => parseJson('{')).toThrow('Invalid JSON');
  });
});

describe('JSON 流式解析', () => {
  it('分块读取数组与单对象均正确', async () => {
    const { streamJsonRows, readJsonSample } = await import('../../../src/data/transfer/json');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'json-stream-'));
    const arr = join(dir, 'a.json');
    const one = join(dir, 'o.json');
    writeFileSync(arr, '[{"id":1,"s":"a}b,c"},{"id":2,"s":"x\\"y"}]\n');
    writeFileSync(one, '{"id":9,"s":"z"}');
    try {
      const a: unknown[] = [];
      for await (const row of streamJsonRows(arr, 5)) a.push(row);
      expect(a).toEqual([{ id: 1, s: 'a}b,c' }, { id: 2, s: 'x"y' }]);
      const o: unknown[] = [];
      for await (const row of streamJsonRows(one, 4)) o.push(row);
      expect(o).toEqual([{ id: 9, s: 'z' }]);
      const sample = await readJsonSample(arr, 1);
      expect(sample.columns).toEqual(['id', 's']);
      expect(sample.rows).toEqual([{ id: 1, s: 'a}b,c' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
