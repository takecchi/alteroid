// @vitest-environment jsdom
/**
 * `ChatComposer` の作り直し（Issue #3224）。ボタンの名前とヒント、送信のショートカット
 * （Mac は ⌘ + Enter だけ、それ以外は Ctrl + Enter だけ。Enter・Shift + Enter では送らない）、
 * 案内の文、IME 変換中の扱い、`disabled`。実時間は待たない（ヒントは偽の時計とフォーカスで出す）。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from './chat-composer';

function setPlatform(platform: string) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
}

function setup(props: Partial<React.ComponentProps<typeof ChatComposer>> = {}) {
  const onSend = vi.fn();
  render(
    <ChatComposer
      value="こんにちは"
      onChange={() => undefined}
      onSend={onSend}
      onAttach={() => undefined}
      {...props}
    />,
  );
  return { onSend, textbox: screen.getByRole('textbox') as HTMLTextAreaElement };
}

/** Radix の吹き出しの位置決めが要る。jsdom には無いので、何もしない版を置く。 */
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ChatComposer: ボタンの名前とヒント', () => {
  it('[+] は「ファイルを添付」、[▶] は「メッセージを送信」の aria-label を持つ', () => {
    setup();
    expect(screen.getByRole('button', { name: 'ファイルを添付' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'メッセージを送信' })).toBeTruthy();
  });

  it('キーボードのフォーカスでヒントが出る（[+]）', () => {
    setup();
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => screen.getByRole('button', { name: 'ファイルを添付' }).focus());
    expect(screen.getByRole('tooltip').textContent).toBe('ファイルを添付');
  });

  it('キーボードのフォーカスでヒントが出る（[▶]。ショートカットを添える）', () => {
    setup();
    act(() => screen.getByRole('button', { name: 'メッセージを送信' }).focus());
    expect(screen.getByRole('tooltip').textContent).toBe('メッセージを送信（Ctrl + Enter）');
  });

  it('ホバーで出る（遅延のあと）', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'ファイルを添付' }).parentElement!;
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('ファイルを添付');
  });

  it('Mac ではヒントと案内が ⌘ + Enter になる。aria-label は変わらない', () => {
    setPlatform('MacIntel');
    setup();
    expect(screen.getByText('⌘ + Enter で送信')).toBeTruthy();
    const send = screen.getByRole('button', { name: 'メッセージを送信' });
    expect(send.getAttribute('aria-keyshortcuts')).toBe('Meta+Enter');
    act(() => send.focus());
    expect(screen.getByRole('tooltip').textContent).toBe('メッセージを送信（⌘ + Enter）');
  });

  it('onAttach が無ければ [+] は出ない', () => {
    setup({ onAttach: undefined });
    expect(screen.queryByRole('button', { name: 'ファイルを添付' })).toBeNull();
  });
});

describe('ChatComposer: 案内の文', () => {
  it('Mac 以外は「Ctrl + Enter で送信」。「Shift + Enter で改行」は出さない', () => {
    setup();
    expect(screen.getByText('Ctrl + Enter で送信')).toBeTruthy();
    expect(screen.queryByText(/Shift/)).toBeNull();
  });

  it('入力欄が案内を aria-describedby で指す', () => {
    const { textbox } = setup();
    const id = textbox.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(id)?.textContent).toBe('Ctrl + Enter で送信');
  });
});

describe('ChatComposer: 送信のキー', () => {
  it('Mac 以外: Ctrl + Enter だけが送る（Enter・Shift + Enter・⌘ + Enter は送らない）', () => {
    const { onSend, textbox } = setup();
    // 既定動作を止めない = 改行が生きている
    expect(fireEvent.keyDown(textbox, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })).toBe(true);
    fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('Mac: ⌘ + Enter だけが送る（Ctrl + Enter・Enter・Shift + Enter は送らない）', () => {
    setPlatform('MacIntel');
    const { onSend, textbox } = setup();
    fireEvent.keyDown(textbox, { key: 'Enter' });
    fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Mac 以外', '', { ctrlKey: true }],
    ['Mac', 'MacIntel', { metaKey: true }],
  ])(
    '%s: IME 変換中（isComposing / keyCode 229）の送信ショートカットでは送らない',
    (_n, platform, mod) => {
      if (platform !== '') setPlatform(platform);
      const { onSend, textbox } = setup();
      fireEvent.keyDown(textbox, { key: 'Enter', ...mod, isComposing: true });
      fireEvent.keyDown(textbox, { key: 'Enter', ...mod, keyCode: 229 });
      expect(onSend).not.toHaveBeenCalled();
      fireEvent.keyDown(textbox, { key: 'Enter', ...mod });
      expect(onSend).toHaveBeenCalledTimes(1);
    },
  );

  it('空の本文（添付も無い）ではショートカットでも送らない', () => {
    const { onSend, textbox } = setup({ value: ' ' });
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('添付だけでも送れる', () => {
    const { onSend } = setup({
      value: '',
      attachments: [{ key: 'k', name: 'a.txt', sizeLabel: '1 B' }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送信' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

describe('ChatComposer: 無効・送信中', () => {
  it('disabled: 入力・[+]・送信が止まり、ショートカットでも送らない', () => {
    const { onSend, textbox } = setup({ disabled: true });
    expect(textbox.disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'ファイルを添付' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'メッセージを送信' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('uploading: ショートカットでも送らない（二重に上げない）', () => {
    const { onSend, textbox } = setup({ uploading: true });
    fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('受信中: 「受信をやめる」を並べて出し、押せる', () => {
    const stop = vi.fn();
    setup({ sending: true, onStopReceiving: stop });
    fireEvent.click(screen.getByRole('button', { name: '受信をやめる' }));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
