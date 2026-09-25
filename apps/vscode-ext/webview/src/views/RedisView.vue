<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from '../composables/useVsCode';
import { useI18n } from '../composables/useI18n';
import ServerStatus from '../components/redis/ServerStatus.vue';
import CliConsole from '../components/redis/CliConsole.vue';
import SlowLog from '../components/redis/SlowLog.vue';
import type { CommandResult, SlowlogEntry } from '../components/redis/types';

const { post, onMessage } = useVsCode();
const { t } = useI18n();
let off: (() => void) | undefined;

type Tab = 'status' | 'console' | 'slowlog';
const tab = ref<Tab>('status');
const connName = ref('');
const readOnly = ref(false);
const info = ref('');
const entries = ref<SlowlogEntry[]>([]);
const results = ref<CommandResult[]>([]);
const pending = ref<{ id: string; command: string } | null>(null);
let seq = 0;

function nextId(): string { seq += 1; return `r${seq}`; }

function run(line: string): void {
  post({ type: 'runCommand', id: nextId(), line });
}

function confirmDanger(id: string, accept: boolean): void {
  pending.value = null;
  post({ type: 'confirmDanger', id, accept });
}

onMounted(() => {
  post({ type: 'ready' });
  off = onMessage((msg: any) => {
    if (msg.type === 'config') {
      tab.value = (msg.redisTab as Tab) ?? 'status';
      connName.value = msg.connName ?? '';
      readOnly.value = !!msg.readOnly;
    } else if (msg.type === 'info') {
      info.value = msg.info ?? '';
    } else if (msg.type === 'slowlog') {
      entries.value = msg.entries ?? [];
    } else if (msg.type === 'commandResult') {
      results.value = [...results.value, msg as CommandResult].slice(-100);
    } else if (msg.type === 'confirmRequired') {
      pending.value = { id: msg.id, command: msg.command };
    }
  });
});

onUnmounted(() => { off?.(); });
</script>

<template>
  <div class="redis-panel">
    <header class="header">
      <span class="conn">{{ connName }}</span>
      <span v-if="readOnly" class="badge">{{ t('wv.redis.readOnly') }}</span>
    </header>
    <nav class="tabs">
      <button :class="{ active: tab === 'status' }" @click="tab = 'status'">{{ t('wv.redis.tab.status') }}</button>
      <button :class="{ active: tab === 'console' }" @click="tab = 'console'">{{ t('wv.redis.tab.console') }}</button>
      <button :class="{ active: tab === 'slowlog' }" @click="tab = 'slowlog'">{{ t('wv.redis.tab.slowlog') }}</button>
    </nav>
    <main class="body">
      <ServerStatus v-if="tab === 'status'" :info="info" @refresh="post({ type: 'refreshInfo' })" />
      <CliConsole
        v-else-if="tab === 'console'"
        :results="results"
        :read-only="readOnly"
        :pending="pending"
        @run="run"
        @confirm="confirmDanger"
      />
      <SlowLog v-else :entries="entries" @refresh="post({ type: 'refreshSlowlog' })" />
    </main>
  </div>
</template>

<style scoped>
.redis-panel { display: flex; flex-direction: column; height: 100vh; padding: 8px 10px; box-sizing: border-box; }
.header { display: flex; gap: 8px; align-items: center; font-size: 12px; }
.conn { font-weight: 600; }
.badge { padding: 1px 6px; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18)); margin: 8px 0; }
.tabs button { padding: 4px 12px; font-size: 12px; cursor: pointer; border: none; background: transparent; color: var(--vscode-foreground); border-bottom: 2px solid transparent; }
.tabs button.active { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
.body { flex: 1; min-height: 0; }
</style>
