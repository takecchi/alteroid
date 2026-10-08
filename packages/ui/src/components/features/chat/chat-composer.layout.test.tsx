// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from './chat-composer';

// jsdom は組版をしないので、幅と高さは測る側の口を差し替えて与える。
// 1行の高さ 24px。写し（見えない div）は改行の数だけ行が増える形にする
const LINE = 24;
const BOX = 300;
const TEXTAREA = 200;
const TOOL = 44;

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function stubLayout() {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName === 'TEXTAREA') return TEXTAREA;
    if (this.dataset.slot === 'chat-composer-row') return BOX;
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.parentElement?.dataset.slot === 'chat-composer-row' && this.tagName === 'DIV'
      ? TOOL
      : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.getAttribute('aria-hidden') !== 'true') return LINE;
    return LINE * (this.textContent ?? '').split('\n').length;
  });
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const style = original(el, pseudo);
    if ((el as Element).tagName !== 'TEXTAREA') return style;
    // 読む欄だけを持つ素の物を返す: 本物の宣言へ書くと jsdom が受け付けないため
    return {
      lineHeight: `${LINE}px`,
      fontSize: '16px',
      paddingLeft: '0px',
      paddingRight: '0px',
      font: '16px sans-serif',
      letterSpacing: 'normal',
    } as unknown as CSSStyleDeclaration;
  });
}

function renderComposer(value: string) {
  const props = {
    onChange: () => undefined,
    onSend: () => undefined,
    onAttach: () => undefined,
  };
  const view = render(<ChatComposer value={value} {...props} />);
  return {
    rerender: (next: string) => view.rerender(<ChatComposer value={next} {...props} />),
  };
}

const row = () => document.querySelector('[data-slot="chat-composer-row"]') as HTMLElement;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChatComposer: 狭い画面の1行の並び', () => {
  it('空なら1行の並び（[+] 入力 [送信]）', () => {
    stubLayout();
    renderComposer('');
    expect(row().dataset.layout).toBe('one-line');
  });

  it('改行で2行になったら2段に替わり、1行へ戻せば1行の並びへ戻る', () => {
    stubLayout();
    const { rerender } = renderComposer('こんにちは');
    expect(row().dataset.layout).toBe('one-line');
    rerender('こんにちは\n二行目');
    expect(row().dataset.layout).toBe('stacked');
    rerender('こんにちは');
    expect(row().dataset.layout).toBe('one-line');
  });

  it('末尾が改行だけでも2行と数える（改行した直後にボタンが下へ移る）', () => {
    stubLayout();
    const { rerender } = renderComposer('こんにちは');
    rerender('こんにちは\n');
    expect(row().dataset.layout).toBe('stacked');
  });

  it('幅が測れない（描かれていない）ときは決めず、1行の並びのまま', () => {
    renderComposer('こんにちは\n二行目');
    expect(row().dataset.layout).toBe('one-line');
  });

  // 広い画面は今のまま（常に2段）にする: 1行の並びの class は全部 `max-md:` 付きで足す
  it('1行の並びで足す class は狭い画面（max-md）にだけ効く', () => {
    stubLayout();
    const { rerender } = renderComposer('こんにちは\n二行目');
    const stacked = new Set(row().className.split(/\s+/));
    rerender('');
    const added = row()
      .className.split(/\s+/)
      .filter((name) => !stacked.has(name));
    expect(added.length).toBeGreaterThan(0);
    for (const name of added) expect(name.startsWith('max-md:')).toBe(true);
  });

  it('並びを替えても入力欄は同じ要素のまま（カーソルと変換を外さない）', () => {
    stubLayout();
    const { rerender } = renderComposer('こんにちは');
    const before = screen.getByRole('textbox');
    rerender('こんにちは\n二行目');
    expect(row().dataset.layout).toBe('stacked');
    expect(screen.getByRole('textbox')).toBe(before);
  });
});

describe('ChatComposer: 下の余白', () => {
  // 足すと、ホームインジケータの取り分の上にさらに 12px 空く（2026-10-08 のオーナーの指摘）
  it('セーフエリアと 0.75rem の大きいほうだけを取り、足さない', () => {
    renderComposer('');
    const outer = row().closest('[data-slot="chat-composer-frame"]')?.parentElement;
    expect(outer?.className).toContain('pb-[max(0.75rem,var(--safe-bottom))]');
    expect(outer?.className).not.toContain('calc(0.75rem+var(--safe-bottom))');
  });
});
