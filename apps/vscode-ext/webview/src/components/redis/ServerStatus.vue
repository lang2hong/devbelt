<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../composables/useI18n';

const { t } = useI18n();
const props = defineProps<{ info: string }>();
const emit = defineEmits<{ (e: 'refresh'): void }>();

interface Section { name: string; lines: string[] }

/** INFO 文本按 `# Section` 分节。 */
const sections = computed<Section[]>(() => {
  const out: Section[] = [];
  let current: Section = { name: '', lines: [] };
  for (const line of props.info.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) {
      current = { name: line.replace(/^#\s*/, ''), lines: [] };
      out.push(current);
      continue;
    }
    if (!current.name && out.length === 0) out.push(current);
    current.lines.push(line);
  }
  return out.filter((s) => s.name || s.lines.length);
});
</script>

<template>
  <div class="server-status">
    <div class="toolbar">
      <button class="btn" @click="emit('refresh')">{{ t('wv.redis.refresh') }}</button>
    </div>
    <div v-if="!info" class="empty">{{ t('wv.redis.status.empty') }}</div>
    <div v-else class="sections">
      <section v-for="(s, i) in sections" :key="i">
        <h4 v-if="s.name">{{ s.name }}</h4>
        <pre>{{ s.lines.join('\n') }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
.server-status { display: flex; flex-direction: column; height: 100%; }
.toolbar { padding: 4px 0; }
.sections { flex: 1; overflow-y: auto; }
.sections h4 { margin: 10px 0 4px; font-size: 12px; color: var(--vscode-descriptionForeground); text-transform: uppercase; }
.sections pre { margin: 0; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.empty { color: var(--vscode-descriptionForeground); padding: 16px; text-align: center; }
.btn { padding: 3px 10px; font-size: 12px; cursor: pointer; border: none; border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
