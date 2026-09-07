# ADR 0054: 擬似実装の `created` は挿入の決定そのものから出す——判定と挿入の間に `await` を挟まない

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「この器で実行して確かめた」と「受け取った前提」を混ぜない。

## ⚠ この ADR には書き手が2人いる

**実装（`resolveIdempotentCreate`・2つの擬似実装の書き換え・歯3本）を書いたのは、
器の入れ替えで消えた作業者である。**その作業は `wip: created flag from the insert decision
itself`（`4764a151`）という**1本のコミットとして押さえられただけ**で、
`docs/decisions/` には何も置かれていなかった。**押さえた者は、中身を書いた者でも
検証した者でもない。**

**受け取った前提（この器では確かめられない）**: 救出役の報告に
「**未コミットの1ハンクは変異と判定して捨てた**」と書かれていた。元の器はもう
入れ替わっているため、**捨てられたものが何だったかは復元できない。**
枝の1コミットと diff が、意図についての唯一の根拠である。

**「実測」と書いた箇所はすべて、この PR を仕上げた作業者がこの器で実行した結果である。**
コマンドと数字は PR 本文に残してある。**元の作業者が書いた説明のうち、実測が崩したものは
崩したと書く**（下記「実測で崩れた主張」）。

**番号について**: 枝はコードの docstring とテスト名で12箇所「ADR 0052」を名乗っていたが、
main の 0052 は
[`0052-compare-cassette-and-provenance-survival.md`](./0052-compare-cassette-and-provenance-survival.md)
（別の判断）に既に割り当たっていた。**0054 はマネージャーが予約して渡したものである**
（書く直前に最大番号を取り直していない——番号を動かすのはマネージャーのマージであり、
作業者からはその時点が見えない）。

---

## 前史: ADR 0012 が「検査できない」と書き残していた1行

[ADR 0012](./0012-ingest-pipeline-design.md) の D-ingest-1「結果」節が、擬似実装の
`created` の導き方をこう記録している（逐語）:

> `packages/postgres` の実装は `db.transaction()`（drizzle-orm の BEGIN/COMMIT）で
> この2つの INSERT を包む。in-memory 実装（testkit）は元々トランザクションを
> 模していないため、単に「サイズが変わったら created」で判定する
> （本物の同時実行安全性は検査できない——これは in-memory 実装の一般的な限界であり、
> 既存の `createMemory`/`createObservation` も同じ限界を持つ）。

**本 ADR は、この括弧の中を改める。**D-ingest-1 の決定そのもの
（`createXWithOutbox` というメソッドの形）は動かさない。改めるのは
**「検査できない」という判定**である。

**JavaScript の実行モデルでは、擬似実装の `created` は決定的に正しくできる。**
単一スレッドであり、**制御が他のタスクへ渡るのは `await` 境界だけ**だからである。
判定と挿入を1つの同期区間に閉じてしまえば、割り込む窓はゼロになる——
「模せない」のではなく、「模す必要がない」のだった。

## 到達経路（実測）

`created` を使っている本番の呼び出し元は `packages/core/src/runtime.ts` の2箇所である
（**出所: 読んだコード**）。

1. `observe()` — `if (!created) return { ..., extraction: "skipped" }`。
   **`created` を取り違えると、冪等な再送で抽出がもう一度走る**（LLM がもう一度叩かれる）。
2. `createMemoriesFromCandidates()` — `if (created) await deps.eventStore.append(..., kind: "created")`。
   **監査ログに `created` イベントが二重に載る。**

`main`（`7ae7b9b`）の擬似実装2つは、`created` を**大域の件数差**から導いていた:

```ts
const sizeBefore = this.observations.size;
const observation = await this.createObservation(ctx, input);   // ← await 境界
const created = this.observations.size > sizeBefore;
```

`await` は解決済みの promise でも制御を手放す。**その隙に別の行が作られると、
件数は増えているので `created` が `true` に化ける**——返っているのは既存の行なのに。
`Promise.all` で「同じ外部 id への再送」と「新しい外部 id の作成」を重ねると再現する。

