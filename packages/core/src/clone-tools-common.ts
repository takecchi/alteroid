// 複数の族の道具が共有する部品（道具の定義の包み・応答の組み立て・日誌の追記・固定文の畳み・使用量の共通の整形）。
// `tools.ts` から import して使う。このファイルから `tools.ts` を import しない（一方向）。

import { tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { assertNeverRunnerLegStatus } from './runner-protocol.js';
import { journalEntryShape, noteDroppedRecord } from './dropped-record.js';
import { collapseErrorCause } from './error-cause.js';
import type { RunnerBacklogSnapshot } from './manager.js';
import type { JournalEntry, JournalEntryInput } from './schema.js';
import type { JournalStore } from './store.js';
import type { UsageRow } from './usage.js';
import { strictToolInput } from './strict-tool-input.js';
import type { CloneToolName } from './clone-tools-names.js';

const MISSING_ARG_HINT =
  '引数が届いていない（received undefined ＝ 呼び出しの JSON にその鍵が最初から無かった。道具が受け取ってから落としたのではない）。書いたつもりなら、まず呼び出しの生の形を疑うこと —— タグの接頭辞の脱落など、呼び出しの組み立てが壊れていると引数は静かに落ちる。決定的な対照: 引数の並びも長さも1文字も変えず、タグだけ正しく書いて1回送り直す。それで通れば、原因は呼び出しの形であって、この道具でも引数の中身でもない';

// `.describe()` を貼り直す: `clone()` で説明が落ち、モデルが読む道具の意味が削れるため
export function withMissingArgHint<Shape extends object>(shape: Shape): Shape {
  const hinted = Object.entries(shape).map(([key, value]) => {
    const schema = value as z.ZodTypeAny & { _zod?: { def?: object } };
    const def = schema?._zod?.def;
    if (!def || typeof schema.clone !== 'function') return [key, value];
    const cloned = schema.clone({
      ...def,
      error: (iss: { input?: unknown }) => (iss.input === undefined ? MISSING_ARG_HINT : undefined),
    } as never);
    return [key, schema.description === undefined ? cloned : cloned.describe(schema.description)];
  });
  return Object.fromEntries(hinted) as Shape;
}

export const tool: typeof sdkTool = (name, description, inputSchema, handler, extras) =>
  sdkTool(name, description, strictToolInput(withMissingArgHint(inputSchema)), handler, extras);

// `instanceSwapped` を先に見る: 脚が 'connected' でも新しい器との接続で、滞留を持っていた古い器とは別物のため
export function describeRunnerLegState(snapshot: RunnerBacklogSnapshot): string {
  if (snapshot.instanceSwapped === true) {
    return (
      'もう来ない（この滞留を観測した後に器が入れ替わった。runner の Outbox は' +
      'プロセスのメモリだけなので、溜まっていた分は配られずに消えている——' +
      '生ログから拾うしかない）'
    );
  }
  const leg = snapshot.legState;
  if (leg === undefined) {
    return '判定できない（この runner は脚の状態を報告しない、またはいま名簿に居ない）';
  }
  switch (leg.status) {
    case 'connected': {
      // 閾値で「死んでいる」を判定しない: 判定を足すと静かに間違える判定を作るため
      const lastByteAt =
        leg.lastByteAt === undefined
          ? '開いてから1バイトも受け取っていない'
          : `最後にバイトを受け取ったのは ${leg.lastByteAt}`;
      return (
        'まだ届いていない。届く見込みがある' +
        `（脚は繋がっている。待ってよい。${leg.since} から、${lastByteAt}）`
      );
    }
    case 'down': {
      const detail = [
        leg.since === undefined ? undefined : `${leg.since} から`,
        leg.lastFailureReason === undefined ? undefined : `直近の理由: ${leg.lastFailureReason}`,
        leg.nextRetryAt === undefined ? undefined : `次の再試行: ${leg.nextRetryAt}`,
      ].filter((part): part is string => part !== undefined);
      const detailSuffix = detail.length === 0 ? '' : `（${detail.join('、')}）`;
      return `⚠ 再接続するまで1件も届かない${detailSuffix}`;
    }
    case 'never-connected':
      return '⚠ 再接続するまで1件も届かない（このデーモンが起きてから一度も繋がっていない）';
    default:
      return assertNeverRunnerLegStatus(leg);
  }
}

// `REPORT_PAGE` と同じ値でも使い回さない: 意味が違い、片方だけ直したくなったときに一緒に動くため
export const TRANSCRIPT_PAGE = 8_000;

// 本文を薄くして件数を残す: 日誌は特定の時刻の1行を探すために引き、全文は `id` で取りに行けるため
export const JOURNAL_TEXT_EXCERPT = 120;

export function describeUnreadableJournalEntry(label: string, id: string): string {
  return `${label} ${id} は在るが読めない（形が合わない壊れた行。無いのではなく、id は合っている）。行は書き換えていない。`;
}

export const RUNNER_MANAGER_PEERS_EXCERPT = 400;

export function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

export type ToolText = ReturnType<typeof text>;

// 一律に「完了した」と書かない: 記録そのものが行為の道具では「やり直すな」が嘘になり、やり直すべきときに止めてしまうため
type JournalFailureOutcome = 'act-completed' | 'act-not-performed' | 'act-partially-completed';

// ガードで握り潰して成功として返さない: `isError: true` は依頼者がその場で気づける唯一の合図のため、跡を残してから投げ直す
export class JournalNotRecordedError extends Error {
  // 呼び手が作り直す応答のために持つ（本文は `journalEntryShape` と `collapseErrorCause` を通した文だけを使う）
  readonly entry: JournalEntryInput;
  readonly journalCause: unknown;

  constructor(
    tool: CloneToolName,
    entry: JournalEntryInput,
    outcome: JournalFailureOutcome,
    cause: unknown,
  ) {
    super(formatJournalNotRecordedMessage(tool, entry, outcome, cause));
    this.name = 'JournalNotRecordedError';
    this.entry = entry;
    this.journalCause = cause;
  }
}

function formatJournalNotRecordedMessage(
  tool: CloneToolName,
  entry: JournalEntryInput,
  outcome: JournalFailureOutcome,
  cause: unknown,
): string {
  // 道具の引数を `journalEntryShape` の外から転記しない: 鍵や本文が応答へ漏れるため
  // `cause.message` を使わない: `DrizzleQueryError` の message は2行目に行の値そのものを含むため `collapseErrorCause` を通す
  const shape = journalEntryShape(entry);
  const reason = collapseErrorCause(cause);
  switch (outcome) {
    case 'act-completed':
      return [
        '⚠⚠ 完了済み・未記録・やり直し禁止',
        `${tool} は完了した（副作用は済んでいる）が、日誌へ記録できなかった。`,
        `記録できなかったエントリ: ${shape}`,
        `理由: ${reason}`,
        'やり直さないこと（同じ副作用がもう一度起きる）。journal_write で記録を書き直すこと。',
      ].join('\n');
    case 'act-not-performed':
      return [
        '⚠⚠ 未記録・行為は起きていない・やり直してよい',
        `${tool} は、この記録に失敗した時点で副作用を1つも起こしていない` +
          '（日誌へ記録すること自体が道具の行為であるか、状態を変える前に日誌を' +
          '先に書く道具であるかのどちらかに当たる）。',
        `記録できなかったエントリ: ${shape}`,
        `理由: ${reason}`,
        'やり直してよい（同じ内容でもう一度呼べる。重複は起きない）。',
      ].join('\n');
    case 'act-partially-completed':
      return [
        '⚠⚠ 一部完了・未記録・やり直し禁止',
        `${tool} は移し先への追記まで済んだが、出どころからの切り取りは行っていない。`,
        'いま同じ節が移し先と出どころの両方に在る——重複しているが、失われてはいない。',
        'そのうえで日誌へ記録できなかった。',
        `記録できなかったエントリ: ${shape}`,
        `理由: ${reason}`,
        'やり直さないこと（重複がもう1つ増える）。memory_outline で現状を読み直してから決めること。',
      ].join('\n');
  }
}

export async function appendJournalOrThrow(
  tool: CloneToolName,
  journal: JournalStore,
  entry: JournalEntryInput,
  outcome: JournalFailureOutcome,
): Promise<JournalEntry> {
  try {
    return await journal.append(entry);
  } catch (error) {
    noteDroppedRecord('日誌', journalEntryShape(entry), error);
    throw new JournalNotRecordedError(tool, entry, outcome, error);
  }
}

// `appendJournalOrThrow` を使わない: 1行目が書けた後の追記が投げると、道具の結果がもう決まっているのに応答が変わるため
export async function appendJournalOrDrop(
  tool: CloneToolName,
  journal: JournalStore,
  entry: JournalEntryInput,
): Promise<JournalEntry | undefined> {
  try {
    return await journal.append(entry);
  } catch (error) {
    noteDroppedRecord(`日誌（${tool}）`, journalEntryShape(entry), error);
    return undefined;
  }
}

export const NO_POOL = text(
  'いまは委譲できない場面である（記憶へ移すための内部ターン）。' +
    '実作業が必要なら、この場では記憶に残すだけにして、次の会話で委譲すること。',
);

// 軸ごとに上限を置き、打ち切ったことを必ず書く: 「全部でこれだけ」と読める出力を黙って作ると嘘になるため
export const USAGE_AXIS_LIMIT = 14;

export const USAGE_AXIS_PAGE = 100;

export function maxUpdatedAt(rows: readonly UsageRow[]): string | undefined {
  let max: string | undefined;
  for (const row of rows) {
    if (max === undefined || row.updatedAt > max) max = row.updatedAt;
  }
  return max;
}

// 文言を1か所に寄せる: 片方だけ直すと読み手が「同じことを別の言葉で言っている」と誤読するため
export function renderRisenSection<T>(
  risen: readonly T[],
  formatEntry: (entry: T) => string,
): string[] {
  if (risen.length === 0) return [];
  const lines = [
    '',
    '⚠ 順位が上がった、または既に見せた行が伸びた可能性がある行' +
      '（前回の呼び出し以降に記録が増えたため。この頁の本体とは重複しない）:',
  ];
  for (const entry of risen.slice(0, USAGE_AXIS_LIMIT)) lines.push(formatEntry(entry));
  if (risen.length > USAGE_AXIS_LIMIT) {
    lines.push(`  …ほか ${risen.length - USAGE_AXIS_LIMIT} 件は省略。`);
  }
  return lines;
}
