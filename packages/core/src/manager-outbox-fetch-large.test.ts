import { describe, expect, it } from 'vitest';

import {
  ATTACHMENT_REQUEST_TIMEOUT_MS,
  DEFAULT_ATTACHMENT_LIMITS,
  type AttachmentLimits,
} from './attachment.js';
import { MemoryAttachmentStore } from './attachment-memory.js';
import { sha256Hex } from './auth.js';
import {
  fetchManagerOutbox,
  OUTBOX_FETCH_FILE_TIMEOUT_MS,
  OUTBOX_FETCH_TOTAL_TIMEOUT_MS,
  outboxFetchDeadlineMs,
  outboxFetchTotalDeadlineMs,
} from './manager-outbox-fetch.js';
import type { RunnerClient, RunnerOutboxFile } from './runner-protocol.js';

// #4128 段3b: 大きいファイルの取り込みと、大きさに応じて延びる期限
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('outboxFetchDeadlineMs（(e) 期限の式）', () => {
  it('小さいファイルは既定の30秒のまま（60 秒 + size/1MiB が 30 秒を下回ることは無いので、式の床は 60 秒）', () => {
    expect(OUTBOX_FETCH_FILE_TIMEOUT_MS).toBe(30_000);
    // 60 秒の上乗せが常に効くので、式の値は 60 秒から始まる（既定の30秒は床としてだけ働く）
    expect(outboxFetchDeadlineMs(0)).toBe(60_000);
    expect(outboxFetchDeadlineMs(1)).toBe(60_001);
  });

  it('大きさに応じて、毎秒 1 MiB の見込みで延びる', () => {
    expect(outboxFetchDeadlineMs(100 * MIB)).toBe(60_000 + 100_000);
    expect(outboxFetchDeadlineMs(GIB)).toBe(60_000 + 1024_000);
    expect(outboxFetchDeadlineMs(2 * GIB)).toBe(60_000 + 2048_000);
  });

  it('上限は 1 時間（ATTACHMENT_REQUEST_TIMEOUT_MS）で、それ以上は延びない', () => {
    expect(ATTACHMENT_REQUEST_TIMEOUT_MS).toBe(3_600_000);
    // 境界: 60 秒 + size/1MiB が 3600 秒になる大きさ（3540 MiB）
    expect(outboxFetchDeadlineMs(3540 * MIB)).toBe(3_600_000);
    expect(outboxFetchDeadlineMs(3540 * MIB - MIB)).toBe(3_599_000);
    expect(outboxFetchDeadlineMs(3541 * MIB)).toBe(3_600_000);
    expect(outboxFetchDeadlineMs(100 * GIB)).toBe(3_600_000);
  });

  it('1報告の期限は、既定の 90 秒と各ファイルの期限の和の大きいほう（上限は 1 時間）', () => {
    expect(OUTBOX_FETCH_TOTAL_TIMEOUT_MS).toBe(90_000);
    expect(outboxFetchTotalDeadlineMs([])).toBe(90_000);
    expect(outboxFetchTotalDeadlineMs([60_000])).toBe(90_000);
    expect(outboxFetchTotalDeadlineMs([60_000, 60_000])).toBe(120_000);
    expect(outboxFetchTotalDeadlineMs([2_000_000, 2_000_000])).toBe(3_600_000);
  });
});

const BIG = new Uint8Array(500).fill(7);

function bigFile(): RunnerOutboxFile {
  return {
    fileId: 'f1',
    name: 'big.bin',
    mediaType: 'application/octet-stream',
    size: BIG.length,
    sha256: sha256Hex(BIG),
  };
}

function fakeRunner(): { runner: RunnerClient; opened: string[] } {
  const opened: string[] = [];
  const runner = {
    async openOutboxFile(_managerId: string, fileId: string) {
      opened.push(fileId);
      return {
        size: BIG.length,
        body: (async function* () {
          yield BIG;
        })(),
      };
    },
    async deleteOutboxFile() {},
  } as unknown as RunnerClient;
  return { runner, opened };
}

async function run(limits: AttachmentLimits) {
  const fake = fakeRunner();
  const store = new MemoryAttachmentStore({ limits });
  const result = await fetchManagerOutbox({
    runner: fake.runner,
    runnerNamesOutbox: true,
    managerId: 'mgr-1',
    reportId: 'report-1',
    files: [bigFile()],
    rejectedFiles: [],
    store,
    limits,
  });
  return { ...fake, store, result };
}

describe('(d) デーモンの大きいファイルの取り込み', () => {
  const base: AttachmentLimits = {
    ...DEFAULT_ATTACHMENT_LIMITS,
    maxFileBytes: 100,
    maxTotalBytes: 100,
  };

  it('外部ストレージが無効（maxLargeFileBytes が 0）なら、理由つきで取りに行かない', async () => {
    const { result, opened } = await run({ ...base, maxLargeFileBytes: 0 });
    expect(opened).toEqual([]);
    expect(result.attachments).toEqual([]);
    expect(result.rejected).toEqual([
      { name: 'big.bin', reason: expect.stringContaining('1つの上限（100 バイト）を超える') },
    ]);
    expect(result.rejected[0]?.reason).toContain('取りに行かなかった');
  });

  it('外部ストレージが有効（maxLargeFileBytes あり）なら、取り込まれて置き場に入る', async () => {
    const { result, opened, store } = await run({ ...base, maxLargeFileBytes: 100_000 });
    expect(opened).toEqual(['f1']);
    expect(result.rejected).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    const found = await store.get(result.attachments[0]!.id);
    expect(found?.bytes.length).toBe(BIG.length);
  });
});
