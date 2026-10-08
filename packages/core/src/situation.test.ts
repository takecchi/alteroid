import { describe, expect, it } from 'vitest';

import {
  INBOX_BACKLOG_LOUD_THRESHOLD,
  summarizeInboxBacklog,
  type InboxBacklogBreakdown,
} from './inbox-backlog.js';
import type { ManagerSummary } from './manager.js';
import type { RunnerLiveness } from './runner-protocol.js';
import type { InboxEvent, JobStatus } from './schema.js';
import {
  countManagerSituation,
  countRecentManagerStarts,
  countRunnerStates,
  describeSituation,
  describeSituationUnavailable,
  describeTokenSituation,
  latestManagerStartAt,
  RECENT_MANAGER_START_WINDOW_MS,
} from './situation.js';

function summary(
  id: string,
  status: JobStatus,
  live: boolean,
  awaitingBackground?: { tasks: number; withheldReports: number; breakdown: string; since: string },
): ManagerSummary {
  return {
    managerId: id,
    status,
    live,
    cwd: '/work',
    request: '依頼',
    startedAt: '2026-09-05T00:00:00.000Z',
    updatedAt: '2026-09-05T00:00:00.000Z',
    waiting: [],
    ...(awaitingBackground === undefined ? {} : { awaitingBackground }),
  };
}

const BG = {
  tasks: 3,
  withheldReports: 1,
  breakdown: 'local_agent×3',
  since: '2026-09-05T00:00:00.000Z',
};

const FAILURE = {
  code: 'api_error_status/429',
  via: 'result',
  at: '2026-09-18T08:20:00.000Z',
};

function withLastFailure(manager: ManagerSummary): ManagerSummary {
  return { ...manager, lastFailure: FAILURE };
}

const USAGE_STOPPED_AT = '2026-09-19T09:00:00.000Z';
function withUsageStopped(manager: ManagerSummary): ManagerSummary {
  return { ...manager, usageStoppedAt: USAGE_STOPPED_AT };
}

function withRunnerVanished(manager: ManagerSummary): ManagerSummary {
  return { ...manager, runnerVanished: true };
}

describe('countManagerSituation', () => {
  it('done は「手が空いている」と「背景処理待ち」に割れる（status だけでは割れない）', () => {
    const counts = countManagerSituation([
      summary('a', 'done', true),
      summary('b', 'done', true, BG),
    ]);
    expect(counts.idle).toBe(1);
    expect(counts.awaitingBackground).toBe(1);
  });

  it('背景処理待ちは running/waiting_human より先に数える', () => {
    const counts = countManagerSituation([
      summary('a', 'running', true, BG),
      summary('b', 'waiting_human', true, BG),
    ]);
    expect(counts.awaitingBackground).toBe(2);
    expect(counts.running).toBe(0);
    expect(counts.waitingHuman).toBe(0);
  });

  it('⭐ 6つの区分は分割で、合計は total に一致する（JobStatus 6値すべてを通す）', () => {
    const statuses: JobStatus[] = ['running', 'waiting_human', 'done', 'failed', 'lost', 'stopped'];
    const managers = [
      ...statuses.map((status, index) => summary(`live-${index}`, status, true)),
      ...statuses.map((status, index) => summary(`dead-${index}`, status, false)),
      summary('bg', 'done', true, BG),
    ];
    const counts = countManagerSituation(managers);
    expect(counts.total).toBe(13);
    expect(
      counts.running +
        counts.waitingHuman +
        counts.awaitingBackground +
        counts.idle +
        counts.lost +
        counts.other,
    ).toBe(counts.total);
    expect(counts.running).toBe(2);
    expect(counts.waitingHuman).toBe(2);
    expect(counts.awaitingBackground).toBe(1);
    expect(counts.idle).toBe(1);
    expect(counts.lost).toBe(2);
    expect(counts.other).toBe(5);
  });

  it('⭐ lost は other から分かれた（other が減り、lost が増える）', () => {
    const withoutLost = countManagerSituation([summary('a', 'failed', false)]);
    const withLost = countManagerSituation([
      summary('a', 'failed', false),
      summary('b', 'lost', false),
    ]);
    expect(withoutLost.lost).toBe(0);
    expect(withoutLost.other).toBe(1);
    expect(withLost.other).toBe(1);
    expect(withLost.lost).toBe(1);
    expect(withLost.total).toBe(2);
  });

  it('背景処理待ちの印が立っていれば、lost でも「背景処理待ち」に数える', () => {
    const counts = countManagerSituation([summary('a', 'lost', false, BG)]);
    expect(counts.awaitingBackground).toBe(1);
    expect(counts.lost).toBe(0);
    expect(counts.awaitingBackground + counts.lost + counts.other).toBe(counts.total);
  });

  it('reachable は5つの区分と重なる（横断する軸である）', () => {
    const counts = countManagerSituation([
      summary('a', 'running', true),
      summary('b', 'waiting_human', true),
      summary('c', 'done', false),
    ]);
    expect(counts.reachable).toBe(2);
    expect(counts.idle).toBe(0);
  });

  it('1本も居なければ全部0で、total も0である', () => {
    const counts = countManagerSituation([]);
    expect(counts).toEqual({
      total: 0,
      running: 0,
      waitingHuman: 0,
      awaitingBackground: 0,
      idle: 0,
      lost: 0,
      other: 0,
      reachable: 0,
      lastTurnFailed: 0,
      lastTurnFailedIdle: 0,
      usageStopped: 0,
      usageStoppedIdle: 0,
      runnerVanished: 0,
    });
  });

  it('⭐ 直近のターンが失敗で終わった done は idle からも数えられる（区分ではなく横断する軸）', () => {
    const counts = countManagerSituation([
      withLastFailure(summary('a', 'done', true)),
      summary('b', 'done', true),
    ]);
    expect(counts.idle).toBe(2);
    expect(counts.lastTurnFailed).toBe(1);
    expect(counts.lastTurnFailedIdle).toBe(1);
    expect(
      counts.running +
        counts.waitingHuman +
        counts.awaitingBackground +
        counts.idle +
        counts.lost +
        counts.other,
    ).toBe(counts.total);
  });

  it('⭐ 走行中・返事待ち・lost に残った lastFailure は、idle の内訳には数えない', () => {
    const counts = countManagerSituation([
      withLastFailure(summary('a', 'running', true)),
      withLastFailure(summary('b', 'waiting_human', true)),
      withLastFailure(summary('c', 'lost', false)),
      withLastFailure(summary('d', 'done', true)),
    ]);
    expect(counts.lastTurnFailed).toBe(4);
    expect(counts.lastTurnFailedIdle).toBe(1);
  });

  it('背景処理待ちへ落ちた委譲でも lastTurnFailed には数え、idle の内訳には数えない', () => {
    const counts = countManagerSituation([withLastFailure(summary('a', 'done', true, BG))]);
    expect(counts.awaitingBackground).toBe(1);
    expect(counts.idle).toBe(0);
    expect(counts.lastTurnFailed).toBe(1);
    expect(counts.lastTurnFailedIdle).toBe(0);
  });

  it('⭐ 枠で止まった done は idle からも数えられる（区分ではなく横断する軸）', () => {
    const counts = countManagerSituation([
      withUsageStopped(summary('a', 'done', true)),
      summary('b', 'done', true),
    ]);
    expect(counts.idle).toBe(2);
    expect(counts.usageStopped).toBe(1);
    expect(counts.usageStoppedIdle).toBe(1);
    expect(
      counts.running +
        counts.waitingHuman +
        counts.awaitingBackground +
        counts.idle +
        counts.lost +
        counts.other,
    ).toBe(counts.total);
  });

  it('⭐ 走行中・返事待ち・lost に残った usageStoppedAt は、idle の内訳には数えない', () => {
    const counts = countManagerSituation([
      withUsageStopped(summary('a', 'running', true)),
      withUsageStopped(summary('b', 'waiting_human', true)),
      withUsageStopped(summary('c', 'lost', false)),
      withUsageStopped(summary('d', 'done', true)),
    ]);
    expect(counts.usageStopped).toBe(4);
    expect(counts.usageStoppedIdle).toBe(1);
  });

  it('背景処理待ちへ落ちた委譲でも usageStopped には数え、idle の内訳には数えない', () => {
    const counts = countManagerSituation([withUsageStopped(summary('a', 'done', true, BG))]);
    expect(counts.awaitingBackground).toBe(1);
    expect(counts.idle).toBe(0);
    expect(counts.usageStopped).toBe(1);
    expect(counts.usageStoppedIdle).toBe(0);
  });

  it('⭐ 同じ委譲が usageStopped と lastTurnFailed の両方に数えられる（排他にしない）', () => {
    const counts = countManagerSituation([
      withUsageStopped(withLastFailure(summary('a', 'done', true))),
    ]);
    expect(counts.usageStopped).toBe(1);
    expect(counts.lastTurnFailed).toBe(1);
    expect(counts.usageStoppedIdle).toBe(1);
    expect(counts.lastTurnFailedIdle).toBe(1);
  });

  it('⭐ 走行中の委譲では usageStopped だけが立ち、lastTurnFailed は立たないことがある', () => {
    const counts = countManagerSituation([withUsageStopped(summary('a', 'running', true))]);
    expect(counts.usageStopped).toBe(1);
    expect(counts.lastTurnFailed).toBe(0);
  });

  it('⭐ running のまま宛先が消えた委譲は running としても runnerVanished としても数えられる（区分ではなく横断する軸）', () => {
    const counts = countManagerSituation([
      withRunnerVanished(summary('a', 'running', true)),
      summary('b', 'running', true),
    ]);
    expect(counts.running).toBe(2);
    expect(counts.runnerVanished).toBe(1);
    expect(
      counts.running +
        counts.waitingHuman +
        counts.awaitingBackground +
        counts.idle +
        counts.lost +
        counts.other,
    ).toBe(counts.total);
  });

  it('⭐ runnerVanished が無ければ runnerVanished は増えない', () => {
    const counts = countManagerSituation([summary('a', 'running', true)]);
    expect(counts.runnerVanished).toBe(0);
  });
});