**⚠ この壊れ方は本番では起きない。**`PostgresMemoryStore` は
`INSERT ... ON CONFLICT DO NOTHING RETURNING *` の**自分の文の戻り行数**から `created` を
得ており、判定と挿入がそもそも1文である。**壊れているのは擬似実装だけである。**
それでも直す理由は [ADR 0047](./0047-fake-referential-integrity-existence-only.md) /
[ADR 0049](./0049-reinforce-monotonicity-in-pseudo-implementations.md) と同じで、
**擬似実装が interface の契約から外れていると、その上で書いた歯は架空の世界を測る**からである
（契約の出典: `packages/core/src/interfaces/memory-store.ts` の
「冪等な再送（`externalId` が既存行と衝突）の場合は `created: false` を返し、
ジョブは一切作らない」、`docs/architecture.md` §3.5、ADR 0012 D-ingest-1）。

**再現の実測**: この壊れ方（= `main` のコード）を変異として撃ち戻すと、
新しく足した歯が赤くなる（M1〜M4。PR 本文に全数）。

## 決めたこと

1. **`packages/core/src/idempotent-create.ts` に `resolveIdempotentCreate` を置き、
   `index.ts` から公開する。**擬似実装が `created` を導く形をこれ1つに絞る。
2. **`insert` は同期関数でなければならない。**戻り値を `Promise` にしない——
   `await` を挟む余地を**型で**塞ぐためである。
3. **2つの擬似実装（`InMemoryMemoryStore`・`FakeMemoryStore`）の
   `createObservation` / `createMemory` / `createXWithOutbox` を、
   この関数を通す形に揃える。**`created` は `createXWithOutbox` が自分で計算せず、
   冪等な作成の結果として受け取る。
4. **`PostgresMemoryStore` はこの関数を使わない。**あちらは SQL 1文で同じ性質を持っており、
   使わせると「判定を JS 側へ持ち出す」という逆向きの劣化になる。
5. **`FakeMemoryStore` には専用の歯を置く**（`packages/core/src/__tests__/fake-idempotent-create.test.ts`）。
   `packages/testkit` の適合スイートは `packages/core` に依存する向きにしか置けないため、
   `packages/core` 側の Fake はスイートの対象外である（ADR 0049 と同じ形の穴）。

## 歯を3箇所に置いた

| 置いた場所 | 測る実装 | 本数 |
|---|---|---|
| `packages/testkit/src/memory-store-conformance.ts` | `InMemoryMemoryStore` と（CI では）`PostgresMemoryStore` | 4 |
| `packages/core/src/__tests__/fake-idempotent-create.test.ts` | `FakeMemoryStore` | 4 |
| `packages/core/src/__tests__/runtime.test.ts` | `runtime.observe` の**値**（`extraction` / `memoryIds` / LLM 呼び出し回数） | 1 |

歯は2種類ある。**この区別が本 ADR の中心である。**

- **「別の行の同時作成」**（枝が持ってきた形）: 大域の件数差から `created` を導く壊れ方を捕まえる。
- **「同じ冪等キーの同時作成」**（この PR で足した形）: **判定と挿入の間に `await` 境界を
  入れる**壊れ方を捕まえる。鍵が違えば事前の存在検査でも答えが合ってしまうため、
  前者では捕まらない。

## 実測で崩れた主張

**枝の docstring は「`await` を挟むと判定と挿入の間に他のタスクの同期区間が入りうる」を
不変条件として名指ししていたが、枝が持ってきた歯はその壊れ方を1本も測っていなかった。**
測っていたのは大域の件数差の壊れ方だけである（変異 M8b が生き残り、M9〜M11 が
どの歯にも当たらなかったことで判明した）。**説明と歯がずれていた**ので、
同じ冪等キーを同時に作る歯を4本足した。

**枝は `pnpm run typecheck` を通っていなかった。**`fake-idempotent-create.test.ts` の
`provenance` が `{ kind: "stated", observationId }` になっており、`StatedProvenance` が
要求する `sourceObservationId` / `at` を欠いていた。**vitest は型を落として走るため、
歯が全部緑のままこの誤りが残っていた**——門が互いに独立であることの実例である。

## 採らなかった案

