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
  it('provider は表示名で、モデルはそのまま出す', () => {
    const tag = tagOf({ provider: 'claude', model: 'opus' });
    expect(tag.textContent).toBe('Claude·opus');
    expect(tagOf({ provider: 'codex', model: 'x' }).textContent).toBe('Codex·x');
    expect(tagOf({ provider: 'other', model: 'x' }).textContent).toBe('other·x');
    expect(tagOf({ provider: 'constructor', model: 'x' }).textContent).toBe('constructor·x');
    expect(tag.getAttribute('title')).toBe('provider: claude / モデル: opus');
    expect(tag.getAttribute('aria-label')).toBe('provider: claude / モデル: opus');
    expect(tag.className).not.toContain('border-dashed');
  });

  it('どちらも無ければ「不明」と出し、札全体を破線にする', () => {
    const tag = tagOf({});
    expect(tag.textContent).toBe('不明');
    expect(tag.className).toContain('border-dashed');
    expect(tag.getAttribute('title')).toBe(
      'provider: 不明（名乗りを受けていない） / モデル: 不明（名乗りを受けていない）',
    );
  });

  it('片方だけ無いときは、その側だけ「不明」で札は破線にしない', () => {
    const noModel = tagOf({ provider: 'claude' });
    expect(noModel.textContent).toBe('Claude·不明');
    expect(noModel.className).not.toContain('border-dashed');
    expect(noModel.getAttribute('title')).toBe(
      'provider: claude / モデル: 不明（名乗りを受けていない）',
    );
    const noProvider = tagOf({ model: 'opus' });
    expect(noProvider.textContent).toBe('不明·opus');
    expect(noProvider.className).not.toContain('border-dashed');
  });

  it('既定の値で埋めず、色は主色を使わない', () => {
    const tag = tagOf({});
    expect(tag.textContent).not.toMatch(/claude|opus|sonnet/i);
    expect(tagOf({ provider: 'codex', model: 'x' }).className).not.toMatch(/primary|accent/);
  });
});
