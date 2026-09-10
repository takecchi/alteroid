# architecture

対象読者: オーナー（takecchi）とそのクローン。設計判断の記録であって入門資料ではない。
用語の定義は [docs/vision.md](./vision.md)、記憶モデルの詳細は [docs/memory-model.md](./memory-model.md)、
recall の詳細は [docs/recall.md](./recall.md)、フェーズ計画は [docs/roadmap.md](./roadmap.md)、
個別の決定理由は [docs/decisions/](./decisions/) を見ること。この doc は「何がどう決まっているか」を書く。

---

## 0. 設計を貫く一本の原則

**文脈を剥がして提示しない (Qualified Presentation)。**

これは mnemora のどの機能よりも先にある規律で、三つの姿で現れる。

1. **争われている主張は、それを争う相手と必ず同時に提示する**（矛盾の扱い）
2. **推論は、その根拠と必ず同時に提示する**（provenance）
3. **結果は、そこから漏れたものと必ず同時に提示する**（explainability / 不在の分類）

この三つは別々の機能一覧ではない。**同じ一つの規律**が、矛盾・推論・欠落という三つの適用先に
現れているだけである。以降の各節に出てくる `omitted`・`contested`・`provenance.basis`・
`embeddingStatus`・`counter: 'heuristic' | 'exact'` は、すべてこの一本の規律の実装である。
節ごとにどの姿の適用かを一行で示す。

---

## 3. 全体アーキテクチャ

### 3.1 層

mnemora は既存の LLM アプリケーションの**下に敷く**認知レイヤーであり、エージェントフレームワークの
代替ではない。

```
┌────────────────────────────────────────────────┐
│ Application                                    │
├────────────────────────────────────────────────┤
│ Agent / LLM フレームワーク（LangGraph, Mastra, 自作 …） │
├────────────────────────────────────────────────┤
│ mnemora Cognitive Runtime                      │  ← mnemora はここ
│   observe / recall / reflect                   │
│   consolidate / forget                         │
├────────────────────────────────────────────────┤
│ Storage（Postgres）│ LLM（OpenAI/Anthropic）│ Queue（BullMQ）│
└────────────────────────────────────────────────┘
```

Application と Agent/LLM は mnemora の**利用側**であり、mnemora が知る必要はない。mnemora が知るのは
Runtime とその下（Storage / LLM / Queue の interface）だけである。プロンプトの組み立ては呼び出し側の
責務であり mnemora は行わない（この限界は [docs/recall.md](./recall.md) で詳説）。

### 3.2 Runtime 内部 — 5 つの動詞がどこを通るか

API 表面は 5 動詞に固定する（6 つ目を足さない。理由は [docs/decisions/](./decisions/) の ADR）。
それぞれが Runtime 内部でどの部品を通るかで分類する。

**書き込み系 — `observe(ctx, input)`**

```
observe
  → MemoryStore.append(Observation)        ── 同一トランザクションで
  → outbox テーブルへ抽出ジョブを書く         ── │ 同一トランザクションで（§3.4）
  → [extract: 'sync']     その場で LLMProvider 抽出 → MemoryStore.create(Memory)
  → [extract: 'deferred'] ここで終わる。抽出は後で Scheduler 経由（§3.3）
```

**読み出し系 — `recall(ctx, query)`**

```
recall
  → EmbeddingProvider.embed(query)
  → VectorStore.search()      ── 段1・ann チャンネル: ANN + 索引が効くフィルタのみ（tenant/subject/status/decay_floor_at）
  → LexicalStore.search()     ── 段1・lexical チャンネル: 全文索引 + 同じフィルタ（既定では走らない。ADR 0084）
  → ScoringStrategy(...)      ── 段2: 純関数で over-fetch 分を再スコア
  → MemoryStore                ── contested の対向を mandatory companion retrieval
  → recalls / recall_usages を記録（後述 §3.5・[docs/recall.md](./recall.md)）
  → RecallResult { memories, omitted, index, usage, explain }
```

recall が「返ったもの」と「返らなかったもの」を対等に返す構造そのものが、原則の姿3の実装である
（詳細は [docs/recall.md](./recall.md)）。

**背景系 — `reflect(ctx, opts)` / `consolidate(ctx, opts)`**

```
reflect / consolidate
  → Scheduler が起動（または runtime.tick() が明示的に駆動）
  → LLMProvider.completeStructured(...)   ── provenance.kind = 'reflected' | 'consolidated'
  → MemoryStore.create(Memory)
  → EventStore.append
```

**破棄系 — `forget(ctx, target)`**

```
forget
  → MemoryStore.updateStatusWithEvent(status: 'forgotten', event: kind='forgotten')
      ── status 更新とイベント追記を 1呼び出し・1トランザクションで（「必ず残る」の強制。ADR 0031）
```

`purge()`（物理削除）は Phase 2 以降。イベント種別だけは Phase 1 のスキーマに含める。

**実装済み**（[ADR 0087](./decisions/0087-runtime-forget-shape.md)、Issue #102）。
`Runtime.forget(ctx, target, opts?)` は対象ごとに `ForgetOutcome` を返す——
`forgotten` / `already_forgotten` / `not_found` / `conflicted` / `failed` / `not_attempted` の6値で、
**「忘れた」「もともと無かった」「見ていない」を潰さない。**冪等性は
`expectedStatus` による compare-and-swap（ADR 0030 と同じ道具）で買う。
⚠ **`forget()` は論理削除のみである**——行も `content` も消さない
（[docs/memory-model.md](./memory-model.md)「forget() と purge() を分ける」と対）。

### 3.3 Background Cognition を切っても成立する

`Scheduler` interface を切り、既定実装は **`InlineScheduler`**（キューを持たず、呼び出しの中で
即時実行する）。これにより Redis も BullMQ も無い最小構成が最初から成立する。

