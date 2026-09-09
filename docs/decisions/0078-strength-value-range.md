# ADR 0078: `Memory.strength` の値域を `(0, 1]` に塞ぐ — 口を開ける前に蓋を付ける

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-09

**⚠ 各主張の出所を分ける。**「私が実行して確かめた」と「読んだだけ」と「人から受け取った前提」を
混ぜない（[AGENTS.md](../../AGENTS.md)）。

---

## 文脈

**これはスコアの調整ではない。[ADR 0036](./0036-clamp-freshness-at-one.md) が `freshness` で
塞いだのと、同じ形の穴である。**

[docs/recall.md](../recall.md) §7 のスコアは
`similarity × decay × tagMatch × freshness × strength`。
そして [ADR 0041](./0041-reinforce-does-not-change-strength.md) は、`strength` を
**「初期値として設定できる欄」**と決めている（逐語）:

> **`strength` は初期値として設定できる欄であり、強化では変化しない。**
> ADR 0010 の「`strength` を低く初期化した `imported` な Memory」は生きる。

**同 ADR は同時に、値域が塞がれていないことを「引き受ける負債」として自認している**（逐語）:

> **`strength` の値域は依然として制約が無い**（`z.number()` / CHECK なし）。**塞いでいない。**

⟹ **設定してよい欄で、値域が無い。**この2つが同時に成り立っているのが、いまの状態である。

### なぜ「いま」塞ぐか — 順序の話

**`Runtime` から初期値を設定する口を開ける作業の準備ではない。開ける前に要るものである。**

[ADR 0036](./0036-clamp-freshness-at-one.md) が `occurredAt` を埋める前に `freshness` の上限を
**単独で先に**入れたのと同じ順序である。**逆にすると、口が開いた日から誰でもスコアを
何倍にでもできる。**

なお `Runtime`（`observe` / `tick` / `recall` / `reextract`）から `strength` に 1 以外が入る経路は
いま存在しない（ADR 0041 の負債節、[ADR 0069](./0069-ann-truncated-says-nothing-about-loss.md) の
「`strength` に 1 以外を書く箇所はリポジトリに0件である【現物】」）。
**⟹ 本 ADR はいまの挙動を変えない。変えるのは「これから何が書けるか」だけである。**

### 実測1: 値域が無いと何が起きるか（**私が実行した。`defaultDecayStrategy` / `defaultScoringStrategy` を直接呼んだ**）

`recordedAt` = 2026-09-01、`halfLifeHours` = 720（既定）、`similarity` = 0.4。

| `strength` | `floorAt` | `total` |
|---|---|---|
| `1`（既定） | 2027-01-08 | 0.276 |
| `0.5` | 2026-12-09 | 0.138 |
| `0.05`（= `DEFAULT_DECAY_THRESHOLD`） | base（生まれた時点で閾値以下） | — |
| **`0`** | base | **0** |
| **`-1`** | base | **−0.276（順位が反転する）** |
| **`2`** | 2027-02-07 | 0.553 |
| **`1e6`** | 2028-08-28 | **276382** |
| **`NaN`** | 🔴 **Invalid Date** | `NaN` |
| **`Infinity`** | 🔴 **Invalid Date** | `Infinity` |

**🔴 `NaN` が `floorAt` の門を素通りする理由**: `floorAt` は
`if (params.strength <= threshold) return base;` で始まるが、**`NaN` との比較は常に false** なので
この早期 return に入らない。そのまま `Math.log2(NaN / 0.05)` → `NaN` → `new Date(NaN)` となる。

**そしてその `Invalid Date` は、`strength` とは別の列の話として落ちる**
（**私が実行した。本物の PostgreSQL 16.15**）:

```
invalid input syntax for type timestamp with time zone: "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN"
```

⟹ ⚠ **原因は `strength` なのに、エラーは `decay_floor_at` を指す。**

### 実測2: 列の型は何も守っていない（**私が実行した。PostgreSQL 16.15**）

`real` 列へ `node-postgres` 経由で入れた結果:

