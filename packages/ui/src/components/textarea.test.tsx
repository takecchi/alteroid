// @vitest-environment jsdom
/**
 * 共有の `Textarea`（Issue #3236）。⌘/Ctrl + Enter で `onSubmitShortcut`、IME の変換中・`submitDisabled`
 * では呼ばない、`maxHeight` で内容に合わせて伸びる。案内（`SubmitHint`）は OS に合わせ、指だけの端末では隠す。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SubmitHint, Textarea } from './common';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(props: React.ComponentProps<typeof Textarea> = {}) {
  const onSubmitShortcut = vi.fn();
  render(
    <Textarea
      value="本文"
      onChange={() => undefined}
      onSubmitShortcut={onSubmitShortcut}
      {...props}
    />,
  );
  return { onSubmitShortcut, area: screen.getByRole('textbox') as HTMLTextAreaElement };
}

describe('Textarea: 送るキー', () => {
  it('Ctrl + Enter と ⌘ + Enter のどちらでも呼ぶ。Enter・Shift + Enter は呼ばず改行のまま', () => {
    const { onSubmitShortcut, area } = setup();
    expect(fireEvent.keyDown(area, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(area, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(onSubmitShortcut).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true })).toBe(false);
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    expect(onSubmitShortcut).toHaveBeenCalledTimes(2);
  });

  it('IME の変換中（isComposing / keyCode 229）は呼ばない', () => {
    const { onSubmitShortcut, area } = setup();
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(area, { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(onSubmitShortcut).not.toHaveBeenCalled();
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
    expect(onSubmitShortcut).toHaveBeenCalledTimes(1);
  });

  it('submitDisabled のあいだは呼ばない（キーでも、ボタンの disabled を飛び越えない）', () => {
    const { onSubmitShortcut, area } = setup({ submitDisabled: true });
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
    expect(onSubmitShortcut).not.toHaveBeenCalled();
  });

  it('onSubmitShortcut を渡さなければ何もしない。呼ぶ側の onKeyDown が止めたキーには反応しない', () => {
    const onKeyDown = vi.fn((event: React.KeyboardEvent) => event.preventDefault());
    const { onSubmitShortcut, area } = setup({ onKeyDown });
    fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onSubmitShortcut).not.toHaveBeenCalled();
    cleanup();
    render(<Textarea value="x" onChange={() => undefined} />);
    expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true })).toBe(
      true,
    );
  });
});

describe('Textarea: 自動伸長', () => {
  function stubHeights() {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLTextAreaElement,
    ) {
      return this.value.split('\n').length * 20;
    });
  }

  it('maxHeight を渡すと内容に合わせて伸び、上限は style の max-height、超えたら内側スクロール', () => {
    stubHeights();
    const { rerender } = render(
      <Textarea value="a" onChange={() => undefined} maxHeight="12rem" />,
    );
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(area.style.height).toBe('20px');
    expect(area.style.maxHeight).toBe('12rem');
    expect(area.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['resize-none', 'overflow-y-auto']),
    );
    rerender(<Textarea value={'a\nb\nc'} onChange={() => undefined} maxHeight="12rem" />);
    expect(area.style.height).toBe('60px');
  });

  it('maxHeight を渡さなければ高さを測らず、今までどおり縦に引き伸ばせる', () => {
    stubHeights();
    render(<Textarea value={'a\nb'} onChange={() => undefined} />);
    const area = screen.getByRole('textbox');
    expect(area.style.height).toBe('');
    expect(area.className.split(/\s+/)).toContain('resize-y');
  });
});

describe('SubmitHint', () => {
  function stubMedia(touch: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: touch && query === '(pointer: coarse) and (hover: none)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  }

  it('Mac 以外は Ctrl、Mac は ⌘ の案内を出す（動詞は呼ぶ側）', () => {
    render(<SubmitHint action="保存" />);
    expect(screen.getByText('Ctrl + Enter で保存')).toBeTruthy();
    cleanup();
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    render(<SubmitHint action="保存" />);
    expect(screen.getByText('⌘ + Enter で保存')).toBeTruthy();
  });

  it('指だけの端末（pointer: coarse かつ hover: none）では出さない。hover があれば出す', () => {
    stubMedia(true);
    const { container } = render(<SubmitHint action="送信" />);
    expect(container.textContent).toBe('');
    cleanup();
    stubMedia(false);
    render(<SubmitHint action="送信" />);
    expect(screen.getByText('Ctrl + Enter で送信')).toBeTruthy();
  });

  it('matchMedia が無い環境では出す側', () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<SubmitHint action="送信" />);
    expect(screen.getByText('Ctrl + Enter で送信')).toBeTruthy();
  });
});
