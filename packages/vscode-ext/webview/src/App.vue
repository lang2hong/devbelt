<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from './composables/useVsCode';
import QueryView from './views/QueryView.vue';
import DesignView from './views/DesignView.vue';

const { onMessage, off } = useMessageHandler();
const mode = ref<'query' | 'design'>('query');

function useMessageHandler() {
  const { onMessage } = useVsCode();
  let off: () => void;
  onMounted(() => {
    off = onMessage((msg: any) => {
      if (msg.type === 'init') {
        mode.value = msg.mode || 'query';
      }
    });
  });
  onUnmounted(() => off?.());
  return { onMessage, off: () => off?.() };
}
</script>

<template>
  <QueryView v-if="mode === 'query'" />
  <DesignView v-else />
</template>
