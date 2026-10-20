import { computed, ref } from 'vue';

export interface CursorPageMeta {
  nextCursor: string | null;
  total?: number;
}

/**
 * keyset 游标分页状态：只维护页码/每页条数/cursor 栈，不绑定具体请求。
 * 调用方每次 load 时读取 `cursor`，成功后 `apply({ nextCursor, total })`。
 */
export function useCursorPages(initialSize = 20) {
  const page = ref(1);
  const pageSize = ref(initialSize);
  const total = ref<number | null>(null);
  const nextCursor = ref<string | null>(null);
  /** 每页起始 cursor；第 1 页为 undefined。 */
  const cursors = ref<Array<string | undefined>>([undefined]);

  const cursor = computed(() => cursors.value[page.value - 1]);
  const hasNext = computed(() => nextCursor.value !== null);

  function reset(): void {
    page.value = 1;
    cursors.value = [undefined];
    nextCursor.value = null;
    total.value = null;
  }

  function apply(meta: CursorPageMeta): void {
    nextCursor.value = meta.nextCursor;
    if (meta.total !== undefined) total.value = meta.total;
    // 回到旧页后重新前进时，丢掉已失效的后续 cursor。
    if (cursors.value.length > page.value) cursors.value = cursors.value.slice(0, page.value);
  }

  function next(): boolean {
    if (nextCursor.value === null) return false;
    cursors.value[page.value] = nextCursor.value;
    page.value += 1;
    return true;
  }

  function prev(): boolean {
    if (page.value <= 1) return false;
    page.value -= 1;
    return true;
  }

  function setPageSize(size: number): void {
    if (size === pageSize.value) return;
    pageSize.value = size;
    reset();
  }

  return { page, pageSize, total, hasNext, cursor, reset, apply, next, prev, setPageSize };
}