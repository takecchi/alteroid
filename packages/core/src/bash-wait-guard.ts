export type WaitGuardForm =
  'until-sleep' | 'while-sleep' | 'for-sleep' | 'tail-f' | 'gh-run-watch-background';

export type WaitGuardVerdict =
  { blocked: false } | { blocked: true; form: WaitGuardForm; reason: string };

// 代替なしで弾かない: 弾いた先に道が無いと、素通りする形へ逃げるため
const ALTERNATIVES =
  '代わりに次のいずれかを使うこと: ' +
  '(1) 起動した処理の完了を待つなら、待ち自体が終わる呼び出しにする ' +
  '（例: 対象の完了を返すコマンドを**前景で**。CI なら `gh run watch <id> --exit-status`）。 ' +
  '(2) 待ちに上限が要るなら `timeout <秒> <コマンド>` で自分から終わらせる。 ' +
  '(3) 完了通知を待つのではなく、成果物が在るかを前景の呼び出しで見に行く。';

function buildReason(shapeDescription: string): string {
  return `${shapeDescription}（無限待ちの形）。${ALTERNATIVES}`;
}

function isTimeoutWrapped(trimmed: string): boolean {
  return (
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:[^\s=]{0,64}\/)?timeout\b/.test(trimmed) &&
    isSingleSimpleCommand(trimmed)
  );
}

function isSingleSimpleCommand(trimmed: string): boolean {
  const command = stripHeredocs(joinLineContinuations(trimmed));
  const mask = computeOutsideQuoteMask(command);
  let lastContent = command.length - 1;
  while (lastContent >= 0 && /[\s;&]/.test(command.charAt(lastContent))) lastContent -= 1;
  for (let i = 0; i < lastContent; i++) {
    if (!mask[i]) continue;
    const ch = command[i];
    if (ch === ';' || ch === '|' || ch === '\n') return false;
    if (ch === '&') {
      const prev = i > 0 ? command[i - 1] : '';
      if (prev === '>' || prev === '<') continue;
      if (command[i + 1] === '>') continue;
      return false;
    }
  }
  return true;
}

// 規則を変えるときは hasTailFollowPattern も変える: 同じ一致を返す写しを bash-wait-guard-issue-2195.test.ts が突き合わせるため
export const TAIL_FOLLOW_RE =
  /\btail\b(?:(?!;|&&|\|\||\||\n).)*?(?:\s-[a-zA-Z]*[fF][a-zA-Z]*(?=[\s;&|]|$)|\s--follow\b)/;

// 単体の `&` を境界に数えない: TAIL_FOLLOW_RE の除外先読みが `&&` だけを見ているのに合わせるため
function boundaryTokenLengthAt(command: string, i: number): 0 | 1 | 2 {
  const ch = command[i];
  if (ch === ';' || ch === '\n' || ch === '|') return 1;
  if (ch === '&' && command[i + 1] === '&') return 2;
  return 0;
}

const TAIL_WORD_ONLY_RE = /\btail\b/;
const FOLLOW_FLAG_ONLY_RE = /\s-[a-zA-Z]*[fF][a-zA-Z]*(?=[\s;&|]|$)|\s--follow\b/;
const FOLLOW_FLAG_ANCHORED_RE = /^\s-[a-zA-Z]*[fF][a-zA-Z]*(?=[\s;&|]|$)|^\s--follow\b/;

// 改行だけは区間の境界を跨いで見る: TAIL_FOLLOW_RE のフラグ側 `\s` が改行にも一致し、`tail\n-f` が一致するため
function regionHasTailFollow(command: string, start: number, end: number): boolean {
  const region = command.slice(start, end);
  const tailMatch = TAIL_WORD_ONLY_RE.exec(region);
  if (!tailMatch) return false;
  const afterTail = region.slice(tailMatch.index + tailMatch[0].length);
  if (FOLLOW_FLAG_ONLY_RE.test(afterTail)) return true;
  return command[end] === '\n' && FOLLOW_FLAG_ANCHORED_RE.test(command.slice(end));
}

export function hasTailFollowPattern(command: string): boolean {
  let start = 0;
  while (start <= command.length) {
    let end = start;
    while (end < command.length && boundaryTokenLengthAt(command, end) === 0) end += 1;
    if (regionHasTailFollow(command, start, end)) return true;
    if (end >= command.length) return false;
    start = end + boundaryTokenLengthAt(command, end);
  }
  return false;
}

interface SimpleCommandSpan {
  readonly start: number;
  readonly end: number;
}

function splitOutsideQuoteSimpleCommands(
  command: string,
  mask: readonly boolean[],
): SimpleCommandSpan[] {
  const spans: SimpleCommandSpan[] = [];
  let start = 0;
  let i = 0;
  while (i < command.length) {
    let tokenLength = mask[i] ? boundaryTokenLengthAt(command, i) : 0;
    if (tokenLength === 0 && mask[i] && command[i] === '&') {
      const prev = i > 0 ? command[i - 1] : '';
      if (prev !== '>' && prev !== '<' && prev !== '|' && command[i + 1] !== '>') tokenLength = 1;
    }
    if (tokenLength > 0) {
      spans.push({ start, end: i });
      i += tokenLength;
      start = i;
    } else {
      i += 1;
    }
  }
  spans.push({ start, end: command.length });
  return spans;
}

