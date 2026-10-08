import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { stateDir } from './paths.js';
import { readSessionRefusal, type SessionRefusal } from './session-refusal.js';

export interface DaemonRuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
  token: string;
}

// boolean にしない: 「確かめられなかった」が黙って「居ない」側へ倒れるため
export type Presence = 'present' | 'absent' | 'unknown';

export interface DaemonStatus {
  presence: Presence;
  info: DaemonRuntimeInfo | null;
}

export type StopOutcome =
  | 'stopped'
  | 'not-running'
  | 'stale'
  | 'unresponsive'
  | 'unknown'
  // 待ち受けは閉じたが、プロセスがまだ後始末をしている
  | 'cleanup-pending';

// daemon の `FORCED_EXIT_MS`（`apps/daemon/src/index.ts`）の写し: export されておらず、CLI から daemon を import すると本体ごと読み込むため（ずれは daemon.test.ts が見張る）
export const DAEMON_FORCED_EXIT_MS = 55_000;

// daemon の強制終了より長く待つ: 強制終了の直前まで後始末が続いても、終わるのを見届けてから返すため
export const CLEANUP_WAIT_MS = DAEMON_FORCED_EXIT_MS + 10_000;

const POLL_MS = 250;

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
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
    return parsed as DaemonRuntimeInfo;
  } catch {
    return null;
  }
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return false;
  return (cause as NodeJS.ErrnoException).code === 'ECONNREFUSED';
}