| 値 | CHECK 無しの `real` 列 |
|---|---|
| `NaN` | **通った**（`NaN` として格納される） |
| `Infinity` | **通った** |
| `-1` | 通った |
| `1e6` | 通った |

**PostgreSQL の浮動小数点型は `NaN` と `Infinity` を正式な値として持つ。**列の型では防げない。

### 実測3: zod は書き込み経路で走っていない（**私が実行して確かめた**）

`MemorySchema` / `NewMemorySchema` を **`.parse()` している箇所はリポジトリに0件**である
（`grep -rn "NewMemorySchema\|MemorySchema" --include=*.ts packages/` の結果は定義4行のみ）。
書き込み経路で実際に走る zod は `ObserveInputSchema.parse(input)`（`packages/core/src/runtime.ts`）
だけであり、これは `Memory` ではなく `ObserveInput` を見ている。

⟹ 🔴 **zod を締めても実行時には何も起きない。**

### 実測4: `strength` を書く経路は8本あり、1本はアプリの層を通らない（**受け取った調査を私が検算した**）

| # | 経路 | 通る層 |
|---|---|---|
| 1 | `buildNewMemoryFromCandidate`（抽出。常に `1`） | core |
| 2 | `PostgresMemoryStore.createMemory` | store → DB |
| 3 | `PostgresMemoryStore.createMemoryWithOutbox` | store → DB |
| 4 | `InMemoryMemoryStore.createMemory` | store |
| 5 | 同 `createMemoryWithOutbox` | store |
| 6 | `FakeMemoryStore.createMemory`（core のテスト用） | store |
| 7 | `buildNewMemoryFixture`（testkit のひな型） | — |
| 8 | 🔴 **`packages/postgres/src/bench/scale-bench.ts` の `INSERT ... SELECT`** | **DB だけ** |

**8 は生 SQL であり、`MemoryStore.createMemory` も `NewMemory` 型も通らない。**
⟹ **アプリ側のどの層を締めても素通りする。DB の CHECK は素通りしない。**

### この repo の作法 — 値域はどの層で守られているか（**現物を数えた**）

| フィールド | zod | DB CHECK |
|---|---|---|
| `status` | `z.enum`（5値） | 在る |
| `provenanceKind` | `z.enum`（5値） | 在る |
| `embeddingStatus` | `z.enum`（4値） | 在る |
| `subjectId` | `z.string().min(1)` | 無い |
| `halfLifeHours` | `z.number().positive()` | 無い |
| **`strength`** | **無い** | **無い** |

⟹ **`strength` は、どちらの層も持たない唯一のフィールドだった。**

これは [ADR 0034](./0034-vector-store-filter-conformance.md) の観測（逐語）と同じ形の話である:

> **⚠ 訂正: 「多層防御が在るから最終結果は正しい」は、`status` には当てはまらない**（…）
> ⟹ **`status` については、adapter がこの契約を守ることが唯一の防衛線である。**

---

## 決定

1. **`Memory.strength` の値域を `(0, MAX_STRENGTH]`（= `(0, 1]`）とする。**
   `MAX_STRENGTH = 1` を `packages/core/src/memory.ts` から export する
   （[ADR 0036](./0036-clamp-freshness-at-one.md) が `MAX_FRESHNESS` を export したのと同じ理由:
   **呼び出し側が上限の存在と値を読める形にしておく**）。

2. **🔴 上限を 1 にするのは、「`strength` は素通りか、弱めるかのどちらかである」と決めたものである。**
   1 は**掛け算の単位元**であり、係数として「素通り」を意味する唯一の値である。
   `strength` で**強める**ことはできなくなる。**⚠ これは「強めてはいけない」という決定ではなく、
   「いま強める根拠が無い」という決定である**（下の「採らなかった案」を見よ）。

3. **0 は含めない。** `strength = 0` は `total` を恒久的に 0 にする＝「二度と引かれない」であり、
   それは `status: 'forgotten'` が既に表している。**同じことを言う道を2つ作らない。**
   なお `(0, 0.05]` は許す——ADR 0010 が「既に閾値以下の Memory を作るのは正常系であり得る」
   （逐語）と明示しており、`floorAt` もその場合に `base` を返すよう作られている。