describe('countRecentManagerStarts（#1103 案1）', () => {
  const AT = Date.parse('2026-09-16T14:51:00.000Z');

  function startedMsAgo(msAgo: number): ManagerSummary {
    return { ...summary('x', 'running', true), startedAt: new Date(AT - msAgo).toISOString() };
  }

  it('窓の中の開始だけを数える（窓の外の開始は数えない＝陽性対照）', () => {
    const managers = [
      startedMsAgo(60 * 60 * 1000),
      startedMsAgo(2 * 60 * 60 * 1000),
      startedMsAgo(4 * 60 * 60 * 1000),
    ];
    expect(countRecentManagerStarts(managers, AT)).toBe(2);
  });

  it('窓の中が0本なら0を返す', () => {
    const managers = [startedMsAgo(4 * 60 * 60 * 1000)];
    expect(countRecentManagerStarts(managers, AT)).toBe(0);
  });

  it('1本も居なければ0を返す', () => {
    expect(countRecentManagerStarts([], AT)).toBe(0);
  });

  it('境界（ちょうど3時間前）は含む', () => {
    const managers = [startedMsAgo(RECENT_MANAGER_START_WINDOW_MS)];
    expect(countRecentManagerStarts(managers, AT)).toBe(1);
  });

  it('境界のすぐ外（3時間 + 1ms 前）は含まない', () => {
    const managers = [startedMsAgo(RECENT_MANAGER_START_WINDOW_MS + 1)];
    expect(countRecentManagerStarts(managers, AT)).toBe(0);
  });

  it('ちょうど観測時刻 at に開始したものも含む', () => {
    const managers = [startedMsAgo(0)];
    expect(countRecentManagerStarts(managers, AT)).toBe(1);
  });

  it('startedAt が壊れている・解釈できない委譲は数えない', () => {
    const managers = [{ ...summary('a', 'running', true), startedAt: 'not-a-date' }];
    expect(countRecentManagerStarts(managers, AT)).toBe(0);
  });
});

