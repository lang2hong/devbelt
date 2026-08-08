const numberTypes = new Set([
  'DECIMAL',
  'TINY',
  'SHORT',
  'LONG',
  'FLOAT',
  'DOUBLE',
  'NULL',
  'NEWDECIMAL',
  'LONGLONG',
  'INT24',
]);
const bitTypes = new Set(['BIT']);
const hexTypes = new Set(['TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB', 'BLOB']);
const geometryTypes = new Set(['GEOMETRY']);

export { numberTypes, bitTypes, geometryTypes, hexTypes };