`observe()` は `extract: 'sync' | 'deferred'` を受ける。`sync` は observe の応答が遅くなる代わりに
その場で記憶になる。`deferred` は observe が速く返る代わりに、抽出が終わるまで recall に乗らない。
**どちらを既定にするかはオーナーの判断が必要**（[docs/roadmap.md](./roadmap.md) の「設計上まだ判断が必要な点」に残す。製品の性格を決める選択であり、
このドキュメントで先取りしない）。

`deferred` を選び、かつ Scheduler が `InlineScheduler`（キュー無し）の構成では、誰かが実際に
CPU を出して溜まったジョブを消化する必要がある。この継ぎ目を隠さず **`runtime.tick(ctx, opts)`**
として明示的に露出する。cron や手動呼び出しから叩ける形にする。「キューが無ければ黙って何も起きない」
という状態を作らない——これも姿3（漏れを黙って無かったことにしない）の適用である。

**2026-09 追記（ADR 0032）**: `opts.leaseMs` は必須で既定値を持たない——`tick(ctx)` を
引数無しで呼ぶことはできない。理由は §5.11 の `ClaimOutboxJobsOptions.leaseMs` を参照。

**2026-09 追記（ADR 0082、issue #105）**: `tick` が**実際に処理する分岐を持つ** kind は
`packages/core/src/runtime.ts` の `TICK_SUPPORTED_JOB_KINDS` が**唯一の出所**である
（`opts.kinds` の既定値もそこを指す）。**`OutboxJobKind` に名前が在ることは、`tick` が
それを処理することを意味しない**——この文書でもその一覧を数え直さない（散文の写しは
kind が増えた瞬間に黙って嘘になる）。そこに無い kind を `opts.kinds` に明示して渡した
ジョブは、`fail()` で**終端に落ち**、`TickResult.unsupported` に**名指しで**出る。
「黙って何も起きないまま lease が切れる」形にはしない——上の「キューが無ければ黙って
何も起きない」を作らない、を outbox の側でも守るということである。

### 3.4 transactional outbox

`observe()` の DB コミットと「抽出ジョブを積む」は同一トランザクションでなければならない。
DB のトランザクションの中から Redis（BullMQ）へ直接書くと、コミットとエンキューが分離するため
at-least-once が壊れる（DB がコミットされたのにジョブが飛ばない、または DB がロールバックしたのに
ジョブだけ残る、のどちらかが起こり得る）。

そのため `observe()` は抽出ジョブを **`outbox` テーブル**へ書く。実際のキューへは別の運搬役
（relay）が outbox の未処理行を読んで渡す。`deferred` を Phase 1 に持つ以上、outbox も Phase 1 の
成果物に含める。運搬役の実装がまだ `InlineScheduler` だけであっても、outbox というテーブルと
書き込み契約自体は最初から要る。

**実装（roadmap.md 段階3、ADR 0012）**: `packages/core/src/runtime.ts` の
`createRuntime(deps: RuntimeDeps): Runtime` が `observe(ctx, input)` / `tick(ctx, opts)` を
実装する。`deps` には `MemoryStore` / `OutboxStore`（§5.11） / `VectorStore` / `EventStore` /
`TenantSettingsStore`（§5.12） / `LLMProvider` / `EmbeddingProvider` に加え、`hashContent`
（D16、`contentHash` の計算関数）を注入する——core は zod 以外の実行時依存を持てない
（§3.6）ため、`node:crypto` を要求する SHA-256 計算そのものは runtime に置かず、
呼び出し側（`packages/postgres` の `sha256Hex`）が注入する。`embed` ジョブは
`extract: 'sync'` の経路でも常に outbox 経由（非同期）のままである
（[docs/memory-model.md](./memory-model.md) §11 の lifecycle 表・行3）。抽出そのものは
`extraction.ts`（`extractCandidates` / `buildNewMemoryFromCandidate`）が担い、
LLM 呼び出し自体が失敗した場合は Observation の全文を1件の `stated` Memory として残す
安全弁を持つ（ADR 0012 D-ingest-4、[docs/memory-model.md](./memory-model.md) §4 の
digest 安全弁と対になる）。

`runtime` は `observe` / `tick` / `recall` に加えて `reextract` も実装する——ADR 0013 が
未解決のまま残した「失敗した抽出をやり直す」操作。概念的な位置づけ（`superseded` にする
判断の理由を含む）は [docs/memory-model.md](./memory-model.md) §4 と
[ADR 0028](./decisions/0028-reextract-superseded-cleanup.md) を参照。

### 3.5 冪等

再送・二重配信は前提として設計する。**カウンタの盲目的インクリメントを設計原則として禁止する。**
値を直接足すのではなく、一意制約を持つ行の挿入が「実際に起きたか」で数える。

| 対象 | 冪等キー | 挙動 |
|---|---|---|
| Observation | `externalId`（テナント内一意, 任意） | 再送は同じ Observation を返す |
| 抽出 → Memory | `(observationId, extractorVersion)` | `(tenant_id, source_observation_id, extractor_version, content_hash)` に一意制約 |
| 使用報告 | `(recall_id, memory_id)` | 主キー。再送は挿入が弾かれるだけ。`last_reinforced_at` / `strength` は挿入が実際に起きたときだけ更新する |

この対応表が示す通り、**「使われたかどうか」は行の存在で表現する**。カラムを+1するのではない。

### 3.6 core は Infrastructure から独立している

`packages/core` が実行時に依存してよいのは **zod だけ**である。DB クライアント、LLM SDK、
キュークライアントのいずれも `core` の `package.json` の `dependencies` に現れない。これは
方針ではなく `packages/testkit` の CI チェックと `package.json` の lint（禁止依存の静的検査）で
機械的に担保する。core が知ってよいのは interface（この doc の §5）と純関数の戦略（`ScoringStrategy` /
`DecayStrategy`）だけであり、実体（Postgres・OpenAI・BullMQ）は adapter パッケージ側にしか存在しない。

### 3.7 multi-tenant

- 全テーブルで `tenant_id` は **NOT NULL**、全ての一意制約・索引の**先頭列**に置く。
- core の全 interface は第一引数に **`ctx: { tenantId, subjectId? }`** を取る。暗黙の・グローバルな
  テナント状態を runtime もモジュールスコープも持たない。
