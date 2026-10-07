// @vitest-environment jsdom
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
    expect(screen.queryByText(/原因の有無にかかわらず/)).toBeNull();
    expect(screen.queryByText(/セッションは生きているので/)).toBeNull();
  });

  it('生きている3値（running / waiting_human / done）は null——呼び出し側が自分の文言を書く', () => {
    for (const status of ['running', 'waiting_human', 'done'] as const) {
      expect(terminalFailureNote(status)).toBeNull();
    }
  });
});
