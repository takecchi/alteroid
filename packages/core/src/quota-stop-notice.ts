import { excerptLine } from './excerpt.js';
import type { JobStatus } from './schema.js';
import { FAILED_REPORT_PARTIAL_MARKER } from './sdk-failure.js';
import { noticeResetText, parseNoticeResetAt } from './usage-reset-text.js';

/**
 * 枠（利用上限）だけが理由の知らせにつける印。**積む時点で呼び手が、構造化された値か既存の分類から付ける**
 * （`isQuotaFailure` / `classifyUsageNotice` / `rate_limit` の facts）。この層では文言から枠かどうかを判定し直さない。
 * 印の無い断片が1つでも混ざる束は枠の束と呼ばず、担当ごとに配る（畳み間違いのほうが重い）。
 */
export interface QuotaMark {
  /** 文言に書かれていたリセット時刻の言い回し（`resets 12:20am (Asia/Tokyo)`）。 */
  resetText?: string;
  /** リセット時刻（epoch ms）。facts か、文言から読めたときだけ。 */
  resetsAt?: number;
  /** SDK の原文。全体で1回だけ載せるために持つ。 */
  sdkText?: string;
  /** 失敗する前に出ていた本文。 */
  said?: string;
  /** `rate_limit` が「課金枠へ入った」遷移だったとき。無ければ追い返された。 */
  enteredOverage?: true;
  /**
   * 積んだ時点でその担当が抱えていたトークンの id（`#tokenIdentities`）。プール全体の窓の鍵になる:
   * 別のトークンの枠は別の出来事なので、1通にまとめない。取れなかったときは付けない（不明の窓にまとまる）。
   */
  tokenKey?: string;
}

const UNKNOWN_TOKEN_WINDOW_KEY = '(トークン不明)';

/** プール全体の窓の鍵。束のどれかの断片がトークンを名乗っていればそれ、無ければ「不明」の1つの鍵。 */
export function quotaStopWindowKeyOf(fragments: readonly { quota?: QuotaMark }[]): string {
  for (const fragment of fragments) {
    if (fragment.quota?.tokenKey !== undefined) return fragment.quota.tokenKey;
  }
  return UNKNOWN_TOKEN_WINDOW_KEY;
}

/** 枠だけの束を、プール全体で1通にまとめる固定窓（延長しない）。 */
export const QUOTA_STOP_WINDOW_MS = 30_000;

/** 文言の `resets 12:20am` は最大でも1日先を指す。余裕を持たせた読み取りの範囲。 */
const RESET_LOOKAHEAD_MS = 2 * 24 * 60 * 60 * 1000;

