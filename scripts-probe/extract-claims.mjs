// 使い捨ての測定用スクリプト（Issue #1130 の前提を測るためだけのもの）。
// scripts/ 直下には置かない（AGENTS.md の指示）。
//
// 仕様は依頼文のとおり:
// - 入力: PR 本文（markdown 文字列）と、変更ファイルの一覧
// - 前処理でフェンス（```...```）と HTML コメント（<!-- --> ）を落とす
// - 引用（行頭 `>`）は落とす版・落とさない版の両方を出せるようにする（stripQuotes フラグ）
// - パス候補: インラインコードスパン `...` の中身が
//     ^[A-Za-z0-9._/-]+$ にマッチし、かつ
//     (a) '/' を含む、または (b) '.' を含み拡張子が md|ts|tsx|mjs|js|json|yml|yaml|sh|toml
// - 主張の判定: パス出現位置から、同じ文の末尾（区切り: 。\n！？）までを「窓」とし、
//     窓の中（パスより後ろ、前向きのみ）に変更動詞が在れば「変更の主張」
//     ただし動詞の直後（おおむね8文字以内）に否定語が在れば除く
// - 出力: { pr, path, verb, sentence } の配列

const VERBS = [
  '追記', '追加', '新設', '新規', '作成', '実装', '導入', '変更',
  '直した', '直す', '直し',
  '修正',
  '足した', '足す', '足し',
  '消した', '消す', '消し',
  '削除', '撤去', '書き換え', '置き換え', '入れ替え', '移設',
  '移す', '移し',
  '更新',
  '外した', '外す', '外し',
  '切り出し', '畳ん', '寄せ',
];

// 長い活用形を先に置かないと短い語（例: 直し）が先に当たって位置がずれる恐れがあるため、
// 文字数の長い順にソートしてから正規表現の代替を作る。
const VERB_PATTERN = new RegExp(
  VERBS.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'),
  'g'
);

const NEGATIONS = ['していない', 'ません', 'なかった', 'いない', '不要', 'せず', 'ない', 'ず', 'ぬ'];
// 2周目(iv-b/iv-c)で足す否定語。1周目で漏れたと報告した「なし」「そのまま」「てある」等。
// 依頼文の逐語どおり。base と重複する部分（「ない」を含む語）があっても、そのまま両方保持する
// （足したことで純増する語がどれかは、依頼文の意図どおり on/off の差分で測る）。
const EXTRA_NEGATIONS = [
  'なし', '無し', 'そのまま', 'てある', 'ておく', 'ていない', '得ない', 'わけではない', 'ものではない',
];

function buildNegationPattern(extra) {
  const words = extra ? NEGATIONS.concat(EXTRA_NEGATIONS) : NEGATIONS;
  return new RegExp(words.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'));
}

// 2周目(iv-c)で1つだけ足す名詞用法の除外。動詞の直後がこの助詞で、かつ動詞が
// このリストのものだけ、名詞用法（「実装が」「変更は」等）とみなして主張から除く。
// 依頼文の逐語どおり、狭く切る（本物のずれまで落とさないため）。
const NOUN_EXCLUDE_VERBS = new Set(['実装', '変更', '更新', '削除', '修正', '追加']);
const NOUN_FOLLOW_CHARS = new Set(['が', 'は', 'の', 'を', 'も', 'に']);

const SENTENCE_DELIMS = ['。', '\n', '！', '？'];

const PATH_EXT_WHITELIST = new Set(['md', 'ts', 'tsx', 'mjs', 'js', 'json', 'yml', 'yaml', 'sh', 'toml']);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// フェンス（``` ... ```）を除去する。中身を空白（改行数は保つ）に置換して位置ズレを避ける。
function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '));
}

// HTML コメント <!-- ... --> を除去する（同様に位置を保って空白化）。
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

// 行頭 '>' の引用行を落とす（内容を空白化。位置ズレを避けるため行の長さは保つ）。
function stripBlockquotes(text) {
  return text
    .split('\n')
    .map((line) => (/^\s*>/.test(line) ? line.replace(/./g, ' ') : line))
    .join('\n');
}

