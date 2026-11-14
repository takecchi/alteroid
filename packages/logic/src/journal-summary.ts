import { describeAnsweredVia } from '@alteroid/core/answered-via';
import { approvalStateOf } from '@alteroid/core/approval-state';
import { describeGithubCi } from '@alteroid/core/github-ci-format';
import { summarizeJournalDiagnosticsEntry } from '@alteroid/core/journal-diagnostics-format';
import {
  isAlteroidReportSource,
  parseReportProblemJson,
  reportProblemDetailRows,
  summarizeReportProblem,
} from '@alteroid/core/report-problem';

import { redactBody } from './redact.js';
import {
  GITHUB_CI_COUNT_LABEL,
  GITHUB_OPEN_LABEL,
  GITHUB_TRUNCATED_NOTE,
  githubObservedByLabel,
} from './progress-labels.js';
import type { JournalEntry } from './types.js';

type JournalSummaryStyle = 'raw' | 'localized';

// 一行に出す名前の数。超えた分は件数だけにする（一行が際限なく伸びないため。全件は行を開くか journal_read id=<id>）
const ATTACHMENT_NOTE_NAMES = 3;

function attachmentNames(items: readonly { name: string }[]): string {
  const shown = items.slice(0, ATTACHMENT_NOTE_NAMES).map((a) => a.name);
  const rest = items.length - shown.length;
  return shown.join('、') + (rest > 0 ? `、ほか ${rest} 件` : '');
}

/**
 * 添付の注記1つ（`［添付 3件: a.png、b.log、c.txt］`）。先頭3件の名前を出し、超えた分は「ほか n 件」にする。
 * 日誌の1行表示と、承認の画面の引用が同じ規則で出すための1本（片方だけ変えると食い違う）。`items` は1件以上で渡すこと。
 */
export function describeAttachmentList(label: string, items: readonly { name: string }[]): string {
  return `［${label} ${items.length}件: ${attachmentNames(items)}］`;
}

function attachmentNote(
  attachments: readonly { name: string }[] | undefined,
  rejected?: readonly { name: string }[],
): string {
  const kept =
    attachments === undefined || attachments.length === 0
      ? ''
      : describeAttachmentList('添付', attachments);
  const refused =
    rejected === undefined || rejected.length === 0
      ? ''
      : describeAttachmentList('受け取れず', rejected);
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
      // 状態は core の `approvalStateOf`（取り下げが先）
      if (approvalStateOf(entry) === 'withdrawn') return `取り下げ済み: ${entry.question}`;
      if (approvalStateOf(entry) === 'unanswered') return `確認: ${entry.question}`;
      return entry.answeredVia === undefined
        ? `回答済: ${entry.question}`
        : `回答済: ${entry.question}（回答経路: ${describeAnsweredVia(entry.answeredVia)}）`;
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
    case 'external_event': {
      // 日誌の本文（`entry.summary`）は逐語のまま。ここで読める1行にするのは表示だけ。壊れた・想定外の形は既存の表示へ落とす
      const report = isAlteroidReportSource(entry.source)
        ? parseReportProblemJson(entry.summary)
        : null;
      return report === null
        ? `${entry.source}: ${entry.summary}${attachmentNote(entry.attachments)}`
        : `${summarizeReportProblem(report)}${attachmentNote(entry.attachments)}`;
    }
    case 'turn_usage':
    case 'context_usage':
    case 'turn_timing':
    case 'http_timing':
      return summarizeJournalDiagnosticsEntry(entry);
    case 'token_rotation':
      // `text` を組み直さない: 同じ事実を読む面ごとに言い方が分かれるため。`event` は落とさない: `exhausted` と `not_rotated` が一覧で見分けられなくなる。
      return `[${entry.event}] ${entry.text}`;
    case 'conversation_deleted':
      return `会話 ${entry.deletedConversationId} を削除した（${entry.hiddenCount} 件。${entry.deletedBy}）`;
    case 'diagnostics_summary':
      // 本体（最大 16 KiB）は一覧の1行に載せない。全文は日誌の個別の読み（id 指定）か `alteroid diagnostics received show`
      return `${entry.source} から診断の要約を受け取った（全文は alteroid diagnostics received show ${entry.id}）`;
    case 'github_observation':
      return entry.result.status === 'ok'
        ? `${entry.repo}: ${GITHUB_OPEN_LABEL.issue[style]} ${entry.result.openIssues} 件 / ${GITHUB_OPEN_LABEL.pull[style]} ${entry.result.openPulls} 件` +
            (entry.result.truncated ? GITHUB_TRUNCATED_NOTE[style] : '') +
            by(entry.observedBy) +
            ` / ${describeGithubCi(entry.result, style === 'localized' ? GITHUB_CI_COUNT_LABEL : undefined)}`
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

/**
 * 展開した行の詳細。`alteroid-report` の `external_event` を欄ごとの（ラベル, 値）にする。それ以外・壊れた形は null（逐語の JSON だけを出す既存の表示のまま）。
 * 値は要旨と同じ伏せ字を通す。日誌の本文は変えない。
 */
export function journalReportDetail(
  entry: JournalEntry,
): { label: string; value: string }[] | null {
  if (entry.type !== 'external_event' || !isAlteroidReportSource(entry.source)) return null;
  const report = parseReportProblemJson(entry.summary);
  if (report === null) return null;
  return reportProblemDetailRows(report).map((row) => ({
    label: row.label,
    value: redactBody(row.value),
  }));
}

export function summarizeJournalEntry(
  entry: JournalEntry,
  style: JournalSummaryStyle = 'raw',
): string {
  // 知らない種別の `undefined` は伏せ字に渡さずそのまま返す: 呼ぶ側（TUI の `journal-format.ts`）が種別を言うため。
  const raw: string | undefined = summarizeJournalEntryRaw(entry, style);
  return raw === undefined ? (raw as unknown as string) : redactBody(raw);
}
