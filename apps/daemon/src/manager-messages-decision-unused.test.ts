import {
  createCloneTools,
  createLocalRunner,
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  decisionUnusedNote,
} from '@alteroid/core';
import type { CloneHost, RunnerClient, RunnerEvent } from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// POST /managers/:id/messages も、requestId 無しの decision が確認に当たらなかった回を `detail` で言う（#5329）。
// 道具 `manager_send` と同じ文（`decisionUnusedNote`）で、入口によって同じ失敗の見え方が割れないようにする。

const UNUSED = '回答としては使っていない';

async function setup() {
  const stores = createMemoryStores();
  const state = { delivers: true };
  const base = createLocalRunner({
    runnerId: 'runner-x',
    workspacePath: '/work/project',
    env: {},
  });
  const runner: RunnerClient = Object.create(base) as RunnerClient;
  Object.assign(runner, {
    runnerId: 'runner-x',
    runnerIdKnown: true,
    workspacePathKnown: true,
    workspacePath: '/work/project',
    async connect(onEvent: (event: RunnerEvent) => void) {
      onEvent({ type: 'hello', runnerId: 'runner-x', capabilities: [] });
    },
    async start(command: { cwd?: string }) {
      return { cwd: command.cwd };
    },
    async send() {
      return state.delivers;
    },
    async list() {
      return [];
    },
  });
  const registry = createRunnerRegistry([runner]);
  const pool = createManagerPool({ stores, post: () => {}, runners: registry });
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
  const post = async (managerId: string, body: unknown) => {
    const res = await app.request(`/managers/${managerId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as { outcome: string; detail: string } };
  };
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool,
  });
  const callTool = async (args: Record<string, unknown>): Promise<string> => {
    const tool = tools.find((t) => t.name === 'manager_send');
    const out = await tool!.handler(args as never, {} as never);
    return out.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
  const { managerId } = await pool.start({ request: '調べて' });
  return { state, post, callTool, managerId };
}

describe('POST /managers/:id/messages: decision が回答に当たらなかったら、detail で言う', () => {
  it('⭐ 待ちの確認が 0 件のマネージャーへ requestId 無しの decision を送ると、detail の末尾に警告が入る', async () => {
    const s = await setup();

    const res = await s.post(s.managerId, { text: 'いいよ', decision: 'allow' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('delivered');
    expect(res.body.detail).toContain(UNUSED);
    expect(res.body.detail.endsWith(decisionUnusedNote('allow', undefined, 'delivered'))).toBe(
      true,
    );
    expect(Object.keys(res.body).sort()).toEqual(['detail', 'outcome']);
  });

  it('requestId があれば入らない', async () => {
    const s = await setup();

    const res = await s.post(s.managerId, {
      text: 'いいよ',
      decision: 'allow',
      requestId: 'req-none',
    });

    // 待っていない requestId は確認に当たらず `unknown`（404）になる。どちらにせよ「回答としては使っていない」とは言わない（requestId を付けた呼び手は確認に答えるつもりで、本文は追加指示にならない）
    expect(JSON.stringify(res.body)).not.toContain(UNUSED);
  });

  it('decision が無ければ入らない', async () => {
    const s = await setup();

    const res = await s.post(s.managerId, { text: '続きを' });

    expect(res.body.outcome).toBe('delivered');
    expect(res.body.detail).not.toContain(UNUSED);
  });

  it('届かなかった回（session_missing）には入らない', async () => {
    const s = await setup();
    s.state.delivers = false;

    const res = await s.post(s.managerId, { text: 'いいよ', decision: 'allow' });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('session_missing');
    expect(res.body.detail).not.toContain(UNUSED);
  });

  it('道具 manager_send と HTTP で警告の文が一致する', async () => {
    const s = await setup();

    const http = await s.post(s.managerId, { text: 'だめ', decision: 'deny' });
    const tool = await s.callTool({ managerId: s.managerId, message: 'だめ', decision: 'deny' });

    const note = decisionUnusedNote('deny', undefined, 'delivered');
    expect(note).toContain('deny');
    expect(http.body.detail).toContain(note);
    expect(tool).toContain(note);
  });
});

describe('decisionUnusedNote', () => {
  it('answered・declined・session_missing・requestId あり・decision なしは空', () => {
    expect(decisionUnusedNote('allow', undefined, 'answered')).toBe('');
    expect(decisionUnusedNote('allow', undefined, 'declined')).toBe('');
    expect(decisionUnusedNote('allow', undefined, 'session_missing')).toBe('');
    expect(decisionUnusedNote('allow', 'req-1', 'delivered')).toBe('');
    expect(decisionUnusedNote(undefined, undefined, 'delivered')).toBe('');
  });

  it('held は「預かった」、delivered は「届けた」と言う', () => {
    expect(decisionUnusedNote('allow', undefined, 'held')).toContain('預かった。');
    expect(decisionUnusedNote('allow', undefined, 'delivered')).toContain('届けた。');
  });
});