- **mnemora はテナントの台帳を持たない。** `tenantId` は呼び出し側が渡す**不透明な文字列**であり、
  認証・ユーザー管理は mnemora の仕事ではない。
- Postgres の RLS は**追加防御**として adapter 側のオプションに位置づける。一次的な分離保証は
  「ctx を引き回すこと」と「索引の先頭列が tenant_id であること」に置く。RLS を一次防御にすると、
  RLS を設定していない Store 実装（将来別 DB で書かれた adapter）で保証がまるごと消えるため。
- `packages/testkit` の store 適合テストは**必ず2テナント分のデータを入れて**走らせることを契約にする
  （詳細は §5 の各 interface の契約欄、および testkit 自体の記述に譲る）。

### 3.8 provider 境界と Structured Output

`core` は OpenAI SDK・Anthropic SDK のどちらの型も import しない。境界はこうなる。

```ts
// packages/core — provider 非依存
interface StructuredRequest<T> {
  prompt: PromptSpec;
  schema: ZodType<T>;      // core は zod でスキーマを記述するだけ
}

interface LLMProvider {
  complete(req: PromptSpec): Promise<LLMResponse>;
  completeStructured<T>(req: StructuredRequest<T>): Promise<T>;
}
```

`packages/openai` と `packages/anthropic` はそれぞれ `LLMProvider` を実装し、内部で zod スキーマを
各社の Structured Output 形式（OpenAI の `response_format: json_schema`、Anthropic の
`output_config.format: json_schema`）へ**翻訳**する。この翻訳は provider package の内側で完結し、
core にも呼び出し側にもベンダー固有の型は漏れない。

**⚠ ここは当初「Anthropic の強制 tool use 相当」と書いていた。実測で訂正した**
（[ADR 0072](./decisions/0072-anthropic-llm-provider.md)）。Anthropic には
**ネイティブの構造化出力**（`messages.create()` の `output_config.format`）が在り、
公式の zod ヘルパ `zodOutputFormat` もある。加えて `tool_choice` による強制 tool use は
**Claude Fable 5.1 系のモデルで 400 になる**ため、強制 tool use に寄せた翻訳は
モデルを新しくした日に壊れる。**⟹ 採るのはネイティブの構造化出力である。**

**翻訳の形は両者で同じにならない。**Anthropic 側は `name` も `strict` も持たず、
**`required` を元のまま通す**（`.optional()` が optional のまま残る）——そのため
`packages/openai` が strict モードのために行っている「全キーを required にして省略可能を
nullable へ倒し、返りで `null` を省略へ戻す」往復が、Anthropic 側では要らない。
差分の一覧は ADR 0072 決定3 に在る。

Structured Output は次の4箇所で強く使う方針とする:

| 用途 | 何を構造化するか |
|---|---|
| 抽出（observe の sync/deferred 経路） | Observation → Memory 候補 + digest |
| 要旨生成 | Memory → digest（NOT NULL。§4 の非対称理由） |
| 統合（consolidate） | 複数 Memory → 1 Memory + `provenance.sources` |
| 矛盾判定 | 新規 Memory と既存 Memory の関係 → `active` / `superseded` / `contested` |

矛盾判定と抽出の結果は `provenance.kind = 'inferred'` として記録され、`basis`（根拠となった
memoryIds/observationIds）を伴う。**根拠を欠いた推論をそのまま提示しない**——原則の姿2の適用
（詳細は [docs/memory-model.md](./memory-model.md)）。

---

## 4. package 構成

オーナー案の表をベースに、以下の構成を採る。

```
packages/
  core        — 純粋。zod 以外の実行時依存を持たない。interface / runtime / 純関数の戦略
  testkit     — adapter が満たすべき適合テスト一式（conformance suite）
  postgres    — MemoryStore + VectorStore + RelationStore + EventStore を1接続で実装
  bullmq      — Scheduler 実装
  openai      — EmbeddingProvider + LLMProvider
  anthropic   — LLMProvider のみ
  server      — HTTP（Phase 4）
  sdk         — client（Phase 4）
```

### オーナー案から変えた3点

**`testkit` を追加した。**
「差し替え可能」という主張は、適合テストが無ければ願望に留まる。core が定義するのは型だけでなく
**振る舞いの契約**（冪等性・テナント分離・順序）であり、それを実行可能な形で持たなければ 2つ目の
adapter が書かれた瞬間に、型は同じでも振る舞いが違う実装が紛れ込む。Phase 1 の成果物に含める。

**`redis` を `bullmq` に改名した。**
依存の中心は Redis というミドルウェアではなく、Scheduler の実装である BullMQ というライブラリの方。
Redis を単体で使う用途（キャッシュ等）は Phase 3 まで発生しない。パッケージ名を実際に依存している
役割に合わせた。

**`anthropic` に `EmbeddingProvider` を置かない。**
これはオーナーの package 表への**事実訂正**である。Anthropic は埋め込み API を提供していない
（公式には外部の埋め込みモデルの利用を案内している）。`packages/anthropic` は `LLMProvider` のみを
実装する。埋め込みが要る構成では `openai` か将来追加される別 provider が必要になる。

### 依存方向

```
                       core（zod のみ）
        ┌────────┬────────┬────────┬────────┬────────┐
        ▼        ▼        ▼        ▼        ▼        ▼
    postgres   bullmq   openai  anthropic  server    sdk
        ▲        ▲        ▲        ▲
        └────────┴────────┴────────┘
              testkit（devDependency として利用）
```

**core は誰にも依存されるが、誰にも依存しない。** 逆方向の依存（core が postgres や openai を
import する）は無い。`testkit` は core の interface 型を使ってテストケースを書き、各 adapter
パッケージ（postgres / bullmq / openai / anthropic）は devDependency として `testkit` を引き、
自分の実装が適合テストを通ることを CI で確認する。`server` と `sdk` は Phase 4。`server` は
core を組み立てる合成ルート（どの adapter を使うかは server の起動設定側の責務であり、core は
関知しない）。

