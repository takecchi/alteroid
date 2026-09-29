// @vitest-environment jsdom
/**
 * **ドロワーを閉じた後に残る後始末が、テストの外へ漏れないこと。**
 *
 * Radix の `FocusScope` は unmount の後始末（元の場所へ焦点を戻す）を
 * `setTimeout(..., 0)` へ逃がす。`cleanup()` はそれを消化しないので、テストが
 * 終わっても macrotask が積まれたまま残る。残った先で発火すると
 * `container.dispatchEvent(new CustomEvent(...))` が
 * `parameter 1 is not of type 'Event'` で投げ、**集計行が全部 passed を
 * 名乗ったまま走行が exit 1 になる**（`vitest.setup.ts` の doc に現物を写してある）。
 *
 * 消化しているのは root の `vitest.setup.ts`（global setup）の `afterEach` で、
 * **ここはその効き目を外から見る歯である。**
 *
 * ## なぜテスト2本にまたがるのか
 *
 * 見たいのは「**テストとテストの境で消化されていること**」そのもので、それは
 * 1本の中からは見えない（自分の `afterEach` はまだ走っていない）。
 * 1本目で仕掛けて2本目で読む形にしてある。**この形以外だと、消化を止めても
 * 緑のままになる**（実際に `vitest.setup.ts` の `afterEach` を外して確かめた:
 * 2本目が `pending` のまま赤くなる）。
 *
 * ## ここで言えること / 言えないこと
 *
 * 言えるのは「Radix が積んだ macrotask が、次のテストが始まる前には発火して
 * いる」ことまで。**「CI の間欠がこれで0になる」はここでは言えない**（間欠は
 * 走行全体のタイミングに依るので、1ファイルの中では踏めない）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';

import { Drawer } from './drawer';

/**
 * Radix `FocusScope` が unmount のときに `container` へ投げるイベントの名前
 * （`@radix-ui/react-focus-scope` の `AUTOFOCUS_ON_UNMOUNT`）。**これが投げられる
 * ＝ 逃がされた後始末が走った**、の合図として使う。
 */
const AUTOFOCUS_ON_UNMOUNT = 'focusScope.autoFocusOnUnmount';

/** 1本目が仕掛けて2本目が読む。`not-armed` のまま2本目に来たら1本目が壊れている。 */
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

  // ここが 'fired' になるなら Radix が同期で片付けるようになったということで、
  // 下の歯（と global setup の消化）はもう要らない。**そのときはこの歯が赤くなる。**
  expect(deferredCleanup).toBe('pending');
});

it('前のテストが残した後始末は、次のテストが始まる前に消化されている', () => {
  // 'not-armed' なら1本目が仕掛けに失敗している（＝この歯は何も測れていない）。
  expect(deferredCleanup).not.toBe('not-armed');
  expect(deferredCleanup).toBe('fired');
});
