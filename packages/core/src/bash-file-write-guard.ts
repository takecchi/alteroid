import { computeOutsideQuoteMask, findHeredocs, type HeredocSpan } from './bash-wait-guard.js';

// 安全の境界ではなく誘導の門: `eval`・変数に入れたコマンド・`bash -c '…'` の中・別ファイルのスクリプトは見ない。素通りされても後ろには分類器が居る（#4348）
// 代わりの道具を必ず理由文に出す: 弾いた先に道が無いと、素通りする形へ逃げるため
// 引用の外・heredoc の本文の外だけを見る: 引用や本文の中の `>` `<<` はデータで、演算子ではないため
// `cp`・`mv`・`mkdir`・`touch`・`rm`・`ln` は断らない: 中身を書く形ではないため

export type BashFileWriteForm =
  'heredoc-file-write' | 'in-place-edit' | 'inline-interpreter-write' | 'output-redirect';

export type BashFileWriteVerdict =
  { blocked: false } | { blocked: true; form: BashFileWriteForm; reason: string };

const FORM_LABEL: Record<BashFileWriteForm, string> = {
  'heredoc-file-write': 'F1 ファイルを宛先にした heredoc / here-string',
  'in-place-edit': 'F2 その場で書き換えるフラグ',
  'inline-interpreter-write': 'F3 インタプリタのその場のコードでのファイル書き込み',
  'output-redirect': 'F4 出力をファイルへ溜めるリダイレクト',
};

const FORM_ALTERNATIVE: Record<BashFileWriteForm, string> = {
  'heredoc-file-write':
    'ファイルの新規作成・全体の置き換えは Write、一部の書き換えは Edit を使うこと。',
  'in-place-edit': 'ファイルの一部の書き換えは Edit、全体の置き換えは Write を使うこと。',
  'inline-interpreter-write':
    'ファイルの作成・書き換えは Write / Edit を使うこと。どうしてもスクリプトが要るなら、Write で作業場所にスクリプトを置き、`node <file>` / `python3 <file>` で走らせること。',
  'output-redirect':
    'コマンドの出力を見るだけなら `| tail -n 50` か `| head` で受けること。残す必要があれば Write で残すこと。',
};

function buildReason(form: BashFileWriteForm): string {
  return (
    `シェルでファイルを書き換える形（形=${FORM_LABEL[form]}）なので拒否した。${FORM_ALTERNATIVE[form]}` +
    '同じことを別のコマンドや別の言語で迂回してやり直さないこと（後ろの分類器に止められ、依頼者への確認に上がる）。'
  );
}

interface View {
  readonly original: string;
  // 引用の中・heredoc の本文と終端・コメントを `x` / 空白に潰した、同じ長さの写し
  readonly masked: string;
  readonly heredocs: readonly HeredocSpan[];
}

