// @vitest-environment jsdom
/**
 * マネージャー詳細が、**確認へ上がらず止められた件数**を出すこと。
 *
 * 一覧（`managers.test.tsx`）と対になっている。あちらは新しい側から3種で畳むが、
 * ここは畳まない — 詳細まで降りてきた人間が見に来たのは「何で止まっているのか」
 * そのものだからである。
 *
 * クローンは同じ状態を `manager_list` で読み、そこには件数が出ている（PR #60）。
 * この画面が「実行中」としか言わないと、同じ仕事を見て人間とクローンで見えている
 * ものが食い違う（北極星 禁止1 を逆向きに踏む）。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ManagerSummary } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/manager-detail';
import ManagerDetail, { clientLoader } from './manager-detail';

const BASE: ManagerSummary = {
  managerId: 'mgr-1',
  status: 'running',
  live: true,
  cwd: '/work/project',
  request: 'PR を出して',
  startedAt: '2026-08-16T03:00:00.000Z',
  updatedAt: '2026-08-16T03:15:00.000Z',
  waiting: [],
};

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

/**
 * ルートモジュールの props（`loaderData`）が渡るのは framework mode だけで、
 * `createMemoryRouter`（library mode）では渡らない。
 *
 * **形を手で書き写さない。** 本物の `clientLoader` を通した戻り値をそのまま
 * 渡す — 手書きの `{ id }` を置くと、`clientLoader` が返すものが変わった日に
 * この試験だけが古い形のまま通り続ける。
 */
function Harness({ id }: { id: string }) {
  const loaderData = clientLoader({ params: { id } } as Route.ClientLoaderArgs);
  return <ManagerDetail {...({ loaderData } as Route.ComponentProps)} />;
}

