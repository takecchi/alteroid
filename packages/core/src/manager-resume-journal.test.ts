import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { RESUME_PEER_BUDGET_CHARS } from './resume-peers.js';
import { RESUME_SUBAGENT_BUDGET_CHARS } from './resume-subagents.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// resume で作業者・peer の記録を戻せなかったときに残す日誌の文を、そのまま固定する

class StubRunner implements RunnerClient {
  readonly runnerId = 'runner-primary';
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';

  async connect(): Promise<void> {}
  async start(command: Parameters<RunnerClient['start']>[0]): Promise<{ cwd: string }> {
    return { cwd: command.cwd };
  }
  async resume(command: RunnerResumeCommand): Promise<{ cwd: string }> {
    return { cwd: command.cwd };
  }
  async send(): Promise<boolean> {
    return true;
  }
  async answer(): Promise<RunnerAnswerOutcome> {
    return { delivered: false };
  }
  async stop(): Promise<void> {}
  async list() {
    return [];
  }
  async transcript(): Promise<string | null> {
    return null;
  }
  async credentials() {
    return [];
  }
  async setCredentials() {
    return [];
  }
  async profile() {
    return undefined;
  }
  async setProfile() {
    return { ok: true as const };
  }
  async close(): Promise<void> {}
}

const MAIN = [{ type: 'user', message: { role: 'user', content: '調べて' } }];

function job(): Job {
  const at = new Date(Date.now() - 1_000).toISOString();
  return {
    id: 'mgr-1',
    managerId: 'mgr-1',
    createdAt: at,
    updatedAt: at,
    status: 'running',
    summary: '走っていた仕事',
    request: '走っていた仕事の依頼',
    cwd: '/work/project',
    sessionId: 'sess-1',
    runnerId: 'runner-primary',
    projectKey: 'proj-key',
  };
}

function storeOf(
  sub: Record<string, SessionStoreEntry[]>,
  options: { failLoadOf?: string; failList?: boolean } = {},
): SessionStore {
  return {
    append: async () => undefined,
    load: async (key) => {
      if (key.subpath === undefined) return MAIN;
      if (key.subpath === options.failLoadOf) throw new Error('読めない（テストの偽物）');
      return sub[key.subpath] ?? null;
    },
    listSubkeys: async () => {
      if (options.failList === true) throw new Error('一覧が落ちた（テストの偽物）');
      return Object.keys(sub);
    },
  };
}

async function decisionsOf(sessionStore: SessionStore) {
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => new StubRunner() });
  const base = createMemoryStores();
  const stores: Stores = { ...base, sessionStore };
  await stores.jobs.putJob(job());
  const pool = createManagerPool({ stores, post: () => undefined, runners: registry });
  await pool.restore();
  const journal = await base.journal.list({ limit: 100 });
  await pool.stop();
  await registry.stop();
  return journal
    .filter((entry) => entry.type === 'decision' && entry.decision.includes('resume で、'))
    .map((entry) => ({
      decision: (entry as { decision: string }).decision,
      grounds: (entry as { grounds: string }).grounds,
    }));
}

const at = (second: number) => `2026-10-01T00:00:${String(second).padStart(2, '0')}.000Z`;
const meta = (threadId: string) => ({
  type: 'alteroid_peer_meta',
  provider: 'codex',
  threadId,
  relPath: `2026/10/01/rollout-2026-10-01T00-00-00-${threadId}.jsonl`,
});
const line = (ordinal: number, second: number, extra = {}) => ({
  timestamp: at(second),
  ordinal,
  type: 'response_item',
  payload: { text: 'x', ...extra },
});

describe('resume で戻せなかった作業者の日誌の文', () => {
  it('一覧を読めなかったとき', async () => {
    expect(await decisionsOf(storeOf({}, { failList: true }))).toEqual([
      // journal.list は新しい順
      {
        decision: '[mgr-1] resume で、peer の生ログの一覧を読めなかったので、peer の記録は戻さずに起こす',
        grounds: 'listSubkeys の失敗: Error: 一覧が落ちた（テストの偽物）',
      },
      {
        decision:
          '[mgr-1] resume で、作業者の生ログの一覧を読めなかったので、作業者の記録は戻さずに起こす',
        grounds: 'listSubkeys の失敗: Error: 一覧が落ちた（テストの偽物）',
      },
    ]);
  });

  it('読めなかった作業者と上限に入らなかった作業者', async () => {
    const big = (second: number) => [
      { type: 'user', timestamp: at(second), text: 'x'.repeat(RESUME_SUBAGENT_BUDGET_CHARS * 0.6) },
    ];
    expect(
      await decisionsOf(
        storeOf(
          {
            'subagents/agent-old': big(1),
            'subagents/agent-new': big(9),
            'subagents/agent-bad': [{ type: 'user', timestamp: at(5) }],
          },
          { failLoadOf: 'subagents/agent-bad' },
        ),
      ),
    ).toEqual([
      {
        decision:
          '[mgr-1] resume で、作業者の記録の一部を戻さなかった（その作業者への SendMessage は記録が無く失敗する）',
        grounds: `合計の上限（${String(RESUME_SUBAGENT_BUDGET_CHARS)} 文字）に入らず戻さなかった作業者 1 件: subagents/agent-old。読めずに戻さなかった作業者 1 件: subagents/agent-bad`,
      },
    ]);
  });
});

describe('resume で戻せなかった peer の日誌の文', () => {
  it('読めなかった・置き場の印が無い・上限に入らなかった peer', async () => {
    const big = (id: string, second: number) => [
      meta(id),
      line(0, second, { text: 'x'.repeat(RESUME_PEER_BUDGET_CHARS * 0.6) }),
    ];
    expect(
      await decisionsOf(
        storeOf(
          {
            'peers/peer-old': big('thr-old', 1),
            'peers/peer-new': big('thr-new', 9),
            'peers/peer-nometa': [line(0, 1)],
            'peers/peer-bad': [meta('thr-2'), line(0, 1)],
          },
          { failLoadOf: 'peers/peer-bad' },
        ),
      ),
    ).toEqual([
      {
        decision:
          '[mgr-1] resume で、peer の記録の一部を戻さなかった（その peer への peer_reply は続きから起こせず、新しく頼み直すことになる）',
        grounds: `合計の上限（${String(RESUME_PEER_BUDGET_CHARS)} 文字）に入らず戻さなかった peer 1 件: peer-old。読めずに戻さなかった peer 1 件: peer-bad。置き場の印（alteroid_peer_meta）が無く戻せなかった peer 1 件: peer-nometa`,
      },
    ]);
  });
});
