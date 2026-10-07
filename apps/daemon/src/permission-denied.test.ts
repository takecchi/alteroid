import type { query as sdkQuery, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  createManagerPool,
  createRunnerHost,
  createRunnerRegistry,
  createMemoryStores,
  type InboxEvent,
  type JournalEntry,
  type Stores,
} from '@alteroid/core';
import { createRunnerApp, Outbox } from '@alteroid/runner';
import { afterEach, describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import { createHttpRunner } from './runner-client.js';

const TOKEN = 'test-runner-token';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function fakeSdk() {
  const sessions: { options: Options; push: (message: SDKMessage) => void }[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    const options = params.options ?? {};
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];

    sessions.push({
      options,
      push(message) {
        if (emit) emit(message);
        else buffered.push(message);
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      for (;;) {
        const next = buffered.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        const message = await new Promise<SDKMessage | null>((resolve) => {
          emit = resolve;
        });
        emit = null;
        if (message === null) return;
        yield message;
      }
    }

    return Object.assign(generate(), {
      close: () => emit?.(null),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

function fetchInto(app: ReturnType<typeof createRunnerApp>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    return app.request(`${url.pathname}${url.search}`, init as never);
  }) as typeof fetch;
}

interface Rig {
  pool: ReturnType<typeof createManagerPool>;
  stores: Stores;
  inbox: InboxEvent[];
  sessions: ReturnType<typeof fakeSdk>['sessions'];
  close(): Promise<void>;
}

const rigs: Rig[] = [];

afterEach(async () => {
  while (rigs.length > 0) await rigs.pop()?.close();
});

async function open(): Promise<Rig> {
  const { fn, sessions } = fakeSdk();
  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId: 'runner-primary',
    workspacePath: '/workspace',
    emit: (event) => outbox.push(event),
    queryFn: fn,
    env: { PATH: '/usr/bin' },
  });
  const app = createRunnerApp({ host, outbox, tokenSha256: TOKEN_SHA256 });
  const client = await createHttpRunner({
    baseUrl: 'http://runner.test',
    token: TOKEN,
    fetchFn: fetchInto(app),
  });

  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: createRunnerRegistry([client]),
  });

  const rig: Rig = {
    pool,
    stores,
    inbox,
    sessions,
    async close() {
      await pool.stop();
      await host.shutdown();
    },
  };
  rigs.push(rig);
  return rig;
}

async function deniedLines(stores: Stores): Promise<string[]> {
  const entries = (await stores.journal.list({ types: ['exchange'] })) as JournalEntry[];
  return entries
    .filter(
      (entry): entry is Extract<JournalEntry, { type: 'exchange' }> =>
        entry.type === 'exchange' && entry.text.includes('確認へ上がらずに止められた'),
    )
    .map((entry) => entry.text)
    .reverse();
}

async function noteLines(stores: Stores): Promise<string[]> {
  const entries = (await stores.journal.list({ types: ['exchange'] })) as JournalEntry[];
  return entries
    .filter(
      (entry): entry is Extract<JournalEntry, { type: 'exchange' }> =>
        entry.type === 'exchange' && entry.text.includes('先に降ろした'),
    )
    .map((entry) => entry.text)
    .reverse();
}

