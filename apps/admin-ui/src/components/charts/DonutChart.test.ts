// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DonutChart from './DonutChart.vue';

describe('DonutChart', () => {
  it('渲染分段、图例、中心合计', () => {
    const wrapper = mount(DonutChart, {
      props: {
        items: [
          { label: '套餐', value: 9100, color: '#111111' },
          { label: 'AI 充值', value: 900, color: '#222222' },
        ],
        centerLabel: '营收',
        kind: 'money',
      },
    });
    expect(wrapper.findAll('.ring-seg')).toHaveLength(2);
    expect(wrapper.text()).toContain('套餐');
    expect(wrapper.text()).toContain('¥100.00');
    expect(wrapper.text()).toContain('91%');
    wrapper.unmount();
  });

  it('全为 0 时显示空状态', () => {
    const wrapper = mount(DonutChart, { props: { items: [{ label: 'x', value: 0 }] } });
    expect(wrapper.text()).toContain('暂无数据');
    expect(wrapper.find('.ring-seg').exists()).toBe(false);
    wrapper.unmount();
  });
});