// 実行形を列挙して弾く側にしない: 列挙していない実行形がすり抜けるため。実行しないと確認できた形だけを許可リストに載せる
const NON_EXECUTING_ARGS_COMMAND_RE =
  /^(?:echo|printf|grep|rg|git[ \t]+commit|gh[ \t]+(?:issue|pr)[ \t]+(?:comment|create|edit|view|close|review))(?=[ \t]|$)/;

function isNonExecutingArgsSimpleCommand(command: string, span: SimpleCommandSpan): boolean {
  let i = span.start;
  while (i < span.end && (command[i] === ' ' || command[i] === '\t')) i += 1;
  if (i >= span.end) return false;
  const ch = command[i] as string;
  if (ch === "'" || ch === '"' || (ch === '$' && command[i + 1] === "'")) return false;
  const rest = command.slice(i, span.end);
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) return false;
  if (rest.includes('$(') || rest.includes('`') || rest.includes('>(') || rest.includes('<(')) {
    return false;
  }
  return NON_EXECUTING_ARGS_COMMAND_RE.test(rest);
}

function isRealPipeBoundary(command: string, i: number): boolean {
  return command[i] === '|' && command[i + 1] !== '|';
}

// 本物のパイプの左側では引用符の中身を消さない: 許可リストのコマンドでも、出力を実行する側へ渡さないことまでは確認できないため
function blankQuotedInteriorForNonExecutingCommands(command: string): string {
  const mask = computeOutsideQuoteMask(command);
  const spans = splitOutsideQuoteSimpleCommands(command, mask);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += command.slice(cursor, span.start);
    const feedsIntoPipe = isRealPipeBoundary(command, span.end);
    if (!feedsIntoPipe && isNonExecutingArgsSimpleCommand(command, span)) {
      for (let i = span.start; i < span.end; i += 1) {
        const ch = command[i] as string;
        out += mask[i] || ch === '\n' ? ch : ' ';
      }
    } else {
      out += command.slice(span.start, span.end);
    }
    cursor = span.end;
  }
  out += command.slice(cursor);
  return out;
}

function hasUnboundedTailFollow(command: string): boolean {
  const view = blankQuotedInteriorForNonExecutingCommands(command);
  // 引用符とバックスラッシュを外した写しにもかける: `tail "-f" x` / `tail \-f x` は bash が引用を外してから argv にするため追従するが、元の写しでは見落とすため
  return hasTailFollowPattern(view) || hasTailFollowPattern(stripQuoteCharacters(view));
}

// 引用符の中の空白と区切り（`;` `&` `|`）は `_` へ替える: 引用符で包んだ1語は引用を外しても1語のままで、`tail -n 5 "my -f file"` の `-f` をフラグと読まないため
function stripQuoteCharacters(command: string): string {
  let out = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else out += /[\s;&|]/.test(ch) ? '_' : ch;
      continue;
    }
    if (ch === '\\') {
      const next = command[i + 1];
      if (next !== undefined) {
        out += quote !== null && /[\s;&|]/.test(next) ? '_' : next;
        i += 1;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else out += /[\s;&|]/.test(ch) ? '_' : ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '$' && (command[i + 1] === "'" || command[i + 1] === '"')) continue;
    out += ch;
  }
  return out;
}

// do / done の直前を行頭・`;` `&` `|`・空白に限る: 単語境界だけだと `/tmp/done` のようなパス名が終端に一致し、本体を早期に打ち切るため
// 規則を変えるときは findUntilWhileLoops も変える: 同じ一致を返す写しを bash-wait-guard-loop-scan.test.ts が突き合わせるため
export const LOOP_RE =
  /\b(until|while)\b([\s\S]*?)(?<=^|[\s;&|])do\b([\s\S]*?)(?<=^|[\s;&|])done\b/g;

export interface LoopMatch {
  readonly keyword: 'until' | 'while' | 'for';
  readonly cond: string;
  readonly body: string;
  readonly index: number;
}

const LOOP_BOUNDARY_RE = /[\s;&|]/;
const WORD_CHAR_RE = /\w/;

function isTokenAt(command: string, i: number, word: string): boolean {
  if (!command.startsWith(word, i)) return false;
  const prev = command[i - 1];
  if (prev !== undefined && !LOOP_BOUNDARY_RE.test(prev)) return false;
  const next = command[i + word.length];
  return next === undefined || !WORD_CHAR_RE.test(next);
}

function firstAtOrAfter(positions: readonly number[], from: number): number | undefined {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((positions[mid] ?? Infinity) < from) lo = mid + 1;
    else hi = mid;
  }
  return positions[lo];
}

