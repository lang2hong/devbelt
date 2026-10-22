/**
 * 连接节点的 FileDecoration 规格（纯函数，无 vscode 运行时依赖）。
 *
 * 连接节点现在用品牌 logo 作图标，颜色不再能承载「环境/自定义色」信号；
 * 改由 `FileDecorationProvider` 用徽标 + 标签色表达，二者互不牺牲。
 */
import type { SavedConnection } from '@devbelt/db-host/connection/connectionStore';
import { connectionColorToken } from '../utils/connectionColor';

/** 连接节点 resourceUri 的自定义 scheme（供 FileDecorationProvider 识别）。 */
export const CONN_DECORATION_SCHEME = 'devbelt-conn';

/** 连接 id → resourceUri 字符串（`devbelt-conn://<id>`，authority 即 id）。 */
export function connectionResource(id: string): string {
  return `${CONN_DECORATION_SCHEME}://${id}`;
}

export interface ConnectionDecorationSpec {
  /** 主题色 token（`ThemeColor` 只接受 token，不接受 hex）。 */
  colorToken: string;
}

/**
 * 连接 → 标签颜色规格。
 *
 * 环境文字由 `connectionEnvironmentLabel` 放在 TreeItem.description 中；
 * 这里只保留自定义色与 production/staging 的标签色。连接节点有 iconPath，
 * FileDecoration.badge 不会被渲染，因此不再返回 badge。
 */
export function connectionDecorationSpec(
  conn: Pick<SavedConnection, 'environment' | 'color'>,
): ConnectionDecorationSpec | undefined {
  const custom = connectionColorToken(conn.color);
  if (custom) return { colorToken: custom };
  if (conn.environment === 'production') return { colorToken: 'errorForeground' };
  if (conn.environment === 'staging') return { colorToken: 'editorWarning.foreground' };
  return undefined;
}