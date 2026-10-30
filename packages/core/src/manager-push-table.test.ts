import type { Options, Query, SDKMessage, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createManagerPool } from './manager.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores } from './testing.js';

// runner へ設定を置く処理（`#push*`）の、呼ぶ順序・失敗の文言・失敗したときの続け方・帳面への記録を縛る（#5871）。
// 置き場が `#connectTo`（繋いだとき）と `#reattach`（繋ぎ直したとき）の2か所にあるので、両方で同じ並びになることを見る。

const PREFIX_ORDER = [
  'credentials',
  'profile',
  'mcpServers',
  'plugins',
  'permissionRules',
  'codexAuth',
  'agentToken',
] as const;

type Kind = (typeof PREFIX_ORDER)[number];

/** 失敗の日誌の本文（`#journalPushFailure` の `body`）。`${reason}` は投げた理由。 */
const FAILURE_BODIES: Record<Exclude<Kind, 'codexAuth'>, (reason: string) => string> = {
  profile: (reason) => `runner-test へ実行環境プロファイルを降ろせなかった: ${reason}`,
  credentials: (reason) =>
    `runner-test へマネージャーの環境変数を降ろせなかった（この runner で起こすマネージャーは、器の環境変数に在るものだけで走る）: ${reason}`,
  mcpServers: (reason) =>
    `runner-test へ MCP サーバの登録を降ろせなかった（この runner で起こすマネージャー・作業者は、記憶ストアの登録を持たずに走る）: ${reason}`,
  plugins: (reason) =>
    `runner-test へ plugin を降ろせなかった（この runner で起こすマネージャー・作業者は、記憶ストアの plugin を持たずに走る）: ${reason}`,
  permissionRules: (reason) =>
    `runner-test へ委譲先の許可規則を降ろせなかった（この runner で起こすマネージャー・作業者には、人間が承認した許可が規則として載っていない。前に降りた一覧が残っていればそれが効いている）: ${reason}`,
  agentToken: (reason) =>
    `runner-test に認証トークンを降ろせなかった（この runner で起こすマネージャーは、器の環境変数に認証トークンが入っていればそれで走り、入っていなければ資格を1つも持たずに走る——どちらになるかは器の env 次第で、ここからは分からない）: ${reason}`,
};

function fakeSdk(): typeof sdkQuery {
  return ((input: { options: Options }) => {
    void input;
    let finish: (() => void) | undefined;
    async function* generate(): AsyncGenerator<SDKMessage, void> {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        uuid: 'uuid-1',
      } as unknown as SDKMessage;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    return Object.assign(generate(), {
      close: () => finish?.(),
      interrupt: async () => undefined,
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
}

function setup(failing: ReadonlySet<Kind> = new Set()) {
  const stores = createMemoryStores();
  const runner = createLocalRunner({
    runnerId: 'runner-test',
    workspacePath: '/work/project',
    queryFn: fakeSdk(),
    env: { PATH: '/usr/bin' },
  });
  const registry = createRunnerRegistry([runner]);
  const calls: Kind[] = [];
  const sync =
    (kind: Kind, ok: unknown = undefined) =>
    async (): Promise<unknown> => {
      calls.push(kind);
      if (failing.has(kind)) throw new Error(`${kind} failed (test)`);
      return ok;
    };
  const pool = createManagerPool({
    stores,
    post: () => undefined,
    runners: registry,
    credentials: { syncRunner: sync('credentials') } as never,
    profile: { syncRunner: sync('profile', null) } as never,
    mcpServers: { syncRunner: sync('mcpServers') } as never,
    plugins: { syncRunner: sync('plugins') } as never,
    permissionRules: { syncRunner: sync('permissionRules') } as never,
    codexAuth: { syncRunner: sync('codexAuth') } as never,
    syncRunnerToken: async () => {
      await sync('agentToken')();
    },
  });
  return { stores, pool, calls };
}

async function journalTexts(stores: ReturnType<typeof setup>['stores']): Promise<string[]> {
  const entries = await stores.journal.list({ types: ['exchange'], limit: 10_000 });
  return entries.flatMap((entry) => ('text' in entry ? [entry.text] : []));
}

/**
 * 開始の直後は、繋いだときと繋ぎ直しが重なって2周ぶん並ぶことがある（周ごとの順は同じなので、混ざっても順は後戻りしない）。
 * 後戻りしないこと・全部の種類が呼ばれていることを見る。
 */
function expectPushOrder(calls: readonly Kind[]): void {
  const indexes = calls.map((kind) => PREFIX_ORDER.indexOf(kind));
  expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  expect(new Set(calls)).toEqual(new Set(PREFIX_ORDER));
}

describe('runner へ設定を置く並び（#5871）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-30T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('繋いだ runner へは、鍵 → プロファイル → MCP → plugin → 許可規則 → codex 認証 → 認証トークンの順に置く（#4841）', async () => {
    const s = setup();

    await s.pool.start({ request: '走る' });

    expectPushOrder(s.calls);
    await s.pool.stop();
  });

  it('繋ぎ直した runner へも、繋いだときと同じ並びで置く', async () => {
    const s = setup();
    await s.pool.start({ request: '走る' });
    s.calls.length = 0;

    await s.pool.reattachRunner('runner-test');

    expect(s.calls).toEqual([...PREFIX_ORDER]);
    await s.pool.stop();
  });

  it('1つ失敗しても残りは同じ順で置き続け、種類ごとに帳面へ failed を記録し、文言どおりの日誌を1行ずつ書く', async () => {
    const failing = new Set<Kind>([
      'credentials',
      'profile',
      'mcpServers',
      'plugins',
      'permissionRules',
      'agentToken',
    ]);
    const s = setup(failing);

    await s.pool.start({ request: '走る' });

    expectPushOrder(s.calls);
    const health = s.pool.pushHealthOf('runner-test');
    const texts = await journalTexts(s.stores);
    for (const kind of Object.keys(FAILURE_BODIES) as (keyof typeof FAILURE_BODIES)[]) {
      // `reasonOf` は Error を `Error: 本文` の形に書く。
      const reason = `Error: ${kind} failed (test)`;
      expect(health?.[kind]).toEqual({
        status: 'failed',
        at: '2026-10-30T00:00:00.000Z',
        error: reason,
      });
      expect(texts.filter((text) => text.includes(FAILURE_BODIES[kind](reason)))).toHaveLength(1);
    }
    await s.pool.stop();
  });

  it('成功した種類は帳面へ ok を記録し、日誌には失敗の行を書かない', async () => {
    const s = setup();

    await s.pool.start({ request: '走る' });

    const health = s.pool.pushHealthOf('runner-test');
    for (const kind of [
      'credentials',
      'profile',
      'mcpServers',
      'plugins',
      'permissionRules',
      'agentToken',
    ] as const) {
      expect(health?.[kind]).toEqual({ status: 'ok', at: '2026-10-30T00:00:00.000Z' });
    }
    const texts = await journalTexts(s.stores);
    expect(texts.filter((text) => text.includes('降ろせなかった'))).toEqual([]);
    await s.pool.stop();
  });
});
