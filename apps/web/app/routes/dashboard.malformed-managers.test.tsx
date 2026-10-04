// @vitest-environment jsdom
/**
 * `GET /managers` の応答が `managers` の配列を持たない形のとき（版のずれ）のホーム（issue #2389）。
 *
 * ホームは旧「稼働中のマネージャー」カードを外し、`/managers` を**地図の下の断り（読めない委譲）**
 * のためだけに読む。だから倒れ先は2つ:
 *
 * 1. 形の違う応答で**ホームが落ちない**（`.filter` や `unreadable` の読みで画面ごと落とさない）
 * 2. 形の違う応答から**断りを作らない**（読めない委譲が「在る」とも「無い」とも言えない。地図そのものは
 *    `/topology` が持つので、地図は出たまま）
 *
 * 旧カードの「読めていない」文言そのものは、カードごと外したのでもう無い。
 */
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { storeTestBaseUrl } from '~/test-support';

import { renderHome, topologySnapshot } from './dashboard-test-helpers';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const MALFORMED: [string, { managers: unknown; unreadable?: unknown[] }][] = [
  ['managers が null', { managers: null, unreadable: [{ id: 'x', reason: 'r' }] }],
  ['managers が配列でないオブジェクト', { managers: {}, unreadable: [{ id: 'x', reason: 'r' }] }],
  ['managers の鍵が無い', {} as { managers: unknown }],
];

describe('/managers の応答が配列を持たない形のとき', () => {
  it.each(MALFORMED)('%s でも落ちず、地図は出たまま断りは作らない', async (_n, managers) => {
    renderHome({
      managers,
      topology: { frames: [{ event: 'snapshot', data: topologySnapshot() }] },
    });

    // 地図が出る（落ちていない）。
    expect(await screen.findByText('走っているマネージャーはいません')).toBeTruthy();
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
    expect(screen.queryByText(/読めない委譲/)).toBeNull();
  });

  it('対照: 配列を持つ応答で読めない行があれば、断りを出す', async () => {
    renderHome({
      managers: { managers: [], unreadable: [{ id: 'mgr-bad', reason: '不正な欄: status' }] },
      topology: { frames: [{ event: 'snapshot', data: topologySnapshot() }] },
    });

    expect(await screen.findByText(/読めない委譲が 1 件ある/)).toBeTruthy();
  });
});
