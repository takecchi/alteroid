/**
 * 外へ成果を出すコマンドの一覧と、Bash のコマンド文字列からそれを見つける判定。
 *
 * 背景処理の完了待ちで畳むターンでも、ここに当たったコマンドが走っていればその報告は待たずに配る
 * （`runner.ts` が `report.outwardActions` に載せ、`manager.ts` が畳まない）。
 * 一覧に無い出し方（`gh api -X POST` など）は取りこぼす。取りこぼした報告は、30分のまとめ配り（`flushWithheldReports`）が拾う。
 * 一覧を足すときは `outward-commands.test.ts` の固定も一緒に直すこと: 黙って増減させないため。
 */
export const OUTWARD_COMMANDS: readonly (readonly string[])[] = [
  ['gh', 'pr', 'create'],
  ['gh', 'pr', 'merge'],
  ['gh', 'pr', 'close'],
  ['gh', 'pr', 'comment'],
  ['gh', 'pr', 'review'],
  ['gh', 'issue', 'create'],
  ['gh', 'issue', 'close'],
  ['gh', 'issue', 'comment'],
  ['gh', 'release', 'create'],
  ['git', 'push'],
];

// 値を取る git の大域オプション: `git -C <dir> push` の `<dir>` をサブコマンドと読まないため
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const TIMEOUT_OPTIONS_WITH_VALUE = new Set(['-k', '-s', '--kill-after', '--signal']);

function basenameOf(token: string): string {
  const at = token.lastIndexOf('/');
  return at === -1 ? token : token.slice(at + 1);
}

// 先頭の `NAME=value` と `timeout <オプション> <秒>` を外す: 器の作法でコマンドの頭に付くことが多く、外さないと当たらないため
function stripPrefixes(tokens: readonly string[]): string[] {
  let rest = [...tokens];
  while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0] ?? '')) rest = rest.slice(1);
  if (basenameOf(rest[0] ?? '') === 'timeout') {
    rest = rest.slice(1);
    while ((rest[0] ?? '').startsWith('-')) {
      // `-k 5` / `-s KILL` は値を取る（`--kill-after=5` の形は1語）
      rest = rest.slice(TIMEOUT_OPTIONS_WITH_VALUE.has(rest[0] ?? '') ? 2 : 1);
    }
    rest = rest.slice(1);
  }
  return rest;
}

// サブコマンドより前のオプションを外して、コマンド名とサブコマンドの並びにする
function commandWords(tokens: readonly string[]): string[] {
  const [head, ...rest] = tokens;
  if (head === undefined) return [];
  const words = [basenameOf(head)];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? '';
    if (token.startsWith('-')) {
      if (words[0] === 'git' && GIT_OPTIONS_WITH_VALUE.has(token)) i += 1;
      continue;
    }
    words.push(token);
  }
  return words;
}

/**
 * コマンド文字列に含まれる、一覧に当たったコマンドの名前（例 `'gh pr merge'`）を、重複なしで出た順に返す。
 * `&&` `||` `;` `|` と改行で区切った各部分を見る。引用符の中までは読まない（中の区切りで部分が増えても、当たらなければ何も起きない）。
 */
export function outwardCommandsIn(command: string): string[] {
  const found: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const words = commandWords(stripPrefixes(segment.trim().split(/\s+/).filter(Boolean)));
    for (const outward of OUTWARD_COMMANDS) {
      if (outward.every((word, index) => words[index] === word)) {
        const label = outward.join(' ');
        if (!found.includes(label)) found.push(label);
      }
    }
  }
  return found;
}
