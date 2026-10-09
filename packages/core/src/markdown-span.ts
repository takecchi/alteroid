/**
 * `text` を Markdown のインラインコードとして包む。中身は字面のまま残る。
 *
 * `markup` 印は立てない: 連結済みの文字列には名乗れる値が無いので、連結する側が埋め込む前に包む。
 * SDK の prose は包まない: 等幅の「コード」として描かれてしまい、表示の方針の話になるから。
 *
 * 空文字は包まない: 「空のコード」という無い事実を描くことになるので、そのまま返す。
 *
 * 改行を含む文字列は扱わない: インラインコードは改行を空白へ潰すので字面が保たれない。
 * 今の呼び出し元は生の改行を含まないため、検出も置換もしない。
 */
export function codeSpan(text: string): string {
  if (text === '') return '';

  const runs = text.match(/`+/g);
  const longest = runs === null ? 0 : Math.max(...runs.map((run) => run.length));
  const fence = '`'.repeat(longest + 1);

  // 端が空白かバッククォートなら内側へ空白を足す: 足さないとバッククォートは包みと繋がり、
  // 空白は CommonMark の「両端の空白を1つずつ除く」で中身のほうが削られる。
  const padded = /^[ `]/.test(text) || /[ `]$/.test(text);
  const pad = padded ? ' ' : '';

  return `${fence}${pad}${text}${pad}${fence}`;
}
