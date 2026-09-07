# ADR 0056: 段1の ANN クエリで `excludeProvenanceKinds` を絞る（`period` は今回も降ろさない）

- **状態**: 採用 (2026-09)

- **文脈**:

  `recall()` の `RecallQuery.excludeProvenanceKinds`（`packages/core/src/recall.ts`）は、
  roadmap.md §5.5 のオーナー回答「推論（`inferred`）を既定の recall に含める。ただし
  `provenance.kind` で区別して返す」を実装した除外オプションである。**これまで段2
  （再スコア前の後段フィルタ、`recall-runtime.ts` の候補取得後のループ）でしか
  適用されていなかった。** 段1（ANN 検索、`VectorFilter` を渡す `VectorStore.search`）の
  `filter` には `tenantId` / `status` / `subjectId` しか無く、`excludeProvenanceKinds` は
  含まれていなかった。

  ⟹ ADR 0023 が `subjectId` について指摘したのと同じ構造の穴が、`excludeProvenanceKinds`
  にも空いていた。**大規模テナントで `excludeProvenanceKinds` を指定すると、over-fetch の窓
  （`k' = limit × overFetchFactor`、既定40）が除外対象の kind で埋まり、残したい kind の
  記憶が1件も窓に入らないまま黙って落ちうる。**

  マネージャーが現物で確認した事実として渡された前提（本 ADR ではこれ自体は再確認していない）:

  - `RecallQuery.excludeProvenanceKinds?: ProvenanceKind[]` は zod で `.optional()` のみ、
    `.default()` は無い（`packages/core/src/recall.ts:592`）。
  - `memories (tenant_id, provenance_kind)` の索引は既に在る
    （`packages/postgres/migrations/0001_init.sql:134-135`）。コメントは逐語で
    `-- provenance によるフィルタ（推論を除外する recall オプション）`。
  - ADR 0034 が `VectorFilter` の各フィールドを「adapter が実際に適用しなければならない」
    契約にし、適合テストの歯を置いた。
  - ADR 0023 が `subjectId` を段1へ降ろした先例であり、`period` を降ろさなかった理由は
    「連続値の範囲比較——索引設計に踏み込む」。ADR 0023 に `provenance` への言及は0件。

- **決定**:

  1. **`VectorFilter`（`packages/core/src/interfaces/vector-store.ts`）に
     `excludeProvenanceKinds?: ProvenanceKind[]` を足す。** `RecallQuery` と同じ語彙・
     同じ向き（除外の列挙）に揃える。
  2. **`recall-runtime.ts` の段1呼び出しに `excludeProvenanceKinds:
     validatedQuery.excludeProvenanceKinds` を渡す。** `?? []` による正規化はしない
     ——`undefined` のまま渡しても `[]` を渡しても段1が no-op になることを、適合テストの
     歯（`vector-store-conformance.ts`）で両方の adapter に対して固定した。
  3. **段2の絞り（`recall-runtime.ts:306` 付近の `excludeKinds.has(...)`）は残す。**
     ADR 0034 が「多層防御は残す」と決めたことの延長——`VectorFilter` は「絞る義務」を
     持つ契約になったが（ADR 0034）、正しさの責任は後段にも置く。
  4. **postgres / in-memory（`packages/testkit`）/ `FakeVectorStore`（`packages/core`
     自身のテスト用二重、ADR 0047 と同じ構造）の3実装すべてに条件を足す。**
     postgres は `m.provenance_kind <> ALL($x::text[])`、空配列のときは条件自体を
     追加しない（`length > 0` の番人。理由は下記「意味論の非対称」）。in-memory /
     `FakeVectorStore` は `excludeProvenanceKinds.includes(memory.provenance.kind)` で
     真なら候補から落とす。
  5. **既に在る索引を使う。マイグレーションは追加しない。**
     `idx_memories_provenance_kind (tenant_id, provenance_kind)`
     （`packages/postgres/migrations/0001_init.sql:134-135`）は、コメントが逐語で
     「provenance によるフィルタ（推論を除外する recall オプション）」と書いている
     とおり、**この用途のために最初から作られていた。しかしどのクエリ経路もこれまで
     使っていなかった**——段2の後段フィルタは Postgres 側のクエリを経由しないメモリ上の
     ループであり、段1は `provenance_kind` を一切見ていなかったため。今回の変更で、
     この索引が作られてから初めて実際に使われる経路ができる。

