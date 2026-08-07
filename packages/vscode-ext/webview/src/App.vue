<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useVsCode } from './composables/useVsCode';
import QueryView from './views/QueryView.vue';
import DesignView from './views/DesignView.vue';
import StatusView from './views/StatusView.vue';

const { onMessage } = useVsCode();
const mode = ref<'query' | 'design' | 'status'>('query');

onMounted(() => {
  onMessage((msg: any) => {
    if (msg.type === 'init') {
      mode.value = msg.mode || 'query';
    }
  });
});
</script>

<template>
  <QueryView v-if="mode === 'query'" />
  <DesignView v-else-if="mode === 'design'" />
  <StatusView v-else />
</template>
