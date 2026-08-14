import { computed, ref } from 'vue';
import { en, zh } from '../../../src/i18n/catalog';

/**
 * webview 侧国际化。
 *
 * 词条与扩展主进程共用 `src/i18n/catalog`（该模块零 vscode 依赖，能被 vite 打包，
 * 与 `ResultGrid` 复用 `src/utils/filterOps` 是同一条路子）。语言不能在这里自行
 * 解析——`vscode.workspace` / `vscode.env` 在 webview 里不存在——由扩展端在
 * `init` 消息里下发 `isZh`，`BaseWebView.post` 统一注入。
 *
 * 迁移前 ConnectionFormView 与 UserFormView 各自内嵌一张 I18N 表，其余 11 个
 * 视图全是硬编码英文；现在统一走这里。
 */

/** 当前是否中文。init 消息到达前默认英文（与扩展端兜底一致）。 */
const zhActive = ref(false);

/** 由 init 消息驱动：`setLanguage(!!msg.isZh)`。 */
export function setLanguage(isZh: boolean): void {
  zhActive.value = isZh;
}

/** 当前语言标识，供需要按语言分支的少数场景使用（如日期格式）。 */
export const isZhRef = computed(() => zhActive.value);

/**
 * 取词并替换 `{placeholder}`。
 *
 * 回退链与扩展端 `l10n` 一致：当前语言 → 英文 → 键名本身。
 * 键名裸露即说明 catalog 里缺这一条，属可见的缺失信号而非静默空字符串。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const catalog = zhActive.value ? zh : en;
  let text = catalog[key] || en[key] || key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}

/** 组件里用：`const { t } = useI18n()`。 */
export function useI18n(): { t: typeof t; isZh: typeof isZhRef } {
  return { t, isZh: isZhRef };
}