- **理由**:

  1. **ADR 0023 の却下理由が `excludeProvenanceKinds` には当たらない。** ADR 0023 が
     `period` を段1に降ろさなかった理由は「連続値の範囲比較であり、partial index の
     離散値向き制約に関わる設計判断が要る」（下記「`period` を今回も降ろさなかった理由」に
     逐語引用）。`provenance_kind` は**離散5値の独立列**であり、比較は**等値**
     （`<> ALL`）——`docs/architecture.md` §5.2 の「filter は索引で表現できる形
     （等値・単調な範囲比較）に限る」にそのまま当たる。ADR 0023 が `subjectId` について
     「新しい種類の要求ではない」と書いたのと同じ理由が、ここでも成り立つ。
  2. **「降ろさない」と決めた記述が一切無い。** ADR 0023 に `provenance` への言及は
     **0件**である。⟹ これまで段1に無かったのは「検討して却下した」のではなく
     **単純な抜け**であり、埋めるべき穴だった。
  3. **構造として段1に在るべきもの。** 採点（段2）の前に候補集合を縮める絞りは、
     有限の ANN 窓（k′）より*手前*に置かないと、窓の中身がその絞りを反映しない
     ——ANN が返す `k'` 件は「絞る前」の近傍であり、絞りたい対象がその近傍の中で
     少数派なら、窓に入る前に他の候補で埋まってしまう。これは ADR 0023 が `subjectId`
     について実測した現象（大きい crowd が小さい対象を窓から押し出す）と同じ構造であり、
     `excludeProvenanceKinds` にも同じ構造がある。

- **⭐ 既定の挙動は変わらないこと**:

  **既定は空——段1の絞りは no-op のままである。** `RecallQuery.excludeProvenanceKinds` の
  zod スキーマは `z.array(ProvenanceKindSchema).optional()` で `.default()` を持たない
  （`packages/core/src/recall.ts:592`。マネージャーが現物で確認した前提として渡された事実、
  本 ADR ではこの一点を再確認していない）ため、呼び出し側が指定しなければ
  `validatedQuery.excludeProvenanceKinds` は `undefined` のまま段1へ渡る。
  `recall-runtime.ts` はこれを `?? []` で正規化せずそのまま渡しており（決定2参照）、
  `VectorFilter.excludeProvenanceKinds` の契約は「`undefined` と `[]` はどちらも
  no-op」——3実装のどれでも、この入力では候補は一切落ちない。

  ⟹ `docs/roadmap.md` §5.5 のオーナー決定（推論 `inferred` を既定の recall に含める。
  ただし `provenance.kind` で区別して返す）に、本 ADR は何も起こさない。既定のまま
  呼び出した `recall()` は、本 ADR の前後で段1に渡る候補の集合が変わらない
  ——変わるのは「呼び出し側が `excludeProvenanceKinds` を明示したとき、段1がそれを
  無視しなくなる」という一点だけである。

- **`period` を今回も降ろさなかった理由**:

  ADR 0023「`period` を降ろさなかった理由」節の逐語:

  > `docs/recall.md` は「partial index は離散値・低カーディナリティのフィルタに向くが、
  > 連続値の範囲比較には向かない。連続値で索引を効かせたいなら離散化したバケット
  > （例:『直近30日』）を別列に持つ迂回はあり得るが、**Phase 1 の scope には含めない**」
  > と書いている。`period` はまさにこの連続値の範囲比較である。
  >
  > ⟹ **subject（等値）と period（範囲）は索引設計上の性質が違う。**
  > period を降ろすには「バケット列を足すか」というスキーマに踏み込む判断が要り、
  > それは本 ADR の範囲を超える。

  この理由は `excludeProvenanceKinds` の押し下げが完了した後もそのまま生きている
  ——`excludeProvenanceKinds` は等値比較（離散5値）であり、この却下理由が指す
  「連続値の範囲比較」には元から当たらない。**⟹ 次にこの ADR を読む人が
  「`excludeProvenanceKinds` と一緒に `period` も段1へ降ろされたはず」と読まないよう、
  ここに明記する: `period`（`occurredAfter`/`occurredBefore`）は本 ADR でも
  `VectorFilter` に足していない。** 引き受ける負債は ADR 0023 が既に書いたものと同じで、
  本 ADR はこれを解消しない。

