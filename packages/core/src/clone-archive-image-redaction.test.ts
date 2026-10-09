import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { setup, waitFor, waitForDone } from './clone-test-harness.js';
import type { FakeCall } from './clone-test-harness.js';
import type { Stores } from './store.js';
import { humanMessage } from './testing.js';

/**
 * クローンが SDK の生ログを読んで archive ストアへ渡す2か所
 * （reopen／文脈窓で畳む前の `#salvageTranscript` と、PreCompact の `#onPreCompact`）で、
 * 画像の中身が archive へ届かないことを固定する歯（#4127。#4280 で歯が無かった2か所）。
 */

const B64 = Buffer.from('PNG-BYTES-FOR-4127-ARCHIVE-WIRING-'.repeat(4)).toString('base64');

const TRANSCRIPT = [
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'はい' } }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '見て' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
      ],
    },
  }),
].join('\n');

async function plantFile(): Promise<string> {
  const dir = await makeTempDir('alteroid-archive-image-redaction-');
  const path = join(dir, 'transcript.jsonl');
  await writeFile(path, TRANSCRIPT, 'utf8');
  return path;
}

async function archivedBodies(stores: Stores): Promise<string[]> {
  const bodies: string[] = [];
  for (const entry of await stores.archive.list()) {
    const read = await stores.archive.read(entry.id);
    if (read !== null && read.kind === 'body') bodies.push(read.body);
  }
  return bodies;
}

function expectRedacted(bodies: string[]): void {
  expect(bodies).toHaveLength(1);
  const body = bodies[0] as string;
  expect(body).not.toContain(B64);
  expect(body).toContain('[画像の控え] type=image/png');
}

describe('クローンは画像の中身を archive へ渡さない（#4127）', () => {
  it('reopen の退避（#salvageTranscript）: archive の本文に base64 は無く、控えが入る', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const path = await plantFile();
    const hook = (s.calls[0] as FakeCall).options.hooks?.PostToolUse?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PostToolUse フックが登録されていない');
    await hook({ tool_name: 'Read', transcript_path: path } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    if (s.clone.reopenSession === undefined) throw new Error('reopenSession が無い');
    await s.clone.reopenSession({ reason: '試験', distill: false, actor: 'アカウント alice' });
    await waitFor(async () => (await s.stores.archive.list()).length > 0, '退避されること');

    expectRedacted(await archivedBodies(s.stores));
    await s.clone.stop();
  });

  it('PreCompact の退避（#onPreCompact）: archive の本文に base64 は無く、控えが入る', async () => {
    const s = setup();
    s.clone.post(humanMessage('やあ'));
    await waitForDone(s.events);

    const path = await plantFile();
    const hook = (s.calls[0] as FakeCall).options.hooks?.PreCompact?.[0]?.hooks?.[0];
    if (hook === undefined) throw new Error('PreCompact フックが登録されていない');
    await hook({ session_id: 'sess-fake', transcript_path: path } as never, undefined, {
      signal: new AbortController().signal,
    } as never);

    expectRedacted(await archivedBodies(s.stores));
    await s.clone.stop();
  });
});
