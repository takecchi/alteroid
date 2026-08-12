# AGENTS.md — alteroid を実装する AI への指示

## まず読む

1. [docs/north_star.md](./docs/north_star.md) — **正典**。プロダクトの全判断の基準
2. [docs/PRD.md](./docs/PRD.md) — 正典から導出された要件
3. [docs/architecture.md](./docs/architecture.md) — 設計
4. [docs/roadmap.md](./docs/roadmap.md) — 実装計画。**実装を引き継いだらここから着手する**

**これらの文書とコードが矛盾したら、バグなのはコードである**（優先順位は番号順）。実装の都合で要件を下げない。

## この文書の役割

ここに**要件は書かない**。書けば docs と二重管理になり、必ずずれる。ここにあるのは作業手順と、実装で踏みやすい地雷だけである。

## 用語

| 語           | 意味                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| クローン     | 人間の価値観をコピーした AI。人間の代理。判断と人格更新だけを行い、道具は持たない（Fable） |
| マネージャー | 人間が使う Claude Code に相当する層。**能力の等価性の基準はここ**（Opus）                  |
| 作業者       | マネージャーがコストと文脈のために切り出した実作業の担い手。実装に限らない（Sonnet）       |

## 作業を始める前に

`docs/north_star.md` の「立ち戻るための問い」を上から通す。1つでも引っかかったら、その設計のまま進めない。

## 踏みやすい地雷

いずれも「良かれと思って」入れたくなるものばかりで、入れた瞬間に北極星が壊れる。

| やりがちなこと                                            | なぜ違反か                                   | 代わりに                                                           |
| --------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| 作業者の `tools` を明示リストで絞る                       | 能力の削除（追加制限禁止）                   | preset 一式を渡す。SDK が増やしたツールに自動で追いつかせる        |
| ターン数上限・実行回数上限で暴走を止める                  | 同上                                         | 実行環境の境界（サンドボックス・ネットワーク・認証情報の配布範囲） |
| 確認が要る行為の一覧（`permissions.yaml` 的なもの）を作る | 権限境界はクローンの判断であって設定ではない | 記憶に根拠があるかで判断させ、判断を日誌に残す                     |
| 人間が `chat` を開いた時だけ動く作りにする                | 人間起点の固定（自律要件違反）               | 常駐させ、時間・外部イベント・クローン自身の発意からも仕事を起こす |
| 安いモデルに寄せる / 階層を潰して速くする                 | プロダクトの前提そのものの破壊               | Fable / Opus / Sonnet の対応は固定。変更には人間の承認が要る       |
| 能力の欠落を「スコープ外」と書いて正当化する              | デグレード禁止                               | できないならバグとして扱い、直す                                   |
| クローンに直接 Web 検索やファイル編集をさせる             | 層の取り違え                                 | クローンの道具はマネージャーである                                 |
| 作業者を実装専用として設計する                            | 代行対象は調査・相談・確認・レビューも含む   | 仕事の型を実装に狭めない                                           |

## 実装の前提

- エージェント実行基盤は自作しない。**Claude Agent SDK をラップする**
- 外部サービス接続は **MCP**
- インターフェースは **CLI と HTTP API のみ**（Web UI とマルチユーザーは非ゴール）

## リポジトリの約束

- コミットメッセージ: `<type>: <description>`（type は feat / fix / refactor / docs / test / chore / perf / ci）
- **ブランチを切って PR を出す。main へ直接 push しない**（進捗チェックボックス以外の docs/ 変更も PR で人間の確認を通す）
- `docs/` は正典。**AI が単独で書き換えない。** 要件を変える必要が出たら手を止めて人間に確認する（例外: docs/roadmap.md の進捗チェックボックス更新のみ可）

## 開発手順

- 要件: Node 22+ / pnpm（バージョンは `package.json` の `packageManager`）
- `pnpm install` → `pnpm build` → `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test`
- **build が先。** ワークスペース間の型解決が各パッケージの `dist/` に依存するため、build 前の typecheck / test は失敗する
- TypeScript は 6 系に固定（typescript-eslint が TS 7 未対応のため。`pnpm-workspace.yaml` の catalog 参照）。TS6 は `@types` を自動で取り込まないので、新パッケージには `@types/node`（`catalog:`）を devDependencies に入れる
- 新しい依存の追加はバージョンを catalog（`pnpm-workspace.yaml`）に寄せられるか先に検討する

