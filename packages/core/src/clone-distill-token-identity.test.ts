import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

describe('クローン — 蒸留のセッションを組んでも本セッションの鍵の身元を上書きしない（#4880）', () => {
  it('本セッションが鍵 A で走る間に鍵を B へ回して蒸留を組んでも、身元は A のまま・蒸留の env は B', async () => {
    let currentKey = 'key-A';
    const { fn, calls } = fakeSdk();
    const clone = createClone({
      stores: createMemoryStores(),
      queryFn: fn,
      env: {},
      credentials: () => ({ CLAUDE_CODE_OAUTH_TOKEN: currentKey }),
      tokenIdentity: () => ({ tokenId: currentKey, generation: 1 }),
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');

    clone.post(humanMessage('やあ'));
    await waitForDone(events);
    expect(clone.usageBlockedTokenId).toBe('key-A');
    expect((calls[0] as FakeCall).options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('key-A');

    currentKey = 'key-B';
    const dir = await makeTempDir('alteroid-clone-distill-identity-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, '蒸留に渡す生ログ', 'utf8');
    const hook = (calls[0] as FakeCall).options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    expect((calls[1] as FakeCall).kind).toBe('sideQuery');
    expect((calls[1] as FakeCall).options.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe('key-B');
    expect(clone.usageBlockedTokenId).toBe('key-A');

    await clone.stop();
  });
});
