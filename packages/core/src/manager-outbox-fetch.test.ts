import { describe, expect, it } from 'vitest';

import { DEFAULT_ATTACHMENT_LIMITS, type AttachmentLimits } from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';
import { sha256Hex } from './auth.js';
import { fetchManagerOutbox } from './manager-outbox-fetch.js';
import type { RunnerClient, RunnerOutboxContent, RunnerOutboxFile } from './runner-protocol.js';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function describeFile(
  fileId: string,
  name: string,
  bytes: Uint8Array,
  overrides: Partial<RunnerOutboxFile> = {},
): RunnerOutboxFile {
  return {
    fileId,
    name,
    mediaType: 'text/plain',
    size: bytes.length,
    sha256: sha256Hex(bytes),
    ...overrides,
  };
}

async function* chunked(bytes: Uint8Array, chunk = 4): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += chunk) yield bytes.subarray(at, at + chunk);
}

interface FakeRunner {
  runner: RunnerClient;
  opened: string[];
  deleted: string[];
}

/** `contents` は fileId ごとの中身。無い id は 404（`undefined`）。値が関数なら呼んで返す（投げる・止まるを作る）。 */
function fakeRunner(
  contents: Record<string, RunnerOutboxContent | (() => Promise<RunnerOutboxContent>)>,
  options: { deleteFails?: boolean } = {},
): FakeRunner {
  const opened: string[] = [];
  const deleted: string[] = [];
  const runner = {
    async openOutboxFile(_managerId: string, fileId: string) {
      opened.push(fileId);
      const content = contents[fileId];
      if (content === undefined) return undefined;
      return typeof content === 'function' ? content() : content;
    },
    async deleteOutboxFile(_managerId: string, fileId: string) {
      deleted.push(fileId);
      if (options.deleteFails === true) throw new Error('DELETE が落ちた');
    },
  } as unknown as RunnerClient;
  return { runner, opened, deleted };
}

function input(
  fake: FakeRunner,
  files: RunnerOutboxFile[],
  extra: {
    limits?: AttachmentLimits;
    runnerNamesOutbox?: boolean;
    rejectedFiles?: { name: string; reason: string }[];
    fileTimeoutMs?: number;
    totalTimeoutMs?: number;
  } = {},
) {
  const limits = extra.limits ?? DEFAULT_ATTACHMENT_LIMITS;
  const store = new MemoryAttachmentStore({ limits });
  return {
    store,
    args: {
      runner: fake.runner,
      runnerNamesOutbox: extra.runnerNamesOutbox ?? true,
      managerId: 'mgr-1',
      reportId: 'report-1',
      files,
      rejectedFiles: extra.rejectedFiles ?? [],
      store,
      limits,
      ...(extra.fileTimeoutMs === undefined ? {} : { fileTimeoutMs: extra.fileTimeoutMs }),
      ...(extra.totalTimeoutMs === undefined ? {} : { totalTimeoutMs: extra.totalTimeoutMs }),
    },
  };
}

