/**
 * PR / Issue の本文に置く「出所の刻印」（`<!-- alteroid-origin: ... -->`）を読み、
 * 欠落・不整合を判定する（Issue #850）。**判定ロジックはここに置く。**
 * `check-base-overlap-core.mjs` / `check-sdk-quotes-core.mjs` と同じ分け方——
 * この `.mjs` は**依存を持たない・ネットワークもファイル I/O も持たない**。
 * 合成した文字列だけで全判定を撃てるようにするためで、`check-pr-origin.mjs`
 * （薄い CLI）が `PR_BODY` 環境変数から読んだ本文をここへ渡す。
 *
 * ## 刻印の名前・値の語彙
 *
 * 刻印の名前（`alteroid-origin`）と値の語彙（`mgr-` 接頭辞／`clone`／`human`）は
 * `packages/core/src/origin-marker.ts` / `packages/core/src/usage.ts`
 * （`CLONE_ACTOR_ID`）が正本である。**この `.mjs` はそれらを import できない**
 * （`check-*-core.mjs` は依存なしの約束で、TypeScript パッケージを跨げない）ので、
 * `CLONE_VALUE` / `HUMAN_VALUE` は下で文字列として持つ。**これは重複であって、
 * 重複が2箇所に分かれていることそのものが穴である** —— だから
 * `scripts/check-pr-origin.test.ts` に、`formatOriginMarker(CLONE_ACTOR_ID)` /
 * `formatOriginMarker(ORIGIN_HUMAN)` の出力をこの `parseOriginMarker` へ通して
 * 期待どおりの verdict になることを確かめる歯を置いてある——**書き手（TS）と
 * 読み手（この .mjs）が別々に持つ値を、歯で繋いでいる。** 値を変えるならその歯を
 * 通して両方直すこと。
 *
 * ## 判定表
 *
 * | 状態 | verdict | 備考 |
 * |---|---|---|
 * | 刻印1つ、値が `mgr-` で始まる | `manager` | `managerId` にその値が入る |
 * | 刻印1つ、値が `clone` | `clone` | |
 * | 刻印1つ、値が `human` | `human` | |
 * | 刻印が0個 | `missing` | ⛔ `human` に倒さない（下の理由） |
 * | 刻印は在るが値が上のどれでもない | `invalid` | |
 * | 刻印が2つ以上で値が食い違う | `conflict` | |
 * | 刻印が2つ以上で値が同じ | その値の verdict | 単発と同じ判定を通す |
 * | 刻印が0個・かつ `createdAt` が `ORIGIN_GATE_SINCE` より前 | `legacy` | `decideGateVerdict` だけが返す（下） |
 *
 * **`missing` を `human` に倒さない理由（Issue #850 の受け入れ基準3そのもの）。**
 * 「出所が分からない」と「出所が無い（人間が直接作った）」は別の状態である。
 * 倒した瞬間、刻印を忘れたマネージャー／クローンの PR がオーナー本人の PR として
 * 数えられ、クローンが自分の成果を数え損ねる。
 *
 * ## `body` が `null` / `undefined` / 空文字のときの扱い
 *
 * **`missing` に倒す。** `PR_BODY` が空（GitHub は本文なしの PR で空文字列を返す）
 * のときも、環境変数が渡っていないときも、「刻印を探したが1つも見つからなかった」
 * という状態と区別する理由が無い —— どちらも「この PR には出所の手がかりが無い」
 * という同じ結論になる。
 *
 * ## フェンスの中は数えない
 *
 * **理由**: 刻印の形を説明する PR 本文（このリポジトリ自身の PR がまさにそう
 * なりうる——刻印の例をコードブロックで示す）が、それだけで `conflict` や
 * `invalid` を自分に対して作ってしまう。
 *
 * **フェンス判定はこの `.mjs` の中に自前で持つ**（依存なしの約束のため、
 * `packages/core/src/markdown-span.ts` や `scripts/agents-md-references.test.ts`
 * の `proseLinesWithFenceState` を import できない）。ただし**同じ欠陥を
 * 作らないよう、先にそれらを読んで同じ規則に合わせてある**——CommonMark の
 * フェンス付きコードブロックの規則
 * （https://spec.commonmark.org/0.31.2/#fenced-code-blocks）:
 *
 * 1. **開き**: 行頭（0〜3個の空白は許す）に同じ文字（`` ` `` または `~`）の
 *    3個以上の連続。**バックティックのフェンスに限り、開きの行の残り
 *    （info string）にバックティックが1個でも在れば開きとして扱わない**
 *    （PR #796 が固定した欠陥A: 1行に開閉が両方在る形——CommonMark はバック
 *    ティックのフェンスの info string にバックティックを許さないので、その行は
 *    フェンスの開きではなくインラインのコードスパンである）。`~` の info
 *    string はチルダを含んでよい（この非対称性も CommonMark どおり）。
 * 2. **閉じ**: 開いたときと同じ文字で、開いたときの連続長以上、後ろは空白のみ。
 * 3. フェンスの中の行はプローズに数えない（閉じた行自身も数えない）。
 * 4. 末尾まで閉じなかった場合は最後まで「フェンスの中」として扱う——
 *    `check-*-core.mjs` は「判定できない」の3値目を別に持たないので、閉じずに
 *    終わったフェンスの中身も同じ規則（数えない）へ倒す。**PR 本文で意図せず
 *    フェンスが閉じ忘れられた場合、その後ろの刻印も含めて数えなくなる**——
 *    これは `missing` 側（安全側）に倒れる欠落であって、値を捏造する側の欠落
 *    ではない。
 *
 * ## `legacy`（門より前に作られた PR）
 *
 * この門が `main` に入った時点で、**既に開いている PR は全部無印**である。
 * そこを一律で赤くすると、この改修と無関係な既存 PR が一斉に赤くなる。
 * Issue #850 の受け入れ基準1は「`main` に入ったコミットから委譲を機械的に
 * 引ける、**あるいは『引けない』が明示的に分かる**」と書いている ⟹ 古い PR は
 * 「赤」ではなく「引けない、と明示的に分かる」（`legacy`、exit 0）へ倒すのが
 * 基準そのものに書いてある正解である。
 *
 * **`parseOriginMarker` は本文だけを見る純関数のままにする。** 時刻の判定は
 * `decideGateVerdict`（下）という**別の**純関数に分け、`parseOriginMarker` の
 * 結果と `createdAt` を合わせて最終の verdict を出す。**2つを1つの関数に
 * 混ぜない** —— 本文の判定だけを固定したい歯（上の判定表の7行）が、時刻の
 * 都合に巻き込まれて読めなくなることを避けるため。
 *
 * **`legacy` になるのは「刻印が `missing`」のときだけである。** 刻印が在って
 * `invalid` / `conflict` なら、`createdAt` がどれだけ古くても赤のまま——
 * 「壊れた刻印」と「刻印を書く習慣が無かった時代の PR」は別の状態で、
 * 前者を `legacy` へ逃がすと壊れた刻印を見逃す口になる。
 *
 * **`createdAt` が取れない・壊れているときは fail closed** —— `legacy` へは
 * 逃がさず、本文の判定（`parseOriginMarker` の結果）をそのまま使う。門を
 * 通す側の値（`createdAt`）が信頼できないときに安全側（＝より赤くなりうる側）
 * へ倒すのは、`unmeasurable` を赤に倒す `check-base-overlap-core.mjs` の
 * `decideVerdict` と同じ考え方である。
 */

