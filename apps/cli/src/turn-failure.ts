export type TurnFailureKind = 'auth' | 'quota' | 'other';

// chat（端末）と TUI が共有する1行の案内: 画面ごとに言い方がずれないため
const TURN_FAILURE_HINT: Readonly<Record<'auth' | 'quota', string>> = {
  auth: 'クローンの認証が通りません。認証トークンが登録されているか確かめてください。',
  quota: '利用上限に当たっています。上限が開いたあとに、もう一度送ってください。',
};

// 文面から読み替えない・知らない値や無い値は `other` 扱い: 古いデーモンは種別を付けず、本文の語は別の失敗でもありうるため
export function turnFailureHint(kind: unknown): string | null {
  return kind === 'auth' || kind === 'quota' ? TURN_FAILURE_HINT[kind] : null;
}
