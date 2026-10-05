import { describe, expect, it } from 'vitest';

import {
  pruneRescueLedger,
  RESCUE_GRACE_MS,
  RESCUE_LEDGER_NOTHING_KEEP_MS,
  RESCUE_LEDGER_REMOVED_KEEP_MS,
  RESCUE_RETRY_BASE_MS,
  RESCUE_RETRY_MAX_MS,
  rescueRemovalDue,
  rescueRetryAfterMs,
} from './rescue-cleanup.js';
import type { Job, LastRescue, RescueWorktree } from './schema.js';

/** 後始末の判定（Issue #1266）。純関数なので時刻を直に渡す。 */
const NOW = Date.parse('2026-10-20T00:00:00.000Z');
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();
const DAY = 24 * 60 * 60_000;

function tree(pushed: Partial<NonNullable<RescueWorktree['pushed']>> | null): RescueWorktree {
  return {
    relativePath: '.',
    branch: 'main',
    at: iso(-DAY),
    ...(pushed === null
      ? {}
      : {
          pushed: {
            ref: 'refs/alteroid-rescue/m/root-0000abcd',
            commit: 'a'.repeat(40),
            at: iso(-DAY),
            remote: 'https://github.com/o/r.git',
            ...pushed,
          },
        }),
  };
}

describe('退避 ref の後始末の判定（#1266）', () => {
  describe('終端の猶予', () => {
    const grace = RESCUE_GRACE_MS;
    it.each([
      ['done', grace.done],
      ['failed', grace.failed],
      ['stopped', grace.stopped],
    ] as const)('%s は猶予の手前では消さず、過ぎたら理由つきで消す', (status, ms) => {
      expect(rescueRemovalDue(status, iso(-(ms - 1)), tree({}), NOW)).toBeUndefined();
      expect(rescueRemovalDue(status, iso(-ms), tree({}), NOW)).toBe(status);
    });

    it('猶予は done < failed = stopped（done は待機で話しかければ続く。失敗・停止は取り戻しに来る）', () => {
      expect(grace.done).toBe(3 * DAY);
      expect(grace.failed).toBe(14 * DAY);
      expect(grace.stopped).toBe(14 * DAY);
    });

    it('lost は何日放置されても時間では消さない', () => {
      expect(rescueRemovalDue('lost', iso(-365 * DAY), tree({}), NOW)).toBeUndefined();
    });

    it('running / waiting_human は時間では消さない', () => {
      for (const status of ['running', 'waiting_human'] as const) {
        expect(rescueRemovalDue(status, iso(-365 * DAY), tree({}), NOW)).toBeUndefined();
      }
    });

    it('lastRescue.at が読めなければ判定しない（消さない）', () => {
      expect(rescueRemovalDue('failed', 'not-a-date', tree({}), NOW)).toBeUndefined();
    });

    it('退避された ref が無い項目は消すものが無い', () => {
      expect(rescueRemovalDue('failed', iso(-365 * DAY), tree(null), NOW)).toBeUndefined();
    });
  });

  describe('内容が origin に入った', () => {
    it('landedAt があれば、状態によらず（lost も running も）即座に消す', () => {
      for (const status of [
        'running',
        'waiting_human',
        'done',
        'failed',
        'lost',
        'stopped',
      ] as const) {
        expect(rescueRemovalDue(status, iso(0), tree({ landedAt: iso(-1000) }), NOW)).toBe(
          'landed',
        );
      }
    });
  });

  describe('記録と再試行', () => {
    it('消した記録があれば二度と消さない', () => {
      const t = tree({ landedAt: iso(-1000), removal: { at: iso(-1), reason: 'landed' } });
      expect(rescueRemovalDue('failed', iso(-365 * DAY), t, NOW)).toBeUndefined();
    });

    it('消せなかった回は、間隔（回数で倍々、上限つき）が空くまで撃たない', () => {
      const failed = (attempts: number, ago: number) =>
        tree({
          landedAt: iso(-5000),
          removal: { at: iso(-ago), reason: 'landed', failureKind: 'network', attempts },
        });
      expect(
        rescueRemovalDue('done', iso(0), failed(1, RESCUE_RETRY_BASE_MS - 1), NOW),
      ).toBeUndefined();
      expect(rescueRemovalDue('done', iso(0), failed(1, RESCUE_RETRY_BASE_MS), NOW)).toBe('landed');
      expect(
        rescueRemovalDue('done', iso(0), failed(3, RESCUE_RETRY_BASE_MS * 3), NOW),
      ).toBeUndefined();
      expect(rescueRemovalDue('done', iso(0), failed(3, RESCUE_RETRY_BASE_MS * 4), NOW)).toBe(
        'landed',
      );
      expect(rescueRetryAfterMs(1000)).toBe(RESCUE_RETRY_MAX_MS);
      expect(rescueRetryAfterMs(0)).toBe(RESCUE_RETRY_BASE_MS);
    });

    it('再試行のとき、猶予が過ぎていなければ（landed でもなければ）消さない', () => {
      const t = tree({
        removal: { at: iso(-DAY), reason: 'failed', failureKind: 'auth', attempts: 1 },
      });
      expect(rescueRemovalDue('failed', iso(-DAY), t, NOW)).toBeUndefined();
    });
  });

  describe('台帳の片付け（C3）', () => {
    const rescue = (at: string, worktrees: RescueWorktree[]): LastRescue => ({ at, worktrees });
    const removed = (agoMs: number) => tree({ removal: { at: iso(-agoMs), reason: 'done' } });

    it('消して一定期間が過ぎた項目と、退避の無い古い項目を落とす', () => {
      const keepRemovedMs = RESCUE_LEDGER_REMOVED_KEEP_MS;
      const quiet = iso(-keepRemovedMs);
      const out = pruneRescueLedger(
        'done',
        rescue(quiet, [removed(keepRemovedMs), removed(keepRemovedMs - 1000)]),
        NOW,
      );
      expect(out?.worktrees).toHaveLength(1);
      expect(
        pruneRescueLedger('done', rescue(iso(-RESCUE_LEDGER_NOTHING_KEEP_MS), [tree(null)]), NOW),
      ).toBeUndefined();
    });

    it('消せなかった記録・まだ消していない ref は残す', () => {
      const t1 = tree({ removal: { at: iso(-90 * DAY), reason: 'failed', failureKind: 'auth' } });
      const t2 = tree({});
      expect(pruneRescueLedger('failed', rescue(iso(-90 * DAY), [t1, t2]), NOW)).toBeNull();
    });

    it('running / waiting_human の台帳には触らない', () => {
      for (const status of ['running', 'waiting_human'] as const) {
        expect(
          pruneRescueLedger(status, rescue(iso(-90 * DAY), [removed(90 * DAY)]), NOW),
        ).toBeNull();
      }
    });

    it('退避の無い項目は、猶予の手前なら残す', () => {
      expect(
        pruneRescueLedger(
          'lost',
          rescue(iso(-(RESCUE_LEDGER_NOTHING_KEEP_MS - 1)), [tree(null)]),
          NOW,
        ),
      ).toBeNull();
    });
  });
});

// 型の確認（Job['status'] を網羅していること）。
const _statuses: Job['status'][] = [
  'running',
  'waiting_human',
  'done',
  'failed',
  'lost',
  'stopped',
];
void _statuses;
