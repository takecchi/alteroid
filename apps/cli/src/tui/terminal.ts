/**
 * 端末の状態（alt screen・カーソル・各種モード）の出入り。
 * 出所: takecchi/codiva（MIT）`src/utils/terminal-mode.ts` / `alt-screen.ts` を移したもの
 * （マウス関連は借りていない）。
 */

/** テストでフェイクを注入できるよう、必要な write だけに絞ったストリーム型。 */
export interface WritableLike {
  write(text: string): unknown;
}

const ESC = '\x1b';
export const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
export const LEAVE_ALT_SCREEN = `${ESC}[?1049l`;

/**
 * 端末を「TUI が何も設定していない状態」へ戻す一括リセット列。強制終了（SIGKILL・OOM）
 * では `exit` イベントすら走らないので、そのとき残りうるモードを全部落とす。
 * マウスレポート全モード off → bracketed paste off → カーソル表示 → alt screen 退出。
 * 有効でないモードへの off は no-op なので何度送っても安全。
 */
export const RESET_TERMINAL = `${ESC}[?1006l${ESC}[?1015l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?2004l${ESC}[?25h${ESC}[?1049l`;

export function resetTerminalModes(stream: WritableLike = process.stdout): void {
  stream.write(RESET_TERMINAL);
}

/**
 * ある端末モードへ入り、抜けるための関数を返す（冪等）。例外・シグナルで明示の leave を
 * 通らなくても取り残さないよう、`exit` イベントにも保険で登録する。
 */
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

/**
 * 未捕捉の例外・Promise の拒否・SIGTERM/SIGHUP で、端末を戻してから理由を通常の画面へ出す。
 * alt screen のまま死ぬと例外の内容が画面ごと消え、「突然シェルに戻った」としか見えない。
 * 返り値は解除関数。
 */
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
