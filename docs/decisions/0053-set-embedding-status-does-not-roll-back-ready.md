# ADR 0053: `setEmbeddingStatus` は `ready` を `failed` へ巻き戻さない——禁じるのは1本だけ

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-07

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「受け取った前提」を混ぜない。

## ⚠ この ADR には書き手が2人いる

**「前史」「到達経路」「決めたこと」「採らなかった案」を書いたのは、器の入れ替えで消えた
作業者である。**その作業ツリーは未コミットのまま失われかけ、別のマネージャーが
`git add -A` で救出コミットとして押さえた（押さえた者は、中身を書いた者でも検証した者でも
ない）。**その時点で門は1つも通っておらず、変異も撃たれていなかった。**

**「歯を3箇所に置いた」「変異」「実測で崩れた主張」「確かめていないこと」を書いたのは、
この PR を仕上げた別の作業者である。**以降、**「実測」と明記した箇所はすべて後者が
この器で実行した結果**であり、コマンドと数字は PR 本文に残してある。
**前者の主張のうち後者の実測が崩したものは、崩したと書く**（下記「実測で崩れた主張」）。

---

## 前史: ADR 0048 が「特定できていない」と書き残した項目

[ADR 0048](./0048-reinforce-does-not-move-decay-origin-backwards.md) は
「読んでから書く」箇所を数えた台帳の中で、`setEmbeddingStatus` を
**「成立するが、到達する壊れ方を特定できていない」**と判定し、負債として残した
（「**『無い』ではなく『特定できていない』である。**」）。

**本 ADR は、その1件について到達経路を特定し、塞ぐ。**

## 到達経路

**出所: 私が読んだコード**（`packages/core/src/runtime.ts` の `processEmbedJob`、
`packages/postgres/src/memory-store.ts` の `aggregateScope`、
`docs/decisions/0032-outbox-claim-lease.md`）。**この器で実際に走らせて再現したものではない**
（下記「確かめていないこと」）。

1. `failed` を書く**唯一の**呼び出し口は `runtime.ts` の
   `catch (err) { await setEmbeddingStatus(ctx, memory.id, "failed"); throw err; }` である。
2. `ready` は `vectorStore.upsert` が**返った後**にしか書かれない。すなわち
   `embedding_status = 'ready'` は「**ベクトル行が在る**」という主張である。
3. outbox の処理は at-least-once であり（ADR 0032 が明記）、リースを失った古いワーカーも
   同じ Memory の `catch` に到達しうる。⟹ **`ready` が書かれた後に `failed` が届く順序が
   存在する。**
4. **ベクトル行を消す経路は今日のコードに無い**（`VectorStore` に削除の口が無い）。
   ⟹ いちど真になった「在る」は真のまま。
5. その結果、**ベクトル行が在るのに `memories.embedding_status = 'failed'` になる。**
   `aggregateScope` はこの行を `not_indexed_failed` に数え、`recall` は
   `notIndexed.failed` として返す ⟹ **利用者に「埋め込みを疑え」と出す。**
   疑うべき対象が実際には健全である、という誤った説明が出る。

**逆向き（`failed` → `ready`）は正しい。** B が後から成功した場合であり、
反映されなければならない。⟹ **規則は片側だけである。**

## 決めたこと

**現在の `embedding_status` が `ready` のときに `failed` を書く呼び出しは no-op とする。**
それ以外の遷移は今日どおり無条件。

- **例外にはしない。**唯一の呼び出し口が上記 `catch` の中であり、ここで投げると
  **元の埋め込みエラー `err` が握り潰されて別の例外にすり替わる。**呼び出し側の次の一手も
  無い（ADR 0048 が `reinforce` の古い `at` を例外にしなかったのと同じ理由の形。
  判定基準は [ADR 0008](./0008-absence-taxonomy.md) の「呼び出し側の次の一手が変わるか」）。
