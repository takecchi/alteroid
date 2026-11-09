// 足す語は他の語の一部になりにくい形にする（部分一致で `断` 1字だと「判断」に当たるので `断る` / `お断り` にする）。否定の語を含む承認が deny に倒れるのは止める側で、許しすぎる側ではない
const DENIAL_PHRASES = [
  'やめ',
  'だめ',
  'ダメ',
  '駄目',
  '不可',
  '中止',
  '却下',
  '拒否',
  '無理',
  '断る',
  'お断り',
  'しないで',
  '止めて',
  '待って',
  '許可しない',
  '許可できな',
  '許可できません',
  '承認しない',
  '承認できな',
  '承認できません',
  '認めない',
  '認められない',
];

// 英語側は語境界で見る: `nothing` の `no` を否定と読まないため。`reject` / `refuse` / `decline` は語幹＋任意の語尾（`\w*`）にする: `rejecting` の途中に語境界が無く一致しないため
const DENIAL_WORDS =
  /\b(deny|denied|denying|no|nope|don't|do not|won't|will not|cannot|can not|stop|stopping|cancel\w*|reject\w*|refus\w*|declin\w*|abort\w*)\b/i;

// 承認の語の一覧を狭くする: ここに無い言い方は `allow` にならず `unreadable` 側へ寄る（過剰に拒否と読む側で、許しすぎる側ではないため）
// `進めて`（`よい` を伴わない単独形）を足さない: `よい、そのまま進めて` を `unreadable` の代表例として使う複数のテストの歯を反転させてしまうため
const APPROVAL_PHRASES = [
  'どうぞ',
  '進めてよい',
  '許可する',
  '許可します',
  '承認する',
  'はい',
  '承認します',
];
const APPROVAL_WORDS = /\b(go ahead|approved|approve|ok|okay|yes|sure)\b/i;

// 単体で `deny` を返さない: 承認の語と同じ回答に見つかったときにだけ `allow` と読むのを止める（`unreadable` へ落とす）ため
// 保留・一時停止の語を `DENIAL_*` へ足さない: 「Don't wait, go ahead」のように承認の文にも現れうるので、deny と言い切らず `unreadable` へ落とすだけにするため
// 部分一致の誤検出は常に「承認と読まない」側へ倒れる: `unreadable` は SDK 側で deny なので、許しすぎる側へは化けない
// `n't` は語境界の組の外に置く: `\b(…|n't|…)\b` では `isn't` の `s` と `n` のあいだに `\b` が立たず縮約の中で1回も当たらないため
const NEGATION_MARKERS_EN = /\b(not|never|cannot|wait|hold off|hold on|pause\w*)\b|n't\b/i;
const NEGATION_MARKERS_JA = ['ない', 'ません', 'ず', '保留', '見送', '不要'];

// テストのためだけに export している: 否定の印を含む文は `isApprovalOnly` で承認だけから外れるので、`inferDecision` の戻り値からは印が当たったか見えないため
export function hasNegationMarker(message: string): boolean {
  return (
    NEGATION_MARKERS_EN.test(message) ||
    NEGATION_MARKERS_JA.some((marker) => message.includes(marker))
  );
}

// 語を足さず形で絞る: 語を足す形では承認の語と一覧に無い否定・条件の同居が漏れ続けるため、承認以外の語が1つでも残れば `unreadable` にする（答え直しが増えるのは代償として受け入れる）
// 付け足しの一覧を広げない: そのぶん allow の線が緩むため
const APPROVAL_ONLY_FILLERS_JA = [
  'よろしくお願いします',
  'お願いします',
  'お願い',
  'ください',
  'です',
];
const APPROVAL_ONLY_FILLERS_EN = /\b(please|thanks|thank you)\b/gi;
const APPROVAL_ONLY_REMAINDER = /^[\s、。，．,.!！・…~〜ー—–-]*$/u;

function isApprovalOnly(message: string): boolean {
  if (!hasApprovalMarker(message)) return false;
  let rest = message;
  // 長い語から取り除く: `承認します` を `承認する` より先にする等、部分の食い違いを避けるため
  for (const phrase of [...APPROVAL_PHRASES, ...APPROVAL_ONLY_FILLERS_JA].sort(
    (a, b) => b.length - a.length,
  )) {
    rest = rest.split(phrase).join(' ');
  }
  rest = rest.replace(new RegExp(APPROVAL_WORDS.source, 'gi'), ' ');
  rest = rest.replace(APPROVAL_ONLY_FILLERS_EN, ' ');
  return APPROVAL_ONLY_REMAINDER.test(rest);
}

