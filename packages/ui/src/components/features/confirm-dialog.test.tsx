// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog';

afterEach(cleanup);

function Host({ onCloseAutoFocus }: { onCloseAutoFocus?: (event: Event) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        開く
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="確認"
        confirmLabel="実行する"
        destructive
        onConfirm={() => setOpen(false)}
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      />
    </>
  );
}

async function openDialog(onCloseAutoFocus?: (event: Event) => void) {
  render(<Host {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })} />);
  const opener = screen.getByRole('button', { name: '開く' });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole('alertdialog');
  return opener;
}

describe('閉じたら焦点は開いたボタンへ戻る（body に落とさない）', () => {
  it('Escape で閉じたとき', async () => {
    const opener = await openDialog();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('「やめる」で閉じたとき', async () => {
    const opener = await openDialog();

    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('開いたボタンが無くなっていても、落ちずに閉じる', async () => {
    const opener = await openDialog();
    // DOM から外すと React の片付けが落ちるので、外れた要素の見え方だけを真似る
    Object.defineProperty(opener, 'isConnected', { value: false });
    const focus = vi.spyOn(opener, 'focus');

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(focus).not.toHaveBeenCalled();
  });

  it('呼び出し側が onCloseAutoFocus を渡したら、戻し先はそちらが決める（既定の戻しをしない）', async () => {
    const handler = vi.fn((event: Event) => event.preventDefault());
    const opener = await openDialog(handler);
    const focus = vi.spyOn(opener, 'focus');

    fireEvent.click(screen.getByRole('button', { name: 'やめる' }));

    await waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(focus).not.toHaveBeenCalled();
  });
});
