/**
 * `check-pr-line-number-citations.mjs` の判定だけを切り出したもの（Issue #1192 の
 * N3 に対応する）。
 *
 * ## 何を塞ぐために在るか
 *
 * `AGENTS.md`「リポジトリの約束」の逐語（`grep -Fn -- '他のファイルを出典として指すときは、行番号を単独の出典にしない。逐語の一部かシンボル名で指す' AGENTS.md`）:
 *
 * > 他のファイルを出典として指すときは、行番号を単独の出典にしない。逐語の一部か
 * > シンボル名で指す（`grep -Fn -- '<逐語>' <path>` / `<path>` の `<関数名>`）。
 * > **この文書・コードの注釈・PR 本文のどれでも同じである**
 *
 * 理由（同じ節から）: 行番号は移動しても消えても読む側から区別できない・生まれた
 * 時点で間違っていても正しく見える・`grep` で当たる形は書いた側が実行した検算が
 * 残るが行番号には無い。
 *
 * この規約を測る歯は既に在る（`scripts/agents-md-references.test.ts`。`AGENTS.md`
 * 本体と `.claude/**` / どの階層かの `src/**` / `apps/web/app/**` / `scripts/**`）。
 * ⚠️ **だが「PR 本文のどれでも同じである」と書いてある側——PR 本文——を測る門は
 * 無かった**（実測: `check-pr-vanished-footprint` / `check-no-attribution-trailers`
 * / `check-pr-closing-keywords` の3本はどれも PR 本文を読むが、「行番号」を1文字も
 * 見ていない）。この門はその穴を埋める。
 *
 * ## 判定ロジックの出所（重複を作らない）
 *
 * **フェンス（```` ``` ````）の区間検出は `check-pr-closing-keywords-core.mjs` の
 * `computeLineStarts` / `computeFenceIntervals` を import して使い回す。** 理由:
 *
 * - あちらは `issue-intent-hint-core.mjs`（#1134）が既に2本目の呼び出し元として
 *   使い回している——**「フェンスの中を見ない」という判断はどの門でも同じで
 *   なければならない**、という前例がこの repo に既にある。この門はその3本目の
 *   呼び出し元になる。
 * - もう1つの候補は `scripts/agents-md-references.test.ts` の
 *   `proseLinesWithFenceState`（CommonMark 準拠のフェンス状態機械。`~~~` も
 *   `//`/`*` の前置きも扱う、より厳密な実装）だが、**これは `.test.ts` に埋まった
 *   TypeScript であり、`scripts/*.mjs` はどれも素の Node（`node ./scripts/*.mjs`。
 *   `package.json` の `scripts` を見よ）で走る——`.mjs` から `.test.ts` を import
 *   した前例はこの repo に無い。** 切り出して両方から使う形（`proseLinesWithFenceState`
 *   を `-core.mjs` へ動かし、`agents-md-references.test.ts` 側の import を書き換える）
 *   も検討したが、**あの歯は2178行・多数の describe を持つ既存の門であり、
 *   「切り出しで判定が1ミリも変わらないこと」を保証する費用のほうが、
 *   ここで新しく（しかも小さい）フェンス検出を書く費用より大きい**
 *   （`AGENTS.md`「テストを弱めずに直す」——弱める・壊す可能性を持ち込むくらいなら
 *   重複のほうがましという判断）。⟹ **フェンス検出は `check-pr-closing-keywords-core.mjs`
 *   から再利用し、`agents-md-references.test.ts` には一切手を触れない。**
 * - `path:行番号` そのものの正規表現（下の `PATH_LINE_NUMBER_PATTERN`）は
 *   `findLineNumberCitations`（`agents-md-references.test.ts`）と同じ形
 *   （`([A-Za-z0-9_@.][A-Za-z0-9_./@-]*):(\d+)(?:-(\d+))?`）を採ったが、これは
 *   export された関数の import ではなく**1行の正規表現リテラルの参考にした
 *   だけ**である——公開 API ではない内部定数を複製しても「同じ判断を2箇所で
 *   保守する」という重複の実害（変更を1箇所に入れ忘れる）が生まれない規模である。
 *
 * ## 弾かない形（意図している false negative）と、意図して弾く形
 *
 * **この repo の方針は偽陽性を偽陰性より重く見る**（PR 本文は生の出力・
 * スタックトレースを大量に引用するので、素朴な正規表現は誤爆する）。実測
 * （2026-09-19、直近マージ済み PR 200本。`gh api graphql` で本文を取得し、この
 * 判定をそのまま適用）に基づき、次を「弾かない」側に倒した:
 *
 * 1. **フェンス（```` ``` ````）の中**: `agents-md-references.test.ts` が同じ理由
 *    で除外している（「あそこに在るのは出典ではなく生の出力」）。上の
 *    `computeFenceIntervals` で同じ判断を再利用する。
 * 2. **インラインのコードスパン（バッククォート1つ）は除外しない（弾く）。**
 *    ⚠️ これは `check-pr-closing-keywords` の「バッククォートで囲んでも GitHub は
 *    閉じる」と同じ向きだが、理由は別である——**実測でこちらは真逆の結論になった**。
 *    200本の実測で、`path:行番号` が実在ファイルへ解決する例は7 PR・20件、
 *    その**全件がインラインのバッククォートで囲まれていた**。実例2件（逐語の
 *    `path:行番号` 形をそのまま地の文に書くと、この doc 自身が
 *    `scripts/agents-md-references.test.ts` の path:行番号 出典検査に引っかかる。
 *    ⚠️ #891 より前はフェンスで囲むだけで足りていたが、#891 は「フェンスの中を、
 *    落とす前にもう一度だけ見る」歯を足したため、フェンスに加えて**コロンの
 *    直後に数字が来ない形へ言い換えてある**——ファイル名と行番号はどちらも
 *    実測のまま1文字も変えていない、変えたのは区切り文字だけである）:
 *    ```
 *    PR #1205: `scripts/test.mjs`（118行目。本番経路）
 *    PR #1001: `packages/core/src/schema.ts`（532行目・556行目）
 *    ```
 *    この repo の慣行は「ファイルパスをバッククォートで囲む」ことそのものであり、
 *    もしインラインコードスパンを除外すると **20件中19件が二度と検出されない**
 *    （測定: バッククォート除外ありだと 200本中 findings は1本・1件まで落ちる）。
 *    ⟹ **除外すると門が実質何も測らなくなる**ので、ここは弾く側（除外しない）
 *    に倒した。
 * 3. **URL の中**: 構造的に弾かれる。GitHub の blob URL は行番号を `#L12` の形
 *    （コロンではなくハッシュ）で持つので、`path:行番号`（コロン+数字）の正規表現
 *    自体に一致しない。`http://host:8080` のような `host:port` は正規表現には
 *    一致しうるが、`host` がこのリポジトリの実在ファイルに解決することは
 *    通常無いので、下の 5. の実在ファイル判定で弾かれる。
 * 4. **時刻**（`15:04:46Z`、`2026-09-17T11:54:42Z`）: 実測（200本、フェンス除外の
 *    みで実在ファイル判定を外した場合）で、この形の raw match は 167件中
 *    147件（88%）を占めた。**すべて実在ファイル判定（5.）で弾かれる**——
 *    `2026-09-17T01:59` のようなトークンが repo 内の実在パスに解決することは
 *    無い。
 * 5. **実在しないファイルを指すトークンは弾く**（`isRepoFile`。呼び出し側が注入する
 *    純関数）。腐るのは「このリポジトリの実在ファイルを行番号で指したとき」だけ
 *    ——`AGENTS.md`「リポジトリの外（`node_modules` など）を指すときは、版を書いた
 *    うえで行番号を補助として添えてよい」とも整合する（外部依存は最初から対象外に
 *    なる）。実測（200本）: フェンス除外だけの raw match は167件、うち実在ファイル
 *    に解決するのは20件（12%）——`isRepoFile` 判定が無いと門は時刻・ポート番号
 *    まみれで実用にならない。
 * 6. **`grep -n` / `grep -Fn` の出力そのもの**: フェンス除外で大半は落ちるが、
 *    フェンス外に1行で貼る形も在りうる（この repo の実測200本には1件も無かった
 *    ——下の「確かめていないこと」）。`grep -n` の生出力の形は `path:行番号:内容`
 *    で、マッチした `path:行番号` の直後にもう1つコロンが続く。**この形
 *    （マッチ直後の文字が `:`）を弾く**——`AGENTS.md`「生の出力（スタックトレース・
 *    過去の実測）の中の行番号は書き換えない。あれは出典ではなく証拠である」と同じ
 *    向き。実測200本ではこの規則が働く例は0件だったが、安全側の余地として残す
 *    （偽陽性を減らす側にしか効かないので、実測が0件でも害は無い）。
 *
 * ## ⚠️ 確かめていないこと
 *
 * - **`~~~` フェンスは扱っていない**（`computeFenceIntervals` が backtick 3つ以上
 *   だけを見る。`agents-md-references.test.ts` の `proseLinesWithFenceState` は
 *   `~~~` も扱うが、上の理由でこちらは再利用していない）。200本の実測corpus には
 *   `~~~` フェンスを使う PR が無かった——出現したら実測してから扱いを決めること。
 * - **200本という標本は `pr-closing-keywords` / `pr-vanished-footprint` の実測
 *   （150本）と同じ族の抜き取りだが、全件（マージ済み全PR）ではない。**
 * - **6.（`grep -n` 出力）の「弾く」判断は実測0件のまま採用した。** 実例で
 *   確かめられていない。
 * - **インラインコードスパンの入れ子・エスケープ**（`` `` foo ` bar `` `` の
 *   ような形）は `computeInlineCodeIntervals` 同様この門も特別扱いしていない
 *   （そもそもインラインコードスパンを除外していないので、この門には効かない
 *   ——2. を見よ）。
 *
 * ## required にしない理由（`pr-closing-keywords` / `pr-vanished-footprint` と同じ族）
 *
 * この門は「書いた側の意図」を読めない——インラインコードスパンも弾かない選択の
 * 結果、実在ファイルへの `path:行番号` の言及はほぼ機械的に赤くなる（実測: 200本
 * 中7本が該当）。その中には「過去に壊れていた出典を直した経緯の説明」（PR #892の
 * ような回）が混ざりうる——本物の違反かどうかを機械は判定できない。required に
 * するなら逃げ道（ラベル等）を同時に設計する必要があり、それはこの PR の範囲外。
 * `.github/required-status-checks.json`（正本はあちら）は1文字も触らない。
 *
 * ## なぜ repo のファイルも git の履歴も走査しないか（#785 と同じ族）
 *
 * この門自身のテスト（`check-pr-line-number-citations.test.ts`）は fixture として
 * `path:行番号` の形の逐語を持つ。repo を走査する形にすると、その fixture 自身を
 * 「見つかった」と誤検出する自己参照になる（`check-pr-closing-keywords-core.mjs`
 * / `check-pr-vanished-footprint-core.mjs` と同じ理由）。この門が読むのは**この
 * PR の本文だけ**である（`isRepoFile` は実在確認のためだけに repo を読むが、
 * これは走査ではなく1トークンごとの `stat` である）。
 *
 * ## verdict は3値
 *
 * `ok` / `found` / `unreadable`。`found` と `unreadable` はどちらも終了コード1
 * （`unreadable` は fail-closed。「無い」ではなく赤くする）。
 */