- **⭐ ADR 0023 は「覆る条件を自分で書いた決定」であること**:

  ADR 0023「これが覆るとしたら」節の逐語:

  > `period` を段1で絞りたいという要求が実測で裏付けられたら（狭い時間窓 ×
  > 大規模テナントでの取りこぼしが観測されたら）、離散化バケット列の設計を
  > 別 ADR で起こす。

  ⟹ ADR 0023 は「`period` をやらない」を無条件の結論として書いたのではなく、
  **この観測が出たら見直せ、という条件付きの決定**である。

  **前任のマネージャー（`mgr-9aa26aa5`）の報告によれば、その見直しの引き金にあたる
  観測——狭い絞り × 大きい候補集合で目的の記憶が段1の窓に入らない取りこぼし——は
  実測で再現されている。⚠ この記録は前任の報告を経由した伝聞であり、本 ADR の
  作業者は再現していない。** 引き金が引かれた記録として残す。

  **本 ADR の作業者自身が測ったこと（別の段落として、伝聞とは出所を分ける）**:
  上の歯A（`packages/postgres/src/__tests__/vector-search-provenance.test.ts`）は
  `excludeProvenanceKinds` について同じ形の取りこぼし（絞らないと目的の Memory が
  段1の窓に入らない）を再現する*つもり*で書いたが、**この作業環境には PostgreSQL/
  `DATABASE_URL` が無いため、一度も実行していない。CI の結果を待っている状態である。**
  ⟹ 「再現した」とは書かない——次の CI 実行が唯一の実測経路である。

  なお、上の引き金は `period`（連続値の範囲比較）についての観測であり、本 ADR の対象
  （`excludeProvenanceKinds`、離散値の等値比較）とは絞りの種類が異なる。**引き金が
  `period` の見直しを促すものであって、`excludeProvenanceKinds` を段1に降ろす根拠は
  上の「理由」節（1〜3）に別途ある**——両者を混同しないこと。

- **意味論の非対称（`status` とは向きが逆）**:

  `status` は**包含**の列挙（配列に*在る*ものだけ通す）。`excludeProvenanceKinds` は
  **除外**の列挙（配列に*在る*ものを落とす）。この向きの違いから、空配列の意味が
  非対称になる:

  - `status: []` は SQL の `= ANY('{}')` に翻訳され、**何にも一致しない**
    （全件を除外する）。
  - `excludeProvenanceKinds: []` は「除外する kind が0個」という意味であり、
    **全件を通す**（no-op）。

  この非対称は `VectorFilter.excludeProvenanceKinds` の doc コメント
  （`packages/core/src/interfaces/vector-store.ts`）に明記し、適合テストの歯
  （`vector-store-conformance.ts` の「`excludeProvenanceKinds: []` は no-op」の it()）で
  postgres / in-memory 両方に対して固定した。postgres 実装は空配列のとき条件自体を
  追加しない（`length > 0` の番人）——`<> ALL('{}')` は常に真になるので追加しても
  実害は無いが、`EXPLAIN` を読みにくくするため出さない。

- **`recall-runtime.ts` の古い記述を1点訂正したこと**:

  段2のループ内に、以前こう書かれた逐語コメントが残っていた:

  > `InMemoryVectorStore`（testkit）は filter を無視するプレースホルダなので、
  > ここを削ると core の契約そのものが壊れる。

  この根拠は ADR 0034 が `InMemoryVectorStore` を直した時点で事実でなくなっており、
  ADR 0034 自身が「`recall-runtime.ts` はマネージャーの指示により本 PR では触っていない
  ……コメントの更新は別途必要」と書き残していた。本 ADR でこのコメントを、
  「もう事実でない根拠（filter を無視するプレースホルダだから）」から
  「ADR 0034 が決めた現在の根拠（`VectorFilter` は絞る義務を負う契約だが、
  正しさの責任は後段にも置く多層防御）」へ差し替えた。多層防御を残すという
  **決定そのものは変えていない**——根拠の記述だけを事実に合わせて直した。