function renderDetail(manager: ManagerSummary) {
  stubFetch((url) =>
    url.includes(`/managers/${manager.managerId}`) ? json({ manager }) : undefined,
  );
  const router = createMemoryRouter(
    [
      { path: '/managers/:id', Component: () => <Harness id={manager.managerId} /> },
      // `Link to="/journal"` の行き先（描くだけで踏まない）。
      { path: '/journal', Component: () => null },
    ],
    { initialEntries: [`/managers/${manager.managerId}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

/**
 * `renderDetail` に加えて `POST /managers/:id/messages` も受ける版。
 *
 * **共通の `stubFetch` は使わない。** `packages/api-client`（openapi-fetch）は
 * `fetch(request, requestInitExt)` という形で呼ぶ — 第1引数が `method` 込みの
 * `Request` 本体で、第2引数（`requestInitExt`）は素通しの拡張オプションであり
 * 通常 `undefined` になる。`stubFetch`（`~/test-support`）の `Route` はこの
 * **第2引数だけ**を見て `route(url, init)` を呼ぶため、`init?.method` は常に
 * `undefined` になってしまい、「POST が実際に飛んだか」を method では見分け
 * られない（最初それで書いて実際に踏んだ）。ここでは `Request` 本体から
 * `method` を読み直して `sent` に控える。
 *
 * **`url.includes(...)` の1本勝負にもしない。** 素朴に書くと `/managers/mgr-1`
 * という部分一致が `/managers/mgr-1/messages` にも当たってしまい、POST が
 * `GET /managers/:id` 用の応答（`{ manager }`）を受け取って壊れる。`/messages`
 * で終わる URL を先に見て POST 専用の応答へ振り分け、それ以外を詳細の GET
 * として扱う。
 */
function renderDetailWithMessages(
  manager: ManagerSummary,
  sendResult: { outcome: string; detail: string } = {
    outcome: 'delivered',
    detail: '追加指示として届けた。',
  },
) {
  const sent: { url: string; method: string }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { url, method } = request;
    if (url.endsWith(`/managers/${manager.managerId}/messages`)) {
      sent.push({ url, method });
      return json(sendResult);
    }
    if (url.includes(`/managers/${manager.managerId}`)) return json({ manager });
    // 知らない URL は「繋がらない」（`stubFetch` と同じ扱い）。
    throw new TypeError(`Failed to fetch: ${url}`);
  }) as typeof fetch;
  const router = createMemoryRouter(
    [
      { path: '/managers/:id', Component: () => <Harness id={manager.managerId} /> },
      { path: '/journal', Component: () => null },
    ],
    { initialEntries: [`/managers/${manager.managerId}`] },
  );
  render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { sent };
}

/**
 * **一覧で `lost` を見た人間が、次に開くのがこの画面である。**
 *
 * 起こし直すかどうかを決めるのはここなのに、詳細だけが札しか出していなかった
 * （一覧 `managers.test.tsx`・CLI `chat.test.ts`・クローンの `tools.test.ts` には
 * 但し書きの網が張ってある）。
 *
 * 削ってはいけないのは2つ — **観測しているのは「戻れたか」だけだという限界**と、
 * **成果がリモートに残っていることがあるという次の一手**である（PR #42 で `lost` を
 * 分け、PR #60 で断定を外した経緯そのもの）。
 */
describe('詳細でも、lost には次の一手を添える', () => {
  it('「復旧不能」と書かず、観測の限界と確かめる先を出す', async () => {
    renderDetail({ ...BASE, status: 'lost', live: false });

    expect(await screen.findByText('セッションへ戻れず')).toBeTruthy();
    // 成果の有無は見ていないのだから、失われたと断定しない。
    expect(screen.queryByText('復旧不能')).toBeNull();
    // 観測の限界（これが無いと「終わった」とも「失われた」とも読まれる）。
    expect(screen.getByText(/戻れたかどうかしか見ていない/)).toBeTruthy();
    // 次の一手。起こし直す前に見に行く先を名指しする。
    expect(screen.getByText(/リモート（PR・ブランチ・コミット）を確かめる/)).toBeTruthy();
  });

  it('lost 以外にはリモート確認の案内を出さない（雑音にしない）', async () => {
    renderDetail({ ...BASE, status: 'running' });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/戻れたかどうかしか見ていない/)).toBeNull();
    expect(screen.queryByText(/リモート（PR・ブランチ・コミット）/)).toBeNull();
  });
});

describe('詳細でも、拒否は状態を置き換えずに状態へ添える', () => {
  it('「実行中」の札を残したまま、止められた道具を全件出す', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      denials: [
        { tool: 'Bash', count: 4 },
        { tool: 'Write', count: 1 },
        { tool: 'WebFetch', count: 2 },
      ],
    });

    // **札は差し替えない。** 観測しているのは `running` のままである。
    expect(await screen.findByText('実行中')).toBeTruthy();
    // 一覧の 3 種の上限に引っ張られない（詳細は畳まない）。
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('Write')).toBeTruthy();
    expect(screen.getByText('WebFetch')).toBeTruthy();
    // 状態の隣に総数を並べる。
    expect(screen.getByText(/確認へ上がらず止められた 7 件/)).toBeTruthy();
    // 観測していないことを断定しない。
    expect(screen.getByText(/この仕事が止まったかどうかは見ていない/)).toBeTruthy();
    // 「0 件」を「止められていない」と読ませない材料を渡す。
    expect(screen.getByText(/器を作り直すと数え直しになる/)).toBeTruthy();
  });

  it('拒否が無いマネージャーには何も足さない（雑音にしない）', async () => {
    renderDetail({ ...BASE, status: 'running' });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/確認へ上がらず止められた/)).toBeNull();
  });
});

/**
 * **直近の1ターンが「報告」ではなく失敗で終わったことも、状態に映らない。**
 *
 * 上限に当たった回もセッションは生きているので、台帳の `status` は `done`
 * （画面では「待機中」）のままである（`schema.ts` の `lastFailure` の doc）。
 * 一覧（`managers.test.tsx`）と対になっているが、ここには一覧に無いものが2つ
 * ある — 但し書き（次に何をすればよいか）と、**「最後の報告」カードの見出し**で
 * ある。後者は、直す前に
 * `You've hit your org's monthly spend limit …` が「最後の報告」として出ていた
 * まさにその場所である（`sdk-failure.ts` の doc）。
 */
describe('詳細でも、失敗は状態を置き換えずに状態へ添える', () => {
  const FAILURE = { code: 'billing_error', via: 'assistant_error', at: '2026-08-20T10:00:00.000Z' };

  it('「待機中」の札を残したまま、SDK の語・時刻・次の一手を出す', async () => {
    renderDetail({ ...BASE, status: 'done', lastFailure: FAILURE });

    // **札は差し替えない。** 観測しているのは `done`（終えて待機中）である。
    expect(await screen.findByText('待機中')).toBeTruthy();
    // 状態の隣に、失敗であることを添える。
    expect(screen.getByText('⚠ 直近のターンは失敗で終わった')).toBeTruthy();
    // SDK の語をそのまま（言い換えると人間が引ける手がかりが消える）。
    expect(screen.getByText('billing_error')).toBeTruthy();
    expect(screen.getByText('assistant_error')).toBeTruthy();
    // `status` を `failed` へ倒さなかった理由そのもの。
    expect(screen.getByText('この仕事は死んでいない')).toBeTruthy();
    // 観測していないことは言い切らない（`code` の意味の解釈はしていない）。
    expect(screen.getByText('何が起きたかの解釈まではしていない')).toBeTruthy();
  });

  /**
   * **ここが発端の穴そのものである。** 本文（`lastReport`）は runner 側で
   * 「（このターンは応答を返さずに終わった: …）」と包まれているが、見出しが
   * 「最後の報告」のままだと、人間は包みの内側だけを読んで報告として扱う。
   */
  it('失敗で終わった回の本文を「最後の報告」と呼ばない', async () => {
    renderDetail({
      ...BASE,
      status: 'done',
      lastFailure: FAILURE,
      lastReport: '（このターンは応答を返さずに終わった: billing_error / assistant_error）',
    });

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.queryByText('最後の報告')).toBeNull();
    expect(screen.getByText('最後のターンの中身（報告ではない）')).toBeTruthy();
  });

  it('失敗していない回は「最後の報告」のままで、但し書きも出さない（雑音にしない）', async () => {
    renderDetail({ ...BASE, status: 'done', lastReport: 'スキーマまで書いた' });

    expect(await screen.findByText('待機中')).toBeTruthy();
    expect(screen.getByText('最後の報告')).toBeTruthy();
    expect(screen.queryByText(/報告ではなく失敗で終わっている/)).toBeNull();
    expect(screen.queryByText('⚠ 直近のターンは失敗で終わった')).toBeNull();
  });
});

/**
 * **`live` は status と別の軸である。** `live && <札>` の形は `live === false` を
 * 「札が無い」でしか表さず、読む側は「切断されている」と「この画面が接続状態を
 * 報告していない」を区別できない。だから両側を描く。
 *
 * クローンの道具（`packages/core/src/tools.ts`）と CLI（`apps/cli/src/chat.ts`）は
 * どちらも `[running/セッション切断]` と明示している — Web だけが肯定側しか
 * 描いていなかった（北極星 禁止1 を逆向きに踏む）。詳細はさらに、札だけでは
 * 「で、どうなるのか」が伝わらないので文で言う。
 *
 * **経緯（PR #66 の嘘 → 774b316 の是正 → 7df9365 で送信不可の線を引き直した）。**
 * かつてこの注記は「いま送っても届かず」と書いていたが、実測すると
 * `ManagerPool.send`（`packages/core/src/manager.ts`）は `attached === false` でも
 * `session_id` を持つ相手（`lost` を含む）なら resume を試み、resume の `message`
 * に送った文字列がそのまま載って届く — 黙って消える経路は無かった。直したのは
 * 文言であって、送信ボタンを無効化する判断はしていない。塞ぐと、人間が自分の
 * 言葉で繋ぎ直す唯一の手が消える。
 *
 * **ただし、戻る先（`session_id`）を持っていないと分かっている相手だけは押しても
 * 何も起きない**（`#resume` が `sessionId === undefined` で即 `false` を返す）。
 * そこだけは無効化し、`aria-describedby` で理由の段落と結びつけてある
 * （`SendMessage` の `noWayBack`）。
 *
 * ここでは4つを別々の歯にする。
 * A. `live: true` では1バイトも変わらず、送信は普通に通る。
 * B. `live: false` だが `session_id` はある相手には、注記が「届かない」と
 *    嘘をつかず、実際に送れる（ここが線の本体）。
 * C. B と同じ相手でも、送信欄の側に「送ると何が起きるか」の一行が独立して出て
 *    いる（理由の表示だけを消す変異を殺すための、独立した `it`）。
 * D. `session_id` が無い相手だけはボタンが `disabled` になり、その理由が
 *    `aria-describedby` で結び付き、Enter でも POST が飛ばない。
 */
describe('詳細でも、`live` は繋がっていないことを文で言うが、送信は塞がない', () => {
  it('A: live: true では注記も送信欄の一行も出ず、送信は普通に通る', async () => {
    const { sent } = renderDetailWithMessages({ ...BASE, status: 'running', live: true });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('接続あり')).toBeTruthy();
    expect(screen.queryByText('セッション切断')).toBeNull();
    expect(screen.queryByText('引き取り（resume）の契機')).toBeNull();
    expect(screen.queryByText('送信は止めていない')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('追加の指示'), {
      target: { value: '続けて' },
    });
    const button = screen.getByRole('button', { name: '送る' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);

    expect(await screen.findByText('delivered: 追加指示として届けた。')).toBeTruthy();
    expect(
      sent.some(
        (entry) => entry.url.endsWith('/managers/mgr-1/messages') && entry.method === 'POST',
      ),
    ).toBe(true);
  });

  it('B: live: false でも session_id がある相手には「届かず」と言わず、実際に送れる', async () => {
    const { sent } = renderDetailWithMessages({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: 'sess-1',
    });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('セッション切断')).toBeTruthy();
    // #66 の嘘が戻ってきたら、これが最初に落ちる。
    expect(screen.queryByText(/届かず/)).toBeNull();
    // 観測（繋がっていない）自体は残す。
    expect(screen.getByText('繋がっていない')).toBeTruthy();
    // 送信そのものが引き取りの契機になることを言う。
    expect(screen.getByText('引き取り（resume）の契機')).toBeTruthy();
    // 成否は断定しない（観測していないことを言い切らない）。
    expect(screen.getByText('戻れるとは限らない')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('追加の指示'), {
      target: { value: '続けて' },
    });
    const button = screen.getByRole('button', { name: '送る' });
    // ここが線の本体 — `live` だけを理由にボタンを塞いでいないこと。
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);

    expect(await screen.findByText('delivered: 追加指示として届けた。')).toBeTruthy();
    expect(
      sent.some(
        (entry) => entry.url.endsWith('/managers/mgr-1/messages') && entry.method === 'POST',
      ),
    ).toBe(true);
  });

  it('C: session_id がある相手には、送信欄の側にも「送ると何が起きるか」の理由が出ている', async () => {
    // これが「理由の表示だけを消す」変異を殺すテストである。無効化はしていない
    // ので、B（押せることを試すテスト）だけでは理由の一行を消す変異は検知
    // できない — 独立した `it` にする。
    renderDetail({ ...BASE, status: 'running', live: false, sessionId: 'sess-1' });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('送信は止めていない')).toBeTruthy();
    expect(screen.getByText('戻れなければ理由がここに出る。')).toBeTruthy();
  });

  it('D: session_id が無い相手だけはボタンが無効になり、理由と結びつき、Enter でも飛ばない', async () => {
    const { sent } = renderDetailWithMessages({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: undefined,
    });

    expect(await screen.findByText('実行中')).toBeTruthy();

    const input = screen.getByPlaceholderText('追加の指示');
    // **空欄のまま `disabled` を見ない。** `text.trim() === ''` でも
    // `disabled` になるので、入力せずに見ると `noWayBack` を消す変異
    // （M5）を捕まえられない。必ず先に文字を入れる（入力欄は無効にして
    // いないので入る）。
    fireEvent.change(input, { target: { value: '続けて' } });

    const button = screen.getByRole('button', { name: '送る' });
    // 1. 文字を入れてもなお `disabled` である。
    expect(button.hasAttribute('disabled')).toBe(true);

    // 2. `aria-describedby` が理由の段落の id を指し、その id の要素に理由が
    //    入っている（「押せない」と「なぜ押せないか」が結び付いている）。
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy as string);
    expect(reason).not.toBeNull();
    expect(reason?.textContent).toContain('送れない');
    expect(reason?.textContent).toContain('新しく起こし直すこと');

    // 3. Enter でも POST が飛ばない（`submit()` はボタンの `disabled` を
    //    経由しない独立した入口なので、ここも別に確かめる）。
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(sent.length).toBe(0);

    // 4. クリックしても飛ばない（ネイティブの `disabled` 経由で `onClick` は
    //    そもそも呼ばれないはずだが、飛んでいないことを直接確かめる）。
    fireEvent.click(button);
    expect(sent.length).toBe(0);
  });
});