import { computeFenceIntervals, computeLineStarts } from './check-pr-closing-keywords-core.mjs';

/**
 * `path:123` / `path:123-456` の形の参照。`agents-md-references.test.ts` の
 * `findLineNumberCitations` と同じ形（doc 上の理由を見よ——export された関数の
 * import ではなく、正規表現の形だけを参考にした）。
 */
const PATH_LINE_NUMBER_PATTERN = /([A-Za-z0-9_@.][A-Za-z0-9_./@-]*):(\d+)(?:-(\d+))?/g;

/** `[start, end)` が intervals のどれかと重なるか。 */
function overlapsAny(intervals, start, end) {
  return intervals.some(([a, b]) => start < b && end > a);
}

/**
 * PR 本文（`text`）から `path:行番号` の形の出典を探す。
 *
 * - フェンスの中は見ない（上の doc 1.）。
 * - インラインのコードスパンは見る（上の doc 2. ——弾かない）。
 * - `isRepoFile(target)` が真を返すものだけを返す（上の doc 5.）。
 * - マッチ直後の文字が `:` の形（`grep -n` の生出力）は弾く（上の doc 6.）。
 *
 * @param {string} text
 * @param {(candidate: string) => boolean} isRepoFile
 * @returns {{ line: number, token: string, target: string, context: string }[]}
 */
