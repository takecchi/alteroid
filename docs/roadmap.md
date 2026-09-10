# roadmap — Phase 1 実装計画・技術上のリスク・設計上まだ判断が必要な点

`docs/vision.md` の続き。ここでは「何を作るか」ではなく「どの順番で、いつまでに、何を確かめながら作るか」を扱う。

工数の見積もり（人日など）は載せない。根拠となる実績が無い状態で数字を出すと、それ自体が誤った確信を生む。代わりに「何ができたら次の段階へ進めるか」という完了条件で書く。

---

## 1. Phase 1（MVP）の範囲

### 1.1 オーナー指定の範囲

- monorepo の構成
- core interfaces
- Observation / Memory の型
- PostgreSQL 実装の MemoryStore
- pgvector
- EmbeddingProvider
- `observe()`
- 基本の Memory Extraction
- `recall()`
- vector + tag + freshness のスコアリング
- 説明とスコア内訳
- unit テスト・integration テスト
- サンプルのチャットアプリ
- **Background Cognition（`reflect()` の実運用・Scheduler）は必須にしない**

### 1.2 追加する項目とその理由

以下は、この計画の中で Phase 1 に追加したものである。**すべて「後から入れられない、または後から入れると割高になる」という理由に基づく。** 各項目に理由を併記する。

| 項目 | なぜ Phase 1 か（＝なぜ後から入れられないか） |
|---|---|
| `packages/testkit`（store 適合テスト一式） | 「差し替え可能」は、実行可能な適合テストが無ければ願望にすぎない。core が定義するのは型だけでなく冪等性・テナント分離・順序といった振る舞いの契約であり、それを検証する手段を持たないまま2つ目の adapter を書くと、契約は気づかれずに崩れる。 |
| `memory_events`（監査ログ）と `status` 列 | 監査ログは「記録を開始する前に起きたこと」を遡って復元できない。後から追加すると、追加前の期間だけ永久に空白になる。`status` も同様で、後付けだと既存データの `status` を推測で埋めることになり、正確性を失う。 |
| `superseded_by_id` 列（列だけ。関係グラフ本体は Phase 2） | 列を後から追加すること自体はマイグレーションで可能だが、「対向する記憶をスコアに関係なく必ず一緒に取得する」という Phase 1 の検索契約（`recall` が `status = 'active'` で絞る際の前提）が、この列の存在を最初から要求している。列が無い状態で検索ロジックを書き、後から列を足すと検索側の作り直しになる。 |
| `recalls` + `recall_usages` テーブル | 説明可能性（「何を返し、何を返さなかったか」の記録）と強化（「実際に使われたものだけ強化する」）は、同一の機構——recall を識別子付きで記録し、使用報告を受け取る仕組み——を必要とする。片方のためだけに作ると、もう片方のために作り直すことになる。 |
| `decay_floor_at` 列（Phase 1 では書き込むだけ） | Phase 2 で忘却の実処理を入れる際、この列がスキーマに無いとマイグレーションと同時に全件の再計算が発生する。Phase 1 のうちから書き込んでおけば、Phase 2 は「読み取りに使い始める」だけで済む。 |
| `recall` の `omitted` と `usage` | 説明可能性は後付けできない。パイプラインの各段（フィルタ・閾値・予算）が「なぜ落としたか」を持ったまま返す設計になっていないと、後から理由だけを復元することはできない。 |
| 目次帯（`index`）。ただし Phase 1 は第3階（群カウント）のみ、digest 帯は Phase 2 | digest 帯は taxonomy（ラベルの語彙管理）を要求するが、群カウントは subject 単位の集計だけで成立する。「recall が0件でも、何が在るかは言える」という最も価値の高い性質は、群カウントだけで既に得られる。 |