- **返すのは、更新されなかった現在の行そのもの。**`updatedAt` も動かない
  （「べき等」を「同じ値になる」ではなく**「行を触らない」**の意味で固定する）。

### 比較をどこに置くか

**Postgres 側は比較を SQL の1文の `WHERE` に置く**（ADR 0048 と同じ理由——アプリ側で
現在値を読んで比べてから書くと、読みと書きの間に入った別の書き込みを上書きしうる）。
条件片の組み立ては [ADR 0030](./0030-update-status-compare-and-swap.md) の
compare-and-swap と同じ形にする:

```sql
WITH updated AS (
  UPDATE memories
  SET embedding_status = ${status}, updated_at = now()
  WHERE tenant_id = ${tenantId} AND id = ${id}
    AND embedding_status <> 'ready'   -- status が 'failed' のときだけ付く条件片
  RETURNING *
)
SELECT * FROM updated
UNION ALL
SELECT * FROM memories
WHERE tenant_id = ${tenantId} AND id = ${id} AND NOT EXISTS (SELECT 1 FROM updated)
```

**書こうとしている値（引数 `status`）は*読んだ状態*ではないので JS 側で見てよい。**
`WHERE` に入れなければならないのは*読んだ状態*のほう（現在の `embedding_status`）だけである。

**更新できなかったときに返す行も、同じ1文の中で読む。**別の `SELECT` に分けると、
「上で読んだ古い値をそのまま返す」実装との差が**外から観測できない枝**になる
（ADR 0048 の `reinforce` で同じ形を採ったのと同じ理由）。

**⚠ 実測: この選択は適合テストの歯では測れない。**1文を「`UPDATE ... RETURNING *` →
0 行なら別の `SELECT` で読み直す」の2文へ割る変異を撃つと、`packages/postgres` の
`test:db` 182 件は**1件も赤くならなかった**（変異 Mu5a が生存。下記「変異」）。
⟹ **この形を採る根拠は歯ではなく並行性の議論であり、「歯で守られている」と書いては
ならない。**歯が捕まえるのは*返り値を繕う*ほうだけである（Mu5b は死亡）。
**その並行性の差が実在すること・それでも外から窓を狙う口が無いことは、
「引き受けた負債」で実測した。**

**⚠ さらに、`reinforce` から借りた理由づけはそのままでは当たらない。**`reinforce` は
本体の手前で `SELECT` を打って現在行を読む（`decayFloorAt` の計算に要る）が、
**`setEmbeddingStatus` には手前の `SELECT` が無い**（存在検査は `isUuidLike` だけ）。
⟹ 「上で読んだ古い値をそのまま返す」実装は、今日のコードからは書けない。
上の理由づけは**形の予防**であって、今日この関数に在る枝についての観測ではない。

擬似物（`InMemoryMemoryStore`・`FakeMemoryStore`）は共有述語
`isEmbeddingStatusRollback`（`packages/core/src/interfaces/memory-store.ts`）を呼ぶ。
`assertValidEventRetentionDays`（[ADR 0050](./0050-tenant-event-retention.md)）と同じ形で、
**禁じる遷移を1箇所に固定する。**

## 歯を3箇所に置いた

**⚠ 救出コミットの時点では2箇所しか無く、3箇所目が欠けていた**（実測で見つけた。下記
「実測で崩れた主張」）。

1. **`packages/testkit/src/memory-store-conformance.ts`** に2本。適合スイートは
   `InMemoryMemoryStore` と `PostgresMemoryStore` の**両方**に走るので、この2本で
   実装2つ分を押さえる（`packages/testkit` で 141 → 143 件、`packages/postgres` の
   `test:db` で 180 → 182 件）。
2. **`packages/core/src/__tests__/fake-set-embedding-status-no-rollback.test.ts` を新設した。**
   `FakeMemoryStore`（`packages/core` 自身の runtime テスト用フェイク）は
   **適合スイートの対象外**である——対象は `InMemory*` と `Postgres*` であり、
   `packages/core` 専用の `Fake*` には届かない。
   [ADR 0049](./0049-reinforce-monotonicity-in-pseudo-implementations.md) が
   `reinforce` について同じ穴を `fake-reinforce-monotonicity.test.ts` で埋めたのと
   同じ理由・同じ形（`packages/core` で 288 → 291 件）。