export function findPathLineNumberCitations(text, isRepoFile) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const lines = text.split('\n');
  const lineStarts = computeLineStarts(lines);
  const fenceIntervals = computeFenceIntervals(lines, lineStarts);

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = lineStarts[i];

    PATH_LINE_NUMBER_PATTERN.lastIndex = 0;
    let m;
    while ((m = PATH_LINE_NUMBER_PATTERN.exec(line)) !== null) {
      const target = m[1];
      const token = m[0];
      // `PATH_LINE_NUMBER_PATTERN` は先頭1文字 + コロン + 数字を必須で要求する
      // ので、`token` が空文字になることは無い（`lastIndex` を手で進める
      // 空マッチ対策は不要——`g` フラグの exec は非空マッチのたびに前進する）。
      const matchStart = m.index;
      const matchEnd = matchStart + token.length;
      const absStart = lineStart + matchStart;
      const absEnd = lineStart + matchEnd;

      if (overlapsAny(fenceIntervals, absStart, absEnd)) continue;

      // grep -n / grep -Fn の生出力（`path:行番号:内容`）——マッチの直後が
      // もう1つのコロンなら「出典」ではなく証拠として弾く（上の doc 6.）。
      if (line[matchEnd] === ':') continue;

      if (isRepoFile(target)) {
        out.push({ line: i + 1, token, target, context: line.trim().slice(0, 200) });
      }
    }
  }
  return out;
}

