import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { BASH_ENV_GUARD_ENV } from './bash-env-guard.js';
import { createClone } from './clone.js';
import { fakeSdk, setup, waitFor, waitForDone, wireEvents } from './clone-test-harness.js';
import type { FakeCall, Setup } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import type { Stores } from './store.js';
import { createMemoryStores, humanMessage } from './testing.js';

/**
 * クローンの層にも、マネージャー・作業者と同じ環境変数の門と生ログの伏せ字を掛ける（#6866）。
 * 門はクローン自身の PreToolUse、伏せ字は pg の sessionStore（`withProjectKeyProbe`）・PreCompact の退避・reopen の退避の3つの口。
 */

// ダミーの値（本物の鍵ではない）
const SECRET_NAME = 'ALTEROID_TEST_DUMMY_API_KEY';
const SECRET_VALUE = 'dummy-clone-secret-for-6866-0123456789';
// 名前は秘密に見えないが、値がパスワード入りの URL（記憶ストアの所在の形）
const URL_NAME = 'ALTEROID_TEST_DUMMY_STORE_URL';
const URL_VALUE = 'postgres://alteroid:dummy-pass-6866@db.example.invalid:5432/alteroid';
const ENV = { [SECRET_NAME]: SECRET_VALUE, [URL_NAME]: URL_VALUE };

const envOutputEntry = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tu-env',
        content: `HOME=/home/x\n${SECRET_NAME}=${SECRET_VALUE}\n${URL_NAME}=${URL_VALUE}\n`,
      },
    ],
  },
};

function expectRedacted(text: string): void {
  expect(text).not.toContain(SECRET_VALUE);
  expect(text).not.toContain('dummy-pass-6866');
  expect(text).toContain(`[redacted:env:${SECRET_NAME}]`);
  expect(text).toContain(`[redacted:env:${URL_NAME}]`);
  expect(text).toContain('HOME=/home/x');
}

async function archivedBodies(stores: Stores): Promise<string[]> {
  const bodies: string[] = [];
  for (const entry of await stores.archive.list()) {
    const read = await stores.archive.read(entry.id);
    if (read !== null && read.kind === 'body') bodies.push(read.body);
  }
  return bodies;
}

async function plantTranscript(): Promise<string> {
  const dir = await makeTempDir('alteroid-clone-env-guard-');
  const path = join(dir, 'transcript.jsonl');
  await writeFile(
    path,
    [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'はい' } }),
      JSON.stringify(envOutputEntry),
    ].join('\n'),
    'utf8',
  );
  return path;
}

describe('クローンの生ログの写しで、子が持つ秘密の値を伏せる（#6866）', () => {
  it('前提: その値はクローンの子の env に渡っている（渡っていなければこの試験は何も測らない）', async () => {
    const s = setup(undefined, undefined, undefined, ENV);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const env = (s.calls[0] as FakeCall).options.env ?? {};
    expect(env[SECRET_NAME]).toBe(SECRET_VALUE);
    expect(env[URL_NAME]).toBe(URL_VALUE);
    await s.clone.stop();
  });

  it('pg の sessionStore: append に流した Bash の出力の値は、store に印で届く', async () => {
    const written: SessionStoreEntry[][] = [];
    const sessionStore: SessionStore = {
      append: async (...args) => {
        written.push(args[1]);
      },
      load: async () => null,
    };
    const { fn, calls } = fakeSdk();
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      sessionStore,
      env: ENV,
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);

    const passed = calls[0]?.options.sessionStore;
    if (passed === undefined) throw new Error('SDK へ sessionStore が渡っていない');
    await passed.append({ projectKey: 'p', sessionId: 's' }, [
      envOutputEntry,
    ] as SessionStoreEntry[]);

    expectRedacted(JSON.stringify(written));
    await clone.stop();
  });

  it('PreCompact の退避: archive の本文で印になる', async () => {
    const s = setup(undefined, undefined, undefined, ENV);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const path = await plantTranscript();
    const hook = (s.calls[0] as FakeCall).options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: path } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    const bodies = await archivedBodies(s.stores);
    expect(bodies).toHaveLength(1);
    expectRedacted(bodies[0] as string);
    await s.clone.stop();
  });

  it('reopen の退避（墓標の側の `salvageTranscript`）: archive の本文で印になる', async () => {
    const s = setup(undefined, undefined, undefined, ENV);
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const path = await plantTranscript();
    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook({ tool_name: 'Read', transcript_path: path } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    if (s.clone.reopenSession === undefined) throw new Error('reopenSession が無い');
    await s.clone.reopenSession({ reason: '試験', distill: false, actor: 'アカウント alice' });
    await waitFor(async () => (await s.stores.archive.list()).length > 0, '退避されること');

    const bodies = await archivedBodies(s.stores);
    expect(bodies).toHaveLength(1);
    expectRedacted(bodies[0] as string);
    await s.clone.stop();
  });
});

describe('クローン自身の Bash でも、環境変数の値を出す形を断る（#6866）', () => {
  async function hookOf(s: Setup) {
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    const hook = (s.calls[0] as FakeCall).options.hooks?.PreToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreToolUse フックが登録されていない');
    return hook;
  }

  async function decide(hook: Awaited<ReturnType<typeof hookOf>>, command: string) {
    return (await hook(
      { tool_name: 'Bash', tool_input: { command } } as never,
      undefined,
      {} as never,
    )) as { continue?: boolean; hookSpecificOutput?: Record<string, unknown> };
  }

  it('既定で `env` を deny にし、理由に代わりの書き方を返す', async () => {
    const s = setup();
    const result = await decide(await hookOf(s), 'env');
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(String(result.hookSpecificOutput?.permissionDecisionReason)).toContain('compgen -e');
    await s.clone.stop();
  });

  it('`cat /proc/1/environ` も deny', async () => {
    const s = setup();
    const result = await decide(await hookOf(s), 'cat /proc/1/environ');
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    await s.clone.stop();
  });

  it('人間が承認した許可に一致しても、門が on なら通さない', async () => {
    const s = setup();
    await s.stores.permissionGrants.put({
      id: 'grant-env',
      rule: 'Bash(env:*)',
      allows: ['env'],
      denies: [],
      approvalId: 'ap-env',
      answer: '許可します',
      grantedAt: '2026-01-01T00:00:00.000Z',
      route: { principalKind: 'account' as const, accountId: 'acc-1' },
    });
    const result = await decide(await hookOf(s), 'env');
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    await s.clone.stop();
  });

  it('値を出さない形は今までどおり何も決めない', async () => {
    const s = setup();
    expect(await decide(await hookOf(s), 'compgen -e')).toEqual({ continue: true });
    await s.clone.stop();
  });

  it('`ALTEROID_BASH_ENV_GUARD=off` で開く', async () => {
    const s = setup(undefined, undefined, undefined, { [BASH_ENV_GUARD_ENV]: 'off' });
    expect(await decide(await hookOf(s), 'env')).toEqual({ continue: true });
    await s.clone.stop();
  });

  it('綴り違いは止めずに既存の流れへ委ねる（クローンの門には確認に上げる口が無いため）', async () => {
    const s = setup(undefined, undefined, undefined, { [BASH_ENV_GUARD_ENV]: 'deny' });
    expect(await decide(await hookOf(s), 'env')).toEqual({ continue: true });
    await s.clone.stop();
  });
});
