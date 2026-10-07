// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isKeyOfType, KEY, useApprovalById } from './queries';
import { json, Providers, stubFetch, storeTestBaseUrl } from '../test-support';

function Probe({ id }: { id: string | null }) {
  const { data, error } = useApprovalById(id);
  let text = 'loading';
  if (error !== undefined) text = 'error';
  else if (data === null) text = 'null';
  else if (data !== undefined) text = `${data.approval.id}@${data.settledOn ?? 'none'}`;
  return <div data-testid="probe">{text}</div>;
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

const row = {
  id: 'a b',
  createdAt: '2026-09-30T00:00:00.000Z',
  question: 'q',
  updatedAt: '2026-09-30T00:00:00.000Z',
};

describe('useApprovalById', () => {
  it('GET /approvals/{id} を1回だけ叩き（id は URL エンコード・クエリ無し）、承認と settledOn を返す', async () => {
    const stub = stubFetch((url) =>
      url.includes('/approvals/') ? json({ approval: row, settledOn: '2026-09-30' }) : undefined,
    );
    render(
      <Providers>
        <Probe id="a b" />
      </Providers>,
    );
    await screen.findByText('a b@2026-09-30');
    const calls = stub.calls.filter((url) => url.includes('/approvals'));
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!).pathname).toBe('/approvals/a%20b');
    expect(new URL(calls[0]!).search).toBe('');
  });

  it('404 は null（無い）。500 は error（「無い」と言わない）', async () => {
    stubFetch(() => json({ error: 'not found' }, 404));
    render(
      <Providers>
        <Probe id="x" />
      </Providers>,
    );
    await screen.findByText('null');
    cleanup();
    stubFetch(() => json({ error: 'boom' }, 500));
    render(
      <Providers>
        <Probe id="y" />
      </Providers>,
    );
    await screen.findByText('error');
  });

  it('id が null なら取りに行かない', async () => {
    const stub = stubFetch(() => json({}));
    render(
      <Providers>
        <Probe id={null} />
      </Providers>,
    );
    await screen.findByText('loading');
    expect(stub.calls.filter((url) => url.includes('/approvals'))).toHaveLength(0);
  });

  it('キーは approvals の束に入り、id が違えば別のキー、開いた回が違えば別のキー（#4076）', () => {
    expect(isKeyOfType(KEY.approvalById('a', 1), 'approvals')).toBe(true);
    expect(KEY.approvalById('a', 1)).not.toEqual(KEY.approvalById('b', 1));
    expect(KEY.approvalById('a', 1)).not.toEqual(KEY.approvalById('a', 2));
  });
});