## 実測で崩れた主張

**⚠ 以下は、この ADR の前半（消えた器の作業者が書いた部分）および PR の下読みで
「良い」と判定された点のうち、実測が崩したものである。**

| 崩れた主張 | 実測 | どうしたか |
|---|---|---|
| **「擬似物側は、適合スイートの歯がこの器で実際に緑になることを確かめた」**（元の「確かめていないこと」節） | **`FakeMemoryStore` は適合スイートの対象外であり、この主張は `InMemoryMemoryStore` にしか当たらない。**ガードを丸ごと外す変異を撃つと `packages/core` の 288 件は**1件も赤くならなかった**（Mu-F0 が生存） | 3箇所目の歯を新設した（上記）。再撃（Mu-F0'）で死亡を確認 |
| **歯の中の「前提: `ready` への遷移は実際に効いている」の行が、「実装が丸ごと壊れて何も書かなくなっても緑のままになる」のを防いでいる** | **この行を消しても、同じ変異（実装を丸ごと no-op に差し替え）で歯は赤くなった**（Mu4a と Mu4b が同じ4件を赤にした）。歯の本題のアサーション `expect(rolledBack.embeddingStatus).toBe("ready")` は*正の*等値比較なので、それだけで捕まる | 行は残した（赤くなる位置を局所化する価値は在る）が、**コメントの自己申告を実測に合わせて書き直した**——「捕獲力を増やしていない」と明記 |
| **返り値をプリミティブへ写すのは「in-memory が `Map` の行オブジェクトの参照を返す」から** | **正しいが、効く境目は「行を持ち回るかどうか」である。**`readied.updatedAt`（Date オブジェクト）を保持する形に変えても変異は死亡した（Mu6'）——実装は `updatedAt` に**新しい `Date` を代入**するので、古い Date の参照は古い値のまま。**行そのもの（`readied`）を保持する形に変えると変異が生き残った**（Mu6''） | コメントに「＝行そのもの」と、Mu6'' の実測を追記 |
| **1文（`UNION ALL` + `NOT EXISTS`）を採る根拠は「別の `SELECT` に分けると外から観測できない枝になる」から** | **2文へ割る変異（Mu5a）は 182 件すべて緑で生き残った。**⟹ 主張は正しいが、**それは「歯がこの選択を守っていない」ことと同義**である。さらに `setEmbeddingStatus` には手前の `SELECT` が無いので、`reinforce` の理由づけはそのままでは当たらない | 「比較をどこに置くか」に実測と限界を追記 |
| **元の ADR 番号 0051** | `main` に `0051-recorded-provider-cassette.md` と `0052-compare-cassette-and-provenance-survival.md` が既に在り、**衝突していた** | オーナーが予約した **0053** へ、ファイル名・索引・本文の自己言及・コード中の `ADR 0051` の出現すべてを直した |

## 採らなかった案

| 案 | 採らない理由 |
|---|---|
| **巻き戻しで例外を投げる** | 唯一の呼び出し口が `runtime.ts` の `catch` の中であり、**元の埋め込みエラー `err` を握り潰して別の例外にすり替える。**呼び出し側の次の一手も無い |
| **`updateStatus` と同じ `expectedStatus` 引数を足す**（ADR 0030 の形） | 呼び出し口は `runtime.ts` の2箇所しかなく、**そこが読んだ値は `processEmbedJob` 冒頭の `get()` 由来である**——リース切れの古いワーカーでは*その読みも同じく古い*。⟹ 引数に載せても解決しない。かつ `MemoryStore` interface の破壊的変更になる |
| **遷移表を全面的に固定する**（`pending`/`ready`/`failed`/`skipped` の全遷移に意味を与える） | `skipped` を含む全遷移の意味を今日決める根拠が無い。[ADR 0024](./0024-remove-exact-counts-option.md)「実装の無いものを『予約』と書き残さない」に反する。**禁じるのは、到達経路を特定できた1本だけ** |

