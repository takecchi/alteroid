import { describe, expect, it } from 'vitest';

import { methodBody, readCloneSource, squash } from './clone-source-scan.test-support.js';

// clone.ts の受信箱のループ `#pump` は、1件ごとの判断（枠の保持・畳み・束の決め方・実行の分岐）の間に、
// ターンの前の組み立て（時計と断り書き）と、ターンの後始末（`finally` の中身）が挟まる形で長い。
// この2つを `#prepareTurn`・`#settleTurn` へ中身そのまま出すときに壊しうるのは「中身をそのまま移したか」と「呼ぶ位置」だけである。
// そこで `#pump` の本体を、出した先のメソッドの本体を呼び出しの位置へ差し戻した形で読み、まるごと固定する。
// 出す前は差し戻すものが無いので本体そのものになり、出した後は差し戻した形になって、どちらも同じ文字列になる。
// 文の並び・`await` の付き方・`continue` の位置も含めて縛るので、A〜G の段（出さない段）が動いても赤になる。
// 式の畳み方（コードの空白は畳み、コメントは落とし、文字列は1文字ずつ比べる）は `squash`。

/** 出した先のメソッドと、`#pump` の中でそれを呼ぶ1文（畳んだ形）。`trailing` は出した先の末尾に足した1文で、差し戻すときに外す。 */
const INLINED = [
  {
    name: '#prepareTurn',
    call: 'const timer = await this.#prepareTurn(event, batch);',
    trailing: ' return timer;',
  },
  { name: '#settleTurn', call: 'await this.#settleTurn(batch, timer);', trailing: '' },
] as const;

/** `#pump` の本体を、出した先の本体を差し戻して畳んだもの。 */
function expandedPump(text: string): string {
  let pump = squash(methodBody(text, '#pump'));
  for (const { name, call, trailing } of INLINED) {
    const at = pump.indexOf(call);
    if (at === -1) continue;
    if (pump.indexOf(call, at + 1) !== -1) throw new Error(`${call} が2回ある`);
    let inner = squash(methodBody(text, name));
    if (trailing !== '') {
      if (!inner.endsWith(trailing)) throw new Error(`${name} の末尾が ${trailing.trim()} でない`);
      inner = inner.slice(0, -trailing.length);
    }
    pump = pump.slice(0, at) + inner + pump.slice(at + call.length);
  }
  return pump;
}

/** 読みやすさのために、畳んだ1行を文の終わり（`;` の後ろの空白）で切って並べる。切り方は出す前と後で同じなので、比べる中身は変わらない。 */
function statements(squashed: string): string[] {
  return squashed.split(/(?<=;) /);
}

describe('clone.ts の受信箱のループ（#pump）の中身を固定する（ターンの前の組み立てと後始末を出す前後で変わらないことの歯）', () => {
  it('#pump: 出した先を差し戻した中身が変わらない', () => {
    expect(statements(expandedPump(readCloneSource()))).toMatchSnapshot();
  });

  it('走査が本体を読めない状態（走査の故障）を通さない', () => {
    const pump = expandedPump(readCloneSource());
    // 段の目印: 時計の作成・前の組み立ての最後・実行の分岐・後始末の最後
    for (const marker of [
      'const timer = new TurnTimer(',
      "timer.add('prepare', Date.now() - prepareStartedAt);",
      'await this.#runHumanTurn(mergedHuman);',
      'await this.#writeTurnTiming(timer, this.#pumpTurnFailed);',
    ]) {
      expect(pump).toContain(marker);
    }
    for (const { call } of INLINED) expect(pump).not.toContain(call);
  });
});