**⚠ 2026-09 訂正（digest 帯の実装 PR、[ADR 0073](./decisions/0073-digest-band-bounded-without-taxonomy.md)）: 上の表の「digest 帯は taxonomy（ラベルの語彙管理）を要求する」は誤りだった。**要求しない。taxonomy を要するのは `taxonomy` 軸によるグルーピングのほうであり、帯そのものではない（[recall.md](./recall.md) §5 の訂正を見よ）。**digest 帯はオーナーの指示により前倒しで実装済みであり、schema / migration の変更を伴わなかった。**⛔ ただし前倒ししたのはこの1機能だけであり、Phase 1 / Phase 2 の線は動いていない。


### 1.3 Phase 1 から明示的に外すもの

- 関係グラフ本体（`superseded_by_id` / `contradicts` を辿るグラフ探索）
- reranking
- `reflect()` の実運用（Background Cognition）
- `packages/bullmq`（Scheduler の実装）
- HTTP server（`packages/server`）

これらは Phase 1 の範囲外だが、土台となる列・テーブルは 1.2 の通り Phase 1 に含める。

---

## 2. 実装の順序

7つの段階に分ける。各段階は前の段階の成果物に依存する。**「何日で終わるか」ではなく「何ができたら次に進めるか」で区切る。**

### 段階1: 土台

- monorepo の構成（`packages/core`, `packages/testkit` の骨格）
- core interfaces（`MemoryStore`, `VectorStore`, `EmbeddingProvider`, `Scheduler` などの型定義。zod によるスキーマ）
- Observation / Memory の型（`status`, `superseded_by_id`, `decay_floor_at`, `embeddingStatus`, `provenance` を含む）

**完了の判定条件**: `packages/core` が単体でビルドでき、外部実装が無くても型として矛盾が無い。`testkit` の適合テストの雛形（2テナント分のデータを入れて走らせる枠組み）が、プレースホルダ実装に対して動く（中身の正しさではなく、テスト自体が実行できることを確認する段階）。

### 段階2: 保存

- `packages/postgres` の `MemoryStore` / `VectorStore` 実装
- pgvector の導入。ベクトル索引（HNSW）の DDL は手書きのマイグレーションで管理する（`drizzle-kit push` には任せない。理由は §4 のリスク表を参照）
- `status`, `superseded_by_id`, `decay_floor_at`, `embeddingStatus` の各列
- `memory_events`（監査ログ）、`recalls` + `recall_usages`
- 依存: 段階1の interface が確定していること

**完了の判定条件**: `testkit` の適合テストが postgres 実装に対してすべて通る（2テナント分離のテストを含む）。ベクトル索引を使う `ORDER BY` について、`EXPLAIN` で実際に HNSW 索引が使われることを確認する検査が通る。

### 段階3: 取り込み

- `observe()` の実装
- 基本の Memory Extraction（Observation から Memory を抽出し、digest を生成する。digest は NOT NULL）
- `EmbeddingProvider`（`packages/openai`）
- 冪等性: `externalId` による Observation の重複排除、`(observationId, extractorVersion)` による抽出の冪等性、`(tenant_id, source_observation_id, extractor_version, content_hash)` の一意制約
- 依存: 段階2の store

**完了の判定条件**: 同じ Observation を二重に送っても Memory が重複して作られない。抽出された Memory には必ず digest が入っている。`embeddingStatus` が `pending → ready`（または `failed`）に正しく遷移する。

### 段階4: 想起

- `recall()` の実装
- 二段検索（段1: 索引が効く形のフィルタ + ANN、段2: over-fetch した候補への再スコア）
- vector + tag + freshness のスコアリング（freshness は `occurred_at ?? recorded_at` を使う）
- `omitted` の分類、`usage` の計測、`budget` オプション
- 依存: 段階3で埋め込み済みの Memory が存在すること

**完了の判定条件**: `omitted` の各 kind（少なくとも `filtered`, `below_threshold`, `over_limit`, `budget_dropped`, `not_indexed`, `ann_truncated`）が、Phase 1 で発生しうる条件下で実際に返せることを確認済み。段1の `ORDER BY` が `EXPLAIN` で HNSW 索引を使っていることを確認済み。

