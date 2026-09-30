// @vitest-environment jsdom
/**
 * `/inbox` — 受信箱（`inbox_events`）の絞り込み一括削除（issue #972 / #1042）。
 *
 * ここで固定したいのは:
 *
 * - **既定は試算**——開いた直後は何も送らない。「試算する」で `dryRun: true` を送る
 * - 試算の結果（一致件数・対象件数・持ち越し件数・消える id の一覧）が出る
 * - **「実行する」で `dryRun: false` を送る**（同じ絞り込みのまま）
 * - **サーバの400文言をそのまま出す**（クライアント側で言い換えない）
 * - **絞り込みを変えたら、前の試算の結果を無効にする**（古い件数のまま
 *   「実行する」を押せる形を作らない）
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InboxBacklog, InboxEventType } from '@alteroid/logic';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

import Inbox from './inbox';

/** `INBOX_TYPE_ORDER`（`inbox.tsx`）と同じ7種類。全部並べると400になることの試験に使う。 */
const ALL_SEVEN_TYPES = [
  'human_message',
  'human_answer',
  'distill',
  'timer',
  'external',
  'self_initiative',
  'manager_message',
] as const;

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

interface Sent {
  url: string;
  method: string;
  body: {
    types: string[];
    sources?: string[];
    before?: string;
    reason: string;
    dryRun: boolean;
    limit?: number;
  };
}

/**
 * `POST /inbox/remove` の stub。**共有の `stubFetch` は使えない**
 * （`schedule.test.tsx` / `env-vars.test.tsx` と同じ理由——`openapi-fetch` は
 * `fetch(new Request(...))` の形で呼ぶので、素朴な `route(url, init)` だと
 * method も本文も落ちる）。
 *
 * `respond` に渡された関数が、読み取った本文から応答を決める——`dryRun` の値や
 * `types` の組み合わせでテストごとに違う応答を返したいため。
 */
function stubInboxRemove(
  respond: (body: Sent['body']) => { status: number; payload: unknown },
): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? (typeof input === 'string' ? input : String(input));
    const method = request?.method ?? init?.method ?? 'GET';

    if (!url.endsWith('/inbox/remove')) {
      return Promise.reject(new TypeError(`Failed to fetch: ${url}`));
    }

    const rawBody =
      request !== null
        ? await request.clone().text()
        : typeof init?.body === 'string'
          ? init.body
          : '{}';
    const body = JSON.parse(rawBody) as Sent['body'];
    sent.push({ url, method, body });

    const { status, payload } = respond(body);
    return json(payload, status);
  }) as typeof fetch;

  return sent;
}

function renderInbox(): void {
  render(
    <Providers>
      <Inbox />
    </Providers>,
  );
}

/** 種類のチェックボックスを、日本語ラベルの部分一致で選ぶ。 */
function checkType(label: RegExp): void {
  fireEvent.click(screen.getByRole('checkbox', { name: label }));
}

function fillReason(text: string): void {
  fireEvent.change(screen.getByLabelText('理由（日誌に残る・必須）'), {
    target: { value: text },
  });
}

/** 試算の応答の型どおりの既定値。 */
function dryRunPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    dryRun: true,
    totalPending: 120,
    matched: 40,
    targeted: 40,
    removedIds: ['evt-1', 'evt-2'],
    remaining: 0,
    ...overrides,
  };
}

