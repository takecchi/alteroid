# ADR 0100: 統合パイプラインの「新 Memory の作成」と「旧行の supersede」を1トランザクションにする口を足す（任意メソッド）

- **状態**: 採用 (2026-09)

- **文脈**:

  [docs/memory-model.md](../memory-model.md) §11 の Memory lifecycle 遷移表・行5
  （`active → superseded`）は、逐語でこう要求している:

  > 判定ロジック自体は非同期でよいが、書き込み（**旧行の `status`/`superseded_by_id` 更新と
  > 新 Memory の作成**）は1トランザクションで完結させる

  ## 🔴 何が在って、何が無かったか（Issue #134 の切り分け）

  **「1トランザクションの口が実装に無い」は偽である。**口は在り、届く範囲が違っていた。

  | 対                                                                                                           | アトミック性                   | 出所                                                                                                                                                                                                    |
  | ------------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | (a) 旧行の `status`/`superseded_by_id` 更新 ↔ (c) `superseded` イベントの追記                                | ✅ **在る**                    | [ADR 0031](./0031-supersede-status-and-event-in-one-transaction.md)、`MemoryStore.updateStatusWithEvent`。本物の並行で実測する歯（`memory-store-update-status-with-event-transaction.test.ts`）まで在る |
  | (b) 新 Memory の作成（`createMemoryWithOutbox` の INSERT ＋ 同一トランザクションの outbox ジョブ） ↔ (a)+(c) | ❌ **無い**（本 ADR が埋める） | —                                                                                                                                                                                                       |

  ⟹ **差は「口が無い」ではなく「(b) が (a)+(c) と同じトランザクションに入っていない」である。**

  この欠落は**実装側が自分で名指ししていた**。`packages/core/src/interfaces/memory-store.ts`
  の `updateStatusWithEvent` の doc コメント（逐語）:

  > また、docs/memory-model.md §11 行5 が規定する「旧行の status 更新と*新 Memory の作成*も
  > 1トランザクション」は**このメソッドの範囲外**——新しい Memory の作成（`createMemory`/
  > `createMemoryWithOutbox`）は別の呼び出しのままであり、このメソッドは既存 Memory の
  > status 更新とイベント追記の対だけを扱う（ADR 0031「これが覆るとしたら」参照）。

  ## この ADR が新規である根拠（0031 の改訂ではない）

  ADR 0031「これが覆るとしたら」が逐語でこう書いている:

  > 「旧行の status 更新と新 Memory の作成を1トランザクションにする」という
  > docs/memory-model.md §11 行5 の要求を実際に満たす必要が生じたら、
  > `updateStatusWithEvent` をさらに拡張する（あるいは別のメソッドを足す）かどうかを
  > 検討する**新しい ADR が要る**。

  ⟹ **0031 は覆らない**（status↔event の決定はそのまま有効）。本 ADR はその隣に足す。

  ## ギャップに乗っている呼び手は2つ（メソッドの呼び手は3つ）

  `updateStatusWithEvent` の production の呼び手は `packages/core/src/runtime.ts` に3つある。

  | 呼び手        | §11 のどの行                | ギャップに乗るか                                                                                 |
  | ------------- | --------------------------- | ------------------------------------------------------------------------------------------------ |
  | `reextract`   | 行5                         | ✅ 乗る                                                                                          |
  | `consolidate` | 行5                         | ✅ 乗る                                                                                          |
  | **`forget`**  | **行9**（任意 → forgotten） | ❌ **乗らない**——新 Memory を作らないので `updateStatusWithEvent` だけで行9 を完全に満たしている |

  🔴 **⟹ `forget` は1バイトも触らない。**既に正しく閉じているものを、この作業で壊す側に倒さない。

  [ADR 0089](./0089-runtime-consolidate-shape.md)「これが覆るとしたら」が逐語で
  「`reextract` と `consolidate` の**両方**を新しい口へ寄せる判断が要る。**先回りして
  片方だけを寄せない。**」と書いているため、**両方を同じ PR で寄せた。**

