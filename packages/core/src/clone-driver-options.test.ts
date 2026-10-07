import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import type { FakeCall } from './clone-test-harness.js';
import { setup, waitForDone } from './clone-test-harness.js';
import { humanMessage } from './testing.js';

function describeValue(value: unknown): unknown {
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'string') return value.replace(/[0-9a-f]{40}/gu, '<revision>');
  if (Array.isArray(value)) return value.map(describeValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = key === 'instance' ? '[McpInstance]' : describeValue(inner);
    }
    return out;
  }
  return value;
}

function stable(options: unknown): string {
  return JSON.stringify(describeValue(options), null, 2);
}

async function firePreCompact(main: FakeCall): Promise<void> {
  const dir = await makeTempDir('alteroid-clone-driver-options-');
  const transcriptPath = join(dir, 'transcript.jsonl');
  await writeFile(transcriptPath, 'DRIVER-OPTIONS-TRANSCRIPT', 'utf8');
  const hook = main.options.hooks?.PreCompact?.[0]?.hooks?.[0];
  if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
  await hook({ session_id: 'sess-fake', transcript_path: transcriptPath } as never, undefined, {
    signal: new AbortController().signal,
  } as never);
}

describe('クローン — query() へ渡る Options は駆動役の切り出しの前後で同じ（#486）', () => {
  it('本セッションの Options（既定）', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    expect(stable(s.calls[0]?.options)).toMatchSnapshot();
    await s.clone.stop();
  });

  it('本セッションの Options（モデルを置いた env）', async () => {
    const s = setup(undefined, undefined, {}, { ALTEROID_CLONE_MODEL: 'opus' });
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    expect(stable(s.calls[0]?.options)).toMatchSnapshot();
    await s.clone.stop();
  });

  it('蒸留のサイドクエリの Options', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    await firePreCompact(s.calls[0] as FakeCall);
    const side = s.calls[1];
    expect(side?.inputs).toHaveLength(1);
    expect(stable(side?.options)).toMatchSnapshot();
    await s.clone.stop();
  });

  it('入力の流れは SDKUserMessage の形で SDK へ渡る', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);
    expect(s.calls[0]?.inputs[0]).toContain('やあ');
    await s.clone.stop();
  });
});
