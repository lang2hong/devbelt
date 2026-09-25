<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../../composables/useI18n';
import { bytesToAscii } from './bytes';

const props = defineProps<{ bytes: Uint8Array; truncated?: boolean }>();
const { t } = useI18n();

const ROW = 16;
interface HexRow { offset: string; hex: string; ascii: string }

const rows = computed<HexRow[]>(() => {
  const out: HexRow[] = [];
  for (let i = 0; i < props.bytes.length; i += ROW) {
    const slice = props.bytes.subarray(i, i + ROW);
    out.push({
      offset: i.toString(16).padStart(8, '0'),
      hex: [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' '),
      ascii: bytesToAscii(slice),
    });
  }
  return out;
});
</script>

<template>
  <div class="hex-view">
    <div v-if="!bytes.length" class="empty">{{ t('wv.redis.value.none') }}</div>
    <table v-else>
      <thead>
        <tr>
          <th>{{ t('wv.redis.hex.offset') }}</th>
          <th>hex</th>
          <th>{{ t('wv.redis.hex.ascii') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.offset">
          <td class="off">{{ r.offset }}</td>
          <td class="hex">{{ r.hex }}</td>
          <td class="ascii">{{ r.ascii }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="truncated" class="truncated">{{ t('wv.redis.hex.truncated') }}</div>
  </div>
</template>

<style scoped>
.hex-view { max-height: 220px; overflow: auto; border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2)); border-radius: 3px; }
.empty { color: var(--vscode-descriptionForeground); padding: 12px; text-align: center; }
table { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
th { position: sticky; top: 0; text-align: left; padding: 2px 8px; background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); font-weight: 600; }
td { padding: 1px 8px; white-space: pre; }
td.off { color: var(--vscode-descriptionForeground); }
td.ascii { color: var(--vscode-foreground); }
.truncated { position: sticky; bottom: 0; padding: 3px 8px; background: var(--vscode-editor-background); color: var(--vscode-editorWarning-foreground, #cca700); }
</style>