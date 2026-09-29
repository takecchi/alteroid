// @vitest-environment jsdom
/**
 * ドロワー（`drawer.tsx`）。中身は shadcn の `sheet` ＝ Radix Dialog である。
 *
 * **ここで見るのは「自前では書いていなかったもの」である。** 以前の実装が持って
 * いたのは `role="dialog"` / `aria-modal` / Escape / 閉じているあいだ描かない、の
 * 4つで、下の 3〜5 はどれも無かった。**どれもマウスで触っているかぎり気づけない**
 * （焦点が面の外に残っていても、背後が読み上げに残っていても、画面は正常に見える）
 * ので、置き換えの意味はここにしか出ない。
 *
 * 1. 閉じているあいだは中身を描かない（見えていないリンクを Tab の順路に残さない）
 * 2. 開くと `role="dialog"` が、渡した `label` を名前として出る
 * 3. **開くと焦点が面の中へ移る**（以前は開いたボタンに残ったままだった）
 * 4. **開いているあいだ、面の外は読み上げからも操作からも外れる**（`aria-hidden` と
 *    `pointer-events`）。閉じたら元に戻る
 * 5. Escape と、覆いを押すことで閉じる
 *
 * **覆いを押す筋書きは `pointerDown` → `click` の順で打つ。** Radix は覆いの外し方を
 * `pointerdown` で判断していて、`click` だけでは閉じない（実際に確かめた。jsdom の
 * `click` は `pointerdown` を連れてこない）。ここを `click` 1本に縮めると、
 * 「閉じない」ことを「閉じた」と読み違える試験になる。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Drawer } from './drawer';

/** 開くボタンと、面の外に置いた本文を持つ最小の器。 */
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

/** 開いたところまで進める。開くボタンを返す（焦点がどこへ戻るかを見るため）。 */
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

    // 面の外に置いた本文。`screen.getByText` は aria-hidden でも拾えるので、
    // 「読み上げから外れたか」は属性を辿って見る。
    const outside = screen.getByText('本文');
    const hiddenAncestor = outside.closest('[aria-hidden="true"]');
    expect(hiddenAncestor).not.toBeNull();
    // 面そのものは外れていないこと（外した相手を取り違えていないか）。
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
  fireEvent.pointerDown(overlay!);
  fireEvent.click(overlay!);

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'メニュー' })).toBeNull());
});