---

## 5. 主要 interface

各 interface は「型シグネチャ」と「契約（振る舞いの約束）」の両方で構成される。**型だけでなく
振る舞いが契約である**——例えば `MemoryStore.create` が同じ入力に対して本当に冪等かどうかは
型シグネチャからは分からない。この振る舞いの契約は `packages/testkit` の適合テストで実行可能な
形で検査される。adapter は型を満たすだけでなく、testkit のスイートを通ることで初めて「準拠」と
みなす。

共通の `Ctx`:

```ts
interface Ctx {
  tenantId: string;
  subjectId?: string;
}
```

すべての interface のメソッドは第一引数に `ctx: Ctx` を取る（§3.7）。

### 5.1 MemoryStore — Phase 1

```ts
interface MemoryStore {
  createObservation(ctx: Ctx, input: NewObservation): Promise<Observation>;
  getObservation(ctx: Ctx, id: ObservationId): Promise<Observation | null>;
  createObservationWithOutbox(
    ctx: Ctx,
    input: NewObservation,
    jobKinds: OutboxJobKind[]
  ): Promise<{ observation: Observation; created: boolean; jobs: OutboxJobRecord[] }>;
  createMemory(ctx: Ctx, input: NewMemory): Promise<Memory>;
  createMemoryWithOutbox(
    ctx: Ctx,
    input: NewMemory,
    jobKinds: OutboxJobKind[]
  ): Promise<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
  get(ctx: Ctx, id: MemoryId): Promise<Memory | null>;
  getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]>;
  listBySourceObservation(
    ctx: Ctx,
    observationId: ObservationId,
    extractorVersion: string | null
  ): Promise<Memory[]>;
  updateStatus(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts?: { supersededById?: MemoryId; expectedStatus?: MemoryStatus }
  ): Promise<Memory>;
  updateStatusWithEvent(
    ctx: Ctx,
    id: MemoryId,
    status: MemoryStatus,
    opts: { supersededById?: MemoryId; expectedStatus?: MemoryStatus },
    event: NewMemoryEvent
  ): Promise<{ memory: Memory; event: MemoryEvent }>;
  setEmbeddingStatus(ctx: Ctx, id: MemoryId, status: EmbeddingStatus): Promise<Memory>;
  reinforce(ctx: Ctx, id: MemoryId, at: Date): Promise<Memory>;
  recordUsage(
    ctx: Ctx,
    recallId: RecallId,
    memoryIds: MemoryId[]
  ): Promise<{ insertedMemoryIds: MemoryId[] }>;
  aggregateScope(ctx: Ctx, scope: RecallScope): Promise<ScopeAggregate>;
  createRecall(ctx: Ctx, record: NewRecallRecord): Promise<RecallId>;
}

type MemoryStatus = 'active' | 'superseded' | 'contested' | 'archived' | 'forgotten';
```

> **roadmap.md 段階3（2026-09 追記、ADR 0012 D-ingest-1）**: `getObservation` /
> `createObservationWithOutbox` / `createMemoryWithOutbox` / `setEmbeddingStatus` を
> 足した。前2つは transactional outbox（§3.4）——Observation/Memory の作成と outbox への
> ジョブ書き込みを同一トランザクションで行い、新規作成時（`created: true`）だけジョブを
> 積む。`setEmbeddingStatus` は `embeddingStatus` の `pending → ready | failed` 遷移を書く。
> なぜ独立した「トランザクションハンドル」の抽象にしなかったかは ADR 0012 D-ingest-1 を
> 参照。

> **roadmap.md 段階4/5（2026-09 追記、本 PR）**: `countByGroup` を `aggregateScope` に
> 置き換え、`createRecall` を足した。
>
> - **`aggregateScope`**: 旧 `countByGroup` は群カウント（`GroupCount[]`）だけを返し、
>   `totalInScope`・スコープを定義するフィルタ（status/period）で落ちた件数・
>   `not_indexed` 件数は別のクエリで取らざるを得なかった。マネージャー決定
>   （[docs/recall.md](./recall.md) §5「スコープの外延」の補完）により、これらすべてを
>   **単一の集約クエリ**から返す契約に拡張した——ADR 0011 が段1の `count(*) OVER ()` を
>   締め出したのと同じ理由（別々のクエリから出すと、その間の書き込みで総和が
>   一致しなくなる）を、段5でも守るためである。契約: 返り値の `groups` の総和は
>   必ず `totalInScope` と一致する。
> - **`createRecall`**: recall 段6（記録、[docs/recall.md](./recall.md) §2）の書き込み口。
>   `recalls` テーブルへ1行書き込み、発行した `recallId` を返す。この段は省略可能な段では
>   ない——`recallId` が発行されないと `observe({kind:'memory_usage'})` が recall を
>   参照できなくなる（ADR 0008）。

> **PR「update-status-compare-and-swap」（2026-09 追記、ADR 0030・安全弁3）**: `updateStatus`
> の `opts` に `expectedStatus?: MemoryStatus` を足した。渡すと、書き込み時点の実際の
> status がそれと一致するときだけ更新する compare-and-swap になる——`reextract` の
> 「`status !== 'active'` の Memory には触らない」という安全弁が、読み
> （`listBySourceObservation`）と書き（`updateStatus`）の間に別の書き込みが割り込む
> TOCTOU で破れていたのを塞ぐ。省略時は今日と同じ振る舞い（status を条件にしない）。
> 期待と異なる status を観測した場合は `MemoryStatusConflictError` を投げる
> （対象が存在しない場合は今日どおり別の例外のまま）。詳細は ADR 0030。

