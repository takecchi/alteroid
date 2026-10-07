// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentModelTag } from './agent-model-tag';

afterEach(() => {
  cleanup();
});

function tagOf(props: Parameters<typeof AgentModelTag>[0]) {
  const { container } = render(<AgentModelTag {...props} />);
  return container.firstElementChild as HTMLElement;
}

describe('AgentModelTag', () => {
  it('固定の「Claude」の隣にモデルをそのまま出す', () => {
    const tag = tagOf({ model: 'opus' });
    expect(tag.textContent).toBe('Claude·opus');
    expect(tagOf({ model: 'constructor' }).textContent).toBe('Claude·constructor');
    expect(tag.getAttribute('title')).toBe('モデル: opus（層は Claude で動く）');
    expect(tag.getAttribute('aria-label')).toBe('モデル: opus（層は Claude で動く）');
    expect(tag.className).not.toContain('border-dashed');
  });

  it('モデルが無ければ「不明」だけを出し、札全体を破線にする（Claude とは言い切らない）', () => {
    const tag = tagOf({});
    expect(tag.textContent).toBe('不明');
    expect(tag.className).toContain('border-dashed');
    expect(tag.getAttribute('title')).toBe('モデル: 不明（名乗りを受けていない）');
    expect(tag.getAttribute('aria-label')).toBe('モデル: 不明（名乗りを受けていない）');
  });

  it('既定の値で埋めず、色は主色を使わない', () => {
    expect(tagOf({}).textContent).not.toMatch(/claude|opus|sonnet/i);
    expect(tagOf({ model: 'x' }).className).not.toMatch(/primary|accent/);
  });
});
