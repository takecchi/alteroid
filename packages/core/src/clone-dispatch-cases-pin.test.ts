import { describe, expect, it } from 'vitest';

import {
  expandedMethodBody,
  methodBody,
  readGroup,
  readSource,
  type ScannedSource,
  squash,
} from './clone-source-scan.test-support.js';

// 振り分けのメソッド（clone.ts の受信箱の1件を処理する `#handle`・SDK の出来事を受ける `#apply`、
// manager.ts の担当の出来事を受ける `Pool.#handleEvent`、runner.ts の SDK の出来事を受ける `RunnerSession.#apply`）は、
// 出来事の種類ごとの `case` が並ぶ形で、長い `case` を種類ごとのメソッド（`#handleTimer` など）へ出していく。出す変更が壊しうるのは「中身をそのまま移したか」だけである
// （どの `case` も `return` で終わり、`break` で switch の後ろへ落ちないので、`case 'x': return this.#handleX(event);` にすれば意味は変わらない）。
// そこで、各 `case` の中身を種類ごとに取り出して固定する。中身が `return this.#name(event, …);` の1文だけなら、そのメソッドの本体を代わりに取り出すので、
// 出す前と出した後は同じ文字列になる。引数は `event` で始まり、残りは名前だけ（`record`・`fromRunnerId` など、出す前の case が使っていた変数をそのまま渡す）。
// `await` を含まない case は、同期のメソッドへ出して `this.#name(event, …); return;` の2文で呼ぶ形も読む: async のメソッドへ出して `return` すると、
// 振り分けの Promise が解決するまでのマイクロタスクが増え、それに頼る道（runner.ts の `#read` の後ろの偽の SDK の試験など）の前後が変わるため。
// 出した先の本体は元の case の中身そのもの（末尾の `return;` を含む）なので、呼び出しの2文を本体に置き換えれば、やはり同じ文字列になる。
// 式の畳み方（コードの空白は畳み、コメントは落とし、文字列は1文字ずつ比べる）は `squash`。

/** 固定する振り分けと、走査の故障を通さないための case の数の下限。 */
const DISPATCHERS: readonly {
  readonly file: ScannedSource;
  readonly method: string;
  readonly minCases: number;
}[] = [
  { file: 'clone.ts', method: '#handle', minCases: 7 },
  { file: 'clone.ts', method: '#apply', minCases: 15 },
  { file: 'manager.ts', method: '#handleEvent', minCases: 26 },
  { file: 'runner.ts', method: '#apply', minCases: 15 },
];

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
function dispatchCases(file: ScannedSource, dispatcher: string): string[] {
  const text = readSource(file);
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
    const delegated = /^return this\.(#[A-Za-z]+)\(event(?:, [A-Za-z]+)*\);$/.exec(inner);
    // 出した先のメソッドから、さらに段を出していれば差し戻して読む（`INLINED_BY_FILE`）: 振り分けの固定が、その分割で動かないため
    if (delegated !== null) inner = expandedMethodBody(text, delegated[1]!, file);
    // 同期の形は、出した先の本体が `return;` で終わるときだけ差し戻す: 元からある `this.#onTaskStarted(event); return;` のような
    // 下請けの呼び出し（case の中身を移したものではなく、本体が `return;` で終わらない）まで読み替えないため
    const delegatedSync = /^this\.(#[A-Za-z]+)\(event(?:, [A-Za-z]+)*\); return;$/.exec(inner);
    if (delegatedSync !== null) {
      const moved = expandedMethodBody(text, delegatedSync[1]!, file);
      if (moved.endsWith('return;')) inner = moved;
    }
    out.push(`${label}: ${inner}`);
    labelRe.lastIndex = close;
  }
  return out;
}

/** 試験の名前。clone.ts の分は、ファイル名を付ける前の名前のまま（スナップショットの名前を変えないため）。 */
function titleOf(file: ScannedSource, method: string): string {
  return file === 'clone.ts' ? method : `${file} ${method}`;
}

describe('clone.ts の振り分け（#handle・#apply）の各 case の中身を固定する（種類ごとのメソッドへ出す前後で変わらないことの歯）', () => {
  for (const { file, method } of DISPATCHERS) {
    it(`${titleOf(file, method)}: 種類ごとの中身が変わらない`, () => {
      expect(dispatchCases(file, method)).toMatchSnapshot();
    });
  }

  it('走査が case を見つけられない状態（走査の故障）を通さない', () => {
    for (const { file, method, minCases } of DISPATCHERS) {
      expect(dispatchCases(file, method).length, titleOf(file, method)).toBeGreaterThanOrEqual(
        minCases,
      );
    }
  });
});
