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
  - **ただし `claude` にログインしていない器（runner の器など）で、`ALTEROID_RUNNER_URL` を置かずに（＝デーモンの同一プロセスの runner で）動かすと、クローンは動くのにマネージャーだけが `Not logged in` で落ちることがある**（Issue #4112。手元の実測は1回きりで、`claude` にログイン済みの器で同じになるかは確かめていない）。
  - **コードを読んで確かめたこと:**
    - 鍵の器（`CredentialStore`。`packages/core/src/credentials.ts`）を作るのは `apps/runner/src/index.ts` だけで、`ALTEROID_CREDENTIAL_DIR`（無ければ `/run/alteroid/credentials`）を使う。デーモンの同一プロセスの runner（`apps/daemon/src/index.ts` の `runnerSeeds` → `createLocalRunner`）は `credentials` を渡さないので、器を持たない。
    - 器の無い runner は `setCredentials` が `鍵の器が無い runner では差し替えられない（ALTEROID_CREDENTIAL_DIR を用意すること）` と断る（`packages/core/src/runner.ts`）。トークンプールの鍵（`CLAUDE_CODE_OAUTH_TOKEN`）はこの経路で runner へ降ろされるので、**同一プロセスの runner ではプールの鍵がマネージャーに届かない**。`GET /runners` の `pushHealth.agentToken` が上の文言の `failed` になるのがその印。
    - 鍵の置き場は、**デーモンの環境変数に `ALTEROID_CREDENTIAL_DIR` を足しても、同一プロセスの runner には器ができない**（デーモンはこの変数を読まない）。
  - **用意の仕方（実測で通ったと Issue に記録されている形）:** `apps/runner` を `ALTEROID_CREDENTIAL_DIR=<書ける置き場>` と `ALTEROID_RUNNER_TOKEN`（または `ALTEROID_RUNNER_TOKEN_SHA256`）付きで別に起こし、デーモンへ `ALTEROID_RUNNER_URL` と `ALTEROID_RUNNER_TOKEN` を渡して繋ぐ。`pushHealth.agentToken` が `ok` になり、マネージャーが動く。**この手順をこちらで再現してはいない**（器の入れ替えと鍵の降ろしはコードで追っただけ）。
  - **確かめていないこと:** デーモンの env の `CLAUDE_CODE_OAUTH_TOKEN` が同一プロセスの runner のマネージャーの子へ渡る道（`localRunnerEnv`）は読んだが、Issue の観測で `Not logged in` になった理由とは結び付けていない。
  - 失敗の見え方: 器の無い runner のマネージャーが `Not logged in` で落ちると、失敗の報告（クローンの受信箱）の末尾に「鍵の置き場（ALTEROID_CREDENTIAL_DIR）が無いと、ローカル runner のマネージャーへ鍵が届かない」という案内が付く（`packages/core/src/runner.ts` の `NO_CREDENTIAL_DIR_HINT`）。別プロセスの runner（器が必ずある）には付かない。
- 委譲まわりの確認は `GET /managers`（一覧と状態）、`GET /managers/:id/transcript`（生ログ）、`GET /journal?type=tool_use`（マネージャー・作業者の全ツール実行）を見る。chat からは `/managers` `/manager <id>`
- **API の仕様は `GET /openapi.json`（OpenAPI 3.1）、人間が読むなら `GET /docs`。** 経路の zod スキーマから機械生成しており、`pnpm build` が `apps/daemon/openapi.json` を毎回書き直す。**手書きの spec を別に置かないこと**（二重管理になって必ずずれる）
  - コミット済みの spec とコードがずれたら CI が落ちる（`.github/workflows/ci.yml` の「OpenAPI spec がコードと一致しているか」）。**経路やスキーマを変えたら `pnpm build` して `openapi.json` の差分も一緒にコミットすること**
  - 外部向けの生成クライアントは `packages/api-client`（`openapi-typescript` + `openapi-fetch`）。**CLI はこれを使わない** — 同一リポジトリからは `hono/client` の型共有で足りているので無理に置き換えない。生成クライアントは外へ出す成果物である
  - 対象は**デーモンの API だけ**。runner の API は制御面であって外へ出すものではない（触れると自分宛の許可確認に自分で答えられる）
- クローンの挙動を SDK 抜きで検証したいときは `createClone({ queryFn })` に偽の `query` を渡す（`packages/core/src/clone-test-harness.ts` の `fakeSdk` / `setup`。旧 `clone.test.ts` は issue #1744 で分割済み）。マネージャー側は runner に偽の `query` を渡す（`createLocalRunner({ queryFn })` → `createRunnerRegistry`。`packages/core/src/manager.test.ts`）。デーモンと runner の境界そのものは `apps/daemon/src/runner-client.test.ts` が実際の HTTP 経路で通している
