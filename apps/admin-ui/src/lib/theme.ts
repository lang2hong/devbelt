export type ThemeChoice = 'auto' | 'light' | 'dark';

const KEY = 'devbelt-theme';

export function getTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // 存储不可用时仅本次生效
  }
}

export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return choice === 'auto' ? 'light' : choice === 'light' ? 'dark' : 'auto';
}

export const THEME_LABEL: Record<ThemeChoice, string> = { auto: '跟随系统', light: '浅色', dark: '深色' };
