import { describe, expect, it } from 'vitest';
import { parseJson, serializeJson } from './json';

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
