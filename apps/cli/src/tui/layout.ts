// 出所: takecchi/codiva（MIT）`src/core/layout.ts` の `isFullscreenViewport` の考え方

// これ未満で root の height を固定しない: クリップで入力欄やフッタが消えて操作不能になるため
export const MIN_FULLSCREEN_ROWS = 12;

export function isFullscreenViewport(rows: number | undefined): boolean {
  return rows !== undefined && rows >= MIN_FULLSCREEN_ROWS;
}

export const TABS = [
  { id: 'chat', key: '1', label: '会話', command: 'chat' },
  { id: 'approvals', key: '2', label: '承認待ち', command: 'approvals' },
  { id: 'managers', key: '3', label: '委譲', command: 'managers' },
  { id: 'journal', key: '4', label: '日誌', command: 'journal' },
  { id: 'memory', key: '5', label: '記憶', command: 'memory' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

export const CHROME_ROWS = 3;

const COMPOSER_MAX_ROWS = 6;

export interface ChatLayout {
  bodyHeight: number;
  logHeight: number;
  composerShown: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

export function chatLayout(input: {
  rows: number;
  composerRows: number;
  fullscreen: boolean;
}): ChatLayout {
  const bodyHeight = Math.max(input.rows - CHROME_ROWS, input.fullscreen ? 4 : 8);
  const composerShown = clamp(
    input.composerRows,
    1,
    Math.min(COMPOSER_MAX_ROWS, Math.max(1, bodyHeight - 4)),
  );
  const logHeight = Math.max(1, bodyHeight - 1 - (composerShown + 2));
  return { bodyHeight, logHeight, composerShown };
}