### 段階5: 説明

- `explain.stages`（どの段が走り、どの段が走らなかったかのトレース）
- スコア内訳の返却
- 目次帯の第3階（群カウント）

**完了の判定条件**: `recall` の返り値だけを見て、「なぜこの Memory が返ったか／返らなかったか」を人間が説明できる。第3階の群カウントの総和が、スコープ内の総数と一致する（被覆不変条件が `recall()` 1回の返り値について成立する）。

### 段階6: 検証

- unit テスト・integration テスト一式
- `testkit` を使った postgres 実装への網羅的な適用

**完了の判定条件**: CI で `core` / `testkit` / `postgres` / `openai` の主要パスが緑になる。

### 段階7: サンプル

- サンプルのチャットアプリ
- 依存: 段階6が緑であること（壊れている可能性のある API の上にサンプルを書かない）

**完了の判定条件**: サンプルアプリが `observe → recall` の往復を実演し、`omitted` と `usage` を画面またはログに可視化する。

### 抽出モードについての注記

段階3の Memory Extraction は `extract: 'sync' | 'deferred'` を API として持つが、**既定値をどちらにするかは §5 の通りオーナー判断待ち**である。Phase 1 は「Background Cognition を必須にしない」方針のため、`sync` を既定にしても矛盾しないが、この計画自体はどちらか一方に決め打ちしていない。

---

## 3. Phase 2 / 3 / 4

Phase 1 で入れた土台が、後続フェーズをどう安くしているかを1行ずつ結びつける。

### Phase 2

| 項目 | Phase 1 の何が効いているか |
|---|---|
| 関係グラフ本体（`contradicts` / `supersedes` を辿る探索） | `superseded_by_id` 列と `status` 列が既にあるため、フィルタ済みの集合に対してグラフ探索を足すだけで済む。フィルタ自体を作り直す必要が無い。 |
| 目次帯の第2階（digest 帯）、taxonomy の語彙登録・昇格フロー | Phase 1 でも書き込みは自由（open）で、未登録のラベルは `proposed` として既に記録されている。Phase 2 は「フィルタへの参加可否」の切り替えを足すだけで済む。第3階のカウントと `omitted.kind = 'filtered'` の仕組みがあるため、digest 帯を追加しても「0件でも何が在るかは言える」保証は壊れない。 |
| `purge()`（物理削除） | `memory_events` のイベント種別に `purged` を Phase 1 のスキーマから含めてあるため、監査ログのスキーマ変更なしに追加できる。 |
| 忘却の実処理（`decay_floor_at` を使った検索時フィルタとアーカイブ掃引） | Phase 1 では `decay_floor_at` を書き込むだけで読み取りに使っていない。Phase 2 で `WHERE decay_floor_at > now()` を使い始めるだけで、列追加や既存行の再計算は不要。 |
| `valid_from` / `valid_until`（時間的妥当性） | Phase 1 で `occurred_at` / `recorded_at` / `last_reinforced_at` の3つの時刻を混ぜずに区別してあるため、4本目・5本目の時計として自然に追加できる。 |

**⚠ 2026-09 訂正（digest 帯の実装 PR、[ADR 0073](./decisions/0073-digest-band-bounded-without-taxonomy.md)）: 上の表の「目次帯の第2階（digest 帯）」は、オーナーの指示により前倒しで実装済みである。**同じ行に並記された **`taxonomy` の語彙登録・昇格フロー（`labels` / `memory_labels`）は Phase 2 のままである**——2つは同じ行に書かれているが、機構としては独立しており、帯のほうは taxonomy を要さなかった。**⛔ この表の他の項目も前倒しされていない。**


### Phase 3

