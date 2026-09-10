# ADR 0087: `Runtime.forget()` の形を決める — 決めるのは意味論ではなく「無い」の割り方

- **状態**: 採用 (2026-09)

- **文脈**:

  ## この ADR が決めていないこと

  🔴 **「`forget()` を実装するかどうか」は、この ADR の対象ではない。既に決まっている。**
  ADR に番号を割り当てるという行為は「これは新しい決定だ」という前提を運ぶので、
  書く前に「その決定は既に在るか」を現物で問うた。**在った。**以下は現物からの逐語である。

  - `docs/vision.md` §「外から見える API: 5つの動詞」（`:53-65`）:
    「mnemora が外部に公開する操作は5つの動詞に限る。**6つ目は作らない。**」——
    その5つ目が `forget(ctx, target) // -> ForgetResult` であり、
    「`forget` — 記憶を落とす、あるいは失効させる。」と説明されている。
  - `docs/memory-model.md` §「forget() と purge() を分ける」（`:547-549`）:
    「`forget()` = 論理削除（`status` を変える。復元可能）。`purge()` = 物理削除
    （法的要求。内容を消す。イベントは残る）。**Phase 1 は `forget()` のみを実装する。**」
  - `docs/memory-model.md` §11 Memory lifecycle 表 行9:
    「任意 → forgotten / `forget(ctx, target)` 呼び出し / 同期（`EventStore` への追記と
    同一トランザクション） / `status='forgotten'` / `forgotten`」
  - `docs/memory-model.md`（`:509`）: 「**「必ず」の強制**: `forget()` は `EventStore` への
    追記と同一トランザクションで行う。」
  - `docs/roadmap.md` §5.3（`:219`、**オーナー回答 2026-09-06**）:
    「**既定の忘却は、実際に落とさず順位を下げる。物理削除は明示的な操作として分ける。**」
  - `docs/architecture.md` §3.2「破棄系 — `forget(ctx, target)`」（`:93-99`）。

  **⟹ 意味論（何が起きるか）は全部決まっている。**論理削除であること・`status='forgotten'`
  であること・監査ログに同期で残ること・物理削除は別動詞（`purge()`、Phase 2）であること。

  ## Phase 1 の線を確認した結果

  ⚠ **`forget()` が「Phase 1 の範囲外」と読める記述は、現物には無かった。**確認した先:

  - `docs/north-star.md`「やらないこと」（`:80-93`、**正典**）— 10項目。
    独自 LLM の学習 / 独自 Embedding Model の学習 / GPU 基盤 / LangGraph の代替 /
    汎用 Workflow Engine / 完全な AGI シミュレーション / 人間の脳の忠実な再現 /
    複雑な感情シミュレーション / 3D Avatar / Voice Interface。**忘却も削除も無い。**
  - `docs/vision.md`「やらないこと」（`:73-83`）— 同様に無い。むしろ `forget` は5動詞の1つ。
  - `docs/roadmap.md` §1.3「Phase 1 から明示的に外すもの」（`:44-50`）— 5項目
    （関係グラフ本体 / reranking / `reflect()` の実運用 / `packages/bullmq` / HTTP server）。
    **`forget()` は無い。**Phase 2 送りと名指しされているのは
    「忘却の**実処理**（`decay_floor_at` を使った検索時フィルタとアーカイブ掃引）」と
    `purge()` であって、`forget()` そのものではない。

  **⟹ 正典も `AGENTS.md` も書き換えていない。**書き換える必要が無かった
  ——`AGENTS.md` は北極星を「指す」だけで中身を持たない設計であり、
  そこに範囲の線は書かれていない。

  ## では何が無かったのか

  **公開 API としての口が無い。**現物（`0a71a57` 時点、読んで確認した）:

  - `packages/core/src/runtime.ts:284` の `export interface Runtime` は
    `observe / tick / recall / reextract / reembed` の**5つ**。`forget` は無い。
  - ADR 0030（`:29-37`）が既にこれを名指ししていた:
    「**`Runtime` に `forget()` という動詞はまだ実装されていない**……
    `docs/architecture.md` §3.2 の「破棄系 — `forget(ctx, target)`」は設計時点の
    見取り図であり、実装済みの API ではない。」
    **その ADR は書き換えない**——当時の事実確認として正しい。本 ADR がその事実を変える。

  Issue #102（THE PHAGE の gurumi-chan-backend への導入検討中に見つかった外部フィードバック）は、
  この穴が実運用で何を止めているかを具体的に書いている:
  「ユーザーが会話中に『それ間違ってる』『その情報はもう古い』と訂正したときに、
  該当する記憶を落とす」経路が作れない。回避として
  `MemoryStore.updateStatus(ctx, id, "forgotten")` を直接叩けるが、
  それは adapter への直接依存であり store の差し替え可能性を失う。

  **⟹ 決めるべきものとして残っているのは、口の「形」だけである。**
  `target` の型・返り値の語彙・冪等性の作り方・並行で破れたときに何と名乗るか。
  **これはどの ADR にも書かれていない。**だから新しい番号を起こす。

