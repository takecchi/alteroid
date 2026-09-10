# ADR 0022: 北極星の「削っても目的の記憶が落ちない」を、擬似 provider の `compare` では主張しない

- **状態**: 採用 (2026-09)

- **文脈**:

  [docs/north-star.md](../north-star.md) の物差しは:

  > 使う側が、会話ログを全部プロンプトへ積むのをやめられたか。
  >
  > ⚠ トークンを削ったこと自体は成果ではない。「削っても目的の記憶が落ちない」まで
  > 言えて初めて成果である。

  [ADR 0021](./0021-drain-embed-ticks-in-ingest.md) は「スコープ内321件のうち271件が
  埋め込まれないまま(`not_indexed(pending)`)残り、実際に ANN で競ったのは50件だけ
  だった」という欠陥を直した。`examples/chat` の `compare` サブコマンドに
  `formatRecallQualityTable`(本 PR で新設)を足し、**この修正を CI(本物の
  PostgreSQL 17 + pgvector、擬似 provider、GitHub Actions run 34006151739、
  head `e87da3b`)で初めて実測した。**

  結果(`examples/chat/README.md` の「⭐ 削減率だけでは意味を持たない」節に転記済み):

  | 会話ターン数 | スコープ内の Memory | ANN の候補になれた件数 | 返った件数 | 冒頭の事実が残っているか | `omitted` の内訳 |
  |---|---|---|---|---|---|
  | 82 | 41 | 41 | 10 | ✅ | ann_truncated, over_limit:30 |
  | 162 | 81 | 81 | 10 | ✅ | ann_truncated, over_limit:30 |
  | 322 | 161 | 161 | 10 | ❌ | ann_truncated, over_limit:30 |
  | 642 | 321 | 321 | 10 | ❌ | ann_truncated, over_limit:30 |

  **ADR 0021 の修正は効いている**——「ANN の候補になれた件数」が全行で「スコープ内の
  Memory」と一致し、`not_indexed(pending)` はどの行にも出ていない。**そして、
  321件と実際に競わせたら、冒頭の事実は落ちた**(322/642ターンが ❌)。以前の
  README にあった「全行 ✅」は、321件と競った結果ではなく、「候補50件としか
  競っていなかった」ことで成立していた見かけの ✅ だった。

  ただし mnemora は黙って落としてはいない。`omitted` には `over_limit:30`
  (返した10件の外に、閾値は超えたが `limit` に入らなかったものが30件ある)として
  正直に報告されている([ADR 0008](./0008-absence-taxonomy.md)「無いには種類がある」)。
  呼び出し側が `limit` を上げれば取り戻せる。

  **これは擬似 embedding の性質であって、mnemora の欠陥ではない。**
  `DeterministicEmbeddingProvider`(`packages/testkit`)は文字コードの和から
  機械的にベクトルを作るだけで、意味的な類似度を持たない。マネージャーがこの
  純関数を手元で再実装して計算したところ、`scenario.ts` の12種類の filler の
  うち `"最近のニュースについてどう思いますか。"` の1種類だけが、質問文
  (`"ところで、わたしの好きな色を覚えていますか?"`)に対して冒頭の事実
  (`FACT_STATEMENT`)より近い(コサイン距離 0.1333 対 0.1719)。会話が伸びると
  この filler の複製が増え、事実の順位を少しずつ押し下げる:

  | 会話 | embed される件数 | 事実の順位 | 既定 `limit`(10) に入るか |
  |---|---|---|---|
  | `buildConversation(80)` 相当 | 81 | 7位 | ✅ |
  | `buildConversation(160)` 相当 | 161 | 14位 | ❌ |
  | `buildConversation(320)` 相当 | 321 | 27位 | ❌ |

  本物の埋め込みでは別の結果になる——
  [ADR 0019 §7](./0019-real-openai-measurement-cost.md) は本物の provider(arm B/C)で
  MRR 0.714/0.743、hit@10 は7件中7件だったと実測している。一方、擬似 provider を
  意味の違う haystack(60件、`probe-set.ts`)で回すと MRR は **0.018** まで落ちる
  ([ADR 0019 §7.3](./0019-real-openai-measurement-cost.md))——`scenario.ts` の
  12種類の filler の巡回という特殊な形が、擬似 embedding の下でもたまたま
  安定して見えていた理由である。

