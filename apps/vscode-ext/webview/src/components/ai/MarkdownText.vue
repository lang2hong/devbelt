<script setup lang="ts">
import { computed } from 'vue';
import { parseInlineSegments } from '../../utils/aiChatStream';

/**
 * 行内 Markdown 渲染：text / code / strong / em / link。
 * 模型输出属于不可信内容，只用 Vue 文本插值，不使用 v-html；
 * 链接只接受 http/https（解析层已过滤）。
 */
const props = defineProps<{ text: string }>();
const segments = computed(() => parseInlineSegments(props.text));
</script>

<template>
  <template v-for="(seg, index) in segments" :key="index">
    <code v-if="seg.type === 'code'" class="md-code">{{ seg.content }}</code>
    <strong v-else-if="seg.type === 'strong'">{{ seg.content }}</strong>
    <em v-else-if="seg.type === 'em'">{{ seg.content }}</em>
    <a v-else-if="seg.type === 'link'" class="md-link" :href="seg.href" target="_blank" rel="noreferrer">{{ seg.content }}</a>
    <span v-else>{{ seg.content }}</span>
  </template>
</template>

<style scoped>
.md-code {
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12));
  padding: 1px 5px;
  border-radius: 5px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
}
.md-link { color: var(--vscode-textLink-foreground, #3794ff); text-decoration: none; }
.md-link:hover { text-decoration: underline; }
</style>