// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { h } from 'vue';
import Modal from './Modal.vue';

function esc() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function maskClick() {
  const mask = document.querySelector('.modal-mask');
  mask?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Modal', () => {
  it('Esc closes when closable', async () => {
    const wrapper = mount(Modal, { props: { title: '确认' }, attachTo: document.body });
    await flushPromises();
    esc();
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });

  it('Esc does not close when closable=false', async () => {
    const wrapper = mount(Modal, { props: { title: '确认', closable: false }, attachTo: document.body });
    await flushPromises();
    esc();
    expect(wrapper.emitted('close')).toBeUndefined();
    wrapper.unmount();
  });

  it('backdrop click closes only when closable', async () => {
    const a = mount(Modal, { props: { closable: true }, attachTo: document.body });
    await flushPromises();
    maskClick();
    expect(a.emitted('close')).toHaveLength(1);
    a.unmount();
    document.body.innerHTML = '';

    const b = mount(Modal, { props: { closable: false }, attachTo: document.body });
    await flushPromises();
    maskClick();
    expect(b.emitted('close')).toBeUndefined();
    b.unmount();
  });

  it('moves focus into the dialog on mount', async () => {
    const wrapper = mount(Modal, { props: { title: '确认' }, attachTo: document.body });
    await flushPromises();
    const modalEl = document.querySelector('.modal');
    expect(modalEl).toBeTruthy();
    expect(document.activeElement).toBe(modalEl);
    wrapper.unmount();
  });

  it('tab cycles within the dialog, skipping disabled controls', async () => {
    const wrapper = mount(Modal, {
      props: { title: '确认' },
      attachTo: document.body,
      slots: { default: () => [h('button', { class: 'a' }, 'A'), h('button', { class: 'b', disabled: '' }, 'B'), h('button', { class: 'c' }, 'C')] },
    });
    await flushPromises();

    const a = document.querySelector<HTMLElement>('.a')!;
    const c = document.querySelector<HTMLElement>('.c')!;
    c.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(a);

    a.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(c);
    wrapper.unmount();
  });

  it('tab from outside the dialog pulls focus back to the first control', async () => {
    const wrapper = mount(Modal, {
      props: { title: '确认' },
      attachTo: document.body,
      slots: { default: () => [h('button', { class: 'a' }, 'A'), h('button', { class: 'c' }, 'C')] },
    });
    await flushPromises();

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(document.querySelector('.a'));
    outside.remove();
    wrapper.unmount();
  });

  it('restores focus to the previous element on unmount', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    const wrapper = mount(Modal, { props: { title: '确认' }, attachTo: document.body });
    await flushPromises();
    expect(document.activeElement).not.toBe(trigger);

    wrapper.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});