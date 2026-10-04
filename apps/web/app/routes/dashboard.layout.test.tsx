// @vitest-environment jsdom
/**
 * ホームの配置が幅で変わること。jsdom は CSS を評価しないので、並びは JS（`useMinWidth`）で
 * 替えてあり、DOM の順で確かめる（DOM の順＝見た目の順＝Tab 順）。
 */
import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_VIEWPORT_WIDTH, setViewportWidth, storeTestBaseUrl } from '~/test-support';

import { renderHome as renderHomeWith } from './dashboard-test-helpers';

/** 承認待ちが1件ある状態で描く（0件だと見出しの無い1行に畳まれる）。 */
function renderHome() {
  return renderHomeWith({
    approvals: [{ id: 'approval-0', createdAt: '2026-08-14T09:00:00.000Z', question: '質問 0' }],
  });
}

beforeEach(() => {
  localStorage.clear();
  storeTestBaseUrl();
});

afterEach(() => {
  cleanup();
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
});

const MAP_TITLE = '稼働状況';
const AWAITING_TITLE = '承認待ち一覧';

/** 主役の段の中で、地図と承認待ちの見出しを DOM の順に返す。 */
async function mainOrder(): Promise<string[]> {
  const main = await screen.findByTestId('home-main');
  const map = within(main).getByText(MAP_TITLE);
  const awaiting = within(main).getByText(AWAITING_TITLE);
  return map.compareDocumentPosition(awaiting) & Node.DOCUMENT_POSITION_FOLLOWING
    ? [MAP_TITLE, AWAITING_TITLE]
    : [AWAITING_TITLE, MAP_TITLE];
}

describe('ホームの配置', () => {
  it('広い画面（1920px）では地図が左・承認待ち一覧が右の横並び', async () => {
    setViewportWidth(1920);
    renderHome();
    expect((await screen.findByTestId('home-main')).dataset.layout).toBe('side-by-side');
    expect(await mainOrder()).toEqual([MAP_TITLE, AWAITING_TITLE]);
  });

  it('ラップトップ幅（1366px）は縦積みのまま（地図の見た目を変えない）', async () => {
    setViewportWidth(1366);
    renderHome();
    expect((await screen.findByTestId('home-main')).dataset.layout).toBe('stacked');
  });

  it('タブレット幅（900px）では縦積みで承認待ち一覧が上', async () => {
    setViewportWidth(900);
    renderHome();
    expect((await screen.findByTestId('home-main')).dataset.layout).toBe('stacked');
    expect(await mainOrder()).toEqual([AWAITING_TITLE, MAP_TITLE]);
  });

  it('境目（1800px）から横並びになり、幅を変えると組み替わる', async () => {
    setViewportWidth(1799);
    renderHome();
    expect((await screen.findByTestId('home-main')).dataset.layout).toBe('stacked');
    act(() => setViewportWidth(1800));
    expect((await screen.findByTestId('home-main')).dataset.layout).toBe('side-by-side');
  });
});
