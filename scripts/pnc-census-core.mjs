// 日誌（GET /journal の書き出し）から、クローンの 1 ターンの「要求の本数 N・平均の文脈 C・要約直後の床 P」を起点別に集計する（読むだけ）。#5469 P8 前段。
// 純関数だけを置く。ファイルを読む口は `pnc-census.mjs`。ネットワークへは出ない。本文（発言・報告・道具の引数や結果）は読まず、数と道具の名前だけを出す。入力の `external_event` は `summary` に外部の本文を含むが、読むのは `source` と `at` だけ。
//
// 使う欄（`packages/core/src/schema.ts` の journalEntrySchema）:
//   turn_timing: at / succeeded / triggers / kinds / sdk.numTurns / tools{count,totalMs,top[]} / tokens{input,cacheRead,cacheCreation,output} / contextTokens
//   turn_usage : at / layer / site / compactions[]{trigger,preTokens,postTokens?} / contextUsage?
//   context_usage: at / layer / site / contextUsage{totalTokens,autoCompactThreshold,messageBreakdown{...,toolsByName[]}}
//   external_event: at / source（枠の知らせの判別にだけ使う）
// 欄が無い版・行は数えずに「取れなかった件数」を出す（0 に丸めない）。

/** #5469 P8 前段（result-hist.md）で置いた仮定。実測と並べて、当たったかを見る。 */
export const ASSUMPTIONS = {
  /** 要約直後の文脈 P（tokens）。固定 約 66K + 要約本文と再注入 約 20K。 */
  floorTokens: 86_000,
  /** 要約の閾値 T = 窓 300K − 余白 33K。 */
  thresholdTokens: 267_000,
  /** 平均の文脈 C = (P + T) / 2。 */
  meanContextTokens: 176_500,
  /** 起点別の N（C=17.6万 と置いた逆算）。 */
  requestsPerTurn: {
    human: 4.6,
    report: 4.0,
    timer: 3.7,
    initiative: 7.8,
    external: 2.2,
    quota: 2.4,
  },
};

/** 仮定と実測の差を「概ね一致」と見る幅。 */
export const AGREEMENT_TOLERANCE = 0.25;

/** 枠の知らせ（デーモンの runner 登録簿が出す外部の合図）の source。復旧の知らせも同じ source で出るので、枠の知らせの推定は多めに出うる。`daemon-self-notice.ts` の DAEMON_RUNNER_REGISTRY_SOURCE と同じ値。 */
export const QUOTA_SOURCE = 'runner-registry';

/** 行を turn_timing へ結ぶ最大の時間差（ms）。同じターンの終わりの記帳は数 ms〜数秒の差に収まる。 */
export const MATCH_WINDOW_MS = 30_000;

export const CLASS_ORDER = ['human', 'report', 'timer', 'initiative', 'external', 'quota', 'other'];

export const CLASS_LABELS = {
  human: '人間',
  report: '報告',
  timer: '定期 tick',
  initiative: '発意 tick',
  external: '外部',
  quota: '枠の知らせ',
  other: 'その他',
};

/** 読む型は 4 つ。`external_event` は `summary` に外部の本文を含むが、`source` と `at` しか読まない。 */
const NEEDED_TYPES = new Set(['turn_timing', 'turn_usage', 'context_usage', 'external_event']);

// ---------------------------------------------------------------------------------------------
// 読み込み

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 1 つの JSON 値から日誌の行を取り出す。`GET /journal` の封筒 `{entries}`・行の配列・封筒の配列・1 行そのもの、を受ける。 */
function entriesFrom(value) {
  if (Array.isArray(value)) return value.flatMap(entriesFrom);
  if (isObject(value) && Array.isArray(value.entries)) return value.entries.flatMap(entriesFrom);
  if (isObject(value) && typeof value.type === 'string') return [value];
  return [];
}