- **決定**:

  ## 決定1: `MemoryStore` に**任意**メソッド `supersedeWithNewMemories?` を足す

  ```ts
  supersedeWithNewMemories?(
    ctx: Ctx,
    news: ReadonlyArray<{ input: NewMemory; jobKinds: OutboxJobKind[] }>,
    supersede: ReadonlyArray<{
      id: MemoryId;
      supersededByIndex: number;
      expectedStatus?: MemoryStatus;
      event: NewMemoryEvent;
    }>,
  ): Promise<{
    created: Array<{ memory: Memory; created: boolean; jobs: OutboxJobRecord[] }>;
    superseded: MemoryEvent[];
    conflicted: Array<{ id: MemoryId; observedStatus: MemoryStatus }>;
  }>;
  ```

  🔴 **必須にしない。**`MemoryStore` は `packages/testkit` の適合テストで「差し替え可能」が
  保証されている公開 interface であり、`@mnemora/core` は **npm に公開済み**（確認時点で
  `0.1.4`）。必須メソッドを足すと第三者の adapter が壊れる——
  [docs/autonomy.md](../autonomy.md):114 は逐語で「**公開 API の破壊的変更** …
  **提起までにする。**ADR を書き、実装は別 PR にして、承認を待つ」と定めている。
  ⟹ **任意メソッドなら実装者に追加義務が生じないので、既存 adapter は1バイトも壊れない。**

  **`news` が配列である理由**: `consolidate` は N→1 だが、**`reextract` は候補ごとに
  `createMemoryWithOutbox` をループで呼び M 件作る**（`runtime.ts` の
  `createMemoriesFromCandidates`）。1件しか受け取らない形にすると `reextract` を寄せられず、
  ADR 0089 の「片方だけを寄せない」に反する。

  ## 決定2: 🔴 `supersededByIndex`（`news` への索引）であって `MemoryId` ではない

  当初の設計は `supersededById: MemoryId` だった。**これは実装できない。**
  `supersededById` は「このコールの `news` で今まさに作る Memory の id」だが、
  `NewMemory` は `Omit<Memory, "id" | ...>` で `id` を持たず、id は store が採番する
  （postgres は `gen_random_uuid()`）——⟹ **呼び出し側は渡すべき値を渡す前に知りえない。**
  今日これが成立しているのは、作成と supersede が**2つの別の呼び出し**だからであり、
  その2つを融かすこと自体がこの ADR の目的である。

  ⟹ **索引にする。**副次的な利得として、`superseded_by_id` の外部キー違反は
  **構造的に起こりえなくなった**（指す先は必ずこの呼び出しが作った/見つけた行である）。
  ADR 0047 の「存在」検査の役目は、下の範囲検査が引き継ぐ。

  ### 索引にすると型の助けが減る ⟹ 型で守れなくなった分を歯で守る
  1. 🔴🔴 **`created` は `news` と同じ順序・同じ長さで返す。**索引が正しい行を指せるのは
     この対応が保たれているときだけであり、**並びがずれても型は何も言わない**——
     `superseded_by_id` に別の記憶の id が書かれ、検査は緑のまま通る。**これが一番悪い
     壊れ方である。**⟹ 適合テストは **`news` を3件**渡し、**異なる索引（0 と 2）**へ寄せて
     対応を固定する。⚠ **1件では順序という概念が無く、2件では「逆順」と「入れ替え」が
     区別できない。**
  2. 🔴 **範囲外の索引は `RangeError`（メッセージ `supersededByIndex out of range`）。**
     ⛔ 黙って無視しない。⛔ `conflicted` にも「memory not found」にも混ぜない——
     **「呼び手が壊れた索引を渡した」「CAS で弾かれた」「対象の行が無い」は3つとも別の
     失敗**であり、潰すとこの設計の要が壊れる。このときも何も書かれない。
  3. ⚠ **索引が指すのは `news[i]` に対応する Memory であって、それが今回作られたか既に
     在ったかは問わない**（冪等経路で既存行に衝突した場合も同じ行を指す。
     `created[i].created` がどちらかを名乗る）。これを doc に逐語で書いた——書かないと
     次に読む人は「新しく作られた記憶」と読む。

  ## 決定3: CAS に弾かれた対象は例外にせず `conflicted` に積み、トランザクションは commit する

  条件付き UPDATE の0行は**エラーではない**ので、CAS 不一致はトランザクションを中断しない。
  ⟹ 「新 Memory の作成 ＋ 書き込み時点でまだ `active` だった対象の supersede」を1単位として
  確定し、弾かれた分は `conflicted` に積んで commit できる。

  🔑 **これにより、ADR 0031 の「採らなかった案」を覆さずに §11 行5 を満たせる。**あちらは
  「supersede ループ全体を1トランザクションにする」を却下していた（逐語: 「ループ全体を
  1トランザクションにすると『1件の競合』が『全部やらなかった』に化ける——CAS の意味…と
  正面から衝突する」）。**本 ADR は「全部か無か」を N 件に対して買わない。**

  呼び出し側では、`conflicted` を**既存の語彙**へ写す——`reextract` は
  `ReextractSkip.status_changed_concurrently`、`consolidate` は
  `ConsolidateSourceOutcome.status_changed_concurrently`。⛔ **どちらの union にも新しい値を
  足さない**（exhaustive switch を持つ第三者のコードをコンパイルで壊しうる）。

  ## 決定4: 対象の行が存在しない場合は「memory not found」を投げ、`news` の作成も巻き戻る

  ⛔ `conflicted` に混ぜない（決定2の3種類の失敗の話）。
  ⚠ **これは振る舞いの変更である。**今日は直前に別途呼んでいた `createMemoryWithOutbox` の
  作成が既に commit 済みで残る。この口を経由すると、その作成も巻き戻る。
  これは**アトミック性の正しい意味論**であり、負債ではなく決定として引き受ける。

  ## 決定5: `event.meta.supersededById` は実装が解決した id で埋める

  呼び出し側は索引しか持たないため、この欄を自分で埋められない。⟹ 実装が埋める。
  🔑 **理由: 監査ログの中身が、口を実装した adapter と実装していない adapter で同一になる。**
  ⛔ 同じ論理操作が adapter ごとに別の監査記録を残す形にはしない。`event` の他の欄は変えない。

  ## 決定6: 戻り値に `atomicity: WriteAtomicity` を足す（3値・省略不可）

  ```ts
  export type WriteAtomicity = "store_supported" | "store_unsupported" | "not_attempted";
  ```

  - ⛔ **省略可能（`?`）にしない。**`undefined` が「口が無かった」と「この欄より前の版の
    戻り値」の両方を意味してしまい、「無い」の種類を潰す。
  - 🔴 **`'transactional'` と名乗らない。**この値は**原子性の証拠ではなく、口の有無の写し**
    である——adapter が口を実装したと宣言したことしか意味しない。実装していても実際には
    トランザクションを張っていない adapter（`packages/testkit` の `InMemoryMemoryStore` は
    「トランザクションは一切模していない」と自分で書いている）を、この値は見抜けない。
    **買っていない保証を名前で主張しない。**
  - 🔴 **`'not_attempted'` は3つ目の状態として要る。**`reextract` の安全弁（LLM がまた失敗
    した／候補が0件）や `consolidate` の `dry_run`・`nothing_to_consolidate`・
    `not_examined`・`llm_failed` は**書き込みを1件も試みていない**。⛔ これを前2つの
    どちらかに寄せると「§11 行5 が破れた」と「破れる機会が無かった」が区別できなくなる。
    名前は `ConsolidateSourceOutcome.not_attempted`（ADR 0087 決定5）に揃えた。

  ## 決定7: 🔴 口が投げたとき、今日の2段の経路へフォールバックしない

  フォールバックは**口の不在に対してだけ**（書き込みの前に1度だけ判定する静的な性質）。
  **投げられたときに撃ち直すと「トランザクションを張れなかった」と「張ったが失敗した」が
  呼び手から区別できなくなる**——Issue #134 が明示的に潰すなと書いた破れそのものである。

  ## 決定8: 🔴 `consolidate` では ADR 0089 決定5 を**部分的に覆す**（投げる）

  ADR 0089 決定5 は「予期しない例外が出たら**そこで打ち切り**、残りを `not_attempted` に
  して**返す（投げない）**」と決めていた。**口を使う経路では投げる。**

  **理由**: ADR 0089 が「投げない」とした理由は逐語で

  > 🔴 **例外を投げないのは、部分的に起きたことを呼び出し側から見えなくしないためである。**

  ⟹ **1トランザクションでは「部分的に起きたこと」が無くなる**（統合先の作成も supersede も
  全部巻き戻る）。**規則が守ろうとしていたものは、この経路では別の手段で守られている。**

  🔑 **規則を破るときは、「規則に反した」と「規則が守ろうとしていたものは守られている」の
  両方を書く。**片方だけ書くと、次に読む人は「破っただけ」か「破っていない」のどちらかに
  読み替える。⛔ ADR 0089 決定5 は**この経路に限って**覆っている——口を持たない adapter の
  経路では今日どおり「打ち切って返す」であり、あちらでは書き込みが実際に部分的に起きるため
  理由がまだ生きている。
  加えて、`ConsolidateOutcome` の5値（`consolidated` / `nothing_to_consolidate` /
  `not_examined` / `llm_failed` / `dry_run`）に「試みたが何も書かれなかった」に当たる値が
  無く、`outcome: 'consolidated'` + `consolidatedMemoryId` を返すと**嘘になる**。

  ⚠ **口を持たない adapter の経路（今日の2段）では、ADR 0089 決定5 の「打ち切って返す」を
  そのまま残した**——あちらでは書き込みが実際に部分的に起きるため、理由がまだ生きている。

  🔴 **これは公開 API の観測可能な振る舞いの変更であり、`docs/autonomy.md`:114 に従って
  オーナーの承認を得てから入れた**（2026-09-11）。