describe('担い手の出し箱の取り出し（Issue #4126 P2b）', () => {
  it('取れたものは置き場に入り（uploadedBy は manager:<id>）、報告へ結び付き、控えが返り、退避先を消させる', async () => {
    const bytes = textBytes('成果物の中身');
    const fake = fakeRunner({ f1: { size: bytes.length, body: chunked(bytes) } });
    const { store, args } = input(fake, [describeFile('f1', 'result.txt', bytes)]);

    const result = await fetchManagerOutbox(args);

    expect(result.rejected).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    const ref = result.attachments[0]!;
    expect(ref).toMatchObject({
      name: 'result.txt',
      mediaType: 'text/plain',
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
    const found = await store.get(ref.id);
    expect(Buffer.from(found!.bytes).toString()).toBe('成果物の中身');
    expect(found!.meta.uploadedBy).toBe('manager:mgr-1');
    expect(found!.meta.managerReportId).toBe('report-1');
    expect(fake.deleted).toEqual(['f1']);
  });

  it('sha256 が申告と合わなければ置かず、理由つきで rejected に載り、退避先は消させない', async () => {
    const bytes = textBytes('本物の中身');
    const fake = fakeRunner({ f1: { size: bytes.length, body: chunked(bytes) } });
    const { store, args } = input(fake, [
      describeFile('f1', 'bad.txt', bytes, { sha256: sha256Hex(textBytes('別の中身')) }),
    ]);

    const result = await fetchManagerOutbox(args);

    expect(result.attachments).toEqual([]);
    expect(result.rejected).toEqual([{ name: 'bad.txt', reason: 'sha256 が申告と合わない' }]);
    expect(fake.deleted).toEqual([]);
    expect(await store.prune(new Date(Date.now() + 365 * 86_400_000))).toBe(0);
  });

  it('runner が申告より大きく送ってきたら、全部は読まずに途中で打ち切る', async () => {
    const declared = textBytes('1234');
    let yielded = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        yielded += 1;
        yield textBytes('xxxx');
      }
    }
    const fake = fakeRunner({ f1: { size: declared.length, body: endless() } });
    const { args } = input(fake, [describeFile('f1', 'big.txt', declared)]);

    const result = await fetchManagerOutbox(args);

    expect(result.attachments).toEqual([]);
    expect(result.rejected[0]?.name).toBe('big.txt');
    expect(result.rejected[0]?.reason).toContain('途中で打ち切った');
    expect(yielded).toBeLessThanOrEqual(3);
    expect(fake.deleted).toEqual([]);
  });

  it('申告の大きさそのものが1つの上限を超えるものは、取りに行かずに理由を残す', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxFileBytes: 8 };
    const bytes = textBytes('0123456789');
    const fake = fakeRunner({ f1: { size: bytes.length, body: chunked(bytes) } });
    const { args } = input(fake, [describeFile('f1', 'over.txt', bytes)], { limits });

    const result = await fetchManagerOutbox(args);

    expect(fake.opened).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain('1つの上限（8 バイト）を超える');
  });

  it('受け取った大きさが申告より小さければ置かない', async () => {
    const bytes = textBytes('12345678');
    const fake = fakeRunner({ f1: { size: bytes.length, body: chunked(bytes.subarray(0, 4)) } });
    const { args } = input(fake, [describeFile('f1', 'short.txt', bytes)]);

    const result = await fetchManagerOutbox(args);

    expect(result.attachments).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('大きさが申告（8 バイト）と合わない');
  });

  it('runner が 404（退避先が無い）なら、理由つきで rejected に載り、ほかのファイルは取れる', async () => {
    const bytes = textBytes('生きている');
    const fake = fakeRunner({ f2: { size: bytes.length, body: chunked(bytes) } });
    const { args } = input(fake, [
      describeFile('f1', 'gone.txt', textBytes('消えた')),
      describeFile('f2', 'alive.txt', bytes),
    ]);

    const result = await fetchManagerOutbox(args);

    expect(result.rejected).toEqual([
      { name: 'gone.txt', reason: '退避先に無かった（runner が消した、または既に取り出された）' },
    ]);
    expect(result.attachments.map((ref) => ref.name)).toEqual(['alive.txt']);
    expect(fake.deleted).toEqual(['f2']);
  });

  it('runner への接続が落ちたときは理由つきで rejected に載り、投げない', async () => {
    const fake = fakeRunner({
      f1: async () => {
        throw new Error('接続が切れた');
      },
    });
    const { args } = input(fake, [describeFile('f1', 'x.txt', textBytes('x'))]);

    const result = await fetchManagerOutbox(args);

    expect(result.rejected[0]?.reason).toContain('取り出しに失敗した');
    expect(result.rejected[0]?.reason).toContain('接続が切れた');
  });

  it('取っている途中で繋ぎが落ちたときも、理由つきで rejected に載る', async () => {
    async function* breaks(): AsyncGenerator<Uint8Array> {
      yield textBytes('ab');
      throw new Error('途中で切れた');
    }
    const fake = fakeRunner({ f1: { size: 8, body: breaks() } });
    const { args } = input(fake, [describeFile('f1', 'x.txt', textBytes('12345678'))]);

    const result = await fetchManagerOutbox(args);

    expect(result.attachments).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('途中で切れた');
  });

  it('1つの取り出しが時間切れなら、理由つきで rejected に載り、報告は先へ進む（止まった繋ぎは畳まれる）', async () => {
    let closed = false;
    const stalled: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: async () => {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const fake = fakeRunner({ f1: { size: 8, body: stalled } });
    const { args } = input(fake, [describeFile('f1', 'slow.txt', textBytes('12345678'))], {
      fileTimeoutMs: 30,
    });

    const result = await fetchManagerOutbox(args);

    expect(result.attachments).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('時間切れ');
    expect(closed).toBe(true);
    expect(fake.deleted).toEqual([]);
  });

  it('全体の時間を超えた分は「受け取れなかった（時間切れ）」になり、先のファイルの結果は残る', async () => {
    const first = textBytes('先に取れた');
    const stalled: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) };
      },
    };
    const fake = fakeRunner({
      f1: { size: first.length, body: chunked(first) },
      f2: { size: 8, body: stalled },
      f3: { size: 4, body: chunked(textBytes('abcd')) },
    });
    const { args } = input(
      fake,
      [
        describeFile('f1', 'one.txt', first),
        describeFile('f2', 'two.txt', textBytes('12345678')),
        describeFile('f3', 'three.txt', textBytes('abcd')),
      ],
      { totalTimeoutMs: 40, fileTimeoutMs: 10_000 },
    );

    const result = await fetchManagerOutbox(args);

    expect(result.attachments.map((ref) => ref.name)).toEqual(['one.txt']);
    expect(result.rejected.map((item) => item.name)).toEqual(['two.txt', 'three.txt']);
    for (const item of result.rejected) expect(item.reason).toContain('時間切れ');
    expect(fake.opened).toEqual(['f1', 'f2']);
  });

  it('宣言が画像で画像の上限を超えるときは、octet-stream に落として受け付ける', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxImageBytes: 16, maxFileBytes: 1024 };
    const big = new Uint8Array(64).fill(7);
    big.set(PNG);
    const fake = fakeRunner({ f1: { size: big.length, body: chunked(big, 16) } });
    const { store, args } = input(
      fake,
      [describeFile('f1', 'huge.png', big, { mediaType: 'image/png' })],
      { limits },
    );

    const result = await fetchManagerOutbox(args);

    expect(result.rejected).toEqual([]);
    expect(result.attachments[0]).toMatchObject({
      name: 'huge.png',
      mediaType: 'application/octet-stream',
    });
    expect((await store.getMeta(result.attachments[0]!.id))?.managerReportId).toBe('report-1');
  });

  it('宣言が画像で中身が合わない（magic_mismatch）ときは、octet-stream に落として受け付ける', async () => {
    const notImage = textBytes('これは画像ではない');
    const fake = fakeRunner({ f1: { size: notImage.length, body: chunked(notImage, 8) } });
    const { args } = input(fake, [
      describeFile('f1', 'fake.png', notImage, { mediaType: 'image/png' }),
    ]);

    const result = await fetchManagerOutbox(args);

    expect(result.rejected).toEqual([]);
    expect(result.attachments[0]).toMatchObject({
      name: 'fake.png',
      mediaType: 'application/octet-stream',
    });
  });

  it('本物の画像は画像のまま入る', async () => {
    const fake = fakeRunner({ f1: { size: PNG.length, body: chunked(PNG) } });
    const { args } = input(fake, [describeFile('f1', 'ok.png', PNG, { mediaType: 'image/png' })]);

    const result = await fetchManagerOutbox(args);

    expect(result.attachments[0]?.mediaType).toBe('image/png');
  });

  it('DELETE が落ちても、取れた控えは返り、報告は止まらない', async () => {
    const bytes = textBytes('中身');
    const fake = fakeRunner(
      { f1: { size: bytes.length, body: chunked(bytes) } },
      { deleteFails: true },
    );
    const { args } = input(fake, [describeFile('f1', 'a.txt', bytes)]);

    const result = await fetchManagerOutbox(args);

    expect(fake.deleted).toEqual(['f1']);
    expect(result.attachments).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it('1回の報告の個数が上限を超えた分は、取りに行かず、理由つきで受け取らない（先の分は取れる）', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxPerMessage: 2 };
    const names = ['a.txt', 'b.txt', 'c.txt'];
    const contents: Record<string, RunnerOutboxContent> = {};
    const files = names.map((name, index) => {
      const bytes = textBytes(`中身${index}`);
      contents[`f${index}`] = { size: bytes.length, body: chunked(bytes) };
      return describeFile(`f${index}`, name, bytes);
    });
    const fake = fakeRunner(contents);
    const { args } = input(fake, files, { limits });

    const result = await fetchManagerOutbox(args);

    expect(result.attachments.map((ref) => ref.name)).toEqual(['a.txt', 'b.txt']);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.name).toBe('c.txt');
    expect(result.rejected[0]?.reason).toContain('2 個まで');
    expect(fake.opened).toEqual(['f0', 'f1']);
  });

  it('1回の報告の合計が上限を超える分は、理由つきで受け取らない', async () => {
    const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxTotalBytes: 10 };
    const a = textBytes('123456');
    const b = textBytes('abcdef');
    const fake = fakeRunner({
      f1: { size: a.length, body: chunked(a) },
      f2: { size: b.length, body: chunked(b) },
    });
    const { args } = input(fake, [describeFile('f1', 'a.txt', a), describeFile('f2', 'b.txt', b)], {
      limits,
    });

    const result = await fetchManagerOutbox(args);

    expect(result.attachments.map((ref) => ref.name)).toEqual(['a.txt']);
    expect(result.rejected[0]).toMatchObject({ name: 'b.txt' });
    expect(result.rejected[0]?.reason).toContain('合計は 10 バイトまで');
  });

  it('runner が取り出しの口を名乗っていなければ、取りに行かず「名乗っていない」で rejected に落とす', async () => {
    const bytes = textBytes('x');
    const fake = fakeRunner({ f1: { size: bytes.length, body: chunked(bytes) } });
    const { args } = input(fake, [describeFile('f1', 'a.txt', bytes)], {
      runnerNamesOutbox: false,
    });

    const result = await fetchManagerOutbox(args);

    expect(fake.opened).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.rejected).toEqual([
      { name: 'a.txt', reason: 'runner が取り出しの口を名乗っていない' },
    ]);
  });

  it('runner が断ったもの（rejectedFiles）は、取ったものと並べて理由つきで返る', async () => {
    const bytes = textBytes('中身');
    const fake = fakeRunner({ f1: { size: bytes.length, body: chunked(bytes) } });
    const { args } = input(fake, [describeFile('f1', 'ok.txt', bytes)], {
      rejectedFiles: [{ name: 'link\n.txt', reason: 'symlink は\n送れない' }],
    });

    const result = await fetchManagerOutbox(args);

    expect(result.attachments.map((ref) => ref.name)).toEqual(['ok.txt']);
    expect(result.rejected).toEqual([{ name: 'link_.txt', reason: 'symlink は 送れない' }]);
  });
});
