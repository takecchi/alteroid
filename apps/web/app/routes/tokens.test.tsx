// @vitest-environment jsdom
/**
 * `/tokens` — 認証トークンのトークン一覧・追加・削除・無効化/有効化・切り替えの設定・
 * 切り替えの履歴を見る画面（2026-09-14 から読み取り専用ではない）。
 *
 * ここで固定したいのは「値は追加フォーム以外へ出さない」「4状態を潰さない」
 * 「不明と、そもそも無いを混ぜない」「休止は原文と絶対時刻の両方を出す」
 * 「403 に専用の文言がある」「追加・削除・無効化/有効化は既存の一覧を土台に
 * `PUT /tokens` を全置換で呼ぶ」の各点。文言の細部より、この規律が壊れていないかを見る。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatDateTime } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Tokens from './tokens';

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

const DEFAULT_SETTINGS = { rotateOn: 'free_exhausted', cooldownMs: 18_000_000 };

/**
 * `/tokens` と `/journal` の両方をまとめて配る。
 *
 * この画面は2つの経路（`GET /tokens` / `GET /journal?type=token_rotation`）を
 * 同時に叩くので、どちらも知らないと `stubFetch` が「知らない URL」として
 * reject してしまう。
 */
function stubScreen(options: {
  tokens?: unknown[];
  settings?: unknown;
  /**
   * issue #2095。渡すと応答から `settings` を省き、代わりにこれを積む——
   * `GET /tokens` が切り替える条件・休止の設定を読めなかったときと同じ形
   * （`settings` を省いて `settingsUnreadable: { reason }` を返す。既定値では
   * 埋めない）。
   */
  settingsUnreadable?: { reason: string };
  /**
   * issue #2346。渡すと応答へ `rowsUnreadable` を足す（`GET /tokens` がプールの行を読めな
   * かったときと同じ形。渡さなければ鍵ごと無い）。`settings` の軸とは独立。
   */
  rowsUnreadable?: {
    count: number;
    rows: { id?: string; label?: string; reason: string }[];
  };
  tokensStatus?: number;
  journalEntries?: unknown[];
}) {
  const {
    tokens = [],
    settings = DEFAULT_SETTINGS,
    settingsUnreadable,
    rowsUnreadable,
    tokensStatus = 200,
    journalEntries = [],
  } = options;
  return stubFetch((url) => {
    if (url.includes('/tokens')) {
      if (tokensStatus !== 200) {
        return json({ error: '実行環境の持ち主だけが操作できる' }, tokensStatus);
      }
      const rows = rowsUnreadable === undefined ? {} : { rowsUnreadable };
      return settingsUnreadable === undefined
        ? json({ tokens, settings, ...rows })
        : json({ tokens, settingsUnreadable, ...rows });
    }
    if (url.includes('/journal')) return json({ entries: journalEntries });
    return undefined;
  });
}

async function waitForPoolLoaded(): Promise<void> {
  await screen.findByRole('heading', { name: 'トークン一覧' });
}

/**
 * **Router で包む（issue #2109）。** `Tokens`（`PoolAndSettings`）は使用量の
 * 画面から飛んできた行き先の id を `useSearchParams` で読むので、Router
 * 無しでは描けなくなった。形は `usage.test.tsx` の `renderUsage` と同じ
 * `createMemoryRouter` + `RouterProvider`。
 *
 * **`router` を返すのは、飛び先の id を URL 経由で渡すテストのためである**
 * （`initialEntries` に `/tokens?tokenId=<id>` を渡す）。
 */
