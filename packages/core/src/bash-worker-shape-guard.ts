import { computeQuoteScan } from './bash-wait-guard.js';

// 作業者の Bash だけに掛ける「形の歯」（#4947）。依頼文で禁じても破られる形を、機械の門で断って代わりの道を返す。
// 引用符の中・注釈・`<`・`<<<`・`<(...)`・パイプ・`bash -c` は断らない（誤検知の防ぎ）。
// 既知の穴: `bash -c '... > f'` のように引用符の中に入った形は見ない

export type WorkerShapeForm =
  | 'worker-heredoc'
  | 'worker-redirect'
  | 'worker-fd-dup'
  | 'worker-sed-in-place'
  | 'worker-node-eval'
  | 'worker-python-c'
  | 'worker-perl-eval';

export type WorkerShapeVerdict =
  { blocked: false } | { blocked: true; form: WorkerShapeForm; reason: string };

const REASONS: Record<WorkerShapeForm, string> = {
  'worker-heredoc':
    'ヒアドキュメント（`<<EOF`）は作業者の Bash では使えない。ファイルを作るなら Write、直すなら Edit を使うこと。ファイルへ流し込むためなら、内容を Write でファイルに書いてから、そのパスを引数に渡して実行する。',
  'worker-redirect':
    '出力のリダイレクト（`>`・`>>`・`>|`・`&>`・`>/dev/null`・`2>/dev/null`）は作業者の Bash では使えない。ファイルへ書くなら Write を使うこと。出力を捨てるためなら、捨てずに `| tail -n 20` か `| head` で絞る。要る行だけなら `| grep` を使う。',
  'worker-fd-dup':
    '記述子の付け替え（`2>&1`・`>&2`）は作業者の Bash では使えない。Bash の道具は標準エラーも一緒に返すので要らない。出力を絞るなら、付け替えずに `| tail -n 20` を使うこと。',
  'worker-sed-in-place':
    '`sed -i`（`--in-place`・`-Ei`・`-i.bak` を含む）は作業者の Bash では使えない。ファイルの置き換えは Edit を使うこと。例えば `foo` を `bar` に直すなら、Edit で old_string に `foo`、new_string に `bar` を渡す（同じ語が複数あるなら replace_all を立てるか、前後の行を含めて一意にする）。',
  'worker-node-eval':
    '`node -e`・`--eval`・`-p`・`--print` は作業者の Bash では使えない。読むだけなら Read か grep を使うこと。処理が要るなら、スクリプトを Write で作業ディレクトリの中に書き、絶対パスで `node /絶対パス/script.mjs` と実行する。',
  'worker-python-c':
    '`python -c`・`python3 -c` は作業者の Bash では使えない。読むだけなら Read か grep を使うこと。処理が要るなら、スクリプトを Write で作業ディレクトリの中に書き、絶対パスで `python3 /絶対パス/script.py` と実行する。',
  'worker-perl-eval':
    '`perl -e`・`-E`・`-i` は作業者の Bash では使えない。読むだけなら Read か grep を使うこと。ファイルの置き換えは Edit を使う。処理が要るなら、スクリプトを Write で作業ディレクトリの中に書き、絶対パスで `perl /絶対パス/script.pl` と実行する。',
};

function blocked(form: WorkerShapeForm): WorkerShapeVerdict {
  return { blocked: true, form, reason: REASONS[form] };
}

const SEGMENT_BOUNDARY = new Set([';', '&', '|', '\n', '(', ')', '\u0060']);

// `$((…))`・`((…))`・`[[ … ]]` の中の `>` は比較で、リダイレクトではない
function computeNonShellRegions(command: string, outside: readonly boolean[]): boolean[] {
  const skip: boolean[] = new Array<boolean>(command.length).fill(false);
  for (let i = 0; i < command.length; i += 1) {
    if (!outside[i]) continue;
    if (command[i] === '(' && command[i + 1] === '(') {
      let depth = 0;
      let j = i;
      for (; j < command.length; j += 1) {
        if (!outside[j]) continue;
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      for (let k = i; k <= j && k < command.length; k += 1) skip[k] = true;
      i = j;
    } else if (command[i] === '[' && command[i + 1] === '[') {
      let j = i + 2;
      while (j < command.length && !(outside[j] && command[j] === ']' && command[j + 1] === ']')) {
        j += 1;
      }
      for (let k = i; k <= j + 1 && k < command.length; k += 1) skip[k] = true;
      i = j + 1;
    }
  }
  return skip;
}

function findHeredocOpener(command: string, outside: readonly boolean[]): boolean {
  for (let i = 0; i + 1 < command.length; i += 1) {
    if (!outside[i] || command[i] !== '<' || command[i + 1] !== '<') continue;
    if (command[i - 1] === '<' || command[i + 2] === '<') continue;
    let j = i + 2;
    if (command[j] === '-') j += 1;
    while (command[j] === ' ' || command[j] === '\t') j += 1;
    if (/[A-Za-z_'"\\]/.test(command[j] ?? '')) return true;
  }
  return false;
}

function findRedirect(
  command: string,
  outside: readonly boolean[],
  skip: readonly boolean[],
): 'worker-redirect' | 'worker-fd-dup' | undefined {
  for (let i = 0; i < command.length; i += 1) {
    if (!outside[i] || skip[i] || command[i] !== '>') continue;
    if (command[i - 1] === '<') continue;
    let next = i + 1;
    if (command[next] === '>') next += 1;
    if (command[next] === '(' && next === i + 1) continue;
    if (command[next] === '&') return 'worker-fd-dup';
    return 'worker-redirect';
  }
  return undefined;
}

function unquote(token: string): string {
  return token.replace(/['"\\]/g, '');
}

// 注釈の文字を空白へ置き換えた写しを返す（注釈はここで落とす）
function scrubComments(command: string, comment: readonly boolean[]): string {
  if (!comment.some(Boolean)) return command;
  let out = '';
  for (let i = 0; i < command.length; i += 1) out += comment[i] ? ' ' : command.charAt(i);
  return out;
}

function splitSegments(command: string, outside: readonly boolean[]): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let tokenStart = -1;
  const endToken = (end: number): void => {
    if (tokenStart >= 0) tokens.push(command.slice(tokenStart, end));
    tokenStart = -1;
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (outside[i] && SEGMENT_BOUNDARY.has(ch)) {
      endToken(i);
      segments.push(tokens);
      tokens = [];
    } else if (outside[i] && (ch === ' ' || ch === '\t')) {
      endToken(i);
    } else if (tokenStart < 0) {
      tokenStart = i;
    }
  }
  endToken(command.length);
  segments.push(tokens);
  return segments;
}

const KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'while',
  'until',
  'do',
  'time',
  'coproc',
  '!',
  '{',
]);

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

// 前置きの命令ごとに、値を1つ取る短い選択肢
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-T', '-r', '-t', '-U']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p']),
  nohup: new Set(),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  setsid: new Set(),
  stdbuf: new Set(['-i', '-o', '-e']),
  chronic: new Set(),
  unbuffer: new Set(),
  caffeinate: new Set(['-t', '-w']),
  xargs: new Set(['-n', '-I', '-P', '-d', '-L', '-s', '-E', '-a']),
};

