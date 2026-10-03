import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { AgentCloneDriver } from './agent-clone-session.js';
import { ClaudeCloneDriver } from './claude-clone-driver.js';
import { fakeSdk, waitForDone, wireEvents } from './clone-test-harness.js';
import { ALWAYS_REDELIVER, createClone } from './clone.js';
import { createMemoryStores, humanMessage } from './testing.js';

/**
 * クローンは `driver` を通してセッションを開き、蒸留は駆動役の任意の能力として扱う（#486）。
 */
describe('クローン — 駆動役の口（#486 M7 の前段）', () => {
  it('driver を渡すと、queryFn ではなくその駆動役がセッションを開く', async () => {
    const { fn, calls } = fakeSdk();
    const inner = new ClaudeCloneDriver({ queryFn: fn });
    let opened = 0;
    const driver: AgentCloneDriver = {
      providerId: 'claude',
      open: (spec) => {
        opened += 1;
        return inner.open(spec);
      },
      distill: (spec) => inner.distill(spec),
    };
    const stores = createMemoryStores();
    // `queryFn` は渡さない（既定の本物の `query` が起きたら、ここで落ちる／走ってしまう）。
    const clone = createClone({ stores, driver, env: {}, redeliveryGate: ALWAYS_REDELIVER });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);
    expect(opened).toBe(1);
    expect(calls).toHaveLength(1);
    await clone.stop();
  });

  it('蒸留を持たない駆動役では、PreCompact の蒸留は失敗として日誌に残り、サイドクエリは起きない', async () => {
    const { fn, calls } = fakeSdk();
    const inner = new ClaudeCloneDriver({ queryFn: fn });
    const driver: AgentCloneDriver = { providerId: 'claude', open: (spec) => inner.open(spec) };
    const stores = createMemoryStores();
    const clone = createClone({ stores, driver, env: {}, redeliveryGate: ALWAYS_REDELIVER });
    const { events } = wireEvents(clone, 'conv-1');
    clone.post(humanMessage('やあ'));
    await waitForDone(events);

    const dir = await makeTempDir('alteroid-clone-driver-seam-');
    const transcriptPath = join(dir, 'transcript.jsonl');
    await writeFile(transcriptPath, 'SEAM-TRANSCRIPT', 'utf8');
    const hook = calls[0]?.options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    const rows = await stores.journal.list({ types: ['exchange'] });
    const failure = rows.find(
      (row) => row.type === 'exchange' && row.text.includes('蒸留のサイドクエリを持たない'),
    );
    expect(failure, '蒸留できなかったことが日誌に残っていない').toBeDefined();
    expect(failure?.type === 'exchange' ? failure.text : '').toContain(
      'PreCompact の蒸留に失敗した',
    );
    expect(calls).toHaveLength(1);
    await clone.stop();
  });
});