function renderTokens(initialEntries: string[] = ['/']) {
  const router = createMemoryRouter([{ path: '/', Component: Tokens }], {
    initialEntries,
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

interface StubTokenRow {
  id: string;
  label: string;
  order: number;
  sha256?: string;
  source?: 'stored';
  disabledAt?: string;
}

/**
 * **状態を持つ** `/tokens` の stub（追加・削除・無効化/有効化を検証するため）。
 *
 * `useAddToken` / `useRemoveToken` / `useSetTokenDisabled`（`hooks/mutations.ts`）は
 * どれも「`GET /tokens` を取り直す → 加工 → `PUT /tokens`（全置換）」の形なので、
 * PUT を受けたらその場で一覧を書き換え、以降の GET（再検証も含む）がその状態を
 * 返すようにする——1回きりの応答では「置いたのに一覧に反映されない」を見逃す。
 *
 * **共有の `stubFetch` は使えない。** あちらが route へ渡すのは URL と `init` だけ
 * だが、`openapi-fetch` は `fetch(new Request(...))` の形で呼ぶので `init` が
 * `undefined` になり、method も本文も落ちる（`schedule.test.tsx` の同じ断り書きと
 * 同じ理由）。ここでは `globalThis.fetch` を自分で差し替える。
 */
function stubCrudScreen(
  initial: StubTokenRow[],
  options: {
    /** issue #2396。`PUT /tokens` が、保存はしたが読み直しに失敗した応答（200 + `viewUnavailable`）を返す。 */
    putViewUnavailable?: boolean;
  } = {},
) {
  let rows = initial;
  const puts: {
    id?: string;
    label: string;
    value?: string;
    order?: number;
    disabled?: boolean;
  }[][] = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (url.includes('/journal')) return json({ entries: [] });
    if (!url.includes('/tokens')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }
    if (method === 'PUT') {
      const body = (request !== null ? await request.json() : JSON.parse(String(init?.body))) as {
        tokens: {
          id?: string;
          label: string;
          value?: string;
          order?: number;
          disabled?: boolean;
        }[];
      };
      puts.push(body.tokens);
      rows = body.tokens.map((tokenInput, index) => {
        const existing = rows.find((row) => row.id === tokenInput.id);
        return {
          id: tokenInput.id ?? existing?.id ?? `new-${String(puts.length)}-${String(index)}`,
          label: tokenInput.label,
          order: tokenInput.order ?? index,
          sha256: existing?.sha256 ?? 'f'.repeat(12),
          source: 'stored' as const,
          ...(tokenInput.disabled === undefined
            ? existing?.disabledAt === undefined
              ? {}
              : { disabledAt: existing.disabledAt }
            : tokenInput.disabled
              ? { disabledAt: '2026-09-14T00:00:00.000Z' }
              : {}),
        };
      });
      if (options.putViewUnavailable === true) {
        // 保存（rows の更新）は済んでいる。応答にはプールの欄（`tokens` など）が無い。
        return json({ viewUnavailable: { reason: '保存した。保存後のプールを読み直せなかった' } });
      }
      return json({ tokens: rows, settings: DEFAULT_SETTINGS });
    }
    return json({ tokens: rows, settings: DEFAULT_SETTINGS });
  }) as typeof fetch;

  return { puts };
}

describe('/tokens 画面 — プールの4状態', () => {
  it('使用可能・休止中・無効化済み・失効を、それぞれ区別して出す', async () => {
    const future = Date.now() + 60 * 60 * 1000;
    stubScreen({
      tokens: [
        { id: 't-ready', label: 'ready-token', order: 0, sha256: 'a'.repeat(12), source: 'stored' },
        {
          id: 't-cooling',
          label: 'cooling-token',
          order: 1,
          sha256: 'b'.repeat(12),
          source: 'stored',
          cooldownUntil: future,
        },
        {
          id: 't-disabled',
          label: 'disabled-token',
          order: 2,
          sha256: 'c'.repeat(12),
          source: 'stored',
          disabledAt: '2026-08-01T00:00:00.000Z',
        },
        {
          id: 't-invalidated',
          label: 'invalidated-token',
          order: 3,
          sha256: 'd'.repeat(12),
          source: 'stored',
          invalidatedAt: '2026-08-02T00:00:00.000Z',
          invalidatedReason: 'account suspended',
        },
      ],
    });

    renderTokens();

    await waitForPoolLoaded();

    expect(screen.getByText('使用可能')).toBeTruthy();
    expect(screen.getByText('休止中')).toBeTruthy();
    // 同じ行に「戻す」ボタンがあるので、「戻らない」と言い切らない（#3071）。デーモンは
    // 無効化を自動では解かない（解くのは `disabled: false` を送る人間の操作だけ）ので、
    // 「自動では戻らない」と言い、戻し方を添える。
    expect(
      screen.getByText('無効化済み（人間が外した。自動では戻らない。「戻す」で人間が戻す）'),
    ).toBeTruthy();
    expect(screen.getByText('失効（通らないと確定。人間が外すまで戻らない）')).toBeTruthy();
    // 無効化済みの行は「戻す」を持ち、文面は「戻らない」で言い切らない。
    const disabledRow = screen.getByText('disabled-token').closest('li') as HTMLElement;
    expect(disabledRow.textContent).toContain(
      '人間が明示的に外した。自動では戻らない。「戻す」で人間が戻す',
    );
    expect(within(disabledRow).getByRole('button', { name: '戻す' })).toBeTruthy();
    expect(disabledRow.textContent).not.toMatch(/外した。戻らない/);
    // 4状態が4つとも別の label に付いていること（同じトークンに畳まれていない）。
    expect(screen.getByText('ready-token')).toBeTruthy();
    expect(screen.getByText('cooling-token')).toBeTruthy();
    expect(screen.getByText('disabled-token')).toBeTruthy();
    expect(screen.getByText('invalidated-token')).toBeTruthy();
  });
});

describe('/tokens 画面 — 値を絶対に出さない', () => {
  it('応答に value を混ぜても、画面のどこにも出ない', async () => {
    stubScreen({
      tokens: [
        {
          id: 't-leak',
          label: 'leaky-token',
          order: 0,
          sha256: 'a'.repeat(12),
          source: 'stored',
          // **本来サーバは value を返さない。** それでも「返ってきたら画面が
          // うっかり描く」形になっていないかを、ここで直接確かめる。
          value: 'sk-ant-oat01-super-secret-value-should-never-render',
        },
      ],
    });

    renderTokens();

    await waitForPoolLoaded();

    expect(screen.queryByText(/sk-ant-oat01-super-secret-value-should-never-render/)).toBeNull();
    expect(document.body.textContent).not.toContain(
      'sk-ant-oat01-super-secret-value-should-never-render',
    );
  });
});

describe('/tokens 画面 — 不明と、そもそも無いを混ぜない', () => {
  it('断られたことが一度も無い行は「断られた記録が無い」と言う（空文字や - で濁さない）', async () => {
    stubScreen({
      tokens: [{ id: 't-clean', label: 'clean-token', order: 0, sha256: 'e'.repeat(12) }],
    });

    renderTokens();

    await waitForPoolLoaded();
    expect(screen.getByText('断られた記録が無い')).toBeTruthy();
  });
});

describe('/tokens 画面 — recovery（回復の見込み）を潰さない', () => {
  it('time / action / unknown の3値が、それぞれ別の文言で出る', async () => {
    stubScreen({
      tokens: [
        {
          id: 't-time',
          label: 'recovery-time-token',
          order: 0,
          sha256: 'b'.repeat(12),
          lastRejectedAt: '2026-08-25T00:00:00.000Z',
          lastRejectedReason: 'resets in 5 hours',
          recovery: 'time',
        },
        {
          id: 't-action',
          label: 'recovery-action-token',
          order: 1,
          sha256: 'c'.repeat(12),
          lastRejectedAt: '2026-08-25T00:00:00.000Z',
          lastRejectedReason: 'payment required',
          recovery: 'action',
        },
        {
          id: 't-unknown-2',
          label: 'recovery-unknown-token-2',
          order: 2,
          sha256: 'd'.repeat(12),
          lastRejectedAt: '2026-08-25T00:00:00.000Z',
          lastRejectedReason: 'unrecognized message',
          recovery: 'unknown',
        },
      ],
    });

    renderTokens();

    await waitForPoolLoaded();

    expect(screen.getByText('分類: 時間で戻る見込み（リセットを待てば良い）')).toBeTruthy();
    expect(
      screen.getByText('分類: 人の対応が要る見込み（入金・管理者の設定・座席種別の変更など）'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        '分類: どちらとも言えない（時間で戻るとも、人の対応が要るとも言えない。捨てる判断の根拠にしないこと）',
      ),
    ).toBeTruthy();
  });
});

/**
 * **送られてくる値が、この画面の知らないものだったとき。**
 *
 * `apps/web` は Vercel、デーモンは Railway で**別に配られる**ので、
 * **サーバのほうが新しい窓が必ず在る。** 実際 `token_rotation` の `event` は
 * 「5値」として書かれていたのに 2026-08-26 に6値目が足された。
 *
 * **⚠️ そこで投げると、1行の未知が一覧を丸ごと消す。**
 */
describe('/tokens 画面 — 知らない値が届いても落ちない', () => {
  it('recovery が知らない値でも、画面は出て、知らないことをそのまま言う', async () => {
    stubScreen({
      tokens: [
        {
          id: 't-known',
          label: 'known-token',
          order: 0,
          sha256: 'e'.repeat(12),
        },
        {
          id: 't-future',
          label: 'from-newer-daemon',
          order: 1,
          sha256: 'f'.repeat(12),
          lastRejectedAt: '2026-08-25T00:00:00.000Z',
          lastRejectedReason: 'something new',
          // **この画面が知らない値。** 新しいデーモンが足したもの、という想定。
          recovery: 'a_value_this_bundle_does_not_know',
        },
      ],
    });

    renderTokens();

    await waitForPoolLoaded();

    // **一覧が消えていない。** 知っている行はそのまま出る。
    expect(screen.getByText('known-token')).toBeTruthy();
    expect(screen.getByText('from-newer-daemon')).toBeTruthy();
    // **黙って既知のどれかへ寄せない。** 知らないと言う。
    expect(screen.getByText(/未知の回復の見込み/)).toBeTruthy();
    expect(screen.getByText(/a_value_this_bundle_does_not_know/)).toBeTruthy();
  });

  it('切り替えの event が知らない値でも、履歴は出る', async () => {
    stubScreen({
      tokens: [{ id: 't-1', label: 'token-1', order: 0, sha256: 'a'.repeat(12) }],
      journalEntries: [
        {
          type: 'token_rotation',
          id: 'j-future',
          at: '2026-08-26T00:00:00.000Z',
          event: 'a_future_event',
          text: '新しいデーモンが書いた行',
        },
      ],
    });

    renderTokens();

    await waitForPoolLoaded();

    expect(await screen.findByText(/未知の切り替えの出来事/)).toBeTruthy();
    expect(screen.getByText(/a_future_event/)).toBeTruthy();
  });
});

describe('/tokens 画面 — 休止は原文と絶対時刻の両方を出す', () => {
  it('cooldownUntil の絶対時刻と lastRejectedReason の原文が両方出る', async () => {
    // 実測で報告されている桁の食い違い（休止は5時間なのに理由の原文は
    // 「weekly limit resets 5pm」）を再現する fixture。相対表現だけでは
    // この食い違いに気づけないので、絶対時刻が出ることを固定する。
    const cooldownUntil = Date.parse('2026-08-25T05:00:00.000Z');
    stubScreen({
      tokens: [
        {
          id: 't-mismatch',
          label: 'mismatch-token',
          order: 0,
          sha256: 'f'.repeat(12),
          cooldownUntil,
          lastRejectedAt: '2026-08-25T00:00:00.000Z',
          lastRejectedReason: 'weekly limit resets 5pm',
        },
      ],
    });

    renderTokens();

    await waitForPoolLoaded();

    const expectedAbsolute = formatDateTime(new Date(cooldownUntil).toISOString());
    expect(screen.getByText(new RegExp(expectedAbsolute.replace(/[/:]/g, '\\$&')))).toBeTruthy();
    expect(screen.getByText('weekly limit resets 5pm')).toBeTruthy();
    // **#683**: この fixture は出所を持っていない（デーモンが返さなかった）。
    // **黙らない** —— 何も書かないと「確かな値である」と読まれる。
    expect(screen.getByText(/記録が無い（この期限が確かな値かどうかは言えない）/)).toBeTruthy();
  });

  /**
   * **#683**: 絶対時刻だけでは「本物か推測か」が言えなかった。
   *
   * #678 の調査は「文言が 22:10 と言っているのに 01:42 と出ている」を人間が目で
   * 見つけたところから始まっている —— 行が出所を持てば、その1行で終わる。
   */
  it('休止の期限の出所を3値で言い分ける（推測のときだけ言う形にしない）', async () => {
    const cooldownUntil = Date.parse('2026-08-25T05:00:00.000Z');
    const cases = [
      { source: 'quota_reset' as const, text: /利用枠の復活時刻（確かな値）/ },
      { source: 'overage_reset' as const, text: /従量課金枠の復活時刻/ },
      { source: 'default' as const, text: /設定の既定（ただの推測である）/ },
    ];
    for (const one of cases) {
      stubScreen({
        tokens: [
          {
            id: `t-${one.source}`,
            label: one.source,
            order: 0,
            sha256: 'f'.repeat(12),
            cooldownUntil,
            cooldownSource: one.source,
          },
        ],
      });

      const view = renderTokens();

      await waitForPoolLoaded();
      expect(screen.getByText(one.text), one.source).toBeTruthy();
      view.unmount();
    }
  });
});

describe('/tokens 画面 — 空のプール', () => {
  it('プールが0件のとき、まだ1件も無いと言う（0件と未取得を混同しない）', async () => {
    stubScreen({ tokens: [] });

    renderTokens();

    expect(await screen.findByText(/登録された認証トークンがまだ1件も無い/)).toBeTruthy();
    // 対照（issue #2346）: 読めない行が無いので、その断りは出ない。
    expect(screen.queryByText(/読めないトークンの行/)).toBeNull();
  });

  /**
   * issue #2346（`settingsUnreadable` の行版）。`GET /tokens` が `rowsUnreadable` を返す
   * とき、読めた行が0件でも「登録された認証トークンがまだ1件も無い」「正常」と言わない。
   * 値は出ない（応答に混ぜても画面のどこにも出ない）。
   */
  it('読めない行が在るとき、「まだ1件も無い」と言わず、件数と id・ラベルを断る。値は出ない（#2346）', async () => {
    stubScreen({
      tokens: [],
      rowsUnreadable: {
        count: 1,
        rows: [{ id: 'tok-bad', label: 'broken-label', reason: '不正な欄: order' }],
      },
    });

    renderTokens();

    expect(await screen.findByText(/読めないトークンの行が 1 件ある/)).toBeTruthy();
    expect(screen.getByText('tok-bad')).toBeTruthy();
    expect(screen.getByText(/broken-label/)).toBeTruthy();
    expect(screen.getByText(/不正な欄: order/)).toBeTruthy();
    expect(screen.getByText(/読めた認証トークンの行は無い/)).toBeTruthy();
    expect(screen.queryByText(/登録された認証トークンがまだ1件も無い/)).toBeNull();
    expect(screen.queryByText(/これは正常/)).toBeNull();
  });

  it('読めない行が在っても、読めた行は今までどおり出る。設定の軸とは独立（#2346）', async () => {
    stubScreen({
      tokens: [{ id: 'tok-a', label: 'first', order: 0, sha256: 'aaaaaaaaaaaa', source: 'stored' }],
      rowsUnreadable: { count: 1, rows: [{ reason: '不正な行' }] },
    });

    renderTokens();

    expect(await screen.findByText(/読めないトークンの行が 1 件ある/)).toBeTruthy();
    expect(screen.getByText(/id もラベルも取れない/)).toBeTruthy();
    expect(screen.getByText('first')).toBeTruthy();
    // 設定は読めているので、設定の直し方のカードは出ない。
    expect(screen.queryByText(/切り替えの設定は読めない/)).toBeNull();
  });

  /**
   * issue #2354。書き換えは読めない行を「持ち越す」。断りは「捨てる」と言わず、消す口
   * （id を指すボタン）を案内する。id が取れない行にはボタンが無い。
   */
  it('断りは「持ち越す」と言い、「一緒に捨てる」と言わない。id のある行にだけ消すボタンが出る（#2354）', async () => {
    stubScreen({
      tokens: [],
      rowsUnreadable: {
        count: 2,
        rows: [
          { id: 'tok-bad', label: 'broken-label', reason: '不正な欄: order' },
          { reason: 'x' },
        ],
      },
    });

    renderTokens();

    expect(await screen.findByText(/捨てずに持ち越す/)).toBeTruthy();
    expect(screen.queryByText(/一緒に捨てる/)).toBeNull();
    expect(screen.getByText(/番号が取れない行は、ここでは消せない/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'この行を消す' })).toHaveLength(1);
  });

  it('「この行を消す」は id を指して POST /tokens/unreadable/remove を呼ぶ。値は送らない（#2354）', async () => {
    const posts: unknown[] = [];
    let unreadable = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? (typeof input === 'string' ? input : String(input));
      const method = request?.method ?? init?.method ?? 'GET';
      if (url.includes('/journal')) return json({ entries: [] });
      if (url.includes('/tokens/unreadable/remove') && method === 'POST') {
        posts.push(request !== null ? await request.json() : JSON.parse(String(init?.body)));
        unreadable = false;
        return json({ tokens: [], settings: DEFAULT_SETTINGS, removedIds: ['tok-bad'] });
      }
      if (url.includes('/tokens')) {
        return json({
          tokens: [],
          settings: DEFAULT_SETTINGS,
          ...(unreadable
            ? {
                rowsUnreadable: {
                  count: 1,
                  rows: [{ id: 'tok-bad', label: 'broken-label', reason: '不正な欄: order' }],
                },
              }
            : {}),
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;

    renderTokens();

    fireEvent.click(await screen.findByRole('button', { name: 'この行を消す' }));
    // 確認を経て初めて消す（#3067。確認のボタンは「消す」）。押しただけでは POST しない。
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('元に戻せません');
    expect(posts).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'この行を消す' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '消す' }),
    );

    await waitFor(() => {
      expect(posts).toEqual([{ ids: ['tok-bad'] }]);
    });
    // 消したあとの再取得で、読めない行の断りが消え、「まだ1件も無い」側へ戻る。
    await waitFor(() => {
      expect(screen.queryByText(/読めないトークンの行が/)).toBeNull();
    });
  });

  it('消した後の読み直しに失敗した応答（viewUnavailable, 200）でも、失敗とは言わず、再取得で消えた姿へ戻る（#2390）', async () => {
    const posts: unknown[] = [];
    let unreadable = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? (typeof input === 'string' ? input : String(input));
      const method = request?.method ?? init?.method ?? 'GET';
      if (url.includes('/journal')) return json({ entries: [] });
      if (url.includes('/tokens/unreadable/remove') && method === 'POST') {
        posts.push(request !== null ? await request.json() : JSON.parse(String(init?.body)));
        unreadable = false;
        return json({
          removedIds: ['tok-bad'],
          viewUnavailable: { reason: '読めない行は消した。消した後のプールを読み直せなかった' },
        });
      }
      if (url.includes('/tokens')) {
        return json({
          tokens: [],
          settings: DEFAULT_SETTINGS,
          ...(unreadable
            ? {
                rowsUnreadable: {
                  count: 1,
                  rows: [{ id: 'tok-bad', label: 'broken-label', reason: '不正な欄: order' }],
                },
              }
            : {}),
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;

    renderTokens();

    fireEvent.click(await screen.findByRole('button', { name: 'この行を消す' }));
    // 確認を経て初めて消す（#3067。確認のボタンは「消す」）。
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '消す' }),
    );

    await waitFor(() => {
      expect(posts).toEqual([{ ids: ['tok-bad'] }]);
    });
    await waitFor(() => {
      expect(screen.queryByText(/読めないトークンの行が/)).toBeNull();
    });
    expect(screen.queryByText(/消せなかった|保存できなかった/)).toBeNull();
  });
});