- **採らなかった案**:

  - **包含の列挙（`provenanceKinds?: ProvenanceKind[]`）にして `status` と向きを揃える。**
    却下。理由は2つ——(a) `RecallQuery.excludeProvenanceKinds` という既存の公開語彙との
    間で、呼び出し側にもう一段の写し（除外リストから含有リストへの変換、あるいは
    逆方向）が要る。(b) 5値の閉じたユニオンで「除外リストの補集合」を計算するコードが
    どこかに要り、`undefined`（no-op のつもり）が「5値全部を列挙した `WHERE` 句」に
    化ける——意図が読みにくくなる上、`ProvenanceKind` に将来6番目の値が増えたとき、
    その計算コードを直し忘れると黙って壊れる（`provenance.ts` が既に「閉じたユニオンの
    綴りを2箇所に複製すると片方を直し忘れる」と書いている失敗の族と同じ形）。
    `RecallQuery` と同じ向き・同じ語彙に揃えるほうが、写す手間も補集合計算も要らない。
  - **段2の絞りを消して段1だけにする。** 却下（ADR 0034「採らなかった案」節——
    `VectorFilter` を「絞ってもよいが絞らなくてもよい」緩い契約のままにする案を却下し、
    「絞る」を契約にしつつ多層防御としての後段フィルタは残す、と決めた延長）。
    `VectorStore` は「絞ってもよいが絞らなくてもよい」派生索引という前提は
    ADR 0034 で「絞る義務を持つ」に変わったが、正しさの責任を段1の adapter 実装だけに
    委ねる決定はしていない——後段フィルタを消すと、adapter がこの契約を落とした
    ときに結果が静かに壊れる。

