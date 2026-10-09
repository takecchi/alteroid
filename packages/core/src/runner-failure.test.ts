import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createCredentialStore } from './credentials.js';
import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { captureStderr, createMemoryStores } from './testing.js';

const ORG_SPEND_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";

interface FakeSession {
  say(text: string, options?: { error?: string; parentToolUseId?: string }): Promise<void>;
  finish(text: string, options?: { subtype?: string; isError?: boolean }): Promise<void>;
  taskStarted(taskId: string, extra?: Record<string, unknown>): Promise<void>;
  taskNotification(taskId: string, options?: { status?: string; summary?: string }): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    // ポーリングにしない: `close()` で畳めず `pool.stop()` の後もジェネレータが生き残る
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    // `result` の `uuid` を固定しない: `manager.ts` が冪等化し、2回目以降の `finish()` が握りつぶされる
    let finishes = 0;
    const push = (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
    };

    sessions.push({
      async say(text, sayOptions = {}) {
        push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: sayOptions.parentToolUseId ?? null,
          session_id: 'sess-mgr',
          uuid: `uuid-say-${text.length}-${sayOptions.parentToolUseId ?? 'main'}-${Math.random()}`,
          ...(sayOptions.error === undefined ? {} : { error: sayOptions.error }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async finish(text, finishOptions = {}) {
        push({
          type: 'result',
          subtype: finishOptions.subtype ?? 'success',
          result: text,
          session_id: 'sess-mgr',
          uuid: `uuid-result-${(finishes += 1)}`,
          ...(finishOptions.isError === undefined ? {} : { is_error: finishOptions.isError }),
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async taskStarted(taskId, extra = {}) {
        push({
          type: 'system',
          subtype: 'task_started',
          task_id: taskId,
          description: '作業者への委譲',
          uuid: `uuid-task-started-${taskId}`,
          session_id: 'sess-mgr',
          ...extra,
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async taskNotification(taskId, notificationOptions = {}) {
        push({
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          status: notificationOptions.status ?? 'completed',
          summary: notificationOptions.summary ?? '',
          output_file: '/tmp/fake-output',
          uuid: `uuid-task-notification-${taskId}-${Math.random()}`,
          session_id: 'sess-mgr',
        } as unknown as SDKMessage);
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-mgr',
        uuid: 'uuid-init',
      } as unknown as SDKMessage;

      void (async () => {
        for await (const message of params.prompt as AsyncIterable<unknown>) void message;
      })();

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

    const generator = generate();
    return Object.assign(generator, {
      close: () => {
        if (emit) emit(null);
      },
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;

  return { fn, sessions };
}

// 0 に近づけない: `usage_notice` と `turn_failed` が同じ窓で1件にまとまることに頼っており、短すぎると2件に割れて揺れる
const TEST_NOTICE_WINDOW_MS = 100;

function setup(options: { withCredentialStore?: boolean } = {}): {
  pool: ReturnType<typeof createManagerPool>;
  stores: Stores;
  sessions: FakeSession[];
  inbox: InboxEvent[];
} {
  const { fn, sessions } = fakeSdk();
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const registry = createRunnerRegistry([
    createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: fn,
      env: { PATH: '/usr/bin' },
      ...(options.withCredentialStore === true
        ? {
            credentials: createCredentialStore({
              dir: join(tmpdir(), 'alteroid-4112-unused'),
              seed: {},
            }),
          }
        : {}),
    }),
  ]);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    synthesizedNoticeWindowMs: TEST_NOTICE_WINDOW_MS,
  });
  return { pool, stores, sessions, inbox };
}

async function jobOf(stores: Stores, managerId: string) {
  return (await stores.jobs.listJobs()).find((job) => job.id === managerId);
}

// `find` で最初の1本を取らない: 枠の知らせ（`usage_notice`）も同じ `kind: 'report'` で先に届く
async function reportTexts(inbox: InboxEvent[], expected: number): Promise<string[]> {
  return await vi.waitFor(
    () => {
      const found = inbox.filter(
        (entry) => entry.type === 'manager_message' && entry.kind === 'report',
      );
      if (found.length < expected) {
        throw new Error(
          `報告が ${String(expected)} 本届いていない（いま ${String(found.length)} 本）`,
        );
      }
      return found.map((entry) => (entry as { text: string }).text);
    },
    { timeout: 4000 },
  );
}

// 完全に同一な turn_failed の2件目は受信箱へ回らず日誌にだけ残るので、受信箱の件数ではなく日誌で待つ
async function waitForSuppressedTurnFailed(stores: Stores, count: number): Promise<void> {
  await vi.waitFor(
    async () => {
      const entries = await stores.journal.list({ types: ['exchange'] });
      const suppressed = entries.filter((entry) =>
        JSON.stringify(entry).includes('受信箱へは回さず数だけ残した'),
      );
      if (suppressed.length < count) {
        throw new Error(
          `畳んだ記録が ${String(count)} 件届いていない（いま ${String(suppressed.length)} 件）`,
        );
      }
    },
    { timeout: 4000 },
  );
}

describe('分類できなかった失敗の跡（回し手には届かない側）', () => {
  it('枠の文言として分類できた回は跡を残さない（出す判断を変えていない）', async () => {
    const lines = await captureStderr(async () => {
      const s = setup();
      await s.pool.start({ request: '調べて' });
      const session = await vi.waitFor(() => {
        const found = s.sessions[0];
        if (!found) throw new Error('セッションがまだ開いていない');
        return found;
      });
      await session.finish(ORG_SPEND_LIMIT, { isError: true });
      await reportTexts(s.inbox, 1);
      await s.pool.stop();
    });
    expect(lines.join('\n')).not.toContain('枠の文言として分類できなかった');
  });

  it('(#4112) 鍵の器が無い器で Not logged in が来たら、失敗の報告に鍵の置き場の案内を足す', async () => {
    await captureStderr(async () => {
      const s = setup();
      await s.pool.start({ request: '調べて' });
      const session = await vi.waitFor(() => {
        const found = s.sessions[0];
        if (!found) throw new Error('セッションがまだ開いていない');
        return found;
      });
      await session.finish('Not logged in · Please run /login', { isError: true });
      const [text] = await reportTexts(s.inbox, 1);
      expect(text).toContain('Not logged in');
      expect(text).toContain(
        '鍵の置き場（ALTEROID_CREDENTIAL_DIR）が無いと、ローカル runner のマネージャーへ鍵が届かない',
      );
      await s.pool.stop();
    });
  });

  it('(#4112) 鍵の器が在る器では、Not logged in でも案内を足さない', async () => {
    await captureStderr(async () => {
      const s = setup({ withCredentialStore: true });
      await s.pool.start({ request: '調べて' });
      const session = await vi.waitFor(() => {
        const found = s.sessions[0];
        if (!found) throw new Error('セッションがまだ開いていない');
        return found;
      });
      await session.finish('Not logged in · Please run /login', { isError: true });
      const [text] = await reportTexts(s.inbox, 1);
      expect(text).toContain('Not logged in');
      expect(text).not.toContain('ALTEROID_CREDENTIAL_DIR');
      await s.pool.stop();
    });
  });

  it('(#4112) 鍵の器が無い器でも、Not logged in 以外の失敗には案内を足さない', async () => {
    await captureStderr(async () => {
      const s = setup();
      await s.pool.start({ request: '調べて' });
      const session = await vi.waitFor(() => {
        const found = s.sessions[0];
        if (!found) throw new Error('セッションがまだ開いていない');
        return found;
      });
      await session.finish('', { isError: true });
      const [text] = await reportTexts(s.inbox, 1);
      expect(text).not.toContain('ALTEROID_CREDENTIAL_DIR');
      await s.pool.stop();
    });
  });

  it('分類できなかった回は初出で1行出し、同じ組の2回目は出さない', async () => {
    const lines = await captureStderr(async () => {
      const s = setup();
      await s.pool.start({ request: '調べて' });
      const session = await vi.waitFor(() => {
        const found = s.sessions[0];
        if (!found) throw new Error('セッションがまだ開いていない');
        return found;
      });
      await session.finish('', { isError: true });
      await reportTexts(s.inbox, 1);
      await session.finish('', { isError: true });
      await waitForSuppressedTurnFailed(s.stores, 1);
      await s.pool.stop();
    });
    const first = lines.filter((line) => line.includes('（初出。**回し手には届かない**）'));
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('via=result_is_error');
    expect(first[0]).toContain('code=success');
    expect(first[0]).not.toContain(ORG_SPEND_LIMIT);
  }, 12_000);

  it('stop() で畳まれても件数が出る（この経路は #finish を通らない）', async () => {
    const lines = await captureStderr(async () => {
      const s = setup();
      await s.pool.start({ request: '調べて' });
      const session = await vi.waitFor(() => {
        const found = s.sessions[0];
        if (!found) throw new Error('セッションがまだ開いていない');
        return found;
      });
      await session.finish('', { isError: true });
      await reportTexts(s.inbox, 1);
      await session.finish('', { isError: true });
      await waitForSuppressedTurnFailed(s.stores, 1);
      await s.pool.stop();
    });
    const summary = lines.filter((line) => line.includes('このセッションの合計'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain('result_is_error:success×2');
  }, 12_000);
});

describe('マネージャーの報告 — SDK のエラーを報告として扱わない', () => {
  it('assistant.error が付いた本文は報告に混ぜず、失敗として包んで上げる', async () => {
    const s = setup();
    const started = await s.pool.start({ request: 'ログイン周りを直して' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.say('途中まではここまでやった');
    await session.say(ORG_SPEND_LIMIT, { error: 'billing_error' });
    await session.finish('');

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toContain('利用上限に当たった');

    expect(text).toContain('応答を返さずに終わった');
    expect(text).toContain('billing_error');
    expect(text).toContain(ORG_SPEND_LIMIT);
    expect(text).toContain('途中まではここまでやった');
    const partial = text.split('（失敗する前に出ていた本文）')[1] ?? '';
    expect(partial).toContain('途中まではここまでやった');
    expect(partial).not.toContain(ORG_SPEND_LIMIT);

    const job = await vi.waitFor(async () => {
      const found = await jobOf(s.stores, started.managerId);
      if (!found?.lastFailure) throw new Error('台帳にまだ載っていない');
      return found;
    });
    expect(job.lastFailure).toMatchObject({ code: 'billing_error', via: 'assistant_error' });
    expect(job.status).toBe('done');

    await s.pool.stop();
  });

  it('subtype:success でも is_error が立っていれば報告として扱わない', async () => {
    const s = setup();
    const started = await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.finish(ORG_SPEND_LIMIT, { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toContain('応答を返さずに終わった');
    expect(text).toContain('result_is_error');

    const job = await vi.waitFor(async () => {
      const found = await jobOf(s.stores, started.managerId);
      if (!found?.lastFailure) throw new Error('台帳にまだ載っていない');
      return found;
    });
    expect(job.lastFailure?.via).toBe('result_is_error');

    await s.pool.stop();
  });

  it('成功したターンでは包まず、台帳の lastFailure も消える（「直近」の意味を守る）', async () => {
    const s = setup();
    const started = await s.pool.start({ request: '2回に分けて答えて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.finish(ORG_SPEND_LIMIT, { isError: true });
    await vi.waitFor(async () => {
      const job = await jobOf(s.stores, started.managerId);
      if (!job?.lastFailure) throw new Error('まだ失敗が載っていない');
      return job;
    });

    await session.say('直した');
    await session.finish('直した');

    const job = await vi.waitFor(async () => {
      const found = await jobOf(s.stores, started.managerId);
      if (found?.lastReport !== '直した') throw new Error('2回目の報告がまだ載っていない');
      return found;
    });
    expect(job.lastFailure).toBeUndefined();
    expect(job.lastReport).not.toContain('応答を返さずに終わった');

    await s.pool.stop();
  });
});

describe('失敗で終わった回は畳まれない', () => {
  it('本文が丸ごと空（said も result も空）でも、失敗した回はクローンへ届く', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    expect(texts[0]).toContain('応答を返さずに終わった');
    expect(texts[0]).toContain('result_is_error');

    await s.pool.stop();
  });
});

describe('失敗で終わったターンの本文に、そのターンで開いた作業者の数を添える（#1373）', () => {
  const BASELINE_FAILURE_TEXT =
    '（このターンは応答を返さずに終わった: success / result_is_error）\n（報告なし）';

  it('作業者を2体開いたターンが失敗で終わると、本文に「作業者が2体開いていた」の1行が付く（同じ task_id の重複は1と数える）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.taskStarted('task-2');
    await session.taskStarted('task-1');
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者が 2 体開いていた。どちらが当たったかは SDK からは分からない）`,
    );

    await s.pool.stop();
  });

  it('本体自身の発言にも SDK の拒否の印が付いていれば（via: assistant_error）、状況証拠の行は「作業者が当たったかは分からないが、本体は当たっている」の意味になる（openedWorkers だけの経路。Issue #1373 続きのコメント）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.taskStarted('task-2');
    await session.say('本体の枠の文言', { error: 'billing_error' });
    await session.finish('');

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n本体の枠の文言\n（このターンでは作業者が 2 体開いていた。作業者が当たったかは SDK からは分からないが、本体の発言には拒否の印が付いていたので、本体は当たっている）',
    );
    expect(text).not.toContain('どちらが当たったかは SDK からは分からない');

    await s.pool.stop();
  });

  it('陽性対照A: 作業者を開いていないターンが失敗で終わっても、本文は従来と1文字も変わらない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(BASELINE_FAILURE_TEXT);
    expect(text).not.toContain('体開いていた');

    await s.pool.stop();
  });

  it('陽性対照B: 作業者を開いたターンが成功で終わったら、報告の本文にその1行は付かない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.taskStarted('task-2');
    await session.finish('作業者からの結果を踏まえて完了した');

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe('作業者からの結果を踏まえて完了した');
    expect(text).not.toContain('体開いていた');
    expect(text).not.toContain('SDK からは分からない');

    await s.pool.stop();
  });

  it('ターンをまたいで数が持ち越されない（前のターンで開いた作業者は、次のターンの N に入らない）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.finish('1ターン目は成功した');
    await reportTexts(s.inbox, 1);

    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 2);
    const text = texts[1] ?? '';
    expect(text).toBe(BASELINE_FAILURE_TEXT);
    expect(text).not.toContain('体開いていた');

    await s.pool.stop();
  });

  it('作業者の発言に拒否の印が付いたターンが失敗で終わると、状況証拠の行の代わりに「作業者の発言に拒否の印が付いていた」の行が付く（種類ごとに件数で畳む）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.say('作業者の枠の文言', { error: 'rate_limit', parentToolUseId: 'toolu-1' });
    await session.say('作業者の枠の文言', { error: 'rate_limit', parentToolUseId: 'toolu-2' });
    await session.say('課金', { error: 'billing_error', parentToolUseId: 'toolu-2' });
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: rate_limit ×2 / billing_error ×1。作業者が当たったことは確かだが、本体も当たったかは SDK からは分からない）`,
    );
    expect(text).not.toContain('作業者の枠の文言');

    await s.pool.stop();
  });

  it('本体自身の発言にも SDK の拒否の印が付いていれば（via: assistant_error）、「本体も当たったかは分からない」ではなく「本体も当たっている」と言い切る（Issue #1373 続きのコメント）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.say('作業者の枠の文言', { error: 'rate_limit', parentToolUseId: 'toolu-1' });
    await session.say('本体の枠の文言', { error: 'billing_error' });
    await session.finish('');

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n本体の枠の文言\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: rate_limit ×1。作業者が当たったことは確かで、本体の発言にも拒否の印が付いていたので、本体も当たっている）',
    );
    expect(text).not.toContain('分からない');

    await s.pool.stop();
  });

  it('作業者の発言に拒否の印が付いても、ターンが成功で終わったら失敗にはならず、行も付かない（本体は作業者を立て直して進めることがある）', async () => {
    const s = setup();
    const started = await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.say('作業者の枠の文言', { error: 'rate_limit', parentToolUseId: 'toolu-1' });
    await session.say('作業者を立て直して終えた');
    await session.finish('作業者を立て直して終えた');

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe('作業者を立て直して終えた');
    const job = await jobOf(s.stores, started.managerId);
    expect(job?.lastFailure).toBeUndefined();

    await s.pool.stop();
  });

  it('作業者の拒否の印はターンをまたいで持ち越されない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.say('作業者の枠の文言', { error: 'rate_limit', parentToolUseId: 'toolu-1' });
    await session.say('1回目');
    await session.finish('1回目');
    await reportTexts(s.inbox, 1);

    await session.finish('', { isError: true });
    const texts = await reportTexts(s.inbox, 2);
    expect(texts[1]).toBe(BASELINE_FAILURE_TEXT);

    await s.pool.stop();
  });
});

describe('openedWorkers は作業者（local_agent）のタスクだけを数える（Issue #2113）', () => {
  const BASELINE_FAILURE_TEXT =
    '（このターンは応答を返さずに終わった: success / result_is_error）\n（報告なし）';

  it('task_type: local_bash の task_started では「N 体開いていた」が付かない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('bash-task-1', { task_type: 'local_bash' });
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    expect(texts[0]).toBe(BASELINE_FAILURE_TEXT);
    expect(texts[0]).not.toContain('体開いていた');

    await s.pool.stop();
  });

  it('task_type: local_agent の task_started は従来どおり数える', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('agent-task-1', { task_type: 'local_agent' });
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    expect(texts[0]).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者が 1 体開いていた。どちらが当たったかは SDK からは分からない）`,
    );

    await s.pool.stop();
  });

  it('task_type を名乗らない task_started は、これまでどおり作業者として数える', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('untyped-task-1');
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    expect(texts[0]).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者が 1 体開いていた。どちらが当たったかは SDK からは分からない）`,
    );

    await s.pool.stop();
  });

  it('作業者を開いた区間で local_bash が failed で終わっても、作業者の failed 通知にも枠の件数にも数えない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('agent-task-1', { task_type: 'local_agent' });
    await session.taskStarted('bash-task-1', { task_type: 'local_bash' });
    await session.taskNotification('bash-task-1', {
      status: 'failed',
      summary: `Agent terminated early due to an API error: ${ORG_SPEND_LIMIT} (error type rate_limit, HTTP 429)`,
    });
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    expect(texts[0]).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者が 1 体開いていた。どちらが当たったかは SDK からは分からない）`,
    );

    await s.pool.stop();
  });

  it('陽性対照: local_agent と task_type を名乗らない task の failed 通知は従来どおり数える', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('agent-task-1', { task_type: 'local_agent' });
    await session.taskStarted('untyped-task-1');
    await session.taskNotification('agent-task-1', { status: 'failed', summary: '失敗' });
    await session.taskNotification('untyped-task-1', { status: 'failed', summary: '失敗' });
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    expect(texts[0]).toContain('作業者 2 体が失敗で終わった');

    await s.pool.stop();
  });
});

describe("失敗で終わったターンの本文に、task_notification の status:'failed' を状況証拠として添える（#1373 続き）", () => {
  const BASELINE_FAILURE_TEXT =
    '（このターンは応答を返さずに終わった: success / result_is_error）\n（報告なし）';

  it('🔴 #1569: 同じ taskId の failed 通知が2回届いても、作業者の数を水増ししない', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });
    await session.taskStarted('task-1');
    await session.taskNotification('task-1', { status: 'failed', summary: '何か失敗した' });
    await session.taskNotification('task-1', { status: 'failed', summary: '何か失敗した' });
    await session.finish('', { isError: true });
    const text = (await reportTexts(s.inbox, 1))[0] ?? '';
    expect(text).toContain('1 体が失敗で終わった');
    await s.pool.stop();
  });

  it("作業者2体の通知が status:'failed' で終わると、状況証拠の行が「作業者が2体開いていた」から「作業者が2体、失敗で終わった」へ変わる（枠を名乗る文言が無ければ内訳は付けない）", async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.taskStarted('task-2');
    await session.taskNotification('task-1', { status: 'failed', summary: '何か失敗した' });
    await session.taskNotification('task-2', { status: 'failed', summary: '別の失敗' });
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者 2 体が失敗で終わった。本体も当たったかは SDK からは分からない）`,
    );
    expect(text).not.toContain('体開いていた');
    expect(text).not.toContain('枠(429)');

    await s.pool.stop();
  });

  it('本体自身の発言にも SDK の拒否の印が付いていれば（via: assistant_error）、「本体も当たったかは分からない」ではなく「本体も当たっている」と言い切る（failedWorkerNotifications の経路。Issue #1373 続きのコメント）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.taskNotification('task-1', { status: 'failed', summary: '何か失敗した' });
    await session.say('本体の枠の文言', { error: 'billing_error' });
    await session.finish('');

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n本体の枠の文言\n（このターンでは作業者 1 体が失敗で終わった。本体の発言にも拒否の印が付いていたので、本体も当たっている）',
    );
    expect(text).not.toContain('本体も当たったかは SDK からは分からない');

    await s.pool.stop();
  });

  it('failed の通知の要旨が枠(429)を名乗っていれば、その件数も添える（classifyUsageNotice が拾う文言だけを名乗ったと数える）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.taskStarted('task-2');
    await session.taskStarted('task-3');
    // 名乗る側を2件・名乗らない側を1件にする: 1件だけだと判定を反転しても件数が変わらず、検算をすり抜ける
    await session.taskNotification('task-1', {
      status: 'failed',
      summary: `Agent terminated early due to an API error: ${ORG_SPEND_LIMIT} (error type rate_limit, HTTP 429, request id req_1, model sent to the API: claude-sonnet-5)`,
    });
    await session.taskNotification('task-2', {
      status: 'failed',
      summary: `Agent terminated early due to an API error: ${ORG_SPEND_LIMIT} (error type rate_limit, HTTP 429, request id req_2, model sent to the API: claude-sonnet-5)`,
    });
    await session.taskNotification('task-3', { status: 'failed', summary: 'ネットワークが切れた' });
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者 3 体が失敗で終わった（うち 2 体は枠(429)を名乗った）。本体も当たったかは SDK からは分からない）`,
    );

    await s.pool.stop();
  });

  it("陽性対照: status が 'completed' の通知だけなら、失敗ターンの本文は従来どおり「作業者が開いていた」の行のまま", async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.taskNotification('task-1', { status: 'completed', summary: '完了した' });
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者が 1 体開いていた。どちらが当たったかは SDK からは分からない）`,
    );
    expect(text).not.toContain('失敗で終わった');

    await s.pool.stop();
  });

  it('優先順位: 作業者自身の発言に拒否の印（#1466 の経路）が付いていれば、task_notification 側の行より優先される', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.say('作業者の枠の文言', { error: 'rate_limit', parentToolUseId: 'toolu-1' });
    await session.taskNotification('task-1', { status: 'failed', summary: ORG_SPEND_LIMIT });
    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 1);
    const text = texts[0] ?? '';
    expect(text).toBe(
      `${BASELINE_FAILURE_TEXT}\n（このターンでは作業者の発言に SDK の拒否の印が付いていた: rate_limit ×1。作業者が当たったことは確かだが、本体も当たったかは SDK からは分からない）`,
    );
    expect(text).not.toContain('失敗で終わった');

    await s.pool.stop();
  });

  it('ターンをまたいで数が持ち越されない（前のターンの failed 通知は、次のターンの本文に出ない）', async () => {
    const s = setup();
    await s.pool.start({ request: '調べて' });
    const session = await vi.waitFor(() => {
      const found = s.sessions[0];
      if (!found) throw new Error('セッションがまだ開いていない');
      return found;
    });

    await session.taskStarted('task-1');
    await session.taskNotification('task-1', { status: 'failed', summary: ORG_SPEND_LIMIT });
    await session.finish('1ターン目は成功した');
    await reportTexts(s.inbox, 1);

    await session.finish('', { isError: true });

    const texts = await reportTexts(s.inbox, 2);
    const text = texts[1] ?? '';
    expect(text).toBe(BASELINE_FAILURE_TEXT);
    expect(text).not.toContain('失敗で終わった');

    await s.pool.stop();
  });
});