- **決定**:

  1. **擬似 provider の `compare` は「量の削減」を測る道具として使う。**
     `formatComparisonTable`(chars/tokens/比率)の数値はそのまま北極星の
     「積む量を減らせたか」の証拠として扱ってよい。
  2. **擬似 provider の `compare` は「想起の質」の主張をここに載せない。**
     `formatRecallQualityTable` は実測値をそのまま見せる(良い結果も悪い結果も
     隠さない)が、「これは削っても答えが落ちないことの証明である」という主張は
     しない。322/642ターンの ❌ が示す通り、擬似 embedding の下では答えが
     落ちることがあり、この結果は擬似 embedding の意味的な弱さに強く依存する
     ため、一般化できない。
  3. **想起の質の主張は `retrieval` サブコマンド(`retrieval-quality.ts`、本物の
     embedding を使う)が担う。**
     [ADR 0019 §7](./0019-real-openai-measurement-cost.md) の実測(MRR 0.714/0.743、
     hit@10 = 7/7)が、北極星の「削っても目的の記憶が落ちない」を実際に検証した
     測定である。`examples/chat/README.md` の `compare` 節・`retrieval` 節の両方に、
     どちらが何を主張してよいかを明記する。

- **採らなかった案**:

  - **`compare` の `recall()` に渡す `limit` を上げて 322/642ターンを ✅ に戻す。**
    却下。数字を良く見せるために測定条件を選び直すことになる。北極星の物差しは
    「積む量を減らせたか」であり、`limit` を上げれば返る `memories` の量が増える
    ——物差しに逆行する変更を、表を ✅ にするためだけに行うことになる。
    (`limit` を上げること自体は呼び出し側の正当な選択肢であり、`omitted` の
    `over_limit` を見て呼び出し側が判断すればよい。`compare` の既定測定の
    条件として動かすことを却下している。)
  - **filler の種類を増やして12種類の使い回しをやめ、重複を減らす。**
    却下。擬似 embedding には意味が無い(文字コードの和で機械的にベクトルを
    作るだけ)以上、filler の種類を増やしても「意味的に正しく引ける」ことの
    証明にはならない。[ADR 0019 §7.3](./0019-real-openai-measurement-cost.md)は、
    まさに「内容が1件ずつ違う」haystack(`probe-set.ts`、60件)で擬似 provider を
    回した結果を実測しており、MRR は **0.018** まで落ちる——filler を多様化する
    ことは、擬似 provider の下での「見かけの合格率」をむしろ悪化させるだけで、
    質を測れるようにはならない。
  - **表から ❌ の行(322/642ターン)を落とす、あるいは短い会話だけを載せる。**
    却下。都合の悪い行を消すことは、この文書が禁じている「数値を良く見せるための
    条件選び直し」そのものである。北極星は「削っても目的の記憶が落ちないと
    言えて初めて成果」であり、落ちる場合があることを見せないまま量の削減率だけを
    誇るのは、この物差しの精神に反する。
  - **新しい仕組みを作らず、いま在るものを使う。** 採用。想起の質を測る仕組みは
    既に `retrieval` サブコマンド(`retrieval-quality.ts`)として存在し、
    [ADR 0019 §7](./0019-real-openai-measurement-cost.md)で本物の embedding を
    使った実測(MRR・hit@10・distractor 分析)まで済んでいる。`compare` に
    質の主張を持たせようとする代わりに、`compare` の役割を「量」に絞り、
    質の主張は既存の `retrieval` に委ねるだけでよい。新しい測定コード・新しい
    ADR の仕組みを追加で作る必要はない。

