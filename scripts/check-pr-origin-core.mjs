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
 * | 刻印1つ、値が `automation` | `automation` → `authorType !== 'Bot'` なら `unverified` | `decideGateVerdict` だけが担保を見る（下「`automation` の担保と限界」） |
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
 * ## インラインのコードスパンの中も数えない（Issue #857）
 *
 * **`stripFencedCode` が落とすのはフェンス付きコードブロックだけである。**
 * しかも PR #796 の欠陥Aの直しは、**同じ行にバックティックの開閉が両方在る
 * 行をフェンスの開きとして扱わず、プローズとして残す**という分岐そのもの
 * だった——CommonMark はバックティックフェンスの info string にバックティック
 * を許さないため、その行はフェンスではなくインラインのコードスパン
 * （`` `inline code` `` の形）である、という判断は正しい。**しかし「フェンスの
 * 開きではない」までしか判定しておらず、「インラインのコードスパンの中身も
 * 除く」までは踏み込んでいなかった**——残された行はプローズとして
 * `extractMarkerValues` に渡り、その中に「刻印の書き方の例」を書けば拾われて
 * しまう。実測（Issue #857）: 本文中の唯一の刻印が
 * `` `<!-- alteroid-origin: mgr-… -->` `` という**インラインスパンの中の例**
 * （値は全角三点リーダを含む5文字で、実在しない managerId）で、直す前は
 * これを `manager` と誤判定していた（正しくは `missing`）。
 *
 * **だから `stripFencedCode` の後段に `stripInlineCode` を足し、フェンス判定
 * そのものは1バイトも変えず、インラインのコードスパンの除去だけを別の関数に
 * 分離した。** 理由は2つ——(1) フェンス判定を変えると PR #796 の直しを壊す
 * リスクを負う。既に効いている判定に手を入れず、新しい関数を後ろに継ぎ足す
 * ほうが安全である。(2) 「フェンスの開きの判定」と「インラインスパンの除去」
 * は別の関心事なので、分けたほうがそれぞれの歯が何を守っているかを言える。
 *
 * `stripInlineCode`（下）は CommonMark のコードスパンの規則
 * （https://spec.commonmark.org/0.31.2/#code-spans）に沿う——バックティックの
 * 連なり（backtick string）が開き、**同じ長さちょうど**の連なりが後ろに在れば
 * そこまでが閉じ、無ければその連なりはただの文字である。
 *
 * **走査は1行ずつに閉じる。** CommonMark のコードスパンは空行を跨げないので、
 * 行単位の走査は「跨がない」という制約の安全側の部分集合になる——見落とす
 * 方向にしか外れない。そしてこれには副次的な効能がある: **行を跨いで走査する
 * 実装だと、本文の離れた場所に在る孤立したバックティック2個（説明文の中の
 * 単発の `` ` `` のような、対応する閉じの無いもの）が、たまたま別の行の
 * 別の孤立したバックティックと「同じ長さの連なり」として対応してしまい、
 * その間に挟まった本物の刻印ごと1つの巨大なコードスパンとして消してしまう**
 * ——行ごとに閉じておけば、この種の「離れた行同士の誤対応」がそもそも起こらない。
 *
 * **除いた span は空文字ではなく空白1個に置き換える。** 空文字にすると、
 * スパンの直前と直後の文字が連結し、除去によって偶然新しい文字列（たとえば
 * 別々の行にまたがっていた `<!--` と `-->` が隣接して刻印の形を作る、という
 * ようなもの）が生まれる余地がある。空白1個を挟めばそれを防げる——
 * `extractMarkerValues` の正規表現は空白をまたいで一致しないため。
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
 *
 * ## `automation` の担保と限界（Issue #893 / #930）
 *
 * **なぜ担保が要るか。** PR 本文は誰でも編集できる——刻印の値も例外ではない。
 * `manager` / `clone` / `human` は「自己申告のまま通す」ことが問題にならない
 * （その委譲・そのクローン・その人間が自分の PR に自分の名を刻むだけで、
 * 他人になりすます動機が無い）。しかし `automation` を同じ扱いにすると、
 * **誰でも本文に1行足すだけで「これは自動化がやった」と名乗れる**——刻印が
 * 「本文の外の事実」を何も裏付けなくなり、門が意味を失う。だから
 * `automation` だけは、本文の外の事実で裏付ける。
 *
 * **担保の中身。** `PR_AUTHOR_TYPE`（`github.event.pull_request.user.type`。
 * `scripts/check-pr-origin.mjs` の doc、`.github/workflows/ci.yml` の
 * `pr-origin` ジョブを見よ）は GitHub がイベントペイロードとして発行する値で、
 * **PR 本文を書き換えられる人間にも書き換えられない。** これで「本文の主張
 * （`automation`）」を「本文の外の事実（`user.type === 'Bot'`）」で裏付ける
 * 形になる。
 *
 * **⚠️ この担保にも限界がある（省略しない——書くこと自体がこの節の成果）:**
 *
 * 1. **(限界1) 担保するのは「作者が bot アカウントである」までで、「この repo
 *    自身の自動化である」ではない。** 書き込み権を持つ別の bot（別の
 *    GitHub App）が立てた PR も、本文に `automation` と書けば同じ値を
 *    名乗れる。いま測った時点（2026-09-13 観測、`gh pr list --state all
 *    --limit 1000` を全走査）では、`app/` 始まりの author は
 *    `github-actions[bot]`（id 41898282）1つだけで、他の bot は0本である。
 * 2. **(限界2) `ALTEROID_PR_TOKEN`（人間の PAT。Issue #867 がその導入を
 *    求めている）が secret に置かれると、同じワークフローが立てる PR の
 *    作者は PAT の持ち主＝人間（`user.type` が `User`）になる。** そのとき
 *    `automation` は `unverified` で赤くなる。**これは意図した向きである**
 *    ——緑のまま通すと、人間の作者と自動化の主張が食い違ったまま黙って
 *    通ることになる。赤くなったときに何が起きたのかが読めるよう、
 *    `check-pr-origin.mjs` の失敗メッセージにこの2つの読み（人間が
 *    `automation` と書いた／自動化が PAT で走るようになり作者が人間に
 *    なった）を書く。
 * 3. **(限界3) 秘密の有無は測れないので、いま `ALTEROID_PR_TOKEN` が
 *    secret に置かれているかどうかは測っていない。**
 *
 * **`authorType` が動かすのは `automation` の verdict だけである。** 他の
 * verdict（`manager` / `clone` / `human` / `missing` / `invalid` /
 * `conflict` / `legacy`）は `authorType` の値によらず同じ結果を返す——
 * 変更の血管を細く保つため、`decideGateVerdict` の分岐は `base.verdict ===
 * 'automation'` のときだけに限る。
 *
 * **`authorType` が `undefined` / `null` / 空文字のときは fail closed**
 * （`unverified` 側へ倒す）。上の「`createdAt` が取れない・壊れているときは
 * fail closed」と同じ考え方——門を通す側の値が信頼できない・渡っていない
 * ときに、安全側（＝より赤くなりうる側）へ倒す。
 */

const MARKER_NAME = 'alteroid-origin';
const MANAGER_PREFIX = 'mgr-';
const CLONE_VALUE = 'clone';
const HUMAN_VALUE = 'human';
const AUTOMATION_VALUE = 'automation';

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
 * 1行の中のバックティックの連なり（backtick string）を、位置と長さの一覧として返す。
 * 「連なり」は正規表現 `` /`+/g `` で拾うので、1個のバックティックに挟まれた
 * 別のバックティックが独立した連なりとして数えられることはない
 * （`` ``` `` は長さ3の1個の連なりであって、長さ1の連なり3個ではない）。
 */
function findBacktickRuns(line) {
  const runs = [];
  const re = /`+/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    runs.push({ start: m.index, end: m.index + m[0].length, length: m[0].length });
  }
  return runs;
}

