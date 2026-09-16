/**
 * `check-pr-title-type.mjs` の判定だけを切り出したもの（Issue #1097）。
 *
 * ## 何を塞ぐために在るか
 *
 * **GitHub の squash マージは、コミットの件名ではなく PR のタイトルを件名として
 * 焼く。** ⟹ 積んだコミットが全部 `<type>: <description>` でも、PR のタイトルに
 * 型が無ければ `main` に残る件名から型が消える。実測（Issue #1097 本文、
 * 2026-09-16 観測）: `main` 直近200本のうち **14本**が型を持たない（`fe16d57` は
 * `[CI未起動]` の印が手前に付いているだけで型は在るので、15本から除いた）。
 *
 * **これは #1020（`no-attribution-trailers`）と同じ機構の、同じ向きの漏れである。**
 * あちらは PR **本文** → コミットメッセージへ焼かれる経路に門を置いた。こちらは
 * PR **タイトル** → コミット件名で、門が無かった側である。
 *
 * ⟹ この門も **fail-closed** で書く。タイトルが読めなかったら「型が在った」では
 * なく赤くする（下の `unreadable` verdict）。
 *
 * ## なぜ repo のファイルも git の履歴も走査しないか
 *
 * `no-attribution-trailers` と同じ理由（#785 の族）。この歯は fixture として
 * 規約違反のタイトルの逐語を持つので、repo を走査する形にすると自分の fixture を
 * 「見つけた」と誤検出する。**読むのはこの PR のタイトル1本だけである。**
 *
 * ## 既存の14本は対象外
 *
 * **この門は「これから」しか塞がない。** 既に `main` に入っている14本を検出・
 * 修正する仕組みではない（`AGENTS.md`「履歴を書き換えない」。`no-attribution-trailers`
 * の「既存の84本は対象外」と同じ決定）。
 *
 * ## 判定できない、という3つ目の状態を持つ
 *
 * `AGENTS.md`「静かに失敗する道具」: 2値にすると、判定できない場合がどちらかへ
 * 黙って倒れる。だからここも3値で答える——`ok` ／ `missing-type` ／
 * `unreadable`（タイトルを取得できなかった）。**倒す先は赤である**（後者2つは
 * どちらも終了コード1）。
 */

/**
 * 規約の型（`AGENTS.md`「リポジトリの約束」の逐語:
 * `grep -Fn -- 'type は feat / fix / refactor / docs / test / chore / perf / ci' AGENTS.md`）。
 *
 * **大小文字は区別する。** `no-attribution-trailers` が大小文字を無視するのとは
 * 逆向きだが、理由は同じ fail-closed である——あちらは「印が在ること」を探すので
 * 広く取るほうが見逃さない側で、こちらは「型が在ること」を確かめるので**狭く
 * 取るほうが見逃さない側**になる。そして `main` の実測（直近400本）に
 * `Feat:` のような大文字始まりの反例は無い。
 */
export const CONVENTION_TYPES = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'ci'];

/**
 * 型の手前に置いてよい印（`[CI未起動]` など）。**任意個を許し、剥がしてから
 * 型を見る。**
 *
 * **根拠は「規約に書いてあるか」ではなく「`main` に実在するか」で引いた。**
 * この形は repo 自身の自動化が出している——
 * `grep -Fn -- 'title="[CI未起動] $title"' .github/scripts/open-claude-sdk-pr.sh`。
 * ⟹ 落とす形にすると、**CI が起きなかった夜の SDK 更新 PR が必ず赤くなる。**
 * Issue #1097 自身も `fe16d57`（`[CI未起動] chore: …`）を「型を持っている」と
 * 数えている。
 *
 * **印だけで型が無い形（`[併設] SDK 更新 PR に…`、実在する `ed21b12`）は落ちる。**
 * 剥がした後に型が無いからで、これも Issue の数え方と一致する。
 */
const LEADING_MARKERS = /^(?:\[[^\]]*\]\s*)+/;

