// @vitest-environment jsdom
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
    expect(send.getAttribute('aria-keyshortcuts')).toBe('Meta+Enter Control+Enter');
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
  it.each([
    ['Mac 以外', ''],
    ['Mac', 'MacIntel'],
  ])(
    '%s: Ctrl + Enter でも ⌘ + Enter でも送る。Enter・Shift + Enter では送らない',
    (_n, platform) => {
      if (platform !== '') setPlatform(platform);
      const { onSend, textbox } = setup();
      expect(fireEvent.keyDown(textbox, { key: 'Enter' })).toBe(true);
      expect(fireEvent.keyDown(textbox, { key: 'Enter', shiftKey: true })).toBe(true);
      expect(onSend).not.toHaveBeenCalled();
      fireEvent.keyDown(textbox, { key: 'Enter', ctrlKey: true });
      fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true });
      expect(onSend).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['⌘', { metaKey: true }],
  ])(
    '%s + Enter: IME 変換中（isComposing / keyCode 229）の送信ショートカットでは送らない',
    (_n, mod) => {
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
    fireEvent.click(
      screen.getByRole('button', { name: '受信をやめる（クローンのターンは止まらない）' }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('受信中: 「受信をやめる」は送信と同じくアイコンだけの丸いボタンで、aria-label とヒントが同じ文', () => {
    setup({ sending: true, onStopReceiving: vi.fn() });
    const stop = screen.getByRole('button', {
      name: '受信をやめる（クローンのターンは止まらない）',
    });
    expect(stop.textContent).toBe('');
    expect(stop.querySelector('svg')).not.toBeNull();
    expect(stop.getAttribute('aria-label')).toBe('受信をやめる（クローンのターンは止まらない）');
    for (const cls of ['size-11', 'rounded-full', 'md:size-8']) {
      expect(stop.classList.contains(cls)).toBe(true);
    }
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => stop.focus());
    expect(screen.getByRole('tooltip').textContent).toBe(
      '受信をやめる（クローンのターンは止まらない）',
    );
  });

  it('受信中: 「受信をやめる」もホバーでヒントが出る（遅延のあと）', () => {
    setup({ sending: true, onStopReceiving: vi.fn() });
    const trigger = screen.getByRole('button', {
      name: '受信をやめる（クローンのターンは止まらない）',
    }).parentElement!;
    fireEvent.pointerMove(trigger, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip').textContent).toBe(
      '受信をやめる（クローンのターンは止まらない）',
    );
  });
});

describe('ChatComposer: 指だけの端末', () => {
  function stubTouchOnly(touch: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: touch && query === '(pointer: coarse) and (hover: none)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  }

  it('キーボードの案内を隠す。ボタンの aria-label とヒントは残り、ヒントにショートカットは添えない', () => {
    stubTouchOnly(true);
    const { textbox } = setup();
    expect(screen.queryByText(/Enter で送信/)).toBeNull();
    expect(textbox.getAttribute('aria-describedby')).toBeNull();
    const send = screen.getByRole('button', { name: 'メッセージを送信' });
    act(() => send.focus());
    expect(screen.getByRole('tooltip').textContent).toBe('メッセージを送信');
  });

  it('陰性対照: マウスのある端末（hover あり）では出す', () => {
    stubTouchOnly(false);
    setup();
    expect(screen.getByText('Ctrl + Enter で送信')).toBeTruthy();
  });
});
