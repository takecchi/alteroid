// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import {
  LeaveGuardScope,
  ScopeDirtyProvider,
  useReportDirty,
  useScopeDirtyRegistry,
} from './leave-guard';

afterEach(cleanup);

function Field({ id }: { id: string }) {
  const [text, setText] = useState('');
  useReportDirty('field', text !== '');
  return <input aria-label={id} value={text} onChange={(e) => setText(e.target.value)} />;
}

function Harness() {
  const { hasDirty, report } = useScopeDirtyRegistry();
  const [showB, setShowB] = useState(true);
  return (
    <ScopeDirtyProvider value={report}>
      <p data-testid="state">{hasDirty ? 'dirty' : 'clean'}</p>
      <button type="button" onClick={() => setShowB(false)}>
        Bを外す
      </button>
      <LeaveGuardScope>
        <Field id="a" />
      </LeaveGuardScope>
      {showB && (
        <LeaveGuardScope>
          <Field id="b" />
        </LeaveGuardScope>
      )}
    </ScopeDirtyProvider>
  );
}

function renderHarness() {
  const router = createMemoryRouter([{ path: '/', Component: Harness }]);
  render(<RouterProvider router={router} />);
}

const state = () => screen.getByTestId('state').textContent;
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('書きかけの合算', () => {
  it('どの欄も空なら書きかけではない', async () => {
    renderHarness();
    await screen.findByLabelText('a');
    expect(state()).toBe('clean');
  });

  it('どれか1つでも書きかけなら書きかけ。2つのうち1つを消しても、残りがあれば書きかけのまま', async () => {
    renderHarness();
    await screen.findByLabelText('a');
    type('a', 'x');
    type('b', 'y');
    expect(state()).toBe('dirty');

    type('a', '');
    expect(state()).toBe('dirty');

    type('b', '');
    expect(state()).toBe('clean');
  });

  it('書きかけの画面が外れる（unmount）と、書きかけではなくなる', async () => {
    renderHarness();
    await screen.findByLabelText('a');
    type('b', 'y');
    expect(state()).toBe('dirty');

    fireEvent.click(screen.getByRole('button', { name: 'Bを外す' }));

    expect(state()).toBe('clean');
  });
});