> **PR「supersede-status-and-event-in-one-transaction」（2026-09 追記、ADR 0031）**:
> `updateStatusWithEvent` を足した。`runtime.reextract` の supersede ループは、以前
> `updateStatus` の呼び出しと `EventStore.append` の呼び出しを**別々の2コミット**として
> 行っていた——前者が成功し後者が失敗すると、`memories.status` は書き換わったまま
> 対応する `superseded` イベントが永久に存在しないという*永続化された*不整合が残る。
> これは [docs/memory-model.md](./memory-model.md) §11 行5・本節末尾「破棄系」の節が
> 要求する「同一トランザクション」に実装が違反していた不具合であり、正典ではなく
> 実装のほうを直した。`updateStatusWithEvent` は `updateStatus` と同じ CAS 判定を行い、
> 通ったときだけ status の更新とイベントの追記を1回のトランザクションで両方行う
> ——弾かれたときは両方とも起きない。命名は `createObservationWithOutbox` /
> `createMemoryWithOutbox`（ADR 0012 D-ingest-1: 「同一トランザクションで行う必要がある
> 2つの書き込みを、その組み合わせに特化したメソッドとして `MemoryStore` に持たせる」）に
> 揃えた——D-ingest-1 が却下した「トランザクションハンドルを core の型として持つ」案は
> ここでも採らない。**`updateStatus` はそのまま残す**——status だけを更新したい呼び出し元
> はそのまま使える。**買っていない範囲**: 複数の Memory にまたがる supersede ループ全体の
> 原子性（ADR 0030 が既に「範囲外」としていたのと同じ理由で範囲外のまま）、および
> 「旧行の status 更新と*新 Memory の作成*も1トランザクション」という §11 行5 のもう一方の
> 要求（このメソッドは既存 Memory の status 更新とイベント追記の対だけを扱う）。詳細は
> ADR 0031。

> **ADR 0028（2026-09 追記）**: `listBySourceObservation` を足した。**SELECT のみ**——
> マイグレーション・索引の追加は伴わない。`runtime.reextract`（§3.4）が「ある Observation・
> ある版の抽出器から今回作られなかった既存 Memory」を判定するために使う。

> **D9（2026-09 追記）**: `getMany` と `recordUsage` を足した。
>
> - **`getMany`**: recall 段3（矛盾の解決と必須の同伴取得、[docs/recall.md](./recall.md) §2）は
>   `contested` な Memory ごとに対向する Memory を取得する必要がある。`get` を候補の件数だけ
>   繰り返し呼ぶ実装は N+1 になり、候補数が多いテナントほど悪化する。`getMany` を interface に
>   持たせることで、adapter 実装は複数 id の一括取得を単一クエリ（`WHERE id = ANY($1)` 相当）に
>   できる。
> - **`recordUsage`**: 「実際に挿入が起きたときだけ強化する」（§3.5・
>   [docs/memory-model.md](./memory-model.md) §6）という契約は、挿入の成否を呼び出し側が
>   知る手段を要求する。既存の `reinforce(ctx, id, at)` は「強化してよい」ことが確定した
>   *後*に呼ぶメソッドであり、「今回の使用報告で実際に何が新規に挿入されたか」（＝何を
>   強化してよいか）を判定する手段を持たない。`recordUsage` は `recall_usages` への
>   挿入を行い、実際に新規挿入された `memoryIds` だけを `insertedMemoryIds` として返す。
>   呼び出し側（runtime の `observe({kind:'memory_usage', ...})` 処理）は
>   `insertedMemoryIds` に含まれるものだけ `reinforce` を呼ぶ。

契約:
- `createMemory` は `(tenant_id, source_observation_id, extractor_version, content_hash)` の
  一意制約により冪等（§3.5）。
- `getMany` は `get` の複数件版。**存在しない・クロステナントの id は結果から静かに除く**
  （エラーにしない）。呼び出し側が「要求した件数」と「返ってきた件数」の差分から
  欠落を検知できるようにする（recall 側で `omitted` に変換する）。
- `reinforce` は挿入が実際に起きたときだけ `last_reinforced_at` / `strength` を更新し、
  `decay_floor_at` を再計算する（§3.5・[docs/memory-model.md](./memory-model.md)）。
- `recordUsage` は `(recall_id, memory_id)` の一意制約により冪等（§3.5 の使用報告と同じ表）。
  再送で新規に挿入されなかった id は `insertedMemoryIds` に含めない。
- `status = 'contested'` の Memory を単独で返す呼び出し側（recall の内部実装）は、対向する
  Memory を**スコアに関係なく必ず一緒に**取得できなければならない（mandatory companion
  retrieval）。これは原則の姿1（争われている主張を、争われていない顔で出さない）の直接の実装であり、
  MemoryStore の契約としてここに明記する。詳細な判定条件は [docs/memory-model.md](./memory-model.md)。
- `aggregateScope` の返り値は近似を許すが、`countKind: 'exact' | 'lower_bound' | 'unknown'` を
  必ず伴う（[docs/recall.md](./recall.md) の目次帯）。Phase 1 の実装は常に厳密集計であり、
  近似経路（例えば `pg_stats`/`reltuples` に基づく安価な推定）は実装していない
  （PR 本文「設計上の疑義」参照）。
- テナント分離: すべてのメソッドは `ctx.tenantId` に一致しない行を返してはならない。
  `testkit` は2テナントを同時に投入し、クロステナントの取得が0件になることを検査する。

### 5.2 VectorStore — Phase 1

```ts
interface VectorStore {
  upsert(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId, vector: number[]): Promise<void>;
  search(
    ctx: Ctx,
    space: EmbeddingSpaceId,
    query: number[],
    opts: { limit: number; filter: VectorFilter }
  ): Promise<VectorHit[]>;
  delete(ctx: Ctx, space: EmbeddingSpaceId, memoryId: MemoryId): Promise<void>;
}

interface EmbeddingSpaceId {
  provider: string;
  model: string;
  dimensions: number;
}
```

> **D8（2026-09 追記）**: `EmbeddingSpaceId` に `provider` を足した。この節はもともと
> `{ model, dimensions }` だけだったが、[docs/memory-model.md](./memory-model.md) の
> `memory_embeddings_<space>` の節は `<space>` を `(provider, model, dimensions)` の組から
> 導出すると書いており、この doc 自身と食い違っていた。同じ `model` 名を複数の provider が
> 使う可能性がある以上（例: 将来 OpenAI 以外が同名のモデル名を使う場合）、テーブル名スラグの
> 導出元と `EmbeddingSpaceId` の中身は一致しているべきであり、`memory_model.md` 側ではなく
> こちらを直した。

