// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';

vi.mock('../api/admin', () => ({ listPlans: vi.fn(), updatePlan: vi.fn() }));
vi.mock('@devbelt/auth-client', async (importOriginal) => ({
  ...(await importOriginal()), ensureCsrf: vi.fn(async () => 'csrf') }));

import { listPlans, updatePlan } from '../api/admin';
import AdminPlansView from './AdminPlansView.vue';

const PLAN = {
  id: 2, code: 'pro', kind: 'personal', name: 'Pro', priceCents: 9900, billingUnit: 'month',
  sortOrder: 0, status: 'active', version: 3, features: { maxSavedConnections: 100, allowConnectionImport: true },
};
const DEFS = [
  { id: 1, key: 'maxSavedConnections', kind: 'personal', label: { en: 'Saved', zh: '保存' }, valueType: 'number', unit: 'count', sortOrder: 10 },
  { id: 2, key: 'allowConnectionImport', kind: 'personal', label: { en: 'Import', zh: '导入' }, valueType: 'bool', unit: null, sortOrder: 20 },
];

beforeEach(() => {
  vi.mocked(listPlans).mockReset();
  vi.mocked(updatePlan).mockReset();
});

describe('AdminPlansView', () => {
  it('lists plans and saves with the entered reason', async () => {
    vi.mocked(listPlans).mockResolvedValue({ kind: 'ok', value: { items: [PLAN], featureDefs: DEFS } });
    vi.mocked(updatePlan).mockResolvedValue({ kind: 'ok', value: { plan: { ...PLAN, version: 4 } } });

    const wrapper = mount(AdminPlansView);
    await flushPromises();
    expect(wrapper.text()).toContain('Pro');

    const reason = wrapper.find('[data-testid="reason"]');
    await reason.setValue('raise saved connections');
    await wrapper.findAll('button').find((b) => b.text().includes('保存'))!.trigger('click');
    await flushPromises();

    expect(updatePlan).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(updatePlan).mock.calls[0];
    expect(payload.reason).toBe('raise saved connections');
    expect(payload.expectedVersion).toBe(3);
    expect(wrapper.text()).toContain('已保存');
  });

  it('shows a version-conflict message on 409', async () => {
    vi.mocked(listPlans).mockResolvedValue({ kind: 'ok', value: { items: [PLAN], featureDefs: DEFS } });
    vi.mocked(updatePlan).mockResolvedValue({ kind: 'conflict' });

    const wrapper = mount(AdminPlansView);
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text().includes('保存'))!.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('版本冲突');
  });
});