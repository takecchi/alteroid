# ロードマップ — alteroid 実装計画

[architecture.md](./architecture.md) のフェーズ表 M0〜M5 を、実装を引き継ぐ AI が単独で遂行できる粒度に展開したもの。上位文書は [north_star.md](./north_star.md)（正典）→ [PRD.md](./PRD.md)（要件）→ [architecture.md](./architecture.md)（設計）。矛盾したら上位が勝つ。

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
- [x] 継続する依頼の器（ScheduleStore）: 「定期的に〜しておいて」を記憶とは別に持ち、時刻が来たら必ず届く。周期は cron で書ける（人間が cron でできる指定に負けない）。クローンの道具と人間の CLI / HTTP API の両方から足せて外せる

**受け入れ基準**:
1. 人間が一切入力しない状態で、時間起点とクローンの発意からジョブが起きて完了する
2. 承認が要る仕事が保留のまま、他の仕事が進み続ける
3. PRD「自律」の起点4つ（人間・時間・外部イベント・発意）がすべて動作する
4. 日報が毎日生成され、`alteroid chat` と HTTP API で読める
5. 人間が「定期的に〜しておいて」と一度頼めば、デーモンを作り直しても・会話が要約に潰れても、その時刻に依頼の本文つきでクローンへ届く。落ちていた間に過ぎた予定は起き直したときに1回だけ拾う

## M4 — クラウド（PostgreSQL、daemon / manager-runner の分離）

**ゴール**: ローカルと同じものが、コンテナ + PostgreSQL で常駐する。そのうえで、**マネージャーから記憶ストアへ到達する経路が構造的に存在しない**。

- [x] `storage-pg`: drizzle で PersonaStore / JournalStore / JobStore（記憶は同じ Markdown 文書をテーブルに格納。人間の閲覧・編集は CLI / API 経由で担保）
- [x] SDK SessionStore アダプタで セッション永続化も同じ PostgreSQL へ
- [x] **daemon / manager-runner の分離**: SDK（マネージャーと作業者）は runner の中だけで走る。runner は判断も権限一覧も独自のエージェント基盤も持たず、SDK セッションの start / send / stop / resume と出来事の返送だけを担う
- [x] `RunnerRegistry`（`list` / `get` / `select`）を間接層として置く。M4 の `select` は唯一の `runner-primary` を返すだけでよいが、**デーモンは固定 URL も runner のローカルパスも前提にしない**
- [x] runner は安定した `runner_id` を持ち、JobStore に `manager_id → runner_id → session_id → workspace locator` を永続化する
- [x] デーモン再起動時、**走行中だったマネージャーは実際に resume する**（runner が生きていれば繋ぎ直し、器ごと落ちていれば預かった生ログから再開）。待機中（`done`）の遅延 resume とは分ける
- [x] Dockerfile + docker compose（daemon + manager-runner + postgres の3コンテナ）。認証は `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token`）をシークレット注入
- [x] **制御面の分離**: runner API はマネージャーから叩けない（TCP を開かず Unix ソケットのみ、ソケットはデーモン UID の 0600、合鍵は runner にハッシュだけ、SDK 子プロセスは別 UID）。マネージャーが自分の許可確認に自分で答えられないことを実際の子プロセスから検証する
- [x] 記憶ストア認証情報の分離を検証: runner と子プロセスに DB 接続情報が**無く**、runner から DB への経路も**無い**こと

**受け入れ基準**:
1. `docker compose up -d` + トークン注入で起動し、M1〜M3 の受け入れ基準が同じように通る（MCP・許可確認・監査・生ログ経路が分離後も落ちない）
2. コンテナ再起動後、クローンは同じ人格で、走行中だったマネージャーの続きを把握している
3. マネージャープロセスから記憶ストアに到達する認証経路が存在しない
   - manager から daemon の `/proc`・環境変数・人格データが見えない
   - manager / runner に Persona 用 DB 資格情報が無い
   - runner から Persona 用 DB へ接続できない
4. マネージャープロセスから runner の制御面（list / answer / send / stop / resume / transcript）に到達できない
   - 自分宛の許可確認に自分で答えられない（クローンと人間を迂回できない）

## M5 — 複数 manager-runner と水平スケール

**ゴール**: runner を増やしても、能力もプロトコルも1台構成と同じままでいる。

- [ ] runner の登録・heartbeat・生存判定
- [ ] 新規マネージャーの runner 配置（CPU・メモリ・稼働セッション等、**実行環境の資源**を材料にする。固定の `maxManagers` のような人工上限は置かない）
- [ ] `manager_id → runner_id` に基づく sticky routing
- [ ] runner 障害時の session 再開と workspace 復旧
- [ ] workspace locator の運用選択（runner-volume / 共有 FS / Git 再構築）
- [ ] Railway の複数 Service、AWS ECS/Fargate 等で runner 数を増減できるデプロイ定義
- [ ] 1 runner 構成と能力・プロトコルが同じであることの回帰テスト

**受け入れ基準**:
1. runner を2台以上登録し、複数マネージャーが配置される
2. `manager_send` / 許可確認 / 報告が、常に割り当て先の runner へ届く
3. デーモン再起動後も runner affinity を復元できる
4. 1台の runner 停止時、永続化済み session と workspace から別 runner で継続できる。できない場合は、復旧不能な未永続状態を人間へ明示できる
5. runner 数を増減しても、人工的なセッション数上限や能力削減が入らない

**このフェーズの地雷**: 配置の判断（資源を見る）と、能力の制限（何本までと決める）を混同しないこと。前者は実行環境の話であり、後者は禁止2の違反である。

---

## フェーズ共通の約束

- フェーズ内の作業は TDD で進め、受け入れ基準は自動テスト化できるものからテストにする（SDK 実呼び出しが要るものは手動確認でよいが、確認結果を PR に書く）
- フェーズ完了 = 受け入れ基準全部 + CI green + 人間の確認。次のフェーズに勝手に進んでよいが、受け入れ基準を満たさないまま「概ね動く」で進まない
- 実装中に要件・設計の矛盾を見つけたら、コードで辻褄を合わせずに手を止めて人間に報告する（バグなのは文書ではなくコード、が原則。ただし文書側が間違っていると思うなら、それを言うのが正しい）
