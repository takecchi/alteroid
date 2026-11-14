// 受け取った診断の要約（日誌の `diagnostics_summary` の `payload`）を、一覧の1行と比較の表にする。
// 事実を並べるだけで、原因は断定しない。取れない（null）は「取れない」と書き、0 にしない。
// 一覧（`journal_read`・CLI の `received list`）には全文を載せない: 1件が最大 16 KiB で、載せると予算を溢れさせるため。
import { diagnosticsSummarySchema, type DiagnosticsSummary } from './diagnostics-summary.js';

const n = (value: number | null, digits = 0): string =>
  value === null
    ? '取れない'
    : value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const pct = (value: number | null): string =>
  value === null ? '取れない' : `${(value * 100).toFixed(1)}%`;

/** 日誌の行の本体を要約として読む。読めなければ null（版のずれ・壊れた行を例外にしない） */
export function readStoredDiagnosticsSummary(payload: unknown): DiagnosticsSummary | null {
  const parsed = diagnosticsSummarySchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function describeSummaryPeriod(summary: DiagnosticsSummary): string {
  return summary.period === null ? '期間なし' : `${summary.period.start}〜${summary.period.end}`;
}

/** 要点の数字だけの1行（改行を含まない）。全文は載せない */
export function describeDiagnosticsSummaryDigest(payload: unknown): string {
  const summary = readStoredDiagnosticsSummary(payload);
  if (summary === null) {
    return '要約の形を読めない（この版の型に合わない。全文は journal_read id=<id>）';
  }
  const overall = summary.cache.fromTurnUsage.overall;
  return (
    `period=${describeSummaryPeriod(summary)} 日誌 ${summary.rows.lines} 行` +
    ` / 読み出し率 ${pct(overall.readRate.value)}` +
    ` / read÷creation ${n(overall.readOverCreation.value, 2)}` +
    ` / compaction ${summary.compactions.turnUsageCompactions}` +
    ` / resets ${summary.resets.journal.resetRows}`
  );
}

export interface ReceivedSummaryRef {
  id: string;
  at: string;
  source: string;
  summary: DiagnosticsSummary;
}

type MetricUnit = 'ratio' | 'count' | 'decimal2';

export interface SummaryMetric {
  label: string;
  unit: MetricUnit;
  a: number | null;
  b: number | null;
  /** どちらかが取れなければ null（0 にしない） */
  diff: number | null;
}

export interface SummaryComparison {
  source: string;
  a: { id: string; at: string; period: DiagnosticsSummary['period'] };
  b: { id: string; at: string; period: DiagnosticsSummary['period'] };
  metrics: SummaryMetric[];
}

/** 同じ source の2件だけを比べる。違えば例外（別の環境どうしの数字を並べて読み違えないため） */
export function compareDiagnosticsSummaries(
  a: ReceivedSummaryRef,
  b: ReceivedSummaryRef,
): SummaryComparison {
  if (a.source !== b.source) {
    throw new Error(
      `source が違う2件は比べられない（${a.id} と ${b.id}）。同じ source の2件を渡す`,
    );
  }
  const metrics: SummaryMetric[] = [];
  const add = (label: string, unit: MetricUnit, x: number | null, y: number | null) => {
    metrics.push({ label, unit, a: x, b: y, diff: x === null || y === null ? null : y - x });
  };
  const oa = a.summary.cache.fromTurnUsage.overall;
  const ob = b.summary.cache.fromTurnUsage.overall;
  add('キャッシュの読み出し率', 'ratio', oa.readRate.value, ob.readRate.value);
  add('read÷creation', 'decimal2', oa.readOverCreation.value, ob.readOverCreation.value);
  const ta = a.summary.triggers.byKind;
  const tb = b.summary.triggers.byKind;
  const kinds = [...new Set([...ta.map((k) => k.kind), ...tb.map((k) => k.kind)])].sort();
  for (const kind of kinds) {
    // 片方に無い起点は 0 ではなく「取れない」: 要約に載っていないのは、起こらなかったのか載せなかったのか分からないため
    add(
      `起点 ${kind} の割合（cache read の share）`,
      'ratio',
      ta.find((k) => k.kind === kind)?.share ?? null,
      tb.find((k) => k.kind === kind)?.share ?? null,
    );
  }
  const latestMedian = (s: DiagnosticsSummary): number | null =>
    s.promptSize.days.at(-1)?.totalTokens.median ?? null;
  add(
    'プロンプトの大きさ（最新の日の中央値・トークン）',
    'count',
    latestMedian(a.summary),
    latestMedian(b.summary),
  );
  add(
    'compaction（turn_usage の回数）',
    'count',
    a.summary.compactions.turnUsageCompactions,
    b.summary.compactions.turnUsageCompactions,
  );
  add(
    'resets（日誌の数え直しの行）',
    'count',
    a.summary.resets.journal.resetRows,
    b.summary.resets.journal.resetRows,
  );
  const ledgerTotal = (s: DiagnosticsSummary): number | null =>
    s.resets.ledger.state === 'known' ? s.resets.ledger.total : null;
  add('resets（台帳の数え直しの合計）', 'count', ledgerTotal(a.summary), ledgerTotal(b.summary));
  return {
    source: a.source,
    a: { id: a.id, at: a.at, period: a.summary.period },
    b: { id: b.id, at: b.at, period: b.summary.period },
    metrics,
  };
}

const formatOf = (unit: MetricUnit, value: number | null): string =>
  unit === 'ratio' ? pct(value) : unit === 'decimal2' ? n(value, 2) : n(value);

export function renderSummaryComparison(comparison: SummaryComparison): string {
  const period = (p: DiagnosticsSummary['period']): string =>
    p === null ? '期間なし' : `${p.start}〜${p.end}`;
  const out = [
    `# 診断の要約の比較（source: ${comparison.source}。事実の並べで、原因は断定しない）`,
    `A: ${comparison.a.id}（受信 ${comparison.a.at}、${period(comparison.a.period)}）`,
    `B: ${comparison.b.id}（受信 ${comparison.b.at}、${period(comparison.b.period)}）`,
    '項目: A → B（B−A）。どちらかが取れないときは差を出さない（0 とは書かない）',
  ];
  for (const metric of comparison.metrics) {
    const diff =
      metric.diff === null
        ? '差は取れない'
        : `${metric.diff >= 0 ? '+' : ''}${formatOf(metric.unit, metric.diff)}${metric.unit === 'ratio' ? '（割合の差）' : ''}`;
    out.push(
      `- ${metric.label}: ${formatOf(metric.unit, metric.a)} → ${formatOf(metric.unit, metric.b)}（${diff}）`,
    );
  }
  return out.join('\n');
}
