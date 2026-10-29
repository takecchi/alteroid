/**
 * auto mode が危険として捨てる Bash の allow 規則かを、SDK の判定の写しで予測する（#5435）。
 *
 * 出典: @anthropic-ai/claude-agent-sdk 0.3.312 の同梱 CLI（単体バイナリ。minify 名は版で変わる）の
 * `stripDangerousPermissionsForAutoMode`（minify 名 `pY`）→ `jOs` → `tfe` → `w2t` → `EVr`（Bash）→ `Aer`。
 * 語リストは `j`（= `tqo` = `Ter` + zsh, fish, eval, exec, env, xargs, sudo。`re` は空）。
 *
 * この予測は「捨てられる見込み」を日誌に名前で残すためだけに使う。配る一覧から外したり規則を書き換えたりしない
 * （捨てられるのを回り道で防がない。決めたのはオーナー、#5435）。
 *
 * Why not: `autoMode.classifyAllShell`（真なら完全一致も含め Bash の allow を全部捨てる）と IDE ホスト判定は、
 * デーモンから見えない（SDK の設定・実行環境の中）ので写さない。写しの外で捨てられることがある。
 * ネットワーク系（curl・kubectl など）の枝も写さない: `Aer` が回すリスト `j` に入っていないため、この経路では働かない。
 */

/** 写した版。日誌の文言に出す（SDK を上げたら、この版と下のリストを見直す）。 */
export const AUTO_MODE_STRIP_PREDICTION_SDK_VERSION = '0.3.312';

// `j`（Ter + zsh, fish, eval, exec, env, xargs, sudo）。SDK 0.3.312
const DANGEROUS_COMMAND_WORDS: readonly string[] = [
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'tsx',
  'ruby',
  'perl',
  'php',
  'lua',
  'npx',
  'bunx',
  'npm run',
  'yarn run',
  'pnpm run',
  'bun run',
  'bash',
  'sh',
  'ssh',
  'zsh',
  'fish',
  'eval',
  'exec',
  'env',
  'xargs',
  'sudo',
];

const BASH_RULE = /^Bash\((.*)\)$/s;
const PYTHON_WORD = /^python[\d.]*$/;
// `python -m <package>.<module>` の形。`Aer` はこの形だけ `-` 始まりの除外にする
const PYTHON_MODULE_FLAG = /^-m\s+\w+\.[\w.]+(\s*:|\s+)$/;

/** `Aer` の写し。`content` は規則の括弧の中身。 */
function stripsBashContent(content: string): boolean {
  if (content === '' || /^[\s*]+$/.test(content)) return true; // `EVr`: 中身が無い・空白と `*` だけ
  const o = content.trim().toLowerCase();
  if (o === '*') return true;
  for (const s of DANGEROUS_COMMAND_WORDS) {
    if (o === s || o === `${s}:*` || o === `${s} *` || o === `${s}*`) return true;
    if (o.startsWith(`${s} `) && o.endsWith('*')) {
      const rest = o.slice(s.length + 1);
      if (rest.startsWith('-')) {
        const flags = rest.slice(0, -1);
        if (!(PYTHON_WORD.test(s) && PYTHON_MODULE_FLAG.test(flags))) return true;
      }
    }
  }
  return false;
}

/** `Bash(<中身>)` の規則が、auto mode で SDK に捨てられる見込みなら true。Bash 以外は false（写していない）。 */
export function autoModeStripsDelegatedRule(rule: string): boolean {
  const matched = BASH_RULE.exec(rule);
  if (matched === null) return false;
  return stripsBashContent(matched[1] ?? '');
}