| 項目 | Phase 1 の何が効いているか |
|---|---|
| `packages/bullmq`（Scheduler の実装）と Background Cognition（`reflect()`）の実運用 | Phase 1 で `deferred` 抽出を選んだ場合の transactional outbox パターンを設計に組み込んであれば、Phase 3 は「outbox を運ぶ役」を `InlineScheduler` から BullMQ に差し替えるだけで済む。キューの選択が支配的な決定にならない。 |
| Redis をキャッシュとして使う用途 | Phase 1〜2 では Redis を要求しない設計（Postgres 必須・Redis 任意）を維持してあるため、Phase 3 で初めて Redis を導入しても既存の保証に影響しない。 |
| 監査ログの保持期間ポリシーの実運用（テナント単位の設定、期限切れ削除の `purged` イベント化） | `memory_events` のスキーマと `purged` イベント種別が Phase 1〜2 で既にあるため、Phase 3 は削除ジョブの実装だけで済む。 |

### Phase 4

| 項目 | Phase 1 の何が効いているか |
|---|---|
| `packages/server`（HTTP）、`packages/sdk`（client） | Phase 1 で「`recall()` の戻り値にメソッドを生やさない」という決定をしてある（`docs/vision.md` 参照）ため、`RecallResult` などの戻り値がそのまま JSON としてシリアライズでき、HTTP 越しに使える。Phase 4 になって初めてシリアライズできないことに気づく、という事態を避けている。 |

---

## 4. 技術上のリスク

各リスクに「兆候（何が起きたらそれだと分かるか）」と「そのときどうするか」を必ず添える。

| リスク | 兆候 | 対処 |
|---|---|---|
| over-fetch 近似の取りこぼしが、利用者に「記憶が消えた」と見える | `omitted.kind = 'ann_truncated'` の発生率が高い、または「知っているはずなのに出てこない」という報告が増える | over-fetch 係数（k'）を上げる。段1で落ちた境界付近のスコアをログして閾値を調整する。取りこぼしの可能性そのものは常に `omitted` に出し、隠さない。 |
| 抽出 LLM の品質が全体の質を決めてしまう（garbage in） | digest が空虚・的外れになる、抽出される Memory の件数が異常に多い／少ない、`extractorVersion` を上げた途端に既存 Memory との整合性が崩れる | `extractorVersion` ごとの冪等性を保ったまま並行比較できるようにする。抽出結果のサンプルレビューを運用に組み込む。alteroid の「分類に失敗したら厚い側（安全側）に倒す」という安全弁を抽出にも取り入れる。 |
| 埋め込みモデル移行のコスト（全件再 embed） | 新しい embedding モデルを使いたくなる、または既存モデルが非推奨化される | 埋め込み空間ごとにテーブルを分ける設計（`memory_embeddings_<space>`）を維持する。移行は新しい空間の追加であって、既存空間の置換ではない。 |
| `decay_floor_at` の設計が、half-life をテナントごとに変えたくなった瞬間に再計算全件を要求する | 「このテナントだけ忘却を早く／遅くしたい」という要望が来る | half-life は Memory 単位の列として持ち、テナント設定はあくまでデフォルト値としてのみ使う。既存行の全件再計算は発生させない。 |
| 監査ログの量 | `memory_events` テーブルのサイズが MemoryStore 本体を上回るペースで伸びる | テナント単位の保持期間設定と、期限切れ削除を `purged` イベントとして残す仕組みを Phase 3 で実装する。スキーマは Phase 1 から仕込んである。 |
| multi-tenant での ANN 索引の効き（テナントごとの偏り） | 特定テナントだけ recall のレイテンシが悪化する、`EXPLAIN` で想定外の Seq Scan が出る | `tenant_id` を索引の先頭に置く設計を維持する。テナントごとの件数分布を監視し、必要ならパーティショニングを検討する（Phase 3 以降の課題として明示する）。 |
| 「認知レイヤー」という位置づけが、実際には利用側のプロンプト構築と密結合になる | 呼び出し側が mnemora の返り値を丸ごとプロンプトに焼き込む実装になり、`budget` / `omitted` / `usage` を無視し始める | サンプルアプリで `budget` と `omitted` の扱いを模範として示す。「載せるかどうかを決めるのは呼び出し側の責任」であることをドキュメントで明記する。 |
| Drizzle 公式ガイドの例（`1 - cosineDistance(...)` を降順で並べる書き方）では HNSW 索引が効かない可能性がある | `EXPLAIN` で Seq Scan が出る、recall のレイテンシがデータ量に比例して悪化する | 規約として、`ORDER BY` には距離演算子の結果をそのまま昇順で書き、式にしない。`testkit` に `EXPLAIN` で索引が使われることを確認する検査を含める（段階2の完了条件と同じもの）。 |
| `drizzle-kit push` が生成する HNSW の DDL に operator class が欠落する不具合が報告されている | `push` で作成した索引が `EXPLAIN` で使われない、または `CREATE INDEX` の operator class が想定と違う | ベクトル索引の DDL は手書きのマイグレーションで管理し、`push` に任せない。 |
| フィルタ問題（`tenant_id` / `status` / `decay_floor_at > now()`）とスコア問題（減衰・タグ・鮮度を掛ける再スコア）を混同して対処を誤る | `hnsw.iterative_scan` を有効にしたのにスコアの取りこぼしが直らない（あるいはその逆） | 二つを明確に分けて扱う。フィルタ問題には iterative index scan と `hnsw.ef_search` の調整、スコア問題には over-fetch と段2の再スコアで対処する。片方の対処でもう片方が直ると期待しない。 |
| pgvector のバージョン要件（iterative scan は 0.8.0 以降、CVE-2026-3172 の修正は 0.8.2） | マネージド Postgres の環境で `hnsw.iterative_scan` が使えない、または既知の脆弱性が残ったバージョンが動いている | `SELECT * FROM pg_available_extensions WHERE name = 'vector'` で各環境のバージョンを確認する運用手順をドキュメントに明記する。要件を `>= 0.8.0`、推奨を `>= 0.8.2` として明文化する。**マネージド Postgres 各社が実際に提供するバージョンは確認できていない**（§6 参照）。 |
| 「計測を見せれば行動が変わる」という前提が、実は未検証のまま採用されてしまう | `usage` を返しているにもかかわらず、呼び出し側のプロンプトが肥大し続ける | 下記「計測と抑止を混同しない」を参照。 |