describe('/tokens 画面 — 403', () => {
  it('alteroid を使う許可が無ければ、専用の文言を出す（汎用のエラー表示に投げない）', async () => {
    stubScreen({ tokensStatus: 403 });

    renderTokens();

    expect(await screen.findByText(/使う許可があるアカウントだけが見られる/)).toBeTruthy();
    expect(screen.queryByText('alteroid token list')).toBeNull();
  });
});

describe('/tokens 画面 — 切り替えの履歴（エラー状況）', () => {
  it('journal の token_rotation が出る', async () => {
    stubScreen({
      tokens: [],
      journalEntries: [
        {
          type: 'token_rotation',
          id: 'jr-1',
          at: '2026-08-25T00:00:00.000Z',
          event: 'exhausted',
          earliestAt: '2026-08-25T05:00:00.000Z',
          text: '候補が無いので全層が止まった',
        },
      ],
    });

    renderTokens();

    expect(await screen.findByText('候補が無いので全層が止まった')).toBeTruthy();
    expect(screen.getByText('候補が無い（全層が止まる）')).toBeTruthy();
  });

  it('切り替えの記録が0件なら、その旨を言う', async () => {
    stubScreen({ tokens: [], journalEntries: [] });

    renderTokens();

    expect(await screen.findByText('切り替えの記録がまだ1件も無い。')).toBeTruthy();
  });
});

