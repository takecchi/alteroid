// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { useSWRConfig } from 'swr';
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

  it('開き直しても、キャッシュの項目は増えない。前の値が残っていても取り直し、済むまで revalidated は false（#4076）', async () => {
    let settledOn: string | null = null;
    const stub = stubFetch((url) =>
      url.includes('/approvals/') ? json({ approval: row, settledOn }) : undefined,
    );
    let cacheKeys: () => number = () => -1;
    let seen: Array<string> = [];
    function Opened() {
      const { data, revalidated } = useApprovalById('a b');
      seen.push(`${data?.settledOn ?? 'none'}:${revalidated}`);
      return <div data-testid="opened">{revalidated ? 'done' : 'wait'}</div>;
    }
    function Harness() {
      const [open, setOpen] = useState(true);
      const { cache } = useSWRConfig();
      cacheKeys = () => [...cache.keys()].length;
      return (
        <>
          <button onClick={() => setOpen((v) => !v)}>toggle</button>
          {open ? <Opened /> : null}
        </>
      );
    }
    render(
      <Providers>
        <Harness />
      </Providers>,
    );
    await screen.findByText('done');
    const sizeAfterFirst = cacheKeys();
    expect(sizeAfterFirst).toBeGreaterThan(0);
    // 閉じて、別の経路で答えられてから、開き直す
    fireEvent.click(screen.getByText('toggle'));
    settledOn = '2026-09-30';
    seen = [];
    fireEvent.click(screen.getByText('toggle'));
    await screen.findByText('done');
    // 取り直しが済む前に、残った「未回答」を済んだものとして見せない
    expect(seen.filter((s) => s === 'null:true' || s === 'none:true')).toEqual([]);
    expect(seen).toContain('2026-09-30:true');
    expect(stub.calls.filter((url) => url.includes('/approvals/'))).toHaveLength(2);
    fireEvent.click(screen.getByText('toggle'));
    fireEvent.click(screen.getByText('toggle'));
    await screen.findByText('done');
    expect(cacheKeys()).toBe(sizeAfterFirst);
  });

  it('キーは approvals の束に入り、id が違えば別のキー', () => {
    expect(isKeyOfType(KEY.approvalById('a'), 'approvals')).toBe(true);
    expect(KEY.approvalById('a')).not.toEqual(KEY.approvalById('b'));
  });
});