- **守れないもの**:

  - 🔴 **任意メソッドである以上、サードパーティのアダプタの上では §11 行5 は恒久的に
    満たされない。`store_unsupported` はそれを見えるようにするだけで、直さない。**
    ⟹ ⛔ 「ADR 0100 が入ったから §11 行5 は守られている」と読まないこと——
    **守られるのは口を実装した adapter の上だけである。**
  - 🔴 **口の有無は原子性の証拠ではない。**決定6 に既述。実装しているが実際には
    トランザクションを張っていない adapter を、この機構は見抜けない。
  - ⚠ **`created` イベント（`kind: "created"`）は、このトランザクションの外に在る。**
    `EventStore.append` は別コミットのままである。§11 行5 が名指ししたのは「旧行の更新」と
    「新 Memory の作成」の対であり、`created` イベントはその要求文に含まれていない——
    **含まれていないから買っていない、と明示しておく。**
  - ⚠ **複数の Memory にまたがる supersede の「全部か無か」は買っていない**（決定3）。
    ADR 0030/0031 からの継続。

- **未決の問い**:

  - **`docs/memory-model.md` §11 行5 は*すべての*アダプタに要求しているのか、それとも
    口を実装したアダプタにだけか。**⛔ **この ADR では決めない。**正典の解釈であり
    オーナーの判断である（`AGENTS.md`「正典と実装が食い違ったら」）。
    ⛔ 本 PR は `docs/memory-model.md` を1バイトも書き換えていない。

