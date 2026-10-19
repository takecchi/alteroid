import { computeQuoteScan } from './bash-wait-guard.js';

// Bash の「形の歯」（#4947 で作業者に、#4949 でマネージャーにも）。依頼文で禁じても破られる形を、機械の門で断って代わりの道を返す。
// 引用符の中・注釈・`<`・`<<<`・`<(...)`・パイプ `|` は断らない（誤検知の防ぎ）。ただし、状態を変えるコマンド（`git merge` など）を管の最後でない段に置く形は断る（#4990）。
// 引用符の中でも実行される所だけ中を読む: `bash -c` / `sh -c` の引数（1段）と、二重引用符の中の `$(...)`・バッククォート
// git は、コマンドの位置の `git` の全体の選択肢を読み飛ばした先の下位命令で判定する（`echo git reset` は通す）
// 既知の穴（断らない）: `eval`・変数に入れた命令（`$CMD`）・2段以上の入れ子の `bash -c`
// `chain`（`;` で繋ぐ形）は外側の `;` だけを見る。`for`・`while`・`until`・`if`・`case`・`select`・関数定義・`{ …; }` のような制御構文が在るコマンドは、丸ごと断らない（制御構文の `;` と繋ぎの `;` を字面では見分けきれないため）
// `pipe-trim`（管の最後が `head`・`tail`）は、一番外側の文だけを見る。`$(...)`・バッククォートの中の管は断らない（値を1行取る形のため）

export type BashShapeForm =
  | 'heredoc'
  | 'subst-heredoc'
  | 'redirect'
  | 'fd-dup'
  | 'pipe-stderr'
  | 'sed-in-place'
  | 'node-eval'
  | 'python-c'
  | 'perl-eval'
  | 'git-reset'
  | 'git-force-push'
  | 'git-rebase'
  | 'git-take-side'
  | 'mv-across-workspaces'
  | 'no-verify'
  | 'gh-merge-auto'
  | 'cd-git'
  | 'cd-chain'
  | 'chain'
  | 'pipe-trim'
  | 'pipe-masks-exit';

export type BashShapeVerdict =
  { blocked: false } | { blocked: true; form: BashShapeForm; reason: string };

// 理由の文は、最初の1文で「何を止めたか」と「代わりにどう書けば通るか」を言う（#4989）: 「使えない」とだけ言うと禁止の宣言として読まれ、担当が手を止めて依頼者の指示を待つため。
// 管（`| tail`）で絞ることは勧めない（#4990）: 終了コードが管の後ろのものになり、前のコマンドの失敗が成功に見えるため
// `pipe-masks-exit` は止めるコマンドの名前が文に入るので、ここには置かず `pipeMasksExitReason` で作る
const REASONS: Record<Exclude<BashShapeForm, 'pipe-masks-exit'>, string> = {
  heredoc:
    'ヒアドキュメント（`<<EOF`）は通らないので、ファイルを作るなら Write、直すなら Edit で書き、流し込む先のコマンドにはそのファイルの絶対パスを引数で渡すこと。',
  'subst-heredoc':
    '二重引用符の中のコマンド置換（`"$(cat <<\'EOF\' …)"`）やバッククォートの中のヒアドキュメントは実行されるので通らない。コミットメッセージや PR の本文は Write でファイルに書き、`git commit -F <絶対パス>`・`gh pr create --body-file <絶対パス>` のようにファイルで渡すこと。',
  redirect:
    '出力のリダイレクト（`>`・`>>`・`>|`・`&>`・`>/dev/null`・`2>/dev/null`）は通らないので、ファイルへ書くなら Write を使い、出力を捨てたいだけならリダイレクトを外してそのまま打ち、出力を読むこと（長い出力は道具が切って、全文をファイルに残す）。',
  'fd-dup':
    '記述子の付け替え（`2>&1`・`>&2`）は通らないので、付け替えを外してそのまま打つこと（Bash の道具は標準エラーも一緒に返す）。',
  'pipe-stderr':
    '`|&`（標準エラーも一緒に管へ流す形）は通らないので、`|&` を外してそのまま打つこと（Bash の道具は標準エラーも一緒に返す）。',
  'sed-in-place':
    '`sed -i`（`--in-place`・`-Ei`・`-i.bak` を含む）は通らないので、ファイルの置き換えは Edit で、old_string に元の文字列、new_string に新しい文字列を渡して行うこと（同じ語が複数あるなら replace_all を立てるか、前後の行を含めて一意にする）。',
  'node-eval':
    '`node -e`・`--eval`・`-p`・`--print` は通らないので、読むだけなら Read か grep を使い、処理が要るならスクリプトを Write で作業ディレクトリの中に書いて `node /絶対パス/script.mjs` で実行すること。',
  'python-c':
    '`python -c`・`python3 -c` は通らないので、読むだけなら Read か grep を使い、処理が要るならスクリプトを Write で作業ディレクトリの中に書いて `python3 /絶対パス/script.py` で実行すること。',
  'perl-eval':
    '`perl -e`・`-E`・`-i` は通らないので、読むだけなら Read か grep、ファイルの置き換えは Edit を使い、処理が要るならスクリプトを Write で作業ディレクトリの中に書いて `perl /絶対パス/script.pl` で実行すること。',
  'git-reset':
    '`git reset`（`--hard`・`--soft`・`--mixed` を含む全ての形）は通らないので、ステージを外すなら `git restore --staged <path>`、コミットを取り消して戻すなら `git revert <commit>` を使うこと（作業ツリーの変更を捨てる・枝を動かすのが目的のときだけは、捨てる前に依頼者へ確かめる）。',
  'git-force-push':
    '`git push` の強制（`--force`・`--force-with-lease`・`--force-if-includes`・`-f`・`-uf` のような組み合わせ・`+` で始まる refspec）は通らないので、新しいコミットを積んで普通に `git push` し、履歴を書き換える必要があるなら新しい枝を切って PR にすること。',
  'git-rebase':
    '`git rebase`（`git pull --rebase`・`git pull -r` を含む）は通らないので、最新の main を取り込むなら `git merge origin/main` を使うこと（途中で止まった rebase から抜ける `git rebase --abort` は通る）。',
  'git-take-side':
    '衝突を片側の版へ丸ごと寄せる形（`-X theirs`・`-X ours`・`-s ours`・`git checkout --theirs`・`git restore --ours` など）は通らないので、選択肢を外して `git merge origin/main` のように普通に取り込み、衝突したファイルを Read で読んで、衝突の塊ごとに Edit で解くこと（片側の変更を丸ごと捨てるのが目的のときだけは、捨てる前に依頼者へ確かめる）。',
  'mv-across-workspaces':
    '別の担当の作業場（`/tmp/mgr-<id>`・`/workspace/mgr-<id>`）をまたいで `mv` で動かす形は通らないので、元の作業ツリーは動かさずに残し、要るものを取り出すこと: コミットは元のツリーで `git -C <元の絶対パス> push` してから自分の作業場へ clone し直し、コミットしていないファイルは `cp` で自分の作業場へ写す（元は消さない）。',
  'no-verify':
    '`--no-verify`（git のどの下位命令でも）と `git commit -n` は通らないので、フックが落ちた理由を直してから、付けずに打ち直すこと。',
  'gh-merge-auto':
    '`gh pr merge --auto` は通らないので、CI を前景で `timeout 530 gh run watch <id> --exit-status` で待ち、緑なら `gh pr merge <番号> --squash --match-head-commit <sha>` でマージすること。',
  'cd-git':
    '`cd` と `git` を1回の Bash に重ねる形（`cd <dir> && git …`）は、Claude Code 本体が確認に上げて手が止まりやすいので通らない。`cd` を外して `git -C <絶対パス> …` で場所を指すこと。',
  'cd-chain':
    '`cd` の後ろに別のコマンドを同じ1回で続ける形（`cd <dir> && make`・`cd <dir>; ls`）は通らないので、`cd` を外して、コマンドの側で場所を指すこと（`git -C <絶対パス>`・`pnpm -C <絶対パス>`・`make -C <絶対パス>`・コマンドの引数に絶対パス）。`cd` だけを1回で打つのは通る。',
  chain:
    '`;` で2つ以上のコマンドを繋ぐ形は通らないので、1回の Bash には1つのコマンドだけを打ち、前の結果を見てから次を打つ形で順に呼ぶこと（`;` で繋ぐと、前のコマンドが失敗しても後ろが走り、後ろだけが成功して返る）。',
  'pipe-trim':
    '管の最後の段が `head`・`tail` の形（`git log | head -20`・`pnpm test | tail -50`）は通らない。管の終了コードは最後の段のものになり、前のコマンドの失敗が成功に見えるので、管を外してそのまま打つこと（長い出力は道具が切って、全文をファイルに残す）。件数を絞りたいなら、コマンド自身の選択肢（`git log -n 20`・`gh … --limit 20`）を使うこと。',
};

