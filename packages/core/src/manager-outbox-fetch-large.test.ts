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

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe('outboxFetchDeadlineMs（(e) 期限の式）', () => {
  it('小さいファイル（30 MiB まで）は既定の 30 秒のまま', () => {
    expect(OUTBOX_FETCH_FILE_TIMEOUT_MS).toBe(30_000);
    expect(outboxFetchDeadlineMs(0)).toBe(30_000);
    expect(outboxFetchDeadlineMs(25 * MIB)).toBe(30_000);
    expect(outboxFetchDeadlineMs(30 * MIB)).toBe(30_000);
    expect(outboxFetchDeadlineMs(30 * MIB + 1)).toBe(30_001);
  });

  it('それより大きいものは、毎秒 1 MiB の見込みで延びる', () => {
    expect(outboxFetchDeadlineMs(100 * MIB)).toBe(100_000);
    expect(outboxFetchDeadlineMs(GIB)).toBe(1024_000);
    expect(outboxFetchDeadlineMs(2 * GIB)).toBe(2048_000);
  });

  it('上限は 1 時間（ATTACHMENT_REQUEST_TIMEOUT_MS）で、それ以上は延びない', () => {
    expect(ATTACHMENT_REQUEST_TIMEOUT_MS).toBe(3_600_000);
    expect(outboxFetchDeadlineMs(3600 * MIB - MIB)).toBe(3_599_000);
    expect(outboxFetchDeadlineMs(3600 * MIB)).toBe(3_600_000);
    expect(outboxFetchDeadlineMs(3601 * MIB)).toBe(3_600_000);
    expect(outboxFetchDeadlineMs(100 * GIB)).toBe(3_600_000);
  });

  it('1報告の期限は、既定の 90 秒に、各ファイルが 30 秒を超えて延びた分を足す（上限は 1 時間）', () => {
    expect(OUTBOX_FETCH_TOTAL_TIMEOUT_MS).toBe(90_000);
    expect(outboxFetchTotalDeadlineMs([])).toBe(90_000);
    expect(outboxFetchTotalDeadlineMs(Array.from({ length: 10 }, () => 30_000))).toBe(90_000);
    expect(outboxFetchTotalDeadlineMs([50, 50])).toBe(90_000);
    expect(outboxFetchTotalDeadlineMs([30_000, 2048_000])).toBe(90_000 + 2018_000);
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

function fakeRunner(): { runner: RunnerClient; opened: string[]; deleted: string[] } {
  const opened: string[] = [];
  const deleted: string[] = [];
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
    async deleteOutboxFile(_managerId: string, fileId: string) {
      deleted.push(fileId);
    },
  } as unknown as RunnerClient;
  return { runner, opened, deleted };
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
    const { result, opened, deleted } = await run({ ...base, maxLargeFileBytes: 0 });
    expect(opened).toEqual([]);
    // 二度と取りに行かないので、runner の退避先から消させる（24時間の掃除まで溜めない）
    expect(deleted).toEqual(['f1']);
    expect(result.attachments).toEqual([]);
    expect(result.rejected).toEqual([
      { name: 'big.bin', reason: expect.stringContaining('1つの上限（100 バイト）を超える') },
    ]);
    expect(result.rejected[0]?.reason).toContain('取りに行かなかった');
  });

  it('外部ストレージが有効（maxLargeFileBytes あり）なら、取り込まれて置き場に入る', async () => {
    const { result, opened, deleted, store } = await run({ ...base, maxLargeFileBytes: 100_000 });
    expect(opened).toEqual(['f1']);
    expect(deleted).toEqual(['f1']);
    expect(result.rejected).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    const found = await store.get(result.attachments[0]!.id);
    expect(found?.bytes.length).toBe(BIG.length);
  });
});
