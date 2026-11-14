// 別の alteroid から届いた診断の要約を検査して日誌（`diagnostics_summary`）へ積む。
// 受信箱・外部イベントへは積まない: 積むとクローンのターンが起き、消費を調べる仕組みが消費を増やすため。
// 断るときは何も積まず、メッセージに入力の値を載せない（欄名と理由の種類だけ）。
import {
  diagnosticsSummarySchema,
  findSecretPatterns,
  type DiagnosticsSummary,
  type JournalStore,
} from '@alteroid/core';
import type { Principal } from './auth.js';

export type IntakeResult =
  | { kind: 'accepted'; id: string; duplicate: boolean }
  | { kind: 'rejected'; message: string }
  | { kind: 'not-persisted'; message: string };

export const DIAGNOSTICS_NOT_PERSISTED_MESSAGE =
  '日誌へ書けなかった（または既に届いているかを確かめられなかった）ので、診断の要約を受け付けていない（何も積んでいない）。送り直してよい。';

const MAX_ISSUES_SHOWN = 8;
// 重複の探索を、期間の始まりのこれより前までは遡らない: 受け取った時刻は送り手の生成時刻（期間の終わり以降）より前にならず、送り手の時計のずれを見込んでも1日で足りる
const DUPLICATE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DUPLICATE_SCAN_PAGE = 50;

/** 入力の値を含めずに、どの欄がなぜ通らなかったかだけを言う */
function describeIssues(error: {
  issues: ReadonlyArray<{ code: string; path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  const shown = error.issues.slice(0, MAX_ISSUES_SHOWN).map((issue) => {
    const path = issue.path.length === 0 ? '(全体)' : issue.path.map(String).join('.');
    // `unrecognized_keys` の欄名は送り手が決める文字列なので出さない（親の欄までを言う）。`custom` の文言は定数（サイズの上限）
    const reason = issue.code === 'custom' ? issue.message : issue.code;
    return `${path}: ${reason}`;
  });
  const rest = error.issues.length - shown.length;
  return shown.join(' / ') + (rest > 0 ? ` / ほか ${rest} 件` : '');
}

export function checkDiagnosticsSummary(
  summary: unknown,
  env: NodeJS.ProcessEnv | undefined,
): { ok: true; value: DiagnosticsSummary } | { ok: false; message: string } {
  const parsed = diagnosticsSummarySchema.safeParse(summary);
  if (!parsed.success) {
    return {
      ok: false,
      message: `診断の要約の形が合わないので受け付けていない（何も積んでいない）: ${describeIssues(parsed.error)}`,
    };
  }
  // 送り手の版が古い・悪意でも、秘密らしいものが入った要約は積まない（伏せて続行しない）。当たった規則の名前だけを言う
  const hits = findSecretPatterns(JSON.stringify(parsed.data), env);
  if (hits.length > 0) {
    return {
      ok: false,
      message: `診断の要約に秘密らしい文字列が見つかったので受け付けていない（何も積んでいない。規則: ${hits.join(', ')}）。`,
    };
  }
  return { ok: true, value: parsed.data };
}

async function findDuplicate(
  journal: JournalStore,
  source: string,
  period: { start: string; end: string },
): Promise<string | null> {
  const since = new Date(Date.parse(period.start) - DUPLICATE_LOOKBACK_MS).toISOString();
  let after: { id: string; at: string } | undefined;
  for (;;) {
    const page = await journal.listPage({
      types: ['diagnostics_summary'],
      since,
      limit: DUPLICATE_SCAN_PAGE,
      ...(after === undefined ? {} : { after }),
    });
    for (const entry of page.entries) {
      if (entry.type !== 'diagnostics_summary' || entry.source !== source) continue;
      const stored = entry.payload['period'];
      if (
        typeof stored === 'object' &&
        stored !== null &&
        (stored as Record<string, unknown>)['start'] === period.start &&
        (stored as Record<string, unknown>)['end'] === period.end
      ) {
        return entry.id;
      }
    }
    if (page.next === null) return null;
    after = page.next;
  }
}

/**
 * 同じ（source, period.start, period.end）は先着の1件だけ積む。呼び手が同じ鍵の錠の中で呼ぶこと（同時の2本が両方「無い」を見て両方積むのを防ぐ）。
 * 先着にする理由: 同じ期間の再送は同じ集計の送り直しであり、2件目で上書きすると、受け取った後に読んだ側が見た数字が動くため。
 */
export async function acceptDiagnosticsSummary(spec: {
  journal: JournalStore;
  principal: Principal;
  source: string;
  summary: DiagnosticsSummary;
}): Promise<IntakeResult> {
  const { journal, principal, source, summary } = spec;
  // `period` が null（診断の行が1行も無い）の要約は送る意味が無く、冪等の鍵も作れないので断る
  if (summary.period === null) {
    return {
      kind: 'rejected',
      message:
        '診断の要約の period が null（診断の行が1行も無い）ので受け付けていない（何も積んでいない）。日誌に診断の行が溜まってから送る。',
    };
  }
  try {
    const duplicateId = await findDuplicate(journal, source, summary.period);
    if (duplicateId !== null) return { kind: 'accepted', id: duplicateId, duplicate: true };
    const entry = await journal.append({
      type: 'diagnostics_summary',
      source,
      principalKind: principal.kind,
      ...(principal.kind === 'integration' ? { keyId: principal.keyId } : {}),
      payload: summary,
    });
    return { kind: 'accepted', id: entry.id, duplicate: false };
  } catch {
    // 例外の文面（値を抱えうる）は返さない
    return { kind: 'not-persisted', message: DIAGNOSTICS_NOT_PERSISTED_MESSAGE };
  }
}
