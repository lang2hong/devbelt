// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import Modal from './Modal.vue';

describe('Modal size', () => {
  it('默认不带 modal-lg（其余弹窗外观不变）', () => {
    const wrapper = mount(Modal, { props: { title: 't' }, attachTo: document.body });
    expect(document.querySelector('.modal')).not.toBeNull();
    expect(document.querySelector('.modal.modal-lg')).toBeNull();
    wrapper.unmount();
  });

  it('size="lg" 加上 modal-lg', () => {
    const wrapper = mount(Modal, { props: { title: 't', size: 'lg' }, attachTo: document.body });
    expect(document.querySelector('.modal.modal-lg')).not.toBeNull();
    wrapper.unmount();
  });
});
