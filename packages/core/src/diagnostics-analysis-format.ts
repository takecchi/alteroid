// `analyzeDiagnostics` の結果を日本語の表にする。事実を並べるだけで、原因を断定する文は出さない（しきい値は材料が揃ってから人間が決める）。
// 取れない軸は 0 ではなく「取れない」と書く。
import type {
  Coverage,
  DiagnosticsAnalysis,
  TimeZoneResolution,
  TokenStat,
} from './diagnostics-analysis.js';

const n = (value: number | null, digits = 0): string =>
  value === null
    ? '取れない'
    : value.toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
const pct = (value: number | null): string =>
  value === null ? '取れない' : `${(value * 100).toFixed(1)}%`;
const cov = (c: Coverage): string => `取れた ${c.obtained} / 取れない ${c.missing}`;

export function describeTimeZone(tz: TimeZoneResolution): string {
  switch (tz.state) {
    case 'known':
      return `${tz.name}（${tz.source === 'usage' ? '台帳の ledgerDateTimeZone の申告' : '--ledger-tz の引数'}）`;
    case 'unknown':
      return '不明（台帳の申告も --ledger-tz も無い。日誌は UTC のまま）';
    case 'invalid':
      return `不正（${tz.given}: ${tz.reason}）`;
  }
}

function statLine(label: string, s: TokenStat): string {
  return (
    `  ${label}: 行 ${s.rows}` +
    ` / read÷creation ${n(s.readOverCreation.value, 2)}（${cov(s.readOverCreation.rows)}）` +
    ` / 読み出し率 ${pct(s.readRate.value)}（${cov(s.readRate.rows)}）` +
    ` / cache read 合計 ${n(s.sums.cacheRead)} / cache creation 合計 ${n(s.sums.cacheCreation)}`
  );
}

