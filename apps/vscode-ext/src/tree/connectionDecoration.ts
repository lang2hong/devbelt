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
  /** 右侧小徽标（1–2 字符）；无则为纯标签着色。 */
  badge?: string;
  /** 主题色 token（`ThemeColor` 只接受 token，不接受 hex）。 */
  colorToken: string;
}

/**
 * 连接 → 装饰规格：
 * - 用户自定义色优先（仅着色，不加徽标）；
 * - 否则 production=`P`红 / staging=`S`橙；
 * - 其它环境返回 undefined（不装饰，避免噪音）。
 */
export function connectionDecorationSpec(
  conn: Pick<SavedConnection, 'environment' | 'color'>,
): ConnectionDecorationSpec | undefined {
  const custom = connectionColorToken(conn.color);
  if (custom) return { colorToken: custom };
  if (conn.environment === 'production') return { badge: 'P', colorToken: 'errorForeground' };
  if (conn.environment === 'staging') return { badge: 'S', colorToken: 'editorWarning.foreground' };
  return undefined;
}