function indexLoopTokens(command: string): { dos: number[]; dones: number[]; braces: number[] } {
  const dos: number[] = [];
  const dones: number[] = [];
  const braces: number[] = [];
  for (let i = command.indexOf('do'); i !== -1; i = command.indexOf('do', i + 1)) {
    if (isTokenAt(command, i, 'done')) dones.push(i);
    else if (isTokenAt(command, i, 'do')) dos.push(i);
  }
  for (let i = command.indexOf('}'); i !== -1; i = command.indexOf('}', i + 1)) {
    const prev = command[i - 1];
    if (prev !== undefined && /[\s;]/.test(prev)) braces.push(i);
  }
  return { dos, dones, braces };
}

const LOOP_KEYWORD_RE = /\b(until|while)\b/g;

export function findUntilWhileLoops(command: string): LoopMatch[] {
  const { dos, dones } = indexLoopTokens(command);
  const loops: LoopMatch[] = [];
  LOOP_KEYWORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LOOP_KEYWORD_RE.exec(command)) !== null) {
    const keyword = m[1] as 'until' | 'while';
    const condStart = m.index + keyword.length;
    const doAt = firstAtOrAfter(dos, condStart);
    if (doAt === undefined) break;
    const doneAt = firstAtOrAfter(dones, doAt + 2);
    if (doneAt === undefined) break;
    loops.push({
      keyword,
      cond: command.slice(condStart, doAt),
      body: command.slice(doAt + 2, doneAt),
      index: m.index,
    });
    LOOP_KEYWORD_RE.lastIndex = doneAt + 4;
  }
  return loops;
}

const C_FOR_HEADER_RE = /\bfor[ \t]*\(\(([^;()]*);([^;()]*);([^()]*)\)\)[\s;]*/g;

// 符号と先頭の 0 も非零と読む: bash の算術では `-1` / `+5` / `007` も真で、無限ループになるため
function isEndlessCForCondition(cond: string): boolean {
  const trimmed = cond.trim();
  return trimmed === '' || (/^[+-]?\d+$/.test(trimmed) && /[1-9]/.test(trimmed));
}

export function findUnboundedCFors(command: string): LoopMatch[] {
  if (!command.includes('for')) return [];
  const { dos, dones, braces } = indexLoopTokens(command);
  const loops: LoopMatch[] = [];
  C_FOR_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = C_FOR_HEADER_RE.exec(command)) !== null) {
    const cond = m[2] ?? '';
    if (!isEndlessCForCondition(cond)) continue;
    const bodyStartCandidate = m.index + m[0].length;
    let body: string | undefined;
    if (firstAtOrAfter(dos, bodyStartCandidate) === bodyStartCandidate) {
      const doneAt = firstAtOrAfter(dones, bodyStartCandidate + 2);
      if (doneAt !== undefined) body = command.slice(bodyStartCandidate + 2, doneAt);
    } else if (command[bodyStartCandidate] === '{') {
      const closeAt = firstAtOrAfter(braces, bodyStartCandidate + 1);
      if (closeAt !== undefined) body = command.slice(bodyStartCandidate + 1, closeAt);
    }
    if (body === undefined) continue;
    loops.push({ keyword: 'for', cond, body, index: m.index });
  }
  return loops;
}

