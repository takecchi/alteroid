// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { JournalEntry } from '@alteroid/logic';

import { JournalReportDetail } from './journal-report-detail';

afterEach(cleanup);

const entry = (source: string, summary: string): JournalEntry => ({
  type: 'external_event',
  id: 'ev-1',
  at: '2026-11-01T00:00:00.000Z',
  source,
  summary,
});

describe('JournalReportDetail', () => {
  it('報告は欄ごとに見せる。値は HTML として解釈しない', () => {
    const payload = { summary: '<b>x</b>', component: 'web', severity: 'low' };
    render(<JournalReportDetail entry={entry('alteroid-report', JSON.stringify(payload))} />);
    expect(screen.getByText('重大度（報告者の自己申告）')).toBeTruthy();
    expect(screen.getByText('<b>x</b>')).toBeTruthy();
  });

  it('他の source・壊れた形は何も出さない', () => {
    const { container, rerender } = render(
      <JournalReportDetail entry={entry('ci', '{"summary":"s"}')} />,
    );
    expect(container.innerHTML).toBe('');
    rerender(<JournalReportDetail entry={entry('alteroid-report', 'x')} />);
    expect(container.innerHTML).toBe('');
  });
});
