import { scanJournalPages } from './journal-scan.js';
import type { JournalEntry, JournalEntryInput } from './schema.js';
import type { JournalStore } from './store.js';

// 「始めた」ではなく「成功で終わった」を印にする: 開始の印は `#runInternal` の前に書かれ、途中でプロセスが消えた回が「蒸留した」と読めてしまうため
export const DISTILL_SUCCEEDED_DECISION_PREFIX = '蒸留が成功で終わった:';

export type DistillReason = 'conversation_end' | 'shutdown' | 'pre_compact' | 'scheduled';

export function distillSucceededEntry(reason: DistillReason): JournalEntryInput {
  return {
    type: 'decision',
    decision: `${DISTILL_SUCCEEDED_DECISION_PREFIX} reason=${reason}`,
    grounds:
      '蒸留のターンが成功（`answered`）で返った。**「始めた」ではなく「成功で終わった」印である** —— ' +
      '開始の印（日誌の `ターンの入力: distill`）は `#runInternal` を呼ぶ前に書かれるので、' +
      '途中でプロセスが消えた回も「蒸留した」と読めてしまう（`distill-gap.ts` の doc）。' +
      'クローンの判断ではなく器の記帳である。',
  };
}

export function isDistillSucceededEntry(entry: JournalEntry): boolean {
  return entry.type === 'decision' && entry.decision.startsWith(DISTILL_SUCCEEDED_DECISION_PREFIX);
}

/** デーモンが起動のたびに、クローンを作る前に書く器の実寸の記録（`apps/daemon` の `reportBootFootprint`）の source。 */
export const BOOT_FOOTPRINT_EVENT_SOURCE = 'boot-storage-footprint';

/** デーモンが起動のたびに書く、クローンの子の env で ToolSearch が止まる見込みかの記録（`apps/daemon` の `reportBootToolSearch`）の source。 */
export const BOOT_TOOL_SEARCH_EVENT_SOURCE = 'boot-tool-search';
const BOOT_EVENT_SOURCES: ReadonlySet<string> = new Set([
  BOOT_FOOTPRINT_EVENT_SOURCE,
  BOOT_TOOL_SEARCH_EVENT_SOURCE,
]);

// 型と構造化フィールドだけで決め、本文は見ない: 文言を直した瞬間に黙って数え方が変わるため
// 「最後の蒸留 < 最終追記」で判定しない: 蒸留自身が日誌へ書くので毎回真になるため
// 起動時の器の記録（実寸・ToolSearch）は数えない: 起動のたびに必ず1行ずつ積まれるので、数えると記憶が空の初回起動でも、蒸留が成功して終わった後の再起動でも、毎回「移りきっていない」と偽って断ることになるため
export function countsAsUndistilledActivity(entry: JournalEntry): boolean {
  switch (entry.type) {
    case 'exchange':
      return entry.with !== 'self';
    case 'turn_usage':
      return entry.site === 'session';
    case 'external_event':
      return !BOOT_EVENT_SOURCES.has(entry.source);
    case 'subagent_stall':
      return false;
    case 'context_usage':
      return false;
    case 'inbox_flow':
      return false;
    default:
      return false;
  }
}

// 無制限に遡らない: 印が1件も無い器で全件を読むと、日誌の大きさに比例した読み出しが起動直後に走るため
export const DISTILL_GAP_ACTIVITY_SCAN_LIMIT = 500;

export interface DistillGap {
  lastDistilledAt: string | null;
  lastActivityAt: string;
  firstActivityAt: string;
  activityCount: number;
  window: 'since_last_distill' | 'newest_entries';
}

