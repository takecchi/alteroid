import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { InboxEvent } from './schema.js';
import { createMemoryStores } from './testing.js';


let messageSeq = 0;

interface FakeSession {
  rateLimit(info: Record<string, unknown>): Promise<void>;
}

function fakeSdk() {
  const sessions: FakeSession[] = [];

  const fn = ((params: { prompt: unknown; options?: Options }) => {
    let emit: ((message: SDKMessage | null) => void) | null = null;
    const buffered: SDKMessage[] = [];
    const sessionId = `sess-mgr-${sessions.length}`;
    const push = async (message: SDKMessage) => {
      if (emit) emit(message);
      else buffered.push(message);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    sessions.push({
      async rateLimit(info) {
        messageSeq += 1;
        await push({
          type: 'rate_limit_event',
          rate_limit_info: info,
          session_id: sessionId,
          uuid: `uuid-rl-${messageSeq}`,
        } as unknown as SDKMessage);
      },
    });

    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        uuid: `uuid-init-${sessionId}`,
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

async function setupTwoTokens(): Promise<{
  pool: ReturnType<typeof createManagerPool>;
  a: FakeSession;
  b: FakeSession;
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
  let active: { tokenId: string; generation: number } = { tokenId: 'tok-old', generation: 1 };
  const pool = createManagerPool({
    stores,
    post: (event) => inbox.push(event),
    runners: registry,
    tokenIdentity: () => active,
    synthesizedNoticeWindowMs: 100,
  });

  await pool.start({ request: '古い鍵で走り続ける委譲' });
  const a = await vi.waitFor(() => {
    const found = sessions[0];
    if (!found) throw new Error('1本目のセッションがまだ開いていない');
    return found;
  });

  active = { tokenId: 'tok-new', generation: 2 };
  await pool.start({ request: '新しい鍵で起きた委譲' });
  const b = await vi.waitFor(() => {
    const found = sessions[1];
    if (!found) throw new Error('2本目のセッションがまだ開いていない');
    return found;
  });

  return { pool, a, b, inbox };
}

function reports(inbox: InboxEvent[]): string[] {
  return inbox
    .filter((entry) => entry.type === 'manager_message' && entry.kind === 'report')
    .map((entry) => (entry as { text: string }).text);
}

function countReports(inbox: InboxEvent[], fragment: string): number {
  return reports(inbox).filter((text) => text.includes(fragment)).length;
}

const rejected = (kind: string) => ({ rateLimitType: kind, status: 'rejected' });
const allowed = (kind: string) => ({ rateLimitType: kind, status: 'allowed' });

const SENTINEL_KIND = 'seven_day_opus';
async function drain(session: FakeSession, inbox: InboxEvent[]): Promise<void> {
  const before = countReports(inbox, SENTINEL_KIND);
  await session.rateLimit(rejected(SENTINEL_KIND));
  await vi.waitFor(() => expect(countReports(inbox, SENTINEL_KIND)).toBe(before + 1), {
    timeout: 10_000,
  });
}

describe('枠の知らせ — 二重に配らない歯（トークンを跨がない）', () => {
  it('別のトークンで走る委譲の allowed は、枠が尽きた側の rejected の記憶を消さない', async () => {
    const s = await setupTwoTokens();
    try {
      await s.a.rateLimit(rejected('five_hour'));
      await vi.waitFor(() => expect(countReports(s.inbox, 'five_hour')).toBe(1), {
        timeout: 10_000,
      });

      await s.b.rateLimit(allowed('five_hour'));
      await s.a.rateLimit(rejected('five_hour'));
      await s.b.rateLimit(allowed('five_hour'));
      await s.a.rateLimit(rejected('five_hour'));

      await drain(s.a, s.inbox);

      expect(countReports(s.inbox, 'five_hour')).toBe(1);
    } finally {
      await s.pool.stop();
    }
  }, 30_000);
});

describe('枠の知らせ — 取りこぼさない歯', () => {
  it('同じトークンで枠が開いたと観測できたら、次に追い返されたときはもう一度配る', async () => {
    const s = await setupTwoTokens();
    try {
      await s.a.rateLimit(rejected('five_hour'));
      await vi.waitFor(() => expect(countReports(s.inbox, 'five_hour')).toBe(1), {
        timeout: 10_000,
      });

      await s.a.rateLimit(allowed('five_hour'));
      await s.a.rateLimit(rejected('five_hour'));

      await vi.waitFor(() => expect(countReports(s.inbox, 'five_hour')).toBe(2), {
        timeout: 10_000,
      });
    } finally {
      await s.pool.stop();
    }
  }, 30_000);

  it('別のトークンで同じ種類の枠に当たったら、それは新しい出来事として配る', async () => {
    const s = await setupTwoTokens();
    try {
      await s.a.rateLimit(rejected('five_hour'));
      await vi.waitFor(() => expect(countReports(s.inbox, 'five_hour')).toBe(1), {
        timeout: 10_000,
      });

      await s.b.rateLimit(rejected('five_hour'));

      await vi.waitFor(() => expect(countReports(s.inbox, 'five_hour')).toBe(2), {
        timeout: 10_000,
      });
    } finally {
      await s.pool.stop();
    }
  }, 30_000);
});