describe('/inbox 画面 — 受信箱の絞り込み一括削除（#972 / #1042）', () => {
  it('既定は試算——開いた直後は何も送らず、「試算する」で dryRun:true を送る', async () => {
    const sent = stubInboxRemove(() => ({ status: 200, payload: dryRunPayload() }));
    renderInbox();

    // 種類を選ぶ・理由を書くまでは、開いただけでは1本も飛んでいない。
    expect(sent).toHaveLength(0);

    checkType(/マネージャーの報告/);
    fillReason('数千件の写しが積もったので畳む');
    fireEvent.click(screen.getByRole('button', { name: '試算する' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.body.dryRun).toBe(true);
    expect(sent[0]?.body.types).toEqual(['manager_message']);
    expect(sent[0]?.body.reason).toBe('数千件の写しが積もったので畳む');
  });

  it('試算の結果（一致・対象・持ち越し・消える id の一覧）が出る', async () => {
    stubInboxRemove(() => ({ status: 200, payload: dryRunPayload() }));
    renderInbox();

    checkType(/マネージャーの報告/);
    fillReason('数千件の写しが積もったので畳む');
    fireEvent.click(screen.getByRole('button', { name: '試算する' }));

    expect(await screen.findByText(/未読 120 件中 40 件が絞り込みに一致/)).toBeTruthy();
    expect(screen.getByText(/持ち越し 0 件/)).toBeTruthy();
    expect(screen.getByText('evt-1')).toBeTruthy();
    expect(screen.getByText('evt-2')).toBeTruthy();
    // 試算では1件も消していないと明言する。
    expect(screen.getByText(/1件も消していません（試算）/)).toBeTruthy();
  });

  it('「実行する」を押すと、同じ絞り込みのまま dryRun:false を送る', async () => {
    let dryRunCalls = 0;
    const sent = stubInboxRemove((body) => {
      if (body.dryRun) {
        dryRunCalls += 1;
        return { status: 200, payload: dryRunPayload() };
      }
      return {
        status: 200,
        payload: dryRunPayload({ dryRun: false, removedIds: ['evt-1', 'evt-2'] }),
      };
    });
    renderInbox();

    checkType(/マネージャーの報告/);
    fillReason('数千件の写しが積もったので畳む');
    fireEvent.click(screen.getByRole('button', { name: '試算する' }));
    await waitFor(() => expect(dryRunCalls).toBe(1));

    fireEvent.click(await screen.findByRole('button', { name: /実行する/ }));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.body.dryRun).toBe(false);
    expect(sent[1]?.body.types).toEqual(['manager_message']);
    expect(sent[1]?.body.reason).toBe('数千件の写しが積もったので畳む');
    expect(await screen.findByText(/実行しました/)).toBeTruthy();
  });

  it('サーバの400文言をそのまま出す（7種類全部を選んだ呼び）', async () => {
    const errorText =
      'types に在る7種類（human_message, human_answer, distill, timer, external, ' +
      'self_initiative, manager_message）を全部並べた呼びは断る——それは絞り込みが' +
      '無いのと同じで、1回で受信箱を空にできてしまう。消したい種類だけを名指しする' +
      'こと（例 types: ["manager_message"]）。**1件も消していない。**';
    stubInboxRemove((body) => {
      const coversAllSeven = ALL_SEVEN_TYPES.every((type) => body.types.includes(type));
      if (coversAllSeven) return { status: 400, payload: { error: errorText } };
      return { status: 200, payload: dryRunPayload() };
    });
    renderInbox();

    for (const label of [
      /人間の発言/,
      /人間の回答/,
      /要約/,
      /タイマー/,
      /外部イベント/,
      /自発/,
      /マネージャーの報告/,
    ]) {
      checkType(label);
    }
    // クライアント側の事前の注意（断るのはサーバ、注意はUI）。
    expect(screen.getByText(/7種類全部を選んでいる/)).toBeTruthy();

    fillReason('全部畳みたい');
    fireEvent.click(screen.getByRole('button', { name: '試算する' }));

    // サーバの断り文言がそのまま出る——言い換えていない。
    expect(await screen.findByText(errorText)).toBeTruthy();
  });

  it('絞り込みを変えると、前の試算の結果を無効にする', async () => {
    stubInboxRemove(() => ({ status: 200, payload: dryRunPayload() }));
    renderInbox();

    checkType(/マネージャーの報告/);
    fillReason('数千件の写しが積もったので畳む');
    fireEvent.click(screen.getByRole('button', { name: '試算する' }));

    expect(await screen.findByText(/未読 120 件中 40 件が絞り込みに一致/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /実行する/ })).toBeTruthy();

    // 種類の選択を変える（絞り込みの変更）——前の結果は消え、「実行する」も消える。
    checkType(/タイマー/);

    expect(screen.queryByText(/未読 120 件中 40 件が絞り込みに一致/)).toBeNull();
    expect(screen.queryByRole('button', { name: /実行する/ })).toBeNull();
  });
});

/** `GET /inbox` の内訳（`InboxBacklogCard`）の材料。実際に返す欄をすべて埋める。 */
function backlogFixture(overrides: Partial<InboxBacklog> = {}): InboxBacklog {
  return {
    total: 2,
    byType: [{ type: 'manager_message', count: 2 }],
    bySource: [],
    bySourceOverflowKinds: 0,
    bySourceOverflowCount: 0,
    bySourceUnknownCount: 0,
    distinct: 2,
    distinctAcrossManagers: 2,
    undelivered: 0,
    deliveredOnce: 2,
    redelivered: 0,
    maxDeliveries: 1,
    undeliveredByType: [],
    ageBuckets: [{ label: '1時間未満', count: 2 }],
    observedAt: '2026-09-28T00:00:00.000Z',
    humanOriginated: { total: 0, byType: [], undelivered: 0 },
    ...overrides,
  };
}

/** `GET /inbox` だけを埋める（`POST /inbox/remove` はこの群の対象外なので触らない）。 */
function stubInboxBacklog(backlog: InboxBacklog): void {
  stubFetch((url, init) => {
    if (url.endsWith('/inbox') && (init?.method ?? 'GET') === 'GET') return json(backlog);
    return undefined;
  });
}

