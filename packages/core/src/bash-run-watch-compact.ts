// `gh run watch` は非 TTY では更新のたびに全ジョブ・全ステップを描き直し、1本が 10〜19K 文字になる（#5322）。
// `--compact`（実行中・失敗のステップだけ）を足して結果を小さくする。弾かず書き換える: 弾くと往復が1回増えるうえ、打った側の能力は何も増えないため。
// 単純な1コマンドだけを書き換える（`timeout <秒>` の前置き + `gh run watch ...`）: 引用符・`;`・`&`・`|`・`$`・改行を含む形は、`--compact` を入れる位置を誤ると別の語（コミットメッセージ・文字列）を書き換えうるので触らず、そのまま通す（書き換えは便宜であって安全弁ではない）
// `--compact` を持たない古い `gh` では `unknown flag` で落ちる（黙って成功には倒れない）。落ちたら `--compact` を付けて打ち直せばよいが、その版では打ち直しでも同じなので、器の `gh` の版を上げること

const RUN_WATCH_COMPACT_RE =
  /^(?<head>[ \t]*(?:timeout[ \t]+(?:-\S+[ \t]+)*(?:\d\S*[ \t]+)+)?gh[ \t]+run[ \t]+watch)(?<rest>(?:[ \t][^\s;&|<>$`'"()\\]+)*[ \t]*)$/;

const COMPACT_FLAG_RE = /(?:^|[ \t])--compact(?:[ \t]|$)/;

export interface RunWatchCompactRewrite {
  readonly command: string;
}

export function planRunWatchCompact(toolInput: {
  readonly command?: unknown;
  readonly run_in_background?: unknown;
}): RunWatchCompactRewrite | undefined {
  if (typeof toolInput.command !== 'string') return undefined;
  // 背景に置く形は待ちの歯が断る形で、書き換える意味が無い
  if (toolInput.run_in_background === true) return undefined;
  const match = RUN_WATCH_COMPACT_RE.exec(toolInput.command);
  if (match?.groups === undefined) return undefined;
  const { head = '', rest = '' } = match.groups;
  if (COMPACT_FLAG_RE.test(rest)) return undefined;
  return { command: `${head} --compact${rest}` };
}

export const RUN_WATCH_COMPACT_NOTE =
  '`gh run watch` に `--compact` を足した（実行中・失敗のステップだけを出し、既出の行の再掲を減らす。#5322）。' +
  '全ステップは `gh run view <id>`、失敗の全文は `gh run view <id> --log-failed` で引ける。';
