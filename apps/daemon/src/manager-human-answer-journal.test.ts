import { createManagerPool, createMemoryStores, createRunnerRegistry } from '@alteroid/core';
import type { CloneHost, JournalEntry, RunnerClient, RunnerEvent, Stores } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// POST /managers/:id/messages で人間が担当の確認へ答える回。答えは承認の跡そのものなので、
// 判断の行を答えより先に日誌へ書き、書けなければ答えない（クローンの manager_send と同じ形。#5231）。

type Decision = Extract<JournalEntry, { type: 'decision' }>;

const BEFORE = '人間が直接 API からマネージャーの確認へ答えた（答えを届ける前に残す）';
const SENT = '人間が直接 API からマネージャーへ送った';
const RETRACT_MARK = '直前の回答の行は効いていない（答えは届いていない）';

function setup(answer: (managerId: string) => Promise<{ delivered: boolean; decision?: 'allow' }>) {
  const base = createMemoryStores();
  const control = { failAppend: false };
  const stores: Stores = {
    ...base,
    journal: {
      ...base.journal,
      append: async (entry) => {
        if (control.failAppend) throw new Error('journal down');
        return base.journal.append(entry);
      },
    },
  };
  const wired: { emit: ((event: RunnerEvent) => void) | null } = { emit: null };
  const runner: RunnerClient = {
    runnerId: 'runner-legacy',
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent) {
      wired.emit = onEvent;
    },
    async start(): Promise<{ cwd?: string }> {
      return {};
    },
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    answer,
    async stop() {},
    async list() {
      return [];
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
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true };
    },
    async close() {},
  };
  const pool = createManagerPool({
    stores,
    post: () => {},
    runners: createRunnerRegistry([runner]),
  });
  const clone: CloneHost = {
    postPersisted: async () => 'persisted',
    post: () => {},
    recycleSessionForToken: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    async dropQueuedInboxEvents() {
      return 0;
    },
    managers: pool,
    usageBlocked: false,
    usageReleasePending: false,
    usageBlockedResetsAt: undefined,
    usageBlockedTokenId: undefined,
    async stop() {},
  };
  const app = createApp({ clone, stores, token: 'test-token', shutdown: () => {} });
  const post = (managerId: string, body: unknown) =>
    app.request(`/managers/${managerId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify(body),
    });
  const decisions = async (): Promise<Decision[]> =>
    (await stores.journal.list({ types: ['decision'], order: 'asc' })).flatMap((entry) =>
      entry.type === 'decision' ? [entry] : [],
    );
  const startAsking = async () => {
    const { managerId } = await pool.start({ request: 'デプロイして' });
    wired.emit?.({
      type: 'ask',
      managerId,
      requestId: 'req-human',
      kind: 'permission',
      summary: 'Bash の実行許可: git push',
      askedAt: new Date().toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return managerId;
  };
  return { stores, control, pool, post, decisions, startAsking };
}

const ANSWER = { text: 'よい', requestId: 'req-human', decision: 'allow' };

describe('POST /managers/:id/messages: 人間の答えは日誌に先に残る', () => {
  it('答える瞬間に判断の行が日誌に既に在り、その行には humanAction が付かない', async () => {
    const seen: Decision[][] = [];
    const ref: { decisions: () => Promise<Decision[]> } = { decisions: async () => [] };
    const s = setup(async () => {
      seen.push(await ref.decisions());
      return { delivered: true, decision: 'allow' };
    });
    ref.decisions = s.decisions;
    const managerId = await s.startAsking();

    const response = await s.post(managerId, ANSWER);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { outcome: string }).outcome).toBe('answered');
    const atAnswer = seen[0] ?? [];
    expect(
      atAnswer.map((entry) => entry.grounds),
      '【赤の意味】答えが先に届いている。日誌が書けない窓で答えだけが届く。',
    ).toEqual([BEFORE]);
    expect(atAnswer[0]?.decision).toContain(
      `人間が担当 ${managerId} の確認（req-human: Bash の実行許可: git push）へ直接答える`,
    );
    expect(atAnswer[0]?.decision).toContain('decision=allow');
    expect(atAnswer[0]).not.toHaveProperty('humanAction');

    // 答えが効いた後の既存の行は、今どおり humanAction を持つ。打ち消しは無い
    const after = await s.decisions();
    expect(after.map((entry) => entry.grounds)).toEqual([BEFORE, SENT]);
    expect(after[1]?.humanAction).toMatchObject({ kind: 'manager_message', target: managerId });
    expect(JSON.stringify(after)).not.toContain(RETRACT_MARK);
    await s.pool.stop();
  });

  it('日誌に書けないときは 500 で、答えず、担当は確認待ちのまま', async () => {
    let answerCalls = 0;
    const s = setup(async () => {
      answerCalls += 1;
      return { delivered: true, decision: 'allow' };
    });
    const managerId = await s.startAsking();
    s.control.failAppend = true;

    const response = await s.post(managerId, ANSWER);

    expect(response.status).toBe(500);
    expect(((await response.json()) as { code: string }).code).toBe('journal_write_failed');
    expect(answerCalls, '日誌が書けなかったのに runner へ答えが送られた').toBe(0);
    const after = (await s.pool.list()).find((m) => m.managerId === managerId);
    expect(after?.status).toBe('waiting_human');
    expect(after?.waiting.map((item) => item.requestId)).toEqual(['req-human']);
    s.control.failAppend = false;
    expect(await s.decisions()).toEqual([]);
    await s.pool.stop();
  });

  it('runner 側で既に解けていた回は、先の行の後に打ち消しの行が足される（humanAction は付かない）', async () => {
    const s = setup(async () => ({ delivered: false }));
    const managerId = await s.startAsking();

    const response = await s.post(managerId, ANSWER);

    // `unknown` は既存どおり 404（答えは届いていない）
    expect(response.status).toBe(404);
    const after = await s.decisions();
    expect(after).toHaveLength(2);
    expect(after[0]?.grounds).toBe(BEFORE);
    expect(after[1]?.decision).toContain(
      `人間が担当 ${managerId} の確認（req-human）へ直接答えるとした${RETRACT_MARK}`,
    );
    for (const entry of after) expect(entry).not.toHaveProperty('humanAction');
    await s.pool.stop();
  });

  it('runner への答えが例外で終わった回も、打ち消しの行が足される', async () => {
    const s = setup(async () => {
      throw new Error('runner が落ちた');
    });
    const managerId = await s.startAsking();

    await s.post(managerId, ANSWER);

    const after = await s.decisions();
    expect(after[0]?.grounds).toBe(BEFORE);
    expect(after.some((entry) => entry.decision.includes(RETRACT_MARK))).toBe(true);
    expect(JSON.stringify(after)).toContain('送信が例外で終わった');
    await s.pool.stop();
  });

  it('確認でない普通の送信では、先の行も打ち消しも足さない', async () => {
    const s = setup(async () => ({ delivered: true }));
    const { managerId } = await s.pool.start({ request: '調べて' });

    const response = await s.post(managerId, { text: 'こっちを見て' });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { outcome: string }).outcome).toBe('delivered');
    const after = await s.decisions();
    expect(after.map((entry) => entry.grounds)).toEqual([SENT]);
    expect(JSON.stringify(after)).not.toContain(RETRACT_MARK);
    await s.pool.stop();
  });
});
