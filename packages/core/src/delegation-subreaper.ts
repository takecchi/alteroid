import { constants } from 'node:os';

import type { AgentChildProcess, AgentSpawnOptions } from './agent-session.js';

// 委譲の CLI を `tini -s --` の子として起こす（#4494）。`-s` は tini に PR_SET_CHILD_SUBREAPER を立てさせる:
// 委譲の木の中で親が先に終わった子孫（`pg_ctl` の postmaster・`setsid nohup` のサーバー）が PID 1 ではなくこの tini に引き取られ、
// 委譲が生きている間は委譲の木の中に居続ける。PID 1 へ直に落ちると、走査の間に一度も木の中で観測されず、誰のものか分からないまま撃たれずに残るため。
export function underSubreaper(options: AgentSpawnOptions, subreaper: string): AgentSpawnOptions {
  return { ...options, command: subreaper, args: ['-s', '--', options.command, ...options.args] };
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

// 番号から名前を引く表は1度だけ作る。同じ番号の別名（SIGIOT と SIGABRT など）は先に定義された側を採る: Node の表は SIGABRT が先のため。
const SIGNAL_NAME_BY_NUMBER = new Map<number, NodeJS.Signals>();
for (const [name, number] of Object.entries(constants.signals)) {
  if (!SIGNAL_NAME_BY_NUMBER.has(number)) SIGNAL_NAME_BY_NUMBER.set(number, name as NodeJS.Signals);
}

// tini は子がシグナルで死ぬと 128+N で終わる。読み戻さないと SDK の失敗が `terminated by signal SIGABRT` から
// `exited with code 134` に変わり、pids の飽和で落ちた形が読み手から消えるため。
// CLI が自分で 129 以上の値で exit した回もシグナルと読む（CLI はその値を使わないので、取り違えの害より読み戻さない害が大きい）。
export function signalOfSubreaperExit(code: number | null): NodeJS.Signals | undefined {
  if (code === null || code <= 128) return undefined;
  return SIGNAL_NAME_BY_NUMBER.get(code - 128);
}

// tini 越しの子を、CLI を直に起こしたときと同じ終わり方に見せる。`kill` は tini に届き、tini が CLI へ転送する。
export function subreapedProcess(child: AgentChildProcess): AgentChildProcess {
  // 包んだ関数を覚えておく: `off` には呼び出し側の関数が来るが、子に登録されているのは包んだ側のため。
  const wrappedExitListeners = new Map<ExitListener, ExitListener>();
  const wrapExit = (listener: ExitListener, once: boolean): ExitListener => {
    const wrapped: ExitListener = (code, signal) => {
      if (once) wrappedExitListeners.delete(listener);
      const translated = signal === null ? signalOfSubreaperExit(code) : undefined;
      if (translated === undefined) listener(code, signal);
      else listener(null, translated);
    };
    wrappedExitListeners.set(listener, wrapped);
    return wrapped;
  };

  // `stderr` は型に無いが写す: runner は委譲の stderr の末尾を読んで落ちた理由を残すため（`#watchDelegationStderr`）。
  const stderr = (child as { stderr?: unknown }).stderr;
  const handle: AgentChildProcess & { stderr?: unknown } = {
    get stdin() {
      return child.stdin;
    },
    get stdout() {
      return child.stdout;
    },
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return signalOfSubreaperExit(child.exitCode) === undefined ? child.exitCode : null;
    },
    get signalCode() {
      return child.signalCode ?? signalOfSubreaperExit(child.exitCode) ?? null;
    },
    get pid() {
      return child.pid;
    },
    kill: (signal) => child.kill(signal),
    on: ((event: 'exit' | 'error', listener: ExitListener | ErrorListener) => {
      if (event === 'exit') child.on('exit', wrapExit(listener as ExitListener, false));
      else child.on('error', listener as ErrorListener);
    }) as AgentChildProcess['on'],
    once: ((event: 'exit' | 'error', listener: ExitListener | ErrorListener) => {
      if (event === 'exit') child.once('exit', wrapExit(listener as ExitListener, true));
      else child.once('error', listener as ErrorListener);
    }) as AgentChildProcess['once'],
    off: ((event: 'exit' | 'error', listener: ExitListener | ErrorListener) => {
      if (event === 'exit') {
        const wrapped = wrappedExitListeners.get(listener as ExitListener);
        if (wrapped === undefined) return;
        wrappedExitListeners.delete(listener as ExitListener);
        child.off('exit', wrapped);
      } else child.off('error', listener as ErrorListener);
    }) as AgentChildProcess['off'],
  };
  if (stderr !== undefined) handle.stderr = stderr;
  return handle;
}