// PID で本人確認しない: 異常終了のあと、OS が同じ PID を別プロセスに配ることがあるため
async function verify(info: DaemonRuntimeInfo): Promise<Presence> {
  try {
    // token を `/health` の応答と突き合わせない: 許可を付与できる資格なので、無認証で読める応答には載せられないため
    const response = await fetch(`${baseUrl(info)}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return 'absent';
    const body = (await response.json()) as { operator?: unknown };
    return body.operator === true ? 'present' : 'absent';
  } catch (error) {
    // 接続拒否以外を `absent` にしない: 確かめられなかっただけで、生きているデーモンかもしれないため
    if (isConnectionRefused(error)) return 'absent';
    return 'unknown';
  }
}

export async function storageOf(info: DaemonRuntimeInfo | null): Promise<string | null> {
  if (!info) return null;
  try {
    const response = await fetch(`${baseUrl(info)}/status`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { storage?: unknown };
    return typeof body.storage === 'string' && body.storage.length > 0 ? body.storage : null;
  } catch {
    return null;
  }
}

/**
 * クローンのセッションが安全分類器に弾かれ続けている状況を `/status` から取る（#4173）。
 * 無い・聞けない・形が読めないときは `null`（作り物の「弾かれている」を出さない）。
 */
export async function sessionRefusalOf(
  info: DaemonRuntimeInfo | null,
): Promise<SessionRefusal | null> {
  if (!info) return null;
  try {
    const response = await fetch(`${baseUrl(info)}/status`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { cloneSessionRefusal?: unknown };
    return readSessionRefusal(body.cloneSessionRefusal);
  } catch {
    return null;
  }
}

export async function status(): Promise<DaemonStatus> {
  const info = await readRuntimeInfo();
  if (!info) return { presence: 'absent', info: null };
  return { presence: await verify(info), info };
}

function daemonEntrypoint(): string {
  return fileURLToPath(import.meta.resolve('@alteroid/daemon'));
}

// 呼び出し側が「起こした」と「既に居た」を言い分けられるように、どちらかを返す
export type StartOutcome =
  | { kind: 'already-present'; info: DaemonRuntimeInfo }
  | { kind: 'started'; info: DaemonRuntimeInfo };

export async function start(): Promise<StartOutcome> {
  const current = await status();
  if (current.presence === 'present' && current.info) {
    return { kind: 'already-present', info: current.info };
  }
  if (current.presence === 'unknown') {
    // 2本目を起こさない: 確かめられなかっただけで生きているかもしれず、ポート衝突や記憶ストアへの二重書き込みになるため
    throw new Error(
      '既存の alteroidd の生死を確かめられませんでした（応答が無いかタイムアウトしました）。' +
        '二重起動を避けるため起動を中止しました。ネットワークや負荷を確認してから、' +
        '必要なら `alteroid daemon status` で状態を見てからやり直してください。',
    );
  }

  // 子プロセスの出力を捨てない: 「起動しない理由」が分からなくなるため
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
    if (next.presence === 'present' && next.info) return { kind: 'started', info: next.info };
  }
  throw new Error(`デーモンの起動を確認できませんでした（ログ: ${logPath}）`);
}

export interface StopDeps {
  readInfo(): Promise<DaemonRuntimeInfo | null>;
  verify(info: DaemonRuntimeInfo): Promise<Presence>;
  requestShutdown(info: DaemonRuntimeInfo): Promise<void>;
  terminate(pid: number): void;
  clearInfo(): Promise<void>;
  wait(ms: number): Promise<void>;
  now(): number;
  // `null`（確かめられない）を「終わった」にしないため boolean にしない
  isAlive(pid: number): boolean | null;
  // 待ち受けが閉じたあと、まだ後始末中のプロセスを待ち始めるときに1度だけ呼ぶ
  onCleanupWait?(): void;
}

export async function stopDaemon(deps: StopDeps): Promise<StopOutcome> {
  const info = await deps.readInfo();
  if (!info) return 'not-running';

  const presence = await deps.verify(info);
  if (presence === 'unknown') {
    // 状態ファイルを消さない: 直後の `ensureRunning()` が `absent` と読み、`start()` の安全弁を素通りして2本目を起こすため
    return 'unknown';
  }
  if (presence === 'absent') {
    // PID にシグナルを送らない: OS が別プロセスへ再利用しているかもしれないため
    await deps.clearInfo();
    return 'stale';
  }

  // 待つ上限の起点を停止要求の前に置く: 起点が後ろへずれた分だけ、再利用された PID を待つ窓が広がるため
  const shutdownSentAt = deps.now();
  try {
    await deps.requestShutdown(info);
  } catch {
    deps.terminate(info.pid);
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await deps.wait(POLL_MS);
    // `unknown` を止まったとみなさない: 確かめられないことを確定へ倒さないため
    if ((await deps.verify(info)) === 'absent') {
      await deps.clearInfo();
      return waitForExit(deps, info.pid, shutdownSentAt);
    }
    if (attempt === 20) deps.terminate(info.pid);
  }
  return 'unresponsive';
}

// 待ち受けが閉じただけで `stopped` と言わない: daemon は待ち受けを閉じたあとも、別れの蒸留・記憶ストアを閉じる後始末を続けるため
async function waitForExit(
  deps: StopDeps,
  pid: number,
  shutdownSentAt: number,
): Promise<'stopped' | 'cleanup-pending'> {
  let announced = false;
  while (deps.isAlive(pid) !== false) {
    // 上限を過ぎたら待たない: 停止要求から時間が経つほど、その PID が別プロセスへ再利用されている見込みが増えるため
    if (deps.now() - shutdownSentAt >= CLEANUP_WAIT_MS) return 'cleanup-pending';
    if (!announced) {
      announced = true;
      deps.onCleanupWait?.();
    }
    await deps.wait(POLL_MS);
  }
  return 'stopped';
}

function isProcessAlive(pid: number): boolean | null {
  // 0 以下を `kill(pid, 0)` に渡さない: 0 は自分のプロセスグループ宛てになり、常に「生きている」と返るため
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return pidAppearsAlive(pid);
}

export async function stop(options: { onCleanupWait?: () => void } = {}): Promise<StopOutcome> {
  return stopDaemon({
    readInfo: readRuntimeInfo,
    verify,
    now: Date.now,
    isAlive: isProcessAlive,
    onCleanupWait: options.onCleanupWait,
    async requestShutdown(info) {
      const response = await fetch(`${baseUrl(info)}/shutdown`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${info.token}`,
        },
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

export async function ensureRunning(): Promise<DaemonRuntimeInfo> {
  const current = await status();
  if (current.presence === 'present' && current.info) return current.info;
  // `startWithRecovery()` を呼ばない: 回復は人間が明示のフラグを付けたときだけ起きる操作で、毎回通るこの経路の既定にしてはいけないため
  return (await start()).info;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function quarantineRuntimeFile(): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${runtimeFile()}.stale-${stamp}`;
  let target = base;
  let attempt = 0;
  while (await pathExists(target)) {
    attempt += 1;
    target = `${base}-${attempt}`;
  }
  await rename(runtimeFile(), target);
  return target;
}

function pidAppearsAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

export type StartWithRecoveryOutcome =
  | { kind: 'already-present'; info: DaemonRuntimeInfo }
  | { kind: 'started'; info: DaemonRuntimeInfo }
  | {
      kind: 'recovered';
      info: DaemonRuntimeInfo;
      quarantinedTo: string;
      previousPid: number;
      previousPidAlive: boolean | null;
    };

export async function startWithRecovery(): Promise<StartWithRecoveryOutcome> {
  const current = await status();
  if (current.presence === 'present' && current.info) {
    return { kind: 'already-present', info: current.info };
  }
  if (current.presence === 'absent') {
    return start();
  }
  if (!current.info) {
    throw new Error('内部エラー: unknown と判定されたのに状態ファイルを読めていません');
  }
  const previousPid = current.info.pid;
  const previousPidAlive = pidAppearsAlive(previousPid);
  const quarantinedTo = await quarantineRuntimeFile();
  const { info } = await start();
  return { kind: 'recovered', info, quarantinedTo, previousPid, previousPidAlive };
}
