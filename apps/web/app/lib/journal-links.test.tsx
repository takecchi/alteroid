// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import type { JournalEntry } from '@alteroid/logic';

import { JournalEntryLinks, journalEntryLinks } from './journal-links';

afterEach(() => {
  cleanup();
});

function renderLinks(entry: JournalEntry) {
  const router = createMemoryRouter(
    [{ path: '/', Component: () => <JournalEntryLinks entry={entry} /> }],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

const AT = '2026-09-28T23:00:00.000Z';

const MODELS = {
  'claude-opus-5-5': {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUsd: 0.01,
  },
};

describe('journalEntryLinks（issue #2064）', () => {
  it('マネージャー発の escalation はその委譲へ、managerId の無い escalation は何も出さない', () => {
    const fromManager: JournalEntry = {
      type: 'escalation',
      id: 'e-1',
      at: AT,
      question: '進めてよいか',
      approvalId: 'a-1',
      managerId: 'mgr-7',
    };
    const fromClone: JournalEntry = {
      type: 'escalation',
      id: 'e-2',
      at: AT,
      question: '進めてよいか',
      approvalId: 'a-2',
    };
    expect(journalEntryLinks(fromManager)).toEqual([
      { to: '/managers/mgr-7', label: '委譲 mgr-7 の詳細', short: '委譲' },
    ]);
    expect(journalEntryLinks(fromClone)).toEqual([]);
  });

  it('turn_usage は mgr- の分だけつなぎ、clone の分はつながない', () => {
    const clone: JournalEntry = {
      type: 'turn_usage',
      id: 't-1',
      at: AT,
      layer: 'clone',
      site: 'session',
      managerId: 'clone',
      models: MODELS,
    };
    const manager: JournalEntry = { ...clone, id: 't-2', layer: 'manager', managerId: 'mgr-9' };
    expect(journalEntryLinks(clone)).toEqual([]);
    expect(journalEntryLinks(manager)).toEqual([
      { to: '/managers/mgr-9', label: '委譲 mgr-9 の詳細', short: '委譲' },
    ]);
  });

  it('mgr- で始まらない委譲の id でもつなぎ、クローンの id はつながない', () => {
    const base: JournalEntry = {
      type: 'turn_usage',
      id: 't-3',
      at: AT,
      layer: 'manager',
      site: 'session',
      managerId: 'job-7f3a',
      models: MODELS,
    };
    expect(journalEntryLinks(base)).toEqual([
      { to: '/managers/job-7f3a', label: '委譲 job-7f3a の詳細', short: '委譲' },
    ]);
    expect(journalEntryLinks({ ...base, id: 't-4', layer: 'clone', managerId: 'clone' })).toEqual(
      [],
    );
  });

  it('memory_update は slug の記憶（いまの版）へつなぐ', () => {
    const entry: JournalEntry = {
      type: 'memory_update',
      id: 'mu-1',
      at: AT,
      slug: 'values',
      summary: '価値観を足した',
      cause: 'human',
    };
    expect(journalEntryLinks(entry)).toEqual([
      { to: '/memory/values', label: '記憶 values（いまの版）', short: '記憶' },
    ]);
  });

  it('実体を指さない種別は何も出さない', () => {
    const entry: JournalEntry = {
      type: 'exchange',
      id: 'x-1',
      at: AT,
      with: 'human',
      role: 'inbound',
      text: 'こんにちは',
    };
    expect(journalEntryLinks(entry)).toEqual([]);
  });
});

describe('JournalEntryLinks（issue #2064）', () => {
  it('リンクを href 付きで描く', () => {
    renderLinks({
      type: 'memory_update',
      id: 'mu-1',
      at: AT,
      slug: 'values',
      summary: '価値観を足した',
      cause: 'human',
    });
    const link = screen.getByRole('link', { name: /記憶 values/ });
    expect(link.getAttribute('href')).toBe('/memory/values');
  });

  it('つなぐ先が無ければ何も描かない', () => {
    const { container } = renderLinks({
      type: 'escalation',
      id: 'e-2',
      at: AT,
      question: '進めてよいか',
      approvalId: 'a-2',
    });
    expect(screen.queryByRole('link')).toBeNull();
    expect(container.textContent).toBe('');
  });
});