const COUNTER_COMPARISON_RE = /-lt\b|-le\b|-gt\b|-ge\b|\(\(/;

function isBoundedLoop(keyword: 'until' | 'while', cond: string, body: string): boolean {
  if (keyword === 'while' && /\bread\b/.test(cond)) return true;
  if (COUNTER_COMPARISON_RE.test(cond) || COUNTER_COMPARISON_RE.test(body)) return true;
  if (/\bbreak\b/.test(body)) return true;
  return false;
}

// 前景の `gh run watch` を弾かない: ALTERNATIVES (1) が勧めている形を自分で禁じることになり、代替の無い拒否になるため
// `timeout` に包まれた背景の `gh run watch` を弾かない: 全体が `timeout N ...` に包まれていれば有界と読む約束を、この形のためだけに崩さないため
// 背景指定はコマンド文字列に現れない: `run_in_background` は invocation.backgrounded として呼び出し側から受け取る
export const GH_RUN_WATCH_RE = /\bgh\b(?:(?!;|&&|\|\||\||\n).)*?\brun\s+watch\b/;

const GH_WORD_SRC_FOR_RUN_WATCH = String.raw`\bgh\b`;
const RUN_WATCH_SRC = String.raw`\brun\s+watch\b`;
const RUN_WATCH_SEGMENT_END_SRC = /[;|\n\r\u2028\u2029]|&&/.source;

// 区切りの中の最初の `gh` だけを試す: 正規表現のままだと、区切りの無い1行に `gh` が並ぶと `gh` ごとに区切りまで読み直して2乗になるため
export function findGhRunWatch(command: string): { index: number; end: number } | null {
  const found = findGhRunWatchFrom(command, 0);
  return found === null ? null : { index: found.index, end: found.end };
}

function findGhRunWatchFrom(
  command: string,
  from0: number,
): { index: number; end: number; limit: number } | null {
  const gh = new RegExp(GH_WORD_SRC_FOR_RUN_WATCH, 'g');
  gh.lastIndex = from0;
  const runWatch = new RegExp(RUN_WATCH_SRC, 'g');
  const segmentEnd = new RegExp(RUN_WATCH_SEGMENT_END_SRC, 'g');
  let nextRunWatch: RegExpExecArray | null | undefined;
  let m: RegExpExecArray | null;
  while ((m = gh.exec(command)) !== null) {
    const from = m.index + m[0].length;
    segmentEnd.lastIndex = from;
    const end = segmentEnd.exec(command);
    const limit = end === null ? command.length : end.index;
    if (nextRunWatch === undefined || (nextRunWatch !== null && nextRunWatch.index < from)) {
      runWatch.lastIndex = from;
      nextRunWatch = runWatch.exec(command);
    }
    if (nextRunWatch === null) return null;
    if (nextRunWatch.index < limit) {
      return { index: m.index, end: nextRunWatch.index + nextRunWatch[0].length, limit };
    }
    gh.lastIndex = Math.max(gh.lastIndex, limit);
  }
  return null;
}

// `&` を単純に探さない: `2>&1`・`&&`・`|&`・`&>` にも現れ、誤爆するため
const FIRST_CONTROL_OPERATOR_RE = /[;\n]|(?<![<>&|])&(?![&>])/;

const FIRST_CONTROL_OPERATOR_GLOBAL_RE = new RegExp(FIRST_CONTROL_OPERATOR_RE.source, 'g');

function isBackgroundedGhRunWatch(trimmed: string, backgrounded: boolean): boolean {
  let match = findGhRunWatchFrom(trimmed, 0);
  if (match === null) return false;
  if (backgrounded) return true;
  let operator: RegExpExecArray | null | undefined;
  const isInsideBackgrounded = createBackgroundedBraceGroupChecker(trimmed);
  while (match !== null) {
    if (operator === undefined || (operator !== null && operator.index < match.end)) {
      FIRST_CONTROL_OPERATOR_GLOBAL_RE.lastIndex = match.end;
      operator = FIRST_CONTROL_OPERATOR_GLOBAL_RE.exec(trimmed);
    }
    if (operator !== null && operator[0] === '&') return true;
    const segment = trimmed.slice(commandPositionStartBefore(trimmed, match.index), match.index);
    if (isBackgroundingSetsid(segment)) return true;
    if (COPROC_RE.test(segment)) return true;
    if (isInsideBackgrounded(match.index)) return true;
    match = findGhRunWatchFrom(trimmed, match.limit);
  }
  return false;
}

const COPROC_RE = /(?:^|\s)coproc\s/;

function isBraceOpenAt(command: string, i: number): boolean {
  if (command[i] !== '{') return false;
  const prev = command[i - 1];
  const next = command[i + 1];
  const prevOk = prev === undefined || /[\s;&|(]/.test(prev);
  const nextOk = next === undefined || /\s/.test(next);
  return prevOk && nextOk;
}

function isBraceCloseAt(command: string, i: number): boolean {
  if (command[i] !== '}') return false;
  const prev = command[i - 1];
  return prev === undefined || /[\s;&|]/.test(prev);
}

function createBackgroundedBraceGroupChecker(command: string): (index: number) => boolean {
  const stack: number[] = [];
  let pos = 0;
  const closeOf = new Map<number, number>();
  const operatorRe = new RegExp(FIRST_CONTROL_OPERATOR_RE.source, 'g');
  let lastOperator: RegExpExecArray | null | undefined;
  let lastOperatorFrom = 0;
  const findClose = (open: number, from: number): number => {
    const known = closeOf.get(open);
    if (known !== undefined) return known;
    let depth = 0;
    let close = -1;
    for (let i = from; i < command.length; i += 1) {
      if (isBraceOpenAt(command, i)) {
        depth += 1;
      } else if (isBraceCloseAt(command, i)) {
        if (depth === 0) {
          close = i;
          break;
        }
        depth -= 1;
      }
    }
    closeOf.set(open, close);
    return close;
  };
  return (index: number): boolean => {
    for (; pos < index; pos += 1) {
      if (isBraceOpenAt(command, pos)) stack.push(pos);
      else if (isBraceCloseAt(command, pos)) stack.pop();
    }
    let balancedFrom = -1;
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const open = stack[k] as number;
      const close = findClose(open, balancedFrom >= 0 ? balancedFrom : open + 1);
      if (close < 0) return false;
      balancedFrom = close + 1;
      if (
        lastOperator === undefined ||
        lastOperatorFrom > close + 1 ||
        (lastOperator !== null && lastOperator.index < close + 1)
      ) {
        operatorRe.lastIndex = close + 1;
        lastOperatorFrom = close + 1;
        lastOperator = operatorRe.exec(command);
      }
      if (lastOperator !== null && lastOperator[0] === '&') return true;
    }
    return false;
  };
}

// setsid が fork しない場合を区別しない: 弾く側へ倒すため
const SETSID_RE = /(?:^|\s)setsid((?:[ \t]+-\S+)*)[ \t]/;
const SETSID_WAIT_OPTION_RE = /(?:^|\s)(?:--wait|-[A-Za-z]*w[A-Za-z]*)(?=\s|$)/;

function isBackgroundingSetsid(segment: string): boolean {
  const m = SETSID_RE.exec(segment);
  if (m === null) return false;
  return !SETSID_WAIT_OPTION_RE.test(m[1] ?? '');
}

// 規則を変えるときは findHeredocs も変える: 同じ一致を返す写しを bash-wait-guard-heredoc-scan.test.ts が突き合わせるため
export const HEREDOC_RE =
  /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2(?=[\s;&|]|$)/g;

export function stripHeredocs(command: string): string {
  const spans = findHeredocs(command);
  if (spans.length === 0) return command;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += command.slice(cursor, span.start);
    out += command.slice(span.start, span.end).replace(/[^\n]/g, ' ');
    cursor = span.end;
  }
  return out + command.slice(cursor);
}

export interface HeredocSpan {
  readonly start: number;
  readonly end: number;
  readonly bodyStart: number;
  readonly bodyEnd: number;
}

const HEREDOC_OPENER_RE = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n/g;

const HEREDOC_WORD_START_RE = /[A-Za-z_]/;
const HEREDOC_WORD_CHAR_RE = /\w/;
const HEREDOC_TERMINATOR_FOLLOW_RE = /[\s;&|]/;

interface HeredocTerminator {
  readonly newline: number;
  readonly end: number;
}

function firstTerminatorAtOrAfter(
  list: readonly HeredocTerminator[],
  from: number,
): HeredocTerminator | undefined {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid]?.newline ?? Infinity) < from) lo = mid + 1;
    else hi = mid;
  }
  return list[lo];
}