### 計測と抑止を混同しない

alteroid には「焼かれた文字数と増分」を計測して返す機能が実在する。ただし **alteroid のコード自身が「この機能が効くかは未検証」と明記している。** 実測で 37,515 文字から 51,751 文字（+38%）まで増えたのを見ながら、使う側が畳む行動を取らなかった、という事例がコード内に記録されている。

⟹ **「測って見せれば行動が変わる」という前提を、検証済みの知見として輸入してはならない。**

mnemora はこの前提を採用しない。mnemora は計測（`usage`）を提供するが、**それが肥大を抑止すると主張しない。** 抑止する力を持つのは計測ではなく、`budget` という強制力のある仕組みである（`budget` を超えたら実際に候補を落とす）。

**設計上の帰結**: 計測（`usage`）と強制（`budget`）を分けて、両方を持つ。計測だけで済ませない。

---

## 5. 設計上まだ判断が必要な点

以下の6項目に限る。それ以外は足さない。いずれも「妥当なデフォルトを技術側だけで決め切れない」——製品の性格・データの安全性・事業の前提に関わる判断であるため、オーナーの判断を必要とする。

**2026-09-06 現在、6項目すべてが解決済みである。**5.1 / 5.2 は以前から、5.3〜5.6 は 2026-09-06 の**オーナー回答**による（各項の追記を参照）。**この節は今後も「判断が必要な点」を集める場所であり、空になったからといって畳まない。**

### 5.1 npm org `mnemo` が取れなかった場合の名前

**なぜオーナーが決めるべきか**: npm という外部サービスの空き状況に依存する上、ブランディングと将来の公開範囲に関わる判断であり、設計側の裁量だけで決め切れる話ではない。

