import { stripDataHeredocsForWaitForms } from './bash-wait-guard.js';

// 見分けるだけで守りではない: 文字列しか見ないので、スクリプトファイルの中・変数で組んだ `gh`・`eval`・数値 ID 指定・`curl` は拾えない
// `ALTEROID_BASH_GUARD=off` でも確認に残す: 取り返しがつきにくい操作を黙って通す設定にしないため

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

  const wf = rest.indexOf('workflow');
  if (wf >= 0 && rest[wf + 1] === 'run') return true;

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
