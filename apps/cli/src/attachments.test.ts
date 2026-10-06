import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import {
  AttachmentDraft,
  attachmentsGetCommand,
  describeAttachment,
  mediaTypeOfName,
  uploadAttachment,
  uploadDraft,
} from './attachments.js';
import { runAttachmentCommand, sendMessage } from './chat.js';
import { renderConversationDetail } from './conversations.js';
import type { Target } from './target.js';
import { captureStdout } from './test-support.js';

vi.mock('./target.js', async (orig) => ({
  ...(await orig<typeof import('./target.js')>()),
  resolveTarget: async () => ({
    baseUrl: 'http://127.0.0.1:4517',
    headers: { authorization: 'Bearer t' },
    remote: false,
    note: null,
  }),
}));

const target: Target = {
  baseUrl: 'http://127.0.0.1:4517',
  headers: { authorization: 'Bearer t' },
  remote: false,
  note: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('/attach から送るまで', () => {
  it('POST /attachments は octet-stream で呼ばれ、返った id が /chat の attachments に入り、受理後に添えかけが空になる', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    const path = join(dir, 'run.log');
    await writeFile(path, 'hello log');
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', (input: unknown, init: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/attachments')) {
        return Promise.resolve(
          Response.json({
            id: 'att-1',
            name: 'run.log',
            mediaType: 'text/plain',
            size: 9,
            sha256: 'x',
          }),
        );
      }
      return Promise.resolve(
        new Response('event: done\ndata: {"type":"done"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    });
    const out = captureStdout();
    const draft = new AttachmentDraft();
    await runAttachmentCommand(`/attach ${path}`, draft);
    await runAttachmentCommand('/attachments', draft);
    expect(out()).toContain('run.log');
    expect(draft.count).toBe(1);

    const uploaded = await uploadDraft(draft, (f) => uploadAttachment(target, f));
    expect(uploaded.ok).toBe(true);
    await sendMessage(target, '見て', null, undefined, {
      attachments: uploaded.ok ? uploaded.uploaded.map((a) => a.id) : [],
      onAccepted: () => draft.clear(),
    });

    const upload = calls[0]!;
    expect(upload.url).toBe(`${target.baseUrl}/attachments?name=run.log&type=text%2Fplain`);
    expect((upload.init.headers as Record<string, string>)['content-type']).toBe(
      'application/octet-stream',
    );
    expect(Buffer.from(upload.init.body as Uint8Array).toString()).toBe('hello log');
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({
      text: '見て',
      attachments: ['att-1'],
    });
    expect(draft.count).toBe(0);
  });

  it('上げるのに失敗したら添えかけは残り、理由が返る。再送では上げ済みを上げ直さない', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    const a = join(dir, 'a.txt');
    const b = join(dir, 'b.txt');
    await writeFile(a, 'a');
    await writeFile(b, 'b');
    const draft = new AttachmentDraft();
    await draft.add(a);
    await draft.add(b);
    let n = 0;
    const meta = (id: string) => ({ id, name: id, mediaType: 'text/plain', size: 1, sha256: 'x' });
    const failing = await uploadDraft(draft, async () => {
      n += 1;
      if (n === 2) throw new Error('デーモンに繋がらない');
      return meta('att-a');
    });
    expect(failing).toEqual({ ok: false, reason: 'b.txt: デーモンに繋がらない' });
    expect(draft.count).toBe(2);
    n = 0;
    const retry = await uploadDraft(draft, async () => {
      n += 1;
      return meta('att-b');
    });
    expect(n).toBe(1);
    expect(retry.ok && retry.uploaded.map((u) => u.id)).toEqual(['att-a', 'att-b']);
  });

  it('上限は先に検査する（大きすぎる・個数超過・無いファイル）。/detach で外せる', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    const big = join(dir, 'big.bin');
    await writeFile(big, Buffer.alloc(100));
    const small = new AttachmentDraft({
      maxImageBytes: 10,
      maxFileBytes: 50,
      maxPerMessage: 1,
      maxTotalBytes: 1000,
      retentionDays: 1,
    });
    const tooBig = await small.add(big);
    expect(tooBig.ok ? '' : tooBig.reason).toContain('大きすぎる');
    const ok = join(dir, 'ok.txt');
    await writeFile(ok, 'x');
    expect((await small.add(ok)).ok).toBe(true);
    const many = await small.add(ok);
    expect(many.ok ? '' : many.reason).toContain('1 個まで');
    const missing = await small.add(join(dir, 'nope'));
    expect(missing.ok).toBe(false);
    expect(small.remove('9').ok).toBe(false);
    expect(small.remove('1').ok).toBe(true);
    expect(small.count).toBe(0);
  });

  it('MIME は拡張子の表から。分からなければ octet-stream', () => {
    expect(mediaTypeOfName('a.PNG')).toBe('image/png');
    expect(mediaTypeOfName('x.mp4')).toBe('video/mp4');
    expect(mediaTypeOfName('noext')).toBe('application/octet-stream');
    expect(mediaTypeOfName('a.weird')).toBe('application/octet-stream');
  });
});

describe('alteroid attachments get / 表示', () => {
  it('get は中身を書き、既存のファイルは上書きしない', async () => {
    const dir = await makeTempDir('alteroid-cli-attach-');
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(Uint8Array.from([1, 2, 3, 255]))));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = join(dir, 'out.bin');
    await attachmentsGetCommand('att-1', { output: out });
    expect([...(await readFile(out))]).toEqual([1, 2, 3, 255]);
    await expect(attachmentsGetCommand('att-1', { output: out })).rejects.toThrow('上書きしない');
  });

  it('添付のある発言は [添付] name (type, size) id=… で出る（中身は出ない）', () => {
    const line = describeAttachment({
      id: 'i1',
      name: 'a.png',
      mediaType: 'image/png',
      size: 2048,
    });
    expect(line).toBe('[添付] a.png (image/png, 2.0 KB) id=i1');
    const text = renderConversationDetail(
      'c1',
      [
        {
          id: 'm1',
          at: '2026-10-06T00:00:00Z',
          role: 'inbound',
          text: '見て',
          attachments: [{ id: 'i1', name: 'a.png', mediaType: 'image/png', size: 2048 }],
        },
      ],
      1,
      true,
      0,
    );
    expect(text).toContain(line);
  });
});