function hasApprovalMarker(message: string): boolean {
  return (
    APPROVAL_PHRASES.some((phrase) => message.includes(phrase)) || APPROVAL_WORDS.test(message)
  );
}

// アポストロフィの変種（U+2019 等）を素の `'` へ揃える: 素の `'` を要求する一覧がどれにも当たらず、`Don’t go ahead.` が `go ahead` にだけ当たって `allow` へ化けるため
// `inferDecision` の入口1箇所でだけ呼び、元の文言は書き換えない: 表示・台帳への保存は呼び出し元の元の `message` を使うため
function normalizeApostrophes(message: string): string {
  return message.replace(/[‘’ʼ]/g, "'");
}

// NFKC で全角を半角へ揃える: 半角だけの `DENIAL_WORDS` に当たらず、`ＮＯ、go ahead` が承認の語に負けて allow になるため
function normalizeForDecision(message: string): string {
  return normalizeApostrophes(message.normalize('NFKC'));
}

// 否定の語を含む承認の言い方は `allow` ではなく `unreadable` に倒す: `DENIAL_WORDS` が `no` / `don't` を先に拾って `deny` を確定させ、答え直しの案内に届かないため（SDK から見える結果は `deny` のままで許しすぎる側へは動かない）
// 一致した部分を除いた残りに本物の否定が在れば `deny` を優先する（`no problem, but stop` 等）
const NEGATED_APPROVAL_PHRASES = [
  'no problem',
  'no objection',
  "don't hesitate",
  "don't mind",
  "don't worry",
  'no worries',
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasNegatedApprovalPhrase(message: string): boolean {
  const lower = message.toLowerCase();
  return NEGATED_APPROVAL_PHRASES.some((phrase) => lower.includes(phrase));
}

function stripNegatedApprovalPhrases(message: string): string {
  return NEGATED_APPROVAL_PHRASES.reduce(
    (remainder, phrase) => remainder.replace(new RegExp(escapeRegExp(phrase), 'gi'), ' '),
    message,
  );
}

function hasNegatedApprovalDenial(message: string): boolean {
  const remainder = stripNegatedApprovalPhrases(message);
  return (
    DENIAL_PHRASES.some((phrase) => remainder.includes(phrase)) || DENIAL_WORDS.test(remainder)
  );
}

// 既定を閉じる側（`unreadable`）にする: 一覧に無い否定が `allow` へ化ける実害が続き、語を足すだけでは漏れが終わらないため（過剰に拒否と読む側で許しすぎる側ではない）
// 否定は承認より先に見る: `won't approve` は `approve` を含むため
// 否定の語を含む承認の言い方の判定は、否定の判定より先に走らせる: 先だと `no problem` の `no` が `deny` を確定させるため
// 日本語を語境界（`\s` や `\b`）で探さない: 「それはやめて」の「やめ」の前に区切りが無く、探せていないことが承認として表に出るため
export function inferDecision(message: string): 'allow' | 'deny' | 'unreadable' {
  const normalized = normalizeForDecision(message);
  if (hasNegatedApprovalPhrase(normalized)) {
    return hasNegatedApprovalDenial(normalized) ? 'deny' : 'unreadable';
  }
  if (DENIAL_PHRASES.some((phrase) => normalized.includes(phrase))) return 'deny';
  if (DENIAL_WORDS.test(normalized)) return 'deny';
  if (isApprovalOnly(normalized) && !hasNegationMarker(normalized)) return 'allow';
  return 'unreadable';
}

// 式を複数箇所に書かない（この関数が唯一の実装）: 実装が2つあると runner.ts 側が変わったときに黙ってずれるため
export function decideAnswer(
  kind: 'question' | 'permission',
  decision: 'allow' | 'deny' | undefined,
  message: string,
): { decision: 'allow' | 'deny'; unreadable: boolean } {
  if (kind === 'question') return { decision: 'allow', unreadable: false };
  if (decision !== undefined) return { decision, unreadable: false };
  const inferred = inferDecision(message);
  return inferred === 'unreadable'
    ? { decision: 'deny', unreadable: true }
    : { decision: inferred, unreadable: false };
}
