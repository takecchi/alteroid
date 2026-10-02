/**
 * 全画面のテストの足場。出所: takecchi/codiva（MIT）`tests/helpers.ts` の
 * `FakeStdout` / `FakeStdin` / `renderFullscreen` / `waitFor` / `stripAnsi`。
 *
 * ink-testing-library の fake stdout は rows を注入できない（実端末のサイズへフォール
 * バックして非決定的になる）ので、Ink 本体の `render` に寸法固定のストリームを渡す。
 */
import { EventEmitter } from 'node:events';

import { render } from 'ink';
import type { ReactElement } from 'react';

class FakeStdout extends EventEmitter {
  readonly frames: string[] = [];
  constructor(
    readonly rows: number,
    readonly columns: number,
  ) {
    super();
  }
  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
}

/** ink-testing-library の Stdin と同じ挙動（write → 'readable' / 'data' を emit）。 */
export class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string): void => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const value = this.data;
    this.data = null;
    return value;
  };
}

export function renderFullscreen(element: ReactElement, rows = 24, columns = 80) {
  const stdout = new FakeStdout(rows, columns);
  const stdin = new FakeStdin();
  const app = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
    // 非 TTY では debug なしだと途中のフレームが書き出されない。
    debug: true,
  });
  return { app, stdin, stdout, lastFrame: () => stripAnsi(stdout.frames.at(-1) ?? '') };
}

const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');

export function stripAnsi(frame: string): string {
  return frame.replace(SGR, '').replace(CSI, '');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 出るはずのものが出るまで待つ。固定の待ちは遅い環境で負けるので、条件が成り立ったら
 * すぐ返る。既定のタイムアウトは vitest の testTimeout（5s）より短くする（成り立たないとき
 * 「テストがタイムアウト」ではなく、待ったあとの expect の差分が出る）。
 */
export async function waitFor(
  predicate: () => boolean,
  { tickMs = 20, timeoutMs = 3_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(tickMs);
}

/** 1 文字ずつ打つ（IME の確定や貼り付けではなく、キー入力として届く形）。 */
export async function type(stdin: FakeStdin, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await sleep(2);
  }
}