- **引き受ける負債**:

  擬似 provider だけを使う CI(このリポジトリの CI には本物の `OPENAI_API_KEY` が
  無い——[ADR 0019 §1](./0019-real-openai-measurement-cost.md))では、**想起の質の
  回帰を検知する歯が無い。** `compare` が測るのは量だけであり、`retrieval` は
  本物の API キーが要るため CI には載っていない(手動実行のみ)。したがって、
  例えばスコアリング式(`docs/recall.md` §7 の
  `similarity × decay × tagMatch × freshness × strength`)や ANN の段のパラメータを
  変更して意味的な想起の質が悪化しても、**CI はそれを検知できない。** この負債は
  「実 API キーを CI に持たせる」までは解消しない(費用が発生するため、
  [ADR 0019](./0019-real-openai-measurement-cost.md)の通りオーナー判断が要る)。

- **これが覆るとしたら**:

  - CI に本物の(あるいは安価な)embedding provider を持たせられるようになったとき
    ——`retrieval` を CI に載せ、想起の質の回帰をそこで検知できるようになれば、
    `compare` に質の主張を戻す必要も無くなる。
  - 擬似 embedding に意味的な類似度を持たせる改良(例: 実際の文字列の編集距離や
    n-gram 重なりを反映させる)が `packages/testkit` に入ったとき——ただしこれは
    「本物の embedding の近似」を作る話であり、費用対効果を別途検討する必要がある。

- **確かめていないこと**:

  - **事実の順位(7位/14位/27位)の計算は `DeterministicEmbeddingProvider.vectorFor()`
    という純関数の再実装によるものであり、実際に `recall()` を撃って確かめた
    ものではない。** 段2で掛かる decay/freshness/strength の再スコアは考慮して
    いない(同じ ingest 内で作られる Memory 同士は経過時間がほぼ等しく、
    similarity が支配的だろうという前提を置いているが、これも実測ではない)。
  - **この会話(`scenario.ts` の `buildConversation`)を本物の provider で
    測り直してはいない。** [ADR 0019 §7](./0019-real-openai-measurement-cost.md)の
    MRR 0.714/0.743 は `probe-set.ts` の別シナリオ(7領域・haystack 60件)による
    ものであり、`compare` が使う `buildConversation` の会話(12種類の filler の
    巡回・642ターン)をそのまま本物の embedding で測ったわけではない。実費が
    発生するため、実行はオーナー判断とする。
  - `not_indexed(pending)` 以外の `Omission.kind`(`filtered`・`below_threshold`・
    `budget_dropped`・`stage_skipped`)がこのシナリオでどう振る舞うかは、
    今回の実測の対象外であり確かめていない。

---

## 追記 (2026-09-10): 「これが覆るとしたら」の第1項が満たされた

**⚠ 状態欄は書き換えていない。**この repo に「採用済みの ADR を覆った」と示す書式が無いため
（ADR 0064 が ADR 0063 の数値を訂正したときと同じ扱い）。**決定そのものは今も有効である**
——`compare` は量だけを測り、質の主張を持たない。**変わったのは負債のほうである。**

[ADR 0088](./0088-retrieval-quality-measured-in-ci.md) が `retrieval` を CI のジョブに載せた。

**上の「引き受ける負債」が前提にしていた「`retrieval` は本物の API キーが要るため
CI には載っていない」は、もう成り立たない。**[ADR 0051](./0051-recorded-provider-cassette.md)
のカセット（実 API の埋め込み 152 件）を `MNEMORA_PROVIDER_SOURCE=recorded` で再生すれば、
**鍵なしに実 embedding の想起の質を測れる**——追加コスト 0 という意味で、
「これが覆るとしたら」の第1項が言う**「安価な embedding provider」に文言どおり一致する。**

**⚠ ただし覆ったのは半分である。**

- ✅ **「CI はそれを検知できない」は覆った。**スコアリング式や ANN の段を変えれば、
  arm B / C の MRR・`hit@1`・`hit@10` が動き、その差分が Job Summary と
  基準値ファイルの diff に現れる。
- ⛔ **「検知する歯」にはなっていない。**ADR 0088 は**門を1つも置いていない**
  （標本が probe 7 件しかなく、閾値の門は偽陽性を出す。ADR 0033 §3）。
  **⟹ 最後は人の注意力に残る。**

**⛔ そして「`compare` に質の主張を戻す」ことはしていない。**この ADR の決定は維持する。
