// 道具のファイル（`clone-tools-common.ts`・`clone-tools-context.ts`）がまだ import している型だけを残す。
// 計器の本体（日誌への書き込み・間引き・ラベル）は外した。道具側の呼びを外す次の PR で、この型とファイルも消す。

/** handler が `extra._meta['claudecode/toolUseId']` をどう読めたか。値は持たない。 */
export type ToolUseIdProbe = 'present' | 'missing' | 'wrongType';