const TIMEOUT_VALUE_OPTIONS = new Set(['-k', '-s', '--signal', '--kill-after']);

// コマンドの位置にある語と、その引数を返す（前置きを読み飛ばす）
function commandWordOf(tokens: readonly string[]): { name: string; args: string[] } | undefined {
  const t = tokens.map(unquote);
  let i = 0;
  while (i < t.length) {
    const word = t[i] ?? '';
    const base = word.slice(word.lastIndexOf('/') + 1);
    if (word === '' || KEYWORDS.has(word) || ASSIGNMENT_RE.test(word)) {
      i += 1;
    } else if (base === 'env') {
      i += 1;
      while (i < t.length) {
        const o = t[i] ?? '';
        if (o === '-u' || o === '-C' || o === '-S') i += 2;
        else if (o.startsWith('-') || ASSIGNMENT_RE.test(o)) i += 1;
        else break;
      }
    } else if (base === 'timeout') {
      i += 1;
      while (i < t.length && (t[i] ?? '').startsWith('-')) {
        i += TIMEOUT_VALUE_OPTIONS.has(t[i] ?? '') ? 2 : 1;
      }
      i += 1;
    } else if (WRAPPERS[base] !== undefined) {
      const valued = WRAPPERS[base];
      i += 1;
      while (i < t.length && (t[i] ?? '').startsWith('-')) {
        i += valued?.has(t[i] ?? '') === true ? 2 : 1;
      }
    } else {
      return { name: base, args: t.slice(i + 1) };
    }
  }
  return undefined;
}

// 選択肢の並びを、最初の位置引数（スクリプト名など）まで読む。値を取る選択肢の次の語は読み飛ばす
function optionsBeforeOperand(args: readonly string[], valued: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (a === '--' || !a.startsWith('-') || a === '-') break;
    out.push(a);
    if (valued.has(a)) i += 1;
  }
  return out;
}

const NODE_VALUED = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '-C',
  '--conditions',
]);
const PYTHON_VALUED = new Set(['-W', '-X', '--check-hash-based-pycs']);

function inspectInterpreter(name: string, args: readonly string[]): WorkerShapeForm | undefined {
  if (name === 'sed') {
    return args.some(
      (a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='),
    )
      ? 'worker-sed-in-place'
      : undefined;
  }
  if (name === 'node' || name === 'nodejs') {
    const opts = optionsBeforeOperand(args, NODE_VALUED);
    return opts.some(
      (a) => /^-[ep]{1,2}$/.test(a) || a === '--eval' || a === '--print' || a.startsWith('--eval='),
    )
      ? 'worker-node-eval'
      : undefined;
  }
  if (/^python[0-9.]*$/.test(name)) {
    const opts = optionsBeforeOperand(args, PYTHON_VALUED);
    for (const a of opts) {
      if (/^-[bBdEiIOPqsSuvxR]*c/.test(a)) return 'worker-python-c';
      if (/^-[bBdEiIOPqsSuvxR]*m/.test(a)) return undefined;
    }
    return undefined;
  }
  if (name === 'perl') {
    const opts = optionsBeforeOperand(args, new Set());
    return opts.some((a) => /^-[0-9acdfFlnpsStTuUvwWX]*[eEi]/.test(a))
      ? 'worker-perl-eval'
      : undefined;
  }
  return undefined;
}

export function inspectWorkerBashShape(command: string): WorkerShapeVerdict {
  const scan = computeQuoteScan(command);
  const outside = scan.outside;

  if (findHeredocOpener(command, outside)) return blocked('worker-heredoc');

  const skip = computeNonShellRegions(command, outside);
  const redirect = findRedirect(command, outside, skip);
  if (redirect !== undefined) return blocked(redirect);

  const scrubbed = scrubComments(command, scan.comment);
  const tokenMask = outside.map((o, i) => o || scan.comment[i] === true);
  for (const tokens of splitSegments(scrubbed, tokenMask)) {
    const word = commandWordOf(tokens);
    if (word === undefined) continue;
    const form = inspectInterpreter(word.name, word.args);
    if (form !== undefined) return blocked(form);
  }
  return { blocked: false };
}
