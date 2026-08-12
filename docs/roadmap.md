# ロードマップ — alteroid 実装計画

[architecture.md](./architecture.md) のフェーズ表 M0〜M4 を、実装を引き継ぐ AI が単独で遂行できる粒度に展開したもの。上位文書は [north_star.md](./north_star.md)（正典）→ [PRD.md](./PRD.md)（要件）→ [architecture.md](./architecture.md)（設計）。矛盾したら上位が勝つ。

**着手前の儀式**: フェーズを始める前に north_star の「立ち戻るための問い」を通し、AGENTS.md の地雷表を読むこと。

**この文書の更新権限**: 進捗チェックボックスの更新だけは実装 AI が行ってよい。フェーズの中身・受け入れ基準・順序の変更は要件変更なので、手を止めて人間に確認する。

---

## M0 — モノレポ雛形と CI

**ゴール**: 空でもビルド・テスト・型チェックが回る骨格。

- [x] pnpm workspaces（`packages/core`, `packages/storage-fs`, `packages/storage-pg`（空スタブ）, `apps/daemon`, `apps/cli`）
- [x] TypeScript strict / ESM 統一、ビルドは tsup
- [x] vitest / eslint + prettier
- [x] GitHub Actions: install → typecheck → lint → test
- [x] AGENTS.md「リポジトリの約束」にビルド・テスト手順を追記（書いた人が追記する約束）

**受け入れ基準**: clean checkout から `pnpm install && pnpm build && pnpm test` が通り、CI が green。

## M1 — クローンと記憶（`init` / `chat`）

**ゴール**: 常駐デーモン内のクローンと会話でき、価値観が蒸留されて Markdown 記憶に残り、人間がそれを直接編集できる。

- [x] `core`: ストア IF（PersonaStore / JournalStore / JobStore）と型付きメッセージ（エスカレーション・日誌・受信箱イベント）の zod スキーマ
- [x] `core`: クローンループ — SDK `query()`、model `fable`、`tools: []`、インプロセス MCP（`memory_*` / `journal_*` / `ask_human`。`manager_*` は M2 までスタブ）
- [x] `core`: **受信箱を M1 から作る**。この時点で届くのは人間の発言だけだが、構造はイベント駆動にしておく（chat 専用の作りにすると M3 で自律に化けられない — AGENTS.md 地雷4）
- [x] `storage-fs`: 記憶 = Markdown、日誌 = JSONL、ジョブ = JSON（`~/.alteroid/`）
- [x] `apps/daemon`: hono で chat(SSE)・journal 閲覧・記憶閲覧。クローンは常に1インスタンス
- [x] `apps/cli`: `alteroid init` / `chat` / `daemon start|stop|status`（hono/client の型付きクライアント）
- [x] 蒸留: 会話終了時 + PreCompact フック時（寿命モデル: 蒸留は生存条件）
- [x] PreCompact で全文トランスクリプトをアーカイブへ退避

**受け入れ基準**:
1. `alteroid init` → `~/.alteroid/` が生成される
2. `alteroid chat` で価値観を伝える → 会話終了後、記憶の Markdown にその学びが残っている
3. 人間がその Markdown を手で書き換える → 次の会話でクローンの判断に反映される
4. デーモンを再起動しても同じ人格として応答する（同一性は記憶に宿る）

## M2 — 委譲（マネージャーと作業者）

**ゴール**: クローンが複数のマネージャーを並行に使い、エスカレーションが人間まで一本の経路で届く。

- [x] `manager_start` / `manager_send` / `manager_list` の実装。委譲はノンブロッキング、`manager_id` と SDK session_id の対応は JobStore へ
- [x] マネージャー: SDK 子プロセス、model `opus`、**`tools` を渡さない**、`settingSources` で人間の `.mcp.json` を共有、cwd = 実ワークスペース
- [x] 作業者: `agents` 定義、model `sonnet`、**`tools` フィールド省略**（全継承）
- [x] 配線: マネージャーの `AskUserQuestion`・許可確認・最終報告をクローンの受信箱へルーティング。クローンは記憶に根拠があれば自分で答え、無ければ `ask_human` で承認待ちキューへ
- [x] 承認待ちキューを chat と HTTP API から閲覧・回答できる
- [x] PostToolUse フックでマネージャー・作業者の全ツール実行を日誌へ記録（監査）
- [x] セッションログの閲覧: manager_id からそのセッションのトランスクリプト（アーカイブ含む）へ chat / API で降りられる（可観測性3層の下2つがここで揃う）