## 動かす

- `alteroid init` → `alteroid chat`。chat はデーモンが居なければ自分で起こす
- 人格データは既定で `~/.alteroid/`。**`ALTEROID_HOME` で差し替えられる**ので、動作確認は必ず一時ディレクトリを指すこと（自分の記憶を壊さない）
- デーモンの待ち受けポートは `ALTEROID_PORT`（既定 4517）。接続先とプロセス id は `$ALTEROID_HOME/state/daemon.json` にある
- マネージャーの既定の作業ディレクトリは `ALTEROID_WORKSPACE`（既定はデーモンの cwd）。**実プロジェクトを直に触るので、動作確認では捨ててよい一時ディレクトリを指すこと**
- `ALTEROID_HOME` と `ALTEROID_PORT` はマネージャー子プロセスの環境変数から落としてある（記憶ストアの所在を配らない）。ここに環境変数を足すときは、それが下へ漏れてよいものか先に考える
- SDK を実際に呼ぶ確認は `curl -N -X POST http://127.0.0.1:$PORT/chat -d '{"text":"..."}'` が手軽。ローカルの `claude` のログイン認証がそのまま使われる
- 委譲まわりの確認は `GET /managers`（一覧と状態）、`GET /managers/:id/transcript`（生ログ）、`GET /journal?type=tool_use`（マネージャー・作業者の全ツール実行）を見る。chat からは `/managers` `/manager <id>`
- クローンの挙動を SDK 抜きで検証したいときは `createClone({ queryFn })` に偽の `query` を渡す（`packages/core/src/clone.test.ts`）。マネージャー側は `createManagerPool({ queryFn })`（`packages/core/src/manager.test.ts`）で、こちらは `canUseTool` とフックを直接叩いて配線を確かめる

## 自律まわりの動かし方（起点4つ）

- **既定で動く。** 日報（既定 22:00）と発意 tick（既定 60 分）は何も設定しなくても回る。常駐と自律は後から足す機能ではないので、既定を「止まっている」にしないこと
  - `ALTEROID_DAILY_REPORT_AT`（`HH:MM` / `off`）、`ALTEROID_INITIATIVE_EVERY`（分 / `off`）、`ALTEROID_REPORT_LOOKBACK_DAYS`（起動時に遡って日報を作る日数、既定 3）
  - これらは**方針**の設定であって、暴走を止めるための回数制限ではない。抑止は実行環境の境界で行う（north_star 禁止2）
- 待たずに確かめるなら `POST /schedule/:kind/run`（chat では `/run daily_report` / `/run self_initiative`）。`GET /schedule` で次の発火が見える
- **外部イベントの入口は HTTP の `POST /events`**（`{source, payload}`）。送り元の形を変えられない webhook 用に `POST /events/:source`（本文まるごとが payload）もある。chat からは `/event <source> <本文>`
  - 開いているのは 127.0.0.1 だけ。外から叩かせるならトンネル・リバースプロキシ側に境界を置く（ここで認証を足す前に、それが方針か境界かを考える）
  - MCP 経由のポーリングは**別機構にしない**。「Slack を見に行く」は定期ジョブ＋マネージャーへの委譲で足りる（マネージャーは人間と同じ `.mcp.json` を持つ）
- 日報は `GET /reports` / `GET /reports/:date`、chat では `/report` `/reports`。**日報が無い日を作らないこと** — クローンが `daily_report_write` を呼び忘れたらその応答をそのまま日報にする実装になっている（`clone.ts` の `#dailyReport`）
- 溜まった承認待ちは chat の `/approvals`（番号付き）→ `/answer <番号> <回答>`、API では `POST /approvals/answer` にまとめて渡す
- 時間起点の確認を SDK 抜きでやるなら `createScheduler({ now, post })` に偽の時計を渡して `tick(日時)` を直接呼ぶ（`packages/core/src/schedule.test.ts`）。実 SDK での確認は `ALTEROID_INITIATIVE_EVERY=1`＋締め時刻を数分後にして放置するのが早い
