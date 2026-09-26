<script setup lang="ts">
import { useI18n } from '../../composables/useI18n';

const props = defineProps<{
  entries: { command: string; args: string[]; durationMs: number; ok: boolean; at: number }[];
  events: { event: string; detail: string | null; at: number }[];
}>();
const { t } = useI18n();
</script>

<template>
  <div class="cmdlog">
    <div class="events">
      <strong>{{ t('wv.redis.events.title') }}</strong>
      <div v-if="!props.events.length" class="empty">{{ t('wv.redis.events.empty') }}</div>
      <div v-for="(e, i) in props.events" :key="'e' + i" class="ev">
        {{ new Date(e.at).toLocaleTimeString() }} · {{ e.event }}{{ e.detail ? ' ' + e.detail : '' }}
      </div>
    </div>
    <div v-if="!props.entries.length" class="empty">{{ t('wv.redis.commandLog.empty') }}</div>
    <table v-else>
      <thead>
        <tr>
          <th>{{ t('wv.redis.commandLog.time') }}</th>
          <th>{{ t('wv.redis.commandLog.command') }}</th>
          <th>{{ t('wv.redis.commandLog.cost') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(e, i) in props.entries" :key="i" :class="{ err: !e.ok }">
          <td>{{ new Date(e.at).toLocaleTimeString() }}</td>
          <td class="mono">{{ e.command }} {{ e.args.join(' ') }}</td>
          <td>{{ t('wv.redis.console.duration', { ms: e.durationMs }) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.cmdlog { flex: 1; overflow: auto; font-size: 12px; }
.cmdlog table { width: 100%; border-collapse: collapse; }
.cmdlog th, .cmdlog td { text-align: left; padding: 2px 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); }
.cmdlog .mono { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.cmdlog tr.err td { color: var(--vscode-errorForeground); }
.cmdlog .empty { color: var(--vscode-descriptionForeground); padding: 12px; text-align: center; }
.cmdlog .events { padding: 2px 0 6px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.12)); }
.cmdlog .ev { color: var(--vscode-descriptionForeground); font-size: 11px; }
</style>