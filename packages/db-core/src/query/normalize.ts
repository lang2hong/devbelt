import type { ColumnMeta } from '../types/meta';

/**
 * 归一化列元数据行（兼容 MySQL/PG/SQLite 返回格式）。
 * 两个服务（MetadataService + TableService）共用。
 */
export function normalizeColumnMeta(row: any): ColumnMeta {
  const name = row.name ?? row.Field ?? row.column_name ?? row['name'];
  const type = row.type ?? row.Type ?? row.data_type ?? row['type'];
  const isPrimary = row.key === 'PRI' || row.Key === 'PRI';
  const nullable = row.nullable ?? row.Null ?? row.is_nullable ?? '';
  const isNotNull = row.isNotNull ?? nullable === 'NO';
  return {
    name,
    simpleType: row.simple_type ?? row.simpleType ?? String(type).split('(')[0],
    type,
    comment: row.comment ?? row.Comment ?? row['comment'] ?? '',
    key: row.key ?? row.Key ?? row['key'] ?? '',
    nullable,
    maxLength: row.maxLength ?? '',
    defaultValue: row.defaultValue ?? row.Default ?? row.column_default ?? '',
    extra: row.extra ?? row.Extra ?? '',
    isNotNull,
    isAutoIncrement: String(row.extra ?? row.Extra ?? '').includes('auto_increment'),
    isUnique: false,
    isPrimary,
    pk: isPrimary ? 'PRI' : '',
  };
}