describe('/tokens 画面 — 追加・削除・無効化/有効化（2026-09-14）', () => {
  it('追加すると、既存行を土台に PUT /tokens が全置換で呼ばれ、一覧に反映される', async () => {
    const { puts } = stubCrudScreen([
      { id: 't-existing', label: 'existing-token', order: 0, sha256: 'a'.repeat(12) },
    ]);

    renderTokens();
    await waitForPoolLoaded();

    fireEvent.change(screen.getByLabelText('ラベル（人間が読む名前。秘密ではない）'), {
      target: { value: 'new-token' },
    });
    fireEvent.change(screen.getByLabelText('値（claude setup-token の出力）'), {
      target: { value: 'sk-ant-oat01-new-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));

    expect(await screen.findByText('new-token')).toBeTruthy();
    // 既存行はそのまま（label/order だけを土台にし、値は送り直さない）。
    expect(puts).toEqual([
      [
        { id: 't-existing', label: 'existing-token', order: 0 },
        { label: 'new-token', value: 'sk-ant-oat01-new-secret' },
      ],
    ]);
    // 送った値はどこにも出ない（送信後に state から消える）。
    expect(document.body.textContent).not.toContain('sk-ant-oat01-new-secret');
  });

  it('保存した後の読み直しに失敗した応答（viewUnavailable, 200）でも、失敗とは言わず、再取得で保存後の姿になる。フォームは空に戻る（#2396）', async () => {
    const { puts } = stubCrudScreen(
      [{ id: 't-existing', label: 'existing-token', order: 0, sha256: 'a'.repeat(12) }],
      { putViewUnavailable: true },
    );

    renderTokens();
    await waitForPoolLoaded();

    const labelInput = screen.getByLabelText('ラベル（人間が読む名前。秘密ではない）');
    const valueInput = screen.getByLabelText('値（claude setup-token の出力）');
    fireEvent.change(labelInput, { target: { value: 'new-token' } });
    fireEvent.change(valueInput, { target: { value: 'sk-ant-oat01-new-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));

    // 応答に一覧は無いが、再取得で保存後の姿（新しい行）が出る。
    expect(await screen.findByText('new-token')).toBeTruthy();
    expect(puts).toHaveLength(1);
    expect((labelInput as HTMLInputElement).value).toBe('');
    expect((valueInput as HTMLInputElement).value).toBe('');
    expect(screen.queryByText(/保存できなかった|失敗/)).toBeNull();
    expect(document.body.textContent).not.toContain('sk-ant-oat01-new-secret');
  });

  it('削除すると、その行を除いた一覧で PUT /tokens が呼ばれ、画面から消える', async () => {
    const { puts } = stubCrudScreen([
      { id: 't-a', label: 'token-a', order: 0, sha256: 'a'.repeat(12) },
      { id: 't-b', label: 'token-b', order: 1, sha256: 'b'.repeat(12) },
    ]);

    renderTokens();
    await waitForPoolLoaded();
    expect(await screen.findByText('token-a')).toBeTruthy();

    const rows = screen.getAllByText('削除');
    fireEvent.click(rows[0]!);
    // 確認を経て初めて消す（#3067。期待値は弱めていない）。
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '削除する' }),
    );

    await screen.findByText('token-b');
    expect(screen.queryByText('token-a')).toBeNull();
    expect(puts).toEqual([[{ id: 't-b', label: 'token-b', order: 1 }]]);
  });

  it('「削除」は押しただけでは PUT せず、「やめる」で閉じ、「削除する」で初めて PUT する（#3067）', async () => {
    const { puts } = stubCrudScreen([
      { id: 't-a', label: 'token-a', order: 0, sha256: 'a'.repeat(12) },
    ]);
    renderTokens();
    await waitForPoolLoaded();
    expect(await screen.findByText('token-a')).toBeTruthy();

    fireEvent.click(screen.getByText('削除'));
    const dialog = await screen.findByRole('alertdialog');
    // 事実どおり: 戻せない・値は画面に出ていないので入れ直しには元の出力が要る。
    expect(dialog.textContent).toContain('元に戻せません');
    expect(dialog.textContent).toContain('claude setup-token の出力がもう一度要ります');
    expect(puts).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'やめる' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(puts).toHaveLength(0);
    expect(screen.getByText('token-a')).toBeTruthy();

    fireEvent.click(screen.getByText('削除'));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: '削除する' }),
    );
    await waitFor(() => expect(puts).toHaveLength(1));
  });

  it('無効化すると disabled: true で PUT され、バッジが「無効化済み」に変わる', async () => {
    const { puts } = stubCrudScreen([
      { id: 't-a', label: 'token-a', order: 0, sha256: 'a'.repeat(12) },
    ]);

    renderTokens();
    await waitForPoolLoaded();

    fireEvent.click(screen.getByRole('button', { name: '無効化する' }));

    expect(await screen.findByText(/無効化済み/)).toBeTruthy();
    expect(puts).toEqual([[{ id: 't-a', label: 'token-a', order: 0, disabled: true }]]);
  });

  it('戻す（有効化）と disabled: false で PUT される', async () => {
    const { puts } = stubCrudScreen([
      {
        id: 't-a',
        label: 'token-a',
        order: 0,
        sha256: 'a'.repeat(12),
        disabledAt: '2026-08-01T00:00:00.000Z',
      },
    ]);

    renderTokens();
    await waitForPoolLoaded();

    fireEvent.click(screen.getByRole('button', { name: '戻す' }));

    expect(await screen.findByText('使用可能')).toBeTruthy();
    expect(puts).toEqual([[{ id: 't-a', label: 'token-a', order: 0, disabled: false }]]);
  });
});

