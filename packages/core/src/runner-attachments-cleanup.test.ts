import { createHash } from 'node:crypto';
import { access, mkdir, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { placeRunnerAttachments, RunnerAttachmentRejectedError } from './runner-attachments.js';
import type { RunnerAttachment } from './runner-protocol.js';

function attachmentOf(id: string, name: string, text: string): RunnerAttachment {
  const bytes = Buffer.from(text);
  return {
    id,
    name,
    mediaType: 'text/plain',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
  };
}

describe('placeRunnerAttachments の失敗時の掃除', () => {
  it('途中で落ちても、以前のメッセージで置いた同じ id の dir（担い手が読み中のもの）は消さない', async () => {
    const root = await makeTempDir('runner-att-cleanup-');
    const first = await placeRunnerAttachments({
      root,
      managerId: 'mgr-abc123',
      attachments: [attachmentOf('att-1', 'a.txt', '前のメッセージの中身')],
    });
    const earlier = first[0]?.path as string;
    await expect(readFile(earlier, 'utf8')).resolves.toBe('前のメッセージの中身');

    const outside = await makeTempDir('runner-att-cleanup-outside-');
    await symlink(outside, join(root, 'mgr-abc123', 'att-2'));
    await expect(
      placeRunnerAttachments({
        root,
        managerId: 'mgr-abc123',
        attachments: [attachmentOf('att-1', 'b.txt', '再送'), attachmentOf('att-2', 'c.txt', 'x')],
      }),
    ).rejects.toBeInstanceOf(RunnerAttachmentRejectedError);

    await expect(readFile(earlier, 'utf8')).resolves.toBe('前のメッセージの中身');
  });

  it('（対照）別 id の以前の添付は、失敗した呼び出しの掃除で消えない', async () => {
    const root = await makeTempDir('runner-att-cleanup-ctl-');
    const first = await placeRunnerAttachments({
      root,
      managerId: 'mgr-abc123',
      attachments: [attachmentOf('att-0', 'a.txt', '別 id')],
    });
    await mkdir(join(root, 'mgr-abc123', 'att-2'), { mode: 0o700 }).catch(() => undefined);
    await expect(
      placeRunnerAttachments({
        root,
        managerId: 'mgr-abc123',
        attachments: [attachmentOf('att-1', 'b.txt', 'y'), attachmentOf('../x', 'c.txt', 'x')],
      }),
    ).rejects.toBeInstanceOf(RunnerAttachmentRejectedError);
    await expect(readFile(first[0]?.path as string, 'utf8')).resolves.toBe('別 id');
  });

  it('新しく作った dir は、失敗時に消える（従来どおり）', async () => {
    const root = await makeTempDir('runner-att-cleanup-new-');
    const outside = await makeTempDir('runner-att-cleanup-new-outside-');
    await mkdir(join(root, 'mgr-abc123'), { mode: 0o700 });
    await symlink(outside, join(root, 'mgr-abc123', 'att-2'));
    await expect(
      placeRunnerAttachments({
        root,
        managerId: 'mgr-abc123',
        attachments: [attachmentOf('att-1', 'a.txt', '新規'), attachmentOf('att-2', 'c.txt', 'x')],
      }),
    ).rejects.toBeInstanceOf(RunnerAttachmentRejectedError);
    await expect(access(join(root, 'mgr-abc123', 'att-1'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('既に在る dir の中では、失敗した呼び出しが置いたファイルだけを消す（以前のファイルは残す）', async () => {
    const root = await makeTempDir('runner-att-cleanup-mixed-');
    const first = await placeRunnerAttachments({
      root,
      managerId: 'mgr-abc123',
      attachments: [attachmentOf('att-1', 'a.txt', '前の中身')],
    });
    const outside = await makeTempDir('runner-att-cleanup-mixed-outside-');
    await symlink(outside, join(root, 'mgr-abc123', 'att-2'));
    await expect(
      placeRunnerAttachments({
        root,
        managerId: 'mgr-abc123',
        attachments: [attachmentOf('att-1', 'b.txt', '再送'), attachmentOf('att-2', 'c.txt', 'x')],
      }),
    ).rejects.toBeInstanceOf(RunnerAttachmentRejectedError);
    await expect(readFile(first[0]?.path as string, 'utf8')).resolves.toBe('前の中身');
    await expect(access(join(root, 'mgr-abc123', 'att-1', 'b.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
