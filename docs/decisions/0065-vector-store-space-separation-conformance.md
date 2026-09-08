# ADR 0065: `VectorStore` の space 分離を適合テストの歯にする — `FakeVectorStore` に丸ごと空いていた一段と、監査の漏れの記録

- **状態**: 採用 (2026-09)

- **文脈**:

  この節の「欠陥そのもの」「歯が0本だった」「監査の漏れ」は、いずれもこの PR の作業者が
  現物（コード・ADR 本文・git 履歴）で確認した。「実測」節の数字だけは先行する作業者による
  実測をそのまま引いており、その扱いは「引き受ける負債 / 確かめていないこと」に書き分けた。

  **欠陥そのもの**: `FakeVectorStore.search`（`packages/core/src/__tests__/runtime-fakes.ts`）は
  `space`（`EmbeddingSpaceId` — `provider`/`model`/`dimensions` の組）を受け取る第2引数を
  一度も参照せず（引数名も `_space` だった）、`this.entries` を丸ごと線形走査していた。
  一方 `key()` は `` `${space.provider}:${space.model}:${space.dimensions}:${tenantId}:${memoryId}` ``
  という space を含む prefix でエントリを格納しており、`upsert` はこの prefix を書き込みに
  使っている。**つまり書き込み側は space で仕切っていたのに、読み出し側（`search`）だけが
  それを見ていなかった。**`packages/testkit/src/__fixtures__/in-memory-vector-store.ts` の
  `InMemoryVectorStore.search` は同じ prefix（`` `${space.provider}:${space.model}:${space.dimensions}:` ``）
  でエントリを絞ってから走査しており、`FakeVectorStore` にはこの一段が丸ごと無かった。

  **実測**: 同一 tenant で space A・space B にそれぞれ1件ずつ vector を入れ、space A を
  指定して `search` すると、修正前の `FakeVectorStore` は**2件返す（A と B が混ざる）**。
  同じ操作を `InMemoryVectorStore` に対して行うと**1件だけ返る（A のみ）**。

  ⭐ **歯が0本だった**: `packages/testkit/src/vector-store-conformance.ts`（adapter 適合テスト）
  にも、`packages/core` 側の `FakeVectorStore` 専用テスト
  （`packages/core/src/__tests__/fake-vector-store-filter.test.ts`）にも、**2つの embedding
  space を同時に使うテストが本 PR 以前は1本も無かった。**適合テストが定義する `space`
  （`const space: EmbeddingSpaceId = { provider: "test", model: "fixture-model", dimensions: 3 }`）
  は全テストを通じて固定の1つだけで、2つ目の space を作る手段（フック）自体が
  存在しなかった。⟹ **「space 分離」という契約は、どの adapter に対しても検査する歯が
  0本だった。**`InMemoryVectorStore`（key prefix による絞り）と `PostgresVectorStore`
  （[ADR 0002](./0002-embedding-space-tables.md) の空間ごとのテーブル分割）は実際には
  space を分離できていたが、それを検査するものが無かった——**たまたま両方とも正しかった
  だけであり、リグレッションを検知できる歯は無かった。**

  🔴 **これは「決定」ではなく「監査の漏れ」だった**: [ADR 0034](./0034-vector-store-filter-conformance.md)
  は `VectorFilter` の各フィールド（`status`/`subjectId`/`decayFloorAtAfter`、その後
  [ADR 0056](./0056-exclude-provenance-kinds-in-ann-stage.md) で `excludeProvenanceKinds`、
  [ADR 0059](./0059-period-in-ann-stage.md) で `occurredAfter`/`occurredBefore`）を1つずつ
  監査し、`filter` の契約の歯を5本足した。しかも ADR 0034 の「引き受ける負債」節は
  **`FakeVectorStore` 自身の穴を名指しで書いている**——「`FakeVectorStore` は
  `status`/`decayFloorAtAfter` を `backing`（省略可）が渡されている場合だけ適用し、
  `subjectId` に至っては参照が一つも無い」と、`VectorFilter` の側の穴を一つずつ名指しで
  記録していた（これらは後に PR #36 で埋まった。**本 PR が直した `space` は、それとは
  別の穴である**）。**それだけ丁寧に `FakeVectorStore` の穴を監査していながら、`space` には
  ADR 0034 のどこにも一言も触れていない。**`search` のシグネチャに `space` 引数
  （当時から `_space`）自体は存在していたにもかかわらず、である。**この漏れの記録は
  ADR 0034 を書き換えて消さない**（ADR 0034 のファイルには本 PR で一切手を入れていない）。

  ⚠ **「意図的にこの歯を作らなかった」という決定は見つからなかった——ただし、これは
  「無かった」という断定ではなく、当たった範囲での結果である。**当たったのは
  `docs/decisions/` 配下の ADR 64本（`0001`〜`0064`、`README.md` の一覧表の件数と一致）、
  `packages/core/src/__tests__/runtime-fakes.ts` の変更履歴（`git log` で16コミット、
  うち `FakeVectorStore` に直接触れたものは ADR 0034/0040/0042/0047/0049 に対応する
  数コミット）、そして `git log --oneline` に PR 番号が付いた74件のコミットメッセージ
  （うち `space` を含むのはこの PR 自身、[ADR 0018](./0018-register-embedding-space-advisory-lock.md)
  の `registerEmbeddingSpace()`、npm publish 整備の3件のみで、いずれも「2つ目の space を
  意図的にテストしない」という趣旨の記述ではない）。この範囲のどこにも、space 分離を
  意図的に検査対象から外したという記録は見つからなかった。

  ⚠ **ただし、欠陥そのものが誰にも気付かれていなかったわけではない。**直前の PR #73
  （`2fe96e2`、`main` の HEAD）は、その本文の「範囲外として手を付けなかったもの」に
  **「`FakeVectorStore.search` が `_space` 引数を無視する件（別途調査中、指示により
  不変更）」**と逐語で書き残している（`git log -1 --format=%B 2fe96e2` で確認）。⟹
  **その時点で欠陥は既に見えており、その PR の範囲から意図的に外されていた。**これは
  「あの PR ではやらない」という範囲の決定であって、**「この契約に歯は要らない」という
  決定ではない**——本 ADR が「監査の漏れ」と呼んでいるのは後者のほうであり、この記録は
  それを否定しない。

  ⚠ **弱い反対証拠もある——これは今は通っていない欠陥である**: [ADR 0002](./0002-embedding-space-tables.md)
  は「**Phase 1 は稼働中の空間を1つに限る。**2つ目の空間を追加するときは、既存行の移行
  ではなく『テーブルを追加する』形で済むようにしておく」と明記している（現物で確認済み、
  逐語）。実際、`packages/core/src/runtime.ts:547` の `upsert` 呼び出し
  （`deps.vectorStore.upsert(ctx, deps.embeddingProvider.space, memory.id, vector)`）と
  `packages/core/src/recall-runtime.ts:253` の `search` 呼び出し
  （`deps.vectorStore.search(ctx, deps.embeddingProvider.space, queryVector, ...)`）は、
  **同じ `deps.embeddingProvider.space` を渡している**（本 ADR の作業者が両ファイルとも
  現物で確認した。`recall-runtime.ts` は読んだだけで一切変更していない）。⟹ **本番相当の
  経路では、常に同じ space で upsert と search が行われるため、この欠陥は今は通らない。**
  現に壊れている現象は無い——だから本 PR は緊急のバグ修正ではなく、先回りの契約整備である。

  **いつ牙を剥くか**: `docs/roadmap.md` §4「技術上のリスク」の表、「埋め込みモデル移行の
  コスト（全件再 embed）」の行は「新しい embedding モデルを使いたくなる、または既存モデルが
  非推奨化される」を兆候とし、対処を「埋め込み空間ごとにテーブルを分ける設計
  （`memory_embeddings_<space>`）を維持する。**移行は新しい空間の追加であって、既存空間の
  置換ではない**」と書いている（現物で確認済み、逐語）。**この「新しい空間を追加する」が
  実際に起きた瞬間、2つの space が同時に稼働する**——ADR 0002 が「Phase 1 は空間を1つに
  限る」として先送りした前提がそこで崩れる。その前提が本番の upsert/search 経路
  （`deps.embeddingProvider.space` の単一性）にも埋め込まれているため、**前提が変わった
  瞬間に、`FakeVectorStore` を使うテストは実装の嘘（space を無視しても緑になる）を
  抱えたまま走り続けることになる。**それを避けるため、前提が崩れる前のいま、歯にする。