export async function deriveDistillGapFromJournal(
  journal: Pick<JournalStore, 'list' | 'listPage'>,
  options: { until: string; activityScanLimit?: number },
): Promise<DistillGap | null> {
  const { until } = options;
  const scanLimit = options.activityScanLimit ?? DISTILL_GAP_ACTIVITY_SCAN_LIMIT;

  // `at < until` で切り直す（`until` は読み出しの上限にだけ使う）: `until` は時刻を含み、器の生成と最初の発言の記帳が同じミリ秒に並ぶと自分を数えてしまうため
  const beforeBoot = (entry: JournalEntry): boolean => entry.at < until;

  let marker: JournalEntry | undefined;
  await scanJournalPages(journal, { types: ['decision'], until }, (page) => {
    for (const entry of page) {
      if (beforeBoot(entry) && isDistillSucceededEntry(entry)) {
        marker = entry;
        return false;
      }
    }
  });
  const lastDistilledAt = marker?.at ?? null;

  // `since: lastDistilledAt` にしない: `since` は時刻を含み、印と同じミリ秒の1つ前の行（その蒸留が移した活動）が窓へ入るため
  let activityCount = 0;
  let firstActivityAt: string | undefined;
  let lastActivityAt: string | undefined;

  if (marker === undefined) {
    const entries = await journal.list({ until, limit: scanLimit });
    const activity = entries.filter(
      (entry) => beforeBoot(entry) && countsAsUndistilledActivity(entry),
    );
    if (activity.length === 0) return null;
    activityCount = activity.length;
    lastActivityAt = activity[0]?.at;
    firstActivityAt = activity.at(-1)?.at;
  } else {
    const markerAnchor = marker;
    await scanJournalPages(
      journal,
      { order: 'asc', after: { id: markerAnchor.id, at: markerAnchor.at }, until },
      (page) => {
        for (const entry of page) {
          if (!beforeBoot(entry) || !countsAsUndistilledActivity(entry)) continue;
          activityCount += 1;
          if (firstActivityAt === undefined) firstActivityAt = entry.at;
          lastActivityAt = entry.at;
        }
      },
    );
    if (activityCount === 0) return null;
  }

  if (firstActivityAt === undefined || lastActivityAt === undefined) return null;

  return {
    lastDistilledAt,
    lastActivityAt,
    firstActivityAt,
    activityCount,
    window: lastDistilledAt === null ? 'newest_entries' : 'since_last_distill',
  };
}

export const DISTILL_GAP_NOTICE_HEAD =
  '[system] 前のセッションの終わりが記憶へ移りきっていない可能性がある。';

// 全文を載せ直さない: 日誌の大きさに比例して最初のターンが重くなり、履歴として resume のたびに運ばれるため
export function describeDistillGap(gap: DistillGap): string {
  const distilled =
    gap.lastDistilledAt === null
      ? '最後に蒸留が成功で終わった記録は、日誌の新しい方から' +
        `${DISTILL_GAP_ACTIVITY_SCAN_LIMIT}件を見た範囲には無かった`
      : `最後に蒸留が成功で終わったのは ${gap.lastDistilledAt}`;

  // 比較は `<=` にする: 前提が崩れても、断りを出す側へ倒すため
  const sameMillisecondNotice =
    gap.lastDistilledAt !== null && gap.firstActivityAt <= gap.lastDistilledAt
      ? '**区間の始まりが蒸留の時刻と同じに見えるのは、日誌の時刻がミリ秒までしか' +
        '無いためである。**数えているのは時刻ではなく日誌の並びで、成功の印そのものより' +
        '後ろに積まれた行だけを数えている（印と同じミリ秒でも、印より前に積まれた行は' +
        '数えていない）。'
      : '';

  return [
    DISTILL_GAP_NOTICE_HEAD,
    `${distilled}。それより後、この器が起きるまでのあいだに、` +
      `記憶へ移された記録の無い活動が ${gap.activityCount} 件ある` +
      `（${gap.firstActivityAt} 〜 ${gap.lastActivityAt}）。` +
      sameMillisecondNotice,
    '',
    '**これは「蒸留を始めた」ではなく「蒸留が成功で終わった」記録で数えている。**' +
      '前のプロセスが蒸留の途中で消えたか、蒸留が失敗して終わったか、そもそも走らなかった、' +
      'のいずれかである。この区間の出来事は**記憶（正本）には入っていない**' +
      '（前のセッションを引き継いで開き直していれば会話の履歴には残っているかもしれないが、' +
      'それは記憶ではない）。',
    '',
    `中身は日誌に在る。\`journal_read\` に \`since\`（${gap.firstActivityAt}）と ` +
      `\`until\`（${gap.lastActivityAt}）を渡せばその区間だけを読める。` +
      '記憶へ移すべきものが在れば `memory_write` / `memory_append` で移すこと' +
      '（既存の文書を `memory_write` で書き直すときは、先に `memory_read` で読んで `base_version` を渡すこと）。',
  ].join('\n');
}
