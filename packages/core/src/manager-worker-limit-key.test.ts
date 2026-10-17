import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createProfileService } from './profile-service.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
  type RunnerProfileFingerprint,
  type RunnerProfileResult,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import type { AgentToken } from './token-pool.js';
import { createMemoryStores } from './testing.js';
import { parseNoticeResetDatedAt } from './usage-reset-text.js';
import { describeWorkerLimitKeyMatch } from './worker-limit-key-match.js';

// 2026-10-17、WORLDBUILD-7 の作業者が落ちた原文。鍵12（order 3）の seven_day の resetsAt 2026-10-22T07:00Z と分単位で一致した（#5021）。
const RAW = "You've hit your weekly limit · resets Oct 22, 4pm (Asia/Tokyo)";
const RESET_AT = Date.parse('2026-10-22T07:00:00.000Z');
const NOW = Date.parse('2026-10-17T08:32:41.000Z');
// 値そのものは載せない: 載ったら落ちる印のダミー
const SECRET_B = 'sk-ant-oat01-SECRET-B-VALUE';
const SECRET_C = 'sk-ant-oat01-SECRET-C-VALUE';

function token(overrides: Partial<AgentToken> & Pick<AgentToken, 'id' | 'label' | 'order'>) {
  return overrides as AgentToken;
}

const KEY_A = token({ id: 'aaaaaaaa-1111', label: '鍵A', order: 1 });
const KEY_B = token({
  id: 'bbbbbbbb-2222',
  label: '鍵B',
  order: 3,
  value: SECRET_B,
  cooldownUntil: RESET_AT,
  cooldownSource: 'quota_reset',
});
const KEY_C = token({ id: 'cccccccc-3333', label: '鍵C', order: 4, value: SECRET_C });

describe('parseNoticeResetDatedAt（日付付きの resets）', () => {
  it('Oct 22, 4pm (Asia/Tokyo) を 2026-10-22T07:00Z に直す', () => {
    expect(parseNoticeResetDatedAt(RAW, { at: NOW, withinMs: 30 * 86_400_000 })).toBe(RESET_AT);
  });

  it('分付き・年またぎ（12月に読む Jan 2）を直す。存在しない日付は直さない', () => {
    const december = Date.parse('2026-12-30T00:00:00.000Z');
    expect(
      parseNoticeResetDatedAt('resets Jan 2, 3:30am (UTC)', {
        at: december,
        withinMs: 30 * 86_400_000,
      }),
    ).toBe(Date.parse('2027-01-02T03:30:00.000Z'));
    expect(
      parseNoticeResetDatedAt('resets Feb 30, 3am (UTC)', { at: NOW, withinMs: 400 * 86_400_000 }),
    ).toBeUndefined();
  });

  it('日付が無い形は直さない（既存の読み取りの持ち場）', () => {
    expect(
      parseNoticeResetDatedAt('resets 9:30am (Asia/Tokyo)', { at: NOW, withinMs: 86_400_000 }),
    ).toBeUndefined();
  });
});