契約:
- **`MemoryStore` が真実の源(source of truth)であり、`VectorStore` は再構築可能な派生索引である。**
  これは非対称な契約であり、VectorStore を失っても MemoryStore から再 embed して復旧できるが、
  逆はできない。理由の詳細は [docs/decisions/](./decisions/) の ADR に譲るが、契約としての
  非対称性自体はここに書く: adapter は VectorStore の内容だけを唯一の正とする実装をしてはならない。
- `search` の `filter` は索引で表現できる形（等値・単調な範囲比較）に限る。`ORDER BY` を距離式に
  しない、という規約は adapter 実装の責務であり、`testkit` は `EXPLAIN` で索引が使われることを
  検査する（[docs/decisions/](./decisions/) の Drizzle/pgvector ADR）。
- 埋め込みが未完了の Memory は `Memory.embeddingStatus: 'pending' | 'ready' | 'failed' | 'skipped'`
  を持つ。recall はこれを「候補にすら上がらなかった件数」として `omitted.kind = 'not_indexed'`
  で報告する——**索引の遅れを黙って無かったことにしない**。原則の姿3そのものの適用である
  （[docs/recall.md](./recall.md)）。
- **core は埋め込みの次元を知らない。** `EmbeddingSpaceId` は「(provider, モデル, 次元)」の組
  （D8）を単位にし、空間ごとにテーブル（`memory_embeddings_<space>`）を分ける設計を前提とする
  （[docs/decisions/](./decisions/)、pgvector の可変次元列は索引が張れないため）。
- **`search` は、渡された `space` と一致しない vector を返してはならない。** 同一 tenant の中でも、
  `EmbeddingSpaceId`（`provider` / `model` / `dimensions` の3つ組）が違えば別の空間であり、
  混ぜない——ある空間で `upsert` した vector は、別の空間を指定した `search` には出てこない。
  adapter がこれをどう実現するか（空間ごとのテーブル分割・key の prefix 一致など）は実装の自由だが、
  **この振る舞い自体は契約である。**この契約は
  [ADR 0065](./decisions/0065-vector-store-space-separation-conformance.md) で決定され、適合テスト
  （`packages/testkit/src/vector-store-conformance.ts` の「space が違う vector は同一 tenant の
  search でも混同されない」）で固定されている。

### 5.2.1 LexicalStore — Phase 1（[ADR 0084](./decisions/0084-lexical-recall-channel.md) で追加、Issue #106）

```ts
interface LexicalStore {
  search(
    ctx: Ctx,
    query: string,
    opts: { limit: number; filter: LexicalFilter }
  ): Promise<LexicalHit[]>;
}
```

**⚠ 節番号を `5.2.1` にしてあるのは、以降の節（5.3〜5.13）の番号を動かさないためである。**
番号を繰り下げると、この interface と無関係な節への参照が repo 中で一斉に古くなる。

契約:
- **`MemoryStore` が真実の源であり、語彙索引は再構築可能な派生索引である**（`VectorStore` と同じ非対称）。
- **返り値は `LexicalHit.rank` の降順**であり、`limit` はその上位から切る。
  **⚠ `rank` はスコアに入らない**——尺度が adapter ごとに違い、コサイン類似度と比較可能な量ではない
  （ADR 0084 §5）。スコアに入るのは `ScoreBreakdown.lexicalMatch`（二値）である。
- `filter` の各フィールドを adapter が実際に適用する（`VectorFilter` と同じ契約、ADR 0034）。
  適合テストは `packages/testkit/src/lexical-store-conformance.ts`。
- **`query` は正規化前の生の文字列であり、どう分かち書きするかは adapter の責務である。**
  core は「語彙的に引く」としか言っていない。
- **🔴 書き込み口（`upsert`/`delete`）を持たない。**`VectorStore` との最大の違いである。
  Phase 1 の postgres 実装は `memories.content` の上の式索引なので、索引は本体の書き込みに自動で追随する。
  **⟹ `memories` の外に索引を持つ実装は、この interface だけでは同期できない**（ADR 0084 §8 の負債）。
- **省略可能な依存である**（`RuntimeDeps.lexicalStore?`）。無くても mnemora は成立する。
  **ただし `RecallQuery.channels` に `"lexical"` を明示したのに配線が無ければ `recall()` は投げる**
  ——黙って0件を返すと「探したが無かった」と「探していない」が同じ顔になる（ADR 0084 §4.2）。

### 5.3 RelationStore — Phase 2（`status`/`superseded_by_id` 列のみ Phase 1）

```ts
interface RelationStore {
  link(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void>;
  unlink(ctx: Ctx, kind: RelationKind, fromId: MemoryId, toId: MemoryId): Promise<void>;
  listRelated(ctx: Ctx, memoryId: MemoryId, kind?: RelationKind): Promise<Relation[]>;
}

type RelationKind = 'contradicts' | 'supports' | 'derived_from';
```

契約:
- 関係グラフの汎用化（`RelationStore` そのもの）は Phase 2 に置く。ただし `contested` 判定に
  必須な `superseded_by_id` 列と `status` 列は Phase 1 のスキーマに前倒しで入れる（後付けの
  マイグレーションにしない、[docs/roadmap.md](./roadmap.md)）。
- `link('contradicts', ...)` は対称関係として扱う（`listRelated` はどちら向きの `fromId`/`toId`
  で張られていても双方から引ける）。

### 5.4 LLMProvider — Phase 1

```ts
interface LLMProvider {
  complete(ctx: Ctx, req: PromptSpec): Promise<LLMResponse>;
  completeStructured<T>(ctx: Ctx, req: StructuredRequest<T>): Promise<T>;
}
```

契約:
- `completeStructured` はベンダー固有の Structured Output 機構へ翻訳する義務を negate できない
  （§3.8）。core・呼び出し側に OpenAI/Anthropic SDK の型を漏らしてはならない。