/**
 * 1 ファイルぶんの文字列を読む。全体が 1 つの JSON（封筒・配列）ならそれ、そうでなければ 1 行 1 JSON（JSONL。各行が行そのものでも封筒でもよい）。
 * 戻り: { entries, badLines（JSON として読めなかった行の数）, notEntries（JSON だが日誌の行でも封筒でもなかった数） }
 */
export function parseJournalText(text) {
  const trimmed = text.trim();
  if (trimmed === '') return { entries: [], badLines: 0, notEntries: 0 };
  try {
    const whole = JSON.parse(trimmed);
    const entries = entriesFrom(whole);
    return { entries, badLines: 0, notEntries: entries.length === 0 ? 1 : 0 };
  } catch {
    // JSONL として読む
  }
  const entries = [];
  let badLines = 0;
  let notEntries = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      badLines += 1;
      continue;
    }
    const found = entriesFrom(value);
    if (found.length === 0) notEntries += 1;
    entries.push(...found);
  }
  return { entries, badLines, notEntries };
}

// ---------------------------------------------------------------------------------------------
// 統計

const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** 中央値（偶数個は中の 2 つの平均）・p90（最近順位法）・平均。空なら null（0 に丸めない）。 */
export function stat(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const p90 = sorted[Math.ceil(0.9 * n) - 1];
  const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
  return { n, median, p90, mean };
}

const timeOf = (entry) => {
  const t = typeof entry.at === 'string' ? Date.parse(entry.at) : Number.NaN;
  return Number.isFinite(t) ? t : null;
};

// ---------------------------------------------------------------------------------------------
// 起点の分類

/** 束の中の起点の優先順位（人間 > 報告系 > 外部 > 定期 > 発意）で 1 つへ寄せる。 */
export function classifyTurn(timing, hasQuotaEvent) {
  const triggers = Array.isArray(timing.triggers)
    ? timing.triggers.filter((t) => typeof t === 'string')
    : [];
  const kinds = Array.isArray(timing.kinds) ? timing.kinds : [];
  if (triggers.includes('human_message') || triggers.includes('human_answer')) return 'human';
  if (triggers.includes('manager_message')) return 'report';
  if (triggers.includes('external')) return hasQuotaEvent ? 'quota' : 'external';
  if (triggers.includes('timer')) return 'timer';
  if (triggers.includes('self_initiative')) return 'initiative';
  if (kinds.length > 0 && kinds.every((kind) => kind === 'distill')) return 'other';
  return 'other';
}

// ---------------------------------------------------------------------------------------------
// 集計

