// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Drawer } from './drawer';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <p>本文</p>
      <button type="button" onClick={() => setOpen(true)}>
        開く
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} label="メニュー">
        <nav>
          <a href="/a">行き先A</a>
        </nav>
      </Drawer>
    </div>
  );
}

async function openDrawer(): Promise<HTMLElement> {
  render(<Harness />);
  const opener = screen.getByRole('button', { name: '開く' });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole('dialog', { name: 'メニュー' });
  return opener;
}

afterEach(cleanup);

it('閉じているあいだは中身を描かない（Tab の順路に残さない）', () => {
  render(<Harness />);

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('link', { name: '行き先A' })).toBeNull();
});

it('開くと、渡した label が dialog の名前になる', async () => {
  await openDrawer();

  expect(screen.getByRole('dialog', { name: 'メニュー' })).toBeTruthy();
  expect(screen.getByRole('link', { name: '行き先A' })).toBeTruthy();
});

it('開くと焦点が面の中へ移る（開いたボタンに残らない）', async () => {
  const opener = await openDrawer();

  const dialog = screen.getByRole('dialog', { name: 'メニュー' });
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(opener);
});

describe('開いているあいだ、面の外は読み上げからも操作からも外れる', () => {
  it('外の内容が aria-hidden になり、閉じると戻る', async () => {
    await openDrawer();

    const outside = screen.getByText('本文');
    const hiddenAncestor = outside.closest('[aria-hidden="true"]');
    expect(hiddenAncestor).not.toBeNull();
    const dialog = screen.getByRole('dialog', { name: 'メニュー' });
    expect(dialog.closest('[aria-hidden="true"]')).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(screen.getByText('本文').closest('[aria-hidden="true"]')).toBeNull();
  });

  it('背後が押せなくなり、閉じると戻る', async () => {
    await openDrawer();

    expect(document.body.style.pointerEvents).toBe('none');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    expect(document.body.style.pointerEvents).toBe('');
  });
});

it('Escape で閉じる', async () => {
  await openDrawer();

  fireEvent.keyDown(document, { key: 'Escape' });

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'メニュー' })).toBeNull());
  expect(screen.queryByRole('link', { name: '行き先A' })).toBeNull();
});

it('覆いを押すと閉じる', async () => {
  await openDrawer();

  const overlay = document.querySelector('[data-slot="sheet-overlay"]');
  expect(overlay).not.toBeNull();
  // `pointerDown` → `click` の順で打つ: Radix は覆いの外し方を `pointerdown` で判断し、`click` だけでは閉じないため
  fireEvent.pointerDown(overlay!);
  fireEvent.click(overlay!);

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'メニュー' })).toBeNull());
});