/** 断る形ごとの要約（プロンプトに載せる一覧の元）。型で全部の形を網羅させる: 形を足して要約を書き忘れると typecheck が落ちる（#5017）。 */
export const BASH_SHAPE_SUMMARIES: Record<BashShapeForm, { shape: string; instead: string }> = {
  heredoc: { shape: '`<<EOF`', instead: 'Write でファイルを作り、絶対パスで渡す' },
  'subst-heredoc': {
    shape: '`"$(cat <<EOF …)"`（二重引用符の中のヒアドキュメント）',
    instead:
      'Write でファイルを作り、`git commit -F <絶対パス>`・`gh pr create --body-file <絶対パス>` で渡す',
  },
  redirect: {
    shape: '`>`・`>>`・`&>`・`2>/dev/null`',
    instead: 'ファイルへ書くなら Write。出力は捨てずにそのまま読む',
  },
  'fd-dup': { shape: '`2>&1`・`>&2`', instead: '付け替えを外してそのまま打つ' },
  'pipe-stderr': { shape: '`|&`', instead: '`|&` を外してそのまま打つ' },
  'sed-in-place': { shape: '`sed -i`', instead: 'Edit で置き換える' },
  'node-eval': {
    shape: '`node -e`・`-p`',
    instead: 'Read か grep。処理が要るなら Write でスクリプトを作って絶対パスで実行する',
  },
  'python-c': {
    shape: '`python -c`・`python3 -c`',
    instead: 'Read か grep。処理が要るなら Write でスクリプトを作って絶対パスで実行する',
  },
  'perl-eval': {
    shape: '`perl -e`・`-E`・`-i`',
    instead: 'Read か grep か Edit。処理が要るなら Write でスクリプトを作って絶対パスで実行する',
  },
  'git-reset': {
    shape: '`git reset`',
    instead: '`git restore --staged <path>`・`git revert <commit>`',
  },
  'git-force-push': {
    shape: '`git push --force`・`-f`・`--force-with-lease`・`+` で始まる refspec',
    instead:
      '新しいコミットを積んで普通に `git push` する。書き換えが要るなら新しい枝を切って PR にする',
  },
  'git-rebase': { shape: '`git rebase`・`git pull --rebase`', instead: '`git merge origin/main`' },
  'git-take-side': {
    shape: '`git merge -X theirs`・`-X ours`・`-s ours`・`git checkout --theirs`・`--ours`',
    instead: '普通に取り込み、衝突の塊を Read で読んで Edit で1つずつ解く',
  },
  'mv-across-workspaces': {
    shape: '別の担当の作業場（`/tmp/mgr-<id>`）をまたぐ `mv`',
    instead:
      '元は動かさない。コミットは元のツリーで push して clone し直し、コミットしていないファイルは `cp` で写す',
  },
  'no-verify': {
    shape: '`--no-verify`・`git commit -n`',
    instead: 'フックが落ちた理由を直して、付けずに打ち直す',
  },
  'gh-merge-auto': {
    shape: '`gh pr merge --auto`',
    instead:
      '前景で `timeout 530 gh run watch <id> --exit-status` で待ち、緑なら `gh pr merge <番号> --squash --match-head-commit <sha>`',
  },
  'cd-git': { shape: '`cd <dir> && git …`', instead: '`git -C <絶対パス> …`' },
  'cd-chain': {
    shape: '`cd <dir> && make`・`cd <dir>; ls`（`cd` の後ろに別のコマンドを続ける形）',
    instead:
      '`cd` を外し、コマンドの側で場所を指す（`pnpm -C <絶対パス>`・`make -C <絶対パス>`・絶対パス）',
  },
  chain: {
    shape: '`;` で2つ以上のコマンドを繋ぐ形',
    instead: '1回の Bash に1つのコマンドを打ち、前の結果を見てから次を打つ',
  },
  'pipe-trim': {
    shape: '`| head`・`| tail`（管の最後の段）',
    instead:
      '管を外してそのまま打つ。件数はコマンド自身の選択肢で絞る（`git log -n 20`・`gh … --limit 20`）',
  },
  'pipe-masks-exit': {
    shape:
      '`git merge`・`git commit`・`gh pr merge`・`prettier --write` などを管の最後でない段に置く形',
    instead: '管を外して、そのコマンドだけを打つ',
  },
};