- **採らなかった案**:

  1. **必須メソッドにする。** 却下。決定1。公開 API の破壊的変更で `docs/autonomy.md`:114 に
     当たる（[Issue #137](https://github.com/takecchi/mnemora/issues/137) が同じ理由で
     止まっている）。
  2. **`updateStatusWithEvent` を拡張して新 Memory も受け取らせる。** 却下。3人目の呼び手
     `forget` が同じシグネチャを使っており、`forget` は新 Memory を作らない——**既に正しく
     閉じている経路に、意味のない引数と分岐を持ち込むことになる。**別メソッドなら `forget`
     は1バイトも動かない。
  3. **`news` を1件だけ受け取る形。** 却下。`consolidate` にしか使えず `reextract` を
     寄せられない（決定1）。ADR 0089 が「片方だけを寄せない」と明示。
  4. **supersede ループ全体を「全部か無か」にする。** 却下。ADR 0031「採らなかった案」が
     既に却下済みで、CAS の安全弁3（ADR 0030）と正面衝突する。決定3が回避策。
  5. **返り値を richer にするだけで済ませる。** 却下。ADR 0031 が同じ案を同じ理由で却下済み
     （逐語: 「**永続化された不整合は返り値では消えない。**」）。
  6. **`conflicted` と「行が無い」を1つに潰す。** 却下。決定2・決定4。「無い」の種類を潰す
     破れであり、この repo が族として繰り返してきた失敗（「名乗れる以上の精度を主張する」族、
     ADR 0011/0025/0027/0028/0034/0065）の再演になる。
  7. **`supersededById` を `MemoryId` のまま持つ。** 却下——**実装不能だから**（決定2）。
     「正しいが重い」ので落としたのではない。
  8. **`supersededBy: { kind:'new'; index } | { kind:'existing'; id }` の判別可能ユニオン。**
     却下。[ADR 0024](./0024-remove-exact-counts-option.md)「先回りして作らない」に反する
     ——今の呼び手2つはどちらも `'new'` しか使わない。面が増えた分だけ測る歯も増える。
  9. **`RuntimeDeps` に client 側の id 生成器を足す**（呼び出し側が先に採番する）。却下。
     公開型 `NewMemory` と `RuntimeDeps` の両方を変える破壊的変更であることに加え、
     **採番の責務が store から core へ移り `gen_random_uuid()` と二重になる**——
     「同じことを2箇所で決める」形であり、片側だけが変わった日に静かに壊れる。
  10. **`ConsolidateOutcome` に値を足す**（例: `'write_failed'`）。却下。union に値を足すと
      exhaustive switch を持つ第三者のコードがコンパイルで壊れうる——**却下案6 で
      `ReextractSkip` に kind を足すのを禁じたのと同じ理由**であり、一貫性を取るなら
      ここでも却下すべきである。⟹ 決定8（投げる）を採った。
  11. **口だけ着地させ、`reextract`/`consolidate` への配線を次の PR にする。** 却下。
      **測られていない interface が先に着地する**形になる——適合テストの分岐こそが
      interface の変更を意味あるものにしている。

- **引き受ける負債**:

  - 🔴 **決定8 の振る舞いの変更は、型が変わらないので使う側はコンパイルで気づけない。**
    `consolidate` が返していた場面で投げるようになる——**例外を受け止めていない呼び手は
    実行時に落ちる。**

    🔴 **オーナーへの説明に使った言い方をそのまま残す（この一文が承認の前提である）:**

    > **型は変わらないので、コンパイルは通ったままです ＝ 気づかずに実行時に落ちる形です。**

    ⚠ これは型が変わる破壊的変更より**むしろ悪い**——型が変わるなら少なくとも
    コンパイルで止まる。⟹ だからこそ `docs/autonomy.md`:114 の手順（提起して承認を待つ）を
    通した。**オーナーの承認は 2026-09-11 に下りた**（回答: `a`＝投げる形を採る）。
    🔴 **⚠ この負債は、本 PR の作業中に repo 内で現実になった。**作業開始時点では
    `runtime.consolidate()` の production の呼び手は0件だった（[Issue #136](https://github.com/takecchi/mnemora/issues/136)
    「`examples/chat` への配線が無い」がその住所）。**しかし [ADR 0101](./0101-how-to-measure-whether-consolidate-moved-the-north-star.md)
    （PR #143）が作業中に `main` へ入り、`examples/chat/src/consolidation-cost.ts` が
    `runtime.consolidate()` を呼ぶようになった——そしてその呼び出しは `try`/`catch` で
    包まれていない。**
    ⟹ **「壊れうるのは第三者だけ」はもう成り立たない。**予期しない store の失敗
    （接続断など）が起きたとき、このベンチは以前なら `sources` に `failed`/`not_attempted`
    を記録して続行したが、本 PR 以降は**そこで落ちる。**
    ⚠ **ベンチが実測中の失敗で大きな音を立てて落ちるのは、むしろ望ましい**とも言えるが、
    **それはこの ADR が決めたことではなく、`examples/chat` 側の判断である。**
    ⛔ 本 PR では `examples/chat` を触っていない（PR #143 が着地した直後のファイルであり、
    そこへ手を入れるかは別の判断）。**この住所をここに残す。**

  - ⚠ **決定4 の振る舞いの変更**（対象行が存在しないとき `news` の作成も巻き戻る）。
  - **`MemoryStore` の責務がさらに広がった。** ADR 0012 D-ingest-1 → ADR 0031 の延長線上。
    この口は `memories` / `outbox` / `memory_events` の3つの書き込み先を1つのトランザクションに
    持つ。
  - **`created` イベントがトランザクションの外に在る**（「守れないもの」に既述）。

- **歯について**:

  🔴 **基準線は実測した**（`main` の head `59711d1`）。⚠ ADR 0031 が記録している値
  （root 7 / core 203 / testkit 72 / openai 20）は**とうに古い**——そのまま使わないこと。

  | package                    | 基準線                          | 本 PR 後 | 差            |
  | -------------------------- | ------------------------------- | -------- | ------------- |
  | root vitest                | 18 files / 314                  | 18 / 314 | 変わらず      |
  | `packages/core`            | 36 / 515                        | 37 / 526 | +1 file / +11 |
  | `packages/testkit`         | 3 / 213                         | 3 / 217  | +4            |
  | `packages/openai`          | 7 (1 skipped) / 54 (11 skipped) | 同じ     | 変わらず      |
  | `packages/anthropic`       | 5 (1 skipped) / 51 (2 skipped)  | 同じ     | 変わらず      |
  | `packages/local-embedding` | 6 (1 skipped) / 88 (14 skipped) | 同じ     | 変わらず      |

  ⚠ **skip は1本も増えていない**（増えた skip は「検査した」と「していない」を同じ緑にする）。

  ### 変異試験（⚠ **手で撃った**）

  ⚠ **`.claude/skills/mutation-testing/` はこの repo にもユーザ側にも存在しない**
  （`ls` で確認した）。⟹ **ハーネスが在ると思い込まない。**手で撃ったことをここに明示する。

  各変異は適用 → 該当パッケージの `vitest run` → `git checkout --` で復帰し、
  次に進む前に `git status --porcelain` が空であることを確認した。

  | #                                     | 変異                                                                             | 当たったか      | 赤/総数            | 一意に捕まえた歯                                                    | 赤の出どころ                                                                                                                                    |
  | ------------------------------------- | -------------------------------------------------------------------------------- | --------------- | ------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
  | M1                                    | `reextract` の `atomicity` を常に `'store_supported'` にする                     | 当たった        | 1/522 (core)       | 「口が無い adapter で `store_unsupported` を名乗る」                | `AssertionError: expected 'store_supported' to be 'store_unsupported'`                                                                          |
  | M2                                    | `reextract` で口が投げたとき今日の経路へフォールバックする                       | 当たった        | 2/522 (core)       | 「フォールバックしない」＋ TOCTOU の歯                              | `AssertionError: promise resolved "{ observationId: 'obs-271', …(6) }" instead of rejecting`                                                    |
  | M3                                    | in-memory 実装で `created` の並びを逆にする                                      | 当たった        | 1/217 (testkit)    | 🔴 順序を固定する歯（3件・索引0と2）                                | `AssertionError: expected [ 'news-3', 'news-2', 'news-1' ] to deeply equal [ 'news-1', 'news-2', 'news-3' ]`                                    |
  | M4                                    | in-memory 実装で範囲外の索引の検査を外す                                         | 当たった        | 1/217 (testkit)    | 🔴 `RangeError` の歯                                                | `AssertionError: expected [Function] to throw error matching /supersededByIndex out of range/ but got 'Cannot read properties of undefined (…'` |
  | **M5**（⭐ **赤くなってはいけない**） | in-memory 実装で振る舞いに影響しない等価な書き換え（中間変数への分割）           | **✅ 緑のまま** | 0/217・0/522       | —                                                                   | —                                                                                                                                               |
  | M6                                    | `consolidate` で口が投げたとき今日の経路へフォールバックする                     | 当たった        | 2/24 (consolidate) | 「フォールバックしない」＋ 芯の歯                                   | `AssertionError: expected [Function] to throw error including 'simulated transaction failure' but got '__fallback_marker__'`                    |
  | M7                                    | in-memory 実装で事前検証より前に `news` を作ってしまう（部分的な書き込みが残る） | 当たった        | 2/217 (testkit)    | ロールバックの歯（冪等キーでの再作成が `created: true` になること） | `AssertionError: expected false to be true`                                                                                                     |

  **各行について:**
  - 7本とも `git diff --stat` が非空であることを確認した。`SKIP` になったものは無い。
  - ⭐ **M5 は要求どおり緑のままだった**——歯が「振る舞い」ではなく「書き方」に反応して
    いないことの確認。
  - ⚠ **M4 が捕まったのは、歯がメッセージまで固定しているからである。**引数無しの
    `.rejects.toThrow()` だったら `TypeError: Cannot read properties of undefined` でも
    通ってしまい、**検査が死んでいることに気づけなかった**（#29/#33/#49 が確立した
    「メッセージまで固定する」規約が、ここで実際に効いた）。
  - M1・M6 は `AssertionError`。M2 は「resolve してしまった」の `AssertionError`。
    型検査やフレームワークの番犬による赤は1件も無い。

  ### ⚠ 既存の歯が1本、黙って意味を失いかけた（ADR 0031 決定8 の再演）

  `runtime.test.ts` の TOCTOU の歯は `updateStatusWithEvent` を差し替えて例外を注入する。
  `reextract` がその口を呼ばなくなった時点で、**この歯は何も検査しなくなる。**
  ADR 0031 決定8 が逐語で予告していた壊れ方である:

  > さもないと `reextract` が `updateStatus` を呼ばなくなった時点で、この歯が黙って意味を
  > 失う（見た目は緑のまま、実際には何も検査していない、という一番危険な壊れ方）。

  今回は**赤くなって気づけた**ので、差し替え先を新しい口へ向け直した。
  `consolidate` 側の「打ち切って返す」の歯（ADR 0089 決定5）も同じ理由で、
  **口を外した経路で測るよう**向け直した——あちらの契約が生きているのはその経路だからである。

  ### ⚠ CI の postgres ジョブが、手元では出なかった食い違いを1件捕まえた

  適合テストの「CAS に弾かれた対象は一切変わっていない」の歯で、期待値を
  `oldConflicted.status`（`createMemory` の返り値）から読んでいた。**これは adapter ごとに
  別の値になる**——in-memory は Map の行の**参照**をそのまま返すので `updateStatus` の後に
  読むと `"archived"` に見えるが、postgres は切り離された行を返すので `"active"` のまま
  である。⟹ 手元（in-memory）では緑、CI（postgres）では
  `AssertionError: expected 'archived' to be 'active'` で赤になった。

  🔑 **皮肉なことに、これは「in-memory の参照共有に気をつける」ための書き方が、
  別の形で同じ穴に落ちた例である。**正しい期待値は「直前に自分で書いた値」＝リテラルの
  `"archived"` であって、**どこかから読んでくるものではない。**
  ⟹ ⛔ **「変わっていない」の期待値を、変わりうる場所から読まないこと。**

  ⚠ これは「手元で緑・CI で赤」が**正しく機能した**例でもある——`packages/postgres` の歯は
  この器では一度も走らないので、**CI が唯一の検出点だった。**

  ### 🔴 芯の歯

  **投げること自体は本題ではない。*巻き戻ること*が本題である。**
  ⚠ 例外が投げられたことだけを見る歯は、書き込みが残っていても緑になる。⟹
  `consolidate.test.ts` の「口が投げたら例外は呼び出し側まで届き、新しい Memory も
  supersede も1件も書かれていない」は、**store を実際に見に行って**行数・イベント数・
  各 source の `status` を assert する。

- **確かめていないこと**:

  - 🔴 **`packages/postgres` の歯を一度も実行していない。**この器に Docker/PostgreSQL/
    `DATABASE_URL` が無い（ルートの `pnpm test` は「DB テストは実行していません」と名指しで
    出力して緑のまま通る。ADR 0015）。**新設の並行の歯
    （`memory-store-supersede-with-new-memories-transaction.test.ts`）と適合テストの
    postgres 版は、CI の postgres ジョブが唯一の実行環境である。**
  - **`db.transaction()` が本物のロールバックとして機能すること自体**（決定4 の
    「`news` の作成も巻き戻る」）は、CI の postgres ジョブで初めて実測される。
  - **本物の並行**での「ちょうど1本だけ `conflicted` が空になる」も、CI 上で初めて実測される。
  - ⭐ **zod の実行時検証には当たらないことを確かめた**（当たらなかったので記録しておく）:
    `ReextractResult`/`ConsolidationResult` は**素の TypeScript の `interface`** であり
    zod スキーマを持たない。[ADR 0098](./0098-validate-recall-output.md) の `safeParse` は
    `RecallResultSchema` だけである（`packages/core/src/recall-output-validation.ts`）。
    production コードに `.strict()` は1件も無い。⟹ **欄の追加で実行時検証は落ちない。
    次に戻り値へ欄を足す人が、同じ確認をやり直さずに済むようここに残す。**

- **これが覆るとしたら**:

  - **オーナーが「§11 行5 はすべてのアダプタに要求している」と判断したとき**（未決の問い）。
    そのとき任意メソッドでは足りず、必須化＝破壊的変更の判断が要る。
  - **`tick` の `consolidate` ジョブ（別 issue）が入ったとき。**決定8（投げる）が
    ジョブの失敗処理と噛み合うかを見直す必要が出る。
  - **`forget` や `contested` の解決が新 Memory を作る形になったとき。**そのとき3人目の
    呼び手もこの口へ寄せる判断が要る（今は寄せない——`forget` は新 Memory を作らない）。
  - **CI の postgres ジョブで、決定3（CAS 不一致は0行でエラーにならない）の前提が崩れた
    とき。**例えばデッドロックで複数本が例外になる場合、`conflicted` の意味論を見直す。