/**
 * PR 本文から `path:行番号` の出典を判定する。
 *
 * @param {{ body: string|null }} input `body` が `null`（または文字列でない）
 *   なら「取得できなかった」を意味する（**空文字とは区別する**）。
 * @param {{ isRepoFile: (candidate: string) => boolean }} deps
 * @returns {{ verdict: 'ok'|'found'|'unreadable', findings: { line: number, token: string, target: string, context: string }[] }}
 */
export function evaluatePrLineNumberCitations({ body }, { isRepoFile }) {
  if (typeof body !== 'string') {
    return { verdict: 'unreadable', findings: [] };
  }
  const findings = findPathLineNumberCitations(body, isRepoFile);
  return { verdict: findings.length > 0 ? 'found' : 'ok', findings };
}

/**
 * 判定を、人が読んで次の一手が決まる文へ畳む（`check-pr-closing-keywords-core.mjs`
 * / `check-pr-vanished-footprint-core.mjs` の `formatVerdict` と同じ方針）。
 */
export function formatVerdict(prNumber, result) {
  const header = `check-pr-line-number-citations(#${prNumber}):`;
  switch (result.verdict) {
    case 'unreadable':
      return `${header} 判定できなかった —— PR 本文を読めなかった（fail-closed。「無い」ではなく赤くする）`;
    case 'found':
      return [
        `${header} NG（required ではない） —— 実在するファイルを \`path:行番号\` の形で指す出典が見つかった`,
        ...result.findings.map((f) => `  行${f.line} [${f.token}]: ${f.context}`),
        '  次の一手:',
        "   - 逐語の一部かシンボル名で指す（`grep -Fn -- '<逐語>' <path>` / `<path>` の `<関数名>`）",
        '   - 生の出力（スタックトレース・過去の実測）としてフェンス（```）で囲む',
        '   - 過去に壊れていた出典を直した経緯を説明しているだけなら、意図どおりなので直す必要は無い（この門は required ではない）',
      ].join('\n');
    case 'ok':
      return `${header} OK —— 実在するファイルを \`path:行番号\` の形で指す出典は無い`;
    default:
      return `${header} 未知の verdict: ${result.verdict}`;
  }
}
