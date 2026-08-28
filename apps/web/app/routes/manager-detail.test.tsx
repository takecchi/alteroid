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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ManagerStatus, ManagerSummary } from '~/lib/types';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import type { Route } from './+types/manager-detail';
import ManagerDetail, { clientLoader } from './manager-detail';

/**
 * `askedAt` の絶対時刻表示（`~/lib/format` の `formatDateTime`）を確かめる
 * 歯があるので、この画面と同じ理由で TZ を固定する。**理由（`vi.hoisted` で
 * なければ静かに効かない事情、CI が UTC で手元が JST であること）は
 * `apps/web/app/routes/reports.test.tsx` の冒頭に逐語で在るので、ここには
 * 写さない。**
 */
const tzBeforeThisFile = vi.hoisted(() => {
  const before = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  return before;
});

afterAll(() => {
  if (tzBeforeThisFile === undefined) delete process.env.TZ;
  else process.env.TZ = tzBeforeThisFile;
});

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
  const sent: { url: string; method: string; body?: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const { url, method } = request;
    if (url.endsWith(`/managers/${manager.managerId}/messages`)) {
      // **本文も控える（`body`）。** 種別（`kind`）ごとに送る JSON の形
      // （`decision` を付けるか）を確かめる歯（#334）が要る。`.clone()` で
      // 読むのは、これより後で本物の fetch 実装が同じ `request` を読む
      // 経路が万一あっても壊れないため。
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => undefined);
      sent.push({ url, method, body });
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
 * **依頼の全文は header ではなく本文に出る。**
 *
 * かつてこの画面は `manager.request` を `Page` の `description`（header）へ
 * そのまま渡していた。header は `shrink-0`（`components/page.tsx`）なので、依頼が
 * 長いぶんだけ header が縦に伸び、スクロールできる本文の領域が潰れる — 長い依頼
 * では状態カードすら画面に入らず、人間から「header が大きくて content が見え
 * ない」という報告が出た。
 *
 * **jsdom にはレイアウトが無いので「高さ」は測れない。** だから測るのは高さでは
 * なく**どちらの側に置かれているか**である。header に入っていない・本文に全文が
 * ある、の2つで、`description` へ戻す変異と本文で切り詰める変異の両方が落ちる。
 */
describe('依頼の全文は header ではなく本文に置く', () => {
  const LONG = [
    '依頼の1行目',
    ...Array.from({ length: 40 }, (_, index) => `手順 ${index + 1}: ${'あ'.repeat(60)}`),
  ].join('\n');

  it('本文に全文があり、header には依頼が入っていない', async () => {
    renderDetail({ ...BASE, request: LONG });

    // 本文側に全文がある。**既定の normalizer は改行を潰すので通さない** —
    // 潰すと「改行を捨てる変異」が見えなくなる。
    const body = await screen.findByText(LONG, { normalizer: (text) => text });
    // 1文字も捨てていない（`slice` で切り詰める変異はここで落ちる）。
    expect(body.textContent).toBe(LONG);
    // 置かれているのは本文側である。
    expect(body.closest('header')).toBeNull();
    // カードの見出しも出ている（何のカードなのかが分かる）。
    expect(screen.getByText('依頼')).toBeTruthy();

    const header = document.querySelector('header');
    expect(header).not.toBeNull();
    // `description={manager.request}` へ戻す変異は、ここで落ちる。
    expect(header?.textContent ?? '').not.toContain('手順 40:');
    // header 側の一文は残っている（依頼がどこにあるかを人間に渡す）。
    expect(header?.textContent ?? '').toContain('依頼の全文は下');
  });
});

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
    // **層の印（`denialActorTag`）が同じ要素へ付くので、完全一致ではなく
    // 部分一致で見る**（`actor` が無いのでどれも `[層不明]` が付く）。
    expect(screen.getByText(/^Bash/)).toBeTruthy();
    expect(screen.getByText(/^Write/)).toBeTruthy();
    expect(screen.getByText(/^WebFetch/)).toBeTruthy();
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

  /**
   * Issue #373 — PR #549 で `ManagerDenial.actor` が API まで届いたのに、詳細
   * 画面（`manager-detail.tsx` の `DenialsCard`）だけが `tool`/`count` の2値の
   * ままだった。一覧（`managers.tsx`）と同じ `denialActorTag` を使い、3値の
   * まま出す。
   */
  it('拒否の層（マネージャー／作業者／層不明）が3値のまま出る', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      denials: [
        { tool: 'Bash', count: 2, actor: 'manager' },
        { tool: 'Edit', count: 1, actor: 'worker' },
        // `via: 'result'` は SDK 側に判定材料が無いので `actor` キーが無い。
        { tool: 'Write', count: 3 },
      ],
    });

    expect(await screen.findByText(/Bash ?\[マネージャー\]/)).toBeTruthy();
    expect(screen.getByText(/Edit ?\[作業者\]/)).toBeTruthy();
    expect(screen.getByText(/Write ?\[層不明\]/)).toBeTruthy();
  });

  /**
   * **`actor` が無い回を `[マネージャー]` へ化けさせない。** `undefined`
   * （層が取れなかった）を「マネージャーだった」と決めつけると、Issue #373 が
   * 守ろうとしている「層が取れていないことが分かる」が壊れる
   * （`apps/daemon/src/app.test.ts`「拒否の層（actor）が…」と対になる）。
   */
  it('actor が無い回は [層不明] になり、[マネージャー] へは化けない', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      denials: [{ tool: 'Bash', count: 1 }],
    });

    expect(await screen.findByText(/Bash ?\[層不明\]/)).toBeTruthy();
    expect(screen.queryByText(/\[マネージャー\]/)).toBeNull();
  });

  /**
   * **同じ道具が層違いで2件並んでも、React の重複キーで片方が消えたり
   * 警告が出たりしない（回帰止め）。** `manager.ts` の `denials()` は帳面の
   * キーを `道具::層`（`denialKey`）で作るので、`Bash`(worker) と
   * `Bash`(manager) が同時に返ることがある——`key={entry.tool}` のままだと
   * 直す前はここが重複キーだった。
   */
  it('同じ道具が層違いで2件返っても、両方とも表示される', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      denials: [
        { tool: 'Bash', count: 3, actor: 'worker' },
        { tool: 'Bash', count: 1, actor: 'manager' },
      ],
    });

    expect(await screen.findByText(/Bash ?\[作業者\]/)).toBeTruthy();
    expect(screen.getByText(/Bash ?\[マネージャー\]/)).toBeTruthy();
    // 総数は2件分（3+1）が合算されていること。
    expect(screen.getByText(/確認へ上がらず止められた 4 件/)).toBeTruthy();
  });
});

