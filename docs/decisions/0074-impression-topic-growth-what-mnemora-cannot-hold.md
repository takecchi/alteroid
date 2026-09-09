# ADR 0074: 「印象」「話題」「成長」を mnemora は持てるか — 現物で当てた結果と、3つの案

- **状態**: **提案（未採用）。オーナーの判断待ち。**
- **日付**: 2026-09-09

**⚠ この ADR は決定していない。** 3つの案を並べ、**選ばなかった**記録である。
選ぶのはオーナーであり、この文書の末尾「オーナーへ差し戻す問い」がその入口である。
実装は含まない（この PR はこの1ファイルだけである）。

**⚠ 各主張の出所を分ける**（ADR 0033 / 0055 の体裁を踏む）。

- **【現物】** — この repo または `virchamate/virchamate-backend` のコード・スキーマを読んで確かめた。
- **【逐語】** — 引用元の文字列をそのまま写した。
- **【受】** — 依頼として受け取った前提であり、この ADR の書き手は再導出していない。
- **【見立て】** — 書き手の解釈。確かめていない。

---

## 文脈

**【受】** オーナーの言葉（逐語）:

> **mnemora は「印象」「話題」「成長」を持てない これが課題って感じですかね。**

**【受】** この3語が `virchamate/virchamate-backend` の3つの Prisma エンティティを指す、という
対応づけは**依頼者の推測として受け取ったもの**である。この ADR はまずその推測を現物で検めた。

---

## 1. 対応づけの検証【現物】

`virchamate/virchamate-backend` の `prisma/schema.prisma`（単一ファイル）に対し
`grep -n "^model \|^enum "` を当て、全モデル・全 enum を列挙した。3つとも**逐語一致で実在する。**

| 語 | モデル | 場所 |
|---|---|---|
| 印象 | `UserImpressionEntity` | `prisma/schema.prisma:1379` |
| 話題 | `ConversationTopicEntity` | `prisma/schema.prisma:1431` |
| 成長 | `PersonaGrowthEntity` | `prisma/schema.prisma:1528` |

**⚠ ただし「成長」は単一モデルで閉じない。**【現物】
`PersonaEvolutionProposalEntity`（`prisma/schema.prisma:1999-2027`）が別に在り、
こちらは `currentValue` → `proposedValue` という**明示的な差分**を持ち、承認されると
`PersonaEntity` の人格フィールドを実際に書き換える。既定は無効
（`PersonaEvolutionConfigEntity.enabled` の default が `false`、`prisma/schema.prisma:1984`）。

- `PersonaGrowthEntity` = 経験の**エビデンスの束**。各行は「その時点の命題」であり、差分ではない。
- `PersonaEvolutionProposalEntity` = そのエビデンスが閾値を超えたときの、**人格への一度きりの書き換え**。

**⟹ 「成長」がどちらを指すかで、以下の設計は変わる。**これは末尾の問い2 として差し戻す。

### 運用側から見た「成長」の実際の不満【現物・逐語】

`virchamate/virchamate-backend#50`「成長や印象の仕組みについて」で、オーナー本人が書いている:

> 成長は類似するものにどんどん加算されていく認識ですがあってますか？…**ログを見る限り成長は一過性のように見えます。**原因を教えてほしいです。

**⟹ 訴えは「保存できない」ではなく「引けない／続かない」である。**
同じ症状が `virchamate/virchamate` で
**「[成長検索] Vector検索ミス: AIが関連と判定した成長がembeddingでヒットしなかった」という同題の Issue として 42 本**
起票されている（`gh api search/issues` の `total_count`、`#71`（2026-05-04）〜`#230`（2026-07-26）、全て closed）。
その後は個別起票をやめて内部計測へ移っており、週次レポート `virchamate/virchamate#271`（2026-09-07）でも
直近1週間に 3 件検出されている。**⟹ 「直った」ではなく「見せ方が変わった」である。**【見立て】

**⚠ これは mnemora の物差しの真ん中に在る。**北極星「目指す姿」の逐語:
「**知らないことを、知らないと言える。**——「見つからなかった」と「探していない」を、同じ顔で返さない。」

---

## 2. 問1: いまの mnemora で表せるか

判定は **(a) そのまま表せる / (b) 表せるが意味が落ちる / (c) 表せない** の3択。

