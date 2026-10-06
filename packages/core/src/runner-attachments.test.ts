import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { DEFAULT_ATTACHMENT_LIMITS } from './attachment.js';
import {
  composeAttachmentInput,
  placeRunnerAttachments,
  pruneStaleAttachmentDirs,
  removeManagerAttachments,
  runnerAttachmentBodyLimit,
  RunnerAttachmentRejectedError,
} from './runner-attachments.js';
import type { RunnerAttachment } from './runner-protocol.js';

/** 1x1 の PNG（先頭8バイトが PNG のマジック）。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function attachmentOf(
  id: string,
  name: string,
  bytes: Uint8Array,
  mediaType = 'application/octet-stream',
): RunnerAttachment {
  return {
    id,
    name,
    mediaType,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: Buffer.from(bytes).toString('base64'),
  };
}

describe('placeRunnerAttachments（Issue #3111 段3）', () => {
  it('元と同じ中身を <root>/<managerId>/<id>/<名前> に置き、通知行に path が載る（読み取り専用）', async () => {
    const root = await makeTempDir('runner-att-');
    const log = Buffer.from('エラーログ\nline2\n');
    const placed = await placeRunnerAttachments({
      root,
      managerId: 'mgr-abc123',
      attachments: [attachmentOf('att-1', 'build.log', log, 'text/plain')],
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]?.path).toBe(join(root, 'mgr-abc123', 'att-1', 'build.log'));
    expect(await readFile(placed[0]?.path ?? '')).toEqual(log);
    // 所有者のみ読み取り（ローカル構成。子 UID が無いので同じ UID が読む）。
    expect((await stat(placed[0]?.path ?? '')).mode & 0o777).toBe(0o400);
    expect((await stat(join(root, 'mgr-abc123'))).mode & 0o777).toBe(0o700);

    const input = composeAttachmentInput('依頼です', placed);
    expect(input.images).toBeUndefined();
    expect(input.text).toContain('依頼です');
    expect(input.text).toContain(
      `[添付] id=att-1 name=build.log type=text/plain size=${log.length} sha256=${placed[0]?.sha256}` +
        ` path=${placed[0]?.path}（Read で開ける）`,
    );
  });

  it('画像は images にも入り、通知行が画像として渡したと言う（宣言ではなく中身で決める）', async () => {
    const root = await makeTempDir('runner-att-');
    const placed = await placeRunnerAttachments({
      root,
      managerId: 'mgr-abc123',
      attachments: [
        attachmentOf('img-1', 'shot.png', PNG, 'image/png'),
        // 宣言が画像でも中身が画像でなければ画像として渡さない。
        attachmentOf('fake-1', 'fake.png', Buffer.from('not an image'), 'image/png'),
      ],
    });
    const input = composeAttachmentInput('見て', placed);
    expect(input.images).toEqual([
      { mediaType: 'image/png', data: PNG.toString('base64'), name: 'shot.png' },
    ]);
    expect(input.text).toContain('（画像としても渡した）（Read で開ける）');
    expect(input.text.match(/画像としても渡した/g)).toHaveLength(1);
  });

  it('添付が無ければ入力は本文だけのまま', () => {
    expect(composeAttachmentInput('本文', [])).toEqual({ text: '本文' });
  });

  it('長い名前（日本語 100 文字・ASCII 255 文字）でも置け、path のファイル名は 200 バイト以内。通知行の name は丸めない（#3324）', async () => {
    const root = await makeTempDir('runner-att-');
    for (const [index, name] of [`${'あ'.repeat(100)}.log`, 'a'.repeat(255)].entries()) {
      const placed = await placeRunnerAttachments({
        root,
        managerId: `mgr-long${index}`,
        attachments: [attachmentOf('att-1', name, Buffer.from('x'), 'text/plain')],
      });
      expect(placed[0]?.name).toBe(name);
      const file = placed[0]!.path.split('/').at(-1)!;
      expect(Buffer.byteLength(file, 'utf8')).toBeLessThanOrEqual(200);
      expect((await readFile(placed[0]!.path)).toString()).toBe('x');
      expect(await readdir(join(root, `mgr-long${index}`, 'att-1'))).toEqual([file]);
    }
  });

  it('sha256 が合わなければ何も置かずに断る（半端な dir も残さない）', async () => {
    const root = await makeTempDir('runner-att-');
    const good = attachmentOf('att-ok', 'ok.txt', Buffer.from('ok'));
    const bad = {
      ...attachmentOf('att-bad', 'bad.txt', Buffer.from('original')),
      data: Buffer.from('tampered').toString('base64'),
    };
    await expect(
      placeRunnerAttachments({ root, managerId: 'mgr-abc123', attachments: [good, bad] }),
    ).rejects.toBeInstanceOf(RunnerAttachmentRejectedError);
    // 先に全部を検めるので、良いほうも置かれていない。
    expect(await readdir(join(root, 'mgr-abc123')).catch(() => [])).toEqual([]);
  });

  it('置き場の外に出る id・managerId は断り、名前の区切りは正規化されて外へ出ない', async () => {
    const root = await makeTempDir('runner-att-');
    const bytes = Buffer.from('x');
    await expect(
      placeRunnerAttachments({
        root,
        managerId: 'mgr-abc123',
        attachments: [attachmentOf('../escape', 'a.txt', bytes)],
      }),
    ).rejects.toBeInstanceOf(RunnerAttachmentRejectedError);
    await expect(
      placeRunnerAttachments({
        root,
        managerId: '../evil',
        attachments: [attachmentOf('att-1', 'a.txt', bytes)],
      }),
    ).rejects.toBeInstanceOf(RunnerAttachmentRejectedError);

    const placed = await placeRunnerAttachments({
      root,
      managerId: 'mgr-abc123',
      attachments: [
        attachmentOf('att-2', '../../../etc/passwd', bytes),
        attachmentOf('att-3', '..', bytes),
      ],
    });
    const base = join(root, 'mgr-abc123');
    for (const item of placed) {
      expect(item.path.startsWith(join(base, item.id) + '/')).toBe(true);
    }
    expect(placed[0]?.name).toBe('.._.._.._etc_passwd');
    expect(placed[1]?.name).toBe('file');
  });

  it('置き場の root が symlink に差し替えられていたら置かない（root 権限の書き込みを外へ向けさせない）', async () => {
    const parent = await makeTempDir('runner-att-');
    const target = await makeTempDir('runner-att-target-');
    const root = join(parent, 'alteroid-attachments');
    await symlink(target, root);
    await expect(
      placeRunnerAttachments({
        root,
        managerId: 'mgr-abc123',
        attachments: [attachmentOf('att-1', 'a.txt', Buffer.from('x'))],
      }),
    ).rejects.toThrow(/実在の dir でない|root/);
    expect(await readdir(target)).toEqual([]);
  });

  it('同じ id を重ねて置ける（上書き）。子の gid を渡すと dir 0750 / file 0440 で group が子の gid になる', async () => {
    const root = await makeTempDir('runner-att-');
    const gid = process.getgid?.() ?? 0;
    const bytes = Buffer.from('v1');
    for (let i = 0; i < 2; i++) {
      await placeRunnerAttachments({
        root,
        managerId: 'mgr-abc123',
        attachments: [attachmentOf('att-1', 'a.txt', bytes)],
        childGid: gid,
      });
    }
    const path = join(root, 'mgr-abc123', 'att-1', 'a.txt');
    const fileInfo = await stat(path);
    expect(fileInfo.mode & 0o777).toBe(0o440);
    expect(fileInfo.gid).toBe(gid);
    expect((await stat(join(root, 'mgr-abc123', 'att-1'))).mode & 0o777).toBe(0o750);
    // 一時ファイルを残さない。
    expect(await readdir(join(root, 'mgr-abc123', 'att-1'))).toEqual(['a.txt']);
  });
});

describe('placeRunnerAttachments の規約の隙（#3561）', () => {
  it('同じ id が2つ以上あれば、何も置かずに断る（通知行の sha256 と path の中身が食い違うのを防ぐ）', async () => {
    const root = await makeTempDir('runner-att-');
    const batch = [
      attachmentOf('dup-id', 'a.txt', Buffer.from('first')),
      attachmentOf('dup-id', 'a.txt', Buffer.from('second!')),
    ];
    await expect(
      placeRunnerAttachments({ root, managerId: 'mgr-x', attachments: batch }),
    ).rejects.toBeInstanceOf(RunnerAttachmentRejectedError);
    // 置く前に断る（半端な dir も残さない）。
    expect(await readdir(root)).toEqual([]);
  });

  it('画像として渡す data は、受け取った文字列ではなく検めた中身から作った正規の base64 である', async () => {
    const root = await makeTempDir('runner-att-');
    const item = attachmentOf('img-1', 'p.png', PNG);
    // Node の base64 復号は空白・改行・url-safe 文字を黙って許す。sha256 は復号後の中身で合ってしまう。
    const wrapped = (item.data.match(/.{1,16}/g) ?? []).join('\n');
    const placed = await placeRunnerAttachments({
      root,
      managerId: 'mgr-y',
      attachments: [{ ...item, data: wrapped }],
    });
    expect(placed[0]?.image?.data).toBe(item.data);
  });
});

describe('掃除', () => {
  it('removeManagerAttachments はその委譲の dir だけを消す', async () => {
    const root = await makeTempDir('runner-att-');
    const bytes = Buffer.from('x');
    for (const managerId of ['mgr-aaaa', 'mgr-bbbb']) {
      await placeRunnerAttachments({
        root,
        managerId,
        attachments: [attachmentOf('att-1', 'a.txt', bytes)],
      });
    }
    await removeManagerAttachments(root, 'mgr-aaaa');
    expect(await readdir(root)).toEqual(['mgr-bbbb']);
    // 区切りを含む id は何もしない。
    await removeManagerAttachments(root, '../');
    expect(await readdir(root)).toEqual(['mgr-bbbb']);
  });

  it('pruneStaleAttachmentDirs は生きた委譲と猶予内を残し、古い取りこぼしだけ消す', async () => {
    const root = await makeTempDir('runner-att-');
    for (const name of ['live', 'fresh', 'stale']) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, 'f'), 'x');
    }
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(join(root, 'live'), old, old);
    await utimes(join(root, 'stale'), old, old);
    const removed = await pruneStaleAttachmentDirs(root, ['live'], Date.now());
    expect(removed).toBe(1);
    expect((await readdir(root)).sort()).toEqual(['fresh', 'live']);
    // 置き場が無くても落ちない。
    expect(await pruneStaleAttachmentDirs(join(root, 'none'), [], Date.now())).toBe(0);
    expect((await lstat(root)).isDirectory()).toBe(true);
  });
});

describe('runnerAttachmentBodyLimit', () => {
  it('合計上限の base64（×4/3）以上で、巨大な本文は抜けられない大きさに収まる', () => {
    const limit = runnerAttachmentBodyLimit(DEFAULT_ATTACHMENT_LIMITS);
    const maxBase64 = Math.ceil((DEFAULT_ATTACHMENT_LIMITS.maxTotalBytes * 4) / 3);
    expect(limit).toBeGreaterThan(maxBase64);
    expect(limit).toBeLessThan(maxBase64 + 10 * 1024 * 1024);
  });
});