/**
 * **待ちは `kind` で質問と実行許可を出し分ける（Issue #334）。**
 *
 * 直す前は `waiting` の要素が `{ requestId, summary }` しか持たず、画面は
 * 両者を区別できなかった——質問に拒否ボタンを押すと、文字列「許可しない」が
 * そのまま回答として注入されていた（`runner.ts` の `kind === 'question'`
 * 分岐は本文をそのまま答えに使うため）。
 *
 * **`askedAt` の絶対時刻表示は歯で確かめるが、相対表記（「〜分前」）の文言は
 * 確かめない。** `formatRelative` は壁時計（`Date.now()`）に依存するため、
 * 固定の期待値を書くとテスト実行時刻によっては別の帯（分／時間／日）に
 * 化ける——`vi.useFakeTimers` を導入すれば固定できるが、この画面のテストは
 * RTL の非同期待ち（`findByText` / `waitFor`）に real timers を前提にした
 * ものが多く、混ぜるとハングの危険がある（このリポジトリに fake timers を
 * 使う `apps/web` テストの先例が無いことも踏まえ、今回は避けた）。
 */
describe('待ちは kind で質問と実行許可を出し分ける（#334）', () => {
  const askedAt = '2026-08-23T01:00:00.000Z'; // TZ=Asia/Tokyo で 08/23 10:00

  it('kind: question には本文の入力欄が出て、送るのは人間が書いた文と requestId だけ（decision を送らない）', async () => {
    const { sent } = renderDetailWithMessages(
      {
        ...BASE,
        status: 'waiting_human',
        waiting: [
          { requestId: 'req-q', summary: 'DB はどちらにする？', kind: 'question', askedAt },
        ],
      },
      { outcome: 'answered', detail: '回答として届けた。' },
    );

    expect(await screen.findByText('DB はどちらにする？')).toBeTruthy();
    // allow/deny の概念が無いので、許可・拒否ボタンは出ない。
    expect(screen.queryByRole('button', { name: '許可' })).toBeNull();
    expect(screen.queryByRole('button', { name: '拒否' })).toBeNull();
    // 待ち始めた時刻（絶対表記）。書式は既存の startedAt/updatedAt と同じ道具
    // （`formatDateTime`）で出ている。
    expect(screen.getByText(/08\/23 10:00/)).toBeTruthy();

    const textarea = screen.getByPlaceholderText('この質問への答えを、自分の言葉で書く');
    fireEvent.change(textarea, { target: { value: 'PostgreSQL で' } });
    const button = screen.getByRole('button', { name: '送信' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'POST' });
    // **`decision` を送らない。** 本文と requestId だけが乗る
    // （余計なキーが無いことまで見るため `toEqual` で完全一致にする）。
    expect(sent[0]?.body).toEqual({ text: 'PostgreSQL で', requestId: 'req-q' });
  });

  it('question は空文字・空白のみでは送らない', async () => {
    const { sent } = renderDetailWithMessages({
      ...BASE,
      status: 'waiting_human',
      waiting: [{ requestId: 'req-q', summary: 'DB はどちらにする？', kind: 'question', askedAt }],
    });

    expect(await screen.findByText('DB はどちらにする？')).toBeTruthy();
    const textarea = screen.getByPlaceholderText('この質問への答えを、自分の言葉で書く');
    const button = screen.getByRole('button', { name: '送信' });

    // 空欄のまま押しても disabled なので飛ばない。
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(sent).toHaveLength(0);

    // 空白だけを入れて Cmd/Ctrl+Enter で送っても、`disabled` を経由しない
    // `submit()` 側の歯（`text.trim() === ''`）が弾く。
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
    expect(sent).toHaveLength(0);
  });

  it('kind: permission は許可・拒否の2ボタンのまま', async () => {
    const { sent } = renderDetailWithMessages({
      ...BASE,
      status: 'waiting_human',
      waiting: [
        { requestId: 'req-p', summary: 'Bash の実行許可: ls', kind: 'permission', askedAt },
      ],
    });

    expect(await screen.findByText('Bash の実行許可: ls')).toBeTruthy();
    // 質問用の入力欄は出ない。
    expect(screen.queryByPlaceholderText('この質問への答えを、自分の言葉で書く')).toBeNull();
    expect(screen.getByText(/08\/23 10:00/)).toBeTruthy();

    const allow = screen.getByRole('button', { name: '許可' });
    fireEvent.click(allow);

    await waitFor(() => expect(sent).toHaveLength(1));
    // **今までどおり `decision` を送る。** ここは1文字も変えていない。
    expect(sent[0]?.body).toEqual({ text: '許可する', requestId: 'req-p', decision: 'allow' });
  });

  /**
   * **版のずれの倒れ先。** `packages/api-client` は型だけで実行時検証を
   * 持たない（`packages/api-client/src/index.ts`）ので、古いデーモン＋新しい
   * 画面という組み合わせでは実際に `kind` というキー自体が届かないことが
   * ある。そのときは現状の2ボタン（許可確認）へ倒す——何も消さない、
   * 安全側の既定（AGENTS.md「型で塞いだ分岐にも、実行時の倒れ先の歯を
   * 足す」）。
   */
  it('kind が届かない（版のずれ）ときは許可確認と同じ2ボタンへ倒れる', async () => {
    renderDetail({
      ...BASE,
      status: 'waiting_human',
      waiting: [
        {
          requestId: 'req-unknown',
          summary: '種別が来なかった確認',
          // `kind` を欠いたオブジェクト。型は `ManagerSummary['waiting'][number]`
          // が `kind` を必須で持つので、実機の版ずれを模すために `as` で
          // 割り込む——ここが今回のテストの前提そのものである。
        } as ManagerSummary['waiting'][number],
      ],
    });

    expect(await screen.findByText('種別が来なかった確認')).toBeTruthy();
    expect(screen.getByRole('button', { name: '許可' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒否' })).toBeTruthy();
    expect(screen.queryByPlaceholderText('この質問への答えを、自分の言葉で書く')).toBeNull();
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
 * **`lastReport` の描き方は `lastFailure` の有無で分岐する（issue #293）。**
 * 直す前は、失敗回でも `<Markdown>` として無条件に描いていたので、SDK の生の
 * 失敗文言（例: `You've hit your org's monthly spend limit …`）に Markdown の
 * 記法が混ざっていた場合、体裁まで正常な報告と同じ顔になっていた。
 *
 * ここで確かめるのは `markup`（issue #287 の軸）ではなく `lastFailure`（この
 * Issue の軸）で分岐していること — 失敗回の本文に Markdown の記法（`*` /
 * `#` / `**`）を混ぜても化けないこと、成功回は今日どおり化けること、
 * 失敗回は改行を潰さず長い行が横に溢れないことを別々の歯にする。
 */
describe('詳細でも、`lastReport` は `lastFailure` の有無で描き方を分ける', () => {
  const FAILURE = { code: 'billing_error', via: 'assistant_error', at: '2026-08-20T10:00:00.000Z' };

  it('失敗回の本文は Markdown を通さない（*/#/** が化けず、改行と生の文字がそのまま出る）', async () => {
    renderDetail({
      ...BASE,
      status: 'done',
      lastFailure: FAILURE,
      lastReport:
        '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n' +
        '# 見出しではない\n' +
        '*強調ではない* 文字\n\n' +
        '（失敗する前に出ていた本文）\n' +
        '**途中まで進めた**',
    });

    expect(await screen.findByText('最後のターンの中身（報告ではない）')).toBeTruthy();
    // `<pre>` は1本のテキストノードとして描かれるので、部分一致の
    // マッチャー関数で取る（`findByText` の完全一致では見えない）。
    const pre = await screen.findByText((_content, node) => node?.tagName === 'PRE');
    // 記法の文字を含む見出し・強調が、化けずにそのまま画面に在ること。
    expect(pre.textContent).toContain('# 見出しではない');
    expect(pre.textContent).toContain('*強調ではない* 文字');
    expect(pre.textContent).toContain('**途中まで進めた**');
    // Markdown を通っていれば em / strong / heading になる。通っていないことを確かめる。
    expect(screen.queryByRole('heading', { name: '見出しではない' })).toBeNull();
    expect(pre.querySelector('em, strong, h1, h2, h3')).toBeNull();
    // 改行を潰さない（`whitespace-pre-wrap`）。
    const tokens = pre.className.split(/\s+/);
    expect(tokens).toContain('whitespace-pre-wrap');
    // 長い1行が横に溢れて画面を壊さないための作法（既存の `reports.tsx` の
    // `UnavailableNote` と同じ）。
    expect(tokens).toContain('overflow-x-auto');
    expect(tokens).toContain('break-words');
  });

  /** 実際の事故の形（`failedReportText` 相当）。次に読む人へ意図を伝える1本。 */
  it('実際の事故の形（monthly spend limit の生文言）が化けずそのまま出る', async () => {
    renderDetail({
      ...BASE,
      status: 'done',
      lastFailure: FAILURE,
      lastReport:
        '（このターンは応答を返さずに終わった: billing_error / assistant_error）\n' +
        "You've hit your org's monthly spend limit for the API. To keep going, **increase your limit** in the console.",
    });

    const body = await screen.findByText(/You've hit your org's monthly spend limit for the API\./);
    expect(body.textContent).toContain('**increase your limit**');
    expect(body.closest('strong')).toBeNull();
  });

  it('成功回（lastFailure 無し）は今日どおり Markdown で描く（既定は変えていないことの固定）', async () => {
    renderDetail({
      ...BASE,
      status: 'done',
      lastReport: '*強調される* はず',
    });

    expect(await screen.findByText('最後の報告')).toBeTruthy();
    const em = await screen.findByText('強調される');
    expect(em.tagName).toBe('EM');
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

/**
 * **停止は status で出し分けない。**
 *
 * かつてこの画面は「停止する」を `running` / `waiting_human` のときだけ描いて
 * いた。**絞っていたのは画面だけだった** — CLI の `/stop`（`apps/cli/src/chat.ts`）
 * は id をそのまま `DELETE` へ渡すだけで status を見ず、デーモン
 * （`apps/daemon/src/app.ts` の `.delete('/managers/:id')`）も `ManagerPool.abort`
 * （`packages/core/src/manager.ts`）も、台帳に居ない（`absent`）以外では弾かない。
 * **同じ行為が入口によってできたりできなかったりしていた**（`docs/PRD.md`
 * 「入口の等価性」は「委譲の停止」を名指しで挙げている。北極星の禁止1）。
 *
 * とくに `done` である。**`done` は死ではなく待機で**（`schema.ts` の
 * `jobStatusSchema` の doc、この画面の札も「待機中」）、セッションは生きている。
 * 待機したまま残っているものを畳む手が、Web にだけ無かった。
 *
 * **測るのは「ボタンが出ること」ではなく「停止の行為が届くこと」である。**
 * 描画だけを見ると、ボタンを描いたまま `onClick` を殺す変異が生き残る。だから
 * `DELETE` が実際に飛んだことを **method 込みで**確かめ、さらに完了後の遷移
 * （`/managers` へ戻る）まで見る。
 */
describe('停止は status で出し分けない', () => {
  /**
   * **この `Record` が数え上げの持ち主である。**
   *
   * 画面の側は状態を1つも数え上げない（数え上げると、状態が増えた日に黙って
   * 新しい状態を締め出す）。**代わりに数え上げをここへ置く** — `ManagerStatus`
   * に値が増えたら、この定義が**コンパイルで落ちる**。落ちた人は「増えた状態を
   * 停止できるか」を一度は考えることになる。
   *
   * だから `as const` の配列や `string[]` へ緩めないこと。緩めた瞬間、増えた
   * 状態は誰にも気づかれずに試験の外へ出る。
   */
  const EVERY_STATUS: Record<ManagerStatus, true> = {
    running: true,
    waiting_human: true,
    done: true,
    failed: true,
    lost: true,
    stopped: true,
  };
  const ALL_STATUSES = Object.keys(EVERY_STATUS) as ManagerStatus[];

  /**
   * `renderDetail` の停止版。
   *
   * **`stubFetch` は使えない。** 停止の `DELETE` と詳細の `GET` は**同じ URL**
   * （`/managers/:id`）なので、URL だけでは見分けられない。`stubFetch` の
   * `Route` が受け取る第2引数は openapi-fetch の呼び方（`fetch(request, ext)`）
   * では常に `undefined` になり `method` が読めない — `renderDetailWithMessages`
   * の doc に同じ罠が書いてある。ここでは `Request` 本体から `method` を読む。
   */
  function renderDetailWithAbort(manager: ManagerSummary) {
    const sent: { url: string; method: string; body: string }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'DELETE' && url.endsWith(`/managers/${manager.managerId}`)) {
        sent.push({ url, method, body: await request.text() });
        return json({ outcome: 'stopped', detail: '止めた。' });
      }
      if (url.includes(`/managers/${manager.managerId}`)) return json({ manager });
      throw new TypeError(`Failed to fetch: ${url}`);
    }) as typeof fetch;
    const router = createMemoryRouter(
      [
        { path: '/managers/:id', Component: () => <Harness id={manager.managerId} /> },
        // 停止が通ると一覧へ戻る。**行き先に印を置く** — ここまで来たことが
        // 「停止の行為が最後まで届いた」ことの証拠になる。
        { path: '/managers', Component: () => <p>マネージャー一覧</p> },
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
   * **`done` だけを別の `it` にしてある。**
   *
   * 下の全状態版と重なるが、重ねる価値がある — 塞がれていたのはここで、
   * `done` だけを条件へ書き戻す変異は「全状態版が落ちたから」では原因が
   * 分からない。落ちるテストの名前がそのまま欠陥の名前になる形にする。
   */
  it('done（待機中）のマネージャーへ、停止の行為が届く', async () => {
    const { sent } = renderDetailWithAbort({ ...BASE, status: 'done' });

    expect(await screen.findByText('待機中')).toBeTruthy();

    const button = screen.getByRole('button', { name: '停止する' });
    // 描いたうえで、押せる（`disabled` で塞ぐ形へ逃げていない）。
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);

    // 行為が最後まで届いた（一覧へ戻っている）。
    expect(await screen.findByText('マネージャー一覧')).toBeTruthy();
    // API に実際に届いた。**method まで見る** — URL は GET と同じである。
    expect(sent.length).toBe(1);
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.url.endsWith('/managers/mgr-1')).toBe(true);
    // 本文が要る（サーバ側に json バリデータが付いており、空だと 400 になる）。
    expect(sent[0]?.body).toContain('人間が画面から停止した');
  });

  /**
   * **どの状態でも届く。** 上の `Record` が数え上げの持ち主なので、状態が増えれば
   * ここは自動で増える（増やせなければコンパイルが落ちる）。
   */
  it.each(ALL_STATUSES)('%s のマネージャーへも、停止の行為が届く', async (status) => {
    const { sent } = renderDetailWithAbort({ ...BASE, status });

    const button = await screen.findByRole('button', { name: '停止する' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);

    expect(await screen.findByText('マネージャー一覧')).toBeTruthy();
    expect(sent.map((entry) => entry.method)).toEqual(['DELETE']);
  });

  /**
   * **止まらなかったことは、ボタンを消さずに理由で出す。**
   *
   * 「押せないなら隠す」へ倒すと、**できないことと「この画面が扱っていないこと」を
   * 人間が区別できない。** 非表示は非対称を隠すだけで、直したことにならない。
   */
  it('停止が失敗しても、ボタンは残り、理由が出る', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const { url, method } = request;
      if (method === 'DELETE' && url.endsWith('/managers/mgr-1')) {
        return json({ error: 'mgr-1 というマネージャーは居ない。' }, 404);
      }
      if (url.includes('/managers/mgr-1')) return json({ manager: { ...BASE, status: 'done' } });
      throw new TypeError(`Failed to fetch: ${url}`);
    }) as typeof fetch;
    const router = createMemoryRouter(
      [
        { path: '/managers/:id', Component: () => <Harness id="mgr-1" /> },
        { path: '/managers', Component: () => <p>マネージャー一覧</p> },
        { path: '/journal', Component: () => null },
      ],
      { initialEntries: ['/managers/mgr-1'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '停止する' }));

    // 理由が画面に出る。
    expect(await screen.findByText(/マネージャーは居ない/)).toBeTruthy();
    // 一覧へは飛ばない（止まっていないのだから、止まったように見せない）。
    expect(screen.queryByText('マネージャー一覧')).toBeNull();
    // **ボタンは消えない。** もう一度押せる。
    expect(screen.getByRole('button', { name: '停止する' })).toBeTruthy();
  });
});

/**
 * 折り返しの付け忘れ（本2）。
 *
 * `runnerId` は空白を含まない識別子で、兄弟の `cwd` / `sessionId` / `lease`
 * にはすでに `break-all` が付いていたのに、ここだけ無かった。
 *
 * **⚠️ これは「はみ出しが直った」ことの試験ではない。** jsdom はレイアウトを
 * 持たないので、固定できるのは「そのクラス名が書かれていること」までである。
 * それでも置くのは、戻す変更（`break-all` を消す）を黙って通さないため。
 */
describe('折り返しの付け忘れ（本2）', () => {
  it('runnerId に break-all が付いている（cwd/sessionId/lease と同じ扱い）', async () => {
    renderDetail({ ...BASE, runnerId: 'runner-abcdefghijklmnop' });

    const dd = await screen.findByText('runner-abcdefghijklmnop');
    expect(dd.className.split(/\s+/)).toContain('break-all');
  });
});

/**
 * 横並びの積み替え（本4-A）。
 *
 * `dl`（`grid-cols-[8rem_1fr]`）は breakpoint 無しで固定されていたので、
 * 375px 幅でもラベル列（8rem）が値の取り分を持っていっていた。`sm:` 未満は
 * 1列、`sm:` 以上で固定幅ラベル列に切り替える。積んだときに `dt`/`dd` の
 * 対応が読めるよう、`dt` に `mt-3 first:mt-0 sm:mt-0` を足して組の境目を
 * 間隔の差で表す。
 *
 * **⚠️ これは「積み替わった」ことの試験ではない。** jsdom はレイアウトを
 * 持たない（`offsetWidth` / `scrollWidth` / `getBoundingClientRect()` は
 * すべて 0）ので、`sm:grid-cols-[8rem_1fr]` が実際に効いていることは
 * ここでは1つも観測できない。固定できるのは「そのクラス名が書かれていること」
 * までである。本2・本3 のテストより歯が弱い — breakpoint は CSS の話なので、
 * jsdom では「効いている」ことそのものが原理的に見えない。
 */
describe('横並びの積み替え（本4-A）: 状態カードの dl', () => {
  /*
   * **`状態` という文字列は画面に2箇所在る**（`CardHeader title="状態"` の
   * `<h2>状態</h2>` と、この `dl` の `<dt>状態</dt>`）。`findByText('状態')`
   * は複数一致で例外になるので、まず衝突しないラベル（`作業ディレクトリ`）で
   * `dl` を掴み、そこから先は `within(dl)` で範囲を絞る。
   */
  it('狭い画面では1列、sm: 以上で固定幅ラベル列になる', async () => {
    renderDetail(BASE);

    const anchor = await screen.findByText('作業ディレクトリ');
    const dl = anchor.closest('dl');
    expect(dl).not.toBeNull();
    const dlTokens = dl!.className.split(/\s+/);
    expect(dlTokens).toContain('grid-cols-1');
    expect(dlTokens).toContain('sm:grid-cols-[8rem_1fr]');
    expect(dlTokens).not.toContain('grid-cols-[8rem_1fr]');
  });

  it('全ての dt に mt-3 first:mt-0 sm:mt-0 が付いている（積んだときの組の境目）', async () => {
    renderDetail(BASE);

    const anchor = await screen.findByText('作業ディレクトリ');
    const dl = anchor.closest('dl');
    expect(dl).not.toBeNull();
    const scope = within(dl!);

    for (const label of ['状態', '作業ディレクトリ', '開始', '更新']) {
      const dt = scope.getByText(label);
      const tokens = dt.className.split(/\s+/);
      expect(tokens).toContain('mt-3');
      expect(tokens).toContain('first:mt-0');
      expect(tokens).toContain('sm:mt-0');
    }
  });
});

/**
 * **詳細でも、`sessionMissingSince` / `runnerLostSince` は状態も `live` も
 * 置き換えずに添える。**
 *
 * 一覧（`managers.test.tsx`）と対になっている。直す前、この2欄は
 * `apps/web/` に**1件も出てこなかった**（`/usr/bin/grep -rn` がどちらも 0 件）。
 * デーモンは `GET /managers/:id` で返していて、クローンは `manager_list` で、
 * 人間は CLI の `/manager` で読めていた —— 値は届いていて、Web UI だけが描いて
 * いなかった。
 *
 * **部品は一覧（`managers.tsx`）から import している。書き写していない。** ここで
 * 測っているのは「詳細の側にも出ること」であって、文言そのものは1箇所にしか無い。
 */
describe('詳細でも、セッション不在と器の沈黙は状態を置き換えずに添える', () => {
  const MISSING = '2026-08-16T03:10:00.000Z';
  const LOST_SINCE = '2026-08-16T03:05:00.000Z';

  /**
   * **ここが本体。** `sessionMissingSince` の欄の主眼は「`live` を落とさない」こと
   * である（`sessionId` が残っていれば `manager_send` が resume から入り直せる）。
   * ⟹ **「接続あり」の札と同時に出るのが正しい形**で、片方が他方を消したら
   * それはこの欄が名指ししている5つ目の形を壊している。
   */
  it('「接続あり」の札を残したまま、セッションが無いことを言う', async () => {
    renderDetail({ ...BASE, status: 'running', live: true, sessionMissingSince: MISSING });

    expect(await screen.findByText('実行中')).toBeTruthy();
    // 札は1つも差し替えない。
    expect(screen.getByText('接続あり')).toBeTruthy();
    expect(screen.queryByText('セッション切断')).toBeNull();
    expect(screen.getByText(/runner がそう答えた。聞けなかったのではない/)).toBeTruthy();
  });

  /**
   * **文言の核が消えたら赤くなる歯。** 由来が2つあり（途中で失われた／完遂した後に
   * セッションが畳まれて終端の合図だけが届かなかった）、デーモンは台帳から区別
   * できない（`packages/core/src/manager.ts` の `sendFailureDetail` の doc）。
   * 「失われた」と描くと、読み手は**完遂済みの仕事を委譲し直す**。
   */
  it('「失われた」と言い切らない（完遂後に畳まれた回も同じ形に見える）', async () => {
    renderDetail({ ...BASE, status: 'running', live: true, sessionMissingSince: MISSING });

    expect(await screen.findByText(/この委譲が失われたという意味ではない/)).toBeTruthy();
    expect(
      screen.getByText(
        /完遂した後にセッションが畳まれ、終端の合図だけが届かなかった回も同じ形に見える/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/同じ仕事が2本になる/)).toBeTruthy();
  });

  it('欄が無ければ何も描かない（雑音にしない）', async () => {
    renderDetail({ ...BASE, status: 'running', live: true });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.queryByText(/この委譲のセッションを持っていなかった/)).toBeNull();
    expect(screen.queryByText(/名乗っていない/)).toBeNull();
  });

  /**
   * `runnerLostSince` は `live: false` を**引き起こす側**である（`isLive()` が
   * `silentRunners.has(runnerId)` で false を返す）。`DisconnectedNote` は
   * 「繋がっていない」としか言わないので、この注記がその理由を1つ名指しする。
   *
   * **2つは矛盾していない。** `DisconnectedNote` が言うのは「送信ボタンは塞いで
   * いない」で、こちらが言うのは「この器は名簿から外れている」である。並んで出る
   * のが正しい。
   */
  it('器が黙ったときは、切断の注記と並べてその理由を名指しする', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: 'sess-1',
      runnerLostSince: LOST_SINCE,
    });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText('セッション切断')).toBeTruthy();
    // `DisconnectedNote` は消えない。
    expect(screen.getByText('繋がっていない')).toBeTruthy();
    expect(screen.getByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    // `status: lost` の言葉には寄せない（まだ何も確かめていない）。
    expect(screen.getByText(/黙っているのが器なのか経路なのかは、ここからは言えない/)).toBeTruthy();
    expect(screen.queryByText('セッションへ戻れず')).toBeNull();
  });

  /**
   * **`ba4053d`（#67）の再発を止める歯 —— 詳細側。ここが本当の現場である。**
   *
   * #67 が閉じた欠陥は「「いま送っても届かず」の真下に、届く送信ボタンが並んでいた」で、
   * その送信欄はこの画面に在る。CLI の `runnerLostSince` の文言には「いま話しかけ
   * られない」が入っているが、**実測ではデーモンは拒まない** —— 名簿が `lost` と
   * 判定した runner でも `RunnerRegistry#get()` は client を返し、`send()` は
   * `outcome: 'delivered'` を返した。
   *
   * ⟹ 注記が「話しかけられない」と言い、その下の送信ボタンが有効なまま、という
   * 組を作らない。**この歯は、注記と送信ボタンの両方を同時に見る。**
   */
  it('注記が送信を否定せず、その下の送信ボタンも実際に有効なまま', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: 'sess-1',
      runnerLostSince: LOST_SINCE,
    });

    expect(await screen.findByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    // #67 が閉じた欠陥そのもの。
    expect(screen.queryByText(/いま話しかけられない/)).toBeNull();
    expect(screen.queryByText(/届かず/)).toBeNull();
    expect(screen.getByText(/話しかけることは塞いでいない/)).toBeTruthy();
    // **注記の下のボタンが本当に押せること**まで見る（文言だけ直してボタンを
    // 塞ぐ、の逆向きの取り違えも止める）。**先に入力を埋める** —— 空欄のときは
    // `noWayBack` とは無関係に `disabled` なので、埋めずに測ると
    // 「戻る先が無いから塞がれている」と取り違える（実際に一度踏んだ）。
    fireEvent.change(screen.getByPlaceholderText('追加の指示'), {
      target: { value: '続けて' },
    });
    expect(screen.getByRole('button', { name: '送る' }).hasAttribute('disabled')).toBe(false);
  });

  /**
   * **2つは排他ではない。同時に立つ**（`packages/core/src/manager.ts` を
   * `ff24ded9` で引いて確かめた）。`summaryOf()` は2つを独立した spread で
   * 組み立てており、排他を課している行は1行も無い。`record.sessionMissingSince`
   * を消すのは「resume で戻れた」＝ runner が実際に答えた回の2箇所だけなので、
   * **runner が黙っても消えない。**
   *
   * この画面では `ManagerDenialNote` / `ManagerFailureNote` 相当の注記も同時に
   * 出うるので、**4本並ぶ形が理論上ある。** ここでは2本が両方出ることだけを固定
   * する（詰まって読めないかは jsdom では測れない —— PR 本文で人間へ回してある）。
   */
  it('2つの欄が同時に立ったら、注記は2本とも出る（片方が他方を消さない）', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: 'sess-1',
      runnerLostSince: LOST_SINCE,
      sessionMissingSince: MISSING,
    });

    expect(await screen.findByText('実行中')).toBeTruthy();
    expect(screen.getByText(/宛先の器は.*から名乗っていない/)).toBeTruthy();
    expect(screen.getByText(/この委譲のセッションを持っていなかった/)).toBeTruthy();
  });

  /**
   * **時刻はこの画面の作法（`~/lib/format` の `formatRelative`）。** CLI と
   * `manager_list` は ISO をそのまま出しており、**書式が違うのは意図である。**
   */
  it('時刻は相対表示で、ISO をそのまま出さない', async () => {
    renderDetail({
      ...BASE,
      status: 'running',
      live: false,
      sessionId: 'sess-1',
      runnerLostSince: LOST_SINCE,
      sessionMissingSince: MISSING,
    });

    expect(await screen.findByText(/名乗っていない/)).toBeTruthy();
    expect(screen.queryByText(new RegExp(LOST_SINCE))).toBeNull();
    expect(screen.queryByText(new RegExp(MISSING))).toBeNull();
  });
});