describe('describeWorkerLimitKeyMatch', () => {
  const windows = [
    { tokenId: KEY_B.id, kind: 'seven_day', resetsAt: RESET_AT + 12_345 },
    { tokenId: KEY_B.id, kind: 'five_hour', resetsAt: NOW + 3_600_000 },
  ];

  it('⭐ 鍵Bの seven_day の resetsAt と一致し、現役（鍵C）ではない', () => {
    const line = describeWorkerLimitKeyMatch({
      raw: RAW,
      at: NOW,
      pool: [KEY_A, KEY_B, KEY_C],
      activeTokenId: KEY_C.id,
      windows,
    });
    expect(line).toContain('鍵「鍵B」（order 3・id bbbbbbbb）');
    expect(line).toContain('seven_day の枠に一致する');
    expect(line).toContain('現役ではない（現役は 鍵「鍵C」（order 4・id cccccccc））');
  });

  it('一致した鍵が現役なら「現役と同じ鍵である」', () => {
    const line = describeWorkerLimitKeyMatch({
      raw: RAW,
      at: NOW,
      pool: [KEY_A, KEY_B],
      activeTokenId: KEY_B.id,
      windows,
    });
    expect(line).toContain('現役と同じ鍵である');
  });

  it('枠の観測が無くても、冷却明けと一致すれば鍵は名乗る。枠の種類は記録に無いと書く', () => {
    const line = describeWorkerLimitKeyMatch({
      raw: RAW,
      at: NOW,
      pool: [KEY_B, KEY_C],
      activeTokenId: KEY_C.id,
      windows: [],
    });
    expect(line).toContain('鍵「鍵B」');
    expect(line).toContain('どの枠かは記録に無い');
  });

  it('一致する鍵が無ければ、その旨を書く（決め打ちしない）', () => {
    const line = describeWorkerLimitKeyMatch({
      raw: RAW,
      at: NOW,
      pool: [KEY_A, KEY_C],
      activeTokenId: KEY_C.id,
      windows: [],
    });
    expect(line).toContain('一致する鍵の枠は、プールの記録に無い');
    expect(line).not.toContain('鍵「鍵A」');
  });

  it('分を跨ぐずれは一致にしない', () => {
    const line = describeWorkerLimitKeyMatch({
      raw: RAW,
      at: NOW,
      pool: [{ ...KEY_B, cooldownUntil: RESET_AT + 60_000 }],
      activeTokenId: KEY_C.id,
      windows: [],
    });
    expect(line).toContain('一致する鍵の枠は、プールの記録に無い');
  });

  it('複数の鍵に一致すれば、両方を並べて決めないと書く', () => {
    const twin = { ...KEY_A, cooldownUntil: RESET_AT, cooldownSource: 'quota_reset' as const };
    const line = describeWorkerLimitKeyMatch({
      raw: RAW,
      at: NOW,
      pool: [twin, KEY_B, KEY_C],
      activeTokenId: KEY_C.id,
      windows: [],
    });
    expect(line).toContain('複数の鍵に一致する');
    expect(line).toContain('鍵「鍵A」');
    expect(line).toContain('鍵「鍵B」');
    expect(line).toContain('決められない');
  });

  it('原文を時刻に直せなければ、その旨を書く', () => {
    const line = describeWorkerLimitKeyMatch({
      raw: "You've hit your weekly limit",
      at: NOW,
      pool: [KEY_B],
      activeTokenId: KEY_B.id,
      windows,
    });
    expect(line).toContain('時刻に直せなかった');
  });

  it('プールを読めなければ、その旨を書く', () => {
    const line = describeWorkerLimitKeyMatch({
      raw: RAW,
      at: NOW,
      pool: undefined,
      activeTokenId: undefined,
      windows,
    });
    expect(line).toContain('鍵のプールを読めなかった');
  });

  it('現役の指名が読めなければ、一致の鍵は名乗りつつ現役かどうかは分からないと書く', () => {
    const line = describeWorkerLimitKeyMatch({
      raw: RAW,
      at: NOW,
      pool: [KEY_B],
      activeTokenId: undefined,
      windows,
    });
    expect(line).toContain('鍵「鍵B」');
    expect(line).toContain('現役かどうかは分からない');
  });

  it('⚠️ 鍵の値（秘密）も id の先頭より後ろも載らない', () => {
    const line = describeWorkerLimitKeyMatch({
      raw: RAW,
      at: NOW,
      pool: [KEY_A, KEY_B, KEY_C],
      activeTokenId: KEY_C.id,
      windows,
    });
    expect(line).not.toContain(SECRET_B);
    expect(line).not.toContain(SECRET_C);
    expect(line).not.toContain('SECRET');
    expect(line).not.toContain('bbbbbbbb-2222');
    expect(line).not.toContain('cccccccc-3333');
  });
});

// --- デーモンの note の受け口を通す ---

const JOB: Job = {
  id: 'mgr-wl',
  managerId: 'mgr-wl',
  createdAt: '2026-10-17T00:00:00.000Z',
  updatedAt: '2026-10-17T00:00:00.000Z',
  status: 'running',
  summary: '調べもの',
  request: '調べておいて',
  cwd: '/work/project',
  sessionId: 'sess-1',
  runnerId: 'runner-primary',
};

function fakeRunner() {
  let emit: ((event: RunnerEvent) => void) | null = null;
  const alive: RunnerManagerState[] = [];
  const runner: RunnerClient = {
    runnerId: 'runner-primary',
    runnerIdKnown: true,
    workspacePath: '/work/project',
    workspacePathKnown: true,
    async connect(onEvent) {
      emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(command): Promise<{ cwd?: string }> {
      alive.push({
        managerId: command.managerId,
        status: 'running',
        cwd: command.cwd,
        request: command.request,
        waiting: [],
        sessionId: command.sessionId,
      });
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop() {
      /* この検証では使わない */
    },
    async list() {
      return [...alive];
    },
    async transcript() {
      return null;
    },
    async credentials() {
      return [];
    },
    async setCredentials() {
      return [];
    },
    async profile(): Promise<RunnerProfileFingerprint | undefined> {
      return undefined;
    },
    async setProfile(): Promise<RunnerProfileResult> {
      return { ok: false, error: 'この検証では使わない' };
    },
    async close() {
      /* この検証では使わない */
    },
  };
  return {
    runner,
    push(event: RunnerEvent): void {
      if (emit === null) throw new Error('connect されていない（名乗る前に流している）');
      emit(event);
    },
  };
}

async function setup(pool: readonly AgentToken[] | null, activeTokenId?: string) {
  const stores = createMemoryStores();
  await stores.jobs.putJob(JOB);
  if (pool !== null) {
    await stores.tokens.replace([...pool]);
    if (activeTokenId !== undefined) {
      await stores.tokens.writeActive({
        tokenId: activeTokenId,
        generation: 297,
        rotatedAt: '2026-10-17T08:21:44.000Z',
      });
    }
  }
  const fake = fakeRunner();
  const registry = createRunnerRegistry([fake.runner]);
  const inbox: InboxEvent[] = [];
  const managerPool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    profile: createProfileService({ stores, runners: registry }),
    now: () => NOW,
    // 落ちた時点でセッションが抱えている鍵は鍵B（回転前）。現役はプールの側（鍵C）
    tokenIdentity: () => ({ tokenId: KEY_B.id, generation: 296 }),
  });
  await managerPool.restore();
  return { pool: managerPool, fake, stores, inbox };
}