export function renderDiagnosticsAnalysis(a: DiagnosticsAnalysis): string {
  const out: string[] = [];
  const h = a.header;
  out.push('# 診断の集計（事実の並べ。原因は断定しない）');
  out.push(`台帳の date の時間帯: ${describeTimeZone(h.timeZone)}`);
  out.push(
    `日誌の期間（UTC）: ${h.period === null ? '取れない（読める行が無い）' : `${h.period.first} 〜 ${h.period.last}`}`,
  );
  out.push(
    `日誌の行数: ${h.lines}（読めない行 ${h.invalidLines}）。型ごと: ` +
      (Object.keys(h.countsByType).length === 0
        ? 'なし'
        : Object.entries(h.countsByType)
            .sort((x, y) => x[0].localeCompare(y[0]))
            .map(([k, v]) => `${k} ${v}`)
            .join(' / ')),
  );
  out.push(
    `旧版で欄が無い行: turn_timing の tokens 無し ${h.legacy.turnTimingWithoutTokens} / ` +
      `context_usage の大きさの欄が無い ${h.legacy.contextUsageWithoutSizeFields} / ` +
      `turn_usage の cache 欄が取れない ${h.legacy.turnUsageWithoutCacheFields}（いずれも 0 ではなく取れない）`,
  );
  out.push(`context_usage の測定失敗（error）の行: ${h.contextUsageErrorRows}（本文は出さない）`);
  out.push(
    h.ledger.state === 'none'
      ? '台帳: 渡されていない'
      : h.ledger.state === 'unreadable'
        ? `台帳: 読めない（${h.ledger.reason}）`
        : `台帳: 行 ${h.ledger.rows}（読めない行 ${h.ledger.skippedRows}）` +
          (h.ledger.dates === null
            ? ''
            : `、date ${h.ledger.dates.first} 〜 ${h.ledger.dates.last}`),
  );
  for (const notice of a.notices) out.push(`⚠ ${notice}`);

  const r = a.compactionsAndResets;
  out.push('', '## resets（累積の数え直し。二重計上の再発の目印）');
  if (r.ledgerResets.state === 'unavailable') {
    out.push(`  台帳の resets: 取れない（${r.ledgerResets.reason}）`);
  } else {
    out.push(
      `  台帳の resets: 基準 ${r.ledgerResets.baselines} 件、合計 ${r.ledgerResets.total} 回`,
    );
    for (const row of r.ledgerResets.rows) {
      out.push(
        `    ${row.layer}層 ${row.managerId}: ${row.resets}回` +
          (row.lastResetAt === null ? '' : `（最後 ${row.lastResetAt}）`),
      );
    }
  }
  out.push(
    `  日誌の reset を持つ turn_usage 行: ${r.journalReset.resetRows} / ${r.journalReset.turnUsageRows} 行` +
      `、その cache read ${n(r.journalReset.resetCacheRead)}（全 turn_usage の cache read の ${pct(r.journalReset.cacheReadShare)}）`,
  );

  const c = a.cache;
  out.push(
    '',
    '## 1. キャッシュ（read ÷ creation の比・読み出し率 = read ÷（input + read + creation））',
  );
  out.push('  [turn_timing.tokens: ターン単位。層・場所は行に無い]');
  out.push(statLine('全体', c.fromTurnTiming));
  out.push(
    `  [turn_usage.models: 増分。reset を持つ ${c.fromTurnUsage.excludedResetRows} 行は増分ではないので除く]`,
  );
  out.push(statLine('全体', c.fromTurnUsage.overall));
  for (const [k, v] of Object.entries(c.fromTurnUsage.byLayer)) out.push(statLine(`層 ${k}`, v));
  for (const [k, v] of Object.entries(c.fromTurnUsage.bySite)) out.push(statLine(`場所 ${k}`, v));

  const t = a.triggers;
  out.push('', '## 2. 起点別（turn_timing。cache read は tokens のある行だけ）');
  const triggerTable = (title: string, rows: typeof t.byBundle): void => {
    out.push(`  ${title}`);
    if (rows.length === 0) out.push('    （行なし）');
    for (const x of rows) {
      out.push(
        `    ${x.key}: ${x.turns}ターン / cache read 合計 ${n(x.cacheReadSum)} / 1ターン平均 ${n(x.cacheReadPerTurn)}` +
          ` / 全体比 ${pct(x.share)}（${cov(x.tokenRows)}）`,
      );
    }
  };
  triggerTable('起点の束ごと', t.byBundle);
  triggerTable(
    '1起点ごと（束は構成する起点すべてに数える。割合の合計は 100% を超えうる）',
    t.bySingleTrigger,
  );
  if (t.triggersMissingRows > 0) out.push(`  起点が取れない行: ${t.triggersMissingRows}`);
  out.push(
    `  batchSize の分布（${cov(t.batchSize.rows)}）: ` +
      (t.batchSize.distribution.length === 0
        ? '取れない'
        : t.batchSize.distribution.map((d) => `${d.batchSize}→${d.count}`).join(' / ')),
  );
  const iv = t.managerMessageIntervals;
  out.push(
    `  manager_message を起点に含むターンの開始間隔（開始 = at − totalMs。報告・質問・許可の別は行に無い）: ` +
      `ターン ${iv.turns}（開始が取れない ${iv.withoutBoundary}）/ 間隔 ${iv.intervals} 件 / ` +
      `60秒未満 ${pct(iv.under60s.share)}（${iv.under60s.count}）/ 5分未満 ${pct(iv.under5min.share)}（${iv.under5min.count}）/ ` +
      `30分未満 ${pct(iv.under30min.share)}（${iv.under30min.count}）`,
  );

  out.push('', '## 3. 層・場所別のターンあたり（turn_usage の増分）と委譲');
  for (const x of a.perTurn.byLayer) {
    out.push(
      `  層 ${x.key}: ${x.turns}行 / cache read 平均 ${n(x.stat.perTurn.cacheRead)} / output 平均 ${n(x.stat.perTurn.output)}`,
    );
  }
  for (const x of a.perTurn.bySite) {
    out.push(
      `  場所 ${x.key}: ${x.turns}行 / cache read 平均 ${n(x.stat.perTurn.cacheRead)} / output 平均 ${n(x.stat.perTurn.output)}`,
    );
  }
  const tm = a.perTurn.topManagers;
  out.push(`  委譲（managerId）の cache read 上位 ${tm.limit}（全 ${tm.totalManagers} 件）`);
  for (const x of tm.rows) {
    out.push(
      `    ${x.managerId} [${x.layer}]: ${x.turns}行 / cache read ${n(x.cacheRead)}（${cov(x.cacheReadRows)}）`,
    );
  }

  out.push('', '## 4. プロンプトの大きさ（context_usage。日 UTC ごとの中央値 / 最大。トークン）');
  if (a.promptSize.days.length === 0) out.push('  （測れた行なし）');
  for (const d of a.promptSize.days) {
    const f = d.fields;
    const cell = (label: string, x: (typeof f)['totalTokens']): string =>
      `${label} ${n(x.median)}/${n(x.max)}（${cov(x.rows)}）`;
    out.push(
      `  ${d.day} 行${d.rows}: ${cell('system', f.systemPromptTokens)} | ${cell('memory', f.memoryFileTokens)} | ` +
        `${cell('mcp', f.mcpToolTokens)} | ${cell('total', f.totalTokens)}`,
    );
  }
  const ms = a.promptSize.mcpServers;
  out.push(
    `  MCP サーバ別（中央値の大きい上位 ${ms.limit}、全 ${ms.totalServers} 件。mcpToolsByServer が無い行 ${ms.rowsWithoutField}）`,
  );
  for (const s of ms.rows) {
    out.push(
      `    ${s.name}: 中央値 ${n(s.medianTokens)} / 最大 ${n(s.maxTokens)}（観測 ${s.observations}）`,
    );
  }

  const cp = r.compactions;
  out.push('', '## 5. compaction');
  out.push(
    `  turn_usage: ${cp.turnUsageCompactions} 回（行 ${cp.turnUsageRowsWithCompactions}）/ ` +
      `turn_timing.compactions: ${n(cp.turnTimingCompactions.sum)} 回（${cov(cp.turnTimingCompactions.rows)}）`,
  );
  out.push(
    `  sessionId あたり（turn_usage）: session ${cp.perSession.sessions} / compaction のある session ${cp.perSession.sessionsWithCompaction}` +
      ` / 平均 ${n(cp.perSession.mean, 2)} / 最大 ${n(cp.perSession.max)} / sessionId が無い行 ${cp.perSession.rowsWithoutSessionId}`,
  );

  const u = a.unlinkedIncrements;
  out.push('', '## 6. どの turn_timing のターンにも結べない増分');
  out.push(
    `  turn_usage の増分 ${u.increments} 行のうち ${u.unlinked} 行（${pct(u.unlinkedShare)}）。cache read では ${n(u.cacheReadUnlinked)} / ${n(u.cacheReadAll)}（${pct(u.cacheReadShare)}）`,
  );
  out.push(
    `  結ぶ窓 = turn_timing の [at − totalMs, at]（窓 ${u.turnTimingWindows} 件、境界が無い turn_timing ${u.turnTimingWithoutBoundary} 行）。` +
      'turn_timing は主にクローンのターンの行で、層ごとの内訳を併せて見ること',
  );
  for (const [layer, v] of Object.entries(u.byLayer))
    out.push(`    層 ${layer}: ${v.unlinked} / ${v.increments}`);

  out.push('', '## 7. 台帳と日誌の日別');
  const d = a.dailyComparison;
  if (d.state === 'not_joined') out.push(`  ${d.reason}`);
  else {
    out.push(
      `  時間帯 ${d.timeZone} の暦日。日誌の at をこの時間帯の暦日へ変換した。日誌は reset 行を除く turn_usage の増分`,
    );
    for (const row of d.rows) {
      const l = row.ledger;
      const j = row.journal;
      out.push(
        `  ${row.date}: 台帳 cache read ${l === null ? '行なし' : n(l.cacheReadInputTokens)} / ` +
          `日誌 ${j === null ? '期間外（取れない）' : `cache read ${n(j.cacheRead)}（${j.turns}行）`}` +
          ` / 台帳÷日誌 ${n(row.ledgerOverJournalCacheRead, 2)}` +
          (row.journalEdgeDay ? ' / 日誌の期間の端の日（一部の時間のみ）' : ''),
      );
    }
  }

  // 見立ての材料の索引。値の評価（しきい値・良し悪し）は書かない: 材料が揃ってから人間が決める
  out.push(
    '',
    '## 見立て別に見る節（材料の索引。判定はしない）',
    '  キャッシュの効き: 1（読み出し率・read÷creation。turn_timing と turn_usage の2つの出所）',
    '  プロンプトの大きさ: 4（system / memory / mcp / total の日別の中央値と最大、MCP サーバ別）',
    '  同じ合図の配り直し: 2（起点別・batchSize・manager_message のターンの開始間隔）と resets・5（compaction）',
    '  委譲の多さ: 3（層・場所別のターンあたり、managerId 別の cache read）',
    '  台帳だけの膨らみ: resets（台帳と日誌）・7（台帳÷日誌の日別）・6（結べない増分）',
  );
  return out.join('\n');
}