- タイムアウト・レート制限・失敗時は例外を投げる。呼び出し側（runtime）がリトライ方針を持つ。
  `LLMProvider` 自体はリトライを内蔵しない（責務の混在を避ける）。

### 5.5 EmbeddingProvider — Phase 1

```ts
interface EmbeddingProvider {
  readonly space: EmbeddingSpaceId;
  embed(ctx: Ctx, texts: string[]): Promise<number[][]>;
}
```

契約:
- 1つの `EmbeddingProvider` インスタンスは1つの `EmbeddingSpaceId` に固定される。次元をモデルに
  応じて動的に変える実装は許容しない（`VectorStore` 側がテーブルを空間ごとに分ける前提と対応する）。
- `packages/anthropic` はこの interface を実装しない（§4）。

### 5.6 Scheduler — interface は Phase 1（既定 `InlineScheduler`）、BullMQ 実装は後続フェーズ

```ts
interface Scheduler {
  enqueue(ctx: Ctx, job: OutboxJob): Promise<void>;
}
```

契約:
- `enqueue` はジョブの重複投入に対して冪等でなくてよい（重複排除は消費側/extractor の
  `(observationId, extractorVersion)` 冪等制約が担う。§3.5）。Scheduler 自体は「運ぶ」役に
  縮小されている（§3.4 の outbox 設計のおかげで Scheduler の選択が支配的な決定にならない、
  [docs/decisions/](./decisions/) の Job Queue ADR）。
- `InlineScheduler` は `enqueue` を呼び出しコンテキストの中で同期的に実行する実装であり、
  外部プロセスを必要としない。

### 5.7 ScoringStrategy / DecayStrategy — Phase 1・純関数

```ts
type ScoringStrategy = (candidate: ScoringInput) => Score;

type DecayStrategy = {
  strengthAt(now: Date, params: DecayParams): number;
  /** threshold を省略すると既定値 0.05 が使われる（ADR 0010）。 */
  floorAt(params: DecayParams, threshold?: number): Date;
};
```

契約:
- **両方とも純関数であり、状態を保存しない。** `DecayStrategy.strengthAt` の結果はどこにも
  永続化されない。永続化されるのは書き込み時に一度だけ計算する `decay_floor_at`（単調に増加する
  時刻であり、強化イベントが起きたときだけ再計算される。§3.5・[docs/decisions/](./decisions/) の
  忘却 ADR）。
- 式とパラメータ（`strengthAt` の指数減衰の形、`floorAt` の既定閾値 0.05、
  `strength <= threshold` のときに base をそのまま返す境界の扱い）は
  [ADR 0010](./decisions/0010-decay-parameters.md) に固定してある。
- 鮮度スコアは `occurred_at ?? recorded_at` を使い、減衰は `last_reinforced_at` を使う
  （時計を混同しない。詳細は [docs/memory-model.md](./memory-model.md) の「三つの時計」）。
- half-life は Memory 単位の列として持ち、テナント設定はその既定値としてのみ使う
  （テナント全体の half-life 変更が全件再計算を要求しないようにするため）。

### 5.8 EventStore — Phase 1（監査ログ）

```ts
interface EventStore {
  append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent>;
  get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null>;
  list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]>;
}
```

契約:
- **`update` / `delete` を意図的に持たせない。** append-only。alteroid（github.com/takecchi/alteroid）の
  `JournalStore` interface が同じ形——`append` / `list` / `get` のみで update/delete が型に存在しない
  ——を採っており、mnemora はこの担保の作り方をそのまま真似る。理由は「運用の規律」ではなく
  **「型に無ければ、実装が間違って消す経路がそもそも生えない」**という静的な担保である
  （[docs/memory-model.md](./memory-model.md) の監査ログの節）。
- 本文は記録しない。記録するのは tenant_id・memory_id・kind・at・actor・digest のスナップショット・
  直前のサイズのみ。
- `forget()` は status の更新とイベントの追記を同一トランザクションで行う。**その2つを1呼び出しに
  まとめた口が `MemoryStore.updateStatusWithEvent`**（ADR 0031）であり、`Runtime.forget()` は
  これを使う（[ADR 0087](./decisions/0087-runtime-forget-shape.md)）。`updateStatus` と
  `EventStore.append` を別々に呼ぶと、前者だけが永続化される不整合が残りうる。
  リポジトリ層を通らない削除経路を作らない（§3.2。「必ず残る」の強制）。
- 保持期間はテナント単位で設定可能。期限切れの削除自体も `purged` イベントとして残す（件数と
  期間のみ、対象の詳細は残さない）。alteroid の JournalStore には保持期間の概念が無く、mnemora は
  multi-tenant で量が桁違いになるためこれを追加で持つ（[docs/memory-model.md](./memory-model.md)）。

### 5.9 TokenCounter — Phase 1

```ts
interface TokenCounter {
  count(text: string): { tokens: number; counter: 'heuristic' | 'exact' };
}
```

契約:
- 既定実装は文字数ベースの推定（`counter: 'heuristic'`）。モデル固有のトークナイザに依存する
  正確な実装を差し込める。**推定値を実測値の顔で返してはならない**——`counter` フィールドは
  必須であり、これも原則（姿3寄りの適用: 精度の性質を隠さない）である。
- **既定実装は文字種で重み付けする**（CJK 0.9トークン/コードポイント・非CJK 0.25）。
  係数は `o200k_base` に対する121件の実測から決めた（[ADR 0083](./decisions/0083-cjk-aware-heuristic-token-counter.md)）。
  ⚠ **精度が上がっても `'heuristic'` のままである。**CJK 以外の非ラテン文字（キリル・タイ・
  アラビア文字）は依然として過小評価し、`cl100k_base` に対しては日本語を約12%過小評価する。

### 5.10 Clock — Phase 1

```ts
interface Clock {
  now(): Date;
}
```