### 2.1 「話題」— **(c) と (b) に割れる**

**この語は実装上2つの別物を指しており、片方は (c)、片方は (b) である。**

#### (c) 会話中の話題状態 — 表せない

`ConversationTopicEntity` の逐語（`prisma/schema.prisma:1431-1447` より抜粋）:

```prisma
conversationId String @map("conversation_id")
topic          String @db.VarChar(200)
status         String @default("active") @db.VarChar(20) // active | concluded | avoided
interest       Int    @default(50) // キャラの興味度 (0-100)
startedAt      Int    @map("started_at") // message order when topic started
endedAt        Int?   @map("ended_at")   // message order when topic ended
```

**表せない理由を、型の逐語で示す。**

1. **`conversationId` に当たる単位が core に無い。**
   `Memory`（`packages/core/src/memory.ts:37-70`）にも `Observation`（`packages/core/src/observation.ts`）にも、
   複数の観測をまとめる「会話」「セッション」の識別子が無い。
2. **`startedAt` / `endedAt` は `Int`（会話内のメッセージ通番）である。**
   mnemora の時間はすべて `Date`（`occurredAt` / `recordedAt` / `lastReinforcedAt`）であり、
   会話内の順序を入れる整数列が無い。
3. **`status: 'active'` の意味が違う。**`MemoryStatus`（`memory.ts:5`）の逐語は
   `"active" | "superseded" | "contested" | "archived" | "forgotten"` であり、
   `active` は `docs/memory-model.md:208-210` の通り「置き換えられていない」の意である。
   「いまこの会話で開いている」ではない。
4. **`interest`（0-100）に当たる数値列が無い。**（下の 2.3 の 🔴3 と同じ穴）

**⚠ 探した場所を列挙する（「探したが無かった」と「探していない」を区別するため）。**【現物】
`packages/core/src/**` の全 `.ts`（`*.test.ts` を除く）に対して次を grep した:

| 語 | ヒット |
|---|---|
| `conversation` | **0** |
| `conversationId` | **0** |
| `session` | **0** |
| `sessionId` | **0** |
| `thread` | **0** |
| `dialogue` | **0** |
| `chat` | **0** |
| `turn` | 143（**すべて `return` の部分一致**。会話のターンではない） |
| `topic` | **0** |
| `salience` | **0** |
| `importance` | **0** |

加えて `packages/postgres/migrations/*.sql`（5ファイル）と `docs/memory-model.md` の schema 節も見た。
**⟹ 会話単位も、主観的な興味度も、この repo には無い。**

**⚠ ただしこれを「mnemora の欠落」と読むのは早い。**【見立て】
会話中に開いている話題は**短期の会話状態**であって長期記憶ではない。
北極星の問い1（毎回渡す量を減らすか）に当てると、これを mnemora が持つ理由は自明ではない。
**この ADR はここを「持つべきでない」とは決めない**（末尾の問い1 と同じ扱い）。

#### (b) 蓄積された話題 — 表せるが落ちる

`tags: string[]`（`memory.ts:56`、自由文字列）に話題語を載せれば表せる。

**落ちるもの（名指し）:** 目次帯の軸に話題を置けない。
`GroupCount.axis`（`packages/core/src/recall.ts:293-298`）は逐語で
`axis: "subject" | "taxonomy" | "time_window"` の**閉じたユニオン**であり、Phase 1 の実装は `subject` のみである
（`taxonomy` の `labels` / `memory_labels` テーブルは Phase 2 で未実装）。
**⟹ 「その話題については N 件ある」を目次に出せない。**

**⚠ 対照を取っておく。**【現物】この点で mnemora が virchamate に劣っているわけではない。
`virchamate-backend` 側も会話をまたいだ話題の再訪を検知していない——
`TopicSuggestionService` は `previousTopics` を受け取る形になっているが、唯一の呼び出し元
（`topic-suggestion.processor.ts:81`）が `previousTopics: []` をハードコードしている。
ダッシュボードの集計（`dashboard.service.ts:667-714`）は `GROUP BY ct.topic` の**文字列完全一致**で、
記憶・印象・成長が持っている embedding による揺らぎ吸収がここには無い。
**⟹ 「話題の継続性」は、どちらも持っていない。**

### 2.2 「印象」— **(b) 表せるが、意味が落ちる**

