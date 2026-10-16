<script setup lang="ts">
import { router, navigate, withBase } from '../lib/router';

/** 分组导航：按运营动线归类，避免 9 个平级入口。 */
const groups = [
  { title: '运营', links: [
    { name: 'admin-users', path: '/users', label: '用户' },
    { name: 'admin-orders', path: '/orders', label: '订单' },
    { name: 'admin-invoices', path: '/invoices', label: '发票' },
  ] },
  { title: '商业化', links: [
    { name: 'admin-plans', path: '/plans', label: '套餐' },
    { name: 'admin-ai-topup', path: '/ai-topup', label: 'AI 积分' },
  ] },
  { title: 'AI', links: [
    { name: 'admin-ai-providers', path: '/ai-providers', label: '模型厂商' },
    { name: 'admin-ai-billing', path: '/ai-billing', label: '计费与成本' },
  ] },
  { title: '系统', links: [
    { name: 'admin-audit', path: '/audit', label: '审计日志' },
    { name: 'admin-version', path: '/version', label: '系统状态' },
  ] },
];
</script>

<template>
  <nav class="admin-nav" aria-label="后台导航">
    <div v-for="g in groups" :key="g.title" class="group">
      <div class="group-title">{{ g.title }}</div>
      <a
        v-for="l in g.links"
        :key="l.name"
        :href="withBase(l.path)"
        :class="{ on: router.name === l.name }"
        :aria-current="router.name === l.name ? 'page' : undefined"
        @click.prevent="navigate(l.path)"
      >{{ l.label }}</a>
    </div>
  </nav>
</template>

<style scoped>
.admin-nav { display: flex; flex-direction: column; gap: 18px; }
.group { display: flex; flex-direction: column; gap: 2px; }
.group-title { padding: 0 12px 4px; font-size: 11.5px; font-weight: 600; letter-spacing: .04em; color: var(--c-text-subtle); }
.admin-nav a {
  display: block; padding: 7px 12px; border-radius: var(--r-sm);
  color: var(--c-text-muted); text-decoration: none; font-size: 13.5px;
}
.admin-nav a:hover { background: var(--c-surface-muted); color: var(--c-text); }
.admin-nav a.on { background: var(--c-accent-bg); color: var(--c-accent-text); font-weight: 600; }
</style>
