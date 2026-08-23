// @vitest-environment jsdom
/**
 * 画面の枠（`page.tsx`）の横向き safe-area inset（Issue #247 の4）。
 *
 * **これは「切り欠きの側で本文が欠けなくなった」ことの試験ではない。** jsdom は
 * レイアウトを持たず `env(safe-area-inset-*)` を評価できないので、実際に何 px に
 * なるかはここでは測れない。固定できるのは、見出しの帯と本文のスクロール領域の
 * 両方に `--safe-left` / `--safe-right` を使うクラス名が書かれていることまでである
 * （`drawer.test.tsx` の「クラス名の存在のみ」と同じ形）。
 *
 * 縦向きの `--safe-bottom` は本文側に既に当たっていた（`pb-[calc(1rem+var(--safe-bottom))]`）。
 * ここで足したのは横向きぶんで、既存の `p-4` / `md:p-6` と同じ `calc()` の形に揃えてある。
 * 見出しの帯（`header`）は縦の safe-area を持たない（`--safe-top` は shell 側の
 * `MobileTopBar` が持つ）が、左右は本文と同じ幅を占めるので、本文だけに当てると
 * 見出しの文字だけが切り欠きにかぶることになる。だから帯にも当てた。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Page } from './page';

afterEach(cleanup);

function classesOf(element: HTMLElement): string[] {
  return element.className.split(/\s+/);
}

describe('Page の横向き safe-area inset（本4）', () => {
  it('見出しの帯（header）が pl / pr の safe-area クラスを持つ（クラス名の存在のみ）', () => {
    render(
      <Page title="見出し">
        <p>本文</p>
      </Page>,
    );

    const header = screen.getByRole('banner');
    const classes = classesOf(header);
    expect(classes).toContain('pl-[calc(1rem+var(--safe-left))]');
    expect(classes).toContain('pr-[calc(1rem+var(--safe-right))]');
    expect(classes).toContain('md:pl-[calc(1.5rem+var(--safe-left))]');
    expect(classes).toContain('md:pr-[calc(1.5rem+var(--safe-right))]');
  });

  it('本文のスクロール領域が pl / pr の safe-area クラスを持つ（クラス名の存在のみ）', () => {
    render(
      <Page title="見出し">
        <p>本文</p>
      </Page>,
    );

    const body = screen.getByText('本文').parentElement;
    if (body === null) throw new Error('本文の親要素が見つからない');
    const classes = classesOf(body);
    expect(classes).toContain('pl-[calc(1rem+var(--safe-left))]');
    expect(classes).toContain('pr-[calc(1rem+var(--safe-right))]');
    expect(classes).toContain('md:pl-[calc(1.5rem+var(--safe-left))]');
    expect(classes).toContain('md:pr-[calc(1.5rem+var(--safe-right))]');
    // 既存の縦の safe-area（本4の対象外だが、消していないことも一緒に見ておく）。
    expect(classes).toContain('pb-[calc(1rem+var(--safe-bottom))]');
  });
});
