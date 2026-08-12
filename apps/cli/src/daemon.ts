import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { stateDir } from './paths.js';

export interface DaemonRuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export interface DaemonStatus {
  running: boolean;
  info: DaemonRuntimeInfo | null;
}

async function readRuntimeInfo(): Promise<DaemonRuntimeInfo | null> {
  try {
    const raw = await readFile(join(stateDir(), 'daemon.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonRuntimeInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null;
    return parsed as DaemonRuntimeInfo;
  } catch {
    return null;
  }
}

export function baseUrl(info: DaemonRuntimeInfo): string {
  return `http://127.0.0.1:${info.port}`;
}

async function healthy(info: DaemonRuntimeInfo): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl(info)}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function status(): Promise<DaemonStatus> {
  const info = await readRuntimeInfo();
  if (!info) return { running: false, info: null };
  return { running: await healthy(info), info };
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

export async function stop(): Promise<boolean> {
  const current = await status();
  const info = current.info;
  if (!info) return false;

  if (current.running) {
    try {
      await fetch(`${baseUrl(info)}/shutdown`, { method: 'POST' });
    } catch {
      signal(info.pid);
    }
  } else {
    // /health が応えなくてもプロセスは生きているかもしれない。
    // 「動いていません」と言って孤児を残さない。
    if (!signal(info.pid)) return false;
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    if (!alive(info.pid)) return true;
  }
  return false;
}

function signal(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** プロセスの生死だけを見る（シグナル 0 は送信せず存在確認のみ）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 起動していなければ起こしてから接続先を返す。 */
export async function ensureRunning(): Promise<DaemonRuntimeInfo> {
  const current = await status();
  if (current.running && current.info) return current.info;
  return start();
}
