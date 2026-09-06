# alteroid

> **人間が PC の前に座り、Claude Code に作業を依頼して物事を進める。**
> alteroid はこれを、人間の代わりにクローン（AI）が行うようにするためのツールである。
> — [docs/north_star.md](./docs/north_star.md)

人間の価値観をコピーしたクローンが最終判断を持ち、その下にマネージャー（プロジェクト管理）と
作業者（実作業）を置く。人間の役目は価値観の伝達と最終承認だけに縮む。

**この文書に要件は書かない。** 正典は [docs/](./docs/) で、ここはその入口である。矛盾したら
docs/ が勝つ。

## 3つの層

| 層               | モデル帯 | 位置づけ                                | 実体                                  |
| ---------------- | -------- | --------------------------------------- | ------------------------------------- |
| **クローン**     | Fable    | 人間の代理。最終判断と記憶を持つ        | デーモン内の長寿命セッション1本       |
| **マネージャー** | Opus     | **人間が使う Claude Code に相当**する層 | manager-runner の中で走る Claude Code |
| **作業者**       | Sonnet   | マネージャーが切り出した実作業の担い手  | マネージャー配下のサブエージェント    |

役割とモデル帯の対応は固定の設計判断であり、変更には人間の承認が要る。

エージェント実行基盤は自作していない（[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
をラップする）。alteroid が書くのは配線と、独自価値の3点 —— **クローンの永続記憶**・
**エスカレーション・プロトコル**・**役割別モデルルーティング**である（[docs/PRD.md](./docs/PRD.md)
「提供価値」）。

## ドキュメント

読む順序は番号順で、**矛盾したら上が勝つ**。

| 文書                                              | 何が書いてあるか                                           |
| ------------------------------------------------- | ---------------------------------------------------------- |
| 1. [docs/north_star.md](./docs/north_star.md)     | **正典**。プロダクトの全判断の基準。2つの禁止              |
| 2. [docs/PRD.md](./docs/PRD.md)                   | 正典から導出された要件（能力の等価性・自律・権限境界ほか） |
| 3. [docs/architecture.md](./docs/architecture.md) | 設計（プロセス境界・ストレージ・パッケージ構成・技術選定） |
| [AGENTS.md](./AGENTS.md)                          | 実装する AI への指示（地雷・リポジトリの約束・報告の形）   |
| [.claude/skills/](./.claude/skills/)              | 部分系ごとの手順書（触るときだけ引く）                     |
| [railway/README.md](./railway/README.md)          | クラウド（Railway）への常駐                                |
| [apps/web/README.md](./apps/web/README.md)        | 画面の配置・接続先の決まり方・ログイン                     |

`docs/` は AI が単独で書き換えない。要件を変える必要が出たら人間に確認する。

## 動かす

### 手元（Node）

実行系の版は [mise.toml](./mise.toml) に一本化してある（CI も同じファイルを読む）。

```sh
mise install        # Node 22 / pnpm。使わないなら corepack enable
pnpm install
pnpm build          # **build が先。** ワークスペース間の型解決が各パッケージの dist/ に依存する
```

CLI の実体は `apps/cli/dist/index.js`。PATH に置くなら、コンテナと同じ形で繋ぐ:

```sh
ln -sf "$PWD/apps/cli/dist/index.js" /usr/local/bin/alteroid
alteroid init       # 人格データディレクトリ（~/.alteroid）を作る
alteroid chat       # クローンと会話する（デーモンが居なければ自分で起こす）
```

- デーモンの待ち受けは `ALTEROID_PORT`（既定 4517）。接続先と pid は `$ALTEROID_HOME/state/daemon.json`
- 人格データは `ALTEROID_HOME`（既定 `~/.alteroid`）、マネージャーの作業ディレクトリは
  `ALTEROID_WORKSPACE`（既定はデーモンの cwd）
- **動作確認では両方とも捨ててよい一時ディレクトリを指すこと。** 既定のままだと自分の記憶と
  実プロジェクトを直に触る

手順の詳細は [.claude/skills/running-alteroid/SKILL.md](./.claude/skills/running-alteroid/SKILL.md)。

### コンテナ（docker compose）

デーモン / manager-runner / PostgreSQL の3コンテナ構成。

```sh
cp .env.example .env        # 3つ埋める（下記）
docker compose up -d
docker compose exec app alteroid chat
```

`.env` に要るのは3つだけである。

| 変数                      | 取り方                                             |
| ------------------------- | -------------------------------------------------- |
| `CLAUDE_CODE_OAUTH_TOKEN` | `claude setup-token`（人間が一度だけ）             |
| `ALTEROID_RUNNER_TOKEN`   | `openssl rand -hex 32`。**app と runner で同じ値** |
| `POSTGRES_PASSWORD`       | `openssl rand -hex 16`                             |

**道具の鍵や PATH をここに増やさないこと。** それは実行環境プロファイル（`alteroid profile edit`）
の側で、器を焼き直さずに差し替えられる。境界の説明は [.env.example](./.env.example) と
[compose.yaml](./compose.yaml) の冒頭に書いてある。

### クラウド

[railway/README.md](./railway/README.md)（Railway。runner は N 台に増やせる）。

## 入口は3つ、API は1つ

| 入口              | 位置づけ                                                                           |
| ----------------- | ---------------------------------------------------------------------------------- |
| `alteroid`（CLI） | 端末から。常駐の起動・停止もここ                                                   |
| HTTP API          | 外部アプリ・自作ツールの口。仕様は `GET /openapi.json`、人間が読むなら `GET /docs` |
| Web UI            | 公式の画面。**API の上の実装**であって、独自の経路を持たない                       |

> **入口の等価性** — ある入口でできることが別の入口でできない状態を作らない（[docs/PRD.md](./docs/PRD.md)
> 「インターフェース」）。**画面の都合で API に経路を足さないこと。**

CLI の主なコマンド:

| コマンド                            | 何をするか                                                |
| ----------------------------------- | --------------------------------------------------------- |
| `alteroid init`                     | 人格データディレクトリを初期化する                        |
| `alteroid chat`                     | クローンと会話する。中は `/help` でスラッシュコマンド一覧 |
| `alteroid daemon start/stop/status` | 常駐デーモンの操作                                        |
| `alteroid memory ...`               | 記憶（人格）を読む・書き換える・消す                      |
| `alteroid profile ...`              | 実行環境プロファイル（`~/.zprofile` に当たるもの）        |
| `alteroid token ...`                | 認証トークンのプール（枠に当たったときに回す候補）        |
| `alteroid usage`                    | 使った分（トークンと費用）を見る                          |
| `alteroid runners`                  | 委譲先の器と、いま走っている版を見る                      |
| `alteroid conversations ...`        | 会話の履歴を読む                                          |
| `alteroid dropped`                  | 握り潰しの跡を見る                                        |
| `alteroid login/logout/whoami`      | この端末用のアクセストークン                              |
| `alteroid access ...`               | ログインしたアカウントへ使用許可を与える・取り消す        |

## 構成

```
packages/core        ドメイン全部: クローンループ、委譲（デーモン側）、runner 側の
                     SDK セッション、境界のプロトコル(zod)、ストアIF
packages/storage-fs  ローカル用ドライバ（Markdown / JSONL / JSON）
packages/storage-pg  クラウド用ドライバ（PostgreSQL / drizzle）
apps/daemon          alteroidd = core をホストする常駐プロセス + HTTP API（hono）
apps/runner          alteroid-runner = manager-runner。SDK を隔離して走らせる
apps/cli             alteroid = daemon への薄いクライアント（hono/client で型共有）
apps/web             公式の画面。React Router v7 の SPA
packages/api-client  生成 spec から起こした外部向けクライアント
```

**デーモンと manager-runner を分けてあるのは、記憶ストアの鍵をマネージャーから遠ざけるため
である。** 同じ器で走らせている限り、マネージャーは `/proc/1/environ` からデーモンの環境変数に
届く。ツールを削って塞ぐことは禁じられている（正典の禁止2）ので、**実行環境のほうを分ける**
（[docs/architecture.md](./docs/architecture.md)「プロセス境界」）。

## 開発

```sh
pnpm verify         # 検証一式を正しい順序で通す。通し直しは指紋一致で無料になる
```

中身は build → `check:web-bundle-node-traces` → `check:web-bundle-size` →
`apps/daemon/openapi.json` の一致 → `check:sdk-quotes` → `typecheck` → `lint` →
`format:check` → `test` の順で、**build が先である**。個別に打つこともできる。

- **`pnpm test` が「テスト0本のまま exit 1」になったら、落ちたのではなく走っていない。**
  `Test Files` / `Tests` の行が出ているかで見る。器が混んでいるときは `pnpm test --maxWorkers=4`
- 経路やスキーマを変えたら `pnpm build` して `apps/daemon/openapi.json` の差分も一緒にコミットする
  （手書きの spec を別に置かない）
- コミットメッセージは `<type>: <description>`（feat / fix / refactor / docs / test / chore /
  perf / ci）。**トレーラは付けない**
- ブランチを切って PR を出す。**main へ直接 push しない**

CI（[.github/workflows/ci.yml](./.github/workflows/ci.yml)）は同じ一式に加えて、`runtime`
イメージを焼いて **uid 1001＝マネージャーが実際に走る主体**で道具が揃っているかも見る。

## 状態

作者自身の個人利用（MVP）。マルチユーザー / チーム利用は非ゴール。`LICENSE` は置いていない。
