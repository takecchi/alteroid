import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitFor, wireEvents } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';

// 退避は待ちの前に控えたセッション id で書く（#4787）: 退避の間に次のセッションが init すると、古い生ログが新しいセッションの id で退避されるため
describe('開き直す前の退避は、畳んだセッションの id で書く（#4787）', () => {
  it('⭐ 退避の間に次のセッションが別の id で始まっても、退避は前のセッションの id で残る', async () => {
    const stores = createMemoryStores();
    const base = fakeSdk();
    let opened = 0;
    // 開くたびに別の id を名乗らせる: 偽の SDK は既定でどのセッションにも同じ id を名乗らせ、食い違いが見えないため
    const queryFn: typeof base.fn = (args) => {
      const query = base.fn(args);
      if (typeof args.prompt === 'string') return query;
      opened += 1;
      const sessionId = `sess-${String(opened)}`;
      const iterator = query[Symbol.asyncIterator]();
      return Object.assign(Object.create(query) as typeof query, {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const step = await iterator.next();
            if (step.done === true) return step;
            const message = step.value as { session_id?: string };
            return message.session_id === undefined
              ? step
              : { done: false, value: { ...step.value, session_id: sessionId } };
          },
          return: iterator.return?.bind(iterator),
        }),
      });
    };
    const clone = createClone({
      redeliveryGate: ALWAYS_REDELIVER,
      stores,
      queryFn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitFor(() => events.some((event) => event.type === 'done'), '1本目が通ること');

    const dir = await makeTempDir('alteroid-salvage-id-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    // 大きめにして読み出しと画像の伏せ字の待ちを長くする: その間に次のセッションが init する窓を作るため
    await writeFile(transcriptPath, `${'前のセッションの生ログ\n'.repeat(20_000)}`, 'utf8');
    const call = base.calls[0] as FakeCall;
    const hook = call.options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook({ tool_name: 'Read', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    if (clone.reopenSession === undefined) throw new Error('reopenSession が無い');
    await clone.reopenSession({ reason: '試験', distill: false, actor: '試験' });
    clone.post(humanMessage('次の発言'));

    await waitFor(async () => (await stores.archive.list()).length > 0, '退避されること');
    await waitFor(() => opened >= 2, '次のセッションが開くこと');
    const archived = await stores.archive.list();
    expect(archived.map((entry) => entry.sessionId)).toEqual(['sess-1']);
    await clone.stop();
  });
});
