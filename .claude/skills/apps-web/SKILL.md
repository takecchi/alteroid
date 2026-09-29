---
name: apps-web
description: apps/web（Web UI）と、そこから切り出した packages/ui・packages/logic・packages/swr を触るときに読む。4つの分け方と依存の向き（ESLint が止める）、テストの足場が2枚に分かれていること、components.json が packages/ui へ移ったこと。jsdom に無い口を埋める共有の足場 test-support.tsx と、自前スタブを書いてはいけない理由、components.json の "style" を消すと次の shadcn add から静かに別物が来ること。基底の grid-cols-* を持たない grid を検出する歯を作らないと決めた理由。
---

# apps/web を触るときに知っておくこと

<!-- AGENTS.md「apps/web」から移設。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

- **jsdom に無い口（`window.matchMedia` / `Element.prototype.scrollIntoView`）は `apps/web/app/test-support.tsx` が埋めてある。** 自前のスタブを書かないこと — **固定値を返すスタブはテストを緑にしたまま分岐を殺す。** 幅を変えたいテストは `setViewportWidth` を呼ぶ。対応していないメディアクエリは黙って `false` を返さず投げる形にしてあるので、足りなければそこへ足す
- **`components.json` の `"style": "radix-nova"` を消さない。** shadcn 4.x の既定 base は Base UI なので、**消しても何も壊れず、次の `add` から静かに別物が来る**
- **`apps/web` だけテストを回すなら `pnpm --filter @alteroid/web test` でよい**（#246 で `package.json` に足した。中身は `node ../../scripts/test.mjs --root=../.. --scope=apps/web/app`）。この script が無いと `pnpm --filter @alteroid/web test` は出力0行・exit 0 で「通った」ように見える。並列度は `pnpm --filter @alteroid/web test --maxWorkers=4` で渡す（素の `--` は `scripts/test.mjs` の `dropBareDashDash` が落とすので、`-- --maxWorkers=4` の形でも届く）
- **1ファイルだけに絞るなら `pnpm --filter @alteroid/web test -- <app/ からの相対パス>`（`cd apps/web && pnpm test -- <同じ相対パス>` も同じ）でよい**（#1691 で直った。それまでは範囲の位置引数と OR になり、1ファイルへ絞ったつもりでも `apps/web` 全体が走っていた）。パスは**パッケージのディレクトリ（`apps/web`）からの相対**で書く——`pnpm --filter` で root から打っても、pnpm がスクリプト実行時に `apps/web` へ cd するので基準は変わらない。範囲（`apps/web/app`）の外を指すと、黙って全体を走らせず断る（`scripts/test-guard-core.mjs` の `resolveScopedArgs`）

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

## 画面は4つに分けてある（見た目・純ロジック・通信の層を切り出した）

| 置き場           | 名前              | 持つもの                                                                                                                                                               | import してはいけないもの（ESLint が止める）                         |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `apps/web/app`   | `@alteroid/web`   | 経路と画面ごとの部品。下の3つを呼ぶだけ                                                                                                                                | —                                                                    |
| `packages/ui`    | `@alteroid/ui`    | 画面が使う部品（`components/common.tsx` など）・shadcn の素の部品（`components/ui/`、`@alteroid/ui/shadcn`）・見本帳（Storybook）・テーマ（`@alteroid/ui/styles.css`） | `swr` / `@alteroid/swr` / `@alteroid/logic` / `@alteroid/api-client` |
| `packages/logic` | `@alteroid/logic` | 純ロジック（整形・接続先と資格情報の置き場・日誌の窓・URL の組み立て・生成 spec から導いた画面の型）                                                                   | `react` / `react-dom` / `swr` / `@alteroid/ui` / `@alteroid/swr`     |
| `packages/swr`   | `@alteroid/swr`   | `ApiProvider`・SWR の hooks・ログインの段取り                                                                                                                          | `@alteroid/ui`                                                       |

