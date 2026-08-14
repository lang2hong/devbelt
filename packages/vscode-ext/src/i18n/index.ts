import * as vscode from 'vscode';
import { en, zh, type MessageCatalog } from './catalog';

/**
 * 轻量国际化模块（扩展主进程侧）。
 *
 * 词条数据在 `./catalog`（零 vscode 依赖，webview 也从那里读），
 * 这里只负责「当前该用哪种语言」以及取词。
 *
 * 语言解析优先级（从高到低）：
 *  1. 用户显式设置 dbclient.language = zh / en（覆盖）
 *  2. VSCode 界面语言（默认，auto）
 *  3. 兜底英文
 *
 * 用法：
 *   import { l10n } from '../i18n';
 *   vscode.window.showInformationMessage(l10n('common.loading'));
 */

/** 语言设置项 id 与取值 */
export const LANGUAGE_CONFIG_KEY = 'dbclient.language';
export type LanguageSetting = 'auto' | 'zh' | 'en';

export { en, zh };
export type { MessageCatalog };

/** 当前语言目录（惰性解析） */
let cachedCatalog: MessageCatalog | undefined;
let cachedIsZh: boolean | undefined;

/**
 * 解析当前实际语言：用户设置 > VSCode 界面语言。
 * 结果缓存，配置改变时通过 invalidateLanguage() 失效。
 */
export function resolveLanguage(): 'zh' | 'en' {
  const setting = vscode.workspace
    .getConfiguration()
    .get<LanguageSetting>(LANGUAGE_CONFIG_KEY, 'auto');
  if (setting === 'zh') return 'zh';
  if (setting === 'en') return 'en';
  // auto：跟随 VSCode 界面语言
  return vscode.env.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 判断当前是否为中文（含缓存） */
export function isZh(): boolean {
  if (cachedIsZh === undefined) {
    cachedIsZh = resolveLanguage() === 'zh';
  }
  return cachedIsZh;
}

/** 使语言缓存失效（配置变更时调用） */
export function invalidateLanguage(): void {
  cachedCatalog = undefined;
  cachedIsZh = undefined;
}

/**
 * 获取当前语言下的翻译文本。
 * 支持 {placeholder} 占位符替换。
 */
export function l10n(key: string, vars?: Record<string, string | number>): string {
  if (!cachedCatalog) {
    cachedCatalog = isZh() ? zh : en;
  }
  let text = cachedCatalog[key] || en[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}
