/**
 * i18n 词条 barrel。
 *
 * 数据按语言拆到 catalog.en.ts / catalog.zh.ts：单文件 1400 行集中在两处高 churn
 * 的键集上，任一新增词条都会在整文件层面产生冲突；按语言分文件后冲突面减半。
 * 消费方（src/i18n/index.ts、webview useI18n）仍从此处 import，路径不变。
 */
export type { MessageCatalog } from "./catalog.en";
export { en } from "./catalog.en";
export { zh } from "./catalog.zh";
