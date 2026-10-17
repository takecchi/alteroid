import { beforeEach } from 'vitest';

import {
  setDefaultStderrSinkForTesting,
  writeStderrSync,
} from './packages/core/src/dropped-record.js';

// packages/core の跡の行（`alteroid: …記録できませんでした` 等）を、試験ごとに溜め、落ちた試験の分だけ本物の標準エラーへ吐き出す（#5001）。
// 跡は `fs.writeSync(2, …)` で書かれ、vitest が拾えず `--silent` でも止まらないので、通った試験の分が数百行も出て、落ちた試験の名前と理由が出力の中で切れて見えなくなっていた。
// 消さずに溜める: 落ちた試験では、どの記録が書けなかったかが理由を追う手がかりになるため。
// 跡の帳面（`rememberTrace`）には今どおり積まれる（書き先の手前で積むため）。`captureStderr` で跡を観測する試験は、今どおり自分の書き先へ差し替えて、終われば下の溜める書き先へ戻る。
// core を dist から読むほかのパッケージには届かない（別のモジュールになる）。届かなくても今どおり書かれるだけで、壊れはしない。
let traces: string[] = [];

setDefaultStderrSinkForTesting((line) => {
  traces.push(line);
});

// 消すのは試験の頭だけにする（`afterEach` で消さない）: `onTestFailed` は `afterEach` の後に呼ばれるので、先に消すと落ちた試験の跡が失われるため。
// 試験の外（読み込み・`beforeAll`）で書かれた跡は、次の試験の頭で捨てる。
beforeEach(({ onTestFailed }) => {
  traces = [];
  onTestFailed(() => {
    for (const line of traces) writeStderrSync(line);
    traces = [];
  });
});