- **3つのパッケージは build を持たない。** `exports` がソース（`./src/index.ts`）を指し、apps/web の Vite がそのまま束ねる。型検査は各パッケージの `tsc --noEmit` と、apps/web の `typecheck`（import 先まで辿る）の両方で掛かる
- **依存の向きと `@alteroid/core` の値の import 禁止は `eslint.config.js` の `WEB_UI_LAYERS` / `CORE_VALUE_IMPORT_BAN` が持つ。** 同じ規則名を後の設定で書くと前の選択肢が丸ごと置き換わる（flat config は規則ごとに後勝ち）ので、層の設定には core の禁止を載せ直してある。層を足すときも `layerImportRules` を通して足すこと
- **`components.json`（`"style": "radix-nova"`）は `packages/ui/components.json` に在る。部品は `pnpm --filter @alteroid/ui shadcn:add <名前>` で足す**（素の `shadcn add` を打たない）。shadcn 4.21.0 はこの repo で `import { cn } from "cn"` を吐き、npm の無関係な `cn` を依存へ足す（`shadcn info` の解決先は正しいのに、である。2026-09-29 実測）。包み（`packages/ui/scripts/shadcn-add.mjs`）が import を `@/lib/utils` へ直し、`cn` を依存から外し、prettier を掛ける。**`pnpm-lock.yaml` は直さない** — CLI の入れ直しで無関係な推移的依存の版が動くことがある（実測: `@jridgewell/sourcemap-codec` 1.5.5 → 1.6.0）ので、`git diff --stat pnpm-lock.yaml` を見て要らない差分は戻す。足した部品は `src/components/ui/index.ts` へ1行足す（`packages/ui/src/shadcn-setup.test.ts` が、書き忘れ・`cn` の混入・`components.json` のずれを落とす）
- **`src/components/ui/` の部品には手を入れない**（次の `shadcn:add --overwrite` で黙って消える）。画面の呼び方（`variant="primary"` / `tone="warn"` / `loading`）へ合わせるのは `components/common.tsx` の役目である
- **`@/` は `packages/ui/src` の別名で、shadcn の部品が互いを import する形のまま使っている。** 対応は4か所に在る — `packages/ui/tsconfig.json` の `paths`・`packages/ui/.storybook/main.ts`・`apps/web/tsconfig.json` の `paths`（型検査が import 先まで辿るため）・根の `vitest.config.ts`。**`packages/ui` の外で `@/` を書くと ESLint が落とす**（`eslint.config.js` の `UI_ALIAS_BAN`）——画面は `@alteroid/ui` か `@alteroid/ui/shadcn` から取る
- **色の名前は shadcn の既定のまま**（`bg-background` / `bg-card` / `bg-muted` / `text-muted-foreground` / `bg-primary` / `text-destructive` …。値は `packages/ui/src/styles.css`）。**以前の独自の名前（`bg-surface` / `text-fg` / `text-muted`（文字色） / `bg-accent`（強調） / `text-danger`）はもう無い**——`muted` と `accent` は shadcn では「控えめな面」の意味なので、`text-muted` と書くと面の色で文字を塗ることになる。shadcn に無い `warn` / `ok`（注意・成功）だけ足してある。既定は暗い側（`apps/web/app/root.tsx` の `<html class="dark">`）
- **見本帳は根で `pnpm storybook`**（= `pnpm --filter @alteroid/ui storybook`、http://localhost:6006）。見本は部品の隣に `*.stories.tsx` で**1部品に1ファイル**置く。見出しは4つに分ける —— `Foundations`（デザインの基礎）・`UI/<名前>`（`components/ui/` の shadcn の部品と、`common` / `markdown`）・`Layout/<名前>`（`components/layout/` と `page` / `drawer`）・`Features/<名前>`（`components/features/`。まとまりはサブフォルダと `Features/Chat/<名前>` の形）。**stories のファイルから見本以外を名前付き export しない**（Storybook が見本として拾う。見本だけの並びは `samples.ts` のような別ファイルへ）。**見本だけが使う class は画面の生成物の CSS に入れない** — `src/styles.css` の `@source not './**/*.stories.tsx'` で外し、`.storybook/preview.css` で拾わせ直している。`storybook build` の出力（`storybook-static`）は git・prettier・ESLint から外してある
- **Tailwind に `packages/ui` の class を拾わせているのは `packages/ui/src/styles.css` の `@source './'` である。** apps/web の Vite の自動検出は apps/web の下しか見ない。**消しても型検査もテストも緑のまま**、部品の中でしか使わない class だけが生成物の CSS から消える
- **テストの足場は2枚に分けてある。** jsdom に無い口と金額の網は `apps/web/app/test-support.tsx`、`fetch` の差し替え・SSE の偽応答・`Providers` は `packages/swr/src/test-support.tsx`（`@alteroid/swr/test-support`）。画面のテストは今までどおり `~/test-support` だけを見ればよい（前者が後者を再エクスポートしている）。**`packages/swr` のテストは前者を読まない**ので、そちらで jsdom に無い口が要ったら、足場を移すかどうかをその時に決める
- **画面のテストで hook を差し替えるなら、`@alteroid/swr` を部分的に差し替える**（`vi.mock('@alteroid/swr', async (importOriginal) => ({ ...(await importOriginal()), useX: mock }))`）。丸ごと差し替えると、その画面が使う他の hook まで消える（`apps/web/app/routes/journal-selected-memo.test.tsx` が実例）
- **パッケージだけテストを回すなら `pnpm --filter @alteroid/ui test`（`logic` / `swr` も同じ形）。** 根の `vitest.config.ts` の `include` に `packages/*/src/**/*.test.tsx` を足してあるので、根の `pnpm test` からも拾われる
- **Web UI 全体を走査する歯は4つの根を見る。** `scripts/web-api-base-url-no-external-input.test.ts`（接続先を外から受け取らない）と `scripts/chat-lines-bounded.test.ts`（`Line[]` を保つ `useState` は1箇所）は、どちらも `apps/web/app` に加えて3つのパッケージの `src` を走査する。**パッケージを足したら、この2本の根にも足すこと** — 足さないと、足したパッケージの中だけ歯が黙る