- **決定**:

  ## 決定1: `MemoryStatus` に値を足さない

  `MemoryStatus` は5値（`packages/core/src/memory.ts:5`）で、`forgotten` は**既に在る**。
  「ユーザーの訂正で落ちた」と「運用の都合で落とした」の区別（Issue #102 が欲しがっているもの）を
  status に持たせない。

  理由は3つ:

  1. **その区別を運ぶ層が既に在る。**`memory_events.actor`（`human | system | clone`）と
     `meta`（`docs/memory-model.md` §9:「『状態が実際に変わった大分類』だけを列挙し、
     **理由の粒度は `meta` に落とす**」）。status に持たせるのは、その規律を破ることになる。
  2. **status を割ると、status ゲートを全部割ることになる。**`forgotten` は
     `recall-runtime.ts:326,370` の候補生成ゲート・`packages/postgres` の集約 SQL の
     `FILTER (WHERE status = 'forgotten')`・`ScopeAggregate.filteredForgotten` の
     3か所に既に写っている。値を1つ足すと、3か所すべてが**独立にずれる**新しい面を作る
     ——ADR 0082（issue #105）の根がまさにそれだった。
  3. **同じことを言う道を2つ作らない。**ADR 0078 は `strength = 0` を値域から外した理由として
     「`strength = 0` が……『二度と引かれない』という意味になり、それは `status: 'forgotten'`
     が既に表しているからである。同じことを言う道が2つ在ると、どちらで表されているかを
     読む側が両方見る必要が出る」と書いている。**同じ族の判断をここでも採る。**

  ## 決定2: 「無い」は `status` ではなく `ForgetOutcome` の側で割る

  🔴 **この repo で最も繰り返し現れた欠陥の族は「『無い』の種類を潰すこと」である**
  （ADR 0008 / 0026 / 0027 / 0028 / 0029 / 0043 / 0044 / 0076 / 0082 がこの話）。
  判定基準も既に確立している——**「その区別があると、呼び出し側の次の一手が変わるか」**
  （`docs/recall.md` §4）。

  `forget` の返り値を1つの真偽値や件数に潰すと、次の3つが同じ顔になる:
  **「忘れた」「もともと無かった」「見ていない」。**⟹ 対象ごとに `kind` を返す。

  ```ts
  export type ForgetOutcome =
    | { memoryId: MemoryId; kind: "forgotten"; previousStatus: MemoryStatus }
    | { memoryId: MemoryId; kind: "already_forgotten" }
    | { memoryId: MemoryId; kind: "not_found" }
    | { memoryId: MemoryId; kind: "conflicted"; observedStatus: MemoryStatus | null }
    | { memoryId: MemoryId; kind: "failed"; error: string }
    | { memoryId: MemoryId; kind: "not_attempted" };
  ```

  **6値。**それぞれが与える「次の一手」:

  | kind | 何が起きたか | 呼び出し側の次の一手 |
  |---|---|---|
  | `forgotten` | status を動かした。`forgotten` イベントが1件残った | 無し（成功） |
  | `already_forgotten` | 既に `forgotten` だった。**書き込みゼロ・イベントゼロ** | 無し（冪等な再送。**再試行しない**） |
  | `not_found` | そのテナントにその id の Memory が無い | id の出所を疑う。**再試行しても直らない** |
  | `conflicted` | CAS が破れ、読み直しても `forgotten` ではなかった | 読み直して**もう一度呼ぶ**（別の書き手と競合した） |
  | `failed` | store が予期しない例外を投げた | 例外の中身を見る。**この呼び出しはここで打ち切られている** |
  | `not_attempted` | **見ていない。**先行の `failed` で打ち切られ、この対象には触れていない | **そのまま再送してよい**（何も起きていないことが保証されている） |

  🔴 **`not_found` と `already_forgotten` を束ねない。**どちらも「今回は何も書かなかった」だが、
  前者は「渡された id が間違っている」、後者は「正しい id で、既に目的が達成されている」であり、
  次の一手が正反対である。

  🔴 **`not_attempted` と `failed` を束ねない。**「壊れた」と「見ていない」は違う。
  `not_attempted` は**何も起きていないことの積極的な保証**であり、
  呼び出し側はその部分だけをそのまま再送できる。

  `ForgetResult` は `{ outcomes: ForgetOutcome[] }` だけを持つ。
  **`forgottenCount` のような派生値は足さない**（`outcomes` から数えられる。
  `TICK_SUPPORTED_JOB_KINDS` の JSDoc が名指しした「散文で数え直した瞬間に黙って嘘になる」と同じ）。
  `outcomes` は**入力と同じ順序・同じ長さ**であり、入力に同じ id が2回現れれば結果にも2回現れる。

  ## 決定3: 冪等性は「読んでから CAS」で買う。再試行のループは回さない

  Issue #102 は「冪等（既に `forgotten` なら何も起きない）」を要求している。
  素直に書くと read（`getMany`）→ write（`updateStatusWithEvent`）の間に TOCTOU が開く。
  **ADR 0030 が `reextract` で塞いだのと同じ穴である**——同じ道具で塞ぐ:

  1. `getMany(ctx, ids)` で一括読み。
  2. 無い ⟹ `not_found`。`forgotten` ⟹ `already_forgotten`（**書き込みを一切しない**）。
  3. それ以外 ⟹ `updateStatusWithEvent(ctx, id, "forgotten", { expectedStatus: <読んだ status> }, event)`。
  4. `MemoryStatusConflictError` ⟹ **1回だけ**読み直す。
     `forgotten` になっていれば `already_forgotten`（＝別の誰かが先に忘れさせた。目的は達成されている）。
     消えていれば `not_found`。それ以外なら `conflicted`。

  🔴 **再試行のループを回さない**（上限のない再試行を作らない）。
  読み直しは1回で打ち切り、解けなければ `conflicted` と名乗って呼び出し側へ返す。
  「何回まわったか呼び出し側から見えない再試行」は、
  ADR 0032 が `fail` を終端にしたのと同じ理由で作らない。

  **⚠ 1回の呼び出しの中で同じ id が2回渡された場合**、2回目は `already_forgotten` になる
  ——`getMany` の結果を使い回すと2回目も「status を動かした」と名乗って**嘘になる**。
  書き込みが成功した時点でローカルの写しを更新する。歯で固定した。

  ## 決定4: 忘却は監査に残る（既決の再確認と、`actor` を受ける口）

  `docs/memory-model.md:509` が既に「**「必ず」の強制**」として要求している。
  実装は `MemoryStore.updateStatusWithEvent`（ADR 0031）を使う
  ——status 更新とイベント追記を**1トランザクション**で行う口が既に在り、
  `Runtime` 側で `updateStatus` + `append` を並べるとADR 0031 が塞いだ不整合を作り直すことになる。

  ⚠ **`docs/architecture.md:654` は「`forget()` は `MemoryStore.updateStatus` と
  `EventStore.append` を同一トランザクションで行う」と書いているが、
  それを1呼び出しで行う口は ADR 0031 で `updateStatusWithEvent` という名前になった。**
  文書のほうを現物に合わせて直した（本 PR）。

  積むイベント:

  ```ts
  {
    tenantId: ctx.tenantId, memoryId: id, kind: "forgotten",
    actor: opts?.actor ?? { type: "system" },
    digestSnapshot: <その Memory の digest>,
    meta: opts?.reason === undefined ? {} : { reason: opts.reason },
  }
  ```

  **`opts.actor` を受ける。**Issue #102 が欲しがっているのは
  「『ユーザーの訂正で落ちた』と『運用の都合で落とした』を後から区別」することであり、
  `MemoryEvent.actor` は NOT NULL なので `forget` は**必ず何かを書く**。
  そこを `{ type: "system" }` に固定すると、ユーザーの訂正で落ちた記憶が
  「システムが落とした」と記録される——**監査ログが静かに嘘をつく。**
  `EventActor` は既に `human | system | clone` の3値を持っており、新しい語彙は作っていない。

  🔴 **`content` は `meta` に入れない。**`docs/memory-model.md:498-499`:
  「記録項目は tenant_id / memory_id / kind / at / actor / digest のスナップショット /
  直前のサイズに限る。**本文（`content`）は残さない。**」

  ## 決定5: 複数対象の原子性は買わない。打ち切って「見ていない」と名乗る

  ADR 0031 が明示的に**買わない**と書いた不変条件である:
  「複数の Memory にまたがる操作全体の原子性は呼び出し側の責務」。
  `forget` はそれを買い直さない。

  予期しない例外が出たら**そこで打ち切り**、残りを `not_attempted` にして**返す**（投げない）。
  🔴 **例外を投げないのは、部分的に起きたことを呼び出し側から見えなくしないためである。**
  3件目で投げると、1件目が既に忘れられ監査ログに残っていることが呼び出し側に伝わらない。
  ⟹ `failed` と `not_attempted` は、この決定があって初めて意味を持つ。

  ## 決定6: `recall` 側は1行も変えない

  現物を読んで確認した:
  - 候補生成の status ゲートは `["active", "contested"]`（`recall-runtime.ts:326,370`）
    ⟹ `forgotten` は既に候補に入らない。
  - `recall-runtime.ts:817-824` が `{ kind: "filtered", condition: "forgotten", count, countKind }`
    を `omitted` に積む（ADR 0027 が `superseded` から分けた札）。

  **⟹ `forget()` が status を動かした時点で、recall 側は既に正しく振る舞い、
  既に正しく「忘れられた N 件がある」と名乗る。**新しい `Omission` の値も足していない
  （`Omission` は現物のコードで**11種**——`docs/recall.md` §4 の列挙は10種のままで、
  ADR 0084 が足した `lexical_truncated` が反映されていない。**本 ADR ではその drift を直さない**
  ——Issue #109 の作業が同じ節に触れており、衝突面を増やさないため。**直っていないことをここに記録する。**）。

  これは推論ではなく**歯で測った**（`forget` した Memory が `recall()` の結果に出ず、
  `omitted` に `filtered/forgotten` が出ることを検査している）。

  ## 変異試験で分かったこと（歯を「置いた」と「測っている」は違う）

  歯を19本置いたあと、実装を意図的に壊して**どの歯が赤くなるかを目で見た**。
  7つの変異のうち6つは「赤くならなければならない」もの、1つは
  **「赤くなってはいけない」もの**（ふるまいを変えない書き換え）である。

  | 変異 | 壊した内容 | 結果 |
  |---|---|---|
  | M1 | `already_forgotten` の分岐を消す | 🔴 4本が赤（冪等性2本・往復1本・順序1本） |
  | M2 | `expectedStatus` を渡さない（CAS を外す） | 🔴 3本が赤（並行の3本すべて） |
  | M3 | 打ち切りをやめて処理を続ける | 🔴 1本が赤（打ち切りの歯） |
  | M4 | `not_found` を `already_forgotten` に丸める | 🔴 2本が赤 |
  | M5 | `meta` に `reason` を積まない | 🔴 1本が赤 |
  | M6 | 呼び出し内のローカルの写しを更新しない | 🔴 1本が赤（**下記の修正の後**） |
  | M7 | `for (let i…)` → `for (const [i, id] of ids.entries())` | ✅ **緑のまま**（ふるまいを変えない書き換えで赤くならない＝歯が実装の*形*を固定していない） |

  🔴 **M6 は最初、生き残った。**そして生き残った理由が、コードのコメントの主張が
  **間違っている**ことを示した。当初のコメントは「写しを更新しないと2回目も
  `"forgotten"` になる（嘘の2回目）」と書いていたが、**そうはならない**
  ——2回目は古い status で CAS を撃ち、それが弾かれ、読み直して同じ
  `already_forgotten` に着く。**CAS が救っている。**
  ⟹ 写しの更新が買っているのは*正しさ*ではなく**往復**である
  （重複した id 1つにつき「必ず失敗する UPDATE」1回と「読み直しの SELECT」1回を節約する）。
  **コメントのほうを事実に合わせて直した。**

  ⚠ **さらに、直した後も M6 は生き残った。**原因は本番コードではなく**偽物のほう**だった:
  `FakeMemoryStore.getMany` は `memories` Map の**同じ参照**を返し、
  `updateStatusWithEvent` はその場で `memory.status = status` と書き換える
  （`runtime-fakes.ts`）。⟹ **`forget` のローカルの写しが古くなりようがない。**
  本物の Postgres は行を読み直すたびに新しいオブジェクトを返すので、写しは古くなる。
  **⟹ この偽物では、原理的にこの区別を測れなかった。**
  歯の側で `getMany` の戻り値を複製して本物の store を模し、そこで初めて M6 が赤くなった。

  🔴 **記録しておく価値のある一般則**: **この repo のインメモリの偽物は
  `Memory` をその場で書き換え、同じ参照を配る。**
  ⟹ 「読んだ後に別の誰かが書き換えた」を前提にする歯は、
  **素の偽物の上では静かに測定不能になる**（そして落ちる向きは常に緑である）。
  ADR 0078 が「変異試験で歯が当たらないと分かった`Number.isFinite`は冗長だったので
  コードのほうを消した」と書いたのと同じ手続きだが、**結論は逆になった**
  ——ここで冗長だったのは本番コードではなく**測り方**だった。

