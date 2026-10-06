// @vitest-environment jsdom
/**
 * `ChatComposer` の添付の口（Issue #3111 段1c）。選択・貼り付け・ドロップが `onAttach` に届くこと、
 * チップ（遅延読み込み）が出ること、上げているあいだは送れないこと。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer } from './chat-composer';

afterEach(cleanup);

const file = (name: string) => new File(['x'], name, { type: 'text/plain' });

describe('ChatComposer: 添付', () => {
  it('onAttach を渡さなければ、添付のボタンは出ない', () => {
    render(<ChatComposer value="x" onChange={() => undefined} onSend={() => undefined} />);
    expect(screen.queryByRole('button', { name: 'ファイルを添付' })).toBeNull();
  });

  it('ボタンから隠した input を開き、選んだファイルを onAttach へ渡す', () => {
    const onAttach = vi.fn();
    const { container } = render(
      <ChatComposer
        value=""
        onChange={() => undefined}
        onSend={() => undefined}
        onAttach={onAttach}
      />,
    );
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    expect(input.multiple).toBe(true);
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByRole('button', { name: 'ファイルを添付' }));
    expect(click).toHaveBeenCalled();
    Object.defineProperty(input, 'files', { value: [file('a.txt')], configurable: true });
    fireEvent.change(input);
    expect(onAttach).toHaveBeenCalledWith([expect.objectContaining({ name: 'a.txt' })]);
  });

  it('チップに名前・大きさ・外すボタンを出し、外すと onRemoveAttachment が呼ばれる', async () => {
    const onRemove = vi.fn();
    render(
      <ChatComposer
        value=""
        onChange={() => undefined}
        onSend={() => undefined}
        onAttach={() => undefined}
        attachments={[{ key: 'k1', name: 'a.txt', sizeLabel: '1 B' }]}
        onRemoveAttachment={onRemove}
      />,
    );
    expect(await screen.findByText('a.txt')).toBeTruthy();
    expect(screen.getByText('1 B')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'a.txt を外す' }));
    expect(onRemove).toHaveBeenCalledWith('k1');
  });

  it('上げているあいだは送れず、添付のボタンも止まる', () => {
    const onSend = vi.fn();
    render(
      <ChatComposer
        value="本文"
        onChange={() => undefined}
        onSend={onSend}
        onAttach={() => undefined}
        uploading
      />,
    );
    expect(
      (screen.getByRole('button', { name: '添付を上げている' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'ファイルを添付' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('ChatComposer: 添付のチップの並び（#3402 / #3401）', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    key: `k${i}`,
    name: `${'x'.repeat(100)}-${i}.pdf`,
    sizeLabel: '1 MB',
  }));

  it('チップの並びは高さに上限があり、内側をスクロールする（入力欄を押し広げない）', async () => {
    render(
      <ChatComposer
        value=""
        onChange={() => undefined}
        onSend={() => undefined}
        onAttach={() => undefined}
        attachments={items}
      />,
    );
    const list = await screen.findByRole('list', { name: '添付' });
    const classes = (list.getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toContain('overflow-y-auto');
    expect(classes.some((name) => name.startsWith('max-h-'))).toBe(true);
    // 10 件とも並ぶ（畳んで隠さない）。
    expect(list.querySelectorAll('li')).toHaveLength(10);
  });

  it('長い名前は切れるが、title に全体が入る', async () => {
    render(
      <ChatComposer
        value=""
        onChange={() => undefined}
        onSend={() => undefined}
        onAttach={() => undefined}
        attachments={items.slice(0, 1)}
      />,
    );
    const name = await screen.findByTitle(items[0]?.name ?? '');
    expect(name.textContent).toBe(items[0]?.name);
  });
});