- **引き受ける負債 / 確かめていないこと**:

  - **DB を要する歯A・歯B（`vector-search-provenance.test.ts`）は、この作業環境に
    PostgreSQL/`DATABASE_URL` が無いため一度も実行していない。** 型検査（`tsc`）が
    通ることのみ確認した。次の CI 実行が唯一の実測経路である。
  - **歯Bはプランの選択を断定していない。** `subject_id`（高選択性）と
    `provenance_kind`（低選択性、しかも除外）は選択性の性質が違うため、
    `subject_id` で観測された「HNSW を捨てる」という結果をそのまま転用できない
    ——歯Bは「`memories` 本体が `Seq Scan` にならない」「条件が黙って落ちない」という
    選択性に依存しない弱い不変だけを検査し、実際のプランは `console.log` で CI ログに
    残す形にした。
  - **ADR 0023 が subject の押し下げについて記録した代償**（「上のプランは埋め込み
    テーブル側を `Seq Scan` している……この経路の費用はテナントの行数に比例して
    伸びる」「`docs/roadmap.md` §5.6 は100万件級を前提に設計すると書いており、
    その規模でこの経路がどうなるかは測っていない」）**と同じ問いが、
    `excludeProvenanceKinds` の押し下げについても立つ。プランが変わりうるからである。
    ⟹ 同じ代償が実際にあるかどうかは測っていない。**「無い」とは書かない——
    低選択性の除外条件がテナント規模に対してどう振る舞うかは、この ADR の範囲では
    未知のままである。
  - **`excludeProvenanceKinds` を渡す repo 内の呼び出し側は、テストと型定義以外に
    0件である。** ただし `RecallQuery.excludeProvenanceKinds` は公開 API の欄であり、
    `docs/roadmap.md` §5.5 のオーナー決定が明示的に指定した除外オプションである
    ——「型に在るだけで到達経路が0件の欄」ではない（オーナーが要求した欄であり、
    `examples/chat` や外部の呼び出し側が使えば到達する）。**ただし repo 内の実利用は
    0件である。この両方を正直に書く。**
  - `period` 同様、`excludeProvenanceKinds` に空配列以外の特殊な入力
    （例えば同じ kind を重複して渡す）を渡した場合の挙動は個別に検討していない
    ——ADR 0023 が `subjectId` について同じ理由で無検証と書いており、それに倣った。
  - **⭐ 段2の絞りを消す変異は、`recall-pipeline.test.ts` の既存の歯（D5、
    「`excludeProvenanceKinds: ['inferred']` を渡すと除外される」）を赤くしない
    ——手元で変異を撃って確かめた（作業者本人の実測、伝聞ではない）。** 段1
    （`FakeVectorStore`）が本 ADR により正しく `excludeProvenanceKinds` を適用する
    ようになった結果、この既存の歯が使う候補数（1件）では段1の時点で既に候補が
    落ちてしまい、段2の分岐を通る前に検査対象が消える。**⟹ 「段2が多層防御として
    実際に効いている」ことを、このリポジトリの既存の歯は独立に検査していない。**
    これは新しい欠陥ではなく、ADR 0034 が `subjectId` について既に記録した現象
    （「`subjectId` を落とす変異では赤くならない——後段が救うため」）と同じ族であり、
    `excludeProvenanceKinds` もその仲間に入った、という追認である。**本 ADR は
    このテストの穴を塞いでいない**——塞ぐには、段1がわざと絞らない adapter
    （あるいは段1の filter から `excludeProvenanceKinds` を意図的に外したテスト専用の
    `VectorStore`）を使って段2だけを検査する歯が要り、それは本 ADR の範囲を超える
    別の作業として残す。
  - **⭐ 同じ理由で、`FakeVectorStore`（`packages/core/src/__tests__/runtime-fakes.ts`）の
    `excludeProvenanceKinds` の除外方向を反転する変異も、既存のどの歯にも捕まらない
    ——手元で変異を撃って確かめた。** `FakeVectorStore` は ADR 0034 が明記したとおり
    適合テスト（`vector-store-conformance.ts`）の対象外（`packages/core` 自身の runtime
    テスト専用の二重）であり、それを直接検査する歯が無い。加えて上と同じ多層防御が、
    D5 の既存の歯（候補1件のシナリオ）ではこの反転を隠す。**引き受ける負債として
    記録する**——`InMemoryVectorStore`（`packages/testkit`）側は適合テストの歯
    （本 ADR で追加した3本）が同じ変異を確実に捕まえることを確認済みであり
    （下の変異試験の結果参照）、実害の中心はそちらで塞がれている。