**推奨**: `@mnemo/*` が取得できるなら維持する。取れない場合は `@mneme/*` を推す。ギリシャ神話の記憶の女神で意味が近く、unscoped の `mneme` は存在するが scope は別なので衝突しない。`@anamnesis/*` は「想起」そのものを指す語で意味は強いが読みにくい。`@recall-os/*` は機能語で衝突しにくいが名前として凡庸。

**2026-09 追記（オーナー決定、`rename/mnemo-to-mnemora` で改名済み）**: 名前を `mnemora`（スコープは `@mnemora/*`）に決定した。**これは上記の推奨でも、上に挙げた候補（`@mneme` / `@anamnesis` / `@recall-os`）のどれでもない。**候補の外にある名前が、オーナーの判断で採られた。npm の org `@mnemora` はオーナーが作成し、使用できることを確認している（**確認したのはオーナーであり、この計画の書き手ではない**）。これにより「org `mnemo` が取れなかった場合」という前提条件そのものが消えた。決定の記録は `docs/decisions/0014-package-name-mnemora.md`、改名前の経緯（当時の調査・当時の推奨）は `docs/vision.md`「名前について」の経緯節にそのまま保全してある。この項目は解決済みであり、これ以上オーナーの判断待ちではない。

### 5.2 抽出の既定を `sync` にするか `deferred` にするか

**なぜオーナーが決めるべきか**: これは製品の性格そのものを決める判断である。`sync` は `observe()` が遅くなる。`deferred` は「言った直後に思い出せない」という体験になる。どちらが正しいかは技術では決まらず、想定する利用先の性質次第である。

**推奨**: MVP の既定は `sync`。Phase 1 は「Background Cognition を必須にしない」方針を取っており、`deferred` を既定にすると Scheduler または outbox の運搬役が常に必要になり、「切っても成立する」という設計方針と摩擦を起こしやすい。ただし API としては `extract: 'sync' | 'deferred'` を両方持ち、テナントまたは呼び出し単位で選べるようにしておく。

**2026-09 追記（マネージャー決定 D2、roadmap.md 段階3で実装済み）**: 上記の推奨どおり、既定を `sync` に決定した。`ObserveInput.extract` は省略時 `'sync'` になる（`packages/core/src/runtime.ts`）。この項目は解決済みであり、これ以上オーナーの判断待ちではない。

### 5.3 既定の忘却を、実際に落とすのか、落とさず順位を下げるだけにするのか

**なぜオーナーが決めるべきか**: データを失う判断はプロダクトの信頼性に直結する。一度物理的に削除すると取り戻せない場合があり、これは技術的な最適解では決まらない。

**推奨**: 既定は「落とさず、順位を下げる／隠す」（`status` を使った論理的な扱い）。物理削除は `forget()` / `purge()` という明示的な操作として別に持つ。既定の忘却で物理的に消してしまうと、利用者が気づかないうちに記憶が失われる。可逆性を既定にしておき、不可逆な削除は明示操作にする方が安全側に倒れる。

**2026-09 追記（オーナー回答 2026-09-06。マネージャー経由で伝達された）**: **既定の忘却は、実際に落とさず順位を下げる。物理削除は明示的な操作として分ける。**上記の推奨のとおりの内容だが、決めたのはオーナーである。この項目は解決済みであり、これ以上オーナーの判断待ちではない。

**⚠ 決定を記録しただけであり、決定どおりに動いているという意味ではない。**現物を読んで確かめた実装状況（2026-09-06 時点）: `MemoryStatus` に `'forgotten'` は在る（`packages/core/src/memory.ts`）が、**`forget()` / `purge()` に当たる公開操作は `packages/core` に存在しない**（`runtime.ts` と `interfaces/memory-store.ts` を検索して0件）。`decay_floor_at` も書き込むだけで読み取りには使っていない（§3 Phase 2 の表のとおり）。**つまり「落とさない」側は既定として成立しているが、「明示操作としての物理削除」はまだ入口が無い。**