function blankKeepingNewlines(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

function buildView(command: string): View {
  const heredocs = findHeredocs(command);
  const chars = command.split('');
  for (const span of heredocs) {
    for (let i = span.bodyStart; i < span.end && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  const blanked = chars.join('');
  // 本文を先に潰してから引用を読む: 本文の中のアポストロフィが以降の引用の読みを狂わせるため
  const outside = computeOutsideQuoteMask(blanked);
  let masked = chars.map((ch, i) => (outside[i] === true || ch === ' ' ? ch : 'x')).join('');
  masked = masked.replace(/\$\(\([\s\S]*?\)\)/g, blankKeepingNewlines);
  masked = masked.replace(/\[\[[\s\S]*?\]\]/g, blankKeepingNewlines);
  return { original: command, masked, heredocs };
}

interface Segment {
  readonly start: number;
  readonly end: number;
}

// `&>` `>&` の `&` と `>|` の `|` は区切りにしない: リダイレクトの一部のため
function splitSegments(masked: string): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    let separator = false;
    if (ch === ';' || ch === '\n' || ch === '(' || ch === ')' || ch === '`') separator = true;
    else if (ch === '|') separator = masked[i - 1] !== '>';
    else if (ch === '&') separator = masked[i - 1] !== '>' && masked[i + 1] !== '>';
    if (separator) {
      out.push({ start, end: i });
      start = i + 1;
    }
  }
  out.push({ start, end: masked.length });
  return out.filter((s) => s.end > s.start);
}

interface OutputRedirect {
  // '1' | '2' | … | 'both'（`&>`）| undefined（既定の標準出力）
  readonly fd: string | undefined;
  readonly target: string;
}

interface ScanResult {
  readonly outputs: OutputRedirect[];
  readonly hasHereDoc: boolean;
  // リダイレクトと heredoc の記号を消した、コマンドの語だけの写し
  readonly cleaned: string;
}

const HARMLESS_TARGET_RE = /^\/dev\/(?:null|stderr|stdout|tty|fd\/\d+)$/;
const DEV_NULL_RE = /^\/dev\/null$/;

function stripQuotes(word: string): string {
  return word.replace(/^["']+/, '').replace(/["']+$/, '');
}

function scanRedirects(masked: string, original: string): ScanResult {
  const outputs: OutputRedirect[] = [];
  const cleaned = masked.split('');
  let hasHereDoc = false;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < cleaned.length; k += 1) cleaned[k] = ' ';
  };
  const readWordEnd = (from: number): number => {
    let k = from;
    while (k < masked.length && !/[\s<>]/.test(masked[k] ?? '')) k += 1;
    return k;
  };
  const skipSpaces = (from: number): number => {
    let k = from;
    while (k < masked.length && (masked[k] === ' ' || masked[k] === '\t')) k += 1;
    return k;
  };

  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '>') {
      let fdStart = i;
      let fd: string | undefined;
      if (masked[i - 1] === '&') {
        fd = 'both';
        fdStart = i - 1;
      } else {
        let k = i;
        while (k > 0 && /\d/.test(masked[k - 1] ?? '')) k -= 1;
        if (k < i && (k === 0 || /\s/.test(masked[k - 1] ?? ''))) {
          fd = masked.slice(k, i);
          fdStart = k;
        }
      }
      let j = i + 1;
      if (masked[j] === '>') j += 1;
      if (masked[j] === '|') j += 1;
      if (masked[j] === '&') {
        const next = masked[j + 1];
        // `>&2` `2>&1` `>&-` は記述子の付け替え: ファイルを作らない
        if (next !== undefined && /[\d-]/.test(next)) {
          const end = readWordEnd(j + 1);
          blank(fdStart, end);
          i = end - 1;
          continue;
        }
        j += 1;
      }
      if (masked[j] === '(') {
        i = j;
        continue;
      }
      const targetStart = skipSpaces(j);
      const targetEnd = readWordEnd(targetStart);
      if (targetEnd === targetStart) {
        i = j - 1;
        continue;
      }
      outputs.push({ fd, target: stripQuotes(original.slice(targetStart, targetEnd)) });
      blank(fdStart, targetEnd);
      i = targetEnd - 1;
    } else if (ch === '<') {
      if (masked[i + 1] === '(') continue;
      if (masked[i + 1] === '<') {
        hasHereDoc = true;
        let j = i + 2;
        if (masked[j] === '<' || masked[j] === '-') j += 1;
        const wordStart = skipSpaces(j);
        const end = readWordEnd(wordStart);
        blank(i, end);
        i = Math.max(end, i + 2) - 1;
      } else {
        const wordStart = skipSpaces(i + 1);
        const end = readWordEnd(wordStart);
        blank(i, end);
        i = Math.max(end, i + 1) - 1;
      }
    }
  }
  return { outputs, hasHereDoc, cleaned: cleaned.join('') };
}

const KEYWORD_TOKENS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  'time',
  '!',
  '{',
  'coproc',
]);
const WRAPPER_TOKENS = new Set([
  'sudo',
  'doas',
  'env',
  'nice',
  'ionice',
  'nohup',
  'command',
  'builtin',
  'exec',
  'setsid',
  'stdbuf',
  'xargs',
  'timeout',
]);

interface CommandWords {
  readonly name: string;
  readonly args: readonly string[];
}

function commandWordsOf(cleaned: string): CommandWords | undefined {
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  let afterWrapper = false;
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || KEYWORD_TOKENS.has(token)) {
      i += 1;
      continue;
    }
    if (WRAPPER_TOKENS.has(token)) {
      afterWrapper = true;
      i += 1;
      continue;
    }
    if (afterWrapper && (token.startsWith('-') || /^\d+[smhd]?$/.test(token))) {
      i += 1;
      continue;
    }
    const name = (token.split('/').pop() ?? token).replace(/^["'\\]+/, '');
    return { name, args: tokens.slice(i + 1) };
  }
  return undefined;
}

function isInPlaceEdit(words: CommandWords): boolean {
  const args: string[] = [];
  for (const arg of words.args) {
    if (arg === '--') break;
    args.push(arg);
  }
  switch (words.name) {
    case 'sed':
      return args.some((a) => /^-[nEerzus]*i/.test(a) || /^--in-place/.test(a));
    case 'perl':
    case 'ruby':
      return args.some((a) => /^-[nplasw0-9]*i/.test(a));
    case 'awk':
    case 'gawk':
      return args.some((a, k) => (a === '-i' && args[k + 1] === 'inplace') || a === '-iinplace');
    default:
      return false;
  }
}

const INTERPRETER_RE = /^(?:python[\d.]*|node(?:js)?|bun|deno|perl|ruby)$/;
const INLINE_FLAG_RE = /^(?:-[A-Za-z]*[ceEp]|--(?:eval|print)(?:=.*)?)$/;

