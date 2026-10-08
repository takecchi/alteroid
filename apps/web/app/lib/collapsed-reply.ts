/**
 * 繰り返しの崩壊を切り詰めて履歴へ書いた返信を、受信中に積んだ行へも反映する（#4142）。
 *
 * 流れた `text` は取り戻せないので、受信行には崩壊した本文が載っている。履歴の行は切り詰めた形で、
 * 本文の一致で引き取る（`pendingOwnLines`）と合わなくなり、同じ返信が二重に出る。`done` が運ぶ
 * `collapsed`（`from` = 流した本文、`to` = 履歴に載った形）で、受信行の側を履歴と同じ本文へ置き換える。
 */
export interface ReplyLineLike {
  role: string;
  text: string;
  replyGroup?: string | undefined;
}

export interface CollapsedPart {
  from: string;
  to: string;
}

/**
 * `group` の返信行（連続した行の連結が `from` に一致するもの）を `to` の1行へ置き換える。
 * 一致しなければ何もしない（置き換えられなくても、履歴は切り詰めた形で読める）。
 */
export function applyCollapsedReplies<T extends ReplyLineLike>(
  lines: T[],
  group: string,
  collapsed: readonly CollapsedPart[],
): T[] {
  let result = lines;
  for (const part of collapsed) {
    const members = result
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.role === 'clone' && line.replyGroup === group);
    let replaced = false;
    for (let start = 0; start < members.length && !replaced; start += 1) {
      let joined = '';
      for (let end = start; end < members.length; end += 1) {
        const member = members[end];
        if (member === undefined) break;
        joined += member.line.text;
        if (joined === part.from) {
          const first = members[start];
          if (first === undefined) break;
          const drop = new Set(members.slice(start + 1, end + 1).map((m) => m.index));
          result = result.flatMap((line, index) =>
            index === first.index ? [{ ...line, text: part.to }] : drop.has(index) ? [] : [line],
          );
          replaced = true;
          break;
        }
        if (joined.length > part.from.length) break;
      }
    }
  }
  return result;
}
