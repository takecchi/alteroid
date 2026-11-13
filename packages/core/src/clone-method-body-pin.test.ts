import { describe, expect, it } from 'vitest';

import {
  expandedMethodBody,
  INLINED_BY_FILE,
  readSource,
  type ScannedSource,
} from './clone-source-scan.test-support.js';

// 長いメソッド・関数から、段を中身そのまま別のメソッド・関数へ出していく。出す変更が壊しうるのは「中身をそのまま移したか」と「呼ぶ位置」だけである。
// そこで本体を、出した先の本体を呼び出しの位置へ差し戻した形で読み、まるごと固定する（差し戻しの表は `INLINED_BY_FILE`）。
// 出す前は差し戻すものが無いので本体そのものになり、出した後は差し戻した形になって、どちらも同じ文字列になる。
// 文の並び・`await` の付き方・`continue` / `return` の位置も含めて縛るので、出さない段が動いても赤になる。
// 式の畳み方（コードの空白は畳み、コメントは落とし、文字列は1文字ずつ比べる）は `squash`。

/** ファイル → 固定するメソッド・関数 → 走査の故障を通さないための目印（畳んだ形）。目印は差し戻した中身に必ず在る */
const MARKERS: Readonly<Record<ScannedSource, Readonly<Record<string, readonly string[]>>>> = {
  'clone.ts': {
    '#pump': [
      'const timer = new TurnTimer(',
      "timer.add('prepare', Date.now() - prepareStartedAt);",
      'await run();',
      'await this.#writeTurnTiming(timer, this.#pumpTurnFailed);',
    ],
    // まとめ読みの選択と配り分け。`run` は選んだ束の変数を閉じ込めるアローなので、`#pump` へ差し戻せない。出した先を別のメソッドの中身として固定する
    '#chooseBatch': [
      "this.#notices.set('mergedBatchTruncation', '');",
      'const mergedHuman = this.#batchMerge.mergedHumanBatch(event);',
      'this.#batchMerge.extendReportBatchToMixed(sameManagerReports)',
      'return this.#runHumanTurn(mergedHuman);',
      'return {batch, run};',
    ],
    '#restoreUnreadPass': [
      'this.#delivery.registerCollapseRepresentative(key, record.event.id, record.event.at);',
      'this.#delivery.setPendingTokenPoolNotice({',
      'redeliveredLiveHeadline(liveRecordsThisPass, alone, this.#restoredCohort)',
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
  },
  'manager.ts': {},
  'runner.ts': {
    '#applyTurnEnded': [
      "this.#emit({type: 'context_usage', managerId: this.#id,",
      'this.#markProgressed();',
      'answered: failure === undefined',
      'this.#wakeForFinishedBackgroundTaskOutputs();',
    ],
  },
  'digest.ts': {
    buildActivityDigest: [
      "sections.push('', '## 聞かずに決めたこと');",
      "sections.push('', '## 人間の回答待ち（保留中。他の仕事は進めてよい）');",
      "sections.push('', '## 記憶の更新');",
      "sections.push('', '## 届いた外部イベント');",
      "sections.push('', ...(await usageSection(stores, window.since, until)));",
    ],
  },
};

/** 試験の名前。clone.ts の分は、ファイル名を付ける前の名前のまま（スナップショットの名前を変えないため）。 */
function titleOf(file: ScannedSource, method: string): string {
  return file === 'clone.ts' ? method : `${file} ${method}`;
}

/** 読みやすさのために、畳んだ1行を文の終わり（`;` の後ろの空白）で切って並べる。切り方は出す前と後で同じなので、比べる中身は変わらない。 */
function statements(squashed: string): string[] {
  return squashed.split(/(?<=;) /);
}

const PINNED = (Object.keys(MARKERS) as ScannedSource[]).flatMap((file) =>
  Object.entries(MARKERS[file]).map(([method, markers]) => ({ file, method, markers })),
);

describe('clone.ts の長いメソッドの中身を、出した先を差し戻した形で固定する（段を別のメソッドへ出す前後で変わらないことの歯）', () => {
  it('差し戻しの表に載ったメソッドは、すべて固定の対象になっている', () => {
    for (const file of Object.keys(MARKERS) as ScannedSource[]) {
      expect(Object.keys(MARKERS[file]).sort(), file).toEqual(
        Object.keys(INLINED_BY_FILE[file]).sort(),
      );
    }
  });

  for (const { file, method, markers } of PINNED) {
    it(`${titleOf(file, method)}: 出した先を差し戻した中身が変わらない`, () => {
      expect(statements(expandedMethodBody(readSource(file), method, file))).toMatchSnapshot();
    });

    it(`${titleOf(file, method)}: 走査が本体を読めない状態（走査の故障）を通さない`, () => {
      const body = expandedMethodBody(readSource(file), method, file);
      for (const marker of markers) expect(body).toContain(marker);
      for (const { call } of INLINED_BY_FILE[file][method] ?? []) {
        expect(body).not.toContain(call);
      }
    });
  }
});
