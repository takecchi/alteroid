import { describe, expect, it } from 'vitest';

import {
  expandedMethodBody,
  INLINED_BY_METHOD,
  readCloneSource,
} from './clone-source-scan.test-support.js';

// clone.ts の長いメソッドから、段を中身そのまま別のメソッドへ出していく。出す変更が壊しうるのは「中身をそのまま移したか」と「呼ぶ位置」だけである。
// そこでメソッドの本体を、出した先のメソッドの本体を呼び出しの位置へ差し戻した形で読み、まるごと固定する（差し戻しの表は `INLINED_BY_METHOD`）。
// 出す前は差し戻すものが無いので本体そのものになり、出した後は差し戻した形になって、どちらも同じ文字列になる。
// 文の並び・`await` の付き方・`continue` / `return` の位置も含めて縛るので、出さない段が動いても赤になる。
// 式の畳み方（コードの空白は畳み、コメントは落とし、文字列は1文字ずつ比べる）は `squash`。

/** 固定するメソッドと、走査の故障を通さないための目印（畳んだ形）。目印は差し戻した中身に必ず在る */
const MARKERS: Readonly<Record<string, readonly string[]>> = {
  '#pump': [
    'const timer = new TurnTimer(',
    "timer.add('prepare', Date.now() - prepareStartedAt);",
    'await this.#runHumanTurn(mergedHuman);',
    'await this.#writeTurnTiming(timer, this.#pumpTurnFailed);',
  ],
  '#restoreUnreadPass': [
    'this.#delivery.registerCollapseRepresentative(key, record.event.id, record.event.at);',
    'this.#delivery.setPendingTokenPoolNotice({',
    'this.#redeliveredLiveHeadline(liveRecordsThisPass, alone)',
    'await this.#journalRestoreUnreadPassEnd(decided, decided.length, {interrupted: false});',
  ],
  '#handleTimer': [
    'const outcome = await this.#runInternal(timerPrompt);',
    'this.#timerTurnRetries.set(event.kind, {at: event.at, attempts: attempts + 1});',
    'await this.#completeScheduledRun(event.kind, event.at, cause);',
  ],
  '#applyTurnEnded': [
    'const mainLoop = event.usage?.mainLoopUsage;',
    "await this.#noteUsageNotice(notice, turn?.conversationId ?? null, 'text');",
    'this.#usageBlocked = null;',
    "this.#emit(turn?.conversationId ?? null, {type: 'done'});",
  ],
};

/** 読みやすさのために、畳んだ1行を文の終わり（`;` の後ろの空白）で切って並べる。切り方は出す前と後で同じなので、比べる中身は変わらない。 */
function statements(squashed: string): string[] {
  return squashed.split(/(?<=;) /);
}

describe('clone.ts の長いメソッドの中身を、出した先を差し戻した形で固定する（段を別のメソッドへ出す前後で変わらないことの歯）', () => {
  it('差し戻しの表に載ったメソッドは、すべて固定の対象になっている', () => {
    expect(Object.keys(MARKERS).sort()).toEqual(Object.keys(INLINED_BY_METHOD).sort());
  });

  for (const [method, markers] of Object.entries(MARKERS)) {
    it(`${method}: 出した先を差し戻した中身が変わらない`, () => {
      expect(statements(expandedMethodBody(readCloneSource(), method))).toMatchSnapshot();
    });

    it(`${method}: 走査が本体を読めない状態（走査の故障）を通さない`, () => {
      const body = expandedMethodBody(readCloneSource(), method);
      for (const marker of markers) expect(body).toContain(marker);
      for (const { call } of INLINED_BY_METHOD[method] ?? []) expect(body).not.toContain(call);
    });
  }
});
