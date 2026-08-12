import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { stateDir } from './paths.js';

export interface DaemonRuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
  /** 起動ごとの本人確認用トークン。`/health` が返すものと一致して初めて本人。 */
  token: string;
}

export interface DaemonStatus {
  running: boolean;
  info: DaemonRuntimeInfo | null;
}

export type StopOutcome =
  | 'stopped'
  | 'not-running'
  /** 状態ファイルは残っているが本人確認できない。PID は信用できないので触らない。 */
  | 'stale'
  /** 応答はあるが止まらない。 */
  | 'unresponsive';

function runtimeFile(): string {
  return join(stateDir(), 'daemon.json');
}

export function baseUrl(info: Pick<DaemonRuntimeInfo, 'port'>): string {
  return `http://127.0.0.1:${info.port}`;
}

async function readRuntimeInfo(): Promise<DaemonRuntimeInfo | null> {
  try {
    const raw = await readFile(runtimeFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonRuntimeInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null;
    // token の無い状態ファイルは本人確認できない = stale 扱い
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
    return parsed as DaemonRuntimeInfo;
  } catch {
    return null;
  }
}

/**
 * 本人確認。ポートが空いていることではなく、**そこにいるのが自分の記録した
 * デーモンであること**を確かめる。PID は使わない — 異常終了で状態ファイルが
 * 残ったあと、OS が同じ PID を別プロセスに配ることがあるため。
 */
async function verify(info: DaemonRuntimeInfo): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl(info)}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { token?: unknown };
    return body.token === info.token;
  } catch {
    return false;
  }
}

export async function status(): Promise<DaemonStatus> {
  const info = await readRuntimeInfo();
  if (!info) return { running: false, info: null };
  return { running: await verify(info), info };
}

function daemonEntrypoint(): string {
  // @alteroid/daemon の実体を解決する（CLI は core を持たないので子プロセスで起こす）
  return fileURLToPath(import.meta.resolve('@alteroid/daemon'));
}

/** 常駐は自律の前提（PRD）。chat のたびに起こすのではなく、居なければ起こす。 */
export async function start(): Promise<DaemonRuntimeInfo> {
  const current = await status();
  if (current.running && current.info) return current.info;

  // 子プロセスの出力を捨てない。捨てると「起動しない理由」が永久に分からなくなる。
  await mkdir(stateDir(), { recursive: true });
  const logPath = join(stateDir(), 'daemon.log');
  const log = openSync(logPath, 'a');

  const child = spawn(process.execPath, [daemonEntrypoint()], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(250);
    const next = await status();
    if (next.running && next.info) return next.info;
  }
  throw new Error(`デーモンの起動を確認できませんでした（ログ: ${logPath}）`);
}

/** `stopDaemon` が触る外界。テストで差し替えるためだけに切り出してある。 */
export interface StopDeps {
  readInfo(): Promise<DaemonRuntimeInfo | null>;
  verify(info: DaemonRuntimeInfo): Promise<boolean>;
  requestShutdown(info: DaemonRuntimeInfo): Promise<void>;
  /** SIGTERM。**本人確認できたときだけ**呼んでよい。 */
  terminate(pid: number): void;
  clearInfo(): Promise<void>;
  wait(ms: number): Promise<void>;
}

/**
 * デーモンを止める。
 *
 * **本人確認できない限り、記録された PID へシグナルを送らない。** 状態ファイルの
 * PID は、デーモンが SIGKILL やクラッシュや OS 再起動で正常終了できなかった場合に
 * 残る。その PID を OS が別プロセスへ再利用していたら、シグナルはそのプロセスを
 * 殺してしまう。本人だと確かめられないときは、状態ファイルを片付けて手を引く。
 */
export async function stopDaemon(deps: StopDeps): Promise<StopOutcome> {
  const info = await deps.readInfo();
  if (!info) return 'not-running';

  if (!(await deps.verify(info))) {
    // 記録は残っているが本人ではない（または既に居ない）。PID には触らない。
    await deps.clearInfo();
    return 'stale';
  }

  // ここから先は本人だと確認できている。
  try {
    await deps.requestShutdown(info);
  } catch {
    deps.terminate(info.pid);
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await deps.wait(250);
    if (!(await deps.verify(info))) {
      await deps.clearInfo();
      return 'stopped';
    }
    // 折り返し地点で応答があるならシグナルで押す（本人確認済みなので安全）
    if (attempt === 20) deps.terminate(info.pid);
  }
  return 'unresponsive';
}

export async function stop(): Promise<StopOutcome> {
  return stopDaemon({
    readInfo: readRuntimeInfo,
    verify,
    async requestShutdown(info) {
      const response = await fetch(`${baseUrl(info)}/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`shutdown が失敗した (${response.status})`);
    },
    terminate(pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // 既に居ない
      }
    },
    async clearInfo() {
      await rm(runtimeFile(), { force: true });
    },
    wait: sleep,
  });
}

/** 起動していなければ起こしてから接続先を返す。 */
export async function ensureRunning(): Promise<DaemonRuntimeInfo> {
  const current = await status();
  if (current.running && current.info) return current.info;
  return start();
}
