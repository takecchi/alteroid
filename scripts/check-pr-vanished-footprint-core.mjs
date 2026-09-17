/**
 * `check-pr-vanished-footprint.mjs` の判定だけを切り出したもの（Issue #1130）。
 *
 * ## 何を塞ぐために在るか
 *
 * **PR 本文が「`X` を変更した」と名乗っているのに、最終差分に `X` が入っていない
 * ことがある。** ⟹ squash マージで**その嘘が `main` のコミット本文へ焼かれ、二度と
 * 消せない。** 実物: `888724a2`（PR #1115、2026-09-16T21:15:17Z マージ）。本文は
 * 「`AGENTS.md` の…項に…追記」と書いたが、差分に `AGENTS.md` は入っていなかった
 * （途中のコミット `a1543d6c` で追記し、`624f27d2` で取り消したため）。
 *
 * Issue #1130 は当初「本文の主張（動詞つき）× 差分」という形（方向A）を検討したが、
 * 150本のマージ済み PR で実測したところ **92%の PR が1件以上ずれ、動詞に縛っても
 * 32%が赤くなり、そのうち本物は1件（適合率 ≈1.1%）** だった。理由は、この repo の
 * PR 本文がファイルパスを「変更した」ではなく「そこを見ろ（参照・引用）」の意味で
 * 置くのが主用法だからである。⟹ **方向Aは門として成立しない**（結果が赤でも情報を
 * 持たない）。
 *
 * 代わりに採ったのが**この門（方向A′、Issue #1130 の2件目のコメント）**——「本文の
 * 主張」全体ではなく、**この PR 自身が実際に触ったのに最終差分から消えたファイル**
 * だけを見る。分母が最初から小さいので（実測 150本中 `V` が非空なのは2本、延べ4件）、
 * 名指しと組み合わせても実測で 150本中1本（0.7%）しか赤くならず、しかもその1本が
 * 本物（#1115）だった。
 *
 * ## 判定の芯
 *
 * - `U` = **その PR の各コミットが触ったファイルの和集合**。**`parents` が2件以上の
 *   マージコミットは除外する**（マージコミットの `files` は「マージで取り込んだ側の
 *   全差分」を含みうるので、それを `U` に混ぜると無関係なファイルが `V` へ紛れ込む）。
 * - `F` = **最終差分**（このリポジトリでは `gh api repos/<repo>/pulls/<N>/files
 *   --paginate` の `.filename` を使う。`gh pr diff <N> --name-only` でも同じ集合が
 *   取れるはずだが、こちらを採ったのは他の取得（`U` 側のコミット一覧）と同じ
 *   `gh api` の形に揃えたかったからで、`gh pr diff` を避ける積極的な理由がある
 *   わけではない）。
 * - `V = U \ F`（＝ 途中のコミットで触ったのに、最終差分には居ないファイル。
 *   「消えた足跡」）。
 * - **本文が `V` の要素を名指ししているか**を見る。候補はインラインのコードスパン
 *   （`` `…` ``）の中身 `p` で、`v ∈ V` に対して次のどれかが成り立てば「名指しあり」:
 *   - **完全一致**: `p === v`
 *   - **末尾一致**: `v` が `'/' + p` で終わる（`tools.ts` が
 *     `packages/core/src/tools.ts` に当たる）
 *   - **ディレクトリ前方一致**: `v` が `p + '/'` で始まる（`packages/core` が
 *     `packages/core/src/tools.ts` に当たる。**`/` の境界を要求する**——境界の
 *     無い単純な `v.startsWith(p)` だと `p="packages/core"` が無関係な
 *     `v="packages/core-extra/foo.ts"` にも当たってしまう。当初の仕様案は
 *     境界を要求していなかったが、実装時にその誤りが見つかり修正した
 *     ——`p === v` は既に `exact` が取っているので、境界を要求しても本物の
 *     取りこぼしは増えない）
 * - **`V` が非空 かつ 名指しが1件以上 ⟹ 赤（`found`）。それ以外は緑（`ok`）。**
 *
 * ## ⛔ 動詞の判定を入れない（決定。変えない）
 *
 * Issue #1130 の実測で、動詞（「変更した」「追記した」等）に縛る形は誤検知率を
 * 92%→32%へ下げるが、**その動詞リストは実測で不完全だと分かっている**——「なし」
 * 「そのまま」「無変更」「てある」のような**否定・現状維持の言い回し**を取りこぼす
 * （Issue コメントの (iv-b) 「否定語の拡充」を通しても99件中8件がまだ否定語未対応
 * だった）。動詞の一覧を保守し続けるコストと、保守が追いつかない間に生まれる
 * 見逃し・誤検知の両方を抱えるより、**この一覧を持たない**ほうを選んだ。
 *
 * **腐る部品（自然文の動詞判定）を門に入れるより、赤が1本増えるほうを取る、という
 * 判断である**（実測: 方向A′は動詞を持たなくても150本中1本しか赤くならない——
 * PR #1007 がその1本で、本物ではない。下の「この門が拾えない族」と #1007 の歯の
 * コメントを見よ）。
 *
 * ## 赤のときに何と言うか（⛔ 「本文が嘘だ」とは言わせない）
 *
 * **この門は嘘を検出していない。** `V` が非空で名指しがあることは、範囲が縮んだ
 * 事実と、本文がまだそれに触れている事実を示すだけで、**本文が古いままなのか
 * 意図どおりなのかは判定できない**（例: #1070 は `V` に当たる話をしているが、
 * 記述どおりの経緯であり実害は無い、という形が `pr-closing-keywords` の側にも
 * 実例として在る）。⟹ 言えるのは:
 *
 * > このPRは `<v>` を途中のコミットで触ったが、最終的な差分には居ない。そして
 * > 本文が `<v>` を名指ししている。⟹ 本文がまだ古い主張を持っていないか確かめる
 * > こと。意図どおりなら直す必要は無い（この門は required ではない）。
 *
 * 該当した `v` ごとに、本文のどの文（行）で名指しされているかを最大200文字で出す
 * ——直す側が本文を読み返して探さずに済むように。
 *
 * ## この門が拾えない族
 *
 * **一度も触っていないファイルについて嘘を書いた場合は、原理的に拾えない。**
 * `V` は「このPRが実際に触ったが最終差分から消えたファイル」しか含まないので、
 * 一度も `U` に入らなかったファイルについての虚偽は `V` にも現れない。この門が
 * 塞ぐのは「範囲が途中で縮んだのに本文が追随していない」という特定の経路
 * （#1115 の経路そのもの）だけである。
 *
 * また、PR #1007 の実測（Issue #1130 コメント）が示すとおり、**動詞を判定しない
 * ため、「このPRではやらない・別PRへ送る」という文脈でパスが名指しされている
 * だけでも赤くなる**（本文は嘘をついていない）。これは fail-closed ではなく
 * 「情報量の低い赤が時々混じる」という設計上の代償であり、そのために **required
 * にしない**（下）。
 *
 * ## required contexts に入れない理由（`pr-closing-keywords` と同じ）
 *
 * **⛔ required にしない。理由は同じ族——この門も書いた側の意図を読めない**
 * （`V` が非空でも本文が正しいことはありうる。PR #1007 がまさにその実例）。
 * required にするなら、逃げ道（ラベル等の例外機構）を同時に設計しなければならず、
 * それはこの PR の範囲外の判断である。`.github/required-status-checks.json`
 * （protection の宣言。正本はあちら）は1文字も触らない。
 *
 * ## なぜ repo のファイルも git の履歴も走査しないか（#785 と同じ族）
 *
 * この門自身のテスト（`check-pr-vanished-footprint.test.ts`）は fixture として
 * ファイルパスの逐語（`AGENTS.md` 等）とインラインコードスパンの形を持つ。repo を
 * 走査する形にすると、その fixture 自身を「見つかった」と誤検出する自己参照になる
 * （`check-no-attribution-trailers-core.mjs` / `check-pr-closing-keywords-core.mjs`
 * と同じ理由）。この門が読むのは**この PR のコミット・差分・本文だけ**である。
 *
 * ## verdict は3値
 *
 * `ok` / `found` / `unreadable`。`found` と `unreadable` はどちらも終了コード1
 * （`unreadable` は fail-closed。「消えた足跡は無い」ではなく赤くする）。
 */