契約:
- `ScoringStrategy` / `DecayStrategy` は `now` を引数として受け取る純関数であり、`Clock` を
  直接は使わない。`Clock` は runtime が「現在時刻」を取得する唯一の場所であり、テストで固定時刻を
  注入できるようにするための境界。alteroid・オーナー案のどちらにも無いが、multi-tenant・複数
  インスタンスで動く mnemora では時刻取得を暗黙に `new Date()` へ散らさないための最小限の追加である。

### 5.11 OutboxStore — Phase 1（roadmap.md 段階3で追加、ADR 0012 D-ingest-2。claim のリースは ADR 0032）

```ts
interface ClaimOutboxJobsOptions {
  kinds?: OutboxJobKind[];
  limit: number;
  now: Date;
  claimedBy: string;
  /** claim のリース長（ミリ秒）。必須・既定値なし（ADR 0032）。呼び出し側が方針を決める。 */
  leaseMs: number;
}

interface OutboxStore {
  claimBatch(ctx: Ctx, opts: ClaimOutboxJobsOptions): Promise<OutboxJobRecord[]>;
  complete(ctx: Ctx, jobId: string): Promise<void>;
  fail(ctx: Ctx, jobId: string, error: string): Promise<void>;
}
```

`MemoryStore.createObservationWithOutbox` / `createMemoryWithOutbox`（§5.1）が
transactional outbox の「書く」側だとすれば、`OutboxStore` は `runtime.tick()`（§3.3）が
使う「読んで処理する」側である。

契約:
- `claimBatch` は `completed_at IS NULL AND failed_at IS NULL AND available_at <= now`
  のジョブだけを返す。複数ワーカーが同時に呼んでも同じジョブを二重に claim しない
  （`packages/postgres` は `FOR UPDATE SKIP LOCKED` で実装する）。
- **claim のリース（2026-09 追記、ADR 0032）**: `claimBatch` が返すジョブは、
  「一度も claim されていない」か「`claimed_at` が `leaseMs` 以上前」のどちらか。
  `FOR UPDATE SKIP LOCKED` の行ロックは SQL 文の実行が終わった瞬間に解放される
  ——claim 後に処理を完了できないまま止まったワーカー（クラッシュ・ハング）の
  ジョブを、`claimed_at IS NULL` だけで再取得不能にすると、`completed_at`/`failed_at`
  のどちらも付かないまま二度と claim されず「見えない停止」になる。リースはこれを
  避けるための時間切れの仕組みであり、**その代償として処理は at-least-once になる**
  （リース切れ後に同じジョブが複数回処理されうる。呼び出し側は冪等に書くこと）。
  これは次項「Phase 1 は失敗したジョブを自動リトライしない」とは別の話——あちらは
  `fail()` で終端状態になったジョブの話、リースは終端に至らないまま止まったジョブの
  回収である。`leaseMs` に既定値は無い（`packages/core` が発明せず、呼び出し側の
  運用方針で決める）。
- `complete` / `fail` は対象が存在しない・形式が不正な id でも例外を投げない
  （べき等な終端更新）。
- Phase 1 は失敗したジョブを自動リトライしない（ADR 0012 D-ingest-2）。

### 5.12 TenantSettingsStore — Phase 1（roadmap.md 段階3で追加、ADR 0012 D-ingest-3）

```ts
interface TenantSettingsStore {
  getDefaultHalfLifeHours(ctx: Ctx): Promise<number>;
}
```

契約:
- テナントに `tenant_settings` 行が無い場合は `DEFAULT_HALF_LIFE_HOURS`（720、DB 側の
  `default_half_life_hours DEFAULT 720` と同じ値）を返す（エラーにしない）。
- `tenant_settings` の他の列（`event_retention_days`・`taxonomy_mode`）の読み書きは
  この interface の範囲外（ADR 0012 D-ingest-3）。

### 5.13 Sensor / SpeechPolicy — Phase 3、形のみ

```ts
interface Sensor {
  // Phase 3。何を「観測すべき出来事」として検知するかの詰めはまだ無い。
}

interface SpeechPolicy {
  // Phase 3。「いつ mnemora 側から話しかけてよいか」の詰めはまだ無い。
}
```

正直に書く: この2つは Phase 1〜2 の設計検討の対象外であり、**現時点では interface の形すら
仮置きに過ぎない。**動詞5つ（observe/recall/reflect/consolidate/forget）との関係、Ctx との
関係も未検討。ここでの掲載はオーナー要求の11項目網羅のためであり、設計が済んでいることを
意味しない。

---

## 確かめていないこと（この doc に関わる範囲）

- ~~抽出の既定を `sync` にするか `deferred` にするか（§3.3）はオーナー判断が必要で、
  まだ決まっていない。~~ **2026-09 追記（roadmap.md 段階3、D2）**: 既定は `sync` に決定・
  実装済み（`runtime.ts` の `extractMode = input.extract ?? "sync"`）。
- `packages/testkit` が実際にどこまでの振る舞い（順序・並行性）を検査できるかは、testkit 自体の
  設計（Phase 1 着手時）に委ねられており、この doc の時点では契約として書けるが実装されていない。
  **2026-09 追記**: `MemoryStore`/`VectorStore`/`EventStore`/`OutboxStore`/
  `TenantSettingsStore` の適合テストは実装済み（`packages/testkit`）。順序・並行性のうち
  `OutboxStore.claimBatch` の同時 claim 安全性（`FOR UPDATE SKIP LOCKED`）は
  `packages/postgres` 側で実装したが、複数ワーカーが実際に競合する状況を再現するテストは
  Phase 1 の時点では書いていない（単一プロセス内の逐次呼び出ししか検査していない）。
- **2026-09 追記（roadmap.md 段階3）**: `packages/openai` の `completeStructured` が
  OpenAI の strict モードで実際に「省略可能なフィールドを `null` として返す」という
  前提（ADR 0012 D-ingest-7）は、`OPENAI_API_KEY` が無い開発・CI 環境では検証できていない。
  `packages/openai/src/__tests__/live.openai.test.ts` は鍵がある場合のみ実行される。
