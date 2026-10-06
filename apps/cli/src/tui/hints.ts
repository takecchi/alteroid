/** フッタ 1 行のキーヒント。80 桁の端末に収まる長さにする（`hints.test.ts` が見ている）。 */
export const HINT_INPUT =
  'Enter 送信 · \\+Enter 改行 · Esc 移動 · PgUp/Dn 遡る · /help · ^C 中断 · ^D 終了';
export const HINT_NAV =
  '1-5 画面 · Tab/i 入力へ · ↑↓ PgUp/PgDn 遡る · / コマンド · ^C 中断 · ^D 終了';
export const HINT_PICKER = '↑↓ 選択 · Enter 開く · Esc 戻る · ^C 中断';
export const HINT_QUITTING = '終了しています（会話を終えて学びを記憶へ蒸留している）…';
export const HINT_MGR_LIST =
  '↑↓ 選択 · Enter 詳細 · f 絞り · m 古い側 · r 更新 · 1-5 画面 · / コマンド';
export const HINT_MGR_DETAIL =
  'Esc 一覧へ · i 指示を送る · s 止める · ↑↓ PgUp/PgDn 遡る · r 更新 · 1-5 画面';
export const HINT_MGR_INPUT =
  'Enter 送信 · \\+Enter 改行 · Esc 抜ける · /help · ^C 中断（クローン） · ^D 終了';
export const HINT_MGR_CONFIRM = 'y 止める · それ以外のキーでやめる';
export const HINT_JOURNAL_LIST =
  '↑↓ 選ぶ · Enter 全文 · f 種別 · n 最新 · m 古い · r 更新 · 1-5 画面 · / コマンド';
export const HINT_JOURNAL_DETAIL = 'Esc 一覧へ · ↑↓ PgUp/PgDn 読み進める · 1-5 画面 · / コマンド';
export const HINT_JOURNAL_FILTER = '↑↓ 選ぶ · Space 切替 · Enter 適用 · c 全部外す · Esc やめる';
export const HINT_MEM_LIST =
  '↑↓ 選ぶ · Enter 開く（読むだけ） · r 更新 · 1-5 画面 · / コマンド · ^C 中断';
export const HINT_MEM_DETAIL = 'Esc 一覧へ · ↑↓ PgUp/PgDn 読み進める · r 更新 · 1-5 画面';
export const HINT_AP_LIST = '↑↓ 選ぶ · Enter 詳細 · d 回答済み · r 更新 · 1-5 画面 · / コマンド';
export const HINT_AP_DATES =
  '↑↓ 選ぶ · Enter その日の件 · m 古い日を読む · Esc 未回答へ · r 更新 · 1-5 画面';
export const HINT_AP_DAY = '↑↓ 選ぶ · Enter 詳細 · Esc 日付へ · r 更新 · 1-5 画面';
export const HINT_AP_DETAIL = 'Esc 一覧へ · a 答える · ↑↓ PgUp/PgDn 読み進める · r 更新 · 1-5 画面';
/** その日の件（回答済み）から開いた詳細。Esc は未回答の一覧ではなくその日へ戻る。 */
export const HINT_AP_DETAIL_FROM_DAY =
  'Esc その日へ · a 答える · ↑↓ PgUp/PgDn 読み進める · r 更新 · 1-5 画面';
/** 詳細の読む画面の案内（開いた元で Esc の戻り先が違う）。 */
export const approvalDetailHint = (from: 'list' | 'day'): string =>
  from === 'day' ? HINT_AP_DETAIL_FROM_DAY : HINT_AP_DETAIL;
export const HINT_AP_FORM =
  '↑↓ 移動 · Space 選ぶ/書く · s 送る前の確認 · Esc 読む画面へ（書きかけは残る）';
export const HINT_AP_INPUT = 'Enter 確定 · Esc 確定して戻る · ^C 中断（クローン） · ^D 終了';
export const HINT_AP_CONFIRM = 'y 送る · それ以外のキーで戻る';