- **検討して採らなかった案**:

  1. **`forget` を `boolean` か件数だけ返す形にする。**
     却下。決定2 のとおり「忘れた」「もともと無かった」「見ていない」が同じ顔になる。
     この repo が9本の ADR を費やして塞いできた欠陥を、新しい API で作り直すことになる。

  2. **`MemoryStatus` に `forgotten_by_user` / `forgotten_by_ops` を足す。**
     却下。決定1 の3つの理由。加えて、これを足すと「忘れられているか」を判定する全ての箇所が
     `status === 'forgotten'` から集合判定へ変わり、**既存の3つの写しが独立にずれる面が増える。**

  3. **対象が無いときに例外を投げる（`MemoryStore.updateStatusWithEvent` の
     「memory not found」をそのまま伝播させる）。**
     却下。Issue #102 の「冪等」要求と噛み合わない。複数対象のうち1件だけ id が古かった場合に、
     残り全部が道連れになる。**「無い」は結果であって障害ではない。**

  4. **CAS を使わず無条件 UPDATE にする。**
     却下。同時に2回 `forget` されると `forgotten` イベントが**2件**積まれ、監査ログが
     「2回忘れさせた」と読める。Issue #102 の冪等要求も破れる。

  5. **`conflicted` のときに解決するまで再試行する。**
     却下。決定3 のとおり上限が書けない。呼び出し側に返して判断させるほうが正直である。

  6. **本番コードに「読みと書きの間に待ちを差し込む口」を足して並行を測る。**
     却下。⚠ **並行の歯は fake の store 側で作れる**（`getMany` と `updateStatusWithEvent` の
     間で status を差し替える fake を書けばよい）。ADR 0077 が
     「測るための道具は測る場所に置く」と書いたのと同じ判断。
     **本番コードにテスト専用の seam を足すと、その seam 自体が公開契約になる。**

  7. **`purge()` も同じ PR で実装する。**
     却下。`docs/memory-model.md:548` が「`purge()` は Phase 2 以降」と明記しており、
     オーナーの 2026-09-06 の判断（`docs/roadmap.md:219`）もその線を確認している。
     **この PR は Phase の線を動かしていない。**

