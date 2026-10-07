// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isKeyOfType, KEY, useAnsweredApprovalDates, useApprovalsAnsweredOn } from './queries';
import { json, Providers, stubFetch, storeTestBaseUrl } from '../test-support';

function DatesProbe({ limit }: { limit?: number }) {
  const { data } = useAnsweredApprovalDates(limit);
  return (
    <div data-testid="dates">
      {data === undefined ? 'loading' : data.dates.map((d) => `${d.date}:${d.count}`).join(',')}
    </div>
  );
}

function DayProbe({ date }: { date: string | null }) {
  const { data } = useApprovalsAnsweredOn(date);
  return (
    <div data-testid="day">
      {data === undefined ? 'idle' : data.approvals.map((a) => a.id).join(',') || 'empty'}
    </div>
  );
}

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

describe('useAnsweredApprovalDates', () => {
  it('GET /approvals/answered-dates を limit 付きで叩き、日と件数をそのまま返す', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/approvals/answered-dates')) {
        return json({
          dates: [
            { date: '2026-09-30', count: 3 },
            { date: '2026-09-29', count: 1 },
          ],
        });
      }
      return undefined;
    });
    render(
      <Providers>
        <DatesProbe />
      </Providers>,
    );
    await screen.findByText('2026-09-30:3,2026-09-29:1');
    const call = stub.calls.find((url) => url.includes('/approvals/answered-dates'));
    expect(call).toContain('limit=60');
  });

  it('limit を渡せる', async () => {
    const stub = stubFetch((url) =>
      url.includes('/approvals/answered-dates') ? json({ dates: [] }) : undefined,
    );
    render(
      <Providers>
        <DatesProbe limit={5} />
      </Providers>,
    );
    await waitFor(() =>
      expect(stub.calls.find((url) => url.includes('answered-dates'))).toContain('limit=5'),
    );
  });
});

describe('useApprovalsAnsweredOn', () => {
  it('answeredOn だけを送る（pending=true・order・limit・cursor は付けない。併用すると 400 になる）', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [{ id: 'a-1' }] });
      return undefined;
    });
    render(
      <Providers>
        <DayProbe date="2026-09-30" />
      </Providers>,
    );
    await screen.findByText('a-1');
    const call = stub.calls.find((url) => url.includes('/approvals'))!;
    expect(call).toContain('answeredOn=2026-09-30');
    for (const forbidden of ['pending=true', 'order=', 'limit=', 'cursor=']) {
      expect(call).not.toContain(forbidden);
    }
  });

  it('date が null なら取りに行かない', async () => {
    const stub = stubFetch(() => json({ approvals: [] }));
    render(
      <Providers>
        <DayProbe date={null} />
      </Providers>,
    );
    await screen.findByText('idle');
    expect(stub.calls.filter((url) => url.includes('/approvals'))).toHaveLength(0);
  });
});

describe('キーは approvals の束に入る（escalation の無効化から外れない）', () => {
  it('どちらの KEY も isKeyOfType(key, "approvals") に当たる', () => {
    expect(isKeyOfType(KEY.approvalsAnsweredDates(60), 'approvals')).toBe(true);
    expect(isKeyOfType(KEY.approvalsAnsweredOn('2026-09-30'), 'approvals')).toBe(true);
  });

  it('日が違えば別のキー（古い日の値が出ない）', () => {
    expect(KEY.approvalsAnsweredOn('2026-09-30')).not.toEqual(
      KEY.approvalsAnsweredOn('2026-09-29'),
    );
  });
});
