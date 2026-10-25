import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import { RESUME_PEER_BUDGET_CHARS } from './resume-peers.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import type { Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 担当を resume で起こし直すとき、預かってある peer（peers/<peerId>）の記録も resume の要求に載せる（#5257）

class RecordingRunner implements RunnerClient {
  readonly runnerId = 'runner-primary';
  readonly runnerIdKnown = true;
  readonly workspacePathKnown = true;
  readonly workspacePath = '/work/project';
  readonly resumes: RunnerResumeCommand[] = [];

  async connect(): Promise<void> {}
  async start(): Promise<{ cwd?: string }> {
    return {};
  }
  async resume(command: RunnerResumeCommand): Promise<{ cwd?: string }> {
    this.resumes.push(command);
    return {};
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
  options: { failLoadOf?: string } = {},
): SessionStore {
  return {
    append: async () => undefined,
    load: async (key) => {
      if (key.subpath === undefined) return MAIN;
      if (key.subpath === options.failLoadOf) throw new Error('読めない（テストの偽物）');
      return sub[key.subpath] ?? null;
    },
    listSubkeys: async () => [...Object.keys(sub), 'other/not-a-peer'],
  };
}

async function resumeWith(sessionStore: SessionStore) {
  const runner = new RecordingRunner();
  const registry = createRunnerRegistry();
  await registry.register({ label: 'http://runner:4518', open: async () => runner });
  const base = createMemoryStores();
  const stores: Stores = { ...base, sessionStore };
  await stores.jobs.putJob(job());
  const pool = createManagerPool({ stores, post: () => undefined, runners: registry });
  await pool.restore();
  const journal = await base.journal.list({ limit: 100 });
  await pool.stop();
  await registry.stop();
  return { resumes: runner.resumes, journal };
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

describe('担当の resume が、peer の記録を要求に載せる', () => {
  it('peers/ の記録を peerId・provider・threadId・relPath・行に分けて載せる。subagents/ とは混ざらない', async () => {
    const { resumes } = await resumeWith(
      storeOf({
        'peers/peer-aaaa': [meta('thr-1'), line(0, 1), line(1, 2)],
        'subagents/agent-a1': [{ type: 'user', timestamp: at(3) }],
      }),
    );

    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.peers).toEqual([
      {
        peerId: 'peer-aaaa',
        provider: 'codex',
        threadId: 'thr-1',
        relPath: '2026/10/01/rollout-2026-10-01T00-00-00-thr-1.jsonl',
        entries: [line(0, 1), line(1, 2)],
      },
    ]);
    expect(resumes[0]?.subagents).toEqual([
      { subpath: 'subagents/agent-a1', entries: [{ type: 'user', timestamp: at(3) }] },
    ]);
  });

  it('peers/ が無ければ欄を付けない（主の分は今どおり）', async () => {
    const { resumes } = await resumeWith(storeOf({ 'subagents/agent-a1': [{ type: 'user' }] }));
    expect(resumes[0]?.entries).toEqual(MAIN);
    expect(resumes[0]).not.toHaveProperty('peers');
  });

  it('置き場の印が無い peer と読めなかった peer は戻さず、日誌に残す', async () => {
    const { resumes, journal } = await resumeWith(
      storeOf(
        {
          'peers/peer-ok': [meta('thr-1'), line(0, 1)],
          'peers/peer-nometa': [line(0, 1)],
          'peers/peer-bad': [meta('thr-2'), line(0, 1)],
        },
        { failLoadOf: 'peers/peer-bad' },
      ),
    );

    expect(resumes[0]?.peers?.map((peer) => peer.peerId)).toEqual(['peer-ok']);
    const text = JSON.stringify(journal);
    expect(text).toContain('peer-nometa');
    expect(text).toContain('置き場の印');
    expect(text).toContain('peer-bad');
    expect(text).toContain('読めずに戻さなかった');
  });

  it('合計の上限を超えた peer は、新しいほうから入るだけ入れ、入らなかった peer を日誌に残す', async () => {
    const big = (id: string, second: number) => [
      meta(id),
      line(0, second, { text: 'x'.repeat(RESUME_PEER_BUDGET_CHARS * 0.6) }),
    ];
    const { resumes, journal } = await resumeWith(
      storeOf({
        'peers/peer-old': big('thr-old', 1),
        'peers/peer-new': big('thr-new', 9),
        'peers/peer-small': [meta('thr-small'), line(0, 5)],
      }),
    );

    expect(resumes[0]?.peers?.map((peer) => peer.peerId)).toEqual(['peer-new', 'peer-small']);
    const text = JSON.stringify(journal);
    expect(text).toContain('合計の上限');
    expect(text).toContain('peer-old');
  });
});
