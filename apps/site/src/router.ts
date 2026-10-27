import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import HomePage from './pages/HomePage.vue';

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home-zh', component: HomePage, meta: { locale: 'zh' } },
  { path: '/en', name: 'home-en', component: HomePage, meta: { locale: 'en' } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to) {
    if (to.hash) {
      return { el: to.hash, behavior: 'smooth', top: 80 };
    }
    return { top: 0 };
  },
});
