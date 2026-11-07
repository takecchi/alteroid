// 空文字や省略で表さない: 読めなかったことを黙って落とすと、監査の穴が「何も起きなかった」と同じ見え方になるため
// `clone-tool-use-journal.ts`（道具の呼びの日誌）と `clone-denial-journal.ts`（拒否の記録）の両方が使うので、どちらにも置かずここへ出した
export const UNKNOWN_TOOL_NAME = '(不明な道具)';
export const UNKNOWN_AGENT_TYPE = '(不明)';
