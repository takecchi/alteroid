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

/**
 * 別口（`stageRunnerAttachment`。#4128 段3a）が、**何チャンクにも分かれて届く中身**を、順に1つのファイルへ書くこと。
 * 実際の転送はチャンクに分かれる（HTTP の本文・S3 のストリーム）。1チャンクの試験だけでは、
 * 2つめ以降のチャンクが先頭へ上書きされる形を見逃す。
 */

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

describe('applyAttachmentRequestTimeout（HTTP の1リクエストの持ち時間）', () => {
  it('Node 既定の 300 秒を、2 GiB を遅い回線でも送れる長さ（1時間）へ上げる', async () => {
    const { createServer } = await import('node:http');
    const server = createServer();
    expect(server.requestTimeout).toBe(300_000);
    applyAttachmentRequestTimeout(server);
    expect(server.requestTimeout).toBe(ATTACHMENT_REQUEST_TIMEOUT_MS);
    // 2 GiB を 50 Mbps で送ると約 344 秒。それより十分長い
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