4. **🔴 強制の責任は store（adapter）の層に置く。**値は `MemoryStore.createMemory` の
   **呼び出し側**から来るのであって、`Runtime` を通らない直接呼び出しを捕まえられるのは
   store と DB だけである。具体的には:
   - `packages/postgres`: `memories_strength_range` の CHECK 制約（マイグレーション `0006`）
   - `packages/testkit` の in-memory 実装: `isStrengthInRange` による検査
   - **`packages/testkit` の適合スイートに歯を1本置き、これを adapter の契約にする**

5. **zod（`MemorySchema` / `NewMemorySchema`）も `z.number().gt(0).max(MAX_STRENGTH)` に締める。
   ただしこれは公開された型の契約としてであって、防波堤ではない。**
   実測3 のとおり `.parse()` される箇所が無いため、**実行時には何も起きない。**
   コードのコメントにもそう書いた——**「zod で守っている」と読まれるのがいちばん危ない。**

6. **`NaN` / `Infinity` を弾いているのは比較の「向き」である**（`NaN > 0` が false になる）。
   ⚠ **`value <= 0 || value > MAX_STRENGTH` のように否定で書き直してはならない**——
   その形にすると `NaN` は「範囲外ではない」と判定されて素通りする。
   DB 側も同じ理由で `strength > 0 AND strength <= 1` の**両方を AND で**書く
   （PostgreSQL では `NaN > 0` は TRUE だが `NaN <= 1` は FALSE なので、AND で落ちる）。

7. **マイグレーションは検証つきで足す（`NOT VALID` にしない）。** 既存行が値域の外に在れば、
   そこで**失敗する。**それは意図した振る舞いである。

---

## 変異試験で分かったこと（**すべて私が実行した**）

**歯が実際に噛むことを、2つの層について別々に確かめた。**
段0（変異が木に載ったことの確認）→ 段1（赤くなるか）→ 段2（走った件数）→
段3（歯だけ消して同じ変異を当て、緑のままか）の順に踏んだ。

### 層A: core の `isStrengthInRange`（in-memory adapter を守る）

| 変異 | 結果 | 件数 |
|---|---|---|
| **A1: `Number.isFinite(value) &&` を落とす** | 🔴 **赤くならなかった** | 1 passed |
| A2: `value <= MAX_STRENGTH` → `value < MAX_STRENGTH`（上限を1つずらす） | 赤 | 1 failed |
| A3: `value > 0` → `value >= 0`（0 を通す） | 赤（`promise resolved … instead of rejecting`） | 1 failed |

**🔴 A1 は歯の不足ではない。`Number.isFinite` が冗長だったのである**——決定6 のとおり
`value > 0 && value <= 1` の向きだけで `NaN` も `Infinity` も落ちるので、
`isFinite` を消しても**振る舞いが1ミリも変わらない**。

⟹ **歯を足せない（観測できない差が無い）ので、コードのほうを消した。**
**歯の当たらない防御を「守っている」の顔で残すと、後から比較の向きを変える人が
「`isFinite` が見ているから大丈夫」と読む。**それが決定6 を無効化する経路になる。

### 層B: DB の CHECK 制約（`packages/postgres` を守る）

| 変異 | 結果 |
|---|---|
| B1: 上限を落とす（`CHECK (strength > 0)`） | 赤 |
| B2: 下限を `>= 0` にする | 赤 |
| B3: 制約を丸ごと落とす | 赤 |

### 層は独立している（**実測**）

**core を A2 で壊した状態で `packages/postgres` の適合テストを走らせたら、緑のままだった**
（1 passed / 227 skipped）。⟹ 2つは別々の防波堤であり、片方の緑が他方を保証しない
（[ADR 0034](./0034-vector-store-filter-conformance.md) の教訓の適用）。

### 段3: この歯だけが唯一の防衛線である（**実測**）

適合スイートの新しい歯を `it.skip` にして、`conformance.postgres` を丸ごと走らせた:

| 状態 | 結果 |
|---|---|
| 歯なし・**制約あり**（空撃ち） | **137 passed / 1 skipped** |
| 歯なし・**制約を落とす**（B3） | **137 passed / 1 skipped** |

