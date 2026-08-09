/**
 * SQL snippet 目录（纯数据，无 vscode 依赖）。
 *
 * 仅提供编辑器补全模板，不自动执行任何 SQL。模板通过
 * vscode.SnippetString 占位符让用户逐个填写，之后仍须经过
 * 既有 read-only / 生产 / 高风险确认链路才会真正执行。
 */
export interface SqlSnippet {
  /** 唯一的触发词（前缀） */
  trigger: string;
  /** 展示标签 */
  label: string;
  /** 简短说明 */
  description: string;
  /** SnippetString 模板（含 $1、${2:default} 等占位符） */
  body: string;
}

export const SQL_SNIPPETS: SqlSnippet[] = [
  {
    trigger: 'sel',
    label: 'SELECT',
    description: 'SELECT 查询模板',
    body: 'SELECT ${1:*} FROM ${2:table}${3:}${4:;}',
  },
  {
    trigger: 'del',
    label: 'DELETE',
    description: 'DELETE 删除模板',
    body: 'DELETE FROM ${1:table} WHERE ${2:condition}${3:;}',
  },
  {
    trigger: 'ins',
    label: 'INSERT',
    description: 'INSERT 插入模板',
    body: 'INSERT INTO ${1:table} (${2:column}) VALUES (${3:value})${4:;}',
  },
  {
    trigger: 'upd',
    label: 'UPDATE',
    description: 'UPDATE 更新模板',
    body: 'UPDATE ${1:table} SET ${2:column} = ${3:value} WHERE ${4:condition}${5:;}',
  },
  {
    trigger: 'joi',
    label: 'JOIN',
    description: 'JOIN 连接模板',
    body: 'JOIN ${1:table} ON ${2:left} = ${3:right}',
  },
];

export function getSqlSnippet(trigger: string): SqlSnippet | undefined {
  return SQL_SNIPPETS.find((snippet) => snippet.trigger === trigger);
}