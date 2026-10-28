import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { emptyAttachmentUsage } from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';
import {
  deleteFile,
  describeAttachmentAlreadyGoneRetraction,
  renderFileUsage,
} from './file-tools.js';

const COPIES_DIR = join(tmpdir(), 'alteroid-file-tools-test-copies-none');

async function putOne(store: MemoryAttachmentStore) {
  return store.put({ name: 'a.txt', mediaType: 'text/plain', bytes: new Uint8Array(3).fill(65) });
}

describe('deleteFile: 「消す」の行を書いた後で添付が無くなっていた回', () => {
  it('meta 在りで remove が false: 打ち消しの口が呼ばれ、結果は「無い」のまま', async () => {
    const attachments = new MemoryAttachmentStore();
    const meta = await putOne(attachments);
    vi.spyOn(attachments, 'remove').mockResolvedValue(false);
    const before = vi.fn(async () => {});
    const gone = vi.fn(async () => {});
    const result = await deleteFile({ attachments }, COPIES_DIR, meta.id, before, undefined, gone);
    expect(before).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledWith(meta);
    expect(result).toContain('は無い');
    expect(result).not.toContain('日誌に残る');
  });

  it('meta 無しで remove が false: 打ち消しの口は呼ばれない', async () => {
    const attachments = new MemoryAttachmentStore();
    const gone = vi.fn(async () => {});
    const before = vi.fn(async () => {});
    const result = await deleteFile(
      { attachments },
      COPIES_DIR,
      'no-such',
      before,
      undefined,
      gone,
    );
    expect(before).not.toHaveBeenCalled();
    expect(gone).not.toHaveBeenCalled();
    expect(result).toContain('は無い');
  });

  it('meta 無しで remove が true: 成功文に「日誌に残る」が付かない', async () => {
    const attachments = new MemoryAttachmentStore();
    const meta = await putOne(attachments);
    vi.spyOn(attachments, 'getMeta').mockResolvedValue(undefined);
    const before = vi.fn(async () => {});
    const result = await deleteFile({ attachments }, COPIES_DIR, meta.id, before);
    expect(before).not.toHaveBeenCalled();
    expect(result).toContain('中身を消した');
    expect(result).not.toContain('日誌に残る');
  });

  it('meta 在りで remove が true: 成功文に「日誌に残る」が付く', async () => {
    const attachments = new MemoryAttachmentStore();
    const meta = await putOne(attachments);
    const result = await deleteFile({ attachments }, COPIES_DIR, meta.id, async () => {});
    expect(result).toContain('日誌に残る');
  });

  it('文言の共通関数: actor を付けると grounds の先頭に入る', async () => {
    const attachments = new MemoryAttachmentStore();
    const meta = await putOne(attachments);
    const plain = describeAttachmentAlreadyGoneRetraction(meta);
    const withActor = describeAttachmentAlreadyGoneRetraction(meta, '人間');
    expect(plain.decision).toBe(withActor.decision);
    expect(plain.decision).toContain(meta.id);
    expect(withActor.grounds).toBe(`人間。${plain.grounds}`);
  });
});

function usageWithKeys(keys: Record<string, { count: number; totalBytes: number }>) {
  return { ...emptyAttachmentUsage(), byIntegrationKey: keys };
}

describe('renderFileUsage: 連携の鍵別', () => {
  it('鍵が空なら、鍵別の行を足さず今の出力のまま', () => {
    const usage = emptyAttachmentUsage();
    expect(renderFileUsage(usage)).toBe('置き場の使用量: 0 件 0 B');
    usage.count = 1;
    usage.totalBytes = 10;
    usage.byFrom.human = { count: 1, totalBytes: 10 };
    expect(renderFileUsage(usage)).toBe('置き場の使用量: 1 件 10 B\n出所別: 人間 1 件 10 B');
  });

  it('大きい順に並び、同じ大きさなら鍵 id の昇順', () => {
    const text = renderFileUsage(
      usageWithKeys({
        'key-b': { count: 2, totalBytes: 500 },
        'key-z': { count: 1, totalBytes: 2048 },
        'key-a': { count: 3, totalBytes: 500 },
      }),
    );
    expect(text.split('\n').at(-1)).toBe(
      '連携の鍵別: key-z 1 件 2.0 KiB / key-a 3 件 500 B / key-b 2 件 500 B',
    );
  });

  it('21 本なら 20 本までで「ほか 1 本」、20 本ちょうどなら出ない', () => {
    const keys = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `key-${String(i).padStart(2, '0')}`,
          { count: 1, totalBytes: 100 + i },
        ]),
      );
    const last21 = renderFileUsage(usageWithKeys(keys(21)))
      .split('\n')
      .at(-1)!;
    expect(last21.endsWith(' / ほか 1 本')).toBe(true);
    expect(last21.split(' / ')).toHaveLength(21);
    expect(last21).not.toContain('key-00');
    expect(renderFileUsage(usageWithKeys(keys(20)))).not.toContain('ほか');
  });
});
