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

export const router = reactive({
  pathname: '',
  name: null as string | null,
  params: {} as Record<string, string>,
});

const routes: RouteConfig[] = [];

function resolve(pathname: string): void {
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
  if (window.location.pathname === path) return;
  window.history.pushState(null, '', path);
  resolve(path);
}