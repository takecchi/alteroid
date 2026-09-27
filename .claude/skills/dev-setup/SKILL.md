---
name: dev-setup
description: mise / TS6 / catalog / イメージの検査・SDK の PR をマージするときの確認の水準など、開発手順そのものを触るときに読む。
---

この内容は #1192 の再編で AGENTS.md から逐語で移したもの。要約・短縮はしていない。

## AGENTS.md「開発手順」から

- 実行系の版は **`mise.toml`**（Node / pnpm）。`mise install` で揃える。CI も同じファイルを読む（`jdx/mise-action`）ので、ここを直せば両方が動く
  - mise を使わないなら Node 22 系 / pnpm は `package.json` の `packageManager` に合わせる（`corepack enable`）

- **build が先。** ワークスペース間の型解決が各パッケージの `dist/` に依存するため、build 前の typecheck / test は失敗する
- TypeScript は 6 系に固定（typescript-eslint が TS 7 未対応のため。`pnpm-workspace.yaml` の catalog 参照）。TS6 は `@types` を自動で取り込まないので、新パッケージには `@types/node`（`catalog:`）を devDependencies に入れる
- 新しい依存の追加はバージョンを catalog（`pnpm-workspace.yaml`）に寄せられるか先に検討する
- CI はイメージ（`runtime` ステージ）も焼き、**uid 1001＝マネージャーが実際に走る主体**で道具が揃っているかを見る（`.github/workflows/ci.yml` の `image`）。マネージャーの道具は版を固定していないので、上流の変化で壊れたことに気づく場所はここしかない。手元で同じことをするなら `docker build --target runtime -t alteroid:ci .`

- **⚠️ 許可されたのは「緑だから流す」ではない。** 実際に PR #1044（0.3.273）をマージしたときの確認がこの水準である —— 飛ばす3版を `npm pack` で落として型定義6本を `diff -u` で突き合わせ（**除去行ゼロ**。唯一の除去は alteroid が import していない `browser-sdk.d.ts` の doc コメント1行）、`dependencies` / `peerDependencies` が不変であることを見て、**alteroid が実際に触っている API 16個**を出現数で照合し、**この文書が SDK の型を根拠に断定している2箇所**（`load_reason` の5値・`AgentDefinition.skills` が `string[]`）を新しい版で引き直している。**⚠️ それでもバンドル本体（`sdk.mjs`）の挙動は見ていない** — 根拠は型定義の全差分と `package.json` の差分だけである。⟹ **型が動いていないことしか言えていない、と自分の報告にも書くこと**
- **この SDK の版はモデルの版でもある。** エイリアス（`fable` / `opus` / `sonnet`）から具体のモデル id への対応表が SDK のバンドルに焼かれているので（`sdk.mjs` の `aliases`）、**止めると新しいモデルが層に届かない。** コード側に具体のモデル id は1つも無い（`CLONE_MODEL` / `MANAGER_MODEL` / `WORKER_MODEL` はエイリアス）ので、**遅れはここにしか現れない**
- `minimumReleaseAgeExclude`（`pnpm-workspace.yaml`）に**版番号を書かない。** pnpm 11 の既定は `minimumReleaseAge: 1440` で、SDK は公開直後に取りに行きたい側である。版を併記すると上げるたびに書き直しが要り、忘れた回だけ静かに1日古い版で止まる（実際に 0.3.228 で止まっていた）