**2026-09-10 追記（Issue #102、[ADR 0087](./decisions/0087-runtime-forget-shape.md)）**:
上の ⚠ のうち **`forget()` の側は解消した**——`Runtime.forget(ctx, target, opts?)` を実装し、
`status='forgotten'` への論理削除と `memory_events` への `forgotten` イベント追記を
`MemoryStore.updateStatusWithEvent`（ADR 0031）で同一トランザクションに閉じた。
⚠ **`purge()`（物理削除）の入口は依然として無い**（`docs/memory-model.md`「forget() と purge() を
分ける」のとおり Phase 2 以降）。⚠ **`decay_floor_at` を読み取りに使っていない点も変わっていない**
——`forget()` は明示操作であり、§5.3 が言う「既定の忘却」（減衰による自然な弱化）とは別の話である。

### 5.4 監査ログの既定保持期間

**なぜオーナーが決めるべきか**: 適正な保持期間はコンプライアンス要件（法域・業種）によって変わり、技術だけでは決まらない。

**推奨**: 既定は無期限。テナント単位で有限に設定できるようにする。監査ログの目的は「消えたことが見える」ことにあり、既定で早期に消してしまうとその目的自体が弱まる。ただし運用コストがあるため、テナント側から明示的に短縮できる経路は必須にする。

**2026-09 追記（オーナー回答 2026-09-06。マネージャー経由で伝達された）**: **監査ログの既定保持期間は無期限。⚠ テナント単位で短縮できる口は「必須」である**（オーナーが「必須」と明示した）。上記の推奨のとおりの内容だが、決めたのはオーナーである。この項目は解決済みであり、これ以上オーナーの判断待ちではない。

**⚠ 実装状況（2026-09-06 時点、現物を読んで確かめた）**: `tenant_settings` には `event_retention_days`（`NULL` = 無期限）列が既に在る（`packages/postgres/src/schema.ts`）。**しかし `TenantSettingsStore` interface が公開しているのは `getDefaultHalfLifeHours` だけであり、保持期間を読み書きする経路は無い**（interface 自身が「テナント設定の完全な CRUD は本 PR の範囲外」と書いている）。**⟹ 「短縮できる口は必須」という条件は、いまの公開 interface では満たせない。**

**追記（2026-09-07、[ADR 0050](./decisions/0050-tenant-event-retention.md)）**: この条件を塞いだ。`TenantSettingsStore` に `getEventRetention`/`setEventRetention` を足し、`event_retention_days` の3状態（行が無い/行は在るが `NULL`/日数）を区別して読み書きできるようにした。`PostgresTenantSettingsStore` は UPSERT で書く（マイグレーションは追加していない。列は既に在ったため）。`InMemoryTenantSettingsStore` は「行」を持つ形に作り直し、Postgres と同じく half-life だけ設定したテナントが `unlimited` を返すようにした。値の検査（正の整数のみ、延長は許す）は `packages/core` の `assertValidEventRetentionDays` に1箇所だけ持たせ、両実装が共有する。削除処理（期限切れ行を実際に消すジョブ）は`docs/memory-model.md` §9 が指定する別の独立した保守ジョブの範囲であり、本追記の対象外。**⟹ §5.4 の条件は満たされた。**

### 5.5 推論（`inferred`）を既定の recall に含めるか除外するか

**なぜオーナーが決めるべきか**: 「AI の推論を事実と並べて出す」ことへのリスク許容度は、想定する利用先（業務エージェント／個人 AI／ゲーム NPC）によって大きく異なり、mnemora 単独では決められない。

**推奨**: 既定は含める。ただし `provenance.kind` によって区別できる形で返し、除外するオプションを用意する。除外を既定にすると、AI が導出した有用な推論が最初から見えなくなり、mnemora の価値の一部（内省・統合）が届かなくなる。区別して見せる方が「文脈を剥がして提示しない」という全体の原則にも合う。

