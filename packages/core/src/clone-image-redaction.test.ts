import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';

/**
 * クローンの pg sessionStore の唯一の入口（`withProjectKeyProbe` の append）で、
 * 画像の中身が store へ届かないことを固定する歯（#4127）。
 */

const B64 = Buffer.from('PNG-BYTES-FOR-4127-CLONE-WIRING-'.repeat(4)).toString('base64');

describe('クローンは画像の中身を pg の sessionStore へ流さない（#4127）', () => {
  it('SDK へ渡した sessionStore の append に画像入りの entry を流すと、store には控えだけが届く', async () => {
    const append = vi.fn(async (_key: unknown, _entries: SessionStoreEntry[]) => undefined);
    const sessionStore: SessionStore = { append, load: async () => null };
    const { fn, calls } = fakeSdk();
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores: createMemoryStores(),
      queryFn: fn,
      sessionStore,
      env: {},
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
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '見て' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
          ],
        },
      },
    ] as SessionStoreEntry[]);

    const written = append.mock.calls.map((call) => JSON.stringify(call[1])).join('');
    expect(written).not.toContain(B64);
    expect(written).toContain('[画像の控え] type=image/png');
    await clone.stop();
  });
});
