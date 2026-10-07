import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

const SPEND_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/settings/usage?from=cc_cli_limit_message";
const FIVE_HOUR_LIMIT = "You've reached your 5-hour limit · resets at 3pm";

interface FakeSession {
  rateLimit(info: Record<string, unknown>): Promise<void>;
  notify(text: string): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const push = async (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    sessions.push({
      async rateLimit(info) {
        await push({
          type: 'rate_limit_event',
          rate_limit_info: info,
          session_id: 'sess-mgr',
          uuid: `uuid-rl-${JSON.stringify(info).length}`,
        } as unknown as SDKMessage);
      },
      async notify(text) {
        await push({
          type: 'system',
          subtype: 'notification',
          text,
          session_id: 'sess-mgr',
          uuid: `uuid-note-${text.length}`,
        } as unknown as SDKMessage);
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

async function setup(): Promise<{
  pool: ReturnType<typeof createManagerPool>;
  stores: Stores;
  session: FakeSession;
  inbox: InboxEvent[];
}> {
  const { fn, sessions } = fakeSdk();
  const stores = createMemoryStores();
  const inbox: InboxEvent[] = [];
  const registry = createRunnerRegistry([
    createLocalRunner({
      runnerId: 'runner-test',
      workspacePath: '/work/project',
      queryFn: fn,
      env: { PATH: '/usr/bin' },
    }),
  ]);
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    synthesizedNoticeWindowMs: 100,
  });
  await pool.start({ request: '枠の知らせを観測する' });
  const session = await vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('セッションがまだ開いていない');
    return found;
  });
  return { pool, stores, session, inbox };
}

function reports(inbox: InboxEvent[]): string[] {
  return inbox
    .filter((entry) => entry.type === 'manager_message' && entry.kind === 'report')
    .map((entry) => (entry as { text: string }).text);
}

function countReports(inbox: InboxEvent[], fragment: string): number {
  return reports(inbox).filter((text) => text.includes(fragment)).length;
}

async function journalTexts(stores: Stores, fragment: string): Promise<string[]> {
  const entries = await stores.journal.list();
  return entries
    .map((entry) => ('text' in entry && typeof entry.text === 'string' ? entry.text : ''))
    .filter((text) => text.includes(fragment))
    .reverse();
}

describe('枠の知らせ — 二重に配らない歯', () => {
  it('status を運ばない観測が挟まっても、同じ rejected を二度配らない', async () => {
    const s = await setup();
    const rejected = {
      rateLimitType: 'five_hour',
      status: 'rejected',
      overageDisabledReason: 'org_level_disabled_until',
    };

    await s.session.rateLimit(rejected);
    await vi.waitFor(
      () => {
        expect(countReports(s.inbox, '枠から追い返された')).toBe(1);
      },
      { timeout: 4000 },
    );

    await s.session.rateLimit({ rateLimitType: 'five_hour', resetsAt: 1_770_000_000 });
    await s.session.rateLimit(rejected);

    await s.session.notify(SPEND_LIMIT);
    await vi.waitFor(
      () => {
        expect(countReports(s.inbox, '利用上限に当たった')).toBe(1);
      },
      { timeout: 4000 },
    );

    expect(countReports(s.inbox, '枠から追い返された')).toBe(1);

    await s.pool.stop();
  }, 12_000);

  it('同じ種類で文言が交互に届いても、配るのは初めて見た文言のときだけ', async () => {
    const s = await setup();

    await s.session.notify(SPEND_LIMIT);
    await s.session.notify(FIVE_HOUR_LIMIT);
    await vi.waitFor(
      () => {
        expect(countReports(s.inbox, '利用上限に当たった')).toBe(2);
      },
      { timeout: 8000 },
    );

    await s.session.notify(SPEND_LIMIT);
    await s.session.notify(FIVE_HOUR_LIMIT);
    await s.session.notify(SPEND_LIMIT);

    await s.session.rateLimit({ rateLimitType: 'five_hour', status: 'rejected' });
    await vi.waitFor(
      () => {
        expect(countReports(s.inbox, '枠から追い返された')).toBe(1);
      },
      { timeout: 4000 },
    );
    expect(countReports(s.inbox, '利用上限に当たった')).toBe(2);

    await s.pool.stop();
  }, 16_000);
});

describe('枠の知らせ — 取りこぼさない歯', () => {
  it('畳んだ分は1件ずつ日誌に残り、件数が次に配る1本の本文に載る', async () => {
    const s = await setup();

    await s.session.notify(SPEND_LIMIT);
    await vi.waitFor(
      () => {
        expect(countReports(s.inbox, '利用上限に当たった')).toBe(1);
      },
      { timeout: 4000 },
    );

    await s.session.notify(SPEND_LIMIT);
    await s.session.notify(SPEND_LIMIT);
    const folded = await vi.waitFor(async () => {
      const lines = await journalTexts(s.stores, '配達済みの知らせなので受信箱へは回さない');
      expect(lines.length).toBe(2);
      return lines;
    });
    expect(folded[0]).toContain('この種類で 1 件目');
    expect(folded[1]).toContain('この種類で 2 件目');
    expect(folded[1]).toContain(SPEND_LIMIT);

    await s.session.notify(FIVE_HOUR_LIMIT);
    const delivered = await vi.waitFor(
      () => {
        const found = reports(s.inbox).filter((text) => text.includes('利用上限に当たった'));
        expect(found.length).toBe(2);
        return found;
      },
      { timeout: 4000 },
    );
    expect(delivered[1]).toContain(FIVE_HOUR_LIMIT);
    expect(delivered[1]).toContain('2 件畳んでいる');

    await s.pool.stop();
  }, 12_000);

  it('枠が開いたと観測できたら、次に追い返されたときはもう一度配る', async () => {
    const s = await setup();
    const rejected = { rateLimitType: 'five_hour', status: 'rejected' };

    await s.session.rateLimit(rejected);
    await vi.waitFor(
      () => {
        expect(countReports(s.inbox, '枠から追い返された')).toBe(1);
      },
      { timeout: 4000 },
    );

    await s.session.rateLimit({ rateLimitType: 'five_hour', status: 'allowed' });
    await s.session.rateLimit(rejected);

    await vi.waitFor(
      () => {
        expect(countReports(s.inbox, '枠から追い返された')).toBe(2);
      },
      { timeout: 4000 },
    );

    await s.pool.stop();
  }, 12_000);
});
