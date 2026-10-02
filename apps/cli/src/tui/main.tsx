/**
 * TUI の本体（`launch.ts` が `NODE_ENV` を整えてから動的 import する。ここを static import
 * しないこと — react の評価が NODE_ENV の代入より先に走る）。
 */
import { render } from 'ink';

import { resolveTarget } from '../target.js';
import { createTuiApi, type TuiApi } from './api.js';
import { App } from './app.js';
import { ChatController } from './chat-controller.js';
import { HeaderFeed } from './header-feed.js';
import { JournalController } from './journal-controller.js';
import { isFullscreenViewport } from './layout.js';
import { ManagersController } from './managers-controller.js';
import { MemoryController } from './memory-controller.js';
import { enterAltScreen, installCrashRestore, resetTerminalModes } from './terminal.js';

export interface TuiIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

/**
 * TTY での起動。**接続と認証は既存の `resolveTarget()` をそのまま通す**（ローカルは
 * デーモンを起こし、`ALTEROID_URL` ならログイン済みの資格を使う）。未ログイン
 * （`note` が非 null）なら TUI を開かずに案内を出して終わる — `alteroid chat` と同じ。
 */
export async function runTui(io: TuiIo = process): Promise<void> {
  if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) {
    // 端末でなければ描けない（rawMode も使えない）。デーモンを起こす前に断る。
    throw new Error(
      'alteroid tui は端末（TTY）でだけ動きます。スクリプトからは alteroid のサブコマンドを使ってください',
    );
  }
  const target = await resolveTarget();
  if (target.note !== null) {
    io.stdout.write(`${target.note}\n`);
    return;
  }
  await runApp(createTuiApi(target), io);
}

/** 画面を張って、終了まで待つ。端末の状態は正常終了でも例外でも戻す。 */
export async function runApp(api: TuiApi, io: TuiIo): Promise<void> {
  const fullscreen = isFullscreenViewport(io.stdout.rows);
  // 前回の強制終了で端末にモードが残っていても、ここで一度まっさらにする。
  const leaveAlt = fullscreen ? enterAltScreen(io.stdout) : () => undefined;
  const restore = (): void => {
    leaveAlt();
    resetTerminalModes(io.stdout);
  };
  const uninstall = installCrashRestore(restore, io.stderr);
  const controller = new ChatController(api);
  const feed = new HeaderFeed(api);
  const managers = new ManagersController(api);
  managers.attach(feed);
  // 日誌と記憶も、ヘッダが張っている 1 本の SSE を共有する（2 本目は張らない）。
  const journal = new JournalController(api);
  journal.attach(feed);
  const memory = new MemoryController(api);
  memory.attach(feed);
  feed.start();
  try {
    const instance = render(
      <App
        api={api}
        controller={controller}
        feed={feed}
        managers={managers}
        journal={journal}
        memory={memory}
        fullscreen={fullscreen}
      />,
      {
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
        // Ctrl+C は終了ではなく中断に使う。
        exitOnCtrlC: false,
        // TTY であることはここまでで確かめてある。`CI=true` の環境（コンテナの既定など）でも、
        // Ink に非対話扱い（最後のフレームしか書かない）へ倒させない。
        interactive: true,
      },
    );
    await instance.waitUntilExit();
  } finally {
    managers.dispose();
    journal.dispose();
    memory.dispose();
    feed.stop();
    restore();
    uninstall();
  }
}
