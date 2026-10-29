// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TelemetryTrendChart from './TelemetryTrendChart.vue';

const points = [
  { day: '2026-10-27', newInstalls: 2, activeInstalls: 5 },
  { day: '2026-10-28', newInstalls: 1, activeInstalls: 7 },
  { day: '2026-10-29', newInstalls: 4, activeInstalls: 6 },
];

describe('TelemetryTrendChart', () => {
  it('渲染柱形、活跃折线和图例', () => {
    const wrapper = mount(TelemetryTrendChart, { props: { points } });
    expect(wrapper.find('svg.plot').exists()).toBe(true);
    expect(wrapper.findAll('.bars rect')).toHaveLength(3);
    expect(wrapper.find('polyline.active-line').exists()).toBe(true);
    expect(wrapper.findAll('.dots circle')).toHaveLength(3);
    expect(wrapper.text()).toContain('新安装');
    expect(wrapper.text()).toContain('活跃安装');
    expect(wrapper.text()).toContain('近 30 天新安装 7');
    expect(wrapper.find('details table').exists()).toBe(true);
    wrapper.unmount();
  });

  it('全为 0 时显示空状态，不画图', () => {
    const wrapper = mount(TelemetryTrendChart, {
      props: { points: points.map((p) => ({ ...p, newInstalls: 0, activeInstalls: 0 })) },
    });
    expect(wrapper.text()).toContain('暂无数据');
    expect(wrapper.find('svg.plot').exists()).toBe(false);
    expect(wrapper.find('details').exists()).toBe(false);
    wrapper.unmount();
  });

  it('数据表列出每个日期（含 0 值）', () => {
    const wrapper = mount(TelemetryTrendChart, { props: { points } });
    const rows = wrapper.findAll('details tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.text()).toContain('2026-10-27');
    wrapper.unmount();
  });
});