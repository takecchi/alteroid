/**
 * 全画面レイアウトの判定。出所: takecchi/codiva（MIT）`src/core/layout.ts` の
 * `isFullscreenViewport` の考え方（小さい端末ではインライン描画へ縮退する）。
 */

/**
 * 全画面レイアウトに要る最小の端末行数。固定部分（ヘッダ 1 + タブ 1 + 入力欄 3 + 状態 1 +
 * フッタ 1）の上に、ログが数行見える分を足した値。これ未満で root の height を固定すると
 * クリップで入力欄やフッタが消えて操作不能になる。
 */
export const MIN_FULLSCREEN_ROWS = 12;

export function isFullscreenViewport(rows: number | undefined): boolean {
  return rows !== undefined && rows >= MIN_FULLSCREEN_ROWS;
}

/** 画面の移動先（タブ）。この段階で中身があるのは `chat` だけ。 */
export const TABS = [
  { id: 'chat', key: '1', label: '会話', command: 'chat' },
  { id: 'approvals', key: '2', label: '承認待ち', command: 'approvals' },
  { id: 'managers', key: '3', label: '委譲', command: 'managers' },
  { id: 'journal', key: '4', label: '日誌', command: 'journal' },
  { id: 'memory', key: '5', label: '記憶', command: 'memory' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

/** ヘッダ・タブ・フッタが各 1 行。 */
export const CHROME_ROWS = 3;

/** 入力欄が伸びる表示行数の上限（`text-buffer.ts` の `INPUT_MAX_ROWS` と同じ値）。 */
const COMPOSER_MAX_ROWS = 6;

export interface ChatLayout {
  /** ヘッダ・タブ・フッタを除いた本体の行数。 */
  bodyHeight: number;
  /** 会話ログの可視行数（≥ 1）。 */
  logHeight: number;
  /** 入力欄に描く表示行数（枠の上下は別に 2 行）。 */
  composerShown: number;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/**
 * 会話の画面の縦の割り付け。本体 = ログ + 状態 1 行 + 入力欄（枠 2 行 + 表示行）。
 * 入力欄は小さい端末でもログを 1 行は残す範囲でしか伸ばさない。インライン描画（小さい
 * 端末）では端末の行数が当てにならないので、最低限の高さを取る。
 */
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
