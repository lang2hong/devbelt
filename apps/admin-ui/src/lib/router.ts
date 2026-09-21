import { reactive } from 'vue';

/**
 * 自研 pathname 路由（P3 §3，不引 vue-router）。纯函数 matchRoute 负责
 * pattern → { name, params } 匹配（可单测）；router 为浏览器单例，App 据此选择页面。
 */

export interface RouteConfig {
  pattern: string;
  name: string;
}

export interface ResolvedRoute {
  name: string;
  params: Record<string, string>;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function matchRoute(pathname: string, routes: RouteConfig[]): ResolvedRoute | null {
  const clean = pathname.split('?')[0];
  const segs = clean.split('/').filter(Boolean);
  for (const route of routes) {
    const pat = route.pattern.split('/').filter(Boolean);
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < pat.length; i++) {
      const p = pat[i];
      if (p.startsWith(':')) params[p.slice(1)] = safeDecode(segs[i]);
      else if (p !== segs[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { name: route.name, params };
  }
  return null;
}

/** 应用部署基路径（vite base）：'/' 或 '/db/'。构建时由 DEVBELT_DB_CONSOLE_BASE 注入。 */
const BASE: string = (() => {
  const b = (import.meta.env?.BASE_URL as string | undefined) ?? '/';
  return b.endsWith('/') ? b : `${b}/`;
})();

/** 把应用内绝对路径拼上基路径（保留 query/hash）。 */
export function withBase(path: string): string {
  if (BASE === '/') return path;
  const prefix = BASE.replace(/\/$/, '');
  if (!path.startsWith('/')) path = `/${path}`;
  return `${prefix}${path}`;
}

/** 从浏览器 pathname 还原应用内路径（去掉基路径前缀）。 */
export function stripBase(pathname: string): string {
  if (BASE === '/') return pathname;
  const prefix = BASE.replace(/\/$/, '');
  if (pathname === prefix) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

export const router = reactive({
  pathname: '',
  name: null as string | null,
  params: {} as Record<string, string>,
});

const routes: RouteConfig[] = [];

function resolve(rawPathname: string): void {
  const pathname = stripBase(rawPathname);
  const r = matchRoute(pathname, routes);
  router.pathname = pathname;
  router.name = r?.name ?? null;
  router.params = r?.params ?? {};
}

export function installRouter(config: RouteConfig[]): void {
  routes.splice(0, routes.length, ...config);
  resolve(window.location.pathname);
  window.addEventListener('popstate', () => resolve(window.location.pathname));
}

export function navigate(path: string): void {
  const full = withBase(path);
  if (window.location.pathname === full) return;
  window.history.pushState(null, '', full);
  resolve(full);
}