- **決定**:

  1. **`FakeVectorStore.search` を `InMemoryVectorStore` と同じ意味論に揃える。** 引数名を
     `_space` から `space` に戻し、`` `${space.provider}:${space.model}:${space.dimensions}:` ``
     という prefix でエントリを絞ってから走査する（`upsert`/`key()` が既に使っている
     prefix と同じもの）。

  2. **`vector-store-conformance.ts`（`VectorStoreConformanceOptions`）に
     `prepareEmbeddingSpace: (space: EmbeddingSpaceId) => Promise<void> | void` フックを
     足す。**`prepareMemoryId` と同じく**省略可（optional）にしない**。理由も
     `prepareMemoryId` と同じ——省略できると「2つ目の space を実際に使える adapter」と
     「使えない adapter」が同じ緑色の出力になる。ADR 0034 が `prepareMemoryId` を必須に
     した際に立てた基準（「検査できる adapter とできない adapter が同じ緑になることを
     許さない」）を、新しいフックでもそのまま繰り返す。

  3. **`vector-store-conformance.ts` に「space が違う vector は同一 tenant の search でも
     混同されない」歯を1本足す。**フィクスチャは**非対称**にした——space A に2件、
     space B に1件、ベクトルも別。件数が対称だと、取り違えが起きても件数だけ見れば
     一致してしまうため、意図的に非対称にした。加えて、「B の search に A が出ない」
     （変わらない側）だけでなく「B で検索したら B 自身が返る」（変わる側）も同じ歯に
     入れた——そうしないと、`search` が常に空配列を返す実装でも「A が混ざらない」を
     満たしてしまい緑になる（[ADR 0040](./0040-zero-vector-never-returned.md) が
     ゼロベクトルの歯で採った「変わる/変わらないの両方を1本の歯で固定する」形と同じ理由）。
     2つ目の space（`spaceB`）は `provider`/`dimensions` を既定の `space` と揃え、
     **`model` だけを変えた**（`fixture-model` → `fixture-model-b`）。

  4. **呼び出し側2箇所に `prepareEmbeddingSpace` を実装する。**
     - `packages/testkit/src/__tests__/in-memory-fixtures.conformance.test.ts`:
       `InMemoryVectorStore` はテーブルを持たず、`search` 時点の key prefix 一致だけで
       絞るため、未知の space をそのまま `upsert`/`search` に渡しても動く。**no-op**
       （`prepareEmbeddingSpace: () => {}`）で足りる。
     - `packages/postgres/src/__tests__/conformance.postgres.test.ts`:
       `PostgresVectorStore` は `memory_embeddings_<space>` テーブルが
       `registerEmbeddingSpace`（[ADR 0018](./0018-register-embedding-space-advisory-lock.md)
       の advisory lock 付き実装）で事前に作られている前提で動くため、
       `prepareEmbeddingSpace: async (space) => { const { pool } = await getTestClient();
       await registerEmbeddingSpace(pool, space); }` を渡す。`registerEmbeddingSpace` は
       `CREATE TABLE IF NOT EXISTS`/`CREATE INDEX IF NOT EXISTS`（advisory lock で排他）で
       べき等なので、`it()` ごとに呼んでも問題ない。

  5. **`packages/core` には `packages/testkit` の適合テストが届かない。**
     `dependency-boundary.test.ts`（`packages/core/src/__tests__/dependency-boundary.test.ts`）が
     `packages/core/package.json` の `dependencies` が `["zod"]` のみであることを機械的に
     検査しており、`@mnemora/testkit` を実行時依存にできない
     （`docs/architecture.md` §3.6、`FakeVectorStore` のクラス doc にも同旨の記述）。
     ⟹ 同じ形の歯を `packages/core/src/__tests__/fake-vector-store-filter.test.ts` にも
     個別に置いた（`FakeVectorStore` に対する非対称フィクスチャ・「変わる/変わらない」を
     同じ理由で踏襲）。