// 正規表現で探さない: 本文の部分が、終端の無いヒアドキュメントが並ぶ入力で2乗になるため
export function findHeredocs(command: string): HeredocSpan[] {
  if (!command.includes('<<')) return [];

  const terminators = new Map<string, HeredocTerminator[]>();
  for (
    let newline = command.indexOf('\n');
    newline !== -1;
    newline = command.indexOf('\n', newline + 1)
  ) {
    let i = newline + 1;
    while (command[i] === ' ' || command[i] === '\t') i += 1;
    const first = command[i];
    if (first === undefined || !HEREDOC_WORD_START_RE.test(first)) continue;
    let j = i + 1;
    while (j < command.length && HEREDOC_WORD_CHAR_RE.test(command[j] ?? '')) j += 1;
    const next = command[j];
    if (next !== undefined && !HEREDOC_TERMINATOR_FOLLOW_RE.test(next)) continue;
    const word = command.slice(i, j);
    const list = terminators.get(word);
    const entry = { newline, end: j };
    if (list === undefined) terminators.set(word, [entry]);
    else list.push(entry);
  }

  const spans: HeredocSpan[] = [];
  HEREDOC_OPENER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEREDOC_OPENER_RE.exec(command)) !== null) {
    const quote = m[1] ?? '';
    const word = m[2] ?? '';
    const bodyStart = m.index + m[0].length;
    const lengths = quote === '' ? word.length : 1;
    let found: HeredocTerminator | undefined;
    for (let k = 0; k < lengths && found === undefined; k += 1) {
      const delimiter = quote === '' ? word.slice(0, word.length - k) : word;
      const list = terminators.get(delimiter);
      if (list !== undefined) found = firstTerminatorAtOrAfter(list, bodyStart);
    }
    if (found === undefined) {
      HEREDOC_OPENER_RE.lastIndex = m.index + 1;
      continue;
    }
    spans.push({ start: m.index, end: found.end, bodyStart, bodyEnd: found.newline });
    HEREDOC_OPENER_RE.lastIndex = found.end;
  }
  return spans;
}

// 素の文字を1文字ずつ読む: 引用符の選択肢と開始文字が重ならず、後戻りの余地が無いため指数的に増えない
const ENV_ASSIGNMENT_VALUE_SRC = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'])*`;
const ENV_ASSIGNMENT_BODY_SRC = String.raw`[A-Za-z_][A-Za-z0-9_]*=${ENV_ASSIGNMENT_VALUE_SRC}`;

// 末尾の空白を `\s+` にしない: `\s` は改行を含み、代入の鎖が改行を跨いで繋がると、2乗の後戻りになるため（`timeout` と `env` の前置きの末尾も同じ）
const ENV_ASSIGNMENT_SRC = String.raw`${ENV_ASSIGNMENT_BODY_SRC}[ \t]+`;

