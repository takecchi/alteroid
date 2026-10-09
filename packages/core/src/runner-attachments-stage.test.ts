import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';
import { ATTACHMENT_REQUEST_TIMEOUT_MS, applyAttachmentRequestTimeout } from './attachment.js';
import {
  RunnerAttachmentStageError,
  StagedAttachmentLedger,
  stageRunnerAttachment,
} from './runner-attachments.js';
import { createLocalRunner } from './runner-local.js';

const ID = '11111111-2222-4333-8444-555555555555';

function chunksOf(total: number, chunk: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let start = 0; start < total; start += chunk) {
    const part = new Uint8Array(Math.min(chunk, total - start));
    for (let i = 0; i < part.length; i += 1) part[i] = ((start + i) * 31 + 7) & 0xff;
    out.push(part);
  }
  return out;
}

async function* bodyOf(parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

describe('stageRunnerAttachment: チャンクに分かれた中身', () => {
  it('何チャンクに分かれても、順に並べた同じバイトになる', async () => {
    const root = await makeTempDir('alteroid-runner-stage-');
    const parts = chunksOf(200_003, 65_536);
    expect(parts.length).toBeGreaterThan(3);
    const whole = Buffer.concat(parts);
    const ledger = new StagedAttachmentLedger();

    const entry = await stageRunnerAttachment({
      root,
      managerId: 'mgr-1',
      id: ID,
      name: 'big.bin',
      size: whole.length,
      sha256: createHash('sha256').update(whole).digest('hex'),
      body: bodyOf(parts),
      limit: 1_000_000,
      ledger,
    });

    expect(Buffer.compare(await readFile(entry.path), whole)).toBe(0);
    expect(ledger.get('mgr-1', ID)).toEqual(entry);
  });

  it('途中のチャンクで申告を超えたら、そこで断り、何も残さない', async () => {
    const root = await makeTempDir('alteroid-runner-stage-');
    const parts = chunksOf(200_003, 65_536);
    const ledger = new StagedAttachmentLedger();

    const error = await stageRunnerAttachment({
      root,
      managerId: 'mgr-1',
      id: ID,
      name: 'big.bin',
      size: 100_000,
      sha256: 'a'.repeat(64),
      body: bodyOf(parts),
      limit: 1_000_000,
      ledger,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RunnerAttachmentStageError);
    expect((error as RunnerAttachmentStageError).status).toBe(413);
    expect(await readdir(join(root, 'mgr-1'))).toEqual([]);
    expect(ledger.get('mgr-1', ID)).toBeUndefined();
  });
});

describe('in-process の runner の別口は、signal で読むのをやめる（#4128 段3b）', () => {
  it('本文が止まったまま中断されたら、投げて何も残さない', async () => {
    const root = await makeTempDir('alteroid-runner-stage-local-');
    const runner = createLocalRunner({
      runnerId: 'runner-local',
      workspacePath: root,
      env: {},
      attachmentsRoot: root,
    });
    const controller = new AbortController();
    let firstChunkRead!: () => void;
    const firstChunk = new Promise<void>((resolve) => {
      firstChunkRead = resolve;
    });
    async function* stalled(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(10);
      firstChunkRead();
      await new Promise<never>(() => undefined);
    }

    expect(runner.stageAttachment).toBeTypeOf('function');
    const staging = runner.stageAttachment!(
      'mgr-1',
      {
        id: ID,
        name: 'big.bin',
        mediaType: 'application/octet-stream',
        size: 100,
        sha256: 'a'.repeat(64),
      },
      stalled(),
      { signal: controller.signal },
    );
    await firstChunk;
    controller.abort(new Error('時間の上限を超えた'));

    await expect(staging).rejects.toThrow('時間の上限を超えた');
    expect(await readdir(join(root, 'mgr-1'))).toEqual([]);
  });
});

describe('applyAttachmentRequestTimeout（HTTP の1リクエストの持ち時間）', () => {
  it('Node 既定の 300 秒を、2 GiB を遅い回線でも送れる長さ（1時間）へ上げる', async () => {
    const { createServer } = await import('node:http');
    const server = createServer();
    expect(server.requestTimeout).toBe(300_000);
    applyAttachmentRequestTimeout(server);
    expect(server.requestTimeout).toBe(ATTACHMENT_REQUEST_TIMEOUT_MS);
    expect(ATTACHMENT_REQUEST_TIMEOUT_MS).toBeGreaterThan(((2 * 1024 ** 3 * 8) / 50e6) * 1000 * 5);
  });

  it('すでに長い・無制限（0）のものは縮めない', () => {
    const longer = { requestTimeout: ATTACHMENT_REQUEST_TIMEOUT_MS * 2 };
    applyAttachmentRequestTimeout(longer);
    expect(longer.requestTimeout).toBe(ATTACHMENT_REQUEST_TIMEOUT_MS * 2);
    const unlimited = { requestTimeout: 0 };
    applyAttachmentRequestTimeout(unlimited);
    expect(unlimited.requestTimeout).toBe(0);
  });
});
