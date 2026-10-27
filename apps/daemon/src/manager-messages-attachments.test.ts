import {
  createCloneTools,
  createLocalRunner,
  createManagerPool,
  createMemoryStores,
  createRunnerRegistry,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
} from '@alteroid/core';
import type {
  AttachmentLimits,
  CloneHost,
  RunnerAttachment,
  RunnerClient,
  RunnerEvent,
} from '@alteroid/core';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

// POST /managers/:id/messages の `attachments`。道具 `manager_send` と同じ検証（loadManagerAttachments）・同じ渡し方になる（#5317）。

const BYTES = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);

async function setup(attachmentLimits?: AttachmentLimits) {
  const stores = createMemoryStores();
  const sends: {
    managerId: string;
    text: string;
    attachments: readonly RunnerAttachment[] | undefined;
  }[] = [];
  const wired: { emit: ((event: RunnerEvent) => void) | null } = { emit: null };
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
      wired.emit = onEvent;
      onEvent({
        type: 'hello',
        runnerId: 'runner-x',
        capabilities: [RUNNER_CAPABILITY_MANAGER_ATTACHMENTS],
      });
    },
    async start(command: { cwd?: string }) {
      return { cwd: command.cwd };
    },
    async send(managerId: string, text: string, attachments?: readonly RunnerAttachment[]) {
      sends.push({ managerId, text, attachments });
      return true;
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
  const app = createApp({
    clone,
    stores,
    token: 'test-token',
    shutdown: () => {},
    ...(attachmentLimits === undefined ? {} : { attachmentLimits }),
  });
  const post = (managerId: string, body: unknown) =>
    app.request(`/managers/${managerId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
      body: JSON.stringify(body),
    });
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    memoryCause: () => 'clone',
    conversationId: () => undefined,
    managers: pool,
    ...(attachmentLimits === undefined ? {} : { attachmentLimits }),
  });
  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const tool = tools.find((t) => t.name === name);
    const out = await tool!.handler(args as never, {} as never);
    return out.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  };
  const { managerId } = await pool.start({ request: '調べて' });
  const putFile = (name: string) =>
    stores.attachments.put({ name, mediaType: 'text/plain', bytes: BYTES });
  return { stores, sends, post, callTool, managerId, putFile, wired };
}

describe('POST /managers/:id/messages の attachments', () => {
  it('(a) 添付付きの発言が、中身つきでマネージャーへ届き、日誌には参照だけが残る', async () => {
    const s = await setup();
    const meta = await s.putFile('build.log');
    const res = await s.post(s.managerId, { text: 'これを見て', attachments: [meta.id] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'delivered' });
    expect(s.sends).toHaveLength(1);
    expect(s.sends[0]?.attachments).toEqual([
      {
        id: meta.id,
        name: 'build.log',
        mediaType: 'text/plain',
        size: BYTES.length,
        sha256: meta.sha256,
        data: Buffer.from(BYTES).toString('base64'),
      },
    ]);
    const journal = await s.stores.journal.list();
    const outbound = journal.find((e) => e.type === 'exchange' && e.with === 'manager');
    expect(outbound).toMatchObject({
      role: 'outbound',
      attachments: [{ id: meta.id, name: 'build.log' }],
    });
    expect(JSON.stringify(journal)).not.toContain(Buffer.from(BYTES).toString('base64'));
  });

  it('(b) 存在しない id は 400 で、何も送られず日誌にも書かれない', async () => {
    const s = await setup();
    const meta = await s.putFile('a.txt');
    const before = (await s.stores.journal.list()).length;
    const res = await s.post(s.managerId, { text: 'x', attachments: [meta.id, 'no-such'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('no-such');
    expect(body.error).toContain('何も送っていない');
    expect(s.sends).toEqual([]);
    expect((await s.stores.journal.list()).length).toBe(before);
  });

  it('(b) 個数の上限を超えれば 400 で、何も送られない', async () => {
    const s = await setup({
      maxImageBytes: 1024,
      maxFileBytes: 1024,
      maxLargeFileBytes: 0,
      maxPerMessage: 1,
      maxTotalBytes: 1024,
      retentionDays: 30,
    });
    const a = await s.putFile('a.txt');
    const b = await s.putFile('b.txt');
    const res = await s.post(s.managerId, { text: 'x', attachments: [a.id, b.id] });
    expect(res.status).toBe(400);
    expect(s.sends).toEqual([]);
  });

  it('(b) 確認への回答（requestId / decision）に添付を付けると 400 で、何も送られない', async () => {
    const s = await setup();
    const meta = await s.putFile('a.txt');
    const withRequest = await s.post(s.managerId, {
      text: 'よい',
      requestId: 'req-1',
      decision: 'allow',
      attachments: [meta.id],
    });
    expect(withRequest.status).toBe(400);
    const withDecision = await s.post(s.managerId, {
      text: 'よい',
      decision: 'allow',
      attachments: [meta.id],
    });
    expect(withDecision.status).toBe(400);
    expect(s.sends).toEqual([]);
  });

  it('(b) 添付の要素が空文字なら 400（形の不正）', async () => {
    const s = await setup();
    const res = await s.post(s.managerId, { text: 'x', attachments: [''] });
    expect(res.status).toBe(400);
    expect(s.sends).toEqual([]);
  });

  it('(c) 添付なしは従来どおり届き、attachments 欄は載らない。空配列も同じ', async () => {
    const s = await setup();
    const none = await s.post(s.managerId, { text: '普通に' });
    expect(none.status).toBe(200);
    const empty = await s.post(s.managerId, { text: '空配列', attachments: [] });
    expect(empty.status).toBe(200);
    expect(s.sends.map((x) => x.attachments)).toEqual([undefined, undefined]);
  });

  it('(d) manager_send と同じ入力で、同じ添付が同じ形で届く。見つからない id の断り文も同じ', async () => {
    const s = await setup();
    const meta = await s.putFile('same.txt');
    const http = await s.post(s.managerId, { text: '同じ', attachments: [meta.id] });
    expect(http.status).toBe(200);
    const viaTool = await s.callTool('manager_send', {
      managerId: s.managerId,
      message: '同じ',
      attachments: [meta.id],
    });
    expect(viaTool).toContain('届けた');
    expect(s.sends).toHaveLength(2);
    expect(s.sends[0]?.attachments).toEqual(s.sends[1]?.attachments);

    const httpMissing = await s.post(s.managerId, { text: 'x', attachments: ['ghost'] });
    const toolMissing = await s.callTool('manager_send', {
      managerId: s.managerId,
      message: 'x',
      attachments: ['ghost'],
    });
    expect(((await httpMissing.json()) as { error: string }).error).toBe(toolMissing);
    expect(s.sends).toHaveLength(2);
  });
});
