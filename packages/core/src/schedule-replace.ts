import { describeScheduleSpec } from './schedule.js';
import type { JournalEntryInput, ScheduledRequest, ScheduleSpec } from './schema.js';

/**
 * 既存の kind を置き換える直前に、日誌へ先に残す行（旧本文・旧周期を逐語で持つ）。
 *
 * 置き換えると旧本文・旧周期は行から消えるので、書き込みの前にこの行を日誌へ書き、書けなければ置き換えない。
 * クローンの道具 `schedule_create` と人間の `POST /schedule` が同じ書式を使う（`actor` だけが違う）。
 * 印（humanAction）は持たない: 置き換えが効かなかった回に、クローンへ「人間がした」と学ばせないため。
 */
export function scheduleReplaceEntry(params: {
  readonly kind: string;
  readonly previous: Pick<ScheduledRequest, 'request' | 'spec'>;
  readonly next: { readonly request: string; readonly spec: ScheduleSpec };
  /** 行頭に付ける主語。道具は空、人間の入口は「人間が」。 */
  readonly actor?: string;
}): JournalEntryInput {
  const { kind, previous, next, actor = '' } = params;
  return {
    type: 'decision',
    decision:
      `${actor}定期の依頼を置き換えようとしている: ${kind}: ` +
      `置き換え前（${describeScheduleSpec(previous.spec)}）「${previous.request}」→ ` +
      `置き換え後（${describeScheduleSpec(next.spec)}）「${next.request}」`,
    grounds: '同じ kind の依頼を置き換える判断（置き換え前の本文と周期は日誌に残す）',
  };
}
