import { describe, expect, it } from 'vitest';

import {
  methodBody,
  readCloneSource,
  readGroup,
  squash,
} from './clone-source-scan.test-support.js';

// clone.ts の振り分けのメソッド（受信箱の1件を処理する `#handle`、SDK の出来事を受ける `#apply`）は、出来事の種類ごとの `case` が並ぶ形で、
// 長い `case` を種類ごとのメソッド（`#handleTimer` など）へ出していく。出す変更が壊しうるのは「中身をそのまま移したか」だけである
// （どの `case` も `return` で終わり、`break` で switch の後ろへ落ちないので、`case 'x': return this.#handleX(event);` にすれば意味は変わらない）。
// そこで、各 `case` の中身を種類ごとに取り出して固定する。中身が `return this.#name(event);` の1文だけなら、そのメソッドの本体を代わりに取り出すので、
// 出す前と出した後は同じ文字列になる。式の畳み方（コードの空白は畳み、コメントは落とし、文字列は1文字ずつ比べる）は `squash`。

const DISPATCHERS = ['#handle', '#apply'] as const;

/** 振り分けのメソッドの、最初の `switch (event.type) {` の中を返す。 */
function switchBody(text: string, dispatcher: string): string {
  const body = methodBody(text, dispatcher);
  const head = /switch \(event\.type\) \{/.exec(body);
  if (head === null) throw new Error(`${dispatcher} に switch (event.type) が無い`);
  const open = head.index + head[0].length - 1;
  const close = readGroup(body, open).close;
  return body.slice(open + 1, close);
}

/** 種類ごとの中身を、出てくる順に「種類: 中身」で返す。中括弧の無い `case`（素通りの並び）と `default` も残す。 */
function dispatchCases(text: string, dispatcher: string): string[] {
  const body = switchBody(text, dispatcher);
  const out: string[] = [];
  // ラベルの後ろの空白は同じ行の中だけを読む: 中括弧の無い case が続く並び（`case 'a':` の次の行が `case 'b':`）で、次の行の頭を食わないため
  const labelRe = /\n\s*(?:case '([a-z_]+)'|default):[ \t]*(\{)?/g;
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(body)) !== null) {
    const label = m[1] ?? 'default';
    if (m[2] === undefined) {
      out.push(`${label}: （中括弧なし）`);
      continue;
    }
    const open = m.index + m[0].length - 1;
    const close = readGroup(body, open).close;
    let inner = squash(body.slice(open + 1, close));
    const delegated = /^return this\.(#[A-Za-z]+)\(event\);$/.exec(inner);
    if (delegated !== null) inner = squash(methodBody(text, delegated[1]!));
    out.push(`${label}: ${inner}`);
    labelRe.lastIndex = close;
  }
  return out;
}

describe('clone.ts の振り分け（#handle・#apply）の各 case の中身を固定する（種類ごとのメソッドへ出す前後で変わらないことの歯）', () => {
  for (const dispatcher of DISPATCHERS) {
    it(`${dispatcher}: 種類ごとの中身が変わらない`, () => {
      expect(dispatchCases(readCloneSource(), dispatcher)).toMatchSnapshot();
    });
  }

  it('走査が case を見つけられない状態（走査の故障）を通さない', () => {
    const text = readCloneSource();
    expect(dispatchCases(text, '#handle').length).toBeGreaterThanOrEqual(7);
    expect(dispatchCases(text, '#apply').length).toBeGreaterThanOrEqual(15);
  });
});
