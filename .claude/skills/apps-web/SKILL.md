---
name: apps-web
description: apps/web（Web UI）を触るときに読む。jsdom に無い口を埋める共有の足場 test-support.tsx と、自前スタブを書いてはいけない理由、components.json の "style" を消すと次の shadcn add から静かに別物が来ること。基底の grid-cols-* を持たない grid を検出する歯を作らないと決めた理由。
---

# apps/web を触るときに知っておくこと

<!-- AGENTS.md「apps/web」から移設。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

- **jsdom に無い口（`window.matchMedia` / `Element.prototype.scrollIntoView`）は `apps/web/app/test-support.tsx` が埋めてある。** 自前のスタブを書かないこと — **固定値を返すスタブはテストを緑にしたまま分岐を殺す。** 幅を変えたいテストは `setViewportWidth` を呼ぶ。対応していないメディアクエリは黙って `false` を返さず投げる形にしてあるので、足りなければそこへ足す
- **`components.json` の `"style": "radix-nova"` を消さない。** shadcn 4.x の既定 base は Base UI なので、**消しても何も壊れず、次の `add` から静かに別物が来る**
- **`apps/web` だけテストを回すなら `pnpm --filter @alteroid/web test` でよい**（#246 で `package.json` に足した。中身は `vitest run --root=../.. apps/web/app`）。以前はこの script が無く、`pnpm --filter @alteroid/web test` は出力0行・exit 0 で「通った」ように見えた。並列度を絞りたいときは `pnpm --filter @alteroid/web test --maxWorkers=4` の形で引数がそのまま vitest へ届く（`-- --maxWorkers=4` の形は届かない。`AGENTS.md`「静かに失敗する道具」参照）

## 基底の `grid-cols-*` を持たない grid を検出する歯 — **作らないと決めた**

<!-- Issue #385 から移設。理由の本文は1文字も変えていない。 -->

**⚠️ これは「まだ作っていない」ではない。歯を作らないと決めた判断の記録である。** 同じ案がまた出たときに、ここから読み直すためだけに在る。

**いま作らない理由:**

- **鳴る対象が2件しかない。除外リストが対象と同じ大きさなら、それは歯ではなく一覧である。** `apps/web/app/routes/usage.tsx` と `apps/web/app/routes/dashboard.tsx` の2箇所（#295）が該当するが、**この2箇所は正しい**（暗黙トラックは孫以下の `min-w-0` + `overflow:hidden` で有界になっている）。
- **「基底の `grid-cols-*` が無い」は欠陥ではない**（#265 / #266）。緩和が別の場所で効いている構成は、この repo では既に何度も出てきている正常形である。**欠陥でないものを検出する歯は、鳴りっぱなしになって読まれなくなる。**
- **本当に検出したいのは「緩和が _どこにも_ 無い grid」であって、「基底の `grid-cols-*` が無い grid」ではない。** 前者を検出するには孫以下まで className を辿って `min-w-0` 相当の緩和が存在するかを判定する必要があるが、**Tailwind のクラス文字列を静的に辿る道具が、この repo にまだ無い。**

**それでも作ることになったときの下書き:**

- 対象: `className` に `grid` を含む要素で、基底（breakpoint 接頭辞の無い）`grid-cols-*` を持たないもの
- 判定: その要素の子孫（`className` を持つすべての JSX 要素）を辿り、`min-w-0`（または同等の緩和）を持つものが最低1つ存在するかを確認する
- 「無ければ鳴る」歯にするなら、まず repo 全体を一度走査して現状の分布を数え、**鳴る対象の数と除外の数の比**を先に見ること（**上の理由1がまた成り立つなら、歯として作る前に立ち止まる**）

**出どころ**: #295（この案の出どころ）／#283 · #265 · #266（「基底の `grid-cols-*` が無い」が欠陥ではないと確認された過去の走査）。