// 継続時間の選択肢は先頭の文字（数字 / `.`）で排他に保つ: 後戻りが指数的に増えないため
// パスの上限（`[^\s=]{0,62}`）を外さない: 無制限だと、空白の無い長い1語（`a;a;a;…`）で各開始位置が語末まで走り2乗になるため
// パスを `/`・`./`・`../`・`~/` で始まる形に限る: 任意の文字から始めると、すべての開始位置で最大64文字先まで `/` を探して遅くなるため
const TIMEOUT_COMMAND_OPTION_SRC = String.raw`(?:--kill-after(?:=\S*|[ \t]+\S+)[ \t]+|--signal(?:=\S*|[ \t]+\S+)[ \t]+|--(?:foreground|preserve-status|verbose)[ \t]+|-[fvp]+[ \t]+|-[fvp]*[ks](?:\S+|[ \t]+\S+)[ \t]+)`;
const TIMEOUT_PATH_SRC = String.raw`(?:(?:~|\.{1,2})?\/(?:[^\s=]{0,62}\/)?)`;
const TIMEOUT_COMMAND_PREFIX_SRC = String.raw`${TIMEOUT_PATH_SRC}?timeout[ \t]+(?:${TIMEOUT_COMMAND_OPTION_SRC})*[^\s-]\S*[ \t]+`;

// `env NAME=値 ...` の `NAME=値` を読まない: 同じ入力を複数の分割で読めてしまうと、後戻りが指数的に増えるため
const ENV_COMMAND_OPTION_SRC = String.raw`(?:-u[ \t]+\S+[ \t]+|--unset=\S+[ \t]+|-S[ \t]+\S+[ \t]+|-i[ \t]+|--[ \t]+)`;
const ENV_COMMAND_PREFIX_SRC = String.raw`env\b[ \t]+(?:${ENV_COMMAND_OPTION_SRC})*`;

// `!` と `{` を lookbehind の文字集合に足さない: 直後のあらゆる位置が開始位置になり、繰り返し入力で2乗の後戻りになるため
// 予約語の直後の空白を `[ \t]+` に固定し `\s+` にしない: 予約語の連鎖が改行を跨いで繋がり、2乗になるため
// 選択肢の先頭の語を互いに重ならせない: 重なると後戻りが指数的に増えるため
const SHELL_KEYWORD_PREFIX_SRC = String.raw`(?:(?:if|then|elif|else|while|until|do|coproc|time(?:[ \t]+-p)?|[!{])[ \t]+)`;

const LEADING_COMMAND_PREFIX_NAME_SRC = String.raw`(?:sudo|doas|nice|ionice|nohup|command|builtin|exec|xargs|setsid|stdbuf|chronic|unbuffer|caffeinate)`;

const GH_WORD_SRC = String.raw`(?:\\gh|"gh"|'gh'|(?:[^\s;&|()<>\u0060"']*\/)?gh)`;

// オプションを `-\S+(?:[ \t]+\S+)?` にしない: 次の繰り返し単位の前置きコマンド名を値として飲み込め、指数的な後戻りになるため
// 値は `-` で始まらず、次の前置き・予約語・代入・`env`・`gh` の語の始まりでもない語に絞る: 値と読む読みと読まない読みが同じ続きへ再合流し、指数的に増えるため
// `timeout` と `flock` を値から外さない: 外すと `sudo -u timeout gh …` の `timeout` を値として読めず、すり抜けるため
const LEADING_COMMAND_PREFIX_VALUE_SRC = String.raw`(?!-)(?!(?:(?:if|then|elif|else|while|until|do|coproc|time)[ \t]|[!{][ \t]|[A-Za-z_][A-Za-z0-9_]*=|env\b|${LEADING_COMMAND_PREFIX_NAME_SRC}\b|${GH_WORD_SRC}\s))\S+`;

const LEADING_COMMAND_PREFIX_OPTION_SRC = String.raw`(?:-[A-Za-z][ \t]+${LEADING_COMMAND_PREFIX_VALUE_SRC}[ \t]+|-\S+[ \t]+)`;

const LEADING_COMMAND_PREFIX_SRC = String.raw`(?:${LEADING_COMMAND_PREFIX_NAME_SRC}\b[ \t]+(?:${LEADING_COMMAND_PREFIX_OPTION_SRC})*)`;

// 値を取らない側は、値を取る名前を否定の先読みで除く: 1つの語の読み方を常に1通りに保ち、指数的な後戻りを避けるため
// ファイルの位置引数を `-` で始まらない語に絞る: `'sudo ' + '-u flock '.repeat(n)` で2乗になるため
const FLOCK_OPTION_SRC = String.raw`(?:-[A-Za-z]*[wE][ \t]+\S+|--(?:wait|timeout|conflict-exit-code)(?:=\S+|[ \t]+\S+)|(?!-[A-Za-z]*[wE](?:[ \t]|$))(?!--(?:wait|timeout|conflict-exit-code)(?:[ \t=]|$))(?!-c(?:[ \t]|$))(?!--command(?:[ \t=]|$))-\S+)`;

const FLOCK_PREFIX_SRC = String.raw`(?:flock\b(?:[ \t]+${FLOCK_OPTION_SRC})*[ \t]+(?!-)\S+[ \t]+)`;

const LEADING_ENV_PREFIX_SRC = String.raw`(?:${SHELL_KEYWORD_PREFIX_SRC}|${ENV_ASSIGNMENT_SRC}|${TIMEOUT_COMMAND_PREFIX_SRC}|${ENV_COMMAND_PREFIX_SRC}|${LEADING_COMMAND_PREFIX_SRC}|${FLOCK_PREFIX_SRC})*`;