/** 形の歯が断る形の一覧を、プロンプトに載せる箇条書きにして返す（歯の定義から生成する。#5017）。 */
export function bashShapePromptLines(): string {
  return Object.values(BASH_SHAPE_SUMMARIES)
    .map(({ shape, instead }) => `- ${shape} → ${instead}`)
    .join('\n');
}

/** どの形の理由にも最後に添える1文（#4989）。止めたのが1回の呼び出しだけで、書き直して続けてよいことを言う。 */
export const BASH_SHAPE_CONTINUE_NOTE =
  '止めたのはこの1回の呼び出しだけなので、上のとおり書き直して、依頼者の返事を待たずにそのまま続けること。迷ったら、1回の Bash では1つのコマンドだけを、変数を使わず絶対パスで打ち、出力はそのまま読む。';

type FixedReasonForm = Exclude<BashShapeForm, 'pipe-masks-exit'>;

function blocked(form: FixedReasonForm): BashShapeVerdict {
  return { blocked: true, form, reason: `${REASONS[form]}${BASH_SHAPE_CONTINUE_NOTE}` };
}

function pipeMasksExitReason(name: string): string {
  return `\`${name}\` の出力を管（\`| tail\` など）に渡すと、終了コードが管の最後のコマンドのものになり、\`${name}\` が失敗しても成功に見えるので通らない。管を外して \`${name} …\` だけを打ち、出力はそのまま読むこと（長い出力は道具が切って、全文をファイルに残す）。${BASH_SHAPE_CONTINUE_NOTE}`;
}

const SEGMENT_BOUNDARY = new Set([';', '&', '|', '\n', '(', ')', '\u0060']);

// 中を読む入れ子の深さの上限: `bash -c` の引数は最初の1段だけ（depth 0 のときだけ）、コマンド置換は depth 1 まで。無限に再帰しない
const MAX_SUBSTITUTION_DEPTH = 1;

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
): 'redirect' | 'fd-dup' | 'pipe-stderr' | undefined {
  for (let i = 0; i < command.length; i += 1) {
    if (!outside[i] || skip[i]) continue;
    if (command[i] === '|' && command[i + 1] === '&') return 'pipe-stderr';
    if (command[i] !== '>') continue;
    if (command[i - 1] === '<') continue;
    let next = i + 1;
    if (command[next] === '>') next += 1;
    if (command[next] === '(' && next === i + 1) continue;
    if (command[next] === '&') return 'fd-dup';
    return 'redirect';
  }
  return undefined;
}

