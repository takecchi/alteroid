import { journalReportDetail } from '@alteroid/logic';
import type { JournalEntry } from '@alteroid/logic';

// 日誌の本文（逐語の JSON）は下の生の表示にそのまま残る。ここは欄ごとに読めるようにするだけ。
// 値は文字として描く（HTML として解釈しない）。どの欄も報告者の主張であることを、ラベルが言う。
export function JournalReportDetail({ entry }: { entry: JournalEntry }) {
  const rows = journalReportDetail(entry);
  if (rows === null) return null;
  return (
    <dl className="space-y-2 text-xs" data-testid="journal-report-detail">
      {rows.map((row) => (
        <div key={row.label}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="whitespace-pre-wrap break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