export function quotaMarkOf(
  source: { text?: string; resetsAt?: number },
  now: number,
  extra: Omit<QuotaMark, 'resetText' | 'resetsAt'> = {},
): QuotaMark {
  const resetText = source.text === undefined ? undefined : noticeResetText(source.text);
  const resetsAt =
    source.resetsAt ??
    (source.text === undefined
      ? undefined
      : parseNoticeResetAt(source.text, { at: now, withinMs: RESET_LOOKAHEAD_MS }));
  return {
    ...(resetText === undefined ? {} : { resetText }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...extra,
  };
}

/** `failedReportText` が見出しの後ろに付けた「失敗する前に出ていた本文」。無ければ `undefined`。 */
export function partialBeforeFailureOf(failedReport: string): string | undefined {
  const at = failedReport.indexOf(FAILED_REPORT_PARTIAL_MARKER);
  if (at === -1) return undefined;
  const partial = failedReport.slice(at + FAILED_REPORT_PARTIAL_MARKER.length).trim();
  return partial.length === 0 ? undefined : partial;
}

/** `failedReportText` の見出し行の次から、最初の空行か注記（`（…`）の手前までを SDK の本文として返す。 */
export function failedReportBodyOf(failedReport: string): string | undefined {
  const newline = failedReport.indexOf('\n');
  if (newline === -1) return undefined;
  const rest = failedReport.slice(newline + 1);
  const end = rest.search(/\n\n|\n（/);
  const body = (end === -1 ? rest : rest.slice(0, end)).trim();
  return body.length === 0 ? undefined : body;
}

export interface QuotaStopEntry {
  managerId: string;
  /** 窓を開けた担当。この担当の知らせは、担当への報告として先に届けてある。 */
  first?: true;
  /** 配る時点の台帳の `job.status`。台帳に無ければ `undefined`。 */
  status: JobStatus | undefined;
  /** 到着順。 */
  fragments: readonly { label: string; quota: QuotaMark }[];
}

const SAID_EXCERPT = 160;
const SDK_TEXT_EXCERPT = 600;
const SDK_TEXT_LABEL_PRIORITY = ['usage_notice', 'closed_failed', 'turn_failed', 'rate_limit'];

function statusPhrase(status: JobStatus | undefined): string {
  switch (status) {
    case 'running':
      return 'running（セッションは生きている）';
    case 'done':
      return 'done（セッションは生きている）';
    case 'waiting_human':
      return 'waiting_human（セッションは生きている。人の返事待ち）';
    case 'failed':
      return 'failed（セッションは落ちて、failed で畳まれた）';
    case 'lost':
      return 'lost（セッションは失われた）';
    case 'stopped':
      return 'stopped（止められている）';
    case undefined:
      return '不明（台帳に見当たらない）';
  }
}

function whatHappened(fragment: { label: string; quota: QuotaMark }): string {
  switch (fragment.label) {
    case 'turn_failed':
      return '応答を返さずに終わった';
    case 'closed_failed':
      return 'セッションが落ちた';
    case 'rate_limit':
      return fragment.quota.enteredOverage === true ? '課金枠へ入った' : '枠から追い返された';
    case 'usage_notice':
      return '利用上限の通知が来た';
    default:
      return fragment.label;
  }
}

function firstOf<T>(
  entry: QuotaStopEntry,
  pick: (quota: QuotaMark) => T | undefined,
): T | undefined {
  for (const fragment of entry.fragments) {
    const value = pick(fragment.quota);
    if (value !== undefined) return value;
  }
  return undefined;
}

interface Group {
  key: string;
  resetText: string | undefined;
  resetsAt: number | undefined;
  entries: QuotaStopEntry[];
}

function resetPhrase(group: Pick<Group, 'resetText' | 'resetsAt'>): string {
  if (group.resetText !== undefined) return group.resetText;
  if (group.resetsAt !== undefined) return `resets ${new Date(group.resetsAt).toISOString()}`;
  return 'リセット時刻は分からない';
}

/**
 * 同じリセット時刻の担当を1つの節にまとめる。鍵は読めた時刻（分まで）を先に使い、無ければ言い回し、どちらも無ければ「分からない」。
 * 文言から読んだ時刻と facts の時刻は別の経路で届くので、時刻へ直せるものは直して突き合わせる（直せなければ言い回しで）。
 */
function groupByReset(entries: readonly QuotaStopEntry[]): Group[] {
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const resetText = firstOf(entry, (q) => q.resetText);
    const resetsAt = firstOf(entry, (q) => q.resetsAt);
    const key =
      resetsAt !== undefined
        ? `at:${String(Math.floor(resetsAt / 60_000))}`
        : resetText !== undefined
          ? `text:${resetText}`
          : 'unknown';
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { key, resetText, resetsAt, entries: [entry] });
    } else {
      group.entries.push(entry);
      group.resetText ??= resetText;
      group.resetsAt ??= resetsAt;
    }
  }
  // 「分からない」は最後へ: 時刻の分かった節を先に読ませる。
  return [...groups.values()].sort(
    (a, b) => Number(a.key === 'unknown') - Number(b.key === 'unknown'),
  );
}

function sdkTextOf(entries: readonly QuotaStopEntry[]): string | undefined {
  for (const label of SDK_TEXT_LABEL_PRIORITY) {
    for (const entry of entries) {
      for (const fragment of entry.fragments) {
        if (fragment.label === label && fragment.quota.sdkText !== undefined) {
          return fragment.quota.sdkText;
        }
      }
    }
  }
  return undefined;
}

function entryLines(entry: QuotaStopEntry): string[] {
  const what = [...new Set(entry.fragments.map(whatHappened))].join('／');
  const firstNote = entry.first === true ? '（最初の1本。担当への報告としては先に届けてある）' : '';
  const lines = [`- ${entry.managerId}: 状態 ${statusPhrase(entry.status)} / ${what}${firstNote}`];
  const said = firstOf(entry, (q) => q.said);
  if (said !== undefined) {
    lines.push(`  失敗する前に出ていた本文: ${excerptLine(said, SAID_EXCERPT)}`);
  }
  return lines;
}

/**
 * クローンが送り直しを判断するための1通。担当ごとの全文は載せない（日誌に在る）。
 * 状態は呼び手が配る時点の台帳から渡す: 「セッションは生きている」と「failed で畳まれた」で、次の手が違うため。
 */
export function renderQuotaStopNotice(entries: readonly QuotaStopEntry[]): {
  text: string;
  resetGroups: number;
} {
  const groups = groupByReset(entries);
  const head =
    groups.length === 1 && groups[0] !== undefined
      ? `枠に当たって ${String(entries.length)} 本の担当が止まった（${resetPhrase(groups[0])}）`
      : `枠に当たって ${String(entries.length)} 本の担当が止まった（リセット時刻は ${String(groups.length)} 通り）`;
  const lines = [
    head,
    '最初の1本は担当への報告として先に届けてあり、残りは担当ごとには配らずこの1通にまとめてある。',
    '',
  ];
  for (const group of groups) {
    if (groups.length > 1) {
      lines.push(`■ ${resetPhrase(group)}（${String(group.entries.length)} 本）`);
    }
    for (const entry of group.entries) lines.push(...entryLines(entry));
    lines.push('');
  }
  const sdkText = sdkTextOf(entries);
  if (sdkText !== undefined) {
    lines.push(`SDK の原文（全体で1回だけ）: ${excerptLine(sdkText, SDK_TEXT_EXCERPT)}`, '');
  }
  lines.push('各担当の知らせの全文は日誌にある。担当ごとの詳細は manager_report で読める。');
  return { text: lines.join('\n'), resetGroups: groups.length };
}