## 変異（実測。実装ごとに分けて記録）

**基準線**（`main` = `b60cf49` を手元で実測）: `typecheck` / `lint` / `format:check` /
`test`（DB 込み）すべて緑。件数は root 7 / core 288 / testkit 141 /
openai 18 passed・2 skipped / **postgres `test:db` 180** / example-chat `test:db` 83。
**DB は本物の Postgres 18 + pgvector 0.8.6 を手元に立てて接続した**（下記
「確かめていないこと」に、その Postgres の出自を書いた）。

**段0（変異が木に載ったか）は毎回 `git diff --numstat` で確認した。**
**段4**: 下表の赤はすべて `AssertionError: expected ... to be ...` であり、
`TypeError`・SQL エラー・フレームワークのガードによる赤は1件も無い。

### 擬似物: `FakeMemoryStore`（`packages/core`、基準線 288 → 291 件）

| # | 変異 | 走った件数 | どの歯が赤くなったか | 結果 |
|---|---|---|---|---|
| **Mu-F0** | ガード（`if (isEmbeddingStatusRollback(...)) return memory`）を丸ごと削除。**歯を新設する前** | 288（基準線どおり） | **0件** | **⚠ 生存**（穴の証明） |
| **Mu-F0'** | 同じ変異。**歯を新設した後** | 291 | 1件（新設の歯1本目**のみ**） | 死亡 |
| Mu1 | 共有述語の `from`/`to` を入れ替える（判定を反転） | 291 | 2件（新設の歯2本。既存の歯は緑） | 死亡 |
| Mu3a | 共有述語を両側（対称）にする＝`failed → ready` も禁じる | 291 | **1件だけ**（新設の歯**2本目**のみ。1本目は緑） | 死亡・**固有に捕獲** |
| Mu4a | `setEmbeddingStatus` を丸ごと no-op に差し替える | 291 | 4件（新設2本＋`runtime.test.ts` の既存2本） | 死亡 |
| Mu4b | Mu4a ＋ **歯から「前提: … 実際に効いている」の行を削除** | 291 | **Mu4a と同じ4件** | 死亡。⟹ 前提の行は捕獲力を足していない |

### 擬似物: `InMemoryMemoryStore`（`packages/testkit`、基準線 141 → 143 件）

| # | 変異 | 走った件数 | どの歯が赤くなったか | 結果 |
|---|---|---|---|---|
| Mu-IM | ガードを丸ごと削除 | 143 | 1件（新設の歯1本目） | 死亡 |
| Mu1 | 共有述語の判定を反転 | 143 | 2件（新設の歯2本） | 死亡 |
| Mu3a | 共有述語を両側にする | 143 | **1件だけ**（新設の歯2本目） | 死亡・**固有に捕獲** |
| Mu4a | 丸ごと no-op | 143 | 4件（新設2本＋既存の `setEmbeddingStatus` 遷移の歯2本） | 死亡 |
| Mu4b | Mu4a ＋ 前提の行を削除 | 143 | **Mu4a と同じ4件** | 死亡 |
| Mu6 | ガードは効かせるが `updatedAt` だけは触る（「行を触らない」への精密な変異） | 143 | 1件（新設の歯1本目の `updatedAt` アサーション） | 死亡 |
| Mu6' | Mu6 ＋ 歯が `readied.updatedAt`（**Date オブジェクト**）を保持する形へ | 143 | 1件（同じ） | 死亡（実装は新しい `Date` を*代入*するため） |
| **Mu6''** | Mu6 ＋ 歯が `readied`（**行オブジェクト**）を保持する形へ | 143 | **0件** | **⚠ 生存** ⟹ プリミティブへの写し取りは効いている |
| **Mu7** | Mu6 ＋ 歯から `await new Promise((r) => setTimeout(r, 5))` を削除 | 143 | **0件** | **⚠ 生存** ⟹ 時間を進める行は効いている |

