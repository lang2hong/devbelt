import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 结果图表多 Y 绑定的契约（源码扫描，与 aiChatLayout/uxSemantics 同一模式：
 * webview 没有挂载环境，不引入新的测试依赖）。
 *
 * 背景：#06295e5 最初用 `:value="yFields"` 绑定 `<select multiple>`。Vue 的
 * patchDOMProp 会 `String(value)`，两个以上选中值被拼成 "a,b"，匹配不到任何
 * option，界面每次多选后清空——多系列功能实际不可用。此处锁定修复后的写法。
 */
const source = readFileSync(resolve(__dirname, '../../webview/src/components/ResultChart.vue'), 'utf8');
const template = source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'));

describe('ResultChart 多 Y 选择绑定', () => {
  it('多选下拉使用 v-model，而不是把数组塞给 :value', () => {
    expect(template).toMatch(/<select\s+v-model="yFields"\s+multiple/);
    expect(template).not.toContain(':value="yFields"');
    expect(source).not.toContain('onYMultiChange');
  });

  it('上限与饼图约束由 watcher 负责', () => {
    expect(source).toContain('MAX_SERIES');
    expect(source).toMatch(/ys\.length > MAX_SERIES/);
    expect(source).toMatch(/isPieLike\.value && ys\.length > 1/);
  });
});
