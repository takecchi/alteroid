import { createManagerPool, createMemoryStores, createRunnerRegistry, reasonOf } from '@alteroid/core';
import type { CloneHost, Stores } from '@alteroid/core';
import { HTTPException } from 'hono/http-exception';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';

/**
 * `.onError`（Issue #249）専用の検証。
 *
 * **`app.test.ts` には置かない。** 別の PR（#398）がそのファイルを編集中で、
 * 衝突を避けるためにここへ分けた（設計そのものはこの分離と無関係——検証したいのは
 * `createApp` が返す Hono アプリの `onError` の配線であって、既存のどのテスト
 * グループにも属さない新しい観点である）。
 *
 * `/access` を踏み台に使う。`GET /access` は `requireOperator` を通ったあと
 * `stores.auth.listAccounts()` を await するだけで、呼び出し側は try/catch を
 * 持たない——投げれば素通りで `createApp` の `.onError` に落ちる、いちばん
 * 単純な実在の経路である。
 */

/**
 * `clone` はこのテストでは一度も呼ばれない（`/access` はクローンを経由しない）。
 * `managers` だけは実物（`createManagerPool`）を使う——手で書いた `ManagerPool` は
 * 本物の実装が増やした分岐に追随しない（AGENTS.md「テストの足場・スタブ・
 * モックは、動くのに嘘をつく」と同じ理由）。
 */
function fakeCloneHost(stores: Stores): CloneHost {
  return {
    post: () => {},
    subscribe: () => () => {},
    async endConversation() {},
    async answerApproval() {},
    managers: createManagerPool({ stores, post: () => {}, runners: createRunnerRegistry() }),
    async stop() {},
  };
}

describe('.onError（Issue #249: Hono の既定エラーハンドラの console.error(err) を、本文を出さない形に置き換える）', () => {
  let stores: Stores;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stores = createMemoryStores();
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
  });

  it('HTTPException 以外の例外は、応答を既定のまま500に保ち、stderr へ1行だけ・reasonOf で切って・alteroidd: の接頭辞つきで残す（本文は出さない）', async () => {
    // 260字の連続文字＋本文らしい語＋改行付きの2行目。`reasonOf`（`REASON_LIMIT=200`）
    // が1行目だけ・200字で切ることを確かめる（`packages/core/src/dropped-record.ts`）。
    const secretish = `${'B'.repeat(260)} token=SHOULD-NOT-LEAK\nSECOND LINE at foo.ts:1:1`;
    stores.auth.listAccounts = async () => {
      throw new Error(secretish);
    };
    const app = createApp({
      clone: fakeCloneHost(stores),
      stores,
      token: 'test-token',
      shutdown: () => {},
    });

    const res = await app.request('/access');

    // **応答（500 / Internal Server Error）は既定と同じに保つ。**
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');

    const lines = stderr.mock.calls.map((call) => String(call[0]));
    const matching = lines.filter((line) => line.includes('alteroidd:'));
    expect(matching).toHaveLength(1);
    const line = matching[0]!;

    expect(line.startsWith('alteroidd: ')).toBe(true);
    // 呼び出し側が新しい切り方を発明していない——`dropped-record.ts` の既存の
    // `reasonOf` をそのまま呼んだ結果と一致する。
    expect(line).toContain(reasonOf(new Error(secretish)));
    // 1行目だけ・200字で切られているので、2行目とその手前の一部は出ない。
    expect(line).not.toContain('SECOND LINE');
    expect(line).not.toContain('at foo.ts:1:1');
    expect(line).not.toContain('SHOULD-NOT-LEAK');
    // console.error(err) がやる「エラーオブジェクトを丸ごと出す」形（スタック
    // トレースを含む多行の出力）になっていない——1回の書き込みで1行だけ。
    expect(line).not.toContain('\n    at ');
  });

  it('HTTPException は既定と同じ応答（getResponse() の内容）を返し、ログには残さない', async () => {
    stores.auth.listAccounts = async () => {
      throw new HTTPException(418, { message: 'teapot' });
    };
    const app = createApp({
      clone: fakeCloneHost(stores),
      stores,
      token: 'test-token',
      shutdown: () => {},
    });

    const res = await app.request('/access');

    expect(res.status).toBe(418);
    expect(await res.text()).toBe('teapot');
    expect(stderr.mock.calls.some((call) => String(call[0]).includes('alteroidd:'))).toBe(false);
  });
});
