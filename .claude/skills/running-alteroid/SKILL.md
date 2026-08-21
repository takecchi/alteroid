---
name: running-alteroid
description: alteroid をローカルで動かして挙動を確かめるときに読む。alteroid init / chat、ALTEROID_HOME と ALTEROID_WORKSPACE の差し替え、デーモンの口（/managers /journal /openapi.json）、SDK 抜きで検証する queryFn の渡し方、マネージャー子プロセスへ渡す鍵と渡さない鍵の線。
---

# 動かす

<!-- AGENTS.md から移設。本文は1文字も変えていない。パスはリポジトリの根からの相対である。 -->

- `alteroid init` → `alteroid chat`。chat はデーモンが居なければ自分で起こす
- 人格データは既定で `~/.alteroid/`。**`ALTEROID_HOME` で差し替えられる**ので、動作確認は必ず一時ディレクトリを指すこと（自分の記憶を壊さない）
- デーモンの待ち受けポートは `ALTEROID_PORT`（既定 4517）。接続先とプロセス id は `$ALTEROID_HOME/state/daemon.json` にある
- マネージャーの既定の作業ディレクトリは `ALTEROID_WORKSPACE`（既定はデーモンの cwd）。**実プロジェクトを直に触るので、動作確認では捨ててよい一時ディレクトリを指すこと**
- `ALTEROID_HOME` `ALTEROID_PORT` `ALTEROID_DATABASE_URL` はマネージャー子プロセスの環境変数から落としてある（記憶ストアの所在を配らない）。ここに環境変数を足すときは、それが下へ漏れてよいものか先に考える。記憶へ到達する鍵を増やしたら `Storage.withheldEnvKeys`（`apps/daemon/src/storage.ts`）にも足すこと
  - **下へ渡す鍵を環境変数で固定しないこと。** env で配ると鍵は runner の起動時に凍り、人間が差し替えても器を作り直すまで届かない＝**「鍵を直す」と「走行中の仕事を失う」が同じ操作**になる。しかも既に走っている SDK 子プロセスには永久に届かない。鍵は器（`packages/core/src/credentials.ts`）に置き、`git` / `gh` が呼ばれるたびに読み直す形にしてある。回すのは `POST /runners/credentials`、突き合わせは `GET /runners`（指紋だけ。値は出さない）
  - **逆に、マネージャー自身の道具の鍵（`GH_TOKEN` `CLAUDE_CODE_OAUTH_TOKEN` MCP の認証情報など）は下へ渡すのが正しい。** これを「鍵は配らない」と混同して伏せると、人間が Claude Code でできる `gh pr create` が層を下りた瞬間にできなくなる＝デグレード（north_star 禁止1）。伏せるのは**上（記憶）へ到達する鍵**だけであって、**下（外の世界）へ手を伸ばす鍵**ではない
- SDK を実際に呼ぶ確認は `curl -N -X POST http://127.0.0.1:$PORT/chat -d '{"text":"..."}'` が手軽。ローカルの `claude` のログイン認証がそのまま使われる
- 委譲まわりの確認は `GET /managers`（一覧と状態）、`GET /managers/:id/transcript`（生ログ）、`GET /journal?type=tool_use`（マネージャー・作業者の全ツール実行）を見る。chat からは `/managers` `/manager <id>`
- **API の仕様は `GET /openapi.json`（OpenAPI 3.1）、人間が読むなら `GET /docs`。** 経路の zod スキーマから機械生成しており、`pnpm build` が `apps/daemon/openapi.json` を毎回書き直す。**手書きの spec を別に置かないこと**（二重管理になって必ずずれる）
  - コミット済みの spec とコードがずれたら CI が落ちる（`.github/workflows/ci.yml` の「OpenAPI spec がコードと一致しているか」）。**経路やスキーマを変えたら `pnpm build` して `openapi.json` の差分も一緒にコミットすること**
  - 外部向けの生成クライアントは `packages/api-client`（`openapi-typescript` + `openapi-fetch`）。**CLI はこれを使わない** — 同一リポジトリからは `hono/client` の型共有で足りているので無理に置き換えない。生成クライアントは外へ出す成果物である
  - 対象は**デーモンの API だけ**。runner の API は制御面であって外へ出すものではない（触れると自分宛の許可確認に自分で答えられる）
- クローンの挙動を SDK 抜きで検証したいときは `createClone({ queryFn })` に偽の `query` を渡す（`packages/core/src/clone.test.ts`）。マネージャー側は runner に偽の `query` を渡す（`createLocalRunner({ queryFn })` → `createRunnerRegistry`。`packages/core/src/manager.test.ts`）。デーモンと runner の境界そのものは `apps/daemon/src/runner-client.test.ts` が実際の HTTP 経路で通している