/**
 * 各コミットが触ったファイルの和集合 `U` を計算する。**`parentCount` が2件以上の
 * コミット（マージコミット）は除外する。**
 *
 * @param {{ parentCount: number, files: string[] }[]} commits
 * @returns {Set<string>}
 */
export function computeUnion(commits) {
  const union = new Set();
  for (const commit of commits) {
    if (!commit || commit.parentCount >= 2) continue;
    for (const file of commit.files ?? []) {
      if (typeof file === 'string' && file.length > 0) union.add(file);
    }
  }
  return union;
}

/**
 * 消えた足跡 `V = U \ F` を計算する。返り値はソート済み配列（決定的な出力にする
 * ため——`Set` の反復順は挿入順に依存し、`U` の作り方（コミットの順序）に結果が
 * 引きずられるのを避ける）。
 *
 * @param {Set<string>|string[]} union
 * @param {string[]} finalFiles
 * @returns {string[]}
 */
export function computeVanishedFootprint(union, finalFiles) {
  const unionSet = union instanceof Set ? union : new Set(union);
  const finalSet = new Set(finalFiles);
  return [...unionSet].filter((file) => !finalSet.has(file)).sort();
}

/**
 * 1つの候補パス `p` が `v` を名指ししているかを判定する。当たれば分類
 * （`exact` / `suffix` / `subpath`）を返し、当たらなければ `null`。
 *
 * 優先順位は完全一致 → 末尾一致 → ディレクトリ前方一致。ディレクトリ前方一致は
 * `v.startsWith(p + '/')`（`/` の境界を要求する）だけを見る——`v.startsWith(p)`
 * （境界無し）は使わない。境界が無いと `p="packages/core"` が無関係な
 * `v="packages/core-extra/foo.ts"` にも当たってしまうため（マネージャーの
 * 差し戻し、2026-09-17。`p === v` は既に `exact` が取っているので、`exact` を
 * 先に見る限り境界を要求しても本物の取りこぼしは増えない）。
 *
 * @param {string} v
 * @param {string} p
 * @returns {'exact'|'suffix'|'subpath'|null}
 */