/** 時刻の昇順の配列から、時刻が最も近い行の添字（`MATCH_WINDOW_MS` 以内）。無ければ -1。 */
function nearestIndex(times, at) {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let bestGap = Infinity;
  for (const i of [lo - 1, lo, lo + 1]) {
    if (i < 0 || i >= times.length) continue;
    const gap = Math.abs(times[i] - at);
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return bestGap <= MATCH_WINDOW_MS ? best : -1;
}

const isCloneSession = (entry) => entry.layer === 'clone' && entry.site === 'session';

/**
 * @param {unknown[]} rawEntries 日誌の行（重複は id で落とす）
 * @param {{ badLines?: number, notEntries?: number }} [reading]
 */
export function analyze(rawEntries, reading = {}) {
  const seen = new Set();
  const entries = [];
  let duplicates = 0;
  let ignoredTypes = 0;
  for (const entry of rawEntries) {
    if (!isObject(entry) || typeof entry.type !== 'string') continue;
    if (!NEEDED_TYPES.has(entry.type)) {
      ignoredTypes += 1;
      continue;
    }
    if (typeof entry.id === 'string') {
      if (seen.has(entry.id)) {
        duplicates += 1;
        continue;
      }
      seen.add(entry.id);
    }
    entries.push(entry);
  }

  const timings = entries
    .filter((entry) => entry.type === 'turn_timing')
    .map((entry) => ({ entry, at: timeOf(entry) }))
    .filter((row) => row.at !== null)
    .sort((a, b) => a.at - b.at);
  const timingTimes = timings.map((row) => row.at);

  // 時刻を持たない turn_timing は集計に入れない（結べない）。数だけ残す
  const timingWithoutTime =
    entries.filter((entry) => entry.type === 'turn_timing').length - timings.length;

  const quotaTimes = entries
    .filter((entry) => entry.type === 'external_event' && entry.source === QUOTA_SOURCE)
    .map(timeOf)
    .filter((t) => t !== null);

  const turns = timings.map((row) => {
    const timing = row.entry;
    const endAt = row.at;
    const totalMs = finite(timing.totalMs) ? timing.totalMs : 0;
    // 枠の知らせ: 外部だけの束で、ターンの開始の少し前〜終わりの間に runner 登録簿の外部の合図が在る（文面でなく source で見る。束ねの待ちを 10 分見込む）
    const hasQuotaEvent = quotaTimes.some(
      (t) => t >= endAt - totalMs - 600_000 && t <= endAt + MATCH_WINDOW_MS,
    );
    const kind = classifyTurn(timing, hasQuotaEvent);
    const tokens = isObject(timing.tokens) ? timing.tokens : null;
    const cacheRead = tokens !== null && finite(tokens.cacheRead) ? tokens.cacheRead : null;
    const input = tokens !== null && finite(tokens.input) ? tokens.input : null;
    const cacheCreation =
      tokens !== null && finite(tokens.cacheCreation) ? tokens.cacheCreation : null;
    const numTurns =
      isObject(timing.sdk) && finite(timing.sdk.numTurns) && timing.sdk.numTurns > 0
        ? timing.sdk.numTurns
        : null;
    return {
      kind,
      succeeded: timing.succeeded === true,
      at: endAt,
      numTurns,
      cacheRead,
      totalInput:
        cacheRead !== null && input !== null && cacheCreation !== null
          ? input + cacheRead + cacheCreation
          : null,
      contextTokens: finite(timing.contextTokens) ? timing.contextTokens : null,
      toolCount: isObject(timing.tools) && finite(timing.tools.count) ? timing.tools.count : null,
      toolTop: isObject(timing.tools) && Array.isArray(timing.tools.top) ? timing.tools.top : [],
      compactions: [],
      contextUsage: null,
    };
  });

  // turn_usage（要約の前後）と context_usage（床・閾値・履歴の内訳）を、時刻の最も近い turn_timing へ結ぶ
  let usageRows = 0;
  let usageUnmatched = 0;
  let contextRows = 0;
  let contextUnmatched = 0;
  let otherLayerRows = 0;
  for (const entry of entries) {
    if (entry.type !== 'turn_usage' && entry.type !== 'context_usage') continue;
    if (!isCloneSession(entry)) {
      otherLayerRows += 1;
      continue;
    }
    const at = timeOf(entry);
    const index = at === null ? -1 : nearestIndex(timingTimes, at);
    if (entry.type === 'turn_usage') {
      if (!Array.isArray(entry.compactions) || entry.compactions.length === 0) continue;
      usageRows += 1;
      if (index < 0) usageUnmatched += 1;
      else turns[index].compactions.push(...entry.compactions.filter(isObject));
    } else {
      contextRows += 1;
      if (index < 0 || !isObject(entry.contextUsage)) {
        if (index < 0) contextUnmatched += 1;
        continue;
      }
      turns[index].contextUsage = entry.contextUsage;
    }
  }

  const byClass = {};
  for (const key of CLASS_ORDER) byClass[key] = [];
  for (const turn of turns) byClass[turn.kind].push(turn);

  const classes = {};
  for (const key of CLASS_ORDER) {
    const all = byClass[key];
    const ok = all.filter((turn) => turn.succeeded);
    const withN = ok.filter((turn) => turn.numTurns !== null);
    const withC = ok.filter((turn) => turn.numTurns !== null && turn.cacheRead !== null);
    const withCtx = ok.filter((turn) => turn.contextTokens !== null);
    const withR = ok.filter(
      (turn) =>
        turn.numTurns !== null &&
        turn.cacheRead !== null &&
        turn.contextTokens !== null &&
        turn.contextTokens > 0,
    );
    const withR2 = withR.filter((turn) => turn.totalInput !== null);
    const withTools = ok.filter((turn) => turn.toolCount !== null);
    const posts = ok.flatMap((turn) => turn.compactions.map((c) => c.postTokens).filter(finite));
    const pres = ok.flatMap((turn) => turn.compactions.map((c) => c.preTokens).filter(finite));
    const assumedN = ASSUMPTIONS.requestsPerTurn[key] ?? null;
    const nStat = stat(withN.map((turn) => turn.numTurns));
    const cStat = stat(withC.map((turn) => turn.cacheRead / turn.numTurns));
    classes[key] = {
      label: CLASS_LABELS[key],
      turns: all.length,
      failed: all.length - ok.length,
      n: nStat,
      nMissing: ok.length - withN.length,
      c: cStat,
      cMissing: ok.length - withC.length,
      contextTokens: stat(withCtx.map((turn) => turn.contextTokens)),
      contextMissing: ok.length - withCtx.length,
      // 残差: 式 cacheRead ≒ N × 文脈 が成り立つか。文脈はターンの終わりの値なので、伸びるぶん N×文脈 は平均の文脈より大きく、r1 は 1 以下に出る
      r1: stat(withR.map((turn) => turn.cacheRead / (turn.numTurns * turn.contextTokens))),
      r2: stat(withR2.map((turn) => turn.totalInput / (turn.numTurns * turn.contextTokens))),
      residualMissing: ok.length - withR.length,
      toolCount: stat(withTools.map((turn) => turn.toolCount)),
      toolCountMissing: ok.length - withTools.length,
      post: stat(posts),
      pre: stat(pres),
      assumedN,
      assumedC: ASSUMPTIONS.meanContextTokens,
      nVsAssumed: assumedN !== null && nStat !== null ? nStat.mean / assumedN : null,
      cVsAssumed: cStat !== null ? cStat.median / ASSUMPTIONS.meanContextTokens : null,
    };
  }

  // 全体の床・閾値
  const allCompactions = turns.flatMap((turn) => turn.compactions);
  const posts = allCompactions.map((c) => c.postTokens).filter(finite);
  const pres = allCompactions.map((c) => c.preTokens).filter(finite);
  const thresholds = [];
  let thresholdMissing = 0;
  const breakdowns = [];
  for (const turn of turns) {
    const usage = turn.contextUsage;
    if (usage === null) continue;
    if (finite(usage.autoCompactThreshold)) thresholds.push(usage.autoCompactThreshold);
    else thresholdMissing += 1;
    if (isObject(usage.messageBreakdown)) breakdowns.push({ usage, kind: turn.kind });
  }
  const contextTotals = turns.map((turn) => turn.contextUsage?.totalTokens).filter(finite);
  const compactions = {
    total: allCompactions.length,
    auto: allCompactions.filter((c) => c.trigger === 'auto').length,
    manual: allCompactions.filter((c) => c.trigger === 'manual').length,
    triggerUnknown: allCompactions.filter((c) => c.trigger !== 'auto' && c.trigger !== 'manual')
      .length,
    post: stat(posts),
    pre: stat(pres),
    postMissing: allCompactions.length - posts.length,
    preMissing: allCompactions.length - pres.length,
    postVsAssumed: stat(posts) === null ? null : stat(posts).median / ASSUMPTIONS.floorTokens,
    preVsAssumed: stat(pres) === null ? null : stat(pres).median / ASSUMPTIONS.thresholdTokens,
  };
  const threshold = {
    stat: stat(thresholds),
    distinct: [...new Set(thresholds)].sort((a, b) => a - b),
    missing: thresholdMissing,
    vsAssumed:
      stat(thresholds) === null ? null : stat(thresholds).median / ASSUMPTIONS.thresholdTokens,
  };

  const breakdownFields = [
    'toolCallTokens',
    'toolResultTokens',
    'assistantMessageTokens',
    'userMessageTokens',
    'attachmentTokens',
  ];
  const breakdownMeans = {};
  for (const field of breakdownFields) {
    breakdownMeans[field] = stat(
      breakdowns.map((row) => row.usage.messageBreakdown[field]).filter(finite),
    );
  }
  // 道具ごとの結果トークン: 行は文脈の瞬間の値なので足さず、1 行あたりの平均で並べる（道具が載っていない行は 0 として平均に入れる）
  const toolResult = new Map();
  for (const row of breakdowns) {
    const names = Array.isArray(row.usage.messageBreakdown.toolsByName)
      ? row.usage.messageBreakdown.toolsByName
      : [];
    for (const tool of names) {
      if (!isObject(tool) || typeof tool.name !== 'string' || !finite(tool.resultTokens)) continue;
      toolResult.set(tool.name, (toolResult.get(tool.name) ?? 0) + tool.resultTokens);
    }
  }
  const resultByTool = [...toolResult.entries()]
    .map(([name, sum]) => ({ name, meanResultTokens: sum / breakdowns.length }))
    .sort((a, b) => b.meanResultTokens - a.meanResultTokens || a.name.localeCompare(b.name))
    .slice(0, 8);

  // 道具の回数（turn_timing.tools.top。1 ターンの上位だけが載るので下限）
  const toolAgg = new Map();
  for (const turn of turns) {
    for (const tool of turn.toolTop) {
      if (!isObject(tool) || typeof tool.name !== 'string' || !finite(tool.count)) continue;
      const row = toolAgg.get(tool.name) ?? { count: 0, totalMs: 0 };
      row.count += tool.count;
      row.totalMs += finite(tool.totalMs) ? tool.totalMs : 0;
      toolAgg.set(tool.name, row);
    }
  }
  const toolsTop = [...toolAgg.entries()]
    .map(([name, row]) => ({ name, ...row }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 10);

  const first = timings[0]?.at ?? null;
  const last = timings[timings.length - 1]?.at ?? null;

  return {
    period: {
      from: first === null ? null : new Date(first).toISOString(),
      to: last === null ? null : new Date(last).toISOString(),
      hours: first === null || last === null ? null : (last - first) / 3_600_000,
    },
    population: {
      turns: turns.length,
      failed: turns.filter((turn) => !turn.succeeded).length,
      timingWithoutTime,
      duplicates,
      ignoredTypes,
      badLines: reading.badLines ?? 0,
      notEntries: reading.notEntries ?? 0,
      otherLayerRows,
      quotaEvents: quotaTimes.length,
    },
    matching: { usageRows, usageUnmatched, contextRows, contextUnmatched },
    classes,
    compactions,
    threshold,
    contextTotal: stat(contextTotals),
    breakdown: { rows: breakdowns.length, means: breakdownMeans, resultByTool },
    toolsTop,
    assumptions: ASSUMPTIONS,
  };
}

// ---------------------------------------------------------------------------------------------
// 表にする

const fmtInt = (value) =>
  value === null || value === undefined ? '—' : Math.round(value).toLocaleString('en-US');
const fmtRatio = (value) => (value === null || value === undefined ? '—' : value.toFixed(2));
const fmtDec = (value) => (value === null || value === undefined ? '—' : value.toFixed(1));

/** 実測 ÷ 仮定 から「当たったか」の語を作る。 */
export function verdict(ratio) {
  if (ratio === null || ratio === undefined) return '判定不能';
  if (Math.abs(ratio - 1) <= AGREEMENT_TOLERANCE)
    return `概ね一致（±${String(AGREEMENT_TOLERANCE * 100)}%）`;
  const pct = Math.round((ratio - 1) * 100);
  return `ずれ（${pct > 0 ? '+' : ''}${String(pct)}%）`;
}

const statCells = (s, fmt) =>
  s === null ? ['—', '—', '—'] : [fmt(s.median), fmt(s.p90), fmt(s.mean)];
const row = (cells) => `| ${cells.join(' | ')} |`;

export function renderReport(report) {
  const out = [];
  const { period, population, matching } = report;
  out.push('# クローン 1 ターンの N・C・P の集計（#5469 P8 前段）');
  out.push('');
  out.push(
    `期間: ${period.from ?? '—'} 〜 ${period.to ?? '—'}（${period.hours === null ? '—' : period.hours.toFixed(1)} 時間）。母数: turn_timing ${String(population.turns)} ターン（失敗 ${String(population.failed)}。失敗は N・C・P の統計に入れない）。`,
  );
  out.push(
    `単位は tokens。N = turn_timing.sdk.numTurns（そのターンのモデル要求の本数）、C = tokens.cacheRead ÷ N（要求 1 本あたりの平均の文脈の下限。cache_creation の分は含まない）。中央値 / p90（最近順位） / 平均。「—」は取れなかった（0 ではない）。`,
  );
  out.push('');

  out.push('## 取れなかった・結べなかった件数（0 に丸めていない）');
  out.push('');
  out.push(row(['項目', '件数']));
  out.push(row(['---', '---']));
  out.push(row(['JSON として読めなかった行', fmtInt(population.badLines)]));
  out.push(row(['JSON だが日誌の行でも封筒でもなかった', fmtInt(population.notEntries)]));
  out.push(row(['重複（同じ id）を落とした行', fmtInt(population.duplicates)]));
  out.push(row(['時刻が読めず集計から外した turn_timing', fmtInt(population.timingWithoutTime)]));
  out.push(row(['集計に使わない型の行（読み飛ばし）', fmtInt(population.ignoredTypes)]));
  out.push(
    row(['clone/session 以外の turn_usage・context_usage', fmtInt(population.otherLayerRows)]),
  );
  out.push(
    row([
      '要約を持つ turn_usage のうち turn_timing に結べなかった',
      `${fmtInt(matching.usageUnmatched)} / ${fmtInt(matching.usageRows)}`,
    ]),
  );
  out.push(
    row([
      'context_usage のうち turn_timing に結べなかった',
      `${fmtInt(matching.contextUnmatched)} / ${fmtInt(matching.contextRows)}`,
    ]),
  );
  out.push('');

  out.push('## 起点別: N（要求の本数）と道具の回数');
  out.push('');
  out.push(
    row([
      '起点',
      'ターン（失敗）',
      'N 取れた',
      'N 取れなかった',
      'N 中央値',
      'N p90',
      'N 平均',
      '仮定 N',
      '実測平均 ÷ 仮定',
      '判定',
      '道具回数 中央値',
      '道具回数 p90',
      '道具回数 取れなかった',
    ]),
  );
  out.push(row(Array(13).fill('---')));
  for (const key of CLASS_ORDER) {
    const c = report.classes[key];
    const [nMed, nP90, nMean] = statCells(c.n, fmtDec);
    out.push(
      row([
        c.label,
        `${fmtInt(c.turns)}（${fmtInt(c.failed)}）`,
        fmtInt(c.n === null ? 0 : c.n.n),
        fmtInt(c.nMissing),
        nMed,
        nP90,
        nMean,
        c.assumedN === null ? '—' : fmtDec(c.assumedN),
        fmtRatio(c.nVsAssumed),
        c.assumedN === null ? '仮定なし' : verdict(c.nVsAssumed),
        c.toolCount === null ? '—' : fmtDec(c.toolCount.median),
        c.toolCount === null ? '—' : fmtDec(c.toolCount.p90),
        fmtInt(c.toolCountMissing),
      ]),
    );
  }
  out.push('');

  out.push('## 起点別: C（= cacheRead ÷ N）と、式 cacheRead ≒ N × 文脈 の残差');
  out.push('');
  out.push(
    '残差 r1 = cacheRead ÷ (N × contextTokens)、r2 = (input + cacheRead + cacheCreation) ÷ (N × contextTokens)。contextTokens はターンの終わりの文脈なので、ターン内で伸びたぶん N × contextTokens は平均の文脈より大きく、**1 以下に出るのが自然**。r2 が 1 に近ければ、式（要求ごとに文脈の全部を送っている）が成り立つ。',
  );
  out.push('');
  out.push(
    row([
      '起点',
      'C 取れた',
      'C 取れなかった',
      'C 中央値',
      'C p90',
      '仮定 C',
      '実測中央 ÷ 仮定',
      '判定',
      'contextTokens 中央値',
      'contextTokens p90',
      'r1 中央値',
      'r2 中央値',
      '残差 取れなかった',
    ]),
  );
  out.push(row(Array(13).fill('---')));
  for (const key of CLASS_ORDER) {
    const c = report.classes[key];
    out.push(
      row([
        c.label,
        fmtInt(c.c === null ? 0 : c.c.n),
        fmtInt(c.cMissing),
        c.c === null ? '—' : fmtInt(c.c.median),
        c.c === null ? '—' : fmtInt(c.c.p90),
        fmtInt(c.assumedC),
        fmtRatio(c.cVsAssumed),
        verdict(c.cVsAssumed),
        c.contextTokens === null ? '—' : fmtInt(c.contextTokens.median),
        c.contextTokens === null ? '—' : fmtInt(c.contextTokens.p90),
        c.r1 === null ? '—' : fmtRatio(c.r1.median),
        c.r2 === null ? '—' : fmtRatio(c.r2.median),
        fmtInt(c.residualMissing),
      ]),
    );
  }
  out.push('');

  const comp = report.compactions;
  const thr = report.threshold;
  out.push('## 要約直後の文脈 P（床）と閾値');
  out.push('');
  out.push(
    `要約 ${fmtInt(comp.total)} 回（auto ${fmtInt(comp.auto)} / manual ${fmtInt(comp.manual)} / 種別不明 ${fmtInt(comp.triggerUnknown)}）。P = turn_usage.compactions[].postTokens、要約の直前 = preTokens。`,
  );
  out.push('');
  out.push(
    row(['量', '母数', '取れなかった', '中央値', 'p90', '平均', '仮定', '実測中央 ÷ 仮定', '判定']),
  );
  out.push(row(Array(9).fill('---')));
  const [pMed, pP90, pMean] = statCells(comp.post, fmtInt);
  out.push(
    row([
      '床 P（postTokens）',
      fmtInt(comp.post === null ? 0 : comp.post.n),
      fmtInt(comp.postMissing),
      pMed,
      pP90,
      pMean,
      fmtInt(report.assumptions.floorTokens),
      fmtRatio(comp.postVsAssumed),
      verdict(comp.postVsAssumed),
    ]),
  );
  const [qMed, qP90, qMean] = statCells(comp.pre, fmtInt);
  out.push(
    row([
      '要約の直前（preTokens）',
      fmtInt(comp.pre === null ? 0 : comp.pre.n),
      fmtInt(comp.preMissing),
      qMed,
      qP90,
      qMean,
      fmtInt(report.assumptions.thresholdTokens),
      fmtRatio(comp.preVsAssumed),
      verdict(comp.preVsAssumed),
    ]),
  );
  const [tMed, tP90, tMean] = statCells(thr.stat, fmtInt);
  out.push(
    row([
      '閾値（context_usage.autoCompactThreshold）',
      fmtInt(thr.stat === null ? 0 : thr.stat.n),
      fmtInt(thr.missing),
      tMed,
      tP90,
      tMean,
      fmtInt(report.assumptions.thresholdTokens),
      fmtRatio(thr.vsAssumed),
      verdict(thr.vsAssumed),
    ]),
  );
  const [xMed, xP90, xMean] = statCells(report.contextTotal, fmtInt);
  out.push(
    row([
      '要約の前後を問わない文脈（context_usage.totalTokens）',
      fmtInt(report.contextTotal === null ? 0 : report.contextTotal.n),
      '—',
      xMed,
      xP90,
      xMean,
      fmtInt(report.assumptions.meanContextTokens),
      fmtRatio(
        report.contextTotal === null
          ? null
          : report.contextTotal.mean / report.assumptions.meanContextTokens,
      ),
      verdict(
        report.contextTotal === null
          ? null
          : report.contextTotal.mean / report.assumptions.meanContextTokens,
      ),
    ]),
  );
  out.push('');
  out.push(
    `閾値の値の種類: ${thr.distinct.length === 0 ? '—' : thr.distinct.map(fmtInt).join(' / ')}。`,
  );
  out.push('');
  out.push('起点別の P（要約が走ったターンの起点。母数が小さいので参考）:');
  out.push('');
  out.push(row(['起点', '母数', 'P 中央値', 'P p90', 'preTokens 中央値', 'preTokens p90']));
  out.push(row(Array(6).fill('---')));
  for (const key of CLASS_ORDER) {
    const c = report.classes[key];
    out.push(
      row([
        c.label,
        fmtInt(c.post === null ? 0 : c.post.n),
        c.post === null ? '—' : fmtInt(c.post.median),
        c.post === null ? '—' : fmtInt(c.post.p90),
        c.pre === null ? '—' : fmtInt(c.pre.median),
        c.pre === null ? '—' : fmtInt(c.pre.p90),
      ]),
    );
  }
  out.push('');

  out.push(
    '## 会話の履歴の内訳（context_usage.messageBreakdown。1 行あたりの中央値 / p90 / 平均）',
  );
  out.push('');
  out.push(`母数: ${fmtInt(report.breakdown.rows)} 行（欄が無い行は数えない）。`);
  out.push('');
  out.push(row(['項目', '中央値', 'p90', '平均']));
  out.push(row(Array(4).fill('---')));
  const fieldLabels = {
    toolCallTokens: '道具の呼び出し',
    toolResultTokens: '道具の結果',
    assistantMessageTokens: '自分の出力',
    userMessageTokens: '入力（user）',
    attachmentTokens: '添付',
  };
  for (const [field, label] of Object.entries(fieldLabels)) {
    out.push(row([label, ...statCells(report.breakdown.means[field], fmtInt)]));
  }
  out.push('');
  out.push('道具の結果が文脈に占める量の上位（1 行あたりの平均 tokens）:');
  out.push('');
  out.push(row(['道具', '結果 tokens（平均）']));
  out.push(row(['---', '---']));
  for (const tool of report.breakdown.resultByTool)
    out.push(row([tool.name, fmtInt(tool.meanResultTokens)]));
  if (report.breakdown.resultByTool.length === 0) out.push(row(['（取れなかった）', '—']));
  out.push('');

  out.push('## 道具の回数の上位（turn_timing.tools.top の合計。1 ターンの上位だけが載るので下限）');
  out.push('');
  out.push(row(['道具', '回数', '合計 ms']));
  out.push(row(['---', '---', '---']));
  for (const tool of report.toolsTop)
    out.push(row([tool.name, fmtInt(tool.count), fmtInt(tool.totalMs)]));
  if (report.toolsTop.length === 0) out.push(row(['（取れなかった）', '—', '—']));
  out.push('');

  out.push('## 仮定（#5469 P8 前段）');
  out.push('');
  out.push(
    `床 P ${fmtInt(report.assumptions.floorTokens)} / 閾値 T ${fmtInt(report.assumptions.thresholdTokens)} / 平均の文脈 C ${fmtInt(report.assumptions.meanContextTokens)} = (P+T)/2 / 起点別 N: ${Object.entries(
      report.assumptions.requestsPerTurn,
    )
      .map(([k, v]) => `${CLASS_LABELS[k]} ${fmtDec(v)}`)
      .join('、')}。判定の幅は ±${String(AGREEMENT_TOLERANCE * 100)}%。`,
  );
  out.push('');
  return out.join('\n');
}
