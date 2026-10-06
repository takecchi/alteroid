import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerEvent,
  type RunnerManagerState,
} from './runner-protocol.js';
import type { InboxEvent, Job } from './schema.js';
import { createMemoryStores } from './testing.js';

/**
 * 止めた委譲（`abort()` 後）に遅れて届く `permission_denied` が、クローンの受信箱へ
 * 新しい報告を積まないこと。`case 'report'` / `case 'ask'` は `stopped` なら日誌にだけ
 * 残して受信箱へ回さない（R4）。`case 'permission_denied'` にはその門が無い。
 */
function setup() {
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
    async resume(): Promise<{ cwd?: string }> {
      return {};
    },
    async send() {
      return true;
    },
    async answer(): Promise<RunnerAnswerOutcome> {
      return { delivered: false };
    },
    async stop(managerId) {
      const at = alive.findIndex((entry) => entry.managerId === managerId);
      if (at !== -1) alive.splice(at, 1);
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
    async profile() {
      return undefined;
    },
    async setProfile() {
      return { ok: true as const };
    },
    async close() {},
  };
  return { runner, alive, emit: (event: RunnerEvent) => emit?.(event) };
}

describe('止めた委譲に遅れて届く permission_denied', () => {
  it('受信箱へ報告を積まない', async () => {
    const job: Job = {
      id: 'mgr-denied-after-stop',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      status: 'running',
      summary: '調べ物',
      request: '調べて',
      cwd: '/work/project',
      sessionId: 'sess-1',
      runnerId: 'runner-primary',
    };
    const stores = createMemoryStores();
    await stores.jobs.putJob(job);
    const fake = setup();
    fake.alive.push({
      managerId: job.id,
      status: 'running',
      cwd: '/work/project',
      request: '調べて',
      waiting: [],
      sessionId: 'sess-1',
    });
    const inbox: InboxEvent[] = [];
    const pool = createManagerPool({
      stores,
      post: (event) => inbox.push(event),
      runners: createRunnerRegistry([fake.runner]),
    });
    await pool.restore();
    await vi.waitFor(() => {
      if (inbox.length === 0) throw new Error('reattach の知らせがまだ届いていない');
    });
    await pool.abort(job.id, '止める');
    const before = inbox.length;

    fake.emit({
      type: 'permission_denied',
      managerId: job.id,
      toolUseId: 'tu-1',
      tool: 'Bash',
      input: {},
      via: 'live',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(inbox.slice(before)).toEqual([]);

    // 日誌には残る（受信箱へ回さないだけで、黙って捨てない。Issue #3094）。
    const texts = (await stores.journal.list({ types: ['exchange'] })).map((entry) =>
      entry.type === 'exchange' ? entry.text : '',
    );
    expect(texts.some((text) => text.includes('実行が確認へ上がらずに止められた'))).toBe(true);
  });
});
