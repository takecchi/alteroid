import { expect, it } from 'vitest';

import {
  noteDroppedRecord,
  setDefaultStderrSinkForTesting,
  setStderrSinkForTesting,
} from './dropped-record.js';

// 試験の準備（`vitest.quiet-traces.ts`）が跡を溜めるための口（#5001）。モジュールは試験のファイルごとに読み直されるので、ここで差し替えても他のファイルには響かない
it('既定の書き先を差し替えると跡はそこへ行き、一時的な差し替えを戻すと本物の標準エラーではなく既定の書き先へ戻る', () => {
  const kept: string[] = [];
  const captured: string[] = [];
  setDefaultStderrSinkForTesting((line) => {
    kept.push(line);
  });

  noteDroppedRecord('一つ目', '', new Error('a'));
  expect(kept).toHaveLength(1);

  // `captureStderr` と同じ形: 一時的に差し替えて、終われば null で戻す
  setStderrSinkForTesting((line) => {
    captured.push(line);
  });
  noteDroppedRecord('二つ目', '', new Error('b'));
  setStderrSinkForTesting(null);
  noteDroppedRecord('三つ目', '', new Error('c'));

  expect(captured).toHaveLength(1);
  expect(captured[0]).toContain('二つ目');
  expect(kept).toHaveLength(2);
  expect(kept[1]).toContain('三つ目');
});
