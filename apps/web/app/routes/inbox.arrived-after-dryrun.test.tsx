// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, Providers, TestDataRouter, storeTestBaseUrl } from '~/test-support';

import Inbox from './inbox';

process.env.TZ = 'Asia/Tokyo';

const DRY_RUN_AT = '2026-10-12T03:00:00.000Z';
const EXECUTE_AT = '2026-10-12T03:05:00.000Z';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  localStorage.clear();
  storeTestBaseUrl();
  // Date だけを差し替える: タイマーまで止めると waitFor が進まないため
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

interface SentBody {
  dryRun: boolean;
  before?: string;
}

function stubInboxRemove(): SentBody[] {
  const sent: SentBody[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const body = JSON.parse(await (input as Request).clone().text()) as SentBody;
    sent.push(body);
    return json({
      ok: true,
      dryRun: body.dryRun,
      totalPending: 3,
      matched: 2,
      targeted: 2,
      removedIds: ['evt-1', 'evt-2'],
      remaining: 0,
    });
  }) as typeof fetch;
  return sent;
}

async function dryRunThenExecute(beforeLocal?: string): Promise<SentBody[]> {
  const sent = stubInboxRemove();
  render(
    <Providers>
      <TestDataRouter>
        <Inbox />
      </TestDataRouter>
    </Providers>,
  );
  fireEvent.click(screen.getByRole('checkbox', { name: /マネージャーの報告/ }));
  fireEvent.change(screen.getByLabelText('理由（日誌に残る・必須）'), {
    target: { value: '畳む' },
  });
  if (beforeLocal !== undefined) {
    fireEvent.change(screen.getByLabelText('この日時より古い合図だけを対象にする（任意）'), {
      target: { value: beforeLocal },
    });
  }

  vi.setSystemTime(new Date(DRY_RUN_AT));
  fireEvent.click(screen.getByRole('button', { name: '試算する' }));
  const execute = await screen.findByRole('button', { name: /実行する/ });

  vi.setSystemTime(new Date(EXECUTE_AT));
  fireEvent.click(execute);
  await waitFor(() => expect(sent).toHaveLength(2));
  return sent;
}

describe('/inbox 一括削除 — 試算の後に届いた合図を実行で消さない（#4586）', () => {
  it('日時を空のまま試算したら、実行は試算を送った時刻より新しい合図を対象にしない', async () => {
    const sent = await dryRunThenExecute();

    expect(sent[0]?.before).toBeUndefined();
    expect(sent[1]?.dryRun).toBe(false);
    expect(sent[1]?.before).toBe(DRY_RUN_AT);
  });

  it('入れた日時が試算より前なら、実行もその日時のまま送る', async () => {
    // 2026-10-12 09:00 JST = 2026-10-12T00:00Z（試算の 03:00Z より前）
    const sent = await dryRunThenExecute('2026-10-12T09:00');

    expect(sent[0]?.before).toBe('2026-10-12T00:00:00.000Z');
    expect(sent[1]?.before).toBe('2026-10-12T00:00:00.000Z');
  });

  it('入れた日時が試算より後でも、実行は試算を送った時刻で切る', async () => {
    // 2026-10-12 18:00 JST = 2026-10-12T09:00Z（試算の 03:00Z より後）
    const sent = await dryRunThenExecute('2026-10-12T18:00');

    expect(sent[0]?.before).toBe('2026-10-12T09:00:00.000Z');
    expect(sent[1]?.before).toBe(DRY_RUN_AT);
  });
});
