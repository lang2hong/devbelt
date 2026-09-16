import { onUnmounted, ref, type Ref } from 'vue';

/**
 * 每秒（可配）推进的「当前时间」引用，供倒计时展示。
 * 组件卸载时自动清理定时器；无副作用（不请求）。
 */
export function useNow(intervalMs = 1000): Ref<number> {
  const now = ref(Date.now());
  const timer = setInterval(() => { now.value = Date.now(); }, intervalMs);
  onUnmounted(() => clearInterval(timer));
  return now;
}

/** 剩余毫秒 → `mm:ss`（<=0 返回 `00:00`）。 */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}