describe('latestManagerStartAt（#1103 コメント 2026-09-27）', () => {
  const AT = Date.parse('2026-09-16T14:51:00.000Z');

  function startedMsAgo(msAgo: number): ManagerSummary {
    return { ...summary('x', 'running', true), startedAt: new Date(AT - msAgo).toISOString() };
  }

  it('最大値（いちばん最近の開始）を返す。並び順に依存しない', () => {
    const managers = [
      startedMsAgo(4 * 60 * 60 * 1000),
      startedMsAgo(30 * 60 * 60 * 1000),
      startedMsAgo(60 * 60 * 1000),
    ];
    expect(latestManagerStartAt(managers)).toBe(AT - 60 * 60 * 1000);
  });

  it('1本も居なければ undefined を返す（0 でも -Infinity でもない）', () => {
    expect(latestManagerStartAt([])).toBeUndefined();
  });

  it('startedAt が壊れている委譲は最大値の候補から除く', () => {
    const managers = [
      { ...summary('a', 'running', true), startedAt: 'not-a-date' },
      startedMsAgo(2 * 60 * 60 * 1000),
    ];
    expect(latestManagerStartAt(managers)).toBe(AT - 2 * 60 * 60 * 1000);
  });

  it('全部の startedAt が壊れていれば undefined を返す', () => {
    const managers = [
      { ...summary('a', 'running', true), startedAt: 'not-a-date' },
      { ...summary('b', 'running', true), startedAt: '' },
    ];
    expect(latestManagerStartAt(managers)).toBeUndefined();
  });
});

describe('countRunnerStates', () => {
  it('RunnerLiveness の6値をそれぞれ別に数える', () => {
    const states: RunnerLiveness[] = [
      'connecting',
      'connected',
      'connected',
      'unreachable',
      'unusable',
      'lost',
      'vacating',
    ];
    const byState = countRunnerStates(states.map((state) => ({ state })));
    expect(byState.get('connected')).toBe(2);
    expect(byState.get('connecting')).toBe(1);
    expect(byState.get('unreachable')).toBe(1);
    expect(byState.get('unusable')).toBe(1);
    expect(byState.get('lost')).toBe(1);
    expect(byState.get('vacating')).toBe(1);
    expect(byState.size).toBe(6);
  });

  it('居ない state は鍵ごと出さない（0 を作らない）', () => {
    const byState = countRunnerStates([{ state: 'connected' }]);
    expect(byState.has('lost')).toBe(false);
    expect([...byState.keys()]).toEqual(['connected']);
  });
});

