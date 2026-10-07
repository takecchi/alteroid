// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';

import { Drawer } from './drawer';

const AUTOFOCUS_ON_UNMOUNT = 'focusScope.autoFocusOnUnmount';

// テスト2本にまたがる: テストの境での消化は1本の中から見えず、1本にすると消化を止めても緑のままになるため
let deferredCleanup: 'not-armed' | 'pending' | 'fired' = 'not-armed';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
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

afterEach(cleanup);

it('ドロワーを閉じても、焦点の後始末は同期では終わっていない（macrotask へ逃げている）', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '開く' }));
  const panel = await screen.findByRole('dialog', { name: 'メニュー' });
  panel.addEventListener(AUTOFOCUS_ON_UNMOUNT, () => {
    deferredCleanup = 'fired';
  });

  deferredCleanup = 'pending';
  cleanup();

  expect(deferredCleanup).toBe('pending');
});

it('前のテストが残した後始末は、次のテストが始まる前に消化されている', () => {
  expect(deferredCleanup).not.toBe('not-armed');
  expect(deferredCleanup).toBe('fired');
});
