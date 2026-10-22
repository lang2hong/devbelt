/**
 * 连接环境 → 视图树短标签（纯函数，便于单测）。
 *
 * 连接节点设置了数据库类型 logo（TreeItem.iconPath）时，VS Code 不会渲染
 * FileDecoration 徽标，因此环境改用 description 中的小写短标签。
 * description 本身是灰色辅助文本，视觉上比连接名轻。
 * `dev` 兼容早期导入/手写数据。
 */
const ENVIRONMENT_LABELS: Record<string, string> = {
  development: 'dev',
  dev: 'dev',
  test: 'test',
  staging: 'stage',
  production: 'prod',
};

export function connectionEnvironmentLabel(environment?: string): string | undefined {
  return environment ? ENVIRONMENT_LABELS[environment] : undefined;
}