- **引き受ける負債・覆えていない範囲**:

  1. 🔴 **`contested` な Memory を `forget` すると、対向の一対一が破れる。**
     `contested` は相互に `contestedWithId` を指す（`docs/memory-model.md` §5 機構2/3）。
     片側を `forgotten` にしても対向の `contestedWithId` は残り、
     `contested-pair-invariant.test.ts` の検査器が言う `opposite_without_contested_status` に当たる状態になる。
     **直していない。**`docs/memory-model.md` §11 行9 は遷移元を「任意」と書いており、
     `contested` を弾くのは仕様に無い追加の制約になる。加えて **Phase 1 の本番コードに
     `contested` を書き込む経路は1本も無い**（`packages/*/src` を検査して確認。読む側だけが在る）
     ——`contested` を作る主体が入る Phase 2 の判断であり、
     ADR 0046 の歯自身が「破れた入力が来たときの振る舞いはここでは決めない」と書いている。
     **⟹ 起こりうるが、Phase 1 の経路からは起こらない。**

  2. **ベクタ索引から行を外していない。**`memory_embeddings_<space>` は残る。
     Issue #102 は「ベクタ索引から外すのか、スコア段で弾くのかは実装側の判断で」と書いており、
     現物は候補生成の status ゲートで弾いている（決定6）。
     **⟹ 忘れた記憶の埋め込みはディスク上に残り続ける。**これは `purge()`（Phase 2）の担当範囲であり、
     「内容を消す」という要求は今の `forget()` の意味論（可逆な論理削除）と両立しない。

  3. **`forgotten` → `active` へ戻す口を開けていない。**
     `docs/memory-model.md:547` は `forget()` を「復元可能」と書いているが、
     復元する**公開 API は無い**（`MemoryStore.updateStatus` を直接叩けば戻せる）。
     Issue #102 も要求していない。**「復元可能」は今のところ性質であって機能ではない。**

  4. **`docs/recall.md` §4 の `Omission` の列挙が現物より1つ古い**（決定6 の ⚠）。
     本 PR では直していない。

  5. **本物の Postgres に対して `forget` を通していない。**
     この作業環境に `DATABASE_URL` が無く、DB テストは実行していない
     （`AGENTS.md` の「緑をそのまま『全部通った』と読まないこと」）。
     ただし `forget` は `packages/core` だけの変更であり、`updateStatusWithEvent` の
     Postgres 実装は ADR 0031 の適合テスト（`memory-store-conformance.ts:1333-1470`）で
     既に測られている。**CI が DB 付きで走るので、そこが実測の場になる。**

