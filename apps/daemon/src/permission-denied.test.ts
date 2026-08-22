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

/**
 * **確認へ上がらずに止められた実行が、境界越しでクローンまで届くこと。**
 *
 * `permissionMode: 'auto'` では、SDK が自分で拒否したものは `canUseTool` を
 * 通らずその場で止まる。同一プロセスで届くだけでは足りない — デーモンと runner の
 * 間は JSON なので、**降ろす形が境界のスキーマを通らないとコンテナ構成でだけ
 * 消える**（そして消えたことは誰にも見えない）。ここは本物の HTTP を通す。
 *
 * SDK だけが偽物である（`runner-client.test.ts` と同じ形）。
 */

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

/** hono のアプリへ直に流す fetch（ソケットを開かずに本物の HTTP 経路を通す）。 */
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

describe('確認へ上がらずに止められた実行（HTTP 境界）', () => {
  it('走行中の合図と result の記録が、境界越しに日誌と受信箱まで届く', async () => {
    const r = await open();
    const { managerId } = await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 走行中の合図（分類器がその場で止めた）
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
    expect((await deniedLines(r.stores))[0]).toContain('chat.test.tsx');

    // ターン終わりの記録。走行中に見た1件は二度上げず、見ていなかった1件を拾う
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

    // 3件で受信箱が鳴る（同じ道具が繰り返し止められている形）
    await expect
      .poll(
        () =>
          r.inbox.filter(
            (event) => event.type === 'manager_message' && event.text.includes('止められた'),
          ).length,
        { timeout: 2000 },
      )
      .toBe(1);
    const alert = r.inbox.find(
      (event): event is Extract<InboxEvent, { type: 'manager_message' }> =>
        event.type === 'manager_message' && event.text.includes('止められた'),
    );
    expect(alert).toMatchObject({ managerId, kind: 'report' });
    expect(alert?.text).toContain('3 件目');

    // 日誌には3件（重複した toolu_1 は1件のまま）
    expect(await deniedLines(r.stores)).toHaveLength(3);
    // マネージャー自身の報告も従来どおり届く
    expect(
      r.inbox.filter(
        (event) =>
          event.type === 'manager_message' && event.text === '編集できなかったので報告する',
      ),
    ).toHaveLength(1);
  }, 15_000);

  /**
   * **回帰: `tool_input` を持たない走行中の合図が、HTTP 境界を越えて捨てられる。**
   *
   * SDK の実際の `SDKPermissionDeniedMessage` には `tool_input` フィールドが
   * 無い。上のテストは `tool_input` を手で渡していたので、`input` というキーが
   * 常に存在する形でしかこの境界を通していなかった。実機では `input` が
   * `undefined` になり、`JSON.stringify`（`apps/runner/src/app.ts`）がキーごと
   * 落とすので、`runnerEventSchema` が `input` を必須のまま持っていると
   * （zod 4 はキーの不在を許さない）`safeParse` が失敗し、拒否が丸ごと
   * デーモンに届かなかった。
   */
  it('`tool_input` の無い走行中の合図でも、境界越しに日誌まで届く', async () => {
    const r = await open();
    await r.pool.start({ request: 'テストを直して' });
    await expect.poll(() => r.sessions.length, { timeout: 2000 }).toBe(1);
    const session = r.sessions[0];
    if (!session) throw new Error('マネージャーのセッションが無い');

    // 走行中の合図（実機の SDK が実際に送ってくる形。`tool_input` を持たない）
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
});
