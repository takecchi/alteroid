import { summarizeJournalDiagnosticsEntry } from '@alteroid/core/journal-diagnostics-format';

import { redactBody } from './redact.js';
import {
  GITHUB_CI_COUNT_LABEL,
  GITHUB_CI_COUNT_ORDER,
  GITHUB_OPEN_LABEL,
  GITHUB_TRUNCATED_NOTE,
  githubObservedByLabel,
} from './progress-labels.js';
import type { JournalEntry } from './types.js';

export type JournalSummaryStyle = 'raw' | 'localized';

// core の `describeGithubCi` を import せず写す: 本体の値 import はサーバ専用の層をブラウザバンドルへ入れるため。
export function describeGithubCiText(
  ok: {
    ci?: {
      pulls: number;
      success: number;
      failure: number;
      pending: number;
      checks: string;
      truncated?: boolean;
    };
    ciUnavailable?: string;
  },
  style: JournalSummaryStyle = 'raw',
): string {
  if (ok.ci !== undefined) {
    const ci = ok.ci;
    const counted = ci.success + ci.failure + ci.pending;
    const axes =
      style === 'localized'
        ? GITHUB_CI_COUNT_ORDER.map((k) => `${GITHUB_CI_COUNT_LABEL[k]} ${String(ci[k])}`).join(
            ' / ',
          )
        : `success ${String(ci.success)} / failure ${String(ci.failure)} / pending ${String(ci.pending)}`;
    return (
      `CI: ${String(ci.pulls)} 件の PR を確認 — ${axes}` +
      (counted < ci.pulls ? `（チェックが無い等で未集計 ${String(ci.pulls - counted)} 件）` : '') +
      `（数えたもの: ${ci.checks}）` +
      (ci.truncated === true ? '（打ち切り。数は下限）' : '')
    );
  }
  if (ok.ciUnavailable !== undefined)
    return `CI: 取れなかった — ${ok.ciUnavailable}（0 件ではない）`;
  return 'CI: 観測していない（0 件ではない）';
}

function attachmentNote(
  attachments: readonly { name: string }[] | undefined,
  rejected?: readonly { name: string }[],
): string {
  const kept =
    attachments === undefined || attachments.length === 0
      ? ''
      : `［添付 ${attachments.length}件: ${attachments.map((a) => a.name).join('、')}］`;
  const refused =
    rejected === undefined || rejected.length === 0
      ? ''
      : `［受け取れず ${rejected.length}件: ${rejected.map((a) => a.name).join('、')}］`;
  return kept + refused;
}

function summarizeJournalEntryRaw(entry: JournalEntry, style: JournalSummaryStyle): string {
  const by = (observedBy: string) =>
    style === 'localized'
      ? `（記録したのは: ${githubObservedByLabel(observedBy)}）`
      : `（観測者 ${observedBy}）`;
  switch (entry.type) {
    case 'exchange':
      return `${entry.with} ${entry.role === 'inbound' ? '←' : '→'} ${entry.text}${attachmentNote(entry.attachments, entry.rejectedAttachments)}`;
    case 'decision':
      return `${entry.decision}（根拠: ${entry.grounds}）`;
    case 'escalation':
      // 取り下げを先に見る: `answeredAt` 未設定の取り下げ行が「確認:」（新しい質問）と読まれるため。
      if (entry.withdrawnAt !== undefined) return `取り下げ済み: ${entry.question}`;
      return entry.answeredAt === undefined
        ? `確認: ${entry.question}`
        : `回答済: ${entry.question}`;
    case 'tool_use':
      return `${entry.actor} が ${entry.tool}`;
    case 'memory_update': {
      // バイト数が無いときは 0 にも省略にもせず「不明」と言う: 「変化なし」に読めるため。
      // バイトの注記は `:` の手前に置く: `summary` に埋まった文字数と単位が混ざらないため。
      const action = entry.action === undefined ? '' : `/${entry.action}`;
      const bytes =
        entry.bytesBefore === undefined || entry.bytesAfter === undefined
          ? '前後バイト数不明（旧形式）'
          : `${entry.bytesBefore}→${entry.bytesAfter} バイト`;
      return `記憶 ${entry.slug} を更新（${entry.cause}${action} / ${bytes}）: ${entry.summary}`;
    }
    case 'daily_report':
      // 印の付いた行を「日報」と呼ばない: 書けなかった日が書けた日と同じ顔で並ぶため。
      return entry.unavailable === undefined
        ? `${entry.date} の日報`
        : `⚠ ${entry.date} の日報は作れなかった: ${entry.unavailable}`;
    case 'external_event':
      return `${entry.source}: ${entry.summary}${attachmentNote(entry.attachments)}`;
    case 'worker_wait':
    case 'turn_usage':
    case 'context_usage':
    case 'inbox_flow':
      return summarizeJournalDiagnosticsEntry(entry);
    case 'token_rotation':
      // `text` を組み直さない: 同じ事実を読む面ごとに言い方が分かれるため。`event` は落とさない: `exhausted` と `not_rotated` が一覧で見分けられなくなる。
      return `[${entry.event}] ${entry.text}`;
    case 'github_observation':
      return entry.result.status === 'ok'
        ? `${entry.repo}: ${GITHUB_OPEN_LABEL.issue[style]} ${entry.result.openIssues} 件 / ${GITHUB_OPEN_LABEL.pull[style]} ${entry.result.openPulls} 件` +
            (entry.result.truncated ? GITHUB_TRUNCATED_NOTE[style] : '') +
            by(entry.observedBy) +
            ` / ${describeGithubCiText(entry.result, style)}`
        : `${entry.repo}: 取れなかった${by(entry.observedBy)}: ${entry.result.reason}`;
    case 'subagent_stall': {
      // `text` をそのまま出さない: 複数行で、この種別だけ一覧の1行が極端に長くなるため。
      const agentType = entry.agentType === undefined ? '' : `/${entry.agentType}`;
      const outcome =
        entry.outcome === 'woken'
          ? `起こし直した（${entry.wakeupCount}回目）`
          : `上限に達し、起こし直さなかった（要対応。既に${entry.wakeupCount}回起こし直し済み）`;
      return (
        `作業者 ${entry.agentId}${agentType} が自分で起こした背景処理を ` +
        `${entry.ownedTaskCount}件 残したまま畳もうとした（セッション全体 ${entry.sessionTaskCount}件）: ` +
        outcome
      );
    }
  }
}

export function summarizeJournalEntry(
  entry: JournalEntry,
  style: JournalSummaryStyle = 'raw',
): string {
  // 知らない種別の `undefined` は伏せ字に渡さずそのまま返す: 呼ぶ側（TUI の `journal-format.ts`）が種別を言うため。
  const raw: string | undefined = summarizeJournalEntryRaw(entry, style);
  return raw === undefined ? (raw as unknown as string) : redactBody(raw);
}
