/**
 * `check-no-attribution-trailers.mjs` の判定だけを切り出したもの（Issue #1020）。
 *
 * ## 何を塞ぐために在るか
 *
 * `AGENTS.md`「リポジトリの約束」は `Co-Authored-By:` トレーラを（コミット
 * メッセージにも PR 本文にも）付けない、そして `🤖 Generated with [Claude Code]`
 * も同じ決定の射程内であると定めている（人間の決定、2026-08-21 / 2026-09-15）。
 * だがこれまでは**規約が書いてあるだけ**で、それを機械で塞ぐ門が無かった。
 * 実測（Issue #1020 本文、2026-09-15T12:14Z 観測）: `main` 740本中 84本が
 * `🤖 Generated with` を、8本が `Co-Authored-By` を持つ。
 *
 * **今日の実害（1件、機序つき）**: PR #1018 の本文に `🤖 Generated with` が
 * 残ったまま squash マージされ、`main` の `63a33dd` のコミット本文に焼かれた。
 * 機序は2つ重なっている——(1) **squash マージは PR 本文をコミットメッセージへ
 * 写す**ので、本文に残っていれば履歴に入る、(2) マージ前の検査が fail-open
 * だった（`grep -c` は1件見つけても exit 0 を返すので、`;` で繋いだ後続が
 * 普通に走った。`AGENTS.md`「静かに失敗する道具」の1番目）。
 *
 * ⟹ この門は **fail-closed** で書く。本文かコミットメッセージが読めなかったら
 * 「見つからなかった」ではなく赤くする（下の `evaluateNoAttributionTrailers` の
 * `unreadable` verdict）。
 *
 * ## なぜ repo のファイルを走査しないか（#785 と同じ族）
 *
 * この門自身のテスト（`check-no-attribution-trailers.test.ts`）は、fixture として
 * `Co-Authored-By:` / `🤖 Generated with` の逐語を持つ。**repo 全体を走査する形で
 * 書くと、その fixture 自身を「見つかった」と誤検出する自己参照になる**
 * （Issue #785 と同じ形）。だからこの門が読むのは**この PR の本文と、この PR の
 * コミットメッセージだけ**であり、リポジトリのファイルは一切読まない。
 * `AGENTS.md` の該当節（「なぜ付けないか」の理由・「既に付いている分は履歴として
 * 残す」の決定）や、この門自身の doc・テストの fixture に逐語が在っても、
 * それらは対象外である。
 *
 * ## 既存の84本は対象外
 *
 * **この門は「これから」しか塞がない。** 既に main に入っている84本（+ 8本）を
 * 検出・修正する仕組みではない——`AGENTS.md`「これは受け入れた負債である」の
 * 決定どおり、履歴は書き換えない。
 *
 * ## 判定できない、という3つ目の状態を持つ
 *
 * `AGENTS.md`「静かに失敗する道具」: 2値にすると、判定できない場合がどちらかへ
 * 黙って倒れる。だからここも3値で答える——`clean`（見つからなかった。読めた
 * 上での不在）／ `found`（見つかった）／ `unreadable`（読めなかった）。
 * **倒す先は赤である**（`found` と `unreadable` はどちらも終了コード1）。
 */

/**
 * 検査する印。**マッチは大小文字を区別しない。**
 *
 * 実測（2026-09-15、`main` の実コミット。`6a74c9d`）で、同じ意味のトレーラが
 * 2つの表記で共存していることを確認した——`Co-Authored-By: Claude Opus 5
 * <noreply@anthropic.com>` と `Co-authored-by: Claude Opus 5
 * <noreply@anthropic.com>`（1文字違い、`a` の大小）が同じコミットメッセージの
 * 中に並んでいた。`AGENTS.md` の規約の逐語は `Co-Authored-By:`（大文字）だが、
 * **表記ゆれを見逃さないために大小文字を無視する**（fail-closed の向き——
 * 見逃しは「該当なし」を作る側なので、厳密な逐語一致より広く取る）。
 *
 * `🤖 Generated with` は実測（同日、84本全件のうち抜き取り確認）で表記ゆれが
 * 無かったが、同じ理由で大小文字は無視する。
 */