- **これが覆るとしたら**:

  - **`purge()`（Phase 2）が入ったとき**、`forget` の返り値の語彙が
    `purge` にもそのまま要ることが分かれば、`ForgetOutcome` を共有の型へ引き上げる判断が要る。
    今は `forget` 1つしか呼び手が無いので、先回りして抽象化しない（ADR 0024 の
    「実装の無いものを『予約』と書き残さない」）。
  - **`conflicted` が実運用で頻発したら**、決定3 の「読み直し1回で打ち切り」が薄すぎる。
    そのときは再試行回数を**呼び出し側が渡す**形（`opts.maxRetries`）を検討する
    ——runtime が既定値を発明しない、という ADR 0032（`leaseMs` 必須化）の線に合わせる。
  - **`contested` を作る主体が Phase 2 で入ったら**、負債1 は実際に踏まれる。
    そのとき `forget` が対向の `contestedWithId` をどう始末するかを決める必要がある
    （候補: 対向も同時に `active` へ戻す / 対向の `contestedWithId` を NULL にする）。
    **今は決めない**——`contested` の解決規則自体が未実装であり、
    それを決めずに片付け方だけ決めると、後から辻褄が合わなくなる。
  - **`forgotten` からの復元が要求されたら**、負債3 が課題になる。
    そのとき `forgotten` → `active` の遷移が `docs/memory-model.md` §11 の表に無いことに注意
    （表を先に直す必要がある。実装の都合で lifecycle を黙って広げない）。

- **確かめていないこと**:

  - **本物の Postgres で `forget` を走らせていない**（負債5）。この環境に DB が無い。
  - **並行の歯は fake に対して測っており、実 DB の行ロックの振る舞いは測っていない。**
    特に「ガードで弾かれる `UPDATE` が行ロックを取るかどうか」は
    **この ADR の主張の根拠にしていない**——`MemoryStatusConflictError` が投げられさえすれば
    決定3 の分岐は正しく動き、ロックを取るか取らないかは**待つか即返るかの違いにしかならない**。
    ただしそれは推論であり、実測していない。
  - `ForgetOutcome` の6値が「多すぎる」か「足りない」かは、**実利用のフィードバックが無い。**
    Issue #102 の報告者は `ForgetResult` の中身について具体案を出していない。