const MARKER_NAME = 'alteroid-origin';
const MANAGER_PREFIX = 'mgr-';
const CLONE_VALUE = 'clone';
const HUMAN_VALUE = 'human';

/** フェンスの開き（```` ``` ```` / `~~~`）を検出する正規表現。行頭0〜3空白まで許す。 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * `markdown` からフェンス付きコードブロックの中身を取り除いた本文を返す。
 * doc 冒頭「フェンスの中は数えない」の規則そのもの。
 */
export function stripFencedCode(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let inFence = false;
  let fenceChar = null;
  let fenceLen = 0;

  for (const line of lines) {
    if (!inFence) {
      const m = FENCE_OPEN_RE.exec(line);
      if (!m) {
        out.push(line);
        continue;
      }
      const marker = m[1];
      const markerChar = marker[0];
      const rest = m[2];
      if (markerChar === '`' && rest.includes('`')) {
        // 欠陥A（PR #796）: 同じ行にバックティックの開閉が両方在る ⟹
        // info string がバックティックを含むので、これはフェンスの開きではなく
        // インラインのコードスパンである。プローズとして残す。
        out.push(line);
        continue;
      }
      inFence = true;
      fenceChar = markerChar;
      fenceLen = marker.length;
      continue; // 開きの行自身はプローズに数えない
    }

    // フェンスの中。同じ文字・同じ長さ以上・後ろ空白のみの行だけが閉じる。
    if (new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}\\s*$`).test(line)) {
      inFence = false;
      fenceChar = null;
      fenceLen = 0;
    }
    // 閉じなかった行・閉じた行自身は、どちらもプローズには含めない。
  }

  return out.join('\n');
}

/**
 * `stripFencedCode` を通した本文から、刻印の値を全部（出現順で）拾う。
 * 値は空白を含まない前提（`mgr-` id・`clone`・`human` はどれも1トークン）
 * なので `\S+` で取る——想定外に空白入りの値を書かれた場合は最初のトークンだけ
 * を拾い、以降は info string の残りとして無視される（既知の限界）。
 */
function extractMarkerValues(prose) {
  const re = new RegExp(`<!--\\s*${MARKER_NAME}:\\s*(\\S+?)\\s*-->`, 'g');
  const values = [];
  let m;
  while ((m = re.exec(prose)) !== null) {
    values.push(m[1]);
  }
  return values;
}

/** 1つの値を verdict へ分類する（`manager` / `clone` / `human` / `invalid`）。 */
function classifyValue(value) {
  if (value.startsWith(MANAGER_PREFIX)) return { verdict: 'manager', managerId: value };
  if (value === CLONE_VALUE) return { verdict: 'clone' };
  if (value === HUMAN_VALUE) return { verdict: 'human' };
  return { verdict: 'invalid', value };
}

/**
 * PR / Issue の本文を判定する。上の判定表・doc がこの関数の正本。
 *
 * @param {string | null | undefined} body
 * @returns {
 *   | { verdict: 'manager', managerId: string, values: string[] }
 *   | { verdict: 'clone' | 'human', values: string[] }
 *   | { verdict: 'missing' }
 *   | { verdict: 'invalid', value: string, values: string[] }
 *   | { verdict: 'conflict', values: string[] }
 * }
 */
export function parseOriginMarker(body) {
  if (body === null || body === undefined || body === '') {
    return { verdict: 'missing' };
  }

  const prose = stripFencedCode(body);
  const values = extractMarkerValues(prose);

  if (values.length === 0) {
    return { verdict: 'missing' };
  }

  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    return { verdict: 'conflict', values };
  }

  return { ...classifyValue(distinct[0]), values };
}

/**
 * この門が有効になった境界時刻。**これは導出した値ではなく宣言した境界である**
 * ——「観測から測った」値ではないので、実測日を裏付けとして添えるいつもの
 * 作法（`AGENTS.md`「時刻の扱い」）はここでは当てはまらない。この日時より
 * 前に作られた PR には、そもそも刻印を書けという指示（マネージャー／クローンの
 * システムプロンプト、`packages/core/src/prompt.ts`）が一度も届いていない
 * ——だから「書かなかった」ではなく「書けと言われていなかった」であり、
 * `legacy` はその事実をそのまま名乗る値である。値を変えるのは人間の判断
 * （この門をいつから効かせるか）であって、この `.mjs` が自分で測り直す性質の
 * ものではない。
 */
export const ORIGIN_GATE_SINCE = '2026-09-11T20:00:00Z';

/**
 * `parseOriginMarker` の結果と PR の作成時刻を合わせて、最終の verdict を出す。
 * `legacy` の条件・`invalid`/`conflict` を `legacy` へ逃がさない理由・
 * `createdAt` が壊れているときに fail closed する理由は、上の doc
 * 「`legacy`（門より前に作られた PR）」を見よ。
 *
 * @param {{ body: string | null | undefined, createdAt: string | null | undefined }} input
 */
export function decideGateVerdict({ body, createdAt }) {
  const base = parseOriginMarker(body);
  if (base.verdict !== 'missing') return base;

  const createdAtMs = createdAt === null || createdAt === undefined ? NaN : Date.parse(createdAt);
  if (Number.isNaN(createdAtMs)) {
    // fail closed: createdAt が取れない・壊れている ⟹ legacy へは逃がさず、
    // 本文の判定（ここでは missing）をそのまま使う。
    return base;
  }

  if (createdAtMs < Date.parse(ORIGIN_GATE_SINCE)) {
    return { verdict: 'legacy' };
  }

  return base;
}