### `PostgresMemoryStore`（`packages/postgres` `test:db`、基準線 180 → 182 件）

**⚠ 撃てた。**この PR の器では本物の Postgres 18 + pgvector 0.8.6 に接続できた
（ADR を書いた器では撃てず、「CI の `postgres` job でしか確かめられない」と書かれていた）。

| # | 変異 | 走った件数 | どの歯が赤くなったか | 結果 |
|---|---|---|---|---|
| Mu2 | `rollbackGuard` を*空の* `sql` テンプレートに固定（条件片を無効化） | 182 | 1件（歯1本目） | 死亡 |
| Mu3b | `rollbackGuard` を両側にする（`failed → ready` も禁じる） | 182 | **1件だけ**（歯**2本目**） | 死亡・**固有に捕獲** |
| **Mu5a** | 1文を2文へ割る（`UPDATE ... RETURNING *` → 0 行なら別の `SELECT`） | 182 | **0件** | **⚠ 生存**（「比較をどこに置くか」参照） |
| Mu5b | 返り値だけを繕う（`{ ...row, embeddingStatus: status }`） | 182 | 1件（歯1本目） | 死亡 |

**⚠ 述語 `isEmbeddingStatusRollback` への変異（Mu1・Mu3a）は Postgres 側に届かない**
——Postgres は述語を呼ばず、値だけを取って比較を SQL に書くため。これは
「引き受けた負債」の二重化そのものであり、**押さえは Mu2・Mu3b が Postgres 側で
別に死亡していることでしか得られない。**

### 撃てなかったもの

- **`examples/chat` の `test:db`（83 件）にはこの経路の歯が無い。**この PR は
  `examples/chat` を触っていないので変異も撃っていない。
- **並行性そのもの（リースを失った古いワーカーが後から `failed` を書く順序）は
  再現していない。**歯が測るのは「`ready` の行へ `failed` を書いても巻き戻らない」
  という*単一プロセスの*性質だけである。⟹ 到達経路（下記「到達経路」）は
  依然としてコードと ADR 0032 の逐語から導いたものであり、走らせて再現したものではない。

## 引き受けた負債

- **SQL 側は共有述語を呼べず、比較の形が2箇所に書かれる。**値（`from`/`to`）だけを
  `EMBEDDING_STATUS_ROLLBACK` から共有し、比較そのものは SQL に再度書かれる。
  ⟹ **押さえは適合テストの歯だけである**（歯が両実装に走る）。歯を消せば二重化は野放しになる。
- **`OutboxStore.complete`/`fail` のフェンシングは、この ADR では塞がない。**
  同じ「リース切れの古いワーカー」から到達する**別の穴**であり、
  `outbox.completed_at` と `failed_at` が同じ行に両方 non-null で残りうる。
  ADR 0032 自身が「`complete`/`fail` の CAS 化は本 PR の範囲外」と自認している。
