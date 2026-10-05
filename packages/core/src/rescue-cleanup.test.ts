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
  syncTerminalMark,
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

/** `at`（runner から最後に届いた時刻）と、終端を初めて見た時刻（`terminalSeen`）。 */
function rescue(
  atAgo: number,
  terminal?: { status: 'done' | 'failed' | 'stopped'; seenAgo: number },
  worktrees: RescueWorktree[] = [tree({})],
): LastRescue {
  return {
    at: iso(-atAgo),
    worktrees,
    ...(terminal === undefined
      ? {}
      : { terminal: { status: terminal.status, seenAt: iso(-terminal.seenAgo) } }),
  };
}

describe('退避 ref の後始末の判定（#1266）', () => {
  describe('終端の猶予', () => {
    const grace = RESCUE_GRACE_MS;
    it.each([
      ['done', grace.done],
      ['failed', grace.failed],
      ['stopped', grace.stopped],
    ] as const)(
      '%s は猶予の手前では消さず、過ぎたら理由つきで消す（起点は終端を見た時刻）',
      (status, ms) => {
        const wt = tree({});
        const before = rescue(ms + DAY, { status, seenAgo: ms - 1 }, [wt]);
        const after = rescue(ms + DAY, { status, seenAgo: ms }, [wt]);
        expect(rescueRemovalDue(status, before, wt, NOW)).toBeUndefined();
        expect(rescueRemovalDue(status, after, wt, NOW)).toBe(status);
      },
    );

    it('猶予は done 7日 < failed = stopped 14日（done は週末をまたいでも残す）', () => {
      expect(grace.done).toBe(7 * DAY);
      expect(grace.failed).toBe(14 * DAY);
      expect(grace.stopped).toBe(14 * DAY);
    });

    it('lost のまま20日放置→stopped になった直後は、猶予ゼロでは消さない（起点は終端を見た時刻）', () => {
      const wt = tree({});
      // lastRescue.at は20日前で止まっているが、stopped を見たのはいまさっき。
      const justStopped = rescue(20 * DAY, { status: 'stopped', seenAgo: 1000 }, [wt]);
      expect(rescueRemovalDue('stopped', justStopped, wt, NOW)).toBeUndefined();
    });

    it('終端を見ていない（印が無い）ものは消さない。別の状態の印も使わない', () => {
      const wt = tree({});
      expect(
        rescueRemovalDue('failed', rescue(400 * DAY, undefined, [wt]), wt, NOW),
      ).toBeUndefined();
      const doneMark = rescue(400 * DAY, { status: 'done', seenAgo: 400 * DAY }, [wt]);
      expect(rescueRemovalDue('failed', doneMark, wt, NOW)).toBeUndefined();
    });

    it('lastRescue.at が新しければ（生きたセッション）そちらを起点にする', () => {
      const wt = tree({});
      const live = rescue(DAY, { status: 'done', seenAgo: 30 * DAY }, [wt]);
      expect(rescueRemovalDue('done', live, wt, NOW)).toBeUndefined();
    });

    it('lost は何日放置されても時間では消さない', () => {
      const wt = tree({});
      expect(rescueRemovalDue('lost', rescue(365 * DAY, undefined, [wt]), wt, NOW)).toBeUndefined();
    });

    it('running / waiting_human は時間では消さない', () => {
      const wt = tree({});
      for (const status of ['running', 'waiting_human'] as const) {
        expect(
          rescueRemovalDue(status, rescue(365 * DAY, undefined, [wt]), wt, NOW),
        ).toBeUndefined();
      }
    });

    it('時刻が読めなければ判定しない（消さない）', () => {
      const wt = tree({});
      const broken = {
        ...rescue(400 * DAY, { status: 'failed', seenAgo: 400 * DAY }, [wt]),
        at: 'x',
      };
      expect(rescueRemovalDue('failed', broken, wt, NOW)).toBeUndefined();
    });

    it('退避された ref が無い項目は消すものが無い', () => {
      const wt = tree(null);
      const r = rescue(365 * DAY, { status: 'failed', seenAgo: 365 * DAY }, [wt]);
      expect(rescueRemovalDue('failed', r, wt, NOW)).toBeUndefined();
    });
  });

  describe('終端の印', () => {
    it('終端で印が無ければ付け、同じ状態なら動かさず、別の終端なら作り直す', () => {
      const base = rescue(DAY);
      const marked = syncTerminalMark('stopped', base, iso(0));
      expect(marked?.terminal).toEqual({ status: 'stopped', seenAt: iso(0) });
      expect(syncTerminalMark('stopped', marked as LastRescue, iso(5000))).toBeNull();
      expect(syncTerminalMark('failed', marked as LastRescue, iso(5000))?.terminal).toEqual({
        status: 'failed',
        seenAt: iso(5000),
      });
    });

    it('終端でなくなったら（lost・running へ戻った）外す。印の無い非終端は何もしない', () => {
      const marked = rescue(DAY, { status: 'done', seenAgo: DAY });
      for (const status of ['lost', 'running', 'waiting_human'] as const) {
        expect(syncTerminalMark(status, marked, iso(0))?.terminal).toBeUndefined();
        expect(syncTerminalMark(status, rescue(DAY), iso(0))).toBeNull();
      }
    });
  });

  describe('内容が origin に入った', () => {
    it('landedAt があれば、状態によらず（lost も running も・印が無くても）即座に消す', () => {
      const wt = tree({ landedAt: iso(-1000) });
      for (const status of [
        'running',
        'waiting_human',
        'done',
        'failed',
        'lost',
        'stopped',
      ] as const) {
        expect(rescueRemovalDue(status, rescue(0, undefined, [wt]), wt, NOW)).toBe('landed');
      }
    });
  });

  describe('記録と再試行', () => {
    it('消した記録があれば二度と消さない', () => {
      const wt = tree({ landedAt: iso(-1000), removal: { at: iso(-1), reason: 'landed' } });
      expect(rescueRemovalDue('failed', rescue(0, undefined, [wt]), wt, NOW)).toBeUndefined();
    });

    it('消せなかった回は、間隔（回数で倍々、上限つき）が空くまで撃たない', () => {
      const failed = (attempts: number, ago: number) =>
        tree({
          landedAt: iso(-5000),
          removal: { at: iso(-ago), reason: 'landed', failureKind: 'network', attempts },
        });
      const due = (wt: RescueWorktree) =>
        rescueRemovalDue('done', rescue(0, undefined, [wt]), wt, NOW);
      expect(due(failed(1, RESCUE_RETRY_BASE_MS - 1))).toBeUndefined();
      expect(due(failed(1, RESCUE_RETRY_BASE_MS))).toBe('landed');
      expect(due(failed(3, RESCUE_RETRY_BASE_MS * 3))).toBeUndefined();
      expect(due(failed(3, RESCUE_RETRY_BASE_MS * 4))).toBe('landed');
      expect(rescueRetryAfterMs(1000)).toBe(RESCUE_RETRY_MAX_MS);
      expect(rescueRetryAfterMs(0)).toBe(RESCUE_RETRY_BASE_MS);
    });

    it('送り先が台帳に無い（no-remote）は確定扱い。何日たっても再試行しない', () => {
      const wt = tree({
        landedAt: iso(-5000),
        removal: { at: iso(-300 * DAY), reason: 'landed', failureKind: 'no-remote', attempts: 1 },
      });
      expect(rescueRemovalDue('done', rescue(0, undefined, [wt]), wt, NOW)).toBeUndefined();
    });

    it('再試行のとき、猶予が過ぎていなければ（landed でもなければ）消さない', () => {
      const wt = tree({
        removal: { at: iso(-DAY), reason: 'failed', failureKind: 'auth', attempts: 1 },
      });
      const r = rescue(DAY, { status: 'failed', seenAgo: DAY }, [wt]);
      expect(rescueRemovalDue('failed', r, wt, NOW)).toBeUndefined();
    });
  });

  describe('台帳の片付け（C3）', () => {
    const removed = (agoMs: number) => tree({ removal: { at: iso(-agoMs), reason: 'done' } });

    it('消して一定期間が過ぎた項目と、退避の無い古い項目を落とす', () => {
      const keepRemovedMs = RESCUE_LEDGER_REMOVED_KEEP_MS;
      const out = pruneRescueLedger(
        'done',
        rescue(keepRemovedMs, undefined, [removed(keepRemovedMs), removed(keepRemovedMs - 1000)]),
        NOW,
      );
      expect(out?.worktrees).toHaveLength(1);
      expect(
        pruneRescueLedger(
          'done',
          rescue(RESCUE_LEDGER_NOTHING_KEEP_MS, undefined, [tree(null)]),
          NOW,
        ),
      ).toBeUndefined();
    });

    it('消せなかった記録・まだ消していない ref は残す', () => {
      const t1 = tree({ removal: { at: iso(-90 * DAY), reason: 'failed', failureKind: 'auth' } });
      const t2 = tree({});
      expect(pruneRescueLedger('failed', rescue(90 * DAY, undefined, [t1, t2]), NOW)).toBeNull();
    });

    it('running / waiting_human の台帳には触らない', () => {
      for (const status of ['running', 'waiting_human'] as const) {
        expect(
          pruneRescueLedger(status, rescue(90 * DAY, undefined, [removed(90 * DAY)]), NOW),
        ).toBeNull();
      }
    });

    it('退避の無い項目は、猶予の手前なら残す', () => {
      expect(
        pruneRescueLedger(
          'lost',
          rescue(RESCUE_LEDGER_NOTHING_KEEP_MS - 1, undefined, [tree(null)]),
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
