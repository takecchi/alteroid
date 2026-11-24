import { commandWordOf, simpleCommandTokens } from './bash-shape-guard.js';
import { stripDataHeredocsForWaitForms } from './bash-wait-guard.js';
import { isSecretEnvName } from './denial-input-head.js';
import { resolveEnumEnv } from './placed-env.js';

// Bash の「環境変数の値を出す形」の歯。Bash の出力は会話の記録（SDK の生ログ・tasks/*.output）へそのまま書かれ、
// その書き込みは CLI の中で起きるので alteroid は書く前に伏せられない（PostToolUse で差し替えられるのは MCP の道具の出力だけ）。
// ⟹ 値が出力に載る前、呼び出しの時点で断る。名前だけ・在るかだけを確かめる書き方は通るので、能力は削っていない（代わりの書き方を理由に入れる）。
// 見分けるだけで守りではない: 文字列しか見ないので、スクリプトファイルの中・`eval`・変数に入れた命令・`echo "$GH_TOKEN"` のように名前を指して値を出す形は拾えない。
// 塞いだことにしない。生ログへ写す側の伏せ字（`secret-value-redaction.ts`）と2枚で受ける。

export type BashEnvForm = 'env' | 'printenv' | 'printenv-secret' | 'export' | 'declare' | 'set' | 'proc-environ';

type BashEnvVerdict = { blocked: false } | { blocked: true; form: BashEnvForm; reason: string };

export const BASH_ENV_GUARD_ENV = 'ALTEROID_BASH_ENV_GUARD';
const BASH_ENV_GUARD_VALUES = ['on', 'off'] as const;
type BashEnvGuardMode = (typeof BASH_ENV_GUARD_VALUES)[number];
// 既定は掛ける: 形の歯（既定 off）と違い、運用の好みではなく資格の値が平文で残る穴のため。方針なので設定で開けられる（north_star 禁止2）
export const DEFAULT_BASH_ENV_GUARD: BashEnvGuardMode = 'on';

// 綴り違いは黙って既定へ倒さず落とす（呼び手の catch が確認か拒否へ倒す）
export function resolveBashEnvGuard(env: NodeJS.ProcessEnv): BashEnvGuardMode {
  return resolveEnumEnv(env, BASH_ENV_GUARD_ENV, BASH_ENV_GUARD_VALUES, DEFAULT_BASH_ENV_GUARD);
}

// 実効の値: 実行環境プロファイルの値を優先し、無ければ runner の env（形の歯と同じ読み方。プロファイルに1行置けば次の呼び出しから効く）
export function resolveEffectiveBashEnvGuard(
  env: NodeJS.ProcessEnv,
  profileEnv: Readonly<Record<string, string>>,
): BashEnvGuardMode {
  const fromProfile = profileEnv[BASH_ENV_GUARD_ENV]?.trim();
  if (fromProfile !== undefined && fromProfile.length > 0) {
    return resolveBashEnvGuard({ [BASH_ENV_GUARD_ENV]: fromProfile });
  }
  return resolveBashEnvGuard(env);
}

const WHY =
  'Bash の出力は会話の記録にそのまま残るので、`GH_TOKEN` などの資格の値が平文で載る。';
const INSTEAD =
  '名前の一覧が要るなら `compgen -e`（値を出さない）、ある変数が在るかだけなら `test -n "${名前+x}"`、秘密でない1つの値なら `printenv PATH` のように名前を指して打つこと。';
const CONTINUE =
  '止めたのはこの1回の呼び出しだけなので、書き直して、依頼者の返事を待たずにそのまま続けること。';

const SHAPES: Record<BashEnvForm, string> = {
  env: '引数なしの `env`（環境変数を値ごと全部出す）',
  printenv: '引数なしの `printenv`（環境変数を値ごと全部出す）',
  'printenv-secret': '`printenv` に秘密の名前（`TOKEN`・`KEY`・`SECRET`・`PASSWORD` などを含む名前）を渡す形（その値を出す）',
  export: '引数なしの `export`・`export -p`（環境変数を値ごと全部出す）',
  declare: '名前を付けない `declare`・`typeset`（`-p`・`-x` を含む。変数を値ごと全部出す）',
  set: '引数なしの `set`（変数を値ごと全部出す）',
  'proc-environ': '`/proc/<pid>/environ` を読む形（プロセスの環境変数を値ごと出す）',
};

function blocked(form: BashEnvForm): BashEnvVerdict {
  return { blocked: true, form, reason: `${SHAPES[form]}は通らない。${WHY}${INSTEAD}${CONTINUE}` };
}