/**
 * 型の検査。`(scope)` を任意で許す。
 *
 * **`(scope)` を許す根拠も実測である。** 規約の逐語は `<type>: <description>` で
 * `(scope)` に触れていないが、`main` 直近400本中 **18本**が
 * `fix(scope): …` の形で実在する（2026-09-16 観測）⟹ 落とすと確立した慣行を
 * 赤くする。
 *
 * **逆に `feat!: …`（破壊的変更の `!`）は許さない。** 直近400本で **0本**、
 * 規約の逐語にも無い ⟹ **慣行が無いものまで先回りで広げない。** 要るなら規約を
 * 変える判断であって、門が勝手に決めることではない。
 *
 * `: ` の後ろには**空白以外の文字が1つ以上要る**（`chore: ` だけの件名を通さない）。
 * コロンの直後の空白1個は必須（`chore:x` は落とす）。
 */
const TYPE_PATTERN = new RegExp(`^(${CONVENTION_TYPES.join('|')})(\\([^)]*\\))?: (?=.*\\S)`);

/**
 * タイトルの先頭から `[…]` の印を剥がす。
 *
 * @returns {{ stripped: string, markers: string[] }} `markers` は剥がした印
 *   （`[CI未起動]` のような角括弧ごとの文字列）。剥がさなかったら空配列。
 */
export function stripLeadingMarkers(title) {
  if (typeof title !== 'string') return { stripped: '', markers: [] };
  const matched = title.match(LEADING_MARKERS);
  if (matched === null) return { stripped: title, markers: [] };
  const markers = matched[0].match(/\[[^\]]*\]/g) ?? [];
  return { stripped: title.slice(matched[0].length), markers };
}

/**
 * PR のタイトルが `<type>: <description>` の形を持つかを判定する。
 *
 * @param {{ title: string|null }} input `title` が `null` なら「取得できなかった」
 *   を意味する（**空文字とは区別する**——GitHub は空のタイトルを許さないので、
 *   空文字が来ることは通常ありえないが、来たとしてもそれは「型が無い」であって
 *   「読めなかった」ではない）。
 * @returns {{ verdict: 'ok'|'missing-type'|'unreadable', title: string,
 *   stripped: string, markers: string[] }}
 */
export function evaluatePrTitleType({ title }) {
  if (typeof title !== 'string') {
    return { verdict: 'unreadable', title: '', stripped: '', markers: [] };
  }

  const { stripped, markers } = stripLeadingMarkers(title);
  const verdict = TYPE_PATTERN.test(stripped) ? 'ok' : 'missing-type';
  return { verdict, title, stripped, markers };
}

/**
 * 判定を、人が読んで次の一手が決まる文へ畳む（`check-no-attribution-trailers-core.mjs`
 * の `formatVerdict` と同じ方針——ヘッダに何を判定したかを名乗り、`unreadable`
 * では読めなかったこと自体を明言する）。
 *
 * **`missing-type` のときは、なぜこの門が在るのかを1行で言う。** タイトルを直す
 * のは書き手で、書き手はたいてい「コミットは規約どおりに書いた」つもりでいる
 * （Issue #1097 の出どころがまさにそれ）ので、**squash が見るのは PR の
 * タイトルのほうだ**と出力の側から伝えないと、直す理由が伝わらない。
 */
export function formatVerdict(prNumber, result) {
  const header = `check-pr-title-type(#${prNumber}):`;
  switch (result.verdict) {
    case 'unreadable':
      return (
        `${header} 判定できなかった —— PR のタイトルを読めなかった` +
        '（fail-closed。「型が在った」ではなく赤くする）'
      );
    case 'missing-type':
      return [
        `${header} NG —— PR のタイトルに規約の型（<type>: ）が無い`,
        `  タイトル: ${result.title}`,
        ...(result.markers.length > 0
          ? [`  （先頭の印 ${result.markers.join(' ')} を剥がした後: ${result.stripped}）`]
          : []),
        `  型は ${CONVENTION_TYPES.join(' / ')} のどれか。<type>: <description> の形にする`,
        '  （scope 付き fix(foo): … と、先頭の印 [CI未起動] chore: … は通る）',
        '  ⚠️ squash マージが件名に焼くのは、コミットの件名ではなく PR のタイトルである',
      ].join('\n');
    case 'ok':
      return `${header} OK —— PR のタイトルが <type>: <description> の形を持つ: ${result.title}`;
    default:
      return `${header} 未知の verdict: ${result.verdict}`;
  }
}
