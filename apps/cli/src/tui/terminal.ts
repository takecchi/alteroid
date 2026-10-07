// 出所: takecchi/codiva（MIT）`src/utils/terminal-mode.ts` / `alt-screen.ts` を移したもの
export interface WritableLike {
  write(text: string): unknown;
}

const ESC = '\x1b';
export const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
export const LEAVE_ALT_SCREEN = `${ESC}[?1049l`;

// 残りうるモードを全部落とす: 強制終了（SIGKILL・OOM）では `exit` イベントすら走らないため
export const RESET_TERMINAL = `${ESC}[?1006l${ESC}[?1015l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?2004l${ESC}[?25h${ESC}[?1049l`;

export function resetTerminalModes(stream: WritableLike = process.stdout): void {
  stream.write(RESET_TERMINAL);
}

// `exit` イベントにも登録する: 例外・シグナルで明示の leave を通らなくても取り残さないため
export function toggleEscape(
  enter: string,
  leave: string,
  stream: WritableLike = process.stdout,
  proc: Pick<NodeJS.Process, 'on' | 'removeListener'> = process,
): () => void {
  stream.write(enter);
  let done = false;
  const teardown = (): void => {
    if (done) return;
    done = true;
    proc.removeListener('exit', teardown);
    stream.write(leave);
  };
  proc.on('exit', teardown);
  return teardown;
}

export function enterAltScreen(
  stream: WritableLike = process.stdout,
  proc: Pick<NodeJS.Process, 'on' | 'removeListener'> = process,
): () => void {
  return toggleEscape(ENTER_ALT_SCREEN, LEAVE_ALT_SCREEN, stream, proc);
}

// 端末を戻してから理由を出す: alt screen のまま死ぬと例外の内容が画面ごと消え、「突然シェルに戻った」としか見えないため
export function installCrashRestore(
  restore: () => void,
  stderr: WritableLike = process.stderr,
  proc: Pick<NodeJS.Process, 'on' | 'removeListener' | 'exit'> = process,
): () => void {
  const fatal = (error: unknown): void => {
    restore();
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    stderr.write(`alteroid tui: ${text}\n`);
    proc.exit(1);
  };
  const signal = (): void => {
    restore();
    proc.exit(130);
  };
  proc.on('uncaughtException', fatal);
  proc.on('unhandledRejection', fatal);
  proc.on('SIGTERM', signal);
  proc.on('SIGHUP', signal);
  return () => {
    proc.removeListener('uncaughtException', fatal);
    proc.removeListener('unhandledRejection', fatal);
    proc.removeListener('SIGTERM', signal);
    proc.removeListener('SIGHUP', signal);
  };
}
