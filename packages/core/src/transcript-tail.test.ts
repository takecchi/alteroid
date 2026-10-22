import { statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDirSync } from '../../../vitest.tmpdir.js';

import { redactImagesInTranscriptYielding } from './transcript-image-redaction.js';
import { initialTailWindowBytes, readRedactedTranscriptTail } from './transcript-tail.js';

// 末尾の読み（#5160）は、いまの「全文を読んで伏せ、長ければ slice(-(maxChars + 1))」と同じ値でなければならない。

async function reference(path: string, maxChars: number): Promise<string> {
  const redacted = await redactImagesInTranscriptYielding(await readFile(path, 'utf8'));
  return redacted.length > maxChars ? redacted.slice(-(maxChars + 1)) : redacted;
}

function imageLine(bytes: number): string {
  const data = Buffer.alloc(bytes, 7).toString('base64');
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '見て' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ],
    },
  });
}

function textLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}

let dir: string;
let seq = 0;

beforeEach(() => {
  dir = makeTempDirSync('alteroid-transcript-tail-');
});

afterEach(() => {
  seq = 0;
});

function fileOf(body: string): string {
  const path = join(dir, `t-${String(seq++)}.jsonl`);
  writeFileSync(path, body, 'utf8');
  return path;
}

const lines = (n: number, make: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => make(i));

const CASES: Record<string, () => string> = {
  空: () => '',
  短い: () => `${textLine('短い')}\n`,
  改行で終わらない: () => `${textLine('a')}\n${textLine('b')}`,
  長い: () => `${lines(400, (i) => textLine(`行 ${String(i)} `.repeat(5))).join('\n')}\n`,
  末尾に画像の行: () =>
    `${lines(60, (i) => textLine(`前置き ${String(i)}`)).join('\n')}\n${imageLine(30_000)}\n`,
  画像の行が境目にまたがる: () =>
    `${lines(20, (i) => textLine(`前 ${String(i)}`)).join('\n')}\n${imageLine(50_000)}\n${lines(20, (i) => textLine(`後 ${String(i)}`)).join('\n')}\n`,
  日本語と絵文字: () =>
    `${lines(200, (i) => textLine(`日本語の行${String(i)}🙂👨‍👩‍👧‍👦 𠮷野家 あいうえお`)).join('\n')}\n`,
  画像が連続して縮む: () =>
    `${textLine('頭')}\n${lines(6, () => imageLine(40_000)).join('\n')}\n${textLine('尻')}\n`,
  '壊れた JSON の行': () => `${textLine('a')}\n{"type":"image" not json\n${textLine('b')}\n`,
  CRLF: () => `${textLine('a')}\r\n${textLine('b')}\r\n${textLine('c')}\r\n`,
};

describe('readRedactedTranscriptTail は、全文を伏せて slice(-(maxChars + 1)) と同じ値を返す（#5160）', () => {
  for (const [name, make] of Object.entries(CASES)) {
    it(`⭐ ${name}`, async () => {
      const path = fileOf(make());
      const full = await redactImagesInTranscriptYielding(await readFile(path, 'utf8'));
      const sizes = [1, 2, 10, 100, 1000, 5000, 100_000];
      // ちょうど・1つ手前・1つ後ろ
      const edge = [full.length - 1, full.length, full.length + 1].filter((n) => n >= 1);
      for (const maxChars of [...sizes, ...edge]) {
        // 小さい初期幅は、行や多バイト文字の途中から読み始める切り方を総当たりに近い形で作る
        for (const initialWindowBytes of [undefined, 1, 3, 17, 256, 4096]) {
          const got = await readRedactedTranscriptTail(path, maxChars, {
            ...(initialWindowBytes === undefined ? {} : { initialWindowBytes }),
          });
          expect(
            got.body,
            `maxChars=${String(maxChars)} window=${String(initialWindowBytes)}`,
          ).toBe(await reference(path, maxChars));
        }
      }
    });
  }

  it('伏せると短くなって maxChars に届かないとき、読む幅を広げ直して全文と同じ値になる', async () => {
    // 初期幅（maxChars*4 + 64KB ≒ 73KB）の中が1本の巨大な画像の行に収まり、欠けた先頭の行を捨てると空になる
    const body = `${textLine('頭の発言')}\n${imageLine(300_000)}\n${textLine('尻の発言')}\n`;
    const path = fileOf(body);
    const maxChars = 2000;
    const got = await readRedactedTranscriptTail(path, maxChars);

    expect(got.body).toBe(await reference(path, maxChars));
    expect(got.body).toContain('[画像の控え]');
    // 1回目の幅では足りず、読み直した（初期幅より多く読んでいる）
    expect(got.bytesRead).toBeGreaterThan(initialTailWindowBytes(maxChars));
  });

  it('大きいファイルでは、全部を読まない（読むバイト数がファイル全体より小さい）', async () => {
    const path = fileOf(
      `${lines(30_000, (i) => textLine(`発言 ${String(i)} ${'あ'.repeat(20)}`)).join('\n')}\n`,
    );
    const size = statSync(path).size;
    expect(size).toBeGreaterThan(2_000_000);

    const got = await readRedactedTranscriptTail(path, 200_000);

    expect(got.bytesRead).toBeLessThan(size);
    expect(got.bytesRead).toBeLessThanOrEqual(initialTailWindowBytes(200_000));
    expect(got.body).toBe(await reference(path, 200_000));
    expect(got.body.length).toBe(200_001);
  });

  it('無いパスは投げる（呼び手が「読めない」に倒す）', async () => {
    await expect(readRedactedTranscriptTail(join(dir, 'nothing.jsonl'), 10)).rejects.toThrow();
  });
});
