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

describe('Page の本文は位置の基準になる（body がスクロールしない）', () => {
  it('本文のスクロール領域が relative と overflow-y-auto を持つ（クラス名の存在のみ。jsdom は配置を測れない）', () => {
    render(
      <Page title="見出し">
        <p data-testid="inner">本文</p>
      </Page>,
    );
    const scroller = screen.getByTestId('inner').parentElement!;
    expect(classesOf(scroller)).toEqual(expect.arrayContaining(['relative', 'overflow-y-auto']));
  });
});

describe('Page の操作（action）の置き場（#2763・#2765）', () => {
  function renderWith(placement?: 'below-on-narrow' | 'side') {
    render(
      <Page
        title="見出し"
        description="説明文"
        action={<button type="button">操作</button>}
        actionPlacement={placement}
      >
        <button type="button">本文の操作</button>
      </Page>,
    );
    return screen.getByRole('banner');
  }

  it('既定は狭い幅で縦並び（下の段）、md 以上は横並び（クラス名の存在のみ。jsdom は配置を測れない）', () => {
    const classes = classesOf(renderWith());
    expect(classes).toContain('flex-col');
    expect(classes).toContain('md:flex-row');
    expect(classes).not.toContain('justify-between');
  });

  it("'side' は狭い幅でも従来どおり横並び", () => {
    const classes = classesOf(renderWith('side'));
    expect(classes).not.toContain('flex-col');
    expect(classes).toContain('justify-between');
  });

  it('DOM の順は 見出し → 説明 → 操作 → 本文（Tab の順が変わらない）', () => {
    const header = renderWith();
    const order = [
      screen.getByRole('heading', { name: '見出し' }),
      screen.getByText('説明文'),
      screen.getByRole('button', { name: '操作' }),
      screen.getByRole('button', { name: '本文の操作' }),
    ];
    expect(header.contains(order[2])).toBe(true);
    for (let i = 0; i < order.length - 1; i++) {
      expect(
        order[i].compareDocumentPosition(order[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });
});
