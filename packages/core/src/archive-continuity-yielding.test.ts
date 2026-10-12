import { describe, expect, it } from 'vitest';

import {
  classifyArchiveContinuity,
  classifyArchiveContinuityYielding,
  fingerprintArchiveBody,
  fingerprintArchiveBodyYielding,
} from './archive-continuity.js';

// 割って計算する版が、同期版と同じ値を返すこと（#4485）。かけらは 1M コード単位なので、それを跨ぐ長さで確かめる
const CHUNK = 1024 * 1024;
const PAIR = '😀'; // サロゲートペア（UTF-16 で2単位）

describe('fingerprintArchiveBodyYielding（#4485）', () => {
  it('かけらより短い本文・空の本文で、同期版と同じ値を返す', async () => {
    for (const body of ['', 'a', '日本語の本文\n', PAIR]) {
      expect(await fingerprintArchiveBodyYielding(body)).toEqual(fingerprintArchiveBody(body));
    }
  });

  it('かけらの境目でサロゲートペアが割れる位置でも、同期版と同じ値を返す', async () => {
    // 境目の直前（CHUNK-1）に上位サロゲートが来るように並べる
    const body = 'x'.repeat(CHUNK - 1) + PAIR + 'y'.repeat(CHUNK) + PAIR + 'z';
    expect(await fingerprintArchiveBodyYielding(body)).toEqual(fingerprintArchiveBody(body));
  });

  it('不正な片割れ（ペアになっていないサロゲート）を含んでも、同期版と同じ値を返す', async () => {
    const lone = '\ud83d';
    const body = 'a'.repeat(CHUNK - 1) + lone + 'b'.repeat(10) + '\ude00' + 'c';
    expect(await fingerprintArchiveBodyYielding(body)).toEqual(fingerprintArchiveBody(body));
  });

  it('数かけらぶんの本文でも、同期版と同じ値を返す', async () => {
    const body = '生ログの1行 ASCII mixed 😀\n'.repeat(Math.ceil((3 * CHUNK) / 20));
    expect(await fingerprintArchiveBodyYielding(body)).toEqual(fingerprintArchiveBody(body));
  });
});

describe('classifyArchiveContinuityYielding（#4485）', () => {
  const previousOf = (prefix: string) => ({ id: 'prev', ...fingerprintArchiveBody(prefix) });

  it('続いている・食い違う・前が無い・指紋が無いで、同期版と同じ答えを返す', async () => {
    const prefix = 'p'.repeat(CHUNK + 5) + PAIR;
    const cases: [Parameters<typeof classifyArchiveContinuity>[0], string][] = [
      [previousOf(prefix), `${prefix}続き`],
      [previousOf(prefix), `q${prefix.slice(1)}続き`],
      [null, 'first'],
      [{ id: 'prev', bodyChars: null, bodyMd5: null }, 'unknown'],
      // 前回のほうが長い（slice は本文の全体になる）
      [previousOf(`${prefix}もっと長い`), prefix],
    ];
    for (const [previous, body] of cases) {
      expect(await classifyArchiveContinuityYielding(previous, body)).toEqual(
        classifyArchiveContinuity(previous, body),
      );
    }
  });

  it('前回の長さがサロゲートペアの真ん中で終わっても、同期版と同じ答えを返す', async () => {
    const body = 'a'.repeat(CHUNK + 2) + PAIR + 'tail';
    // ペアの上位だけを含む長さ（slice で片割れになる）
    const cut = CHUNK + 3;
    const previous = { id: 'prev', ...fingerprintArchiveBody(body.slice(0, cut)) };
    expect(await classifyArchiveContinuityYielding(previous, body)).toEqual(
      classifyArchiveContinuity(previous, body),
    );
    expect((await classifyArchiveContinuityYielding(previous, body)).continuity).toBe('continues');
  });
});
