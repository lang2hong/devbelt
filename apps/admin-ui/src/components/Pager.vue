<script setup lang="ts">
const props = defineProps<{
  page: number;
  pageSize: number;
  total?: number | null;
  hasNext: boolean;
  count?: number;
  loading?: boolean;
}>();

const emit = defineEmits<{
  (e: 'prev'): void;
  (e: 'next'): void;
  (e: 'update:pageSize', size: number): void;
}>();

function onSize(e: Event): void {
  const size = Number((e.target as HTMLSelectElement).value);
  if (Number.isFinite(size) && size > 0) emit('update:pageSize', size);
}
</script>

<template>
  <div class="pager" :aria-busy="props.loading ? 'true' : undefined">
    <span class="pager-count">
      <template v-if="props.total != null">共 {{ props.total }} 条 · </template>
      <template v-if="props.count != null">本页 {{ props.count }} 条</template>
    </span>
    <span class="spacer"></span>
    <button class="btn small secondary" :disabled="props.page <= 1 || props.loading" @click="emit('prev')">上一页</button>
    <span class="pager-page">第 {{ props.page }} 页</span>
    <button class="btn small secondary" :disabled="!props.hasNext || props.loading" @click="emit('next')">下一页</button>
    <label class="pager-size">
      每页
      <select :value="props.pageSize" :disabled="props.loading" @change="onSize">
        <option :value="20">20</option>
        <option :value="50">50</option>
        <option :value="100">100</option>
      </select>
      条
    </label>
  </div>
</template>

<style scoped>
.pager {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: var(--sp-4) 0;
  padding-top: var(--sp-3);
  border-top: 1px solid var(--c-divider);
}
.pager-count { color: var(--c-text-muted); font-size: 12.5px; }
.pager-page { color: var(--c-text-muted); font-size: 13px; white-space: nowrap; }
.pager-size { display: inline-flex; align-items: center; gap: 4px; color: var(--c-text-muted); font-size: 12.5px; }
.pager-size select { width: auto; padding: 3px 6px; font-size: 12.5px; }
.spacer { flex: 1; }
</style>