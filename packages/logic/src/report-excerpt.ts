/**
 * 日報の本文（Markdown）から、一覧・小さなカードに出す**平文の抜粋**を作る。
 *
 * 一覧の1行は Markdown 化の対象外（`line-clamp` の内側へブロック要素を入れると畳み方が効かなく
 * なる。`packages/ui/src/components/markdown.tsx` の doc）。かといって生の本文を出すと
 * `##` や `**` がそのまま見える。だから**行頭の記法と強調の記号だけを落として**1行に並べる。
 * 意味を要約し直さない・言い換えない（本文の語をそのまま使う）。
 *
 * **切ったら末尾に `…` を付ける**（切ったことが消えない。全文は日報のページ）。切る位置は
 * サロゲートペアを割らない。伏せ字は掛けない——**描画の直前に呼び手が掛ける**
 * （`redactBody`。このファイルは自由文を加工するだけで、秘密を知らない）。
 */
export function reportExcerpt(body: string, limit = 160): string {
  const lines = body
    .split(/\r\n|\n|\r/)
    .map((line) =>
      line
        .trim()
        // 行頭の記法: 見出し・引用・箇条書き・番号つき・タスク
        .replace(/^(#{1,6}|>+|[-*+]|\d+[.)])\s+/, '')
        .replace(/^\[[ xX]\]\s+/, '')
        // 強調・取り消し・インラインコードの記号
        .replace(/(\*\*|__|~~|`)/g, '')
        // リンクは文字だけ残す
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .trim(),
    )
    // 区切り線・コードフェンスだけの行は落とす
    .filter((line) => line.length > 0 && !/^(-{3,}|\*{3,}|_{3,})$/.test(line));
  const text = lines.join(' ');
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  return `${chars.slice(0, limit).join('')}…`;
}
