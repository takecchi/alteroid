import type { JournalEntry } from './schema.js';

// `turn_timing`（#5086）を人が読む形にする。`journal_read` の1行・本文と、`self_status` の要約が同じ言い方を使う
export type TurnTimingEntry = Extract<JournalEntry, { type: 'turn_timing' }>;

const PHASE_LABELS: Record<string, string> = {
  queue: '順番待ち（前のターンの処理待ち）',
  prepare: 'ターンの前の組み立て',
  sessionStart: 'セッションの起動',
  composeInput: '入力の組み立て（記憶の焼き込み・要約の注入）',
  model: 'モデル（SDK に投げてから result まで）',
  finalize: '書き戻し（result の後の後始末）',
};

export function turnTimingPhaseLabel(phase: string): string {
  const known = PHASE_LABELS[phase];
  if (known !== undefined) return known;
  const dot = phase.indexOf('.');
  if (dot < 0) return phase;
  const parent = phase.slice(0, dot);
  return `${PHASE_LABELS[parent] ?? parent}のうち ${phase.slice(dot + 1)}`;
}

export function formatSeconds(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}秒` : `${String(Math.round(seconds))}秒`;
}

function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}

/** 入力として読んだ量（素の入力＋キャッシュの読み＋キャッシュの書き）。モデルが毎要求で読み直す前置きの重さ */
export function turnInputTokens(entry: Pick<TurnTimingEntry, 'tokens'>): number | undefined {
  const tokens = entry.tokens;
  if (tokens === undefined) return undefined;
  return tokens.input + tokens.cacheRead + tokens.cacheCreation;
}

function describeTokens(tokens: NonNullable<TurnTimingEntry['tokens']>): string {
  const input = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  return (
    `入力 ${formatTokens(input)} トークン（素の入力 ${formatTokens(tokens.input)}・キャッシュの読み ${formatTokens(tokens.cacheRead)}` +
    `・キャッシュの書き ${formatTokens(tokens.cacheCreation)}）・出力 ${formatTokens(tokens.output)}`
  );
}

/** 親の段（`.` の無い段）を長い順に並べる。内訳（`.` 付き）は親に含まれるので混ぜない */
export function topLevelPhases(entry: Pick<TurnTimingEntry, 'phases'>): Array<[string, number]> {
  return Object.entries(entry.phases)
    .filter(([name]) => !name.includes('.'))
    .sort((a, b) => b[1] - a[1]);
}

function subPhases(
  entry: Pick<TurnTimingEntry, 'phases'>,
  parent: string,
): Array<[string, number]> {
  return Object.entries(entry.phases)
    .filter(([name]) => name.startsWith(`${parent}.`))
    .sort((a, b) => b[1] - a[1]);
}

/** その段が遅かった「なぜ」の材料を1文にする。材料が無ければ空文字 */
export function describeTurnTimingReason(entry: TurnTimingEntry, phase: string): string {
  if (phase === 'queue') {
    return entry.batchSize > 1 ? `束ねた合図 ${String(entry.batchSize)} 件` : '';
  }
  if (phase === 'model') {
    const parts: string[] = [];
    if (entry.firstResponseMs !== undefined) {
      parts.push(`最初の応答まで ${formatSeconds(entry.firstResponseMs)}`);
    }
    if (entry.tools !== undefined) {
      const top = entry.tools.top[0];
      parts.push(
        `道具 ${String(entry.tools.count)} 回で ${formatSeconds(entry.tools.totalMs)}` +
          (top === undefined
            ? ''
            : `（最も長いのは ${top.name} ${String(top.count)} 回 ${formatSeconds(top.totalMs)}、1回の最長 ${formatSeconds(top.maxMs)}）`),
      );
    }
    if (entry.compactions !== undefined) {
      parts.push(
        `要約 ${String(entry.compactions.count)} 回で ${formatSeconds(entry.compactions.totalMs)}`,
      );
    }
    if (entry.sdk?.numTurns !== undefined) parts.push(`要求 ${String(entry.sdk.numTurns)} 本`);
    if (entry.sdk?.durationApiMs !== undefined) {
      parts.push(`API の時間 ${formatSeconds(entry.sdk.durationApiMs)}`);
    }
    if (entry.contextTokens !== undefined) {
      parts.push(`文脈 ${entry.contextTokens.toLocaleString('en-US')} トークン`);
    }
    const input = turnInputTokens(entry);
    if (input !== undefined) parts.push(`入力 ${formatTokens(input)} トークン`);
    return parts.join('・');
  }
  const subs = subPhases(entry, phase).slice(0, 3);
  return subs
    .map(([name, ms]) => `${name.slice(phase.length + 1)} ${formatSeconds(ms)}`)
    .join('・');
}

export function describeTurnTimingHead(entry: TurnTimingEntry): string {
  const kinds = entry.kinds.length === 0 ? 'ターン無し' : entry.kinds.join('+');
  const [slowest] = topLevelPhases(entry);
  return (
    `[turn_timing ${kinds} ${entry.triggers.join('+') || '?'} ${entry.succeeded ? '成功' : '失敗'}]` +
    ` 合計 ${formatSeconds(entry.totalMs)}` +
    (entry.firstTextMs === undefined
      ? ''
      : `・最初の文字まで ${formatSeconds(entry.firstTextMs)}`) +
    (slowest === undefined ? '' : `・最も長い段 ${slowest[0]} ${formatSeconds(slowest[1])}`)
  );
}

export function describeTurnTimingBody(entry: TurnTimingEntry): string {
  const lines = topLevelPhases(entry).map(([phase, ms]) => {
    const reason = describeTurnTimingReason(entry, phase);
    return `- ${turnTimingPhaseLabel(phase)}: ${formatSeconds(ms)}${reason === '' ? '' : `（${reason}）`}`;
  });
  if (entry.tools !== undefined && entry.tools.top.length > 1) {
    lines.push(
      '- 道具の内訳（合計の長い順）: ' +
        entry.tools.top
          .map((tool) => `${tool.name} ${String(tool.count)} 回 ${formatSeconds(tool.totalMs)}`)
          .join(' / '),
    );
  }
  if (entry.tokens !== undefined) {
    lines.push(`- 消費（このターンのメインループ）: ${describeTokens(entry.tokens)}`);
  }
  return lines.join('\n');
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/**
 * 直近のターンの時間を要約する（`self_status` の節）。どの段が遅さの元かを、段ごとの合計の多い順に出す。
 * 0件なら、まだ測っていないと言う（0 秒と書かない）
 */
export function renderTurnTimingSummary(entries: readonly TurnTimingEntry[]): string {
  if (entries.length === 0) {
    return '直近のターンの時間: まだ記録が無い（turn_timing は、この版でターンが1回終わると書かれる）。';
  }
  const totals = entries.map((entry) => entry.totalMs).sort((a, b) => a - b);
  const firstTexts = entries
    .map((entry) => entry.firstTextMs)
    .filter((ms): ms is number => ms !== undefined)
    .sort((a, b) => a - b);
  const byPhase = new Map<string, number>();
  for (const entry of entries) {
    for (const [phase, ms] of topLevelPhases(entry)) {
      byPhase.set(phase, (byPhase.get(phase) ?? 0) + ms);
    }
  }
  const sumAll = [...byPhase.values()].reduce((sum, ms) => sum + ms, 0);
  const phaseShare = [...byPhase.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(
      ([phase, ms]) =>
        `${turnTimingPhaseLabel(phase)} ${formatSeconds(ms)}` +
        (sumAll === 0 ? '' : `（${String(Math.round((ms / sumAll) * 100))}%）`),
    );
  const slowest = [...entries].sort((a, b) => b.totalMs - a.totalMs).slice(0, 3);
  const inputs = entries
    .map((entry) => turnInputTokens(entry))
    .filter((tokens): tokens is number => tokens !== undefined)
    .sort((a, b) => a - b);
  const inputLine =
    inputs.length === 0
      ? '- 1ターンあたりの入力: 消費が取れたターンが無い'
      : `- 1ターンあたりの入力（素の入力＋キャッシュの読み・書き）: 中央値 ${formatTokens(percentile(inputs, 0.5))}・` +
        `90% 点 ${formatTokens(percentile(inputs, 0.9))}・${String(inputs.length)} ターンの合計 ${formatTokens(
          inputs.reduce((sum, tokens) => sum + tokens, 0),
        )} トークン`;
  return [
    `直近のターンの時間（${String(entries.length)} 件。turn_timing から。詳細は journal_read types=["turn_timing"]）:`,
    `- 応答が全部終わるまで: 中央値 ${formatSeconds(percentile(totals, 0.5))}・90% 点 ${formatSeconds(percentile(totals, 0.9))}`,
    firstTexts.length === 0
      ? '- 最初の文字まで: 文字を返したターンが無い'
      : `- 最初の文字まで: 中央値 ${formatSeconds(percentile(firstTexts, 0.5))}・90% 点 ${formatSeconds(percentile(firstTexts, 0.9))}`,
    `- 時間を食っている段（合計の多い順）: ${phaseShare.join(' / ')}`,
    inputLine,
    '- 最も長かったターン:',
    ...slowest.map((entry) => {
      const [phase] = topLevelPhases(entry);
      const reason = phase === undefined ? '' : describeTurnTimingReason(entry, phase[0]);
      return (
        `  - ${entry.at} 合計 ${formatSeconds(entry.totalMs)}` +
        (phase === undefined
          ? ''
          : `・最も長い段 ${turnTimingPhaseLabel(phase[0])} ${formatSeconds(phase[1])}` +
            (reason === '' ? '' : `（${reason}）`))
      );
    }),
  ].join('\n');
}