export const ATTRIBUTION_MARKERS = [
  {
    id: 'co-authored-by',
    label: 'Co-Authored-By:',
    pattern: /co-authored-by:/i,
  },
  {
    id: 'generated-with',
    label: '🤖 Generated with',
    pattern: /🤖\s*generated with/i,
  },
];

/**
 * `text` の中に印が在るかを見て、当たった印の `label` を返す（無ければ空配列）。
 *
 * `text` が文字列でない・空文字なら何も当たらない（PR 本文が無いことは
 * ありうるし、それ自体は「見つからなかった」であって `unreadable` ではない
 * ——`unreadable` は「取得そのものに失敗した」ときにだけ使う。呼び分けは
 * `check-no-attribution-trailers.mjs` 側が担う）。
 */
export function findAttributionMarkers(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return ATTRIBUTION_MARKERS.filter((marker) => marker.pattern.test(text)).map(
    (marker) => marker.label,
  );
}

/**
 * コミットの見出し（`messageHeadline`）と本文（`messageBody`）を、素の
 * コミットメッセージの形（1行目・空行・以降）へ組み立てる。
 *
 * `gh pr view --json commits` はこの2つに分けて返す
 * （`git log --format=%B` のような1本の文字列では返さない）ので、判定の前に
 * ここで合成する。**本文が空なら見出しだけを返す**（末尾に無駄な空行を作らない）。
 */
export function commitFullMessage(headline, messageBody) {
  const h = typeof headline === 'string' ? headline : '';
  const b = typeof messageBody === 'string' ? messageBody : '';
  return b.length > 0 ? `${h}\n\n${b}` : h;
}

/**
 * PR 本文とコミットメッセージ群から、印が残っていないかを判定する。
 *
 * @param {{ body: string|null, commits: { oid: string|null, headline: string, message: string }[]|null }} input
 *   `body` / `commits` が `null` なら「取得できなかった」を意味する
 *   （**空文字・空配列とは区別する**——PR 本文が空であることも、コミットが
 *   0件であることも、それ自体は正常な「読めた」結果でありうる）。
 * @returns {{ verdict: 'clean'|'found'|'unreadable', findings: { source: string, markers: string[] }[] }}
 */
export function evaluateNoAttributionTrailers({ body, commits }) {
  if (body === null || commits === null) {
    return { verdict: 'unreadable', findings: [] };
  }

  const findings = [];

  const bodyMarkers = findAttributionMarkers(body);
  if (bodyMarkers.length > 0) {
    findings.push({ source: 'PR 本文', markers: bodyMarkers });
  }

  for (const commit of commits) {
    const markers = findAttributionMarkers(commit?.message);
    if (markers.length === 0) continue;
    const oidShort =
      typeof commit?.oid === 'string' && commit.oid.length > 0
        ? commit.oid.slice(0, 7)
        : '(sha不明)';
    const headline =
      typeof commit?.headline === 'string' && commit.headline.length > 0
        ? ` "${commit.headline}"`
        : '';
    findings.push({ source: `commit ${oidShort}${headline}`, markers });
  }

  return { verdict: findings.length > 0 ? 'found' : 'clean', findings };
}

/**
 * 判定を、人が読んで次の一手が決まる文へ畳む（`check-pr-green-core.mjs` の
 * `formatVerdict` と同じ方針——ヘッダに何を判定したかを名乗り、`unreadable`
 * では読めなかったこと自体を明言する）。
 */
export function formatVerdict(prNumber, result) {
  const header = `check-no-attribution-trailers(#${prNumber}):`;
  switch (result.verdict) {
    case 'unreadable':
      return (
        `${header} 判定できなかった —— PR 本文かコミットメッセージを読めなかった` +
        '（fail-closed。「見つからなかった」ではなく赤くする）'
      );
    case 'found':
      return [
        `${header} NG —— Co-Authored-By: / 🤖 Generated with がまだ残っている`,
        ...result.findings.map((f) => `  ${f.source}: ${f.markers.join(', ')}`),
      ].join('\n');
    case 'clean':
      return (
        `${header} OK —— PR 本文・全コミットメッセージのどちらにも ` +
        'Co-Authored-By: / 🤖 Generated with が無い'
      );
    default:
      return `${header} 未知の verdict: ${result.verdict}`;
  }
}
