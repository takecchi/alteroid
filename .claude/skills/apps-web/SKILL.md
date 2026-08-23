---
name: apps-web
description: apps/web（Web UI）を触るときに読む。jsdom に無い口を埋める共有の足場 test-support.tsx と、自前スタブを書いてはいけない理由、components.json の "style" を消すと次の shadcn add から静かに別物が来ること。
---

# apps/web を触るときに知っておくこと

<!-- AGENTS.md「apps/web」から移設。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

- **jsdom に無い口（`window.matchMedia` / `Element.prototype.scrollIntoView`）は `apps/web/app/test-support.tsx` が埋めてある。** 自前のスタブを書かないこと — **固定値を返すスタブはテストを緑にしたまま分岐を殺す。** 幅を変えたいテストは `setViewportWidth` を呼ぶ。対応していないメディアクエリは黙って `false` を返さず投げる形にしてあるので、足りなければそこへ足す
- **`components.json` の `"style": "radix-nova"` を消さない。** shadcn 4.x の既定 base は Base UI なので、**消しても何も壊れず、次の `add` から静かに別物が来る**
- **`apps/web` だけテストを回すなら `pnpm --filter @alteroid/web test` でよい**（#246 で `package.json` に足した。中身は `vitest run --root=../.. apps/web/app`）。以前はこの script が無く、`pnpm --filter @alteroid/web test` は出力0行・exit 0 で「通った」ように見えた。並列度を絞りたいときは `pnpm --filter @alteroid/web test --maxWorkers=4` の形で引数がそのまま vitest へ届く（`-- --maxWorkers=4` の形は届かない。`AGENTS.md`「静かに失敗する道具」参照）
