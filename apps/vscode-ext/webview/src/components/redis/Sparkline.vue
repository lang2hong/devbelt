<script setup lang="ts">
import { computed } from 'vue';
import { buildSparklinePath } from './types';

const props = defineProps<{ points: readonly (number | null)[]; color?: string }>();

const W = 100;
const H = 28;

const path = computed(() => buildSparklinePath(props.points, W, H));
const stroke = computed(() => props.color ?? 'var(--vscode-charts-blue, #3794ff)');
</script>

<template>
  <svg class="sparkline" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none">
    <path v-if="path" :d="path" :stroke="stroke" fill="none" stroke-width="1.5" vector-effect="non-scaling-stroke" />
  </svg>
</template>

<style scoped>
.sparkline { width: 100%; height: 28px; display: block; }
</style>