/** プロンプトに載せる一覧（歯の定義から作る: 形を足して書き忘れないため）。 */
export function bashEnvPromptLines(): string {
  return [
    `- 引数なしの \`env\`・\`printenv\`・\`export -p\`・\`declare -p\`・\`set\`、\`/proc/*/environ\` を読む形 → 名前だけなら \`compgen -e\`、在るかだけなら \`test -n "\${名前+x}"\``,
    `- \`printenv <秘密の名前>\`（\`TOKEN\`・\`KEY\`・\`SECRET\` などを含む名前） → \`test -n "\${名前+x}"\`（値は出さない）`,
  ].join('\n');
}

const PROC_ENVIRON_RE = /\/proc\/\S*\/environ\b/;
// `>`・`2>>`・`<`・`&>` で始まる語（リダイレクト）。値だけの語（`>` の次の行き先）は呼び手が読み飛ばす
const REDIRECT_RE = /^(?:\d*|&)[<>]/;
const BARE_REDIRECT_RE = /^(?:\d*|&)(?:[<>]+|>&|<&)$/;
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

function unquote(token: string): string {
  return token.replace(/['"\\]/g, '');
}

// リダイレクト（とその行き先）を除いた引数
function withoutRedirects(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (BARE_REDIRECT_RE.test(a)) {
      i += 1;
    } else if (!REDIRECT_RE.test(a)) {
      out.push(a);
    }
  }
  return out;
}

const ENV_VALUED = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);

function inspectEnvArgs(rawArgs: readonly string[]): BashEnvForm | undefined {
  const args = withoutRedirects(rawArgs);
  for (let i = 0; i < args.length; i += 1) {
    const a = unquote(args[i] ?? '');
    // 空の環境から始める形は、置いた代入の他に何も出さない
    if (a === '-i' || a === '--ignore-environment' || a === '-') return undefined;
    if (ENV_VALUED.has(a)) {
      i += 1;
    } else if (a.startsWith('-') || ASSIGNMENT_RE.test(a)) {
      continue;
    } else {
      // `env` の後ろに命令が在る: その命令を同じ規則で読む（`env FOO=1 printenv` を拾う）
      return inspectWord(commandWordOf(args.slice(i), true));
    }
  }
  return 'env';
}

function inspectWord(word: ReturnType<typeof commandWordOf>): BashEnvForm | undefined {
  if (word === undefined) return undefined;
  const args = withoutRedirects(word.rawArgs).map(unquote);
  switch (word.name) {
    case 'env':
      return inspectEnvArgs(word.rawArgs);
    case 'printenv': {
      const names = args.filter((a) => !a.startsWith('-'));
      if (names.length === 0) return 'printenv';
      return names.some(isSecretEnvName) ? 'printenv-secret' : undefined;
    }
    case 'export':
      return args.every((a) => a === '-p') ? 'export' : undefined;
    case 'declare':
    case 'typeset': {
      // 名前を1つでも指せば、その名前だけの話になる。`-f`・`-F` は関数の一覧で、変数の値ではない
      if (!args.every((a) => /^[-+][A-Za-z]*$/.test(a))) return undefined;
      return args.some((a) => /[fF]/.test(a)) ? undefined : 'declare';
    }
    case 'set':
      return args.length === 0 ? 'set' : undefined;
    default:
      return undefined;
  }
}

// `command -v env`・`type env` のように、名前を調べるだけの形は通す（`command` は前置きとして読み飛ばされ `env` が命令に見えるため）
function isLookupOnly(tokens: readonly string[]): boolean {
  const t = tokens.map(unquote);
  const at = t.findIndex((w) => w === 'command' || w.endsWith('/command'));
  return at >= 0 && (t[at + 1] === '-v' || t[at + 1] === '-V');
}

export function inspectBashEnvDump(command: string): BashEnvVerdict {
  if (command.trim().length === 0) return { blocked: false };
  const view = stripDataHeredocsForWaitForms(command);
  for (const tokens of simpleCommandTokens(view)) {
    // `/proc/*/environ` はどの命令の引数でも・リダイレクトの元でも断る（`cat`・`tr … <`・`strings`・`xxd` のどれでも値が出る）
    if (tokens.some((t) => PROC_ENVIRON_RE.test(unquote(t)))) return blocked('proc-environ');
    if (isLookupOnly(tokens)) continue;
    const form = inspectWord(commandWordOf(tokens, true));
    if (form !== undefined) return blocked(form);
  }
  return { blocked: false };
}
