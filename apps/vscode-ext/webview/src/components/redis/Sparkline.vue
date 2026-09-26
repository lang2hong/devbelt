<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ points: number[]; color?: string }>();

const W = 100;
const H = 28;

const path = computed(() => {
  const pts = props.points;
  if (pts.length < 2) return '';
  let min = Infinity;
  let max = -Infinity;
  for (const v of pts) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  return pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * W;
      const y = H - ((v - min) / span) * H;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
});
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