**⭐ まず、依頼で懸念されていた点は的が外れている。**
「印象は主体が別（AI 側の主観）だから `subjectId` で表せるか怪しい」という懸念は、
**mnemora では `subjectId` の問題ではなく、既に `provenance` が解いている。**
`docs/memory-model.md:64-67` の逐語:

> **ここが本書で最も明確にしておきたい対応関係:** オーナーの原則7「AI の推論とユーザーが言った事実を区別する」は、実装上は別のフラグや別のテーブルとして現れるのではない。**`provenance.kind` の値そのもの**がその区別である。

`InferredProvenance`（`packages/core/src/provenance.ts:33-39`、逐語）:

```ts
export interface InferredProvenance {
  kind: "inferred";
  model: string;
  promptVersion: string;
  basis: { memoryIds: string[]; observationIds: string[] };
  confidence: number;
}
```

**⟹ 「AI がユーザーについて抱いた、確信度つきの、根拠を辿れる推論」は、いまの型でそのまま書ける。**
`content` は本文、`category`（`personality | preference | habit | appearance | background`）は `tags`、
`confidence`（0-100）は `confidence`（0..1）へ落ちる。

**⚠ そして mnemora のほうが強い点が2つある。**【現物】

1. `virchamate` の印象は**上書き**であり、古い `content` は DB のどこにも残らない
   （`relationships.service.ts:1454-1472` が `content` を新しい値で置き換え、`source` も最新の会話 ID で上書きする）。
   mnemora は `supersededById` で系譜を残せる。
2. `InferredProvenance.basis` は根拠を `memoryIds` / `observationIds` の**集合**で持つ。
   `virchamate` の `source String?`（`@db.VarChar(200)`）は会話 ID 1つで、しかも上書きされる。

#### 落ちるもの（名指し）

1. **🔴 「誰が抱いた印象か」の軸。**
   `virchamate` は印象を `personaRelationshipId` に吊るす。その親
   `PersonaRelationshipEntity` は `@@unique([subjectPersonaId, targetPersonaId])`（`prisma/schema.prisma:844`）——
   **順序対**である。mnemora の `Ctx.subjectId` は単一の不透明文字列であり
   （`packages/core/src/ctx.ts:12-20`、逐語コメント「`tenantId` は隔離境界（安全性の単位）、`subjectId` はテナント内の整理の単位」）、
   `"persona:user"` のような合成文字列に潰すことはできる。
   **しかしその瞬間に、`RecallScope.subjectId` の等値フィルタ（ADR 0023 が段1の ANN クエリへ降ろしたもの）と
   `IndexBand` の `subject` 軸の集計が「対」単位になり、「このユーザーについての印象を、キャラ横断で」が引けなくなる。**
   **⟹ 1テナントに AI が1体、という暗黙の前提が入る。**
2. **🔴 `mentionCount`（何回言及されたか）。**
   mnemora に回数列は無い。`lastReinforcedAt` は**時刻1つ**であり、
   ADR 0041 により `reinforce` は `strength` を動かさない。
   監査ログも列単位の状態変化は記録しない（`docs/memory-model.md` §21 のログ量リスクへの対処）。
   **⟹ 回数は復元できない。**
3. **🔴 `confidence` が recall の返り値に出てこない。**
   ADR 0035 の決定であり、`docs/recall.md:505` の逐語は「持ち出すのは `kind` だけである」。
   呼び出し側は「これは確信度 0.3 の印象だ」と扱えず、`MemoryStore.get()` を別に引く必要がある。
   **⚠ 実運用はこの値を使っている**——`virchamate` はプロンプト注入を `confidence >= 30` でフィルタしている（`#50`）。
4. **🔴 `confidence` を後から動かせない。**
   `Provenance` は Memory と一緒に書かれ、store の interface に update を持たせないのが
   この repo の規律である（`docs/alteroid-findings.md` の F として明示的に採用）。
   **⟹ 「印象が強まった」を表すには、新しい Memory を作るしかない。**

### 2.3 「成長」— **(b) 表せるが、落ちるものが最も大きい**

