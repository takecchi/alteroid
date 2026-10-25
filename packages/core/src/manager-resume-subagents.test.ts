import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { createManagerPool } from './manager.js';
import {
  createRunnerRegistry,
  type RunnerAnswerOutcome,
  type RunnerClient,
  type RunnerResumeCommand,
} from './runner-protocol.js';
import { RESUME_SUBAGENT_BUDGET_CHARS, selectSubagentsWithinBudget } from './resume-subagents.js';
import type { Job } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 担当を resume で起こし直すとき、預かってある作業者（subagents/…）の記録も resume の要求に載せる（#5257）

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

// `main` が null でない鍵は主の記録、`sub` の各鍵は subpath つきの記録。`withListSubkeys: false` は口を持たない預かり先
function storeOf(
  sub: Record<string, SessionStoreEntry[]>,
  options: { withListSubkeys?: boolean; failLoadOf?: string } = {},
): SessionStore {
  const store: SessionStore = {
    append: async () => undefined,
    load: async (key) => {
      if (key.subpath === undefined) return MAIN;
      if (key.subpath === options.failLoadOf) throw new Error('読めない（テストの偽物）');
      return sub[key.subpath] ?? null;
    },
  };
  if (options.withListSubkeys !== false) {
    store.listSubkeys = async () => [...Object.keys(sub), 'other/not-a-subagent'];
  }
  return store;
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

const META = { type: 'agent_metadata', agentType: 'worker', cwd: '/work/project' };
const at = (second: number) => `2026-10-01T00:00:${String(second).padStart(2, '0')}.000Z`;

describe('担当の resume が、作業者の記録を要求に載せる', () => {
  it('subagents/ で始まる subpath だけを、本文（agent_metadata の行を含む）のまま載せる。主の分は今どおり', async () => {
    const worker = [META, { type: 'user', uuid: 'u1', timestamp: at(1) }];
    const { resumes } = await resumeWith(
      storeOf({
        'subagents/agent-a1': worker,
        'subagents/agent-b2': [{ type: 'user', timestamp: at(2) }],
      }),
    );

    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.entries).toEqual(MAIN);
    expect(resumes[0]?.subagents).toEqual([
      { subpath: 'subagents/agent-b2', entries: [{ type: 'user', timestamp: at(2) }] },
      { subpath: 'subagents/agent-a1', entries: worker },
    ]);
  });

  it('listSubkeys を持たない預かり先では欄を付けない（主の分は今どおり）', async () => {
    const { resumes } = await resumeWith(
      storeOf({ 'subagents/agent-a1': [{ type: 'user' }] }, { withListSubkeys: false }),
    );

    expect(resumes[0]?.entries).toEqual(MAIN);
    expect(resumes[0]).not.toHaveProperty('subagents');
  });

  it('1本の作業者が読めなくても、主と他の作業者は戻し、読めなかった作業者を日誌に残す', async () => {
    const { resumes, journal } = await resumeWith(
      storeOf(
        { 'subagents/agent-a1': [{ type: 'user' }], 'subagents/agent-bad': [{ type: 'user' }] },
        { failLoadOf: 'subagents/agent-bad' },
      ),
    );

    expect(resumes[0]?.subagents?.map((item) => item.subpath)).toEqual(['subagents/agent-a1']);
    const text = JSON.stringify(journal);
    expect(text).toContain('subagents/agent-bad');
    expect(text).toContain('読めずに戻さなかった');
  });

  it('合計の上限を超えた作業者は、新しいほうから入るだけ入れ、入らなかった作業者を日誌に残す', async () => {
    const big = (stamp: string) => [
      { type: 'user', timestamp: stamp, text: 'x'.repeat(RESUME_SUBAGENT_BUDGET_CHARS * 0.6) },
    ];
    const { resumes, journal } = await resumeWith(
      storeOf({
        'subagents/agent-old': big(at(1)),
        'subagents/agent-new': big(at(9)),
        'subagents/agent-small': [{ type: 'user', timestamp: at(5), text: 'small' }],
      }),
    );

    // 新しい順: new（0.6）→ small（入る）→ old（0.6 + 0.6 で入らない）
    expect(resumes[0]?.subagents?.map((item) => item.subpath)).toEqual([
      'subagents/agent-new',
      'subagents/agent-small',
    ]);
    expect(resumes[0]?.entries).toEqual(MAIN);
    const text = JSON.stringify(journal);
    expect(text).toContain('subagents/agent-old');
    expect(text).toContain('合計の上限');
  });
});

describe('selectSubagentsWithinBudget', () => {
  const entry = (chars: number, timestamp?: string) => ({
    ...(timestamp === undefined ? {} : { timestamp }),
    pad: 'x'.repeat(chars),
  });

  it('timestamp が読めないものは最も古い扱いで、先に落ちる', () => {
    const picked = selectSubagentsWithinBudget(
      [
        { subpath: 'subagents/agent-nostamp', entries: [entry(100)] },
        { subpath: 'subagents/agent-dated', entries: [entry(100, at(1))] },
      ],
      150,
    );

    expect(picked.included.map((item) => item.subpath)).toEqual(['subagents/agent-dated']);
    expect(picked.omitted).toEqual(['subagents/agent-nostamp']);
  });

  it('上限に収まるなら全部入れ、落とさない', () => {
    const picked = selectSubagentsWithinBudget([
      { subpath: 'subagents/agent-a', entries: [entry(10, at(1))] },
    ]);

    expect(picked.included).toHaveLength(1);
    expect(picked.omitted).toEqual([]);
  });
});
