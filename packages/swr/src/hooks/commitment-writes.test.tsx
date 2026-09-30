// @vitest-environment jsdom
/**
 * 台帳の書き込みが断られても、台帳を取り直す（issue #2455）。
 *
 * close / 編集 / 評定 / 積む は、裏で先に片付いた行（クローンの
 * `commitment_close`・別のタブや CLI）に対して 409 で断られる。`expectOk` の
 * 例外でそのまま抜けると取り直しに届かず、片付いた行が未了の見た目で残る。
 * `useAnswerApproval`（#1619）と同じく、失敗しても取り直すことをここで固定する。
 *
 * **取り直したことの証拠は `GET /commitments` の回数である。** 両方のキー
 * （`includeClosed=false` / `true`）を購読しておき、書き込みの後にそれぞれが
 * もう一度叩かれたかを見る。
 */
import { cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import {
  useAppraiseCommitment,
  useCloseCommitment,
  useEditCommitment,
  usePushCommitment,
} from './mutations';
import { useCommitments } from './queries';
import { writeThenRefresh } from './write-then-refresh';
import { json, Providers, stubFetch, storeTestBaseUrl } from '../test-support';

type Writes = {
  push: ReturnType<typeof usePushCommitment>;
  close: ReturnType<typeof useCloseCommitment>;
  appraise: ReturnType<typeof useAppraiseCommitment>;
  edit: ReturnType<typeof useEditCommitment>;
};

let writes: Writes | undefined;

function Probe({ onWrites }: { onWrites: (next: Writes) => void }) {
  // 両方のキーを購読する（購読の無いキーは `mutate` しても取り直されない）。
  useCommitments(false);
  useCommitments(true);
  const push = usePushCommitment();
  const close = useCloseCommitment();
  const appraise = useAppraiseCommitment();
  const edit = useEditCommitment();
  useEffect(() => {
    onWrites({ push, close, appraise, edit });
  }, [onWrites, push, close, appraise, edit]);
  return null;
}

function receiveWrites(next: Writes): void {
  writes = next;
}

const REJECTION = 'c-1 は既に done に片付いている';

/**
 * `GET /commitments` は空の一覧、書き込みはすべて 409 で断る。
 *
 * 読みと書きは `includeClosed` の有無で分ける（`useCommitments` は必ず付け、
 * `POST /commitments` は付けない）。経路には `Request` で来るので `init` から
 * メソッドは読めない。
 */
function stubRejectingWrites() {
  return stubFetch((url) => {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith('/commitments')) return undefined;
    if (parsed.pathname === '/commitments' && parsed.searchParams.has('includeClosed')) {
      return json({ entries: [] });
    }
    return json({ error: REJECTION }, 409);
  });
}

function getCount(calls: string[], includeClosed: boolean): number {
  return calls.filter((url) => {
    const parsed = new URL(url);
    return (
      parsed.pathname === '/commitments' &&
      parsed.searchParams.get('includeClosed') === String(includeClosed)
    );
  }).length;
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  writes = undefined;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const CASES: { name: string; run: (w: Writes) => Promise<void> }[] = [
  { name: 'close', run: (w) => w.close('c-1', 'もう済んだ') },
  { name: '編集', run: (w) => w.edit('c-1', '直した本文') },
  { name: '評定', run: (w) => w.appraise('c-1', 'good') },
  { name: '積む', run: (w) => w.push('新しい約束') },
];

describe('台帳の書き込みが 409 で断られたとき（issue #2455）', () => {
  it.each(CASES)('$name: 失敗は投げたまま、台帳の両方のキーを取り直す', async ({ run }) => {
    const { calls } = stubRejectingWrites();
    render(
      <Providers>
        <Probe onWrites={receiveWrites} />
      </Providers>,
    );
    await waitFor(() => {
      expect(getCount(calls, false)).toBe(1);
      expect(getCount(calls, true)).toBe(1);
      expect(writes).toBeDefined();
    });

    // `Promise.prototype.catch` で受ける（`expect(...).rejects` は取り直しの
    // 回数を見る前に値を捨ててしまうので、失敗の中身も同じ場で確かめる）。
    const error: unknown = await run(writes!).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // 失敗を握り潰さない——サーバの文言のまま呼び出し側へ届く。
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).message).toContain(REJECTION);

    // 断られた後にも、両方のキーをもう一度取りに行っている。
    expect(getCount(calls, false)).toBeGreaterThanOrEqual(2);
    expect(getCount(calls, true)).toBeGreaterThanOrEqual(2);
  });
});

/**
 * 取り直しそのものの失敗が、書き込みの失敗を上書きしないこと。
 *
 * SWR の `mutate(key)` は取得の失敗を自分で握る（キャッシュの `error` に置く）ので、
 * 画面の経路からは取り直しを失敗させられない。だから土台の `writeThenRefresh` を
 * 直接叩いて固定する。
 */
describe('writeThenRefresh', () => {
  it('書き込みも取り直しも失敗したら、書き込みの失敗を投げる', async () => {
    const writeError = new Error('書き込みの失敗');
    const refreshError = new Error('取り直しの失敗');
    let refreshed = 0;
    const thrown: unknown = await writeThenRefresh(
      () => Promise.reject(writeError),
      () => {
        refreshed += 1;
        return Promise.reject(refreshError);
      },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(refreshed).toBe(1);
    expect(thrown).toBe(writeError);
  });

  it('書き込みが失敗しても取り直しを回し、書き込みの失敗を投げる', async () => {
    const writeError = new Error('書き込みの失敗');
    let refreshed = 0;
    const thrown: unknown = await writeThenRefresh(
      () => Promise.reject(writeError),
      () => {
        refreshed += 1;
        return Promise.resolve();
      },
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(refreshed).toBe(1);
    expect(thrown).toBe(writeError);
  });

  it('書き込みが通って取り直しだけが失敗したら、取り直しの失敗を投げる', async () => {
    const refreshError = new Error('取り直しの失敗');
    const thrown: unknown = await writeThenRefresh(
      () => Promise.resolve(),
      () => Promise.reject(refreshError),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(thrown).toBe(refreshError);
  });

  it('どちらも通れば何も投げない', async () => {
    let refreshed = 0;
    await writeThenRefresh(
      () => Promise.resolve(),
      () => {
        refreshed += 1;
        return Promise.resolve();
      },
    );
    expect(refreshed).toBe(1);
  });
});