describe('describeSituation', () => {
  it('委譲の5区分は 0 でも全部出る（とくに「手が空いている 0」を消さない）', () => {
    const text = describeSituation({
      managers: [summary('a', 'running', true)],
      runners: [{ state: 'connected' }],
    });
    expect(text).toContain('委譲 全 1 本');
    expect(text).toContain('走行中 1');
    expect(text).toContain('返事待ち 0');
    expect(text).toContain('背景処理待ち 0');
    expect(text).toContain('手が空いている 0');
    expect(text).toContain('その他 0');
    expect(text).toContain('話しかけられるのは 1 本');
  });

  it('数えた本数がそのまま出る（背景処理待ちと手が空いているを取り違えない）', () => {
    const text = describeSituation({
      managers: [
        summary('a', 'running', true),
        summary('b', 'running', true),
        summary('c', 'running', true),
        summary('d', 'waiting_human', true),
        summary('e', 'waiting_human', true),
        summary('f', 'waiting_human', true),
        summary('g', 'waiting_human', true),
        summary('h', 'done', true, BG),
        summary('i', 'done', true, BG),
        summary('j', 'done', true),
        summary('k0', 'lost', false),
        summary('k1', 'lost', false),
        summary('k2', 'lost', false),
        summary('k3', 'lost', false),
        summary('k4', 'lost', false),
        summary('l0', 'failed', false),
        summary('l1', 'failed', false),
        summary('l2', 'failed', false),
        summary('l3', 'stopped', false),
        summary('l4', 'stopped', false),
        summary('l5', 'done', false),
      ],
      runners: [],
    });
    expect(text).toContain('委譲 全 21 本');
    expect(text).toContain('走行中 3');
    expect(text).toContain('返事待ち 4');
    expect(text).toContain('背景処理待ち 2');
    expect(text).toContain('手が空いている 1');
    expect(text).toContain('戻れなかった(lost) 5');
    expect(text).toContain('その他 6');
    expect(text).toContain('話しかけられるのは 10 本');
  });

  it('⭐ lost が在れば本数と、リモートを確かめる順序と、名指しの引き方が出る', () => {
    const text = describeSituation({
      managers: [summary('a', 'lost', false), summary('b', 'running', true)],
      runners: [],
    });
    expect(text).toContain('戻れなかった(lost) 1');
    expect(text).toContain('成果の有無は1度も観測していない');
    expect(text).toContain('status: ["lost"]');
    expect(text).toContain('`manager_start` で起こし直さないこと');
  });

  it('⭐ lost が 0 のときは行も断り書きも1文字も出ない（0 の行を作らない）', () => {
    const text = describeSituation({
      managers: [summary('a', 'running', true), summary('b', 'failed', false)],
      runners: [],
    });
    expect(text).not.toContain('戻れなかった(lost)');
    expect(text).not.toContain('成果の有無は1度も観測していない');
    expect(text).toContain('委譲 全 2 本');
    expect(text).toContain('走行中 1');
    expect(text).toContain('返事待ち 0');
    expect(text).toContain('背景処理待ち 0');
    expect(text).toContain('手が空いている 0');
    expect(text).toContain('その他 1');
  });

  it('⭐ 直近3時間に起こした委譲の本数が委譲の行に出る（窓の外は数えない）', () => {
    const AT = Date.parse('2026-09-16T14:51:00.000Z');
    const text = describeSituation({
      managers: [
        {
          ...summary('a', 'running', true),
          startedAt: new Date(AT - 60 * 60 * 1000).toISOString(),
        },
        {
          ...summary('b', 'waiting_human', true),
          startedAt: new Date(AT - 2.5 * 60 * 60 * 1000).toISOString(),
        },
        {
          ...summary('c', 'done', true),
          startedAt: new Date(AT - 4 * 60 * 60 * 1000).toISOString(),
        },
      ],
      runners: [],
      at: AT,
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).toContain('直近3時間に新しく起こした委譲: 2 本');
  });

  it('⭐ 直近3時間の開始が0本でも「0 本」と出る（行が消えない）', () => {
    const AT = Date.parse('2026-09-16T14:51:00.000Z');
    const text = describeSituation({
      managers: [
        {
          ...summary('a', 'running', true),
          startedAt: new Date(AT - 4 * 60 * 60 * 1000).toISOString(),
        },
      ],
      runners: [],
      at: AT,
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).toContain('直近3時間に新しく起こした委譲: 0 本');
  });

  it('⭐ 0 本のときも、最後に起こした経過が括弧で添えられる（issue本文の実測どおり）', () => {
    const AT = Date.parse('2026-09-16T14:51:00.000Z');
    const LAST_START = Date.parse('2026-09-16T10:15:00.000Z');
    const text = describeSituation({
      managers: [{ ...summary('a', 'done', true), startedAt: new Date(LAST_START).toISOString() }],
      runners: [],
      at: AT,
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).toContain(
      '直近3時間に新しく起こした委譲: 0 本（最後に起こしたのは 4時間36分前）。',
    );
  });

  it('⭐ 1本以上のときも、最後に起こした経過が括弧で添えられる（分だけの粒度）', () => {
    const AT = Date.parse('2026-09-16T14:51:00.000Z');
    const text = describeSituation({
      managers: [
        {
          ...summary('a', 'running', true),
          startedAt: new Date(AT - 12 * 60 * 1000).toISOString(),
        },
        {
          ...summary('b', 'running', true),
          startedAt: new Date(AT - 30 * 60 * 1000).toISOString(),
        },
      ],
      runners: [],
      at: AT,
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).toContain(
      '直近3時間に新しく起こした委譲: 2 本（最後に起こしたのは 12分前）。',
    );
  });

  it('⭐ 最後の開始が1分未満前なら「1分未満前」と出る', () => {
    const AT = Date.parse('2026-09-16T14:51:00.000Z');
    const text = describeSituation({
      managers: [
        { ...summary('a', 'running', true), startedAt: new Date(AT - 30 * 1000).toISOString() },
      ],
      runners: [],
      at: AT,
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).toContain(
      '直近3時間に新しく起こした委譲: 1 本（最後に起こしたのは 1分未満前）。',
    );
  });

  it('⭐ 最後の開始が観測時刻より未来（時計のずれ）でも「1分未満前」に丸まる', () => {
    const AT = Date.parse('2026-09-16T14:51:00.000Z');
    const text = describeSituation({
      managers: [
        {
          ...summary('a', 'running', true),
          startedAt: new Date(AT + 10 * 60 * 1000).toISOString(),
        },
      ],
      runners: [],
      at: AT,
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).toContain('（最後に起こしたのは 1分未満前）。');
  });

  it('⭐ 委譲が0本なら括弧は出ない', () => {
    const AT = Date.parse('2026-09-16T14:51:00.000Z');
    const text = describeSituation({ managers: [], runners: [], at: AT });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).toContain('直近3時間に新しく起こした委譲: 0 本。');
    expect(countsLine).not.toContain('（');
  });

  it('⭐ 全ての startedAt が壊れていれば括弧は出ない（委譲は1本以上居る）', () => {
    const AT = Date.parse('2026-09-16T14:51:00.000Z');
    const text = describeSituation({
      managers: [
        { ...summary('a', 'running', true), startedAt: 'not-a-date' },
        { ...summary('b', 'running', true), startedAt: '' },
      ],
      runners: [],
      at: AT,
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).toContain('直近3時間に新しく起こした委譲: 0 本。');
    expect(countsLine).not.toContain('（');
  });

  it('⭐ 手が空いているの中に「直近のターンが失敗で終わっている」本数が並び、断り書きが出る', () => {
    const text = describeSituation({
      managers: [
        withLastFailure(summary('a', 'done', true)),
        withLastFailure(summary('b', 'done', true)),
        summary('c', 'done', true),
        withLastFailure(summary('d', 'running', true)),
      ],
      runners: [],
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine, '「委譲 全 」の行が見つからない').toBeDefined();
    expect(countsLine).toContain('手が空いている 3');
    expect(countsLine).toContain('直近のターンが失敗で終わっているのは 3 本');
    expect(countsLine).toContain('「手が空いている」に数えたものが 2 本');
    expect(countsLine).toContain('上の区分とは足し合わせない');
    expect(text).toContain('「手が空いている」は「仕事を終えて空いた」を意味しない');
    expect(text).toContain('この軸で絞る綴りは無い');
    expect(text).toContain('`manager_report <managerId>`');
  });

  it('⭐ （陰性対照）lastFailure が無ければ本数も断り書きも1文字も出ない', () => {
    const withFailure = describeSituation({
      managers: [withLastFailure(summary('a', 'done', true))],
      runners: [],
    });
    const withoutFailure = describeSituation({
      managers: [summary('a', 'done', true)],
      runners: [],
    });
    const lineWith = withFailure.split('\n').find((l) => l.startsWith('委譲 全 '));
    const lineWithout = withoutFailure.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(lineWithout, '「委譲 全 」の行が見つからない').toBeDefined();
    expect(lineWith).toContain('手が空いている 1');
    expect(lineWithout).toContain('手が空いている 1');
    expect(lineWith).not.toBe(lineWithout);
    expect(lineWithout).not.toContain('直近のターンが失敗で終わっている');
    expect(withoutFailure).not.toContain('「手が空いている」は「仕事を終えて空いた」を意味しない');
    expect(withoutFailure).not.toContain('この軸で絞る綴りは無い');
  });

  it('⭐ 本数が 0 でも「手が空いている」は「終わった」ではないことを常に名乗る', () => {
    const text = describeSituation({
      managers: [summary('a', 'done', true)],
      runners: [],
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).not.toContain('直近のターンが失敗で終わっている');
    expect(text).toContain('「手が空いている」は「終わった」でもない');
    expect(text).toContain('その本数は1本以上あるときだけ上の行に出る');
  });

  it('⭐ 手が空いているの中に「枠(利用上限)で止まっている」本数が並び、断り書きが出る', () => {
    const text = describeSituation({
      managers: [
        withUsageStopped(summary('a', 'done', true)),
        withUsageStopped(summary('b', 'done', true)),
        summary('c', 'done', true),
        withUsageStopped(summary('d', 'running', true)),
      ],
      runners: [],
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine, '「委譲 全 」の行が見つからない').toBeDefined();
    expect(countsLine).toContain('手が空いている 3');
    expect(countsLine).toContain('枠(利用上限)で止まっているのは 3 本');
    expect(countsLine).toContain('「手が空いている」に数えたものが 2 本');
    expect(countsLine).toContain('上の区分とは足し合わせない');
    expect(text).toContain('「手が空いている」は「仕事を終えて空いた」を意味しない');
    expect(text).toContain('manager_list');
    expect(text).toContain('の各行に付く注記');
    expect(text).toContain('で名指しされる');
    expect(text).toContain('`manager_report <managerId>`');
  });

  it('⭐ （陰性対照）usageStoppedAt が無ければ本数も断り書きも1文字も出ない', () => {
    const withStopped = describeSituation({
      managers: [withUsageStopped(summary('a', 'done', true))],
      runners: [],
    });
    const withoutStopped = describeSituation({
      managers: [summary('a', 'done', true)],
      runners: [],
    });
    const lineWith = withStopped.split('\n').find((l) => l.startsWith('委譲 全 '));
    const lineWithout = withoutStopped.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(lineWithout, '「委譲 全 」の行が見つからない').toBeDefined();
    expect(lineWith).toContain('手が空いている 1');
    expect(lineWithout).toContain('手が空いている 1');
    expect(lineWith).not.toBe(lineWithout);
    expect(lineWithout).not.toContain('枠(利用上限)で止まっている');
    expect(withoutStopped).not.toContain('「手が空いている」は「仕事を終えて空いた」を意味しない');
  });

  it('⭐ 本数が 0 でも「手が空いている」は「枠が空いた」ではないことを常に名乗る', () => {
    const text = describeSituation({
      managers: [summary('a', 'done', true)],
      runners: [],
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).not.toContain('枠(利用上限)で止まっている');
    expect(text).toContain('「手が空いている」は「枠が空いた」でもない');
    expect(text).toContain('その本数も1本以上あるときだけ上の行に出る');
  });

  it('⭐ 走行中の中に「宛先の runner が名簿から消えている」本数が並び、断り書きが出る', () => {
    const text = describeSituation({
      managers: [
        withRunnerVanished(summary('a', 'running', true)),
        withRunnerVanished(summary('b', 'running', true)),
        summary('c', 'running', true),
      ],
      runners: [],
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine, '「委譲 全 」の行が見つからない').toBeDefined();
    expect(countsLine).toContain('走行中 3');
    expect(countsLine).toContain('宛先の runner が名簿から entry ごと消えているのは 2 本');
    expect(countsLine).toContain('必ず「走行中」の内側');
    expect(countsLine).toContain('上の区分とは足し合わせない');
    expect(text).toContain('manager_list status: ["lost"]');
    expect(text).toContain('isLive()');
    expect(text).toContain('`manager_report <managerId>`');
    expect(text).toContain('絞りでは切り出せない');
  });

  it('⭐ （陰性対照）runnerVanished が無ければ本数も断り書きも1文字も出ない', () => {
    const withVanished = describeSituation({
      managers: [withRunnerVanished(summary('a', 'running', true))],
      runners: [],
    });
    const withoutVanished = describeSituation({
      managers: [summary('a', 'running', true)],
      runners: [],
    });
    const lineWith = withVanished.split('\n').find((l) => l.startsWith('委譲 全 '));
    const lineWithout = withoutVanished.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(lineWithout, '「委譲 全 」の行が見つからない').toBeDefined();
    expect(lineWith).toContain('走行中 1');
    expect(lineWithout).toContain('走行中 1');
    expect(lineWith).not.toBe(lineWithout);
    expect(lineWithout).not.toContain('宛先の runner が名簿から entry ごと消えている');
    expect(withoutVanished).not.toContain('の絞りでは見えない');
  });

  it('⭐ 本数が 0 でも「走行中」は「宛先の runner が名簿に居る」とは限らないことを常に名乗る', () => {
    const text = describeSituation({
      managers: [summary('a', 'running', true)],
      runners: [],
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine).not.toContain('宛先の runner が名簿から entry ごと消えている');
    expect(text).toContain('「走行中」は「宛先の runner が名簿に居る」でもない');
    expect(text).toContain('その本数も1本以上あるときだけ上の行に出る');
  });

  it('⭐ 「その他」の説明文に lost が入っていない（failed / stopped だけを名指しする）', () => {
    const text = describeSituation({
      managers: [summary('a', 'failed', false)],
      runners: [],
    });
    const note = text.split('\n').find((line) => line.includes('「その他」は終端したもの'));
    expect(note, '「その他」の説明文が見つからない').toBeDefined();
    expect(note).toContain('（failed / stopped）');
    expect(note).not.toContain('lost');
  });

  it('器は台数を必ず出し、居ない state は出さない', () => {
    const text = describeSituation({
      managers: [],
      runners: [{ state: 'connected' }, { state: 'connected' }, { state: 'vacating' }],
    });
    const runnerLine = text.split('\n').find((line) => line.startsWith('器 '));
    expect(runnerLine).toBe('器 3 台: connected 2 / vacating 1。');
    for (const absent of ['lost', 'unreachable', 'unusable', 'connecting']) {
      expect(runnerLine, `居ない state（${absent}）が器の行に出ている`).not.toContain(absent);
    }
  });

  it('器が1台も無くても行を消さず「器 0 台」と書く', () => {
    const text = describeSituation({ managers: [], runners: [] });
    expect(text).toContain('器 0 台。');
  });

  it('「空き枠」「あと何本置ける」を作らず、そう読ませない断りを添える', () => {
    const text = describeSituation({
      managers: [summary('a', 'done', true)],
      runners: [{ state: 'connected' }],
    });
    expect(text).toContain('「手が空いている」は「空き枠」ではない');
    expect(text).toContain('置けるかどうかはここでは答えていない');
    expect(text).not.toContain('あと何本');
    expect(text).not.toContain('空き枠は');
    expect(text).not.toContain('残り');
  });

  it('背景処理待ちが器の名乗り次第であることを断る', () => {
    const text = describeSituation({ managers: [], runners: [] });
    expect(text).toContain('「背景処理待ち」は器が名乗った分だけである');
  });

  it('「走行中」は status だけでなく背景処理待ちの印を見て数えることを、本数と断り書きの両方で測る', () => {
    const text = describeSituation({
      managers: [summary('a', 'running', true, BG)],
      runners: [],
    });
    const countsLine = text.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(countsLine, '「委譲 全 」の行が見つからない').toBeDefined();
    expect(countsLine).toContain('走行中 0');
    expect(countsLine).toContain('背景処理待ち 1');
    expect(text).toContain('「背景処理待ち」を含まない');
    expect(text).toContain('`status`');
    expect(text).toContain('`running`');
  });

  it('（陰性対照）印を外すと同じ委譲が走行中側へ数え直されることを、差分そのもので測る', () => {
    const withMark = describeSituation({
      managers: [summary('a', 'running', true, BG)],
      runners: [],
    });
    const withoutMark = describeSituation({
      managers: [summary('a', 'running', true)],
      runners: [],
    });
    const lineWith = withMark.split('\n').find((l) => l.startsWith('委譲 全 '));
    const lineWithout = withoutMark.split('\n').find((l) => l.startsWith('委譲 全 '));
    expect(lineWithout, '「委譲 全 」の行が見つからない').toBeDefined();
    expect(lineWithout).toContain('走行中 1');
    expect(lineWithout).toContain('背景処理待ち 0');
    expect(lineWith).not.toBe(lineWithout);
  });

  it('次に何をするかを1文字も指図しない', () => {
    const text = describeSituation({
      managers: [summary('a', 'done', true), summary('b', 'done', true)],
      runners: [{ state: 'connected' }],
    });
    for (const forbidden of ['始める', '置くこと', '委譲を出', 'べきである', 'しなさい']) {
      expect(text, `指図（${forbidden}）が混ざっている`).not.toContain(forbidden);
    }
    expect(text).toContain('ここから何をするかは決めない');
  });

  it('末尾は本文と区切られている（--- で終わる）', () => {
    const text = describeSituation({ managers: [], runners: [] });
    expect(text.endsWith('\n---\n')).toBe(true);
  });
});

describe('describeSituationUnavailable', () => {
  it('0 で埋めず、数えられなかったと名乗る', () => {
    const text = describeSituationUnavailable(new Error('list() が壊れている'));
    expect(text).toContain('数えられなかった');
    expect(text).toContain('list() が壊れている');
    expect(text).toContain('「全部片付いている」ではなく');
    expect(text).not.toContain('委譲 全 ');
    expect(text).not.toContain('手が空いている');
    expect(text).not.toContain('器 0 台');
  });

  it('多行の例外（drizzle の形）の2行目以降の値と、URL の資格は、クローンのプロンプトへ出さない（#2468）', () => {
    const drizzleShaped = new Error(
      'Failed query: select * from managers where id = $1\nparams: FAKE_SECRET_VALUE_2468',
    );
    const text = describeSituationUnavailable(drizzleShaped);
    expect(text).toContain('Failed query');
    expect(text).not.toContain('FAKE_SECRET_VALUE_2468');
    expect(text).not.toContain('params:');

    const withCredential = describeSituationUnavailable(
      new Error('connect failed: postgres://user:FAKE_SECRET_VALUE_2468@db.example:5432/alteroid'),
    );
    expect(withCredential).toContain('connect failed');
    expect(withCredential).not.toContain('FAKE_SECRET_VALUE_2468');
  });

  it('行そのものは消えない（見出しは数えられたときと同じ語で始まる）', () => {
    const ok = describeSituation({ managers: [], runners: [] });
    const ng = describeSituationUnavailable(new Error('x'));
    expect(ok.startsWith('[system] いまの全体')).toBe(true);
    expect(ng.startsWith('[system] いまの全体')).toBe(true);
    expect(ng).not.toBe(ok);
  });
});

describe('いまの全体は、いつ数えた値かを名乗る（#902）', () => {
  const material = { managers: [], runners: [] } as const;

  it('⭐⭐ 数が同じでも、数えた時刻が違えば節も違う（文脈に溜まった節を読み分けられる）', () => {
    const early = describeSituation({ ...material, at: Date.parse('2026-09-13T12:51:03.000Z') });
    const late = describeSituation({ ...material, at: Date.parse('2026-09-13T13:07:41.000Z') });

    expect(early, '正の対照: 本数の行が出ていない（節そのものが変わってしまっている）').toContain(
      '委譲 全 0 本',
    );
    expect(late).toContain('委譲 全 0 本');

    expect(
      late,
      '数えた時刻が違うのに節が1バイトも違わない。この赤の意味は「会話履歴に溜まった' +
        '複数の『いまの全体』を、読む側が読み分けられない」——どれも現在形で断定するので、' +
        '古い節が最新として読まれる（#902）。',
    ).not.toBe(early);
  });

  it('名乗るのは「数えた時刻」そのものである（渡した値がそのまま出る）', () => {
    const text = describeSituation({ ...material, at: Date.parse('2026-09-13T12:51:03.000Z') });
    expect(
      text,
      '節が名乗る時刻が、数えた時刻と一致していない（固定値や別の時計に化けている）',
    ).toContain('12:51:03Z');
  });

  it('数えられなかった側も同じ規則で名乗る（片方だけ名乗る非対称を作らない）', () => {
    const text = describeSituationUnavailable(
      new Error('list() が壊れている'),
      Date.parse('2026-09-13T12:51:03.000Z'),
    );
    expect(
      text,
      '「数えられなかった」の節だけが時刻を名乗らない。この赤の意味は「#902 が指摘した' +
        '非対称（同じファイルの中で一部の行にだけ配慮が当たっている）を、こちらで作り直した」。',
    ).toContain('12:51:03Z');
    expect(text).toContain('数えられなかった');
  });
});

describe('枠を理由に見送らせない（describeTokenSituation）', () => {
  const AT = Date.parse('2026-09-07T07:45:00.000Z');
  const row = (
    over: Partial<
      Parameters<typeof describeTokenSituation>[0]['tokens'] extends
        readonly (infer R)[] | undefined
        ? R
        : never
    > = {},
  ) => ({ id: 'tok-a', label: 'first', ...over });

  it('現役と、その記録上の状態を出す', () => {
    const line = describeTokenSituation({
      tokens: [row({ id: 'tok-a', label: 'staging@example' })],
      active: { tokenId: 'tok-a' },
      at: AT,
    });

    expect(line).toContain('現役は「staging@example」');
    expect(line).toContain('記録の上では 使える');
  });

  it('⭐ 冷却中でも「見送らない」の1行が付く（ここが事故の本体）', () => {
    const line = describeTokenSituation({
      tokens: [row({ cooldownUntil: AT + 3 * 60 * 60 * 1000 })],
      active: { tokenId: 'tok-a' },
      at: AT,
    });

    expect(line).toContain('記録の上では 冷却中');
    expect(line).toContain('冷却明けは 2026-09-07T10:45:00.000Z');
    expect(line).toContain('枠を理由に仕事を見送らないこと');
    expect(line).toContain('書ける状況では必ず偽');
    expect(line).toContain('見送りは選ばない');
  });

  it('過去の文言が降りた鍵のものでありうる、と名指しする', () => {
    const line = describeTokenSituation({ tokens: [row()], active: null, at: AT });

    expect(line).toContain('既に降りた鍵についての事実でありうる');
  });

  it('本数を「いま使える / 冷却中 / 人間が外している / 失効」で分けて数える', () => {
    const line = describeTokenSituation({
      tokens: [
        row({ id: 'a', label: 'ready1' }),
        row({ id: 'b', label: 'ready2' }),
        row({ id: 'c', label: 'cool', cooldownUntil: AT + 1000 }),
        row({ id: 'd', label: 'off', disabledAt: '2026-08-25T00:00:00.000Z' }),
        row({ id: 'e', label: 'dead', invalidatedAt: '2026-08-25T00:00:00.000Z' }),
      ],
      active: { tokenId: 'a' },
      at: AT,
    });

    expect(line).toContain('プール 5 本: いま使える 2 / 冷却中 1 / 人間が外している 1 / 失効 1');
    expect(line).not.toContain('外されている');
  });

  it('指名がまだ無い回を「1本目が現役」と書かない', () => {
    const line = describeTokenSituation({ tokens: [row()], active: null, at: AT });

    expect(line).toContain('現役の指名は**まだ一度も無い**');
    expect(line).not.toContain('現役は「first」');
  });

  it('指名の先の行が消えていたら、そう書く', () => {
    const line = describeTokenSituation({
      tokens: [row({ id: 'tok-b', label: 'other' })],
      active: { tokenId: 'tok-gone' },
      at: AT,
    });

    expect(line).toContain('現役として記録された行がプールに無い');
  });

  it('⭐ プールを読めなかった回も、不変条件の行は落とさない', () => {
    const line = describeTokenSituation({
      tokens: undefined,
      active: { tokenId: 'tok-a' },
      at: AT,
    });
    expect(line).toContain('プールを読めなかった');
    expect(line).not.toContain('いま使える 0');
    expect(line).toContain('枠を理由に仕事を見送らないこと');
  });

  it('`active` だけ読めなかった回は「プールを読めなかった」と言わない（`tokens` は読めている）', () => {
    const line = describeTokenSituation({
      tokens: [row({ id: 'a', label: 'ready1' }), row({ id: 'b', label: 'ready2' })],
      active: undefined,
      at: AT,
    });
    expect(line).not.toContain('プールを読めなかった');
    expect(line).toContain('現役の指名を読めなかった');
    expect(line).toContain('プール 2 本: いま使える 2 / 冷却中 0 / 人間が外している 0 / 失効 0');
    expect(line).toContain('枠を理由に仕事を見送らないこと');
  });

  it('「必ず通る」へ反転していない（確実性を作らない）', () => {
    const line = describeTokenSituation({ tokens: [row()], active: { tokenId: 'tok-a' }, at: AT });

    expect(line).not.toContain('必ず通る');
    expect(line).not.toContain('必ず始まる');
  });
});

describe('状況の1行に鍵が載る（describeSituation への配線）', () => {
  const AT = Date.parse('2026-09-07T07:45:00.000Z');

  it('材料を渡せば鍵の行が出る', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      tokens: [{ id: 'tok-a', label: 'staging@example' }],
      active: { tokenId: 'tok-a' },
      at: AT,
    });

    expect(out).toContain('認証トークン: 現役は「staging@example」');
    expect(out).toContain('枠を理由に仕事を見送らないこと');
    expect(out).toContain('委譲 全 0 本');
  });

  it('省略した呼びでは鍵の行が出ない（既存の呼び出しを壊さない）', () => {
    const out = describeSituation({ managers: [], runners: [] });

    expect(out).toContain('委譲 全 0 本');
    expect(out).not.toContain('認証トークン:');
  });
});

describe('状況の1行に受信箱の滞留が載る（#783 段0）', () => {
  const AT_THRESHOLD = 50;
  const ABOVE_THRESHOLD = 51;

  it('足場のリテラルは閾値そのものである（定数が動けばここで赤くなる）', () => {
    expect(AT_THRESHOLD).toBe(INBOX_BACKLOG_LOUD_THRESHOLD);
    expect(ABOVE_THRESHOLD).toBe(INBOX_BACKLOG_LOUD_THRESHOLD + 1);
  });

  it('省略した呼びでは行が出ない（既存の呼び出しを壊さない）', () => {
    const out = describeSituation({ managers: [], runners: [] });

    expect(out).toContain('委譲 全 0 本');
    expect(out).not.toContain('受信箱の未処理');
  });

  it('0件のときは行が出ない（backlog を渡しても count: 0 なら消える）', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count: 0 },
    });

    expect(out).not.toContain('受信箱の未処理');
  });

  it('⭐ 読めなかった（`unreadable`）ときは、0件とは別の専用の1行が出る', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: 'unreadable',
    });

    expect(out).toContain('委譲 全 0 本');
    expect(out).toContain('受信箱の未処理を数えられなかった');
    const line = out.split('\n').find((l) => l.includes('受信箱の未処理'));
    if (line === undefined) throw new Error('行が見つからない');
    expect(line).not.toContain('0');
  });

  it('省略（undefined）と unreadable は別の状態——省略は引き続き行が出ない', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: undefined,
    });

    expect(out).toContain('委譲 全 0 本');
    expect(out).not.toContain('受信箱の未処理');
  });

  it('1件以上・閾値以下は短い1行（⚠ も内訳への案内も付かない）', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count: AT_THRESHOLD, oldestAt: '2026-09-11T00:00:00.000Z' },
    });

    expect(out).toContain(`受信箱の未処理 ${AT_THRESHOLD} 件`);
    expect(out).toContain('2026-09-11T00:00:00.000Z');
    expect(out).not.toContain(`⚠ 受信箱の未処理 ${AT_THRESHOLD} 件`);
    const line = out.split('\n').find((l) => l.includes('受信箱の未処理'));
    if (line === undefined) throw new Error('行が見つからない');
    expect(line).not.toContain('manager_list');
  });

  it('閾値を超えると ⚠ 付きで膨らみ、内訳を割る口の名前が付く', () => {
    const count = ABOVE_THRESHOLD;
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count, oldestAt: '2026-09-10T09:28:55.000Z' },
    });

    expect(out).toContain(`⚠ 受信箱の未処理 ${count} 件`);
    expect(out).toContain('2026-09-10T09:28:55.000Z');
    expect(out).toContain('manager_list');
    expect(out).toContain('器の入れ替え回数');
    expect(out).not.toContain('配達回数');
  });

  it('閾値超え・typeBreakdown 在りは、種類の内訳（上位3件＋他）を添える', () => {
    const count = ABOVE_THRESHOLD;
    const external = (
      id: string,
      at: string,
    ): { event: InboxEvent; at: string; deliveries: number } => ({
      event: { type: 'external', id, at, source: 'token-pool', payload: {} },
      at,
      deliveries: 0,
    });
    const managerMessage = (
      id: string,
      at: string,
    ): { event: InboxEvent; at: string; deliveries: number } => ({
      event: { type: 'manager_message', id, at, managerId: 'mgr-x', kind: 'report', text: '本文' },
      at,
      deliveries: 0,
    });
    const typeBreakdown: InboxBacklogBreakdown = summarizeInboxBacklog(
      [
        external('e1', '2026-09-16T18:15:00.000Z'),
        external('e2', '2026-09-16T18:16:00.000Z'),
        managerMessage('m1', '2026-09-16T18:17:00.000Z'),
      ],
      Date.parse('2026-09-16T18:23:22.000Z'),
    );
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count, typeBreakdown },
    });

    expect(out).toContain(`⚠ 受信箱の未処理 ${count} 件`);
    expect(out).toContain('種類: external 2 / manager_message 1');
    expect(out).toContain('器の生の行 3 件を数えた');
    expect(out).toContain(
      'このターン自身の分は引いていないので、上の件数と1件前後ずれることがある',
    );
    expect(out).toContain('本文は載せない');
  });

  it('閾値超え・typeBreakdown に読めない行が在れば、その数と「処理済みではない」を添える', () => {
    const typeBreakdown = summarizeInboxBacklog(
      [
        {
          event: {
            type: 'external',
            id: 'e1',
            at: '2026-09-16T18:15:00.000Z',
            source: 's',
            payload: {},
          },
          at: '2026-09-16T18:15:00.000Z',
          deliveries: 0,
        },
      ],
      Date.parse('2026-09-16T18:23:22.000Z'),
      [{ id: 'evt-bad', reason: '不正な欄: event.type' }],
    );
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count: ABOVE_THRESHOLD, typeBreakdown },
    });

    expect(out).toContain('器の生の行 1 件を数えた（このほか読めない行が 1 件あり');
    expect(out).toContain('処理済みではない');
  });

  it('閾値超え・typeBreakdown 無しは、従来どおり manager_list への案内のまま', () => {
    const count = ABOVE_THRESHOLD;
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count },
    });

    expect(out).toContain(`⚠ 受信箱の未処理 ${count} 件`);
    expect(out).not.toContain('種類:');
    expect(out).toContain(
      '内訳（種類 / 同一本文 / 器の入れ替え回数 / 齢）は `manager_list` で割れる',
    );
  });

  it('指図を書かない（「〜せよ」の類が1文字も無い）', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count: ABOVE_THRESHOLD },
    });
    const line = out.split('\n').find((l) => l.includes('受信箱の未処理'));
    if (line === undefined) throw new Error('行が見つからない');

    expect(line).not.toContain('確認せよ');
    expect(line).not.toContain('対処せよ');
    expect(line).not.toContain('処理せよ');
  });
});