**そのまま表せる部分が1つある。**`GrowthScope`（`prisma/schema.prisma:1522-1527`）の逐語
`core`（キャラ全体に共通＝全ユーザーに反映）/ `relationship`（特定の関係性でのみ反映）は、
mnemora の `subjectId` の **null / 非 null** に1対1で対応する
（`packages/core/src/recall.ts:642` 逐語「`subjectId` を省略すると『テナント全体』を意味する」）。**ここは (a) である。**

`supersededById` / `supersededAt` も、`Memory.supersededById` + `MemoryStatus = 'superseded'` に
**列としては**そのまま在る。

#### 落ちるもの（名指し）

1. **🔴 系譜を `recall()` から引けない。「N 件在る」とは言えるのに、出せない。**
   `docs/memory-model.md:208-210` の逐語:

   > **機構1: `status` を列で持つ。** `active | superseded | contested | archived | forgotten` の5値。既定の recall は `status = 'active'`（および後述の `contested` の一部）で絞り、`superseded` を**返さない。**「下に出す」のではなく「出さない」。

   そして `RecallQuery`（`packages/core/src/recall.ts:591-613`）の**全10フィールド**は
   `text` / `vector` / `tags` / `occurredAfter` / `occurredBefore` / `limit` / `overFetchFactor` /
   `excludeProvenanceKinds` / `budget` / `scoreThreshold` であり、
   **status ゲートを緩める口が1つも無い。**
   一方 `recall.ts:382` は `status = 'superseded'` で落ちた**件数**を `Omission` として返している。
   **⟹ 「以前は◯◯だったが、いまは△△」を recall 1回で出せない。**

   **⚠ 対照【現物】:** `virchamate` のダッシュボード読み取り（`dashboard.service.ts:188-236`）は
   `supersededAt` で絞っていない。**置き換え済みの過去も一緒に返している＝履歴が製品の見せ物になっている。**

2. **🔴 `superseded` の意味が違う。「訂正」と「変化」が同じ列に同居する。**
   `packages/core/src/recall.ts:382` の逐語:

   > status = 'superseded' で落ちた件数——**機構の都合**（より良い抽出に置き換えられた）。

   成長の supersede は機構の都合ではない。**古いほうも、当時は真だった。**
   **⟹ 同じ列に載せると「間違いだったから消えた」と「変わったから前の版になった」が区別できなくなる。**
   これは北極星の問い3（なぜ思い出したかを説明できるか）に直接効く。

3. **🔴 重要度に当たる列が、実質的に存在しない。**
   `PersonaGrowthEntity` は `importance Int @default(5) @db.SmallInt` を持ち、
   `reinforceCount` が 5 / 10 / 20 の節目で段階的に引き上げられる（`persona-growth.service.ts:453-458`）。
   mnemora には `Memory.strength: number` と `halfLifeHours: number` が在る。**が、値が動かない**【現物】:
   - `packages/core/src/extraction.ts:215` と `:232` が**無条件に `strength: 1`** を書く。
   - `packages/core/src/runtime.ts:241` が
     `const halfLifeHours = await deps.tenantSettingsStore.getDefaultHalfLifeHours(ctx);` で
     **テナント既定値**を取り、全 Memory に同じ値を入れる。

   **⟹ 記憶ごとの重要度は、列は在るが全件同じ値である。**

   **⚠ そしてこれは正典が自分で名指ししている穴でもある。**
   `docs/north-star.md` が引くオーナーの仕様 §48 の逐語:

   > **必要な記憶だけを、意味、構造、時間、重要度、利用頻度、関連性から思い出せること**です。

   6軸のうち、意味（embedding）・時間（`occurredAt` / `freshness` / `period`）・
   利用頻度（`lastReinforcedAt`）・関連性（`tags` / `contested`）は形が在る。
   **いま値が入っていないのは「重要度」である。**

4. `trigger`（何がきっかけか）は `content` に混ぜるか `basis` に落とす。**落ちるのはきっかけの本文。**
   `keywords: String[]` は `tags` で表せる（(a)）。

---

## 3. 問2: 3つは「同じ形」か

**受け取った見立て【受】:** 話題＝事実に近い／印象＝主体が別／成長＝時間方向の差分。

**この ADR は、3点で崩す。**

1. **「印象＝主体が別」は、mnemora ではもう解けている。**
   区別は `subjectId` ではなく `provenance.kind` が担っている（2.2 の逐語）。
   **⟹ 印象の難しさは「主体」ではなく、(a) 確信度が後から動くこと (b) 帰属が順序対であること、の2つである。**

