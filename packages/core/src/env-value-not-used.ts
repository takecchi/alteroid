import { writeStderrLine } from './dropped-record.js';

// 同じ変数・同じ値では1回だけ出す: 読みは担当（セッション）ごとに呼ばれるので、毎回出すと埋もれるため
const noted = new Set<string>();

/**
 * 環境変数に置かれた値を使わず、既定の値や範囲の端へ倒したときに stderr へ1行残す（#5976）。
 * 黙って倒さない: 人間は「置いたのに効いていない」ことに気づけないため。
 * 文の形は `attachment.ts` の環境変数の注意（`${name}="${raw}" は…既定 N を使う`）にそろえる。
 */
export function noteEnvValueNotUsed(name: string, raw: string, what: string): void {
  const key = `${name}\u0000${raw}`;
  if (noted.has(key)) return;
  noted.add(key);
  writeStderrLine(`alteroid: ${name}="${raw}" は${what}\n`);
}

/** 試験専用: 1回だけの記憶を消す。 */
export function resetEnvValueNotUsedForTesting(): void {
  noted.clear();
}
