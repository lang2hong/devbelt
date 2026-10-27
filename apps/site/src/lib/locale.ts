import { computed, ref } from 'vue';
import { zh } from '../locales/zh';
import { en } from '../locales/en';
import type { Copy } from './copy';

const locale = ref<'zh' | 'en'>('zh');

export function setLocale(l: 'zh' | 'en') {
  locale.value = l;
}

export function getLocale(): 'zh' | 'en' {
  return locale.value;
}

export function detectLocaleFromPath(path: string): 'zh' | 'en' {
  if (path.startsWith('/en')) return 'en';
  return 'zh';
}

export const t = computed<Copy>(() => (locale.value === 'en' ? en : zh));

export function useCopy() {
  return { t, locale, setLocale };
}