2. **「話題＝mnemora の本来の対象」は逆で、3つの中で最も遠い。**
   実装上の「話題」は会話1件にスコープされた**セッション状態**であり（`conversationId` FK、
   `status: 'active'`、メッセージ通番の `Int`）、長期記憶ではない。
   mnemora の core に会話の単位は1つも無い（2.1 の grep 表）。
   **⟹ 「話題」の半分は mnemora の対象外で、もう半分（蓄積された話題）は Phase 2 の `taxonomy` が既に受け皿として設計されている。**

3. **「成長＝時間方向の差分」は半分ずれる。**
   `PersonaGrowthEntity` は**差分を持っていない**。各行は「その時点の命題」であり、
   前の版への参照（`supersededById`）を持つだけである。
   `currentValue` → `proposedValue` という明示的な差分を持つのは
   `PersonaEvolutionProposalEntity` のほうである（1章）。
   **そして `occurredAt` / `freshness` で足りない理由は「差分だから」ではない。
   古いほうを recall が返さないからである**（2.3 の 🔴1）。

### 対案: 「新しい観測が来たとき、何が動くか」で切る

| 語 | 動くもの | 動かないもの |
|---|---|---|
| 話題 | **状態**（`active` → `concluded`） | 命題 |
| 印象 | **確信**（`confidence` 50 → 60） | 命題 |
| 成長 | **命題**（A → B）。**しかも A も当時は真だった** | — |

**そして mnemora の `Memory` で、書き込み後に動く列は5つだけである【現物】:**
`status` / `supersededById` / `contestedWithId` / `lastReinforcedAt` / `embeddingStatus`。
**どれも帳簿であって、意味でも度合いでもない。**
`content` は不変、`provenance.confidence` は書き込み時に確定、`strength` は常に 1、
`halfLifeHours` はテナント既定値である。

**⟹ 3つは別々の欠落ではない。「mnemora には、書き込みのあとで動く量が無い」という1つの性質の、3つの顔である。**

**⚠ これは事故ではなく設計である。**追記専用で store に update を持たせないのは、
`docs/alteroid-findings.md` の F として意識的に採った規律である。
**⟹ 問いは「動く量を足すか」ではなく、「追記専用のまま、動いた跡をどう引くか」になる。**

---

## 4. 問3: 3つの案

### 案1 — いま在るものだけで済ませる（`packages/core` の変更 0 行）

| 語 | 表し方 |
|---|---|
| 印象 | `Memory { provenance: { kind: 'inferred', model, promptVersion, basis, confidence }, subjectId: <user>, tags: ['impression', <category>] }` |
| 話題（蓄積分） | `tags` に話題語。会話中の状態は**呼び出し側が持ち、mnemora へ入れない** |
| 成長 | `Memory { provenance: 'inferred' \| 'consolidated', subjectId: null（core）/ <user>（relationship）, tags: ['growth', <category>] }` |
| 確信が上がった／言及が増えた | **新しい Memory を作り、古いほうを supersede する**（内容が同一なら `contentHash` 一致で冪等 create に落ちる、ADR 0054） |
| 「前はこうだった」を出す | recall では出ない。呼び出し側が `RecallResult.omitted` の `filtered { condition: 'superseded' }` を見て、`MemoryStore.get(supersededById)` を辿る |

**引き受ける負債（この案を採る場合）:**

- **ADR 0055 が実測した方向に近い。** 同 ADR は抽出プロンプトに推論を生成させる1文を足した結果、
  記憶件数が **75件 → 129〜138件（+72〜84%）** になり「北極星の物差しに逆行する」と書いている。
  確信が動くたびに1件増やすこの案は、**北極星の問い1 に自分では答えられない。**
- 2.3 の 🔴1・🔴2・🔴3 が**すべてそのまま残る。**
- 「前はこうだった」を辿る経路が `recall()` の外に出る。
  **⟹ 北極星の問い3（なぜ思い出したかを説明できるか）の外に出る。**
- 印象の帰属を `subjectId` に潰す ⟹ 1テナント1 AI の前提が入る。