/**
 * **知らない `type` でも内訳を落とさない**（issue #2010。#1623 で `managers.tsx` の
 * `ManagerStatusBadge` に入れた形の横展開）。`byType` / `undeliveredByType` の
 * `entry.type` は daemon（`GET /inbox`）から届く値で、Web（Vercel）とデーモン
 * （Railway）は別々にデプロイされるので、デーモンが先に新しい種類の値を返す時間が
 * 在る。型は `as InboxEventType` で迂回する——実機でも型はコンパイル時の飾りで、
 * JSON はそのまま届く。
 */
describe('知らない受信箱の種類に倒れ先がある（#2010）', () => {
  it('知らない type が混ざっても落ちず、既知の行は今までどおり、知らない行は生の値を出す', async () => {
    stubInboxBacklog(
      backlogFixture({
        total: 3,
        byType: [
          { type: 'manager_message', count: 2 },
          { type: 'draining' as InboxEventType, count: 1 },
        ],
        bySourceUnknownCount: 1,
        distinct: 3,
        distinctAcrossManagers: 3,
        undelivered: 1,
        undeliveredByType: [{ type: 'draining' as InboxEventType, count: 1 }],
        ageBuckets: [{ label: '1時間未満', count: 3 }],
      }),
    );
    renderInbox();

    expect(await screen.findByText('マネージャーの報告')).toBeTruthy();
    // 「種類」（byType）と「いまの器になってから積まれた分」（undeliveredByType）の
    // 両方の内訳が同じ helper（`inboxTypeLabel`）を通るので、2箇所に出る。
    expect(screen.getAllByText('知らない種類（draining）')).toHaveLength(2);
  });

  /** 継承したキー（`constructor`）は `INBOX_TYPE_LABELS[...]` が `undefined` にならないので別に測る。 */
  it('Object の継承したキーと同じ名前の type でも落ちない', async () => {
    stubInboxBacklog(
      backlogFixture({
        total: 1,
        byType: [{ type: 'constructor' as InboxEventType, count: 1 }],
        bySourceUnknownCount: 1,
      }),
    );
    renderInbox();

    expect(await screen.findByText('知らない種類（constructor）')).toBeTruthy();
  });

  it('既知の type は今までどおりのラベルで出す', async () => {
    stubInboxBacklog(backlogFixture());
    renderInbox();

    expect(await screen.findByText('マネージャーの報告')).toBeTruthy();
  });
});

/**
 * **読めない合図が在るとき、「未処理の合図は無い」と言わない**（issue #2344）。
 * `GET /inbox` の `unreadable` は1件でも在るときだけ載る。承認待ちの
 * `UnreadableApprovalNote`（#2298）と同じ形の断りを、内訳の上に出す。
 */
describe('読めない受信箱の行を「未処理の合図は無い」と言わない（#2344）', () => {
  const EMPTY = {
    total: 0,
    byType: [],
    ageBuckets: [],
    deliveredOnce: 0,
    distinct: 0,
    distinctAcrossManagers: 0,
  };

  it('読めた行が0件で読めない行が在れば、断りを出し、「未処理の合図は無い」とは言わない', async () => {
    stubInboxBacklog(
      backlogFixture({
        ...EMPTY,
        unreadable: [
          { id: 'evt-bad', at: '2026-09-27T00:00:00.000Z', reason: '不正な欄: event.type' },
        ],
      }),
    );
    renderInbox();

    expect(await screen.findByText(/読めない合図が 1 件ある/)).toBeTruthy();
    expect(screen.getByText(/id: evt-bad/)).toBeTruthy();
    expect(screen.getByText('壊れた行であって、処理済みで消えたのではない。')).toBeTruthy();
    expect(screen.queryByText('クローンの受信箱に未処理の合図は無い。')).toBeNull();
    expect(screen.getByText('読めた未処理の合図は無い。')).toBeTruthy();
  });

  it('読めた行が在り、読めない行も在れば、内訳の上に断りが出る', async () => {
    stubInboxBacklog(backlogFixture({ unreadable: [{ reason: '不正な行' }] }));
    renderInbox();

    expect(await screen.findByText(/読めない合図が 1 件ある/)).toBeTruthy();
    expect(screen.getByText(/計 2 件/)).toBeTruthy();
  });

  it('対照: 本当に0件なら「無い」と言い、断りは出ない', async () => {
    stubInboxBacklog(backlogFixture(EMPTY));
    renderInbox();

    expect(await screen.findByText('クローンの受信箱に未処理の合図は無い。')).toBeTruthy();
    expect(screen.queryByText(/読めない合図/)).toBeNull();
  });

  it('対照: unreadable が無ければ断りは出ない', async () => {
    stubInboxBacklog(backlogFixture());
    renderInbox();

    expect(await screen.findByText('マネージャーの報告')).toBeTruthy();
    expect(screen.queryByText(/読めない合図/)).toBeNull();
  });
});