**受け入れ基準**:
1. クローンが2つ以上のマネージャーを同時に走らせ、交錯して届く報告を捌ける
2. 作業者→マネージャー→クローン→承認待ちキュー、のエスカレーションが通る。人間が chat か API で回答すると、止まっていた**その仕事だけ**が再開する
3. 記憶に根拠がある確認はクローンが人間に聞かずに返している（日誌にその判断が残る）
4. 日誌から「どのマネージャーが・いつ・何を実行したか」を追え、そこから該当セッションの生ログまで降りられる

**このフェーズの地雷**: ターン数上限・同時数上限・`permissions.yaml` 的な行為一覧を入れたくなったら手を止めて north_star を読み直す。

## M3 — 自律（起点4つを揃える）

**ゴール**: 人間が何も言わなくても仕事が起きる。人間の不在で止まるのは承認待ちの仕事だけ。

- [x] スケジューラ: 時間起点のジョブ（定期的な見直し）
- [x] 日報: 1日の終わりにクローンが「今日何をしたか・何が決まったか・何が保留か」をまとめる。時間起点ジョブの最初の実例として実装する（PRD「可観測性」）
- [x] 外部イベント入口: webhook を受ける HTTP エンドポイントか MCP 経由ポーリングか、ここで決めて実装（architecture の未解決事項）
- [x] クローンの発意: 記憶にある目的から次にやることを決める定期 tick
- [x] 承認待ちキューの運用完成: 溜まった保留を人間が chat / API でまとめて処理できる

**受け入れ基準**:
1. 人間が一切入力しない状態で、時間起点とクローンの発意からジョブが起きて完了する
2. 承認が要る仕事が保留のまま、他の仕事が進み続ける
3. PRD「自律」の起点4つ（人間・時間・外部イベント・発意）がすべて動作する
4. 日報が毎日生成され、`alteroid chat` と HTTP API で読める

## M4 — クラウド（PostgreSQL とコンテナ）

**ゴール**: ローカルと同じものが、コンテナ + PostgreSQL で常駐する。

- [x] `storage-pg`: drizzle で PersonaStore / JournalStore / JobStore（記憶は同じ Markdown 文書をテーブルに格納。人間の閲覧・編集は CLI / API 経由で担保）
- [x] SDK SessionStore アダプタで セッション永続化も同じ PostgreSQL へ
- [x] デーモン再起動時、JobStore の session_id から走行中マネージャーを resume
- [x] Dockerfile + docker compose（app + postgres）。認証は `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token`）をシークレット注入
- [x] 記憶ストア認証情報の分離を検証: マネージャー子プロセスの環境変数に DB 接続情報が**渡っていない**こと（非対称な可視性の本命の強制がここで成立する）

**受け入れ基準**:
1. `docker compose up` + トークン注入で起動し、M1〜M3 の受け入れ基準が同じように通る
2. コンテナ再起動後、クローンは同じ人格で、走行中だったマネージャーの続きを把握している
3. マネージャープロセスから記憶ストアに到達する認証経路が存在しない

---

## フェーズ共通の約束

- フェーズ内の作業は TDD で進め、受け入れ基準は自動テスト化できるものからテストにする（SDK 実呼び出しが要るものは手動確認でよいが、確認結果を PR に書く）
- フェーズ完了 = 受け入れ基準全部 + CI green + 人間の確認。次のフェーズに勝手に進んでよいが、受け入れ基準を満たさないまま「概ね動く」で進まない
- 実装中に要件・設計の矛盾を見つけたら、コードで辻褄を合わせずに手を止めて人間に報告する（バグなのは文書ではなくコード、が原則。ただし文書側が間違っていると思うなら、それを言うのが正しい）
