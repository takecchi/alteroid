// static import しない: react の評価が `NODE_ENV` の代入より先に走るため
import { render } from 'ink';

import { resolveTarget } from '../target.js';
import { createTuiApi, type TuiApi } from './api.js';
import { App } from './app.js';
import { ChatController } from './chat-controller.js';
import { HeaderFeed } from './header-feed.js';
import { ApprovalsController } from './approvals-controller.js';
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

export async function runTui(io: TuiIo = process): Promise<void> {
  if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) {
    // デーモンを起こす前に断る: 端末でなければ描けない（rawMode も使えない）ため
    throw new Error(
      'alteroid tui は端末（TTY）でだけ動きます。スクリプトからは alteroid のサブコマンドを使ってください',
    );
  }
  const target = await resolveTarget();
  // 例外にして非 0 で終える: TUI は読み書き両方の入口で、起動できなかったことを成功として返すと後続のスクリプトが進むため
  if (target.note !== null) throw new Error(target.note);
  await runApp(createTuiApi(target), io);
}

export async function runApp(api: TuiApi, io: TuiIo): Promise<void> {
  const fullscreen = isFullscreenViewport(io.stdout.rows);
  // 一度まっさらにする: 前回の強制終了で端末にモードが残っていることがあるため
  const leaveAlt = fullscreen ? enterAltScreen(io.stdout) : () => undefined;
  const restore = (): void => {
    leaveAlt();
    resetTerminalModes(io.stdout);
  };
  const uninstall = installCrashRestore(restore, io.stderr);
  const controller = new ChatController(api);
  const feed = new HeaderFeed(api);
  const approvals = new ApprovalsController(api);
  approvals.attach(feed);
  const managers = new ManagersController(api);
  managers.attach(feed);
  // 2 本目の SSE を張らない: 日誌と記憶も、ヘッダが張っている 1 本を共有するため
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
        approvals={approvals}
        managers={managers}
        journal={journal}
        memory={memory}
        fullscreen={fullscreen}
      />,
      {
        stdin: io.stdin,
        stdout: io.stdout,
        stderr: io.stderr,
        // Ctrl+C を終了に使わない: 中断に使うため
        exitOnCtrlC: false,
        // Ink に非対話扱い（最後のフレームしか書かない）へ倒させない: `CI=true` の環境（コンテナの既定など）でも TTY のため
        interactive: true,
      },
    );
    await instance.waitUntilExit();
  } finally {
    approvals.dispose();
    managers.dispose();
    journal.dispose();
    memory.dispose();
    feed.stop();
    restore();
    uninstall();
    // 画面を戻した後に書く: 代替画面ごと消えて読めなくなるため
    if (controller.shutdownFailure !== null) io.stderr.write(`${controller.shutdownFailure}\n`);
  }
}
