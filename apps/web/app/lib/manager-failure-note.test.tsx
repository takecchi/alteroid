// @vitest-environment jsdom
/**
 * `terminalFailureNote` は `manager-detail.tsx` の `FailureNote` と
 * `managers.tsx` の `ManagerFailureNote` が同じ文を手書きで複製していたのを
 * 1本化した生成元（Issue #1882、レビュー指摘）。ここではその生成元そのものを
 * 直接描画して確かめる——route 側のテスト（`manager-detail.test.tsx` /
 * `managers.test.tsx`）は「呼び出し側が正しく繋いでいるか」を見るが、ここは
 * 「文言そのものが正しいか」を1箇所で見る。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ManagerStatus } from '@alteroid/logic';

import { terminalFailureNote } from './manager-failure-note';

afterEach(() => {
  cleanup();
});

function renderNote(status: ManagerStatus) {
  render(<div>{terminalFailureNote(status)}</div>);
}

describe('terminalFailureNote', () => {
  it('failed / lost は「依頼者が望まない終わり方」の終端の言葉になる', () => {
    for (const status of ['failed', 'lost'] as const) {
      cleanup();
      renderNote(status);
      expect(screen.getByText('この仕事はもう終わっている')).toBeTruthy();
      expect(screen.getByText(/依頼者が望まない終わり方で既に終端している/)).toBeTruthy();
      // **「もう続かない」へは戻さない**（レビュー指摘。`send()` / `#resume()` の
      // 現物は `status` を見ずに resume を試みうる——このファイルの doc を見よ）。
      expect(
        screen.getByText(/続けたいなら話しかけて resume を試みるしかなく、届く保証は無い/),
      ).toBeTruthy();
      expect(screen.queryByText(/自動では続かない/)).toBeNull();
      expect(screen.queryByText(/セッションは生きているので/)).toBeNull();
    }
  });

  it('stopped は「人間・クローンが明示的に停止させた」終端の言葉になる', () => {
    renderNote('stopped');
    expect(screen.getByText('この仕事はもう終わっている')).toBeTruthy();
    expect(
      screen.getByText(/人間・クローンが明示的に停止させ、確かめたうえで既に終端している/),
    ).toBeTruthy();
    expect(
      screen.getByText(/続けたいなら話しかけて resume を試みるしかなく、届く保証は無い/),
    ).toBeTruthy();
    // **直す前の言い切り（原因の有無にかかわらず、このセッションはもう続かない）
    // には戻さない。** `stopped` も `send()` が実際に resume を試みうる側
    // ——このファイルの doc の「1」〜「3」を見よ。
    expect(screen.queryByText(/原因の有無にかかわらず/)).toBeNull();
    expect(screen.queryByText(/セッションは生きているので/)).toBeNull();
  });

  it('生きている3値（running / waiting_human / done）は null——呼び出し側が自分の文言を書く', () => {
    for (const status of ['running', 'waiting_human', 'done'] as const) {
      expect(terminalFailureNote(status)).toBeNull();
    }
  });
});
