// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Input } from './common';

afterEach(cleanup);

function setup(props: React.ComponentProps<typeof Input> = {}) {
  const onSubmitShortcut = vi.fn();
  render(
    <Input
      value="本文"
      onChange={() => undefined}
      onSubmitShortcut={onSubmitShortcut}
      {...props}
    />,
  );
  return { onSubmitShortcut, input: screen.getByRole('textbox') as HTMLInputElement };
}

function inForm() {
  const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(
    <form onSubmit={onSubmit}>
      <Input aria-label="欄" value="x" onChange={() => undefined} />
      <button type="submit">送る</button>
    </form>,
  );
  return { onSubmit, input: screen.getByRole('textbox', { name: '欄' }) as HTMLInputElement };
}

describe('Input: 送るキー', () => {
  it('Ctrl + Enter と ⌘ + Enter のどちらでも呼ぶ。Enter・Shift + Enter は呼ばない', () => {
    const { onSubmitShortcut, input } = setup();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSubmitShortcut).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSubmitShortcut).toHaveBeenCalledTimes(2);
  });

  it('IME の変換中（isComposing / keyCode 229）は呼ばない', () => {
    const { onSubmitShortcut, input } = setup();
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(onSubmitShortcut).not.toHaveBeenCalled();
  });

  it('submitDisabled のあいだは呼ばない', () => {
    const { onSubmitShortcut, input } = setup({ submitDisabled: true });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSubmitShortcut).not.toHaveBeenCalled();
  });

  it('呼ぶ側の onKeyDown が止めたキーには反応しない', () => {
    const onKeyDown = vi.fn((event: React.KeyboardEvent) => event.preventDefault());
    const { onSubmitShortcut, input } = setup({ onKeyDown });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onSubmitShortcut).not.toHaveBeenCalled();
  });
});

describe('Input: form の中の Enter', () => {
  // jsdom は Enter から暗黙の送信を起こさないので、ブラウザが送信へ進むかは既定の動作が止められたかで測る
  it('Enter・Shift + Enter は既定の動作（ブラウザの暗黙の送信）を止め、form を送らない', () => {
    const { onSubmit, input } = inForm();
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('IME の確定の Enter は止めない（変換の確定を妨げない）', () => {
    const { onSubmit, input } = inForm();
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('onSubmitShortcut が無ければ、⌘/Ctrl + Enter で form を送る', () => {
    const { onSubmit, input } = inForm();
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('Enter 以外のキーは止めない', () => {
    const { input } = inForm();
    expect(fireEvent.keyDown(input, { key: 'a' })).toBe(true);
  });
});