- **採らなかった案**:

  - **(a) `FakeVectorStore` を直さず、「擬似物だから」と負債として引き受ける。** 却下。
    ADR 0034 が同じ判断をすでに一度行っている——`FakeVectorStore` の `subjectId` 無視・
    `status`/`decayFloorAtAfter` の条件付き適用を「本 ADR の範囲外」として先送りし、
    それが今回 `subjectId`/`status` は #36（ADR 0034 の core 側適用）で埋まったが、`space`
    は埋まらないまま残っていた。同じ先送りを `space` についてもう一度行うと、
    「歯が0本の契約」がさらに1つ積み上がる。`FakeVectorStore` は `packages/core` 自身の
    runtime テストが使う頻度の高い fake であり、放置する理由が薄い。

  - **(b) `prepareEmbeddingSpace` を省略可（optional）にする。** 却下。ADR 0034 が
    `prepareMemoryId` について下した判断と同じ理由——省略できると「2つ目の space を検査
    できる adapter」と「できない adapter」が同じ緑になり、このリポジトリが
    ADR 0011/0025/0027/0028/0034 で繰り返し破ってきた「名乗れる以上の精度を主張する」族の
    失敗を、新しいフックの省略という形で再現することになる。

  - **(c) 適合テストではなく `packages/postgres` 側だけに歯を置く。** 却下。
    `InMemoryVectorStore` にも同じ契約（space で分離する）があり、`packages/testkit` の
    適合テストは「どの adapter に対しても同じ歯が走る」ことが値打ちである
    （ADR 0034 の芯と同じ）。postgres 側だけに置くと、`InMemoryVectorStore` が
    リグレッションしても検知できない。加えて `packages/core` は `packages/testkit` に
    依存できないため、`FakeVectorStore` への回帰はどのみち別経路
    （`fake-vector-store-filter.test.ts`）で塞ぐ必要があり、postgres 側限定にする利点が無い。

  - **(d) 2つ目の space で `dimensions` も変える。** 却下（`model` だけを変えた）。
    `provider`/`dimensions` を揃えたまま `model` だけ変えることで、「space の同一性は
    3フィールドの組全体で決まり、次元が同じでも `model` が違えば別空間として扱われる」
    ことを歯自身が確認できる。`dimensions` まで変えると、ベクトルの長さも変える必要が
    生まれ、フィクスチャが複雑になるうえ、「`dimensions` が違うから分かれて当然」という
    弱い検査になりかねない——`model` だけを変える方が、prefix 生成
    （`embeddingSpaceTableName`／`InMemoryVectorStore.key`／`FakeVectorStore.key`）が
    本当に3フィールドの組から機械的に決まっていることを、より厳密に確認できる。