**⭐ この案を推さない。理由を正直に書く。**
この案は**書きやすい**。「core を1行も変えない」は理由として強く見える。
**だがその強さは、形の良さではなく報告の書きやすさに由来している。**
この案を採ると、オーナーが `virchamate-backend#50` で書いた
「ログを見る限り成長は一過性のように見えます」に対して、**何も変わらない。**
**⟹ この案は「対照」として置く。**

### 案2 — 推奨: 「動く量」を足さず、「動いた跡を引けるようにする」

新しいエンティティ 0、**新しい動詞 0**（`docs/vision.md:51` 逐語「外部に公開する操作は5つの動詞に限る。**6つ目は作らない。**」を守る）。

- **(A) supersede の理由を割る。**
  `superseded` に「訂正」と「変化」の2つの意味が同居している（2.3 の 🔴2）のを分ける。
  形は2通り在り、この ADR では選ばない:
  - `Memory` に `supersededReason: 'correction' | 'change'` の閉じた2値を足す（安い）。
  - Phase 2 の `memory_relations`（`docs/memory-model.md:786-806` に SQL 案が在り、
    `kind IN ('contradicts','supersedes','consolidates_from','derived_from')`）へ `becomes` を足す（正しいが重い）。
- **(B) `RecallQuery` に系譜を引く口を1つ足す。**
  既に `Omission.filtered { condition: 'superseded', count }` で**件数は返している**。
  **「言えるのに出せない」だけを解く。**
  北極星の問い1 に答えられる——既定では件数が増えず、**呼び出し側が指定したときだけ**前の版が付く。
  問い3 にも既存の枠で答えられる（`RecalledMemory.retrievedVia` は
  `'mandatory_companion'` という同じ族の値を既に持つ）。
- **(C) `RecalledMemory` に `confidence` を載せる。**
  ADR 0035 が「持ち出すのは `kind` だけ」と決めているので、**それを覆す ADR が別に要る。**
  理由: 印象は確信度なしでは使えない（`virchamate` は `confidence >= 30` で注入をフィルタしている）。

**この案が触らないもの:** 重要度（2.3 の 🔴3）。**製品の性格を決める判断であり、ここでは決めない。**

### 案3 — ベストな形（費用を度外視した場合）

- **命題に有効区間を持たせる。**
  `valid_from` / `valid_until` は **`packages/postgres` の `0001_init.sql` に「Phase 2」として既に列が在り、
  `packages/core` の `Memory` 型には無い**【現物】。これを core へ持ち上げると、
  「以前は真、いまは真でない」を **supersede を使わずに**表せる。
  **⟹ 成長は「命題の置換」ではなく「区間の終了＋新しい区間の開始」になり、
  古いほうを `status = 'active'` のまま残せる ⟹ 既定の recall から消えない。**
- **`memory_relations` を実装する**（`docs/roadmap.md` §1.3 が Phase 1 から明示的に外しているもの）。
  `becomes`（成長）と `reinforces`（印象の強化）を同じ機構で表す。
- **重要度を第一級にする。**`strength` を「無条件に 1」から解放し、書き込み時に受け取る。
  オーナー仕様 §48 の6軸のうち、いま値が入っていないのは重要度だけである。
- **帰属を順序対にする。**印象は「誰が、誰について」なので、`subjectId` の隣に観測者の軸を持つ。
  **⚠ これは `Tenant` / `Subject` の非対称という設計の芯に触る。この ADR は決めない。**

---

## 採らなかった案

- **「mnemora では無理なので virchamate 側で持つ」。**採らない。
  3語のうち (c) と判定したのは「会話中の話題状態」だけであり、
  残りはすべて (b)——**表せる。落ちるものが在るだけである。**
- **`provenance.kind` に `impression` を足す。**採らない。
  印象は既に `inferred` である（2.2）。5値の閉じたユニオンに値を足すと、
  CHECK 制約・索引・ADR 0056 が段1へ降ろした `excludeProvenanceKinds`・
  ADR 0035 の返り値契約に波及する一方、**区別として増えるものが無い。**
- **`IndexBand.groups[].axis` に `'topic'` を足す。**この ADR では採らない。
  Phase 2 の `taxonomy` 軸と役割が重なる。**先に `taxonomy` を実装して、
  それで話題が足りないと分かってからにする。**
- **スコアに「重要度の項」を足して測る。**採らない。**入れる値が無い**（全件 `strength: 1`）。
  ADR 0033 §7 が時制の項を却下したときと同じ形である——却下ではなく、前提が足りない。