**2026-09 追記（オーナー回答 2026-09-06。マネージャー経由で伝達された）**: **推論（`inferred`）を既定の recall に含める。⚠ ただし `provenance.kind` で区別して返すこと。**上記の推奨のとおりの内容だが、決めたのはオーナーである。この項目は解決済みであり、これ以上オーナーの判断待ちではない。

**実装状況（現物を読んで確かめた、2026-09-06 時点）**: 前半（既定で含める）は満たされている——`RecallQuery.excludeProvenanceKinds` は既定で空であり、`recall-runtime.ts` は指定された `kind` だけを落とす。**後半（`provenance.kind` で区別して返す）は満たされていなかった**——`RecalledMemory`（`packages/core/src/recall.ts`）は `memoryId` / `digest` / `retrievedVia` / `companionOf` / `score` しか持たず、`provenance` を持っていなかった。呼び出し側は `recall()` の返り値だけでは stated と inferred を区別できなかった。

**追記（2026-09-06、[ADR 0035](./decisions/0035-recalled-memory-provenance-kind.md)）**: 後半の条件を塞いだ。`RecalledMemory` に `provenanceKind: ProvenanceKind` を**必須の欄として**足し、値はその Memory 自身の `provenance.kind` から引き継ぐ。**`provenance` 全体は返さない**——求められているのは区別であって中身の追加ではない。**⟹ §5.5 の条件は両方とも満たされた。**

**この決定が解いた保留**: [ADR 0033](./decisions/0033-what-decided-the-rank-in-the-retrieval-bench.md) が測った diet probe の失敗（記憶は症状、質問は帰結を訊いている）は、`inferred` の記憶を作れば埋まる形をしている。**§5.5 が未決だった間は、その実装は「オーナーの判断の前提そのものを先に決めてしまう」ことになるため保留されていた。**この回答でその保留は解けた。

### 5.6 テナントあたりの想定記憶数の桁（100件か、100万件か）

**なぜオーナーが決めるべきか**: 目次帯の設計（第3階カウントの近似許容範囲、索引戦略）は想定規模によって大きく変わる。これは技術選定ではなく「誰に売るか」という事業の前提の判断である。

**推奨**: 100万件級を前提に設計しておく。現に本計画では第3階の群カウントについて近似を既定で許可する設計にしている。小規模を前提に作ると大規模テナントが来たときに再設計が必要になるが、大規模を前提にしたうえで小規模テナントに適用する場合は近似許可オプションをオフにするだけで済む。片方向にしか安全に倒せない判断であるため、大きい側を前提にする。

**2026-09 追記（オーナー回答 2026-09-06。マネージャー経由で伝達された）**: **テナントあたりの想定記憶数は 100万件級を前提に設計する**（小さい側へは後から倒せる、という理由も含めて確定した）。上記の推奨のとおりの内容だが、決めたのはオーナーである。この項目は解決済みであり、これ以上オーナーの判断待ちではない。

---

## 6. 確かめていないこと

この計画の根拠とした調査のうち、確認できなかったものを一覧にする。

- npm org `mnemo` の取得可否（org ページが未ログインだと 403 を返すため判定できなかった）
  - **2026-09 追記**: `mnemora` への改名により、この論点は消えた。npm の org `@mnemora` はオーナーが作成し、使用できることを確認している（確認したのはオーナーである）。§5.1 を参照。
- マネージド Postgres 各社が実際に提供する pgvector のバージョン
- 可変次元のベクトル列を Drizzle でどう表現するかの一次情報（空間ごとにテーブルを分ける設計で回避したため、mnemora には影響しない）
- Prisma の monorepo における生成物配置（Drizzle を採用したため、影響は小さい）
- 段階的 materialize（hot / warm / cold）の実務での採用度（この計画では採らない設計のため、影響しない）
- 「計測を見せると行動が変わる」という前提（alteroid 自身が「未検証」と明記しており、この計画ではこの前提を採用しないという判断をしている）
