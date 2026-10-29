// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DailyBarChart from './DailyBarChart.vue';

const points = [
  { day: '2026-10-27', planCents: 9900, topupCents: 0 },
  { day: '2026-10-28', planCents: 0, topupCents: 900 },
  { day: '2026-10-29', planCents: 5000, topupCents: 100 },
];

describe('DailyBarChart', () => {
  it('堆叠渲染两组序列并按天出柱', () => {
    const wrapper = mount(DailyBarChart, {
      props: {
        points,
        series: [{ key: 'planCents', label: '套餐' }, { key: 'topupCents', label: 'AI 充值' }],
        stacked: true,
        kind: 'money',
      },
    });
    // 6 个非零分段
    expect(wrapper.findAll('.bars rect')).toHaveLength(4);
    expect(wrapper.text()).toContain('套餐');
    expect(wrapper.text()).toContain('¥149.00');
    expect(wrapper.findAll('details tbody tr')).toHaveLength(3);
    wrapper.unmount();
  });

  it('单序列渲染 3 根柱', () => {
    const wrapper = mount(DailyBarChart, {
      props: {
        points: points.map((p) => ({ day: p.day, newUsers: p.planCents / 100 })),
        series: [{ key: 'newUsers', label: '新增用户' }],
      },
    });
    expect(wrapper.findAll('.bars rect')).toHaveLength(2);
    wrapper.unmount();
  });

  it('全为 0 时显示空状态', () => {
    const wrapper = mount(DailyBarChart, {
      props: {
        points: points.map((p) => ({ day: p.day, tokens: 0 })),
        series: [{ key: 'tokens', label: 'tokens' }],
      },
    });
    expect(wrapper.text()).toContain('暂无数据');
    expect(wrapper.find('svg.plot').exists()).toBe(false);
    wrapper.unmount();
  });
});