function isPathCandidate(s) {
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return false;
  if (s.includes('/')) return true;
  if (s.includes('.')) {
    const ext = s.split('.').pop();
    if (PATH_EXT_WHITELIST.has(ext)) return true;
  }
  return false;
}

function findSentenceEnd(text, fromIndex) {
  let end = text.length;
  for (const delim of SENTENCE_DELIMS) {
    const idx = text.indexOf(delim, fromIndex);
    if (idx !== -1 && idx < end) end = idx;
  }
  return end;
}

function findSentenceStart(text, uptoIndex) {
  let start = 0;
  for (const delim of SENTENCE_DELIMS) {
    const idx = text.lastIndexOf(delim, uptoIndex - 1);
    if (idx !== -1 && idx + 1 > start) start = idx + 1;
  }
  return start;
}

/**
 * @param {string} body PR 本文（markdown）
 * @param {object} opts
 * @param {boolean} opts.requireVerb 動詞に縛るか（false なら素朴案 = パス出現だけで主張とみなす）
 * @param {boolean} opts.stripQuotes 行頭 '>' の引用を落とすか
 * @param {boolean} opts.extraNegations (iv-b/iv-c) 否定語リストを拡充するか。動詞リスト・窓は変えない
 * @param {boolean} opts.excludeNounForm (iv-c) 動詞直後が助詞で、動詞が名詞化しやすい6語のときだけ除外するか
 * @returns {{path: string, verb: string|null, sentence: string}[]}
 */
export function extractClaims(body, opts = {}) {
  const { requireVerb = true, stripQuotes = false, extraNegations = false, excludeNounForm = false } = opts;

  let text = stripFences(body);
  text = stripHtmlComments(text);
  if (stripQuotes) text = stripBlockquotes(text);

  const negationPattern = buildNegationPattern(extraNegations);

  const claims = [];
  const codeSpanRe = /`([^`\n]+)`/g;
  let m;
  while ((m = codeSpanRe.exec(text)) !== null) {
    const candidate = m[1];
    if (!isPathCandidate(candidate)) continue;

    const spanEnd = m.index + m[0].length;
    const sentStart = findSentenceStart(text, m.index);
    const sentEnd = findSentenceEnd(text, spanEnd);
    const sentence = text.slice(sentStart, sentEnd).trim();

    if (!requireVerb) {
      claims.push({ path: candidate, verb: null, sentence });
      continue;
    }

    // 前向きの窓（パスより後ろ、文末まで）
    const window = text.slice(spanEnd, sentEnd);

    let matchedVerb = null;
    VERB_PATTERN.lastIndex = 0;
    let vm;
    while ((vm = VERB_PATTERN.exec(window)) !== null) {
      const verbEnd = vm.index + vm[0].length;

      const afterWindow = window.slice(verbEnd, verbEnd + 8);
      if (negationPattern.test(afterWindow)) {
        continue; // 否定が続くので、この動詞は主張にしない
      }

      if (excludeNounForm && NOUN_EXCLUDE_VERBS.has(vm[0])) {
        const nextChar = window.charAt(verbEnd);
        if (NOUN_FOLLOW_CHARS.has(nextChar)) {
          continue; // 名詞用法（「実装が」等）とみなして除外
        }
      }

      matchedVerb = vm[0];
      break; // 最初に見つかった非否定・非名詞用法の動詞を採る
    }

    if (matchedVerb) {
      claims.push({ path: candidate, verb: matchedVerb, sentence });
    }
  }

  return claims;
}

// CLI: node extract-claims.mjs <body-file> [--no-verb] [--strip-quotes]
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const file = process.argv[2];
  const requireVerb = !process.argv.includes('--no-verb');
  const stripQuotes = process.argv.includes('--strip-quotes');
  const body = fs.readFileSync(file, 'utf8');
  const claims = extractClaims(body, { requireVerb, stripQuotes });
  console.log(JSON.stringify(claims, null, 2));
}
