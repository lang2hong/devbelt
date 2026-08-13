import type { ColumnMeta } from '../types/meta';
import { toBool } from '../utils/coerce';

/**
 * 归一化列元数据行（兼容 MySQL/PG/SQLite 返回格式）。
 * 两个服务（MetadataService + TableService）共用。
 *
 * 布尔字段一律过 toBool：MySQL typeCast 把非日期值统一字符串化，
 * `information_schema` 的布尔表达式会以 `"0"`/`"1"` 到达，而 `!!"0"` 为真。
 */
export function normalizeColumnMeta(row: any): ColumnMeta {
  const name = row.name ?? row.Field ?? row.column_name ?? row['name'];
  const type = row.type ?? row.Type ?? row.data_type ?? row['type'];
  const key = row.key ?? row.Key ?? row['key'] ?? '';
  const nullable = row.nullable ?? row.Null ?? row.is_nullable ?? '';
  const isPrimary = String(key).toUpperCase() === 'PRI' || toBool(row.isPrimary) || toBool(row.pk);
  const isNotNull = row.isNotNull !== undefined
    ? toBool(row.isNotNull)
    : String(nullable).toUpperCase() === 'NO';
  const extra = row.extra ?? row.Extra ?? '';
  return {
    name,
    simpleType: row.simple_type ?? row.simpleType ?? String(type).split('(')[0],
    type,
    comment: row.comment ?? row.Comment ?? row['comment'] ?? '',
    key,
    nullable,
    maxLength: row.maxLength ?? '',
    defaultValue: row.defaultValue ?? row.Default ?? row.column_default ?? '',
    extra,
    isNotNull,
    isAutoIncrement: String(extra).toLowerCase().includes('auto_increment'),
    isUnique: String(key).toUpperCase() === 'UNI',
    isPrimary,
    pk: isPrimary ? 'PRI' : '',
  };
}