- **⭐ 変異試験の結果**:

  **撃った環境と門**: この節の測定は `feat/exclude-provenance-kinds-in-ann` の
  `b281fd3` に対して、**手元**（PostgreSQL / `DATABASE_URL` の無い作業環境）で行った。
  回した門は `pnpm run typecheck` / `pnpm run lint` / `pnpm run test`（ルートの test 門。
  DB 段は `DATABASE_URL` が無いため実行されず、門自身がそう報告する。ADR 0015）。
  **基準線**: `packages/core` 298 tests / 28 files、`packages/testkit` 150 tests / 2 files、
  ルート直下 7 tests / 3 files。**下の各行で「走ったテスト数」が基準線と一致していることは、
  歯が走る前に木が壊れていない（変異が型検査や import を落としていない）ことの証拠である。**

  **各変異は1本ずつ当て、当てるたびに `git diff --stat` が空でないことを門の*前*に確かめ、
  測り終えたら `git checkout --` で復元して木が清いことを確かめた。**

  **⭐ 本 ADR が新しく足した歯には、それぞれ「その歯だけが赤くなる」変異が在る:**

  | # | 当てた変異（置換の前後は下に逐語） | 赤くなった歯 | 走ったテスト数 |
  |---|---|---|---|
  | 1 | 段1の filter から `excludeProvenanceKinds` の欄を落とす | **配線の歯の1本目**（新規） | 298（基準線と一致。1 failed / 297 passed） |
  | 2 | in-memory の除外を「`status` の絞りが在るときだけ」に狭める | **適合テストの歯A**（新規） | 150（1 failed / 149 passed） |
  | 3 | in-memory で空配列を「全件除外」に取り違える（`status: []` との混同） | **適合テストの歯B**（新規） | 150（1 failed / 149 passed） |
  | 4 | in-memory の除外を「`status` の絞りが無いときだけ」に狭める | **適合テストの歯C**（新規） | 150（1 failed / 149 passed） |

  **4本とも「1本だけ赤」であり、赤の出どころは4本ともこの適合テスト／配線の歯自身の
  `expect(...)` である**（`AssertionError` に `Expected` / `Received` が出る形。
  フレームワークのガードでもヘルパ内の生 `throw` でもない）。逐語:

  - 変異1（`recall-runtime.ts`、段1呼び出しから1行削除）:
    削除したのは `excludeProvenanceKinds: validatedQuery.excludeProvenanceKinds,`。
    赤: `excludeProvenanceKinds を渡すと VectorStore.search の opts.filter.excludeProvenanceKinds に渡る`。
    失敗メッセージ逐語: `AssertionError: expected undefined to deeply equal [ 'inferred' ]`。
    **配線の歯の2本目（既定が no-op であること）は緑のまま**——`undefined` はこの歯が
    許す形だからであり、正しい振る舞いである。
  - 変異2（`in-memory-vector-store.ts`）: `opts.filter.excludeProvenanceKinds !== undefined &&`
    の**前**に `opts.filter.status !== undefined &&` を足す。
    赤: `filter.excludeProvenanceKinds: 配列に在る kind の Memory は返らず、無い kind の Memory は返る`。
    失敗メッセージ逐語: `AssertionError: expected [ 'mem-182', 'mem-183' ] to not include 'mem-182'`。
  - 変異3（`in-memory-vector-store.ts`）:
    `opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)` を
    `(opts.filter.excludeProvenanceKinds.length === 0 || opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind))`
    に置き換える。赤: `filter.excludeProvenanceKinds: [] は no-op（status: [] とは非対称——両方とも返る）`。
    失敗メッセージ逐語: `AssertionError: expected [] to include 'mem-184'`。
    **⟹ 上の「意味論の非対称」節が言葉で書いた区別を、この歯が実際に噛んでいる。**
  - 変異4（`in-memory-vector-store.ts`）: 変異2と同じ位置に、向きを逆にした
    `opts.filter.status === undefined &&` を足す。
    赤: `filter.excludeProvenanceKinds は他の filter（status）と AND になる`。
    失敗メッセージ逐語: `AssertionError: expected [ 'mem-186', 'mem-187' ] to not include 'mem-187'`。

  **⭐ 加えて、`InMemoryVectorStore` の除外の向きを反転する変異**
  （`opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)` →
  `!opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)`）
  **では、上の3本が同時に赤くなる**（150 tests、3 failed / 147 passed。
  1本目の逐語: `AssertionError: expected [ 'mem-182' ] to not include 'mem-182'`）。
  ⟹ 上の「引き受ける負債」節が `InMemoryVectorStore` 側について書いた「適合テストの歯が
  同じ変異を確実に捕まえる」は、この測定による。

