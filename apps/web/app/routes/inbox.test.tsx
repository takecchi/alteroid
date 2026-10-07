// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InboxBacklog, InboxEventType } from '@alteroid/logic';
import { json, Providers, TestDataRouter, stubFetch, storeTestBaseUrl } from '~/test-support';

import Inbox from './inbox';

const ALL_SEVEN_TYPES = [
  'human_message',
  'human_answer',
  'distill',
  'timer',
  'external',
  'self_initiative',
  'manager_message',
] as const;

process.env.TZ = 'Asia/Tokyo';

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

// 共有の stubFetch を使わない: openapi-fetch は fetch(new Request(...)) の形で呼ぶので、route(url, init) では method も本文も落ちるため
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
      <TestDataRouter>
        <Inbox />
      </TestDataRouter>
    </Providers>,
  );
}

function checkType(label: RegExp): void {
  fireEvent.click(screen.getByRole('checkbox', { name: label }));
}

function fillReason(text: string): void {
  fireEvent.change(screen.getByLabelText('理由（日誌に残る・必須）'), {
    target: { value: text },
  });
}

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

  it('7種類すべてを選んだ状態では送らない（押せず、理由を人間の言葉で言う）', async () => {
    const sent = stubInboxRemove(() => ({ status: 200, payload: dryRunPayload() }));
    renderInbox();

    for (const label of [
      /人間の発言/,
      /人間の回答/,
      /記憶の整理/,
      /定期ジョブ/,
      /外からの通知/,
      /クローンの自発/,
      /マネージャーの報告/,
    ]) {
      checkType(label);
    }
    fillReason('全部畳みたい');

    expect(screen.getByText(/7種類すべてを選んでいる/)).toBeTruthy();
    const button = screen.getByRole('button', { name: '試算する' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(sent).toHaveLength(0);

    checkType(/定期ジョブ/);
    const enabled = screen.getByRole('button', { name: '試算する' }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body.types).toHaveLength(6);
  });

  it('絞り込みを変えると、前の試算の結果を無効にする', async () => {
    stubInboxRemove(() => ({ status: 200, payload: dryRunPayload() }));
    renderInbox();

    checkType(/マネージャーの報告/);
    fillReason('数千件の写しが積もったので畳む');
    fireEvent.click(screen.getByRole('button', { name: '試算する' }));

    expect(await screen.findByText(/未読 120 件中 40 件が絞り込みに一致/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /実行する/ })).toBeTruthy();

    checkType(/定期ジョブ/);

    expect(screen.queryByText(/未読 120 件中 40 件が絞り込みに一致/)).toBeNull();
    expect(screen.queryByRole('button', { name: /実行する/ })).toBeNull();
  });
});

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

function stubInboxBacklog(backlog: InboxBacklog): void {
  stubFetch((url, init) => {
    if (url.endsWith('/inbox') && (init?.method ?? 'GET') === 'GET') return json(backlog);
    return undefined;
  });
}

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
    expect(screen.getAllByText('その他の種類')).toHaveLength(2);
  });

  it('Object の継承したキーと同じ名前の type でも落ちない', async () => {
    stubInboxBacklog(
      backlogFixture({
        total: 1,
        byType: [{ type: 'constructor' as InboxEventType, count: 1 }],
        bySourceUnknownCount: 1,
      }),
    );
    renderInbox();

    expect(await screen.findByText('その他の種類')).toBeTruthy();
  });

  it('既知の type は今までどおりのラベルで出す', async () => {
    stubInboxBacklog(backlogFixture());
    renderInbox();

    expect(await screen.findByText('マネージャーの報告')).toBeTruthy();
  });
});

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

describe('利用者の言葉で出す・日時は地域の時刻で入れる（#2782）', () => {
  it('内部の語（inbox_events・CLI 名・API パス・種類の識別子）が画面に出ない', async () => {
    stubInboxBacklog(backlogFixture());
    renderInbox();
    await screen.findByText('マネージャーの報告');
    const text = document.body.textContent ?? '';
    for (const word of [
      'inbox_events',
      'alteroid inbox',
      '/inbox',
      'ISO8601',
      ...ALL_SEVEN_TYPES.filter((type) => type !== 'external'),
    ]) {
      expect(text).not.toContain(word);
    }
  });

  it('最古時刻と観測時刻は UTC の ISO ではなく利用者の地域の時刻で出る', async () => {
    stubInboxBacklog(backlogFixture({ oldestAt: '2026-09-14T15:00:00.000Z' }));
    renderInbox();
    await screen.findByText(/最も古いものは/);
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it('「この日時より古い」は datetime-local で、送る値は今までと同じ UTC の ISO 8601（TZ=Asia/Tokyo）', async () => {
    const sent = stubInboxRemove(() => ({ status: 200, payload: dryRunPayload() }));
    renderInbox();

    const input = screen.getByLabelText(/この日時より古い合図だけ/) as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    expect(input.placeholder).toBe('');

    checkType(/マネージャーの報告/);
    fillReason('古いものを畳む');
    fireEvent.change(input, { target: { value: '2026-09-15T00:00' } });
    fireEvent.click(screen.getByRole('button', { name: '試算する' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body.before).toBe('2026-09-14T15:00:00.000Z');
    expect(sent[0]?.body.before).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('日時を入れなければ before を送らない', async () => {
    const sent = stubInboxRemove(() => ({ status: 200, payload: dryRunPayload() }));
    renderInbox();
    checkType(/マネージャーの報告/);
    fillReason('x');
    fireEvent.click(screen.getByRole('button', { name: '試算する' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body.before).toBeUndefined();
  });

  it('送る types は識別子のまま（表示だけ日本語）', async () => {
    const sent = stubInboxRemove(() => ({ status: 200, payload: dryRunPayload() }));
    renderInbox();
    checkType(/記憶の整理/);
    checkType(/クローンの自発/);
    fillReason('x');
    fireEvent.click(screen.getByRole('button', { name: '試算する' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.body.types).toEqual(['distill', 'self_initiative']);
  });
});