function workerLimitNote(raw: string, preRotationKey: boolean): RunnerEvent {
  return {
    type: 'note',
    managerId: JOB.id,
    text: '作業者（tool_use toolu-1）だけが利用上限で落ちた。',
    notifyClone: true,
    workerLimit: { raw, preRotationKey },
  } as RunnerEvent;
}

function reports(inbox: readonly InboxEvent[]): string[] {
  return inbox
    .filter(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.kind === 'report',
    )
    .map((event) => event.text);
}

// 作業者の落ちの知らせ（クローンの受信箱の report）が届くまで待つ。固定時間は待たない
async function workerLimitReport(inbox: readonly InboxEvent[]): Promise<string> {
  return vi.waitFor(() => {
    const found = reports(inbox).find((one) => one.includes('作業者'));
    if (found === undefined) throw new Error('作業者の落ちの知らせがまだ届いていない');
    return found;
  });
}

describe('作業者の落ちの note に、落ちた枠の鍵の突き合わせを1行足す（#5021）', () => {
  it('⭐ 鍵Bの seven_day と一致する。クローンへの知らせの末尾に「現役ではない（現役は鍵C）」が載り、秘密は載らない', async () => {
    const s = await setup([KEY_A, KEY_B, KEY_C], KEY_C.id);
    // 回転前の鍵（鍵B）で観測した seven_day の枠
    s.fake.push({
      type: 'rate_limit',
      managerId: JOB.id,
      facts: { kind: 'seven_day', status: 'rejected', resetsAt: RESET_AT },
    } as RunnerEvent);
    s.fake.push(workerLimitNote(RAW, true));

    const text = await workerLimitReport(s.inbox);
    const lastLine = text.split('\n').at(-1) ?? '';
    expect(lastLine).toContain('鍵の突き合わせ:');
    expect(lastLine).toContain('鍵「鍵B」（order 3・id bbbbbbbb）');
    expect(lastLine).toContain('seven_day の枠に一致する');
    expect(lastLine).toContain('現役ではない（現役は 鍵「鍵C」（order 4・id cccccccc））');
    expect(text).not.toContain('SECRET');

    const journal = await s.stores.journal.list({ types: ['exchange'] });
    const logged = journal.find((entry) => 'text' in entry && entry.text.includes('作業者'));
    expect(logged !== undefined && 'text' in logged ? logged.text : '').toContain(
      '鍵「鍵B」（order 3・id bbbbbbbb）',
    );
    expect(JSON.stringify(journal)).not.toContain('SECRET');
    await s.pool.stop();
  });

  it.each([
    ['一致なし', [KEY_A, KEY_C], '一致する鍵の枠は、プールの記録に無い'],
    [
      '複数一致',
      [{ ...KEY_A, cooldownUntil: RESET_AT, cooldownSource: 'quota_reset' as const }, KEY_B, KEY_C],
      '複数の鍵に一致する',
    ],
  ])('%s の場合、その旨が載る', async (_name, pool, expected) => {
    const s = await setup(pool, KEY_C.id);
    s.fake.push(workerLimitNote(RAW, false));
    const text = await workerLimitReport(s.inbox);
    expect(text.split('\n').at(-1)).toContain(expected);
    await s.pool.stop();
  });

  it('原文を時刻に直せない場合、その旨が載る', async () => {
    const s = await setup([KEY_B, KEY_C], KEY_C.id);
    s.fake.push(workerLimitNote("You've hit your weekly limit", false));
    const text = await workerLimitReport(s.inbox);
    expect(text.split('\n').at(-1)).toContain('時刻に直せなかった');
    await s.pool.stop();
  });

  it('鍵のプールを読めない場合、その旨が載る（note の配達は巻き添えにしない）', async () => {
    const s = await setup(null);
    s.stores.tokens.list = async () => {
      throw new Error(`壊れている ${SECRET_B}`);
    };
    s.fake.push(workerLimitNote(RAW, false));
    const text = await workerLimitReport(s.inbox);
    expect(text.split('\n').at(-1)).toContain('鍵のプールを読めなかった');
    expect(text).not.toContain('SECRET');
    await s.pool.stop();
  });

  it('workerLimit の欄が無い note（旧 runner）には何も足さない', async () => {
    const s = await setup([KEY_B, KEY_C], KEY_C.id);
    s.fake.push({
      type: 'note',
      managerId: JOB.id,
      text: '作業者（x）だけが利用上限で落ちた。',
      notifyClone: true,
    } as RunnerEvent);
    const text = await workerLimitReport(s.inbox);
    expect(text).not.toContain('鍵の突き合わせ');
    await s.pool.stop();
  });
});