⟹ 🔑 **完全に同じ。既存の137本は、制約が消えたことに気づかない。**

### ⚠ 変異試験そのものが、実測を1つ生んだ

B1（上限を落とす）の実行中に、テストが `strength = 1.0001` の行を**実際に挿入した**。
その状態で検証つきの `ADD CONSTRAINT` を撃つと:

```
ERROR:  check constraint "tmp_probe" of relation "memories" is violated by some row
```

⟹ **決定7 の「既存行が範囲外なら失敗する」は、主張ではなく実測である。**

---

## 実測: 上限の実効的な粒度は float4 である（**私が実行した**）

`memories.strength` は `real`（float4）である。**float64 の ε は境界の試験に使えない。**

| 値 | CHECK `(s > 0 AND s <= 1)` |
|---|---|
| `1` | 通る |
| **`1 + Number.EPSILON`** | 🔴 **通る**（格納時に `1.0` へ丸められる） |
| `1.0000001` | REJECT |
| `1.0001` | REJECT |
| `1e-45` | 通る（float4 の非正規化数） |
| `1e-46` | REJECT（`0` に丸められ `> 0` を落ちる） |

⟹ ⚠ **in-memory 実装は float64 で判定するので `1 + Number.EPSILON` を弾く。
2つの adapter は境界で食い違う。**
だから適合スイートには**両者が一致する値だけ**を置いた（上限側は `1.0001`）。
**ε を書くと、この歯は「どちらかの adapter でしか成立しない」ものになる。**

---

## この PR が何を*しない*か

- 🔴 **`Runtime` から初期値の `strength` を設定する口は開けない。**
  ADR 0041 が「引き受ける負債」に挙げたその穴は、**そのまま残る**
  （`buildNewMemoryFromCandidate` は今も常に `1` を書く）。**蓋だけを、先に付けた。**
- **`reinforce` が `strength` を動かすかどうかには触れない。**
  それは [ADR 0041](./0041-reinforce-does-not-change-strength.md) が決めたこと（動かさない）であり、
  覆すには同 ADR が挙げた3点（増分の式・上限・`decay_floor_at` の再計算）が要る。
- **`decay` / `similarity` / `tagMatch` の値域には触れない。**
  ADR 0036 が「対象外・塞いでいない」と書いた3つは、いまも塞がれていない。
- **`halfLifeHours` の DB CHECK も足さない。** zod には `positive()` が在るが DB には無い、という
  非対称は残る（実測3 のとおり zod は走らないので、実質どこにも無い）。**別の PR の話である。**

---

## 検討して採らなかった案

- **🔴 上限を掛けずに、スコア側で clamp する**（`freshness` と同じやり方）。 **却下。**
  `freshness` は**計算値**であり、入力（`occurredAt`）は定義上未来を含むので入口で弾けなかった。
  **`strength` は保存される値であり、書いた人が居る。**clamp すると
  「2 と書いたのに 1 として扱われる」が黙って起きる。**保存される値は、弾くほうが正しい。**
- **値域を `[0, 1]` にする**（0 を含める）。 **却下**（決定3）。`status: 'forgotten'` と重なる。
  ⚠ **緩めるのは後からできる（非破壊）。締めるのは後からでは破壊的である。**
  迷ったので厳しい側に置いた。
- **上限を 1 より大きくする**（例: 10 まで許して「重要な記憶を強める」を可能にする）。 **却下。**
  `docs/` 全体を検索して、**`strength` を 1 より大きくしたい需要を示す記述は見つからなかった**
  （ADR 0010 が挙げるのは「**低く**初期化した `imported` な Memory」だけであり、文脈は
  一貫して低い側の正常性を論じている）。ADR 0069 も「`strength` に 1 以外を書く箇所は
  リポジトリに0件である【現物】」と数えている。
  **⟹ 上限を 1 より大きく取るなら、その値を選ぶ根拠が要る。それは無い。**
  なお**「重要な記憶を長く保つ」には既に `halfLifeHours` という専用の軸が在る**——
  `strength` は「いま何倍で引くか」、`halfLifeHours` は「どれだけ長く保つか」であり、別の問いである。
