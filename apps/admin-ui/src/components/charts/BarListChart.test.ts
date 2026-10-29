// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import BarListChart from './BarListChart.vue';

describe('BarListChart', () => {
  it('按最大值归一化宽度并显示数值', () => {
    const wrapper = mount(BarListChart, {
      props: {
        items: [
          { label: '0.4.1', value: 10 },
          { label: '0.4.0', value: 5 },
        ],
      },
    });
    const bars = wrapper.findAll('.bar');
    expect(bars).toHaveLength(2);
    expect((bars[0]!.element as HTMLElement).style.width).toBe('100%');
    expect((bars[1]!.element as HTMLElement).style.width).toBe('50%');
    expect(wrapper.text()).toContain('0.4.1');
    wrapper.unmount();
  });

  it('空列表显示空状态与备注', () => {
    const wrapper = mount(BarListChart, { props: { items: [], note: '滚动窗口' } });
    expect(wrapper.text()).toContain('暂无数据');
    expect(wrapper.text()).not.toContain('滚动窗口');
    wrapper.unmount();
  });
});