- **1文（`UNION ALL` + `NOT EXISTS`）を採ったことは、歯では守られていない。**
  2文へ割る変異（Mu5a）は 182 件すべて緑で生き残った。⟹ **この形は、後から
  「2文のほうが読みやすい」で戻されても門は気付かない。**根拠は ADR 本文
  （「比較をどこに置くか」）にしか無い。
  **⚠ これは「歯を置かないと決めた」のではなく「歯が抜けている」。塞いでよい。**
  ただし**今の口では置けない**（実測。本物の Postgres 18.4 で3本測った）:

  | 測ったこと | 結果 |
  |---|---|
  | ガードで弾かれる `UPDATE` は行ロックを取るか | **取らない。**他の接続が未コミットで同じ行のロックを保持していても、0 行で **2ms** で返る |
  | 2文のあいだに窓を*人工的に*開けたら差が出るか | **出る。**2文の側は他の接続のコミット後の行（新しいスナップショット）を返す |
  | コミットが文の開始*前*に landing した場合 | 1文も同じ新しい行を返す ⟹ 差は「コミットが文境界のどちら側か」だけ |

  ⟹ **差は在る。しかしその窓を外から狙う口が無い**——弾かれる `UPDATE` がブロックしない
  ので他の接続からこの実装を止められず、窓は sub-millisecond である。
  **塞ぐには、この実装の中に待ちを差し込める口（テスト用のフック）が要る。**
  ⚠ そして仮に置けても、**「返す行はどちらのスナップショットの版か」を決めるのは
  この ADR がしていない新しい判断である**（ADR 0024「実装の無いものを予約と書き残さない」）。
- **`ready → pending` の巻き戻しについては決めない。**再埋め込みの経路ができたときに要る
  判断だが、今日そもそも `pending` を書く呼び出し口が（作成時以外に）無い。
  「実装の無いものを予約と書き残さない」（ADR 0024）。

## これが覆るとしたら

- **ベクトル行を削除する経路ができたとき。**`ready` は「ベクトル行が在る」の主張として
  勝っている。削除できるようになると **`ready` は主張でなくなり、この非対称の根拠が消える。**
- **再埋め込みで `embedding_status` を `pending` へ戻す経路ができたとき。**
  そのとき「巻き戻し」の定義そのものを引き直す必要がある（`ready → pending` を
  許すのか、別の名前の操作にするのか）。

## 確かめていないこと

**⚠ 出所を2つに分ける。**

### ADR を書いた器（消えた作業ツリー）が確かめていなかったこと

- **その器には Postgres も pgvector も無かった**（`docker`・`psql`・コンパイラのいずれも
  不在）。⟹ **`PostgresMemoryStore` 側の実測は行われていなかった。**
- **⚠ 門も1つも通っていなかった**（`test`・`typecheck`・`lint` のいずれも未実行）。
- **⚠ 「擬似物側は適合スイートの歯が緑になることを確かめた」は `FakeMemoryStore` には
  当たらなかった**（上記「実測で崩れた主張」）。

### この PR を仕上げた器が実測したこと・していないこと

**実測した:**

- `typecheck` / `lint` / `format:check` / `test`（DB 込み）を最終 head に対して通した。
- **本物の Postgres 18 + pgvector 0.8.6 に対して `packages/postgres` の `test:db` を
  走らせ、上記の SQL が意図どおり 0 行更新と読み戻しに分岐することを、変異
  Mu2・Mu3b・Mu5b の死亡として確認した。**
- 擬似物3実装すべてに歯が届いていることを、Mu-F0'・Mu-IM の死亡として確認した。

**していない:**

- **⚠ この器の Postgres は、埋め込み配布物（`embedded-postgres` 18.4-beta）に
  apt.postgresql.org の Debian 12 向け pgvector 0.8.6 のビルド済み `.so` を後から
  差し込んだものである**（コンパイラが無いためソースからは作れなかった）。
  ⟹ **CI が使う `pgvector/pgvector:pg17` とは Postgres の版も pgvector のビルドも違う。**
  この PR の SQL は版に依存する構文を使っていないが、**「CI と同じ環境で通した」とは
  書かない。**CI の `postgres` job の結果は PR 上で別に確認すること。
- **⚠ 並行性そのものは再現していない。**到達経路（リースを失った古いワーカーの `catch`
  から `failed` が後から届く順序）はコードと ADR 0032 の逐語から導いたものであり、
  走らせて再現したものではない。⟹ **「壊れ方を実際に走らせて再現した」とは書かない。**
  ADR 0048 が `reinforce` について行った実測とは**証拠の強さが違う。**
- **`examples/chat` 側にこの経路の歯は無い**（触っていないため変異も撃っていない）。