/**
 * 1行からインラインのコードスパンを取り除く。
 * CommonMark の規則どおり、開き候補（ある連なり）に対して「その後ろで最初に
 * 現れる同じ長さの連なり」を閉じとして採用する。見つからなければ、その連なりは
 * コードスパンを開始しない（ただの文字として読み飛ばし、次の連なりを開き候補
 * として試す）。
 */
function stripInlineCodeFromLine(line) {
  const runs = findBacktickRuns(line);
  if (runs.length === 0) return line;

  let result = '';
  let cursor = 0;
  let i = 0;
  while (i < runs.length) {
    const open = runs[i];
    let closeIdx = -1;
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j].length === open.length) {
        closeIdx = j;
        break;
      }
    }
    if (closeIdx === -1) {
      // 閉じが見つからない ⟹ この連なりはコードスパンを開始しない、ただの文字。
      i++;
      continue;
    }
    const close = runs[closeIdx];
    // 開きの手前まではそのまま残し、開き〜閉じの全体を空白1個に置き換える
    // （理由は上の doc「除いた span は空文字ではなく空白1個に置き換える」）。
    result += line.slice(cursor, open.start) + ' ';
    cursor = close.end;
    i = closeIdx + 1;
  }
  result += line.slice(cursor);
  return result;
}