- **引き受ける負債 / 確かめていないこと**:

  - **`packages/postgres` に対する新しい歯（`prepareEmbeddingSpace` 経由で2つ目の space の
    テーブルを実際に作り、`PostgresVectorStore` が本当に分離することを検査する歯）は、
    この作業環境では1度も走っていない。**この環境に `DATABASE_URL` が無いため
    （`echo $DATABASE_URL` は空）、`packages/postgres` のテストはそもそも実行できない
    ——**CI の `packages/postgres` ジョブでのみ実行されている。**確認できたのは
    `tsc` の型検査が通ることと、`InMemoryVectorStore`/`FakeVectorStore` 側で同じ歯が
    通ることのみ。**本 ADR を足す一つ前のコミット（`0ca74ce`）に対する CI では、
    `packages/postgres`（本物の Postgres + pgvector）を含む4ジョブすべてが pass して
    いることを `gh pr checks 75` で直接確認した**——ただし、この歯が「2つ目の space の
    テーブルを実際に作って分離を検査した」ことまでを CI の出力から個別に読んだわけでは
    なく、ジョブ単位の pass を見たに留まる。
    同じ体裁の記録は [ADR 0032](./0032-outbox-claim-lease.md)・
    [ADR 0042](./0042-event-store-list-order-and-limit.md)・
    [ADR 0054](./0054-idempotent-create-from-the-insert-decision.md) にもある。

  - **「space 分離」は `provider`/`model`/`dimensions` の3つ組の一致でしか見ていない。**
    意味的な互換性（たとえば同じ `provider`/`dimensions` で `model` だけが違う2つの
    embedding が、実際にはどれくらい近い意味空間を持つか）は一切見ていない。この ADR が
    固定したのは「文字列として区別された space が、実装として混ざらないこと」だけである。

  - **「実測」節の数字そのもの（A/B に1件ずつ入れて A を引くと FVS は2件・IMS は1件）は
    前任の作業者による実測であり、この PR ではその形のままでは再現していない。**ただし
    **同値の現象は変異試験で再現した**——修正後の `FakeVectorStore.search` から space の
    prefix 絞りの1行（`if (!key.startsWith(prefix)) continue;`）だけを外すと、これは修正前の
    `search` と同じ状態になる。この状態で本 ADR が足した歯を走らせると、space A に2件・
    space B に1件という非対称フィクスチャに対して `idsA` が **3件**
    （`[ mem-12, mem-13, mem-14 ]`——B の1件が混入）になり、歯が赤くなる
    （`@mnemora/core` の306件中1件が失敗、305件は緑）。**混ざることは、この PR の作業者が
    自分で実行して確かめた。**

  - **「意図的な決定は見つからなかった」の範囲は上記「文脈」に明記した3つ
    （ADR 64本・`runtime-fakes.ts` の変更履歴・PR 番号付きコミット74件）に限られる。**
    それ以外の場所（たとえば Slack のようなこのリポジトリ外のやり取り、あるいは
    このリポジトリの git 履歴に載っていない議論）は確認していない。

- **これが覆るとしたら**:

  - `docs/roadmap.md` §4 が指す「埋め込みモデル移行」が実際に着手され、2つ目の
    embedding space が本番の `deps.embeddingProvider.space` 経路にも登場するようになったら
    （つまり ADR 0002 の「Phase 1 は空間を1つに限る」という前提が崩れたら）、本 ADR が
    足した歯は「先回りの契約整備」から「本番の正しさを直接守る歯」に格上げされる
    ——歯自体の形は変えずに済むはずである。
  - `VectorFilter` に `period` と同様の新しいフィールドが増えたときと同じで、この歯
    （`prepareEmbeddingSpace` フックと非対称フィクスチャ）の形は、3つ目以降の space を
    使う検査にもそのまま拡張できるはずである。