/**
 * **状態を持つ** `/tokens` + `/tokens/policy` の stub（Issue #1123 の書き込みを
 * 検証するため）。`stubCrudScreen` と同じ理由（`openapi-fetch` が `fetch(new
 * Request(...))` の形で呼ぶので、共有の `stubFetch` では method / 本文が
 * 落ちる）で `globalThis.fetch` を自分で差し替える。
 *
 * **`/tokens/policy` を先に判定する** —— `'/tokens/policy'.includes('/tokens')`
 * が真なので、判定の順序を逆にすると素の `/tokens` 分岐に食われる。
 */
function stubPolicyScreen(initial: { rotateOn: string; cooldownMs: number } = DEFAULT_SETTINGS) {
  let settings: { rotateOn: string; cooldownMs: number } = { ...initial };
  const puts: { rotateOn?: string; cooldownMs?: number }[] = [];
  let failNext: { status: number; error: string } | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (url.includes('/journal')) return json({ entries: [] });

    if (url.includes('/tokens/policy')) {
      if (method !== 'PUT') return Promise.reject(new TypeError(`unexpected method: ${method}`));
      const body = (request !== null ? await request.json() : JSON.parse(String(init?.body))) as {
        rotateOn?: string;
        cooldownMs?: number;
      };
      puts.push(body);
      if (failNext !== undefined) {
        const { status, error } = failNext;
        return json({ error }, status);
      }
      settings = { ...settings, ...body };
      return json(settings);
    }

    if (url.includes('/tokens')) return json({ tokens: [], settings });

    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;

  return {
    puts,
    /** 次の `PUT /tokens/policy` をサーバの 400 として断らせる。 */
    failNextUpdate(status: number, error: string) {
      failNext = { status, error };
    },
  };
}