export function matchNamedCandidate(v, p) {
  if (p === v) return 'exact';
  if (v.endsWith('/' + p)) return 'suffix';
  // `/` の境界を要求する。`v.startsWith(p)`（境界無し）を混ぜると、
  // `p="packages/core"` が `v="packages/core-extra/foo.ts"` にも当たってしまう
  // （マネージャーの差し戻し。2026-09-17）。`p === v` は既に `exact` が
  // 取っているので、ここは `p + '/'` の一形だけで足りる——本物の取りこぼしは
  // 増えない（ディレクトリ参照は必ず `/` の境界を持つ）。
  if (v.startsWith(p + '/')) return 'subpath';
  return null;
}

/** インラインコードスパンの正規表現（バッククォート対、行を跨がない）。 */
const INLINE_CODE_PATTERN = /`([^`\n]*)`/g;

/**
 * 本文からインラインコードスパンの出現をすべて取り出す。**行を跨ぐスパンは
 * 対象にしない**（Markdown のインラインコードは通常1行内で閉じるため。
 * `check-pr-closing-keywords-core.mjs` の `computeInlineCodeIntervals` と同じ
 * 単純化）。空のスパン（`` `` ``）は候補にしない。
 *
 * @param {string} body
 * @returns {{ content: string, line: string }[]}
 */
export function extractInlineCodeSpans(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const lines = body.split('\n');
  const spans = [];
  for (const line of lines) {
    INLINE_CODE_PATTERN.lastIndex = 0;
    let match;
    while ((match = INLINE_CODE_PATTERN.exec(line)) !== null) {
      if (match[1].length > 0) {
        spans.push({ content: match[1], line });
      }
      if (match[0].length === 0) INLINE_CODE_PATTERN.lastIndex++;
    }
  }
  return spans;
}

/** 行を最大200文字へ切り詰める（超えたら末尾に `…` を付ける）。 */
export function truncateExcerpt(line, max = 200) {
  const trimmed = line.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max) + '…';
}

/**
 * `V` の各要素について、本文のインラインコードスパンが名指ししているかを調べる。
 * 名指しがあった要素だけを返す（無ければそのファイルは結果に含まれない）。
 *
 * @param {string[]} vanished
 * @param {string} body
 * @returns {{ file: string, hits: { kind: 'exact'|'suffix'|'subpath', candidate: string, excerpt: string }[] }[]}
 */
export function findNamedMentions(vanished, body) {
  const spans = extractInlineCodeSpans(body);
  const results = [];
  for (const file of vanished) {
    const hits = [];
    const seen = new Set();
    for (const span of spans) {
      const kind = matchNamedCandidate(file, span.content);
      if (kind === null) continue;
      const excerpt = truncateExcerpt(span.line);
      const key = JSON.stringify([kind, excerpt]);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ kind, candidate: span.content, excerpt });
    }
    if (hits.length > 0) results.push({ file, hits });
  }
  return results;
}

/**
 * 判定の全体。`gh` を一切呼ばない純粋関数——テストは合成した入力だけで書ける。
 *
 * `commits` / `finalFiles` が `null`、`body` が文字列でなければ「取得できなかった」
 * とみなし `unreadable`（fail-closed）を返す。空配列・空文字列は「読めた」結果
 * として扱う（`check-pr-closing-keywords-core.mjs` の `evaluatePrClosingKeywords`
 * と同じ区別）。
 *
 * @param {{ commits: { parentCount: number, files: string[] }[]|null, finalFiles: string[]|null, body: string|null }} input
 * @returns {{ verdict: 'ok'|'found'|'unreadable', vanished: string[], mentions: ReturnType<typeof findNamedMentions> }}
 */
export function evaluatePrVanishedFootprint({ commits, finalFiles, body }) {
  if (!Array.isArray(commits) || !Array.isArray(finalFiles) || typeof body !== 'string') {
    return { verdict: 'unreadable', vanished: [], mentions: [] };
  }

  const union = computeUnion(commits);
  const vanished = computeVanishedFootprint(union, finalFiles);
  const mentions = findNamedMentions(vanished, body);
  const verdict = vanished.length > 0 && mentions.length > 0 ? 'found' : 'ok';

  return { verdict, vanished, mentions };
}

/**
 * 判定を、人が読んで次の一手が決まる文へ畳む（`check-pr-closing-keywords-core.mjs`
 * の `formatVerdict` と同じ方針）。
 *
 * @param {string|number} prNumber
 * @param {ReturnType<typeof evaluatePrVanishedFootprint>} result
 */
export function formatVerdict(prNumber, result) {
  const header = `check-pr-vanished-footprint(#${prNumber}):`;
  switch (result.verdict) {
    case 'unreadable':
      return (
        `${header} 判定できなかった —— PR のコミット一覧・最終差分・本文の` +
        'いずれかを読めなかった（fail-closed。「消えた足跡は無い」ではなく赤くする）'
      );
    case 'found':
      return [
        `${header} 要確認 —— 途中のコミットで触ったが最終差分から消えたファイルを、本文が名指ししている`,
        ...result.mentions.flatMap((m) => [
          `  このPRは \`${m.file}\` を途中のコミットで触ったが、最終的な差分には居ない。` +
            `そして本文が \`${m.file}\` を名指ししている。`,
          '  ⟹ 本文がまだ古い主張を持っていないか確かめること。意図どおりなら直す必要は無い（この門は required ではない）。',
          ...m.hits.map((h) => `    [${h.kind}] ${h.excerpt}`),
        ]),
      ].join('\n');
    case 'ok':
      return (
        `${header} OK —— 途中のコミットで触ったが最終差分から消えたファイルは無いか、` +
        '本文がそれを名指ししていない'
      );
    default:
      return `${header} 未知の verdict: ${result.verdict}`;
  }
}