- **10行の helper を2つの擬似実装に複製する**（core に何も足さない）: 公開 API を汚さない
  という点では最善。却下の理由は AGENTS.md の「複製した瞬間から、正文と要約はずれ始める」で、
  実際に ADR 0049 が**「割れていたのは3実装のうち2つ」**という形で同じ失敗を記録している。
  性質を持たせたいのは3実装であり、**綴りが2箇所に在ると片方だけ直る。**
- **helper を `packages/testkit` に置く**: 依存の向きが逆である
  （`testkit` → `core`）。`packages/core` の Fake が `testkit` を参照すると循環し、
  build 順が定義できない。**構造的に不可能。**
- **`@mnemora/core` のサブパス（`@mnemora/core/idempotent-create`）で出す**: `packages/core`
  の `package.json` は `exports` を持たず `main`/`types` だけなので、深い import は
  `dist` を指す。テストは `dist` ではなく `src` を見る配線
  （`packages/testkit/vitest.config.mts` の alias・`tsconfig.json` の paths）なので、
  **深い import はその配線を壊す。**
- **擬似実装に mutex を持たせる**: 「本物の並行性を模す」方向。`await` 境界しか
  割り込み点が無い世界で lock を導入するのは、**存在しない問題への対処**である。
- **件数をテナント別・冪等キー別に数え直す**: 数える対象を細くしても、`await` の後に
  数えている限り同じ窓が残る。**壊れているのは対象ではなく順序である。**
- **挿入後に読み直して `created` を決める**: 読み直しは `await` の後になるため、同じ窓。

## 引き受けた負債

- **`@mnemora/core` の公開 API に、本番が使わない部品が1つ増えた。**
  `resolveIdempotentCreate` の呼び出し元は擬似実装2つだけである。上の「採らなかった案」の
  とおり、**core の `index.ts` から出す以外に3実装へ渡す道が無い**（依存の向きと
  `exports` の形の両方から）。将来 `packages/testkit` が `packages/core` に依存しない形に
  なれば、置き場所を選び直せる。
- **型で塞いだのは `insert` の同期性だけである。**「既存を引く式」は helper の外に
  残っているので、**呼び出し側が lookup と helper 呼び出しの間に `await` を挟むことは
  型では止まらない**（変異 M9 がまさにそれ）。ここは歯で捕まえている。
- **適合スイートに同時実行の歯が4本入った。**これは CI の Postgres ジョブに対しても走る。
  同時実行の歯は本質的に、実装の内部スケジューリングに依存する形の assert になりやすい
  ——ここでは「どちらが作成側になるか」を固定せず、
  **「片方だけが `created`」という非対称そのもの**（`createdCount: 1`）を assert して
  依存を避けたが、**Postgres 側の実測はこの器では取れていない**（下記）。

## これが覆るとしたら

- **擬似実装が本当の並行実行（`worker_threads` 等）へ移ったとき。**「割り込み点は `await`
  境界だけ」という前提が崩れるので、同期区間の閉じ込めでは足りなくなる。
- **`packages/testkit` の依存の向きが変わったとき。**helper の置き場所を選び直せるようになり、
  公開 API から下げられる。
- **`created` を見る本番の呼び出し元が消えたとき。**いま2箇所（`runtime.ts`）で、
  どちらも「やり直さない」「二重に記録しない」の判断に使っている。ここが無くなれば、
  この性質を擬似実装に持たせる理由も薄くなる。

## 確かめていないこと

- **`PostgresMemoryStore` に対する適合スイート4本**（枝の2本 + この PR の2本）**は、
  この器では1度も走っていない。**この環境に Postgres も docker も無く、`DATABASE_URL` も
  無いためである。**測ったのは `InMemoryMemoryStore` に対してだけ**で、Postgres 側は
  CI の `postgres` ジョブが初めて測る。
- **救出時に捨てられた1ハンクが何だったか。**元の器は入れ替わっており、復元できない。
- **変異 M8b が「等価変異（意味が変わっていない）」であることの根拠は、JS の評価順序に
  ついての推論である**（`await f()` は `f()` を同期に呼び切ってから制御を手放すので、
  存在検査と挿入の間に割り込み点が無い）。**形式的に証明したわけではない。**
