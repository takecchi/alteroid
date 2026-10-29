# pnc-census: クローン 1 ターンの N・C・P の集計（#5469 P8 前段）

日誌の書き出しから、クローンの本セッションの 1 ターンについて次を起点別に出す、**読むだけ**のスクリプト。

- **N**: そのターンのモデル要求の本数（`turn_timing.sdk.numTurns`）。道具を 1 回呼ぶたびに 1 本増える。
- **C**: 要求 1 本あたりの平均の文脈（`turn_timing.tokens.cacheRead ÷ N`）と、ターンの終わりの文脈（`turn_timing.contextTokens`）。
- **P**: 要約（auto-compact）直後の文脈（`turn_usage.compactions[].postTokens`）。要約の直前は `preTokens`、閾値は `context_usage.contextUsage.autoCompactThreshold`。
- 式 `cacheRead ≒ N × 文脈` が実測で成り立つかの残差、会話の履歴の内訳（`messageBreakdown`）、道具の回数。
- 各表に、#5469 P8 前段で置いた仮定（P=86K、閾値 267K、報告 N≒4.0・C≒17.6万、起点別 N）と並べた「実測 ÷ 仮定」と判定（±25%）の列がある。

ネットワークへは出ない。本文（発言・報告・道具の引数や結果）は読まず、出力にも載らない（数と道具の名前だけ）。ただし取得を指示している `external_event` は、`summary` に外部の本文をそのまま持つ。つまり**書き出したファイルには外部の本文が入る**ので、取り扱いに注意すること。スクリプトが読むのは `external_event` の `source` と `at` だけである。鍵・接続文字列・URL はこのスクリプトにも持たない。

## 手順（取得は人間が自分の手で行う）

1. 窓は **1 日単位から**始める（日誌は 1 日で数 GB になりうる。型で絞ることと窓を切ることが必須）。
2. 読み取りだけで書き出す。`GET /journal` に次を付ける（認証は自分の手で。書き込みは要らない）:
   - `type=turn_timing,turn_usage,context_usage,external_event`
   - `since=<UTC の日の始め>` `until=<翌日の始め>` `order=asc` `limit=1000`
   - 続きは、応答の `next.id` / `next.at` を `afterId` / `afterAt` に組で渡す（最後の行の id/at ではなく、応答の `next` を使う）。`entries` が空でも `next` が null でなければ続きがある。`next` が null で終端。
   - `type` に知らない値を入れると 400 になる。上の 4 つは日誌の型。`exchange` などは要らない（本文を含むので取らないこと）。`external_event` も `summary` に外部の本文を含むが、枠の知らせの推定に `source` が要るので取る。
3. 書き出したファイルを渡す: `node scripts/pnc-census.mjs <ファイル> [<ファイル> ...]`。表が標準出力へ出る（Markdown）。

## 受ける形

次のどれでもよい。複数ファイルを渡せる。同じ `id` の行は 1 回だけ数える。

- `GET /journal` の応答 JSON（`{ "entries": [...], "next": ... }`）。頁ごとのファイルを複数渡す。応答の配列でもよい。
- 日誌の行の配列（JSON）。
- JSONL（1 行 1 JSON。各行は日誌の行、または `{ "entries": [...] }` の封筒）。

**`journal_read`（クローンの道具）の出力は整形したテキストで、欄が落ちているので読めない。**`GET /journal` の JSON を使うこと。

## 読み方

- 「—」と「取れなかった」の列は、その欄が無い版・行の件数。0 には丸めない。母数が小さい行（p90 など）は参考。
- 起点は `turn_timing.triggers` から、束の中の優先順位（人間 > 報告 > 外部 > 定期 > 発意）で 1 つに寄せる。蒸留だけのターンは「その他」。
- 枠の知らせは、外部だけの束で、ターンの前後に `external_event` の `source=runner-registry` が在る回を数える（推定）。`runner-registry` には復旧の知らせも混ざるので、枠の知らせの推定は多めに出うる。クローンが受ける枠の知らせのうち `manager_message`（`quotaStop`）は日誌の型だけでは見分けられないので「報告」に入る。
- `turn_usage`・`context_usage` は `layer=clone` かつ `site=session` の行だけを、時刻が最も近い `turn_timing`（30 秒以内）へ結ぶ。結べなかった件数は表に出る。
- `r1 = cacheRead ÷ (N × contextTokens)`、`r2 = (input + cacheRead + cacheCreation) ÷ (N × contextTokens)`。contextTokens はターンの終わりの値なので、ターン内で文脈が伸びるぶん r は 1 以下に出るのが自然。r2 が 1 に近ければ「要求ごとに文脈の全部を送る」という式が成り立っている。
- `tokens` は clone/session のメインループ（`result.usage`）の値で、サブエージェントや要約の呼び出しは含まない。台帳（`GET /usage`）の値とは尺度が違う（#5397 の食い違いの件）。

## 試験

`scripts/pnc-census.test.ts`（合成データ。手計算と一致、欄欠けの行・不正行・重複・要約の境界を含む）。