- **`NOT VALID` で足して、あとで `VALIDATE` する。** **却下**（決定7）。
  「新しい行は守られるが、古い行は範囲外のまま黙って残る」状態になる。
  ⚠ **代償は引き受けた**: 検証つきの `ADD CONSTRAINT` は表を走査し、その間
  ACCESS EXCLUSIVE ロックを取る。行数の多い表では停止時間になる。
- **core（`Runtime`）の側で検査する。** **却下。**
  値域の外の値を書くのは `MemoryStore.createMemory` を**直接**呼ぶ経路であり、
  そこは core を通らない。**通らない層に歯を置いても噛まない。**
- **zod だけを締める。** **却下**（実測3）。`.parse()` されないので実行時には何も起きない。
  ⚠ **これがいちばん「やった気になる」案だった。**

---

## 引き受ける負債・覆えていない範囲

- 🔴 **これは adapter の契約の変更である。**
  適合スイートに歯が入るため、**値域の外を受け入れていた第三者の adapter は、これから
  conformance に落ちる。**`0.x` なので semver 上は許されるが、
  [docs/autonomy.md](../autonomy.md) §3 は公開 API の破壊的変更を
  「**提起までにする**」としている。**⟹ ここに書いて提起する。取り込む判断はオーナーのものである。**
- **冪等の経路（同じ `contentHash` で2回目）は検査していない。**
  `packages/postgres` の `ON CONFLICT` と CHECK 制約の評価順序を確かめていないため、
  「重複 + 範囲外」で2つの adapter が食い違う可能性がある。**歯は新規挿入の場合だけを見ている。**
- **境界で2つの adapter が食い違うことは、塞いでいない**（float4 対 float64）。
  歯は「両者が一致する値」だけを置いて回避した。**一致しない帯（`1` と `1.0000001` の間）は
  無検査である。**
- ⚠ **「検証つきの走査が既存行を通った」ことの証拠は弱い。**
  この器のローカル DB は `memories` が **1行**（`strength = 1`）しか無い状態で走った。
  **リポジトリ外の利用者の DB については確かめていない。**
- **`scale-bench.ts` の生 SQL 経路は、DB の CHECK だけが守る。**多層にはなっていない。
  いま書いているのはリテラル `1.0` なので当たらないが、**規律であって機構ではない。**
- **`FakeMemoryStore`（`packages/core` のテスト用）には検査を入れていない。**
  適合スイートの対象外（`describeMemoryStoreConformance` の呼び出し元は
  `packages/postgres` と `packages/testkit` の2箇所）であるため。**手薄なまま残る。**

---

## これが覆るとしたら

- **オーナーが「使った記憶は強くなるべきだ」と決めたとき。**
  [ADR 0041](./0041-reinforce-does-not-change-strength.md) が明示した再開条件である。
  そのときは同 ADR の3点（**(a) 増分・(b) 上限・(c) `decay_floor_at` の再計算がその値を使うこと**）が
  要り、**(b) の上限は本 ADR が決めた `1` そのものである。**
  ⟹ **強化で `strength` が上がる設計を採るなら、上限 1 に当たったときどうするかを決める必要がある**
  （頭打ちにするのか、上限そのものを上げるのか）。
- **利用側が「重要度を申告して並べ替えたい」と決めたとき。**
  `(0, 1]` は**弱める向きにしか使えない**ので、既定値 1 の既存データと混ざると
  「新しく入れたものだけが弱い」状態になる。
  ⚠ そして `strength` を下げると `total` が**絶対値の閾値**（`DEFAULT_SCORE_THRESHOLD = 0.1`）に
  近づくため、**下げ幅によっては `below_threshold` で落ちるようになる。**
  **この写像の設計は本 ADR の対象外であり、決めていない。**
- **Phase 2 で忘却の実処理（`decay_floor_at` を読み取りに使う）が入ったとき。**
  ADR 0041 が「`strength` が動かないことは `decay_floor_at` の単調性の前提でもある」と
  書いている。値域が閉じたことでこの前提の意味も変わりうる。
