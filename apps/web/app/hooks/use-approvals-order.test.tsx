// @vitest-environment jsdom
/**
 * `useApprovals` が `order` を明示して呼ぶこと（Issue #426 の G4）。
 *
 * **見ているのは並びであって、件数ではない。** ここは全件を受け取るので、
 * 応答へ載る `total` は受け取った配列の長さと必ず一致する冗長な値である。
 *
 * `order` を渡さない呼びは、デーモンがストアの生の並びをそのまま返す。その
 * 生の並びは実装ごとに違う（`storage-fs` / `testing.ts` は挿入順で
 * `putApproval` が既存の id を末尾へ動かす、`storage-pg` は `createdAt` の
 * 昇順）。**⟹ 同じ画面が、どの永続化層で動いているかで違う順に出ていた。**
 *
 * **URL を見る形で固定する。** 応答の中身ではなく「何を送ったか」が
 * この変更の本体なので、送った URL そのものを測る（`stubFetch` の `calls`）。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useApprovals } from '~/hooks/queries';
import { json, Providers, stubFetch, storeTestBaseUrl } from '~/test-support';

function Probe({ pending }: { pending: boolean }) {
  const { data } = useApprovals(pending);
  return <div data-testid="count">{data === undefined ? 'loading' : data.approvals.length}</div>;
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

describe('useApprovals は order を明示して呼ぶ（並びを実装によらず揃える）', () => {
  it('既定（未回答のみ）の呼びに order=asc が載る', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [], total: 0 });
      return undefined;
    });

    render(
      <Providers>
        <Probe pending={true} />
      </Providers>,
    );
    await screen.findByText('0');

    const call = stub.calls.find((url) => url.includes('/approvals'));
    expect(call).toBeDefined();
    expect(call).toContain('order=asc');
    // 既定の絞りは変えていない。
    expect(call).toContain('pending=true');
    // **窓は作らない。** `limit` / `cursor` を送ると頁が切れる側へ倒れる。
    expect(call).not.toContain('limit=');
    expect(call).not.toContain('cursor=');
  });

  it('回答済みも見る呼び（pending=false）にも order=asc が載る', async () => {
    const stub = stubFetch((url) => {
      if (url.includes('/approvals')) return json({ approvals: [], total: 0 });
      return undefined;
    });

    render(
      <Providers>
        <Probe pending={false} />
      </Providers>,
    );
    await screen.findByText('0');

    const call = stub.calls.find((url) => url.includes('/approvals'));
    expect(call).toContain('order=asc');
    expect(call).toContain('pending=false');
  });
});
