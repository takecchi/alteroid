import { DAEMON_TOKEN_POOL_REOPENED_SOURCE } from './clone.js';
import { compareIsoInstant } from './iso-instant.js';
import type { InboxEvent } from './schema.js';

export type RestoredInboxEventVerdict = 'live' | 'stale';

// `usageBlocked` を受け取らない: 評価した瞬間のタイミングで消えたり残ったりし、「まだ要る」と「消し損ねた」を区別できなくなるため
export function restoredInboxEventVerdict(event: InboxEvent): RestoredInboxEventVerdict {
  switch (event.type) {
    case 'external':
      // `type` だけで括らない: `source` で性質が割れ、自由文字列の `source` は中身を知らない以上要らないとは言えないため
      return event.source === DAEMON_TOKEN_POOL_REOPENED_SOURCE ? 'stale' : 'live';
    case 'human_message':
    case 'human_answer':
    case 'manager_message':
    case 'timer':
    case 'self_initiative':
    case 'distill':
      return 'live';
    default: {
      const exhaustive: never = event;
      throw new Error(`未知の受信箱イベント種別（staleness）: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// `restoredInboxEventVerdict` に統合しない: あちらは合図だけで答える純関数で、こちらはストアの状態を材料にするため
export function completedTimerRoundVerdict(
  event: InboxEvent,
  lastScheduledRunAt: string | undefined,
): RestoredInboxEventVerdict {
  if (event.type !== 'timer' || event.cause === 'manual') return 'live';
  // 枠保持の印のある行は畳まない: 永続状態は完了済みと同じ見た目だが、走っていないため
  if (event.heldForUsage === true) return 'live';
  if (lastScheduledRunAt === undefined) return 'live';
  return compareIsoInstant(event.at, lastScheduledRunAt) <= 0 ? 'stale' : 'live';
}
