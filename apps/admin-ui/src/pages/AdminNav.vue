<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { router, navigate, withBase } from '../lib/router';

/** 分组导航：按运营动线归类；分组（一级）可折叠，链接（二级）随分组显隐。 */
const groups = [
  { title: '运营', links: [
    { name: 'admin-overview', path: '/overview', label: '概览' },
    { name: 'admin-users', path: '/users', label: '用户' },
    { name: 'admin-feedback', path: '/feedback', label: '反馈' },
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

const STORAGE_KEY = 'devbelt.admin.nav.collapsed';

/** 折叠状态持久化：存被折叠的分组标题数组；存储不可用时仅本次生效。 */
const collapsed = ref<Set<string>>(load());

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed.value]));
  } catch {
    // 存储不可用时仅本次生效
  }
}

function toggle(title: string): void {
  const next = new Set(collapsed.value);
  if (next.has(title)) next.delete(title);
  else next.add(title);
  collapsed.value = next;
  persist();
}

function isCollapsed(title: string): boolean {
  return collapsed.value.has(title);
}

/** 当前路由所在分组保持展开（避免路由跳到被折叠分组里“看不见”）。 */
function ensureActiveGroupOpen(): void {
  const name = router.name;
  if (!name) return;
  const group = groups.find((g) => g.links.some((l) => l.name === name));
  if (group && collapsed.value.has(group.title)) {
    const next = new Set(collapsed.value);
    next.delete(group.title);
    collapsed.value = next;
    persist();
  }
}

watch(() => router.name, ensureActiveGroupOpen);
onMounted(ensureActiveGroupOpen);
</script>

<template>
  <nav class="admin-nav" aria-label="后台导航">
    <div v-for="g in groups" :key="g.title" class="group">
      <button
        type="button"
        class="group-title"
        :aria-expanded="!isCollapsed(g.title)"
        :aria-controls="`nav-group-${g.title}`"
        @click="toggle(g.title)"
      >
        <span>{{ g.title }}</span>
        <span class="chevron" :class="{ closed: isCollapsed(g.title) }" aria-hidden="true">⌃</span>
      </button>
      <div :id="`nav-group-${g.title}`" v-show="!isCollapsed(g.title)" class="group-links">
        <a
          v-for="l in g.links"
          :key="l.name"
          :href="withBase(l.path)"
          :class="{ on: router.name === l.name }"
          :aria-current="router.name === l.name ? 'page' : undefined"
          @click.prevent="navigate(l.path)"
        >{{ l.label }}</a>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.admin-nav { display: flex; flex-direction: column; gap: 18px; }
.group { display: flex; flex-direction: column; gap: 2px; }
.group-title {
  display: flex; width: 100%; align-items: center; justify-content: space-between;
  padding: 0 12px 4px; background: transparent; border: none; cursor: pointer;
  font-size: 11.5px; font-weight: 600; letter-spacing: .04em; color: var(--c-text-subtle);
}
.group-title:hover { color: var(--c-text-muted); }
.chevron { transition: transform .12s ease; }
.chevron.closed { transform: rotate(180deg); }
.group-links { display: flex; flex-direction: column; gap: 2px; }
.admin-nav a {
  display: block; padding: 7px 12px; border-radius: var(--r-sm);
  color: var(--c-text-muted); text-decoration: none; font-size: 13.5px;
}
.admin-nav a:hover { background: var(--c-surface-muted); color: var(--c-text); }
.admin-nav a.on { background: var(--c-accent-bg); color: var(--c-accent-text); font-weight: 600; }
</style>