// @vitest-environment jsdom
/**
 * `apps/web/app/components/ui.tsx` の共有部品が、モバイル対応で入れた
 * クラス名を保ち続けることを固定する（本3「共有部品の土台」）。
 *
 * **⚠️ これは「はみ出しが直った」「タップ標的が実際に44pxある」の試験ではない。**
 * jsdom はレイアウトを持たないので（`offsetWidth` / `scrollWidth` /
 * `getBoundingClientRect()` はどれも 0 を返す。このリポジトリの `jsdom@30.0.1`
 * で実測済み）、ここで固定できるのは「そのクラス名が書かれていること」までである。
 * 実機で崩れていないかは、見た人間にしか言えない（`git show 86ff7d1` と同じ形）。
 *
 * それでも置くのは、この直しを戻す変更（`h-11` を消す・`shrink-0` を消す）を
 * 黙って通さないためである。見た目の差は誰も測れないので、戻っても気づく
 * 契機が他に無い。
 *
 * **クラス名は `className.split(/\s+/)` でトークンに割ってから見る。**
 * 文字列の部分一致（`toContain`）だけで見ると、`h-9` を探すつもりが `h-9` を
 * 含む他のトークンに当たる／`whitespace-nowrap` を探すつもりで
 * `whitespace-pre-wrap` にも当たる、という罠がある
 * （`apps/web/app/routes/usage.test.tsx` で実際に踏まれた形）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Badge, Button } from './ui';

afterEach(() => {
  cleanup();
});

describe('Button のタップ標的（狭い画面で44px）', () => {
  /**
   * 狭い画面（`md` 未満）でタップ標的が44px（`h-11`）を満たすことを固定する。
   * `apps/web/app/routes/shell.tsx` が既に使っている基準（WCAG 2.5.5 /
   * Apple HIG の下限）に、共有の `Button` を合わせた変更である。
   *
   * **広い画面（`md:` 以上）の見た目は変えていないこと**も同時に見る —
   * 依頼は「スマホ表示」なので、デスクトップまで背を高くするのは依頼より広い。
   */
  it('size="sm" は基準の高さを持ち、md: で元の高さへ戻す', () => {
    render(<Button size="sm">送信</Button>);

    const button = screen.getByRole('button', { name: '送信' });
    const tokens = button.className.split(/\s+/);

    // 狭い画面（既定）で44px。
    expect(tokens).toContain('h-11');
    // 広い画面（`md:` 768px以上）は元の28pxのまま。
    expect(tokens).toContain('md:h-7');
    expect(tokens).toContain('md:px-2');
    // デスクトップ側の高さ指定がそのまま残っていないこと
    // （`md:` 無しの `h-7` が残っていたら、狭い画面の `h-11` と衝突する）。
    expect(tokens).not.toContain('h-7');
  });

  it('size="md"（既定）も同じ形で44pxへ持ち上げてある', () => {
    render(<Button>送信</Button>);

    const button = screen.getByRole('button', { name: '送信' });
    const tokens = button.className.split(/\s+/);

    expect(tokens).toContain('h-11');
    expect(tokens).toContain('md:h-9');
    expect(tokens).not.toContain('h-9');
  });
});

describe('Badge の潰れ（flex 行の中で縮まない）', () => {
  /**
   * `shrink-0` だけを固定する。**`whitespace-nowrap` は意図的に入れていない**
   * — `apps/web/app/routes/commitments.tsx` の `OriginBadge` は
   * `commitment.source`（`z.string().optional()`、長さの制約なし）を、
   * `apps/web/app/routes/settings.tsx` の資格情報一覧は `credential.name`
   * （`CREDENTIAL_NAME` 正規表現に長さの上限が無い）をそのまま中身にしており、
   * 折り返さない指定は可変の長文が来たときにはみ出しを直すどころか作る側へ
   * 振れる。**この不在も、戻す変更（`whitespace-nowrap` を足す）を黙って
   * 通さないために固定する。**
   */
  it('flex 行の中で縮まないが、折り返し禁止は付けていない', () => {
    render(<Badge>状態</Badge>);

    const badge = screen.getByText('状態');
    const tokens = badge.className.split(/\s+/);

    expect(tokens).toContain('shrink-0');
    expect(tokens).not.toContain('whitespace-nowrap');
  });
});