/**
 * `markdown` からインラインのコードスパン（`` `...` `` 1個で囲んだ部分）の中身を
 * 取り除いた本文を返す。`stripFencedCode` の後段として使う——フェンスの判定は
 * 一切行わない（フェンスの中の行はこの関数に渡す前に既に除かれている前提）。
 * 上の doc「インラインのコードスパンの中も数えない（Issue #857）」がこの
 * 関数を置いた理由と設計そのものである。1行ずつ独立に処理し、行を跨いで
 * バックティックを対応させることはしない。
 */
export function stripInlineCode(markdown) {
  return markdown.split('\n').map(stripInlineCodeFromLine).join('\n');
}

/**
 * `stripFencedCode` → `stripInlineCode` を通した本文から、刻印の値を全部
 * （出現順で）拾う。値は空白を含まない前提（`mgr-` id・`clone`・`human` は
 * どれも1トークン）なので `\S+` で取る——想定外に空白入りの値を書かれた場合は
 * 最初のトークンだけを拾い、以降は info string の残りとして無視される
 * （既知の限界）。
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

/** 1つの値を verdict へ分類する（`manager` / `clone` / `human` / `automation` / `invalid`）。 */
function classifyValue(value) {
  if (value.startsWith(MANAGER_PREFIX)) return { verdict: 'manager', managerId: value };
  if (value === CLONE_VALUE) return { verdict: 'clone' };
  if (value === HUMAN_VALUE) return { verdict: 'human' };
  if (value === AUTOMATION_VALUE) return { verdict: 'automation' };
  return { verdict: 'invalid', value };
}

/**
 * PR / Issue の本文を判定する。上の判定表・doc がこの関数の正本。
 *
 * @param {string | null | undefined} body
 * @returns {
 *   | { verdict: 'manager', managerId: string, values: string[] }
 *   | { verdict: 'clone' | 'human' | 'automation', values: string[] }
 *   | { verdict: 'missing' }
 *   | { verdict: 'invalid', value: string, values: string[] }
 *   | { verdict: 'conflict', values: string[] }
 * }
 */
export function parseOriginMarker(body) {
  if (body === null || body === undefined || body === '') {
    return { verdict: 'missing' };
  }

  const prose = stripInlineCode(stripFencedCode(body));
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
 * `parseOriginMarker` の結果と PR の作成時刻・作者種別を合わせて、最終の
 * verdict を出す。`legacy` の条件・`invalid`/`conflict` を `legacy` へ
 * 逃がさない理由・`createdAt` が壊れているときに fail closed する理由は、
 * 上の doc「`legacy`（門より前に作られた PR）」を見よ。`automation` の担保・
 * 限界・fail closed の理由は上の doc「`automation` の担保と限界」を見よ。
 *
 * @param {{
 *   body: string | null | undefined,
 *   createdAt: string | null | undefined,
 *   authorType?: string | null | undefined,
 * }} input
 */
export function decideGateVerdict({ body, createdAt, authorType }) {
  const base = parseOriginMarker(body);

  // `automation` だけは本文の外の事実（作者の種別）で裏付ける。他の verdict
  // には一切触れない——上の doc「`authorType` が動かすのは `automation` の
  // verdict だけである」のとおり。
  if (base.verdict === 'automation') {
    if (authorType !== 'Bot') {
      return { verdict: 'unverified', values: base.values };
    }
    return base;
  }

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