function unquote(token: string): string {
  return token.replace(/['"\\]/g, '');
}

// 語の引用符を、シェルが外すのと同じ順で1段はがす（`bash -c` の引数・バッククォートの中身を取り出すため）
function dequote(token: string): string {
  let out = '';
  for (let i = 0; i < token.length; i += 1) {
    const ch = token.charAt(i);
    if (ch === "'") {
      const j = token.indexOf("'", i + 1);
      if (j < 0) {
        out += token.slice(i + 1);
        break;
      }
      out += token.slice(i + 1, j);
      i = j;
    } else if (ch === '"') {
      i += 1;
      while (i < token.length && token.charAt(i) !== '"') {
        const c = token.charAt(i);
        if (c === '\\' && '"\\$\u0060\n'.includes(token.charAt(i + 1)) && i + 1 < token.length) {
          out += token.charAt(i + 1);
          i += 2;
        } else {
          out += c;
          i += 1;
        }
      }
    } else if (ch === '\\') {
      out += token.charAt(i + 1);
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

// ヒアドキュメントの本文の終わり（終端の行の末尾）の位置を返す。終端が無い・ヒアドキュメントでなければ -1
function heredocEnd(command: string, at: number): number {
  let j = at + 2;
  let dash = false;
  if (command.charAt(j) === '-') {
    dash = true;
    j += 1;
  }
  while (command.charAt(j) === ' ' || command.charAt(j) === '\t') j += 1;
  if (!/[A-Za-z_'"\\]/.test(command.charAt(j))) return -1;
  let delimiter: string;
  const q = command.charAt(j);
  if (q === "'" || q === '"') {
    const close = command.indexOf(q, j + 1);
    if (close < 0) return -1;
    delimiter = command.slice(j + 1, close);
    j = close + 1;
  } else {
    const m = /^\\?([A-Za-z_][A-Za-z0-9_]*)/.exec(command.slice(j));
    if (m === null) return -1;
    delimiter = m[1] ?? '';
    j += m[0].length;
  }
  let lineStart = command.indexOf('\n', j);
  if (lineStart < 0) return -1;
  lineStart += 1;
  while (lineStart <= command.length) {
    let lineEnd = command.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = command.length;
    const line = command.slice(lineStart, lineEnd);
    if ((dash ? line.replace(/^\t+/, '') : line) === delimiter) return lineEnd;
    if (lineEnd >= command.length) return -1;
    lineStart = lineEnd + 1;
  }
  return -1;
}

// `from` は `$(` の直後。対応する `)` の位置を返す（無ければ -1）。入れ子の引用符・括弧・ヒアドキュメントの本文を読み飛ばす
function findMatchingParen(command: string, from: number): number {
  let depth = 1;
  for (let i = from; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (ch === '\\') {
      i += 1;
    } else if (ch === "'") {
      const j = command.indexOf("'", i + 1);
      if (j < 0) return -1;
      i = j;
    } else if (ch === '"') {
      const j = skipDouble(command, i + 1);
      if (j < 0) return -1;
      i = j;
    } else if (
      ch === '<' &&
      command.charAt(i + 1) === '<' &&
      command.charAt(i + 2) !== '<' &&
      command.charAt(i - 1) !== '<'
    ) {
      const end = heredocEnd(command, i);
      if (end >= 0) i = end;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// `from` は開き `"` の直後。閉じ `"` の位置を返す（無ければ -1）
function skipDouble(command: string, from: number): number {
  for (let i = from; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (ch === '\\') {
      i += 1;
    } else if (ch === '"') {
      return i;
    } else if (ch === '$' && command.charAt(i + 1) === '(') {
      const close = findMatchingParen(command, i + 2);
      if (close < 0) return -1;
      i = close;
    } else if (ch === '\u0060') {
      const close = findBacktickClose(command, i + 1);
      if (close < 0) return -1;
      i = close;
    }
  }
  return -1;
}

function findBacktickClose(command: string, from: number): number {
  for (let i = from; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (ch === '\\') i += 1;
    else if (ch === '\u0060') return i;
  }
  return -1;
}

type Substitution = { start: number; end: number; body: string };

// 二重引用符の中の `$(...)` とバッククォートを集める（実行されるので中を読む）。単一引用符・ANSI-C 引用・注釈の中は見ない
// `$((...))`（算術）は集めない
function findQuotedSubstitutions(command: string): Substitution[] {
  const found: Substitution[] = [];
  const n = command.length;
  let i = 0;
  while (i < n) {
    const ch = command.charAt(i);
    if (ch === '\\') {
      i += 2;
    } else if (ch === "'") {
      const j = command.indexOf("'", i + 1);
      if (j < 0) break;
      i = j + 1;
    } else if (ch === '$' && command.charAt(i + 1) === "'") {
      i += 2;
      while (i < n && command.charAt(i) !== "'") i += command.charAt(i) === '\\' ? 2 : 1;
      i += 1;
    } else if (ch === '#' && (i === 0 || ' \t\n;&|()'.includes(command.charAt(i - 1)))) {
      const j = command.indexOf('\n', i);
      if (j < 0) break;
      i = j + 1;
    } else if (ch === '"') {
      i += 1;
      while (i < n && command.charAt(i) !== '"') {
        const c = command.charAt(i);
        if (c === '\\') {
          i += 2;
        } else if (c === '$' && command.charAt(i + 1) === '(') {
          const close = findMatchingParen(command, i + 2);
          const end = close < 0 ? n : close + 1;
          if (command.charAt(i + 2) !== '(') {
            found.push({ start: i, end, body: command.slice(i + 2, close < 0 ? n : close) });
          }
          i = end;
        } else if (c === '\u0060') {
          const close = findBacktickClose(command, i + 1);
          const end = close < 0 ? n : close + 1;
          const raw = command.slice(i + 1, close < 0 ? n : close);
          found.push({ start: i, end, body: raw.replace(/\\([\\$\u0060])/g, '$1') });
          i = end;
        } else {
          i += 1;
        }
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return found;
}

// 取り出した置換の範囲を同じ長さの `x` に置き換えた写しを返す（外側の引用符の読み取りが、入れ子の引用符で狂わないようにする）
function maskSubstitutions(command: string, subs: readonly Substitution[]): string {
  let out = '';
  let at = 0;
  for (const s of subs) {
    out += command.slice(at, s.start) + 'x'.repeat(s.end - s.start);
    at = s.end;
  }
  return out + command.slice(at);
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

type CommandWord = { name: string; args: string[]; rawArgs: string[] };

// コマンドの位置にある語と、その引数を返す（前置きを読み飛ばす）。`rawArgs` は引用符を外す前の引数（`args` と同じ並び）
function commandWordOf(tokens: readonly string[]): CommandWord | undefined {
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
      return { name: base, args: t.slice(i + 1), rawArgs: tokens.slice(i + 1) };
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

function inspectInterpreter(name: string, args: readonly string[]): FixedReasonForm | undefined {
  if (name === 'sed') {
    return args.some(
      (a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='),
    )
      ? 'sed-in-place'
      : undefined;
  }
  if (name === 'node' || name === 'nodejs') {
    const opts = optionsBeforeOperand(args, NODE_VALUED);
    return opts.some(
      (a) => /^-[ep]{1,2}$/.test(a) || a === '--eval' || a === '--print' || a.startsWith('--eval='),
    )
      ? 'node-eval'
      : undefined;
  }
  if (/^python[0-9.]*$/.test(name)) {
    const opts = optionsBeforeOperand(args, PYTHON_VALUED);
    for (const a of opts) {
      if (/^-[bBdEiIOPqsSuvxR]*c/.test(a)) return 'python-c';
      if (/^-[bBdEiIOPqsSuvxR]*m/.test(a)) return undefined;
    }
    return undefined;
  }
  if (name === 'perl') {
    const opts = optionsBeforeOperand(args, new Set());
    return opts.some((a) => /^-[0-9acdfFlnpsStTuUvwWX]*[eEi]/.test(a)) ? 'perl-eval' : undefined;
  }
  return undefined;
}

// 値を取る選択肢（`-C <path>`・`-c <k=v>`・`--git-dir <path>` など）。`--git-dir=…` のように `=` で続けた形は1語なので、ここに無くても読み飛ばせる
const GIT_GLOBAL_VALUED = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--attr-source',
]);

// コマンドの位置の `git` の全体の選択肢（`--no-pager`・`-P`・`-C <path>` など）を読み飛ばした先の下位命令
function gitSubcommandOf(args: readonly string[]): { sub: string; rest: string[] } | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (!a.startsWith('-')) return { sub: a, rest: args.slice(i + 1) };
    if (GIT_GLOBAL_VALUED.has(a)) i += 1;
  }
  return undefined;
}

// 短い選択肢の組み合わせ（`-uf`）に `flag` があるか。値を取る文字（`valueChars`）に当たったら、その先は値なので読まない
function hasShortFlag(args: readonly string[], flag: string, valueChars: string): boolean {
  for (const a of args) {
    if (!a.startsWith('-') || a.startsWith('--') || a.length < 2) continue;
    for (const ch of a.slice(1)) {
      if (ch === flag) return true;
      if (valueChars.includes(ch)) break;
    }
  }
  return false;
}

function isForcePush(rest: readonly string[]): boolean {
  if (hasShortFlag(rest, 'f', 'o')) return true;
  return rest.some(
    (a) =>
      a === '--force' ||
      a === '--force-with-lease' ||
      a.startsWith('--force-with-lease=') ||
      a === '--force-if-includes' ||
      (!a.startsWith('-') && a.startsWith('+')),
  );
}

// 衝突を片側の版へ丸ごと寄せる戦略か（`-X theirs`・`-Xours`・`--strategy-option=theirs`・`-s ours`・`--strategy=ours`）。
// `-s` を戦略として読むのは merge・pull だけ（`shortStrategy`）: cherry-pick・revert の `-s` は `--signoff` のため
function takesSideByStrategy(opts: readonly string[], shortStrategy: boolean): boolean {
  for (let i = 0; i < opts.length; i += 1) {
    const a = opts[i] ?? '';
    let option: string | undefined;
    if (a === '-X' || a === '--strategy-option') option = opts[i + 1];
    else if (a.startsWith('--strategy-option=')) option = a.slice('--strategy-option='.length);
    else if (/^-X./.test(a)) option = a.slice(2);
    if (option === 'theirs' || option === 'ours') return true;
    let strategy: string | undefined;
    if (a === '--strategy' || (shortStrategy && a === '-s')) strategy = opts[i + 1];
    else if (a.startsWith('--strategy=')) strategy = a.slice('--strategy='.length);
    else if (shortStrategy && /^-s./.test(a)) strategy = a.slice(2);
    if (strategy === 'ours') return true;
  }
  return false;
}

function inspectGit(args: readonly string[]): FixedReasonForm | undefined {
  const g = gitSubcommandOf(args);
  if (g === undefined) return undefined;
  const dd = g.rest.indexOf('--');
  const opts = dd < 0 ? g.rest : g.rest.slice(0, dd);
  if (opts.includes('--no-verify')) return 'no-verify';
  if (
    ((g.sub === 'merge' || g.sub === 'pull') && takesSideByStrategy(opts, true)) ||
    ((g.sub === 'cherry-pick' || g.sub === 'revert') && takesSideByStrategy(opts, false)) ||
    ((g.sub === 'checkout' || g.sub === 'restore') &&
      opts.some((a) => a === '--theirs' || a === '--ours'))
  ) {
    return 'git-take-side';
  }
  switch (g.sub) {
    case 'reset':
      return 'git-reset';
    case 'rebase':
      // `--abort` / `--quit` の1つだけは通す（#4957）: 履歴を書き換えず、途中で止まった rebase から抜けるだけのため。断ると、`pull.rebase=true` の設定などで rebase の途中に入った担当が抜けられなくなる
      return g.rest.length === 1 && (g.rest[0] === '--abort' || g.rest[0] === '--quit')
        ? undefined
        : 'git-rebase';
    case 'pull':
      return hasShortFlag(opts, 'r', 'sXSj') ||
        opts.some((a) => a === '--rebase' || (a.startsWith('--rebase=') && a !== '--rebase=false'))
        ? 'git-rebase'
        : undefined;
    case 'push':
      return isForcePush(g.rest) ? 'git-force-push' : undefined;
    case 'commit':
      return hasShortFlag(opts, 'n', 'mFCctSu') ? 'no-verify' : undefined;
    default:
      return undefined;
  }
}

// 作業場の持ち主（`/tmp/mgr-<8桁>`・`/tmp/mgr-<8桁>-wt1`・`/workspace/mgr-<8桁>` の8桁）。作業場の外のパスは持ち主なし
const WORKSPACE_OWNER_RE = /^(?:\/tmp|\/workspace)\/mgr-([0-9a-f]{8})(?=[-/]|$)/;

// 持ち主の違う作業場をまたぐ `mv` だけを断る（後継が前任の作業ツリーを自分の作業場へ引っ越す形。2026-10-19 PROFILE-3）。
// `mv` 全般は断らない: 自分の作業場の中の改名・移動は普通の作業で、分類器に止められた実例も無いため
function inspectMv(args: readonly string[]): FixedReasonForm | undefined {
  const operands: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (!optionsEnded && a === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && (a === '-t' || a === '--target-directory')) {
      operands.push(args[i + 1] ?? '');
      i += 1;
    } else if (!optionsEnded && a.startsWith('--target-directory=')) {
      operands.push(a.slice('--target-directory='.length));
    } else if (!optionsEnded && (a === '-S' || a === '--suffix')) {
      i += 1;
    } else if (optionsEnded || !a.startsWith('-')) {
      operands.push(a);
    }
  }
  const owners = new Set(
    operands.flatMap((operand) => WORKSPACE_OWNER_RE.exec(operand)?.[1] ?? []),
  );
  return owners.size >= 2 ? 'mv-across-workspaces' : undefined;
}

// `gh` の先頭の位置引数（`pr merge` など）。`-R <repo>` は読み飛ばす
function ghPositionals(args: readonly string[]): string[] {
  const positional: string[] = [];
  for (let i = 0; i < args.length && positional.length < 2; i += 1) {
    const a = args[i] ?? '';
    if (a.startsWith('-')) {
      if (a === '-R' || a === '--repo') i += 1;
    } else {
      positional.push(a);
    }
  }
  return positional;
}

function inspectGh(args: readonly string[]): FixedReasonForm | undefined {
  const positional = ghPositionals(args);
  return positional[0] === 'pr' && positional[1] === 'merge' && args.includes('--auto')
    ? 'gh-merge-auto'
    : undefined;
}

// 管の最後でない段に置かれたとき、終了コードが隠れて困るコマンド（#4990）。mutating は状態を変えるので止め、checker は成否を見るためのもので知らせる
type PipeStage = { kind: 'mutating'; name: string } | { kind: 'checker'; name: string };

const GIT_MUTATING = new Set([
  'merge',
  'pull',
  'commit',
  'cherry-pick',
  'revert',
  'am',
  'apply',
  'push',
  'checkout',
  'switch',
  'restore',
]);

const STASH_MUTATING = new Set(['push', 'pop', 'apply', 'drop', 'save']);

// `pnpm`・`npm`・`yarn`・`bun` の全体の選択肢のうち、値を取るもの（`--filter=x` のように `=` で続けた形は1語なので、ここに無くても読み飛ばせる）
const PACKAGE_MANAGER_VALUED = new Set([
  '-C',
  '--dir',
  '--filter',
  '-F',
  '--prefix',
  '--workspace',
  '--cwd',
  '--reporter',
]);

const SCRIPT_CHECKER_RE = /^(test|build|typecheck|lint|format|check)/;

// 値を取る選択肢を読み飛ばして、位置引数だけを集める
function positionalsOf(args: readonly string[], valued: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (a === '--') continue;
    if (a.startsWith('-')) {
      if (valued.has(a)) i += 1;
    } else {
      out.push(a);
    }
  }
  return out;
}

// 引数の並び（選択肢を含む）のうち、最初の位置引数の位置。無ければ -1
function firstOperandIndex(args: readonly string[], valued: ReadonlySet<string>): number {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (a === '--') continue;
    if (!a.startsWith('-')) return i;
    if (valued.has(a)) i += 1;
  }
  return -1;
}

// 道具そのもの（`pnpm exec`・`npx` の先にも来る）。git・gh・パッケージマネージャーは含まない
function classifyTool(name: string, args: readonly string[]): PipeStage | undefined {
  switch (name) {
    case 'prettier':
      return args.includes('--write') || args.includes('-w')
        ? { kind: 'mutating', name: 'prettier --write' }
        : { kind: 'checker', name };
    case 'eslint':
      return args.includes('--fix')
        ? { kind: 'mutating', name: 'eslint --fix' }
        : { kind: 'checker', name };
    case 'vitest':
    case 'jest':
    case 'tsc':
    case 'pytest':
    case 'make':
      return { kind: 'checker', name };
    case 'cargo': {
      const sub = positionalsOf(args, new Set())[0];
      return sub !== undefined && ['test', 'build', 'check', 'clippy'].includes(sub)
        ? { kind: 'checker', name: `cargo ${sub}` }
        : undefined;
    }
    case 'go': {
      const sub = positionalsOf(args, new Set())[0];
      return sub !== undefined && ['test', 'build', 'vet'].includes(sub)
        ? { kind: 'checker', name: `go ${sub}` }
        : undefined;
    }
    default:
      return undefined;
  }
}

function classifyPackageManager(name: string, args: readonly string[]): PipeStage | undefined {
  const at = firstOperandIndex(args, PACKAGE_MANAGER_VALUED);
  if (at < 0) return undefined;
  const first = args[at] ?? '';
  const after = args.slice(at + 1);
  if (first === 'exec' || first === 'dlx') {
    const inner = firstOperandIndex(after, new Set());
    return inner < 0 ? undefined : classifyTool(after[inner] ?? '', after.slice(inner + 1));
  }
  const script =
    first === 'run' || first === 'run-script'
      ? positionalsOf(after, PACKAGE_MANAGER_VALUED)[0]
      : first;
  return script !== undefined && SCRIPT_CHECKER_RE.test(script)
    ? { kind: 'checker', name: `${name} ${script}` }
    : undefined;
}

function classifyStage(word: CommandWord): PipeStage | undefined {
  const { name, args } = word;
  switch (name) {
    case 'git': {
      const g = gitSubcommandOf(args);
      if (g === undefined) return undefined;
      if (GIT_MUTATING.has(g.sub)) return { kind: 'mutating', name: `git ${g.sub}` };
      if (g.sub === 'stash') {
        const next = g.rest[0];
        return next === undefined || next.startsWith('-') || STASH_MUTATING.has(next)
          ? { kind: 'mutating', name: 'git stash' }
          : undefined;
      }
      return undefined;
    }
    case 'gh': {
      const p = ghPositionals(args);
      if (p[0] === 'pr' && p[1] === 'merge') return { kind: 'mutating', name: 'gh pr merge' };
      if (p[0] === 'run' && p[1] === 'watch') return { kind: 'checker', name: 'gh run watch' };
      if (p[0] === 'pr' && p[1] === 'checks') return { kind: 'checker', name: 'gh pr checks' };
      return undefined;
    }
    case 'pnpm':
    case 'npm':
    case 'yarn':
    case 'bun':
      return classifyPackageManager(name, args);
    case 'npx':
    case 'pnpx': {
      const at = firstOperandIndex(args, new Set(['-p', '--package', '-c', '--call']));
      return at < 0 ? undefined : classifyTool(args[at] ?? '', args.slice(at + 1));
    }
    default:
      return classifyTool(name, args);
  }
}

// 文（`;`・`&&`・`||`・`&`・改行・括弧で区切る）ごとに、単独の `|` で区切った段の並びを返す。`||` は文の区切り
function splitPipelines(command: string, outside: readonly boolean[]): string[][][] {
  const statements: string[][][] = [];
  let stages: string[][] = [];
  let tokens: string[] = [];
  let tokenStart = -1;
  const endToken = (end: number): void => {
    if (tokenStart >= 0) tokens.push(command.slice(tokenStart, end));
    tokenStart = -1;
  };
  const endStage = (end: number): void => {
    endToken(end);
    stages.push(tokens);
    tokens = [];
  };
  const endStatement = (end: number): void => {
    endStage(end);
    statements.push(stages);
    stages = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    if (!outside[i]) {
      if (tokenStart < 0) tokenStart = i;
    } else if (ch === '|' && command.charAt(i + 1) === '|') {
      endStatement(i);
      i += 1;
    } else if (ch === '|') {
      endStage(i);
      if (command.charAt(i + 1) === '&') i += 1;
    } else if (SEGMENT_BOUNDARY.has(ch)) {
      endStatement(i);
    } else if (ch === ' ' || ch === '\t') {
      endToken(i);
    } else if (tokenStart < 0) {
      tokenStart = i;
    }
  }
  endStatement(command.length);
  return statements;
}

export type PipeExitMasking =
  { kind: 'mutating'; name: string } | { kind: 'checker'; name: string; last: string };

/**
 * 管の最後でない段に、終了コードを隠すと困るコマンドが在るかを読む（#4990）。段が2つ以上の文だけを見る。
 * 最初に当たった mutating を、無ければ最初に当たった checker を返す。引用符・注釈の中は見ない。
 */
export function inspectPipeExitMasking(command: string): PipeExitMasking | undefined {
  // 管の各段の終了コードを自分で拾う形（`PIPESTATUS`・`pipefail`）は見ない: 隠れていないので、止めても知らせても邪魔になるだけのため
  if (/\bPIPESTATUS\b|\bpipefail\b/.test(command)) return undefined;
  const subs = findQuotedSubstitutions(command);
  const visible = subs.length > 0 ? maskSubstitutions(command, subs) : command;
  const scan = computeQuoteScan(visible);
  const scrubbed = scrubComments(visible, scan.comment);
  const tokenMask = scan.outside.map((o, i) => o || scan.comment[i] === true);
  let checker: PipeExitMasking | undefined;
  for (const stages of splitPipelines(scrubbed, tokenMask)) {
    if (stages.length < 2) continue;
    const last = commandWordOf(stages[stages.length - 1] ?? [])?.name ?? '';
    for (const tokens of stages.slice(0, -1)) {
      const word = commandWordOf(tokens);
      const stage = word === undefined ? undefined : classifyStage(word);
      if (stage === undefined) continue;
      if (stage.kind === 'mutating') return stage;
      checker ??= { kind: 'checker', name: stage.name, last };
    }
  }
  return checker;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);

// `bash -c '<script>'` の `<script>`（引用符を外す前の語）。`-lc`・`-ec` のような組み合わせも読む
function shellScriptOperand(rawArgs: readonly string[]): string | undefined {
  for (let i = 0; i < rawArgs.length; i += 1) {
    const a = unquote(rawArgs[i] ?? '');
    if (a === '--' || !(a.startsWith('-') || a.startsWith('+')) || a === '-') return undefined;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a)) return rawArgs[i + 1];
    if (a === '-o' || a === '+o' || a === '-O' || a === '+O') i += 1;
  }
  return undefined;
}

/**
 * 検査のコマンドを管に渡した Bash が成功で返った回に添える知らせ（#4990）。止めない。読めなかったときは何も添えない: 知らせのために道具の結果を壊さないため。
 */
export function pipeExitNotice(toolName: string | undefined, command: unknown): string | null {
  if (toolName !== 'Bash' || typeof command !== 'string') return null;
  try {
    const masking = inspectPipeExitMasking(command);
    if (masking?.kind !== 'checker') return null;
    return `直前の Bash が成功で返ったのは管の最後の \`${masking.last}\` の終了コードで、\`${masking.name}\` が通ったことは表さない。成否は出力の要約の行で確かめ、見えなければ管を外して打ち直すこと（#4990）。`;
  } catch {
    return null;
  }
}

// 制御構文の語（文の頭に来る）。これが在るコマンドの `;` は繋ぎではなく構文の一部かもしれないので、`chain` で断らない
const CONTROL_CONSTRUCT_WORDS = new Set([
  'for',
  'while',
  'until',
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  '{',
  '}',
]);

function hasControlConstruct(scrubbed: string, tokenMask: readonly boolean[]): boolean {
  for (const tokens of splitSegments(scrubbed, tokenMask)) {
    const first = tokens[0];
    if (first === undefined) continue;
    if (CONTROL_CONSTRUCT_WORDS.has(first)) return true;
  }
  // 関数定義（`name() { …; }`）: `(` の直後の `)` で区切られるので、語の並びでは見えない
  return /(?:^|[\s;&|])[A-Za-z_][A-Za-z0-9_-]*[ \t]*\([ \t]*\)/.test(
    scrubbed.replace(/[^\n]/g, (ch, at: number) => (tokenMask[at] === true ? ch : 'x')),
  );
}

// 外側の `;` で、前にも後ろにもコマンドが在るものがあるか。引用符・注釈・`\;`・`$((…))`・`[[ … ]]` の中は見ない
function findChainSemicolon(
  scrubbed: string,
  tokenMask: readonly boolean[],
  skip: readonly boolean[],
): boolean {
  if (hasControlConstruct(scrubbed, tokenMask)) return false;
  for (let i = 0; i < scrubbed.length; i += 1) {
    if (scrubbed.charAt(i) !== ';' || tokenMask[i] !== true || skip[i] === true) continue;
    if (scrubbed.charAt(i + 1) === ';' || scrubbed.charAt(i - 1) === ';') continue;
    if (scrubbed.slice(0, i).trim() !== '' && scrubbed.slice(i + 1).trim() !== '') return true;
  }
  return false;
}

// 括弧で包まれた `$(...)`・`$((...))`・バッククォートの範囲を、管の判定から外す（値を取るための管は断らない）
function maskCommandSubstitutions(scrubbed: string, outside: readonly boolean[]): boolean[] {
  const mask = outside.map((o) => o === true);
  for (let i = 0; i < scrubbed.length; i += 1) {
    if (!mask[i]) continue;
    let close: number;
    if (scrubbed.charAt(i) === '$' && scrubbed.charAt(i + 1) === '(') {
      close = findMatchingParen(scrubbed, i + 2);
    } else if (scrubbed.charAt(i) === '`') {
      close = findBacktickClose(scrubbed, i + 1);
    } else {
      continue;
    }
    const end = close < 0 ? scrubbed.length - 1 : close;
    for (let k = i; k <= end; k += 1) mask[k] = false;
    i = end;
  }
  return mask;
}

const TAIL_FOLLOW_FLAG_RE = /^-[A-Za-z]*[fF]/;

// 一番外側の文の、管の最後の段が `head`・`tail` か。`tail -f`・`--follow` は待ちの歯の受け持ちなので数えない
function findTrimmedPipe(command: string): 'head' | 'tail' | undefined {
  if (/\bPIPESTATUS\b|\bpipefail\b/.test(command)) return undefined;
  const subs = findQuotedSubstitutions(command);
  const visible = subs.length > 0 ? maskSubstitutions(command, subs) : command;
  const scan = computeQuoteScan(visible);
  const scrubbed = scrubComments(visible, scan.comment);
  const tokenMask = maskCommandSubstitutions(
    scrubbed,
    scan.outside.map((o, i) => o || scan.comment[i] === true),
  );
  for (const stages of splitPipelines(scrubbed, tokenMask)) {
    if (stages.length < 2) continue;
    const last = commandWordOf(stages[stages.length - 1] ?? []);
    if (last === undefined || (last.name !== 'head' && last.name !== 'tail')) continue;
    if (
      last.name === 'tail' &&
      last.args.some(
        (a) => a === '--follow' || a.startsWith('--follow=') || TAIL_FOLLOW_FLAG_RE.test(a),
      )
    ) {
      continue;
    }
    return last.name;
  }
  return undefined;
}

// `valueSubstitution` は二重引用符の中の `$(...)` の中身を読むときだけ立てる: 値を1行取る管（`"$(ls | head -1)"`）を `pipe-trim` で断らないため
export function inspectBashShape(
  command: string,
  depth = 0,
  valueSubstitution = false,
): BashShapeVerdict {
  const subs = depth <= MAX_SUBSTITUTION_DEPTH ? findQuotedSubstitutions(command) : [];
  const visible = subs.length > 0 ? maskSubstitutions(command, subs) : command;

  const scan = computeQuoteScan(visible);
  const outside = scan.outside;

  if (findHeredocOpener(visible, outside)) return blocked('heredoc');

  const skip = computeNonShellRegions(visible, outside);
  const redirect = findRedirect(visible, outside, skip);
  if (redirect !== undefined) return blocked(redirect);

  const scrubbed = scrubComments(visible, scan.comment);
  const tokenMask = outside.map((o, i) => o || scan.comment[i] === true);
  // `cd` の後の段に `git` が来たら止める（#4993）: Claude Code 本体がこの形を bare リポジトリ攻撃の防ぎとして確認に上げ、
  // 分類器に止められると「止めて依頼者に説明せよ」の文が返って担当が手を止めるため。形の歯は本体の確認より先に返る
  let sawCd = false;
  let sawCdChain = false;
  for (const tokens of splitSegments(scrubbed, tokenMask)) {
    const word = commandWordOf(tokens);
    if (word === undefined) continue;
    const form = inspectInterpreter(word.name, word.args);
    if (form !== undefined) return blocked(form);
    if (word.name === 'cd') {
      sawCd = true;
    } else if (word.name === 'git') {
      const gitForm = inspectGit(word.args);
      if (gitForm !== undefined) return blocked(gitForm);
      if (sawCd) return blocked('cd-git');
    } else if (word.name === 'gh') {
      const ghForm = inspectGh(word.args);
      if (ghForm !== undefined) return blocked(ghForm);
    } else if (word.name === 'mv') {
      const mvForm = inspectMv(word.args);
      if (mvForm !== undefined) return blocked(mvForm);
    } else if (depth === 0 && SHELLS.has(word.name)) {
      const script = shellScriptOperand(word.rawArgs);
      if (script !== undefined) {
        const inner = inspectBashShape(dequote(script), depth + 1);
        if (inner.blocked) return inner;
      }
    }
    // `cd` の後ろに別のコマンドが続く形。ここでは返さず、後ろに `git`（`cd-git`）や他の形が在れば、それらの理由を先に返す: 直す道がはっきりしているため
    if (sawCd && word.name !== 'cd') sawCdChain = true;
  }
  if (sawCdChain) return blocked('cd-chain');

  for (const sub of subs) {
    const inner = inspectBashShape(sub.body, depth + 1, true);
    if (!inner.blocked) continue;
    return inner.form === 'heredoc' ? blocked('subst-heredoc') : inner;
  }

  // 管の判定は最後に置く: 上の形のほうが直す道がはっきりしているため。`bash -c` の中・置換の中は、上の再帰が自分の最後で読む
  const masking = inspectPipeExitMasking(command);
  if (masking?.kind === 'mutating') {
    return { blocked: true, form: 'pipe-masks-exit', reason: pipeMasksExitReason(masking.name) };
  }
  // 管の最後の `head`・`tail` は pipe-masks-exit の後に置く: 状態を変えるコマンドを管へ渡す形のほうが害が大きく、理由に名前が入るため
  if (!valueSubstitution && findTrimmedPipe(command) !== undefined) return blocked('pipe-trim');
  // `;` の繋ぎは最後に置く: ここまでの形のほうが直す道がはっきりしているため
  if (findChainSemicolon(scrubbed, tokenMask, skip)) return blocked('chain');
  return { blocked: false };
}