describe('/tokens 画面 — 切り替えの設定を書き込む（Issue #1123）', () => {
  it('切り替える条件を変えて保存すると、その値だけで PUT /tokens/policy が呼ばれ、表示に反映される', async () => {
    const { puts } = stubPolicyScreen();

    renderTokens();
    await waitForPoolLoaded();

    fireEvent.change(screen.getByLabelText('切り替える条件を変える'), { target: { value: 'off' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('切り替えない（記録だけする）')).toBeTruthy();
    expect(puts).toEqual([{ rotateOn: 'off', cooldownMs: DEFAULT_SETTINGS.cooldownMs }]);
  });

  it('休止の既定（ミリ秒）を変えて保存すると PUT /tokens/policy が呼ばれ、表示に反映される', async () => {
    const { puts } = stubPolicyScreen();

    renderTokens();
    await waitForPoolLoaded();

    fireEvent.change(screen.getByLabelText('休止の既定を変える（ミリ秒）'), {
      target: { value: '3600000' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(puts).toEqual([{ rotateOn: DEFAULT_SETTINGS.rotateOn, cooldownMs: 3_600_000 }]);
    });
    // 表示（時間換算）にも反映される。
    expect(await screen.findByText(/^1時間/)).toBeTruthy();
  });

  it('保存前は「変更なし」で無効、値を変えると「保存」で押せるようになる', async () => {
    stubPolicyScreen();

    renderTokens();
    await waitForPoolLoaded();

    expect(screen.getByRole('button', { name: '変更なし' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText('切り替える条件を変える'), {
      target: { value: 'overage_exhausted' },
    });

    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false);
  });

  /**
   * **受け入れ基準3（Issue #1123）**: 「正の整数」等の判定を画面側で先回りして
   * 弾かない —— 送って、サーバの 400 の本文をそのまま人間へ見せる。
   */
  it('サーバが 400 で断ったら、握り潰さずサーバの文言をそのまま出す', async () => {
    const { failNextUpdate } = stubPolicyScreen();
    failNextUpdate(400, '設定の入力の形が不正: cooldownMs は正の整数である必要がある');

    renderTokens();
    await waitForPoolLoaded();

    fireEvent.change(screen.getByLabelText('休止の既定を変える（ミリ秒）'), {
      target: { value: '-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(
      await screen.findByText(/設定の入力の形が不正: cooldownMs は正の整数である必要がある/),
    ).toBeTruthy();
    // 断られた値は画面に残る（黙って元に戻さない——人間が直して再送できる）。
    expect(screen.getByLabelText('休止の既定を変える（ミリ秒）')).toHaveProperty('value', '-1');
  });
});

/**
 * **状態を持つ** `/tokens` の stub（設定が読めない状態からの直し方を検証するため）。
 *
 * `stubPolicyScreen` と同じ形——`PUT /tokens/policy` を受けたら、以降の
 * `GET /tokens` がその値を `settings` として返すようにする（成功したら
 * `settingsUnreadable` の代わりに読める設定へ切り替わることを見るため）。
 * 保存に**失敗**させたいときは `failNextUpdate` で 500 を挟む——読めない現在値の
 * まま据え置かれることを見る。
 */
function stubUnreadableScreen(
  options: { reason: string; tokens?: unknown[] } = { reason: '理由' },
) {
  const { reason, tokens = [] } = options;
  let readable: { rotateOn: string; cooldownMs: number; updatedAt: string } | undefined;
  const puts: { rotateOn?: string; cooldownMs?: number }[] = [];
  let failNext: { status: number; error: string } | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (url.includes('/journal')) return json({ entries: [] });

    if (url.includes('/tokens/policy')) {
      if (method !== 'PUT') return Promise.reject(new TypeError(`unexpected method: ${method}`));
      const body = (request !== null ? await request.json() : JSON.parse(String(init?.body))) as {
        rotateOn?: string;
        cooldownMs?: number;
      };
      puts.push(body);
      if (failNext !== undefined) {
        const { status, error } = failNext;
        return json({ error }, status);
      }
      // **両方揃ったときだけ通る**（issue #2053 / PR #2075。読めない現在値は
      // 片方だけの patch では埋められない）——テストの stub でも同じ形にする。
      if (body.rotateOn === undefined || body.cooldownMs === undefined) {
        return json(
          { error: '設定の入力の形が不正: 読めない現在値は両方揃った patch でしか埋められない' },
          500,
        );
      }
      readable = {
        rotateOn: body.rotateOn,
        cooldownMs: body.cooldownMs,
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      return json(readable);
    }

    if (url.includes('/tokens')) {
      return readable === undefined
        ? json({ tokens, settingsUnreadable: { reason } })
        : json({ tokens, settings: readable });
    }

    return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
  }) as typeof fetch;

  return {
    puts,
    /** 次の `PUT /tokens/policy` をサーバの失敗として断らせる。 */
    failNextUpdate(status: number, error: string) {
      failNext = { status, error };
    },
  };
}

/**
 * issue #2096（#2095 の表示側）。切り替える条件・休止の設定（`GET /tokens` の
 * `settings`）が壊れて読めないとき、デーモンは `settings` を省いて
 * `settingsUnreadable.reason` を返す。**この画面は理由を出したうえで、両方
 * 選ばせて直す導線を持つ**（片方だけの保存は `PUT /tokens/policy` 側が
 * 500 で断るので、画面側も両方揃うまで保存を押せなくする）。
 */
describe('/tokens 画面 — 切り替えの設定が読めない（issue #2096）', () => {
  it('reason と「消えたのではない」旨が出て、一覧は道連れにならない。既定値は出ない', async () => {
    const REASON = 'rotateOn が enum の外（テスト用）';
    stubScreen({
      tokens: [
        { id: 't-a', label: 'ready-token', order: 0, sha256: 'a'.repeat(12), source: 'stored' },
      ],
      settingsUnreadable: { reason: REASON },
    });

    renderTokens();
    await waitForPoolLoaded();

    // 一覧（読めている分）は出ている——道連れになっていない。
    expect(screen.getByText('ready-token')).toBeTruthy();
    // 理由が出て、「消えたのではなく、読めない形で入っている」ことが伝わる。
    expect(
      await screen.findByText(new RegExp(`切り替えの設定は読めない（消えたのではなく.*${REASON}`)),
    ).toBeTruthy();
    // 既定値（`free_exhausted` 等）へすり替わっていない——未選択から始まる。
    expect(screen.getByLabelText('切り替える条件を選ぶ')).toHaveProperty('value', '');
    expect(screen.getByLabelText('休止の既定を選ぶ（ミリ秒）')).toHaveProperty('value', '');
    // 選ぶまで保存は押せない。
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
  });

  it('settingsUnreadable も reason も無いとき、理由不明のまま落ちない', async () => {
    // `stubScreen` は `settings` を既定値で埋めてしまう（省略できない）ので、
    // ここだけ生の `stubFetch` で「両方とも無い」応答を作る——実際にはこの
    // 形は起こらないはずだが、`data.settingsUnreadable?.reason` の `??` の
    // 倒れ先が実行時にも落ちないことを確かめる。
    stubFetch((url) => {
      if (url.includes('/tokens')) return json({ tokens: [] });
      if (url.includes('/journal')) return json({ entries: [] });
      return undefined;
    });

    renderTokens();
    await waitForPoolLoaded();

    expect(await screen.findByText(/切り替えの設定は読めない.*理由不明/)).toBeTruthy();
  });

  it('片方しか選んでいないと保存が押せない。両方選んで初めて押せる', async () => {
    stubUnreadableScreen({ reason: '理由' });

    renderTokens();
    await waitForPoolLoaded();

    fireEvent.change(screen.getByLabelText('切り替える条件を選ぶ'), {
      target: { value: 'off' },
    });
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByLabelText('休止の既定を選ぶ（ミリ秒）'), {
      target: { value: '3600000' },
    });
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', false);
  });

  it('両方選んで保存すると PUT /tokens/policy に両方の欄が送られ、成功後は一覧が取り直されて通常の設定カードに戻る', async () => {
    const { puts } = stubUnreadableScreen({ reason: '理由' });

    renderTokens();
    await waitForPoolLoaded();

    fireEvent.change(screen.getByLabelText('切り替える条件を選ぶ'), {
      target: { value: 'overage_exhausted' },
    });
    fireEvent.change(screen.getByLabelText('休止の既定を選ぶ（ミリ秒）'), {
      target: { value: '3600000' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    // 通常の SettingsCard（読み取り表示 + 「切り替える条件を変える」欄）に戻る。
    expect(await screen.findByLabelText('切り替える条件を変える')).toBeTruthy();
    expect(screen.queryByLabelText('切り替える条件を選ぶ')).toBeNull();
    expect(puts).toEqual([{ rotateOn: 'overage_exhausted', cooldownMs: 3_600_000 }]);
  });

  it('保存に失敗したら ErrorNote で理由を出し、下書きは残る', async () => {
    const { failNextUpdate } = stubUnreadableScreen({ reason: '理由' });
    failNextUpdate(500, '読めない現在値は両方揃った patch でしか埋められない');

    renderTokens();
    await waitForPoolLoaded();

    fireEvent.change(screen.getByLabelText('切り替える条件を選ぶ'), {
      target: { value: 'off' },
    });
    fireEvent.change(screen.getByLabelText('休止の既定を選ぶ（ミリ秒）'), {
      target: { value: '3600000' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(
      await screen.findByText(/読めない現在値は両方揃った patch でしか埋められない/),
    ).toBeTruthy();
    // 通常の設定カードには切り替わっていない（読めないまま）。
    expect(screen.getByLabelText('切り替える条件を選ぶ')).toHaveProperty('value', 'off');
  });
});

describe('/tokens 画面 — 使用量からの行き先（issue #2109）', () => {
  it('?tokenId=<id> で飛んでくると、その行が id を持ち、控えめに強調される', async () => {
    stubScreen({
      tokens: [
        { id: 't-a', label: 'row-a', order: 0, sha256: 'a'.repeat(12), source: 'stored' },
        { id: 't-b', label: 'row-b', order: 1, sha256: 'b'.repeat(12), source: 'stored' },
      ],
    });

    renderTokens(['/?tokenId=t-b']);
    await waitForPoolLoaded();
    await screen.findByText('row-b');

    const targetRow = document.getElementById('token-t-b');
    const otherRow = document.getElementById('token-t-a');
    expect(targetRow).not.toBeNull();
    // **強調は className（`border-primary`）で表現する**——`journal.tsx` の
    // 選択チップのテストと同じ測り方（issue #2109）。
    expect(targetRow?.className).toContain('border-primary');
    expect(otherRow?.className).not.toContain('border-primary');
    // 「プールに無い」の注記は出ない——id は実在する。
    expect(screen.queryByText(/はいまの一覧に無い/)).toBeNull();
  });

  it('?tokenId=<id> で飛んでくると、その行へ scrollIntoView する', async () => {
    stubScreen({
      tokens: [
        { id: 't-a', label: 'row-a', order: 0, sha256: 'a'.repeat(12), source: 'stored' },
        { id: 't-b', label: 'row-b', order: 1, sha256: 'b'.repeat(12), source: 'stored' },
      ],
    });

    // **`test-support.tsx` の `Element.prototype.scrollIntoView` は既に
    // no-op で埋めてある**（jsdom に無い口を埋める共有の足場）。ここではその
    // 上に spy を重ねて、正しい行の要素で呼ばれたことまで測る。
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');

    renderTokens(['/?tokenId=t-b']);
    await waitForPoolLoaded();
    await screen.findByText('row-b');

    const targetRow = document.getElementById('token-t-b');
    expect(scrollIntoView.mock.instances).toContain(targetRow);

    scrollIntoView.mockRestore();
  });

  it('プールに無い id で飛んでくると、頭に着地しつつ「いまの一覧に無い」旨を出す', async () => {
    stubScreen({
      tokens: [{ id: 't-a', label: 'row-a', order: 0, sha256: 'a'.repeat(12), source: 'stored' }],
    });

    renderTokens(['/?tokenId=t-removed']);
    await waitForPoolLoaded();

    // 事実だけを言う——なぜ無いかは断定しない（「外したか、別の実行環境のもの」）。
    expect(
      await screen.findByText(/はいまの一覧に無い（外したか、別の実行環境のもの）/),
    ).toBeTruthy();
    expect(screen.getByText('t-removed')).toBeTruthy();
    // 残っている行はそのまま出る——道連れになっていない。
    expect(screen.getByText('row-a')).toBeTruthy();
    // 実在しない id なので、どの行も強調されない。
    expect(document.getElementById('token-t-a')?.className).not.toContain('border-primary');
  });

  it('tokenId を付けずに開くと、これまでどおり何も強調されず注記も出ない', async () => {
    stubScreen({
      tokens: [{ id: 't-a', label: 'row-a', order: 0, sha256: 'a'.repeat(12), source: 'stored' }],
    });

    renderTokens();
    await waitForPoolLoaded();

    expect(screen.queryByText(/はいまの一覧に無い/)).toBeNull();
    expect(document.getElementById('token-t-a')?.className).not.toContain('border-primary');
  });
});

/**
 * 日誌が書けず、サーバが何も保存せずに 500 を返した回（#2886）。
 * 本文は `{ error: "記録（日誌）が書けなかったので、変更していません", code: "journal_write_failed" }`。
 * 保存そのものの失敗は `code` の無い `{ error }`。
 */
describe('/tokens 画面 — 日誌が書けず保存しなかった 500（#2886）', () => {
  const JOURNAL_MESSAGE = '記録（日誌）が書けなかったので、変更していません';
  const HINT =
    /何も変更していない。もう一度試すか、記録の置き場所（ディスクの空き・書き込み権限）を確かめる/;

  function stubFailingWrites(body: { error: string; code?: string }) {
    const puts: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = request?.url ?? (typeof input === 'string' ? input : String(input));
      const method = request?.method ?? init?.method ?? 'GET';
      if (url.includes('/journal')) return json({ entries: [] });
      if (url.includes('/tokens')) {
        if (method === 'PUT') {
          puts.push(url);
          return json(body, 500);
        }
        return json({
          tokens: [
            {
              id: 't-1',
              label: 'existing-token',
              order: 0,
              sha256: 'a'.repeat(12),
              source: 'stored',
            },
          ],
          settings: DEFAULT_SETTINGS,
        });
      }
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }) as typeof fetch;
    return { puts };
  }

  it('追加: サーバの文言と次にすることが出て、入力したラベルと値は残る', async () => {
    const { puts } = stubFailingWrites({ error: JOURNAL_MESSAGE, code: 'journal_write_failed' });
    renderTokens();
    await waitForPoolLoaded();

    fireEvent.change(screen.getByLabelText('ラベル（人間が読む名前。秘密ではない）'), {
      target: { value: 'new-token' },
    });
    fireEvent.change(screen.getByLabelText('値（claude setup-token の出力）'), {
      target: { value: 'sk-ant-oat01-keep-me' },
    });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));

    expect(await screen.findByText(JOURNAL_MESSAGE)).toBeTruthy();
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(puts).toHaveLength(1);
    // 保存していないので、貼り直しを強いない。
    expect(screen.getByLabelText('ラベル（人間が読む名前。秘密ではない）')).toHaveProperty(
      'value',
      'new-token',
    );
    expect(screen.getByLabelText('値（claude setup-token の出力）')).toHaveProperty(
      'value',
      'sk-ant-oat01-keep-me',
    );
  });

  it('有効化・無効化: 行のそばに同じ文言と次にすることが出る', async () => {
    stubFailingWrites({ error: JOURNAL_MESSAGE, code: 'journal_write_failed' });
    renderTokens();
    await waitForPoolLoaded();

    fireEvent.click(screen.getByRole('button', { name: '無効化する' }));

    expect(await screen.findByText(JOURNAL_MESSAGE)).toBeTruthy();
    expect(screen.getByText(HINT)).toBeTruthy();
  });

  it('切り替える条件・休止の既定: 同じ文言と次にすることが出て、変えた入力は残る', async () => {
    stubFailingWrites({ error: JOURNAL_MESSAGE, code: 'journal_write_failed' });
    renderTokens();
    await waitForPoolLoaded();

    fireEvent.change(screen.getByLabelText('切り替える条件を変える'), { target: { value: 'off' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(JOURNAL_MESSAGE)).toBeTruthy();
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.getByLabelText('切り替える条件を変える')).toHaveProperty('value', 'off');
  });

  it('code の無い失敗（保存そのものの失敗）は、サーバの文言だけで、日誌の案内は出さない', async () => {
    stubFailingWrites({ error: 'トークンのプールを保存できなかった' });
    renderTokens();
    await waitForPoolLoaded();

    fireEvent.click(screen.getByRole('button', { name: '無効化する' }));

    expect(await screen.findByText('トークンのプールを保存できなかった')).toBeTruthy();
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