- **会話中の話題状態を mnemora が持つ。**この ADR では採らない。
  **⚠ ただし「持つべきでない」とも決めていない。**末尾の問い1 として差し戻す。

---

## 引き受けた負債

- **この ADR は何も測っていない。**`retrieval` ベンチも `compare` も回していない。
  3案のどれが北極星の物差しを動かすかは、**この文書では示されていない。**
- **「成長」の対応づけが `PersonaGrowthEntity` か `PersonaEvolutionProposalEntity` かを確定していない**（1章）。
  2.3 の判定は前者に対するものである。後者だとすると、
  「差分」が第一級に在るぶん、`valid_from` / `valid_until`（案3）の必要性がより強くなる。【見立て】
- **`virchamate` 側の読みは 2026-09-09 時点の `main`（`7612ada`）に対するものである。**
- **42 本の「Vector検索ミス」が、個別起票から内部計測へ切り替わった経緯を説明する Issue は見つからなかった**
  （`内部計測` / `IssueQueueMetricsService` / `gap-processing` などで探した）。
  **⟹ 「直っていない」は件数の推移からの読みであり、確定した事実ではない。**【見立て】

---

## これが覆るとしたら

- **オーナーが「成長」で `PersonaEvolutionProposalEntity` を指していたとき。**2.3 の判定が変わる。
- **`taxonomy`（Phase 2 の `labels` / `memory_labels`）が実装されたとき。**
  2.1 の (b)（話題を目次の軸に置けない）が自動的に解ける可能性が在る。
- **`reinforce` が `strength` を動かす決定に変わったとき**（ADR 0041 の反転）。
  「確信が動く」を追記なしに表せるようになり、案1 の負債が軽くなる。
- **`RecalledMemory` に `confidence` を載せない決定（ADR 0035）が維持されたとき。**
  案2 の (C) が落ちる。
- **1テナントに複数の AI が居る使い方が要求になったとき。**
  2.2 の 🔴1（帰属の順序対）が (b) から実質 (c) へ落ちる。

---

## 確かめていないこと

- **`valid_from` / `valid_until` が Phase 2 として何を意図していたか**を、
  `docs/memory-model.md:88` の一文（「その事実がいつからいつまで真か」）以上には追っていない。
  **案3 がその意図と一致しているかは確認していない。**
- **`virchamate` の `restrictedFromCloud`**（印象・成長・記憶の3つが持つ、
  クラウド LLM へ渡さないための真偽値）を、この ADR は一度も扱っていない。
  **mnemora に対応物が在るかも探していない。**
- **案2 の (B) を入れたときに `recall()` が返す量がどれだけ増えるか**を測っていない。
  「既定では増えない」は設計上の主張であって、実測ではない。

---

## オーナーへ差し戻す問い

**⚠ この ADR は、次の4つを決めていない。決めるのはオーナーである。**
`docs/autonomy.md` §3.1 の見分け方（「どちらを選んでも技術的には成立するが、選び方が製品の性格を決める」）に当たる。

1. **「印象」は、`docs/north-star.md`「やらないこと」の「複雑な感情シミュレーション」に当たるか。**
   同項目は `docs/vision.md` の「やらないこと」にも重複して載っている。
   `docs/autonomy.md:113` は **north-star の「やらないこと」への追記をエージェントに禁じている**ので、
   この線引きはオーナーにしか引けない。
2. **「成長」が指すのは `PersonaGrowthEntity`（経験のエビデンスの束）か、
   `PersonaEvolutionProposalEntity`（人格への明示的な差分・既定で無効）か。**
3. **記憶ごとの重要度を `Memory` に持たせるか。**
   オーナー仕様 §48 は6軸の1つとして「重要度」を挙げているが、
   いまは `strength` が全件 1 である。**どこから値を入れるか**（LLM に判定させるか／
   呼び出し側に渡させるか／`reinforceCount` から機械的に導くか）は、製品の性格を決める。
   採用するなら `docs/roadmap.md` §5 に項目を足すのが本 repo の作法である。
4. **印象の帰属を「誰が、誰について」の順序対にするか。**
   `Tenant` / `Subject` の非対称（`docs/vision.md`「Tenant と Subject を混同しない」）の芯に触る。