// 書き込み・削除・改名の語: 読むだけ・数えるだけのコードは断らない（#4348 の E6）
const WRITE_CODE_RE = new RegExp(
  [
    String.raw`\bwrite\w*File\w*`,
    String.raw`\bappendFile\w*`,
    String.raw`\bcreateWriteStream\b`,
    String.raw`\bfs\.write`,
    String.raw`\bfs\.(?:promises\.)?(?:rename|rm|rmdir|unlink|copyFile|cp|mkdir|truncate|symlink|link|chmod)\w*`,
    String.raw`\.write_text\s*\(`,
    String.raw`\.write_bytes\s*\(`,
    String.raw`\bshutil\.`,
    String.raw`\bos\.(?:rename|replace|remove|unlink|rmdir|makedirs|mkdir|truncate|chmod)\b`,
    String.raw`\bunlink(?:Sync)?\s*\(`,
    String.raw`\bFile\.(?:write|binwrite|delete|rename|unlink|chmod)\b`,
    String.raw`\bIO\.(?:write|binwrite)\b`,
    String.raw`\bFileUtils\.`,
    String.raw`\bopen\s*\(\s*[^,)]+,\s*(?:mode\s*=\s*)?['"][rwaxbt+]*[wax+][rwaxbt+]*['"]`,
    String.raw`\bopen\s*\([^)]*\bmode\s*=\s*['"][rwaxbt+]*[wax+][rwaxbt+]*['"]`,
    String.raw`\bopen\s*\(?[^;\n]*?['"]\s*\+?>{1,2}`,
  ].join('|'),
);

function interpreterCodeWritesFile(
  words: CommandWords,
  view: View,
  segment: Segment,
  hasHereDoc: boolean,
): boolean {
  if (!INTERPRETER_RE.test(words.name)) return false;
  let inline = words.name === 'deno' && words.args[0] === 'eval';
  let scriptFile = false;
  if (!inline) {
    for (const arg of words.args) {
      if (INLINE_FLAG_RE.test(arg)) {
        inline = true;
        break;
      }
      if (arg === '-') break;
      if (arg.startsWith('-')) continue;
      scriptFile = true;
      break;
    }
  }
  // 位置引数にスクリプトのファイルが在れば、中身は Write を通っている（E5）
  if (scriptFile) return false;
  let code = view.original.slice(segment.start, segment.end);
  for (const span of view.heredocs) {
    if (span.start >= segment.start && span.start < segment.end) {
      code += `\n${view.original.slice(span.bodyStart, span.bodyEnd)}`;
    }
  }
  // 標準入力から読む形で、この区間に本文が無い（`echo … | python3 -`）ときは、コマンド全体を見る
  if (!inline && !hasHereDoc) code = view.original;
  return WRITE_CODE_RE.test(code);
}

function teeFilesOf(words: CommandWords | undefined): string[] {
  if (words === undefined || words.name !== 'tee') return [];
  return words.args.filter((a) => !a.startsWith('-') && !HARMLESS_TARGET_RE.test(stripQuotes(a)));
}

function inspectSegment(view: View, segment: Segment): BashFileWriteForm | undefined {
  const masked = view.masked.slice(segment.start, segment.end);
  const original = view.original.slice(segment.start, segment.end);
  const scan = scanRedirects(masked, original);
  const words = commandWordsOf(scan.cleaned);
  const fileOutputs = scan.outputs.filter((o) => !HARMLESS_TARGET_RE.test(o.target));
  const teeFiles = teeFilesOf(words);

  if (scan.hasHereDoc) {
    // `cat > /dev/null <<EOF` も断る（何もしない呼び出しで、分類器に止められている）。`2> /dev/null` は標準エラーだけなので通す
    const stdoutToNull = scan.outputs.some(
      (o) => DEV_NULL_RE.test(o.target) && (o.fd === undefined || o.fd === '1' || o.fd === 'both'),
    );
    if (fileOutputs.length > 0 || stdoutToNull || teeFiles.length > 0) return 'heredoc-file-write';
  }
  if (words !== undefined && isInPlaceEdit(words)) return 'in-place-edit';
  if (words !== undefined && interpreterCodeWritesFile(words, view, segment, scan.hasHereDoc)) {
    return 'inline-interpreter-write';
  }
  if (fileOutputs.length > 0 || teeFiles.length > 0) return 'output-redirect';
  return undefined;
}

export function inspectBashFileWrite(command: string): BashFileWriteVerdict {
  if (command.trim().length === 0) return { blocked: false };
  const view = buildView(command);
  for (const segment of splitSegments(view.masked)) {
    const form = inspectSegment(view, segment);
    if (form !== undefined) return { blocked: true, form, reason: buildReason(form) };
  }
  return { blocked: false };
}
