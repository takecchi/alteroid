import { stripDataHeredocsForWaitForms } from './bash-wait-guard.js';

/**
 * 本番デプロイ（`release-prod` workflow）を起動する Bash の形を見分ける（issue #2884）。
 * 純関数。文字列だけを見る。
 *
 * ## 経緯
 * 以前は `docker/gh`（`gh` のシム）が、マネージャー・作業者の uid（`ALTEROID_RUNNER_CHILD_UID`）の
 * 呼び出しに限り、この形を exit 1 で止めていた（#865）。止めるだけで確認に上がらないので、
 * クローンが許可しても通らず、誰も開けられなかった。マネージャーは Claude Code で、クローンは
 * それを使う人間である（オーナーの回答 2026-10-05）。Claude Code は取り返しのつきにくい操作を
 * 人間に聞く。同じ形にするため、シムの門を外し、`runner.ts` の `#onPreToolUse` がこの判定器の
 * 結果を**確認（ask）**として返す。`ALTEROID_BASH_GUARD=deny` のときだけ止める。
 *
 * **`ALTEROID_BASH_GUARD=off` でも確認に残す。** `off` は「待つ形の門を掛けない」設定であって、
 * 本番デプロイを黙って通す設定ではない。取り返しがつきにくく、聞いて困る頻度でもない。
 *
 * ## 見分ける形
 * - `gh workflow run <…release-prod…>`（`--ref` / `-R` / `-f` の位置は問わない。パス形も）
 * - `gh api … /actions/workflows/…release-prod…/dispatches`（`-X POST` / `--method` / 引数順は問わない）
 *
 * `bash -c "…"` の中は、引用符を外した語として読むので拾える。`gh` は語として（パス付き・引用符付きも）見る。
 *
 * ## ⚠️ これは守りではなく見分けである（迂回できる）
 * 文字列しか見ないので、次は拾えない。旧シムは `gh` を通る限りこれらも止めていたので、捕まえる範囲は
 * 狭くなった（#2884 の決定。「Claude Code が人間に聞く」形を優先した）。
 * - スクリプトファイルの中、変数で組んだ `gh`（`$GH workflow run …`）、`eval` で組んだ文字列
 * - workflow を数値 ID で指定する形
 * - `curl` で REST を直接叩く、`git push origin main:release/prod`、`gh run rerun <過去の run-id>`
 *
 * 硬い境界は `release/prod` の ruleset（誰が push・起動できるか）側に置く判断で、未設定である（別 Issue）。
 */

export type ReleaseProdVerdict =
  { matched: false } | { matched: true; form: 'gh-release-prod'; reason: string };

const REASON =
  '本番デプロイ（release-prod）を起動する形である（`gh workflow run … release-prod…` / ' +
  '`gh api …/workflows/…release-prod…/dispatches`）。**取り返しがつきにくい**ので、クローンの確認が要る。' +
  '起動してよいか、いつ起動するか（夜の自動反映に任せてよいか）を確かめてから許可すること。';

const SEGMENT_SPLIT_RE = /[;&|\n\r()`]+/;

function unquote(token: string): string {
  return token.replace(/^[\\"']+/, '').replace(/[\\"']+$/, '');
}

function isGhWord(token: string): boolean {
  return /(?:^|\/)gh$/.test(unquote(token));
}

function segmentMatches(tokens: readonly string[]): boolean {
  const args = tokens.map((t) => unquote(t).toLowerCase());
  const ghIndex = tokens.findIndex(isGhWord);
  if (ghIndex < 0) return false;
  const rest = args.slice(ghIndex + 1);
  const mentionsReleaseProd = rest.some(
    (a) => a.includes('release-prod') || a.includes('release/prod'),
  );
  if (!mentionsReleaseProd) return false;

  // 1. gh workflow run …（`workflow` の直後が `run`）
  const wf = rest.indexOf('workflow');
  if (wf >= 0 && rest[wf + 1] === 'run') return true;

  // 2. gh api … /actions/workflows/…/dispatches
  const first = rest.find((a) => !a.startsWith('-'));
  if (first === 'api') {
    const joined = rest.join(' ');
    return joined.includes('/actions/workflows/') && joined.includes('/dispatches');
  }
  return false;
}

export function inspectReleaseProdDispatch(command: string): ReleaseProdVerdict {
  if (command.trim().length === 0) return { matched: false };
  const view = stripDataHeredocsForWaitForms(command);
  for (const segment of view.split(SEGMENT_SPLIT_RE)) {
    const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
    if (segmentMatches(tokens)) return { matched: true, form: 'gh-release-prod', reason: REASON };
  }
  return { matched: false };
}
