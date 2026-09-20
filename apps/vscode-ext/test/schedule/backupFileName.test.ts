import { describe, expect, it } from 'vitest';
import { backupFileName } from '../../src/schedule/backupFileName';

describe('backupFileName', () => {
  it('清洗库名中的路径分隔符与 ..，避免逃出 outputDir', () => {
    const name = backupFileName('../../etc/cron.d/my db', '2024-01-01-00-00-00');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name).not.toContain('..');
    expect(name.endsWith('_2024-01-01-00-00-00.sql')).toBe(true);
  });

  it('正常库名原样（仅追加时间戳与后缀）', () => {
    expect(backupFileName('mydb', 'S')).toBe('mydb_S.sql');
  });

  it('空库名回退为 table', () => {
    expect(backupFileName('', 'S')).toBe('table_S.sql');
  });
});