describe('状況の1行にメモリの配達待ち行列が載る（#1084）', () => {
  it('省略した呼びでは行が出ない（既存の呼び出しを壊さない）', () => {
    const out = describeSituation({ managers: [], runners: [] });

    expect(out).not.toContain('メモリの配達待ち行列');
  });

  it('0件のときは行が出ない（読めない状態が無いので、0は素直に0件を意味する）', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      queuedInMemory: 0,
    });

    expect(out).not.toContain('メモリの配達待ち行列');
  });

  it('⭐ 1件以上なら、器の行数（backlog）とは無関係に専用の1行が出る', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      backlog: { count: 0 },
      queuedInMemory: 3326,
    });

    expect(out).not.toContain('受信箱の未処理');
    const line = out.split('\n').find((l) => l.includes('メモリの配達待ち行列'));
    if (line === undefined) throw new Error('行が見つからない');
    expect(line).toContain('メモリの配達待ち行列 3326 件');
    expect(line).toContain('足しても引いても意味が無い');
    expect(line).toContain('食い違ったときだけ');
  });

  it(
    '⭐ 陰性対照——器の軸が `unreadable`（読めなかった）でも、メモリの軸は' +
      '0 を騙らず、自分の値をそのまま名乗る',
    () => {
      const out = describeSituation({
        managers: [],
        runners: [],
        backlog: 'unreadable',
        queuedInMemory: 7,
      });

      const dbLine = out.split('\n').find((l) => l.includes('受信箱の未処理'));
      if (dbLine === undefined) throw new Error('器の行が見つからない');
      expect(dbLine).toContain('受信箱の未処理を数えられなかった');
      expect(dbLine).not.toContain('0');
      const memLine = out.split('\n').find((l) => l.includes('メモリの配達待ち行列'));
      if (memLine === undefined) throw new Error('メモリの行が見つからない');
      expect(memLine).toContain('メモリの配達待ち行列 7 件');
    },
  );

  it('指図を書かない（「〜せよ」の類が1文字も無い）', () => {
    const out = describeSituation({
      managers: [],
      runners: [],
      queuedInMemory: 42,
    });
    const line = out.split('\n').find((l) => l.includes('メモリの配達待ち行列'));
    if (line === undefined) throw new Error('行が見つからない');

    expect(line).not.toContain('確認せよ');
    expect(line).not.toContain('対処せよ');
    expect(line).not.toContain('処理せよ');
  });
});