// `\u0060` はバッククォートの unicode エスケープ——`String.raw`
// の中に生のバッククォード文字を書くとテンプレートリテラル自体が終端してしまうため
const COMMAND_POSITION_LOOKBEHIND_SRC = String.raw`(?<=^|[;&|\n()\u0060])`;

type OutsideQuoteScanState = 'outside' | 'single' | 'double' | 'ansiC' | 'unknown';

// `$'…'` を専用の状態 `ansiC` で追う: ANSI-C クオートの中では `\'` がエスケープとして効くので、普通の単一引用符として読むと閉じ引用符を誤認するため
function computeOutsideQuoteMask(command: string): boolean[] {
  return computeQuoteScan(command).outside;
}

// `flattenSeparatorsInsideQuotes` は `comment` を別に見る: `outside` のままだとコメントの中の区切りを空白にし、`gh pr merge 1 # ; -d` のように実行されない `-d` まで呼び出し区間へ届いて偽陽性が増えるため
function computeQuoteScan(command: string): { outside: boolean[]; comment: boolean[] } {
  const mask: boolean[] = new Array(command.length);
  const comment: boolean[] = new Array(command.length);
  let state: OutsideQuoteScanState | 'comment' = 'outside';
  let escapedEnd = -2;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (state === 'comment' && ch === '\n') state = 'outside';
    mask[i] = state === 'outside';
    comment[i] = state === 'comment';
    if (state === 'unknown' || state === 'comment') continue;
    if (state === 'outside') {
      if (ch === '\\') {
        if (i + 1 >= command.length) {
          state = 'unknown';
        } else {
          i += 1;
          escapedEnd = i;
        }
      } else if (
        ch === '#' &&
        (i === 0 || (i - 1 !== escapedEnd && ' \t\n;&|()'.includes(command[i - 1] as string)))
      ) {
        state = 'comment';
        mask[i] = false;
        comment[i] = true;
      } else if (ch === '$' && command[i + 1] === "'") {
        state = 'ansiC';
        i += 1;
      } else if (ch === "'") {
        state = 'single';
      } else if (ch === '"') {
        state = 'double';
      }
    } else if (state === 'single') {
      if (ch === "'") state = 'outside';
    } else if (state === 'double') {
      if (ch === '\\') {
        if (i + 1 >= command.length) {
          state = 'unknown';
        } else {
          i += 1;
        }
      } else if (ch === '"') {
        state = 'outside';
      }
    } else if (state === 'ansiC') {
      if (ch === '\\') {
        if (i + 1 >= command.length) {
          state = 'unknown';
        } else {
          i += 1;
        }
      } else if (ch === "'") {
        state = 'outside';
      }
    }
  }
  return { outside: mask, comment };
}

// パス部分の量指定子を無制限の `\S*` にしない: `;` が大量に並ぶ入力でコマンド位置の候補が増え、各候補で後戻りして2乗になるため。`\S{0,64}` に絞る
const SHELL_VAR_SRC = String.raw`"?\$(?:(?:SHELL|BASH)\b|\{(?:SHELL|BASH)\})"?`;

const SHELL_NAME_SRC = String.raw`(?:(?:\S{0,64}\/)?(?:bash|dash|ksh|mksh|ash|yash|sh|zsh|fish|csh|tcsh)\b|${SHELL_VAR_SRC})`;

function commandPositionStartBefore(command: string, index: number): number {
  for (let i = index - 1; i >= 0; i -= 1) {
    const ch = command[i];
    if (
      ch === ';' ||
      ch === '&' ||
      ch === '|' ||
      ch === '\n' ||
      ch === '(' ||
      ch === ')' ||
      ch === '\u0060'
    ) {
      return i + 1;
    }
  }
  return 0;
}

// 行の継続は引用符もヒアドキュメントも見ずに全部取り除く: 写しは実際の実行とずれうるので、呼び出し側は元の文字列と写しの両方に判定をかける
function joinLineContinuations(command: string): string {
  return command.includes('\\\n') || command.includes('\\\r\n')
    ? command.replace(/\\\r?\n/g, '')
    : command;
}

export interface BashInvocation {
  readonly backgrounded?: boolean;
}

const DATA_HEREDOC_READER_RE = new RegExp(
  String.raw`^[ \t]*${LEADING_ENV_PREFIX_SRC}(?:cat|tee)\b`,
);

const SCRIPT_RUN_SHELL_TAIL_SRC = String.raw`(?:[ \t]+(?!-[A-Za-z]*c\b|--(?:version|help)\b)-\S*)*(?:[ \t]+(?!-)\S|[ \t]*(?:$|[;&|)\n]))`;

const SCRIPT_RUN_RE = new RegExp(
  String.raw`${COMMAND_POSITION_LOOKBEHIND_SRC}[ \t]*${LEADING_ENV_PREFIX_SRC}(?:${SHELL_NAME_SRC}${SCRIPT_RUN_SHELL_TAIL_SRC}|source\b|\.[ \t]|\.{0,2}\/\S)|>\([ \t]*${LEADING_ENV_PREFIX_SRC}${SHELL_NAME_SRC}`,
);

