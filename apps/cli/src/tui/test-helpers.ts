// 出所: takecchi/codiva（MIT）`tests/helpers.ts` の `FakeStdout` / `FakeStdin` / `renderFullscreen` / `waitFor` / `stripAnsi`
// ink-testing-library を使わない: fake stdout は rows を注入できず、実端末のサイズへフォールバックして非決定的になるため
import { EventEmitter } from 'node:events';

import { render } from 'ink';
import type { ReactElement } from 'react';

import { withModifyOtherKeysAsCsiU } from './input.js';

class FakeStdout extends EventEmitter {
  readonly frames: string[] = [];
  constructor(
    readonly rows: number,
    readonly columns: number,
  ) {
    super();
  }
  // 書き終わりの callback を呼ぶ: Ink は終了時に空の write の callback を待ってから waitUntilExit を解くため
  write = (frame: string, callback?: () => void): boolean => {
    this.frames.push(frame);
    callback?.();
    return true;
  };
}

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
    // runApp と同じく包む: 端末の符号が Ink へ届く形を本物と揃えるため
    stdin: withModifyOtherKeysAsCsiU(stdin as unknown as NodeJS.ReadStream),
    exitOnCtrlC: false,
    patchConsole: false,
    // debug を付ける: 非 TTY では debug なしだと途中のフレームが書き出されないため
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

// 時間切れで throw する: 成り立たないまま戻ると、後ろに `expect` を置かないテストが条件が偽のまま通るため
// 既定のタイムアウトは vitest の testTimeout（5s）より短くする: 「テストがタイムアウト」ではなく、何を待ったかの付いたエラーを出すため
export async function waitFor(
  predicate: () => boolean,
  { tickMs = 20, timeoutMs = 3_000, description }: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor: ${timeoutMs}ms 待ったが条件が成り立たなかった: ${description ?? predicate.toString()}`,
      );
    }
    await sleep(tickMs);
  }
}

export interface WaitOptions {
  tickMs?: number;
  timeoutMs?: number;
  description?: string;
}

export async function type(stdin: FakeStdin, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await sleep(2);
  }
}

// 少し譲る: 続けて打つキーが前のキーの処理を追い越さないように
export async function press(stdin: FakeStdin, key: string): Promise<void> {
  stdin.write(key);
  await sleep(2);
}