describe('確認へ上がらずに止められた実行（HTTP 境界）', () => {
  it('走行中の合図と result の記録が、境界越しに日誌と受信箱まで届く', async () => {
    const r = await open();
    const { managerId } = await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      tool_input: { file_path: 'apps/web/app/routes/chat.test.tsx' },
      session_id: 'sess-1',
      uuid: 'uuid-denied-1',
    } as unknown as SDKMessage);

    await expect.poll(async () => (await deniedLines(r.stores)).length, { timeout: 2000 }).toBe(1);
    const line = (await deniedLines(r.stores))[0];
    expect(line).toContain('欄=file_path');
    expect(line).toMatch(/chars=\d+/);
    expect(line).not.toContain('chat.test.tsx');

    session.push({
      type: 'result',
      subtype: 'success',
      result: '編集できなかったので報告する',
      permission_denials: [
        {
          tool_name: 'Edit',
          tool_use_id: 'toolu_1',
          tool_input: { file_path: 'apps/web/app/routes/chat.test.tsx' },
        },
        { tool_name: 'Edit', tool_use_id: 'toolu_2', tool_input: { file_path: 'b.tsx' } },
        { tool_name: 'Edit', tool_use_id: 'toolu_3', tool_input: { file_path: 'c.tsx' } },
      ],
      session_id: 'sess-1',
      uuid: 'uuid-result-1',
    } as unknown as SDKMessage);

    await expect
      .poll(
        () =>
          r.inbox.filter(
            (event) => event.type === 'manager_message' && event.text.includes('止められた'),
          ).length,
        { timeout: 2000 },
      )
      .toBe(2);
    const alerts = r.inbox.filter(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.text.includes('止められた'),
    );
    expect(alerts[0]).toMatchObject({ managerId, kind: 'report' });
    expect(alerts[0]?.text).toContain('1 件目');
    expect(alerts[1]).toMatchObject({ managerId, kind: 'report' });
    expect(alerts[1]?.text).toContain('3 件目');

    expect(await deniedLines(r.stores)).toHaveLength(3);
    expect(
      r.inbox.filter(
        (event) =>
          event.type === 'manager_message' && event.text === '編集できなかったので報告する',
      ),
    ).toHaveLength(1);
  }, 15_000);

  it('`tool_input` の無い走行中の合図でも、境界越しに日誌まで届く', async () => {
    const r = await open();
    await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      session_id: 'sess-1',
      uuid: 'uuid-denied-1',
    } as unknown as SDKMessage);

    await expect.poll(async () => (await deniedLines(r.stores)).length, { timeout: 2000 }).toBe(1);
    expect((await deniedLines(r.stores))[0]).toContain('Edit');
    expect((await deniedLines(r.stores))[0]).toContain('走行中の合図');
  }, 15_000);

  it('理由・分類・モデルへの拒否文が、境界越しに日誌まで届く', async () => {
    const r = await open();
    await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Edit',
      tool_use_id: 'toolu_1',
      decision_reason: 'この編集は許可されていないパスに触れている',
      decision_reason_type: 'rule',
      message: 'Edit was denied by a deny rule',
      session_id: 'sess-1',
      uuid: 'uuid-denied-1',
    } as unknown as SDKMessage);

    await expect.poll(async () => (await deniedLines(r.stores)).length, { timeout: 2000 }).toBe(1);
    const line = (await deniedLines(r.stores))[0];
    expect(line).toContain('Edit');
    expect(line).toContain('走行中の合図');
    expect(line).toContain('この編集は許可されていないパスに触れている');
    expect(line).toContain('rule');
    expect(line).toContain('Edit was denied by a deny rule');
  }, 15_000);

  it('理由の3欄が無い result の記録でも、作り物を足さずに境界越しに届く', async () => {
    const r = await open();
    await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push({
      type: 'result',
      subtype: 'success',
      result: '編集できなかったので報告する',
      permission_denials: [
        { tool_name: 'Edit', tool_use_id: 'toolu_1', tool_input: { file_path: 'a.tsx' } },
      ],
      session_id: 'sess-1',
      uuid: 'uuid-result-1',
    } as unknown as SDKMessage);

    await expect.poll(async () => (await deniedLines(r.stores)).length, { timeout: 2000 }).toBe(1);
    const line = (await deniedLines(r.stores))[0];
    expect(line).toContain('Edit');
    expect(line).not.toContain('分類:');
    expect(line).not.toContain('理由:');
    expect(line).not.toContain('モデルへの拒否文:');
    expect(line).not.toContain('（不明）');
  }, 15_000);

  it('先に届いた入力なしの拒否に、後から入力ありの記録が続くと、note が境界越しに日誌まで届く', async () => {
    const r = await open();
    await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    session.push({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      session_id: 'sess-1',
      uuid: 'uuid-denied-1',
    } as unknown as SDKMessage);
    await expect.poll(async () => (await deniedLines(r.stores)).length, { timeout: 2000 }).toBe(1);

    session.push({
      type: 'result',
      subtype: 'success',
      result: '終わった',
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'git diff' } },
      ],
      session_id: 'sess-1',
      uuid: 'uuid-result-1',
    } as unknown as SDKMessage);

    await expect.poll(async () => (await noteLines(r.stores)).length, { timeout: 2000 }).toBe(1);
    const note = (await noteLines(r.stores))[0];
    expect(note).toContain('Bash');
    expect(note).toContain('欄=command');
    expect(note).toContain('先頭の語=git');

    expect(await deniedLines(r.stores)).toHaveLength(1);
  }, 15_000);
});
