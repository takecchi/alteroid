// まとめて消す／閉じる 3 道具（`task_set_status_many`・`inbox_remove_many`・`archive_remove_many`）が共有する定数の唯一の定義。
// 3 道具の公開名（`CLOSE_MANY_*`・`REMOVE_MANY_*`・`ARCHIVE_REMOVE_MANY_*`）は、ここの値を指す再 export である。
// 葉に保つ（他のファイルを import しない）: CLI が `cli-light.ts` 経由で読むため。`tools.ts` へ統合しない: CLI が定数のために SDK・zod を評価してしまう。
export const REMOVE_MANY_LIMIT_DEFAULT = 500;
// store 側に同じ上限を置いて二重にしない: どちらが効いたのか呼び出し側から読めなくなるため
export const REMOVE_MANY_LIMIT_MAX = 2_000;
// id 列は件数ではなく文字数の予算で塊に割り、塊ごとに1件の日誌を書く: 全件を1行へ詰めると予算が文字数という面の規約に反するため
export const REMOVE_MANY_JOURNAL_ID_CHARS = 3_600;
// 応答に並べる id の数。これを超えた分は件数だけ言う
export const REMOVE_MANY_IDS_SHOWN = 20;
// 0 件の理由に並べる送信元の数
export const REMOVE_MANY_SOURCES_SHOWN = 8;
