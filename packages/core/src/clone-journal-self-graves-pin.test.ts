import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { makeTempDir } from '../../../vitest.tmpdir.js';
import { createClone } from './clone.js';
import { createLocalRunner } from './runner-local.js';
import { createRunnerRegistry } from './runner-protocol.js';
import { createMemoryStores, humanMessage } from './testing.js';
import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import type { Stores } from './store.js';

// 日誌へ `with: 'self'` の1行を書く箇所を helper へ寄せる前に、書かれる行を全文で固定する（墓標の塊）。
// 墓標の拾い直しの行（`#distillGrave` / `#pickUpOne*`）は `clone-grave-pickup-journal-pin.test.ts`（#6321）が固定済み。
// ここは残りの1つ、墓標が上限を超えて落ちたときの1行（`#reportDroppedGraves`）を固定する。

// 蒸留（サイドクエリ）だけを枠（429）で落とす fake（`clone-grave-retry.test.ts` と同じ形）
function makeSdk() {
  const inner = fakeSdk();
  const fn = ((params: { prompt: unknown }) => {
    if (typeof params.prompt === 'string') {
      inner.calls.push({
        options: (params as { options?: FakeCall['options'] }).options ?? {},
        inputs: [params.prompt],
        kind: 'sideQuery',
      });
      // eslint-disable-next-line require-yield
      async function* boom(): AsyncGenerator<never, void> {
        throw new Error('API Error: 429 {"type":"rate_limit_error"}');
      }
      return Object.assign(boom(), { close: () => undefined, interrupt: async () => undefined });
    }
    return (inner.fn as unknown as (p: unknown) => unknown)(params);
  }) as unknown as typeof sdkQuery;
  return { fn, calls: inner.calls };
}

async function firePreCompact(calls: FakeCall[], transcriptPath: string): Promise<void> {
  const hook = calls.find((c) => c.kind === 'session')?.options.hooks?.PreCompact?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
  await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
    signal: new AbortController().signal,
  } as never);
}

async function selfLines(stores: Stores): Promise<string[]> {
  const rows = await stores.journal.list({ types: ['exchange'], with: ['self'] });
  return rows.map((row) => (row.type === 'exchange' ? row.text : ''));
}

describe('日誌の with: self の1行を全文で固定する（墓標の塊。helper へ寄せる前の歯）', () => {
  it('墓標を足して上限を超えたら、落とした墓標を ⚠ の1行で残す（#reportDroppedGraves）', async () => {
    const stores = createMemoryStores();
    // 上限を本当に埋めると起動時の拾い直しが走るので、足す口だけを包んで「古い2件を落とした」と返させる
    const add = stores.sessions.addTranscriptGrave.bind(stores.sessions);
    stores.sessions.addTranscriptGrave = async (grave) => {
      await add(grave);
      return { dropped: ['arc-old-1', 'arc-old-2'] };
    };
    const sdk = makeSdk();
    const clone = createClone({
      stores,
      queryFn: sdk.fn,
      env: {},
      runners: createRunnerRegistry([
        createLocalRunner({ workspacePath: '/work', queryFn: fakeSdk().fn, env: {} }),
      ]),
    });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);

    const dir = await makeTempDir('alteroid-clone-journal-self-graves-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, 'GRAVES-PIN compaction の前の会話', 'utf8');
    await firePreCompact(sdk.calls, transcriptPath);

    const dropped = (await selfLines(stores)).filter((line) => line.includes('上限'));
    expect(dropped).toEqual([
      '[障害] 生ログの墓標が上限（20 件）を超えたので、古いものから落とした: arc-old-1, arc-old-2（⚠️ この区間は記憶へ移せていない）',
    ]);
    await clone.stop();
  });
});