const STRING_EXEC_RE = /\$\(|`|(?:^|[\s;&|()])eval\b/;

// ヒアドキュメントの本文を消すのは、読み手が `cat` / `tee` で、開始の行に `|` が無く、書いたファイルを走らせうる形も文字列を組み立てて走らせうる形も無いときだけ: どれかが在ると本文が後で実行されるため
export function stripDataHeredocsForWaitForms(command: string): string {
  const spans = findHeredocs(command).filter((span) => {
    const lineEnd = command.indexOf('\n', span.start);
    const openerRest = command.slice(span.start, lineEnd < 0 ? command.length : lineEnd);
    if (openerRest.includes('|')) return false;
    const prefix = command.slice(commandPositionStartBefore(command, span.start), span.start);
    return DATA_HEREDOC_READER_RE.test(prefix);
  });
  if (spans.length === 0) return command;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += command.slice(cursor, span.bodyStart);
    out += command.slice(span.bodyStart, span.bodyEnd).replace(/[^\n]/g, ' ');
    cursor = span.bodyEnd;
  }
  out += command.slice(cursor);
  if (SCRIPT_RUN_RE.test(out) || STRING_EXEC_RE.test(out)) return command;
  return out;
}

export function inspectBashCommand(
  command: string,
  invocation: BashInvocation = {},
): WaitGuardVerdict {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { blocked: false };

  if (isTimeoutWrapped(trimmed)) return { blocked: false };

  // 待つ形の判定は元の文字列と行の継続を取り除いた写しの両方にかける: 改行を区切りとして読むので、`tail \` + 改行 + `-f x` を見落とすため
  const direct = inspectWaitForms(trimmed, invocation);
  if (direct.blocked) return direct;
  const joined = joinLineContinuations(trimmed);
  return joined === trimmed ? direct : inspectWaitForms(joined, invocation);
}

function inspectWaitForms(trimmed: string, invocation: BashInvocation): WaitGuardVerdict {
  const waitView = stripDataHeredocsForWaitForms(trimmed);

  if (isBackgroundedGhRunWatch(waitView, invocation.backgrounded === true)) {
    return {
      blocked: true,
      form: 'gh-run-watch-background',
      reason:
        '`gh run watch` を背景へ置いている' +
        '（`&` か `Bash` の `run_in_background`）。**待ちが自分の手から外れる形**で、' +
        '背景処理を残したまま作業者が畳むと、完了を待つ上限（30分）を超えた時点で打ち切られて委譲そのものが止まる' +
        '（実測 2026-09-17: 作業者2人が同じ形で停止した）。' +
        '代わりに次のいずれかを使うこと: ' +
        '(1) 前景で `timeout <秒> gh run watch <id> --exit-status` と書き、待ち自体に上限を持たせる。 ' +
        '(2) 上限付きのポーリングで確かめる' +
        '（`gh api repos/<owner>/<repo>/commits/<head_sha>/check-runs` を回数の上限を先に決めて叩く。' +
        '**head sha を明示すること** — PR 番号だけで引くと draft 中の `skipped` を緑と読む）。 ' +
        '⚠️ どちらでも `| tail` / `| head` をチェーンの末尾に置かないこと —— ' +
        'パイプの終了コードは既定で最後のものなので、`gh run watch` が 404 で即死しても成功の顔で返る。',
    };
  }

  if (hasUnboundedTailFollow(waitView)) {
    return {
      blocked: true,
      form: 'tail-f',
      reason: buildReason('`tail -f` / `tail --follow` はファイルの終端で止まらず追従し続ける'),
    };
  }

  for (const { keyword: loopKeyword, cond, body } of findUntilWhileLoops(waitView)) {
    const keyword = loopKeyword as 'until' | 'while';

    if (!/\bsleep\b/.test(body)) continue;
    if (isBoundedLoop(keyword, cond, body)) continue;

    return {
      blocked: true,
      form: keyword === 'until' ? 'until-sleep' : 'while-sleep',
      reason: buildReason(
        `\`${keyword} <条件>; do ... sleep ...; done\` は、条件が反転するまで` +
          '待ち続ける形で、相手（sentinel を書くはずの側）が先に死ねば二度と反転しない',
      ),
    };
  }

  // 条件の節をここで見ない: `isBoundedLoop` は `((` をカウンタ比較の印に数えるので、`for ((;;))` の見出しに当てると有界と誤読するため
  for (const { body } of findUnboundedCFors(waitView)) {
    if (!/\bsleep\b/.test(body)) continue;
    if (/\bbreak\b/.test(body) || COUNTER_COMPARISON_RE.test(body)) continue;
    return {
      blocked: true,
      form: 'for-sleep',
      reason: buildReason(
        '条件の無い C 形式の `for ((;;)); do ... sleep ...; done` は、`while true` と同じで、' +
          '自分からは終わらない',
      ),
    };
  }

  return { blocked: false };
}