- **⭐ 生き残った変異と、その理由（段1と段2が互いを庇っている）**:

  **上の「引き受ける負債」節が記録した2件は、本 ADR の後任が独立に再現した。**
  どちらも `pnpm run typecheck` / `pnpm run lint` / `pnpm run test` の**3門すべてを素通り**し、
  走ったテスト数は基準線と完全に一致した（`packages/core` 298 / `packages/testkit` 150 /
  ルート 7、いずれも 0 failed）。

  | # | 当てた変異 | 結果 |
  |---|---|---|
  | 5 | 段2の除外集合を常に空にする: `const excludeKinds = new Set(validatedQuery.excludeProvenanceKinds ?? []);` → `const excludeKinds = new Set<string>();` | **生き残る** |
  | 6 | `FakeVectorStore`（段1）の除外の向きを反転する: `opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)` → `!opts.filter.excludeProvenanceKinds.includes(memory.provenance.kind)` | **生き残る** |

  **⚠ どちらも等価変異ではない——プログラムの意味は変わっている。**変異5では段2の
  多層防御が消え、変異6では段1が*除外すべきでないほう*を落とす。**歯が無いだけである。**

  **⭐ そして、この2本を*同時に*当てると赤くなる**——`recall-pipeline.test.ts` の既存の歯
  `D5: 既定で provenance.kind='inferred' を含める。除外オプション > excludeProvenanceKinds: ['inferred'] を渡すと除外される`
  が落ちる（298 tests、1 failed / 297 passed。逐語:
  `AssertionError: expected [ { memoryId: 'mem-118', …(4) } ] to have a length of +0 but got 1`）。

  **⟹ 段1と段2は互いを庇っている。** D5 が使うシナリオでは、段1を壊しても段2が結果を救い、
  段2を壊しても段1が結果を救う。**⟹ このリポジトリの既存の歯は、`recall()` の段1の絞りと
  段2の絞りを*独立には*検査していない。**「多層防御が実際に効いている」ことは、
  片方を壊す変異では観測できない。これは新しい欠陥ではなく、ADR 0034 が `subjectId` に
  ついて記録した現象と同じ族であり、`excludeProvenanceKinds` もその仲間に入ったという追認である。
  **本 ADR はこの穴を塞いでいない**——塞ぐには段1がわざと絞らない `VectorStore` を使って
  段2だけを検査する歯が要り、それは別の作業として残す。

  **⚠ 変異5について1点、測り方の注記**: 段2の行
  `if (excludeKinds.has(memory.provenance.kind)) continue;` を*削除*する形で当てると、
  `excludeKinds` が未使用になり `@typescript-eslint/no-unused-vars` で `pnpm run lint` が
  赤くなる。**これは歯が振る舞いを捕まえたのではなく、変異の当て方が残した副作用である。**
  ⟹ 上の表の変異5は、変数が使われたまま振る舞いだけが消える形（除外集合を常に空にする）に
  撃ち直したものであり、この形では lint も緑である。

- **⚠ この変異試験が測っていない範囲**:

  - **`packages/postgres` の歯A・歯B（`vector-search-provenance.test.ts`）には変異を
    当てていない。** この作業環境に PostgreSQL / `DATABASE_URL` が無いため、この2本は
    そもそも手元で走らない（CI が唯一の実行環境である）。**⟹ この2本が何かを噛むかは、
    まだ測られていない。**
  - **適合テスト（`vector-store-conformance.ts`）の歯3本は、`InMemoryVectorStore` に対する
    実行でしか撃っていない。** 同じ3本は CI で `PostgresVectorStore` に対しても走るが、
    **`PostgresVectorStore` 側の実装（`m.provenance_kind <> ALL($x::text[])` と、
    空配列のときに条件を出さない `length > 0` の番人）には変異を当てていない。**
  - **網羅的な変異試験ツール（stryker 等）は使っていない。**上の7本は手で選んだものであり、
    **「これ以外に生き残る変異が無い」ことは示していない。**
  - 上のどの測定も、**CI の4ジョブが緑であること**とは別の話である——変異試験は歯の質を
    測るものであり、実装の正しさを CI の代わりに保証するものではない。

- **これが覆るとしたら**:

  - `period` を段1で絞りたいという要求が実測で裏付けられたら（ADR 0023 の「これが
    覆るとしたら」節、上に逐語引用）、離散化バケット列の設計を別 ADR で起こす——
    本 ADR はこの条件を変えていない。
  - 歯Bの弱い不変（`Seq Scan on memories` にならない・条件が落ちない）が CI で
    実際に破れたら、それは「この不変も選択性に依存していた」という発見であり、
    さらに弱いアサーションへ書き直すか、`EXPLAIN` の実測結果をそのまま歯として
    固定する（ADR 0023 が `subject_id` について実際にそうしたのと同じ手順）。
  - 低選択性の除外条件がテナント規模で重くなることが実測されたら（引き受けた負債・
    確かめていないこと参照）、`hnsw.iterative_scan` の有効化・`provenance_kind` を
    埋め込みテーブル側へ複製する・規模に応じて段1の絞りを切り替える、といった手を
    ADR 0023 に倣って検討し直す。
