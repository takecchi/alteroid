#!/usr/bin/env node
import { chmodSync, chownSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRunnerHost, type RunnerChildUser } from '@alteroid/core';
import { createAdaptorServer } from '@hono/node-server';

import { createRunnerApp, Outbox } from './app.js';
import { leaseTtlMsOf, SessionLease } from './lease.js';

export {
  createRunnerApp,
  Outbox,
  type LeasePort,
  type RunnerAppDeps,
  type RunnerAppType,
} from './app.js';
export { leaseTtlMsOf, SessionLease, type SessionLeaseOptions } from './lease.js';

/**
 * alteroid-runner — マネージャーと作業者を隔離して走らせる常駐プロセス。
 *
 * ここには**記憶ストアへ到達する鍵が無い**。それがこのプロセスを分けた理由で
 * あり、M4 の受け入れ基準3（マネージャーから記憶ストアへの認証経路が存在しない）は
 * この分離で初めて構造的に成立する。
 *
 * **制御面もマネージャーから触らせない。** マネージャーはこの器の中で走る子プロセス
 * なので、この API を叩けてしまうと自分宛の許可確認に自分で `allow` を返せる。
 * 3枚で塞ぐ:
 *
 * 1. **待ち受けは Unix ソケット**（コンテナ構成）。TCP の口が無いので `curl
 *    http://127.0.0.1:...` の宛先自体が存在しない
 * 2. **ソケットの所有者はデーモンの UID・モード 0600**。別 UID の子プロセスは繋げない
 * 3. **子プロセスは別 UID で走る**。runner の `/proc/1/environ` も読めないので、
 *    合鍵（ハッシュしか置いていないが）にもソケットにも手が届かない
 *
 * **ここに DB 接続や人格データの読み書きを足さないこと。** 足した瞬間、マネージャーが
 * 同じ器の中から鍵を取れる状態に戻る。
 */
export function runnerIdOf(env: NodeJS.ProcessEnv = process.env): string {
  const given = env.ALTEROID_RUNNER_ID;
  if (given !== undefined && given.length > 0) return given;
  // 既定は固定名。M4 は1台構成であり、器を作り直しても同じ宛先として戻る
  // （台帳に残った runner_id と突き合わせられる）。
  return 'runner-primary';
}

/** 空文字は「未指定」。 */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * 子プロセスを降ろす UID。
 *
 * **設定されているのに降ろせないなら落とす。** 同じ UID のまま走り続けると、
 * 境界があるつもりで無い状態になる（いちばん危ない）。
 */
export function childUserOf(env: NodeJS.ProcessEnv = process.env): RunnerChildUser | undefined {
  const uid = envValue(env, 'ALTEROID_RUNNER_CHILD_UID');
  if (uid === undefined) return undefined;
  const gid = envValue(env, 'ALTEROID_RUNNER_CHILD_GID') ?? uid;
  const home = envValue(env, 'ALTEROID_RUNNER_CHILD_HOME');
  return {
    uid: Number(uid),
    gid: Number(gid),
    ...(home === undefined ? {} : { home }),
  };
}

export async function main(): Promise<void> {
  const runnerId = runnerIdOf();
  const workspacePath = process.env.ALTEROID_WORKSPACE || process.cwd();

  // 合鍵はハッシュだけを持つ。素の値はデーモンにしかない。
  const tokenSha256 = envValue(process.env, 'ALTEROID_RUNNER_TOKEN_SHA256');
  if (tokenSha256 === undefined) {
    throw new Error(
      'ALTEROID_RUNNER_TOKEN_SHA256 が要る（制御面の本人確認。' +
        'デーモンの ALTEROID_RUNNER_TOKEN の sha256 を16進で渡すこと）',
    );
  }

  const childUser = childUserOf();
  if (childUser !== undefined && process.getuid?.() !== 0) {
    throw new Error(
      'ALTEROID_RUNNER_CHILD_UID が指定されているが、UID を降ろす特権が無い。' +
        '同じ UID で走らせると子プロセスが制御面に手を届かせるので起動しない。',
    );
  }

  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId,
    workspacePath,
    emit: (event) => outbox.push(event),
    ...(childUser === undefined ? {} : { childUser }),
  });

  // 貸し出し期限。デーモンから名乗りを聞かれない時間が続けば、抱えている
  // セッションを**自分で**畳む。これが無いと、通信が切れただけの器で走り続けている
  // 仕事を、デーモンが別の器で開き直してしまう（同じ仕事が2か所で走る）。
  const leaseTtlMs = leaseTtlMsOf();
  const lease =
    leaseTtlMs === null
      ? undefined
      : new SessionLease({
          ttlMs: leaseTtlMs,
          fence: async () => {
            const ids = host.list().map((state) => state.managerId);
            for (const id of ids) await host.stop(id).catch(() => undefined);
            return ids;
          },
          onFenced: (ids) => {
            process.stderr.write(
              `alteroid-runner: デーモンから ${Math.round(leaseTtlMs / 1000)} 秒名乗りを聞かれないので、` +
                `走行中のマネージャーを畳みました（${ids.join(', ')}）。` +
                '別の器で続きが開かれても二重に走らないためです。\n',
            );
          },
        });
  lease?.start();

  const app = createRunnerApp({
    host,
    outbox,
    tokenSha256,
    ...(lease === undefined ? {} : { lease }),
  });
  const server = createAdaptorServer({ fetch: app.fetch });

  server.on('error', (error: unknown) => {
    process.stderr.write(`alteroid-runner: 待ち受けに失敗しました: ${String(error)}\n`);
    process.exit(1);
  });

  const socketPath = envValue(process.env, 'ALTEROID_RUNNER_SOCKET');
  let listeningOn: string;

  if (socketPath !== undefined) {
    // 古いソケットが残っていると listen できない（器の作り直しで残る）
    rmSync(socketPath, { force: true });
    mkdirSync(dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
    // **デーモンだけが繋げる持ち主にする。** 子プロセス（別 UID）は繋げない。
    const ownerUid = Number(envValue(process.env, 'ALTEROID_RUNNER_SOCKET_UID') ?? '');
    if (Number.isInteger(ownerUid)) {
      const ownerGid = Number(envValue(process.env, 'ALTEROID_RUNNER_SOCKET_GID') ?? ownerUid);
      chownSync(socketPath, ownerUid, ownerGid);
    }
    chmodSync(socketPath, 0o600);
    listeningOn = `unix:${socketPath}`;
  } else {
    const port = Number(process.env.ALTEROID_RUNNER_PORT ?? '4518');
    const hostname = process.env.ALTEROID_RUNNER_BIND || '127.0.0.1';
    await new Promise<void>((resolve) => server.listen({ port, host: hostname }, resolve));
    listeningOn = `http://${hostname}:${port}`;
    // TCP は開発用の逃げ道である。マネージャーは同じ器の中に居るので、鍵が漏れれば
    // 制御面に手が届く。**本番はソケットにすること。**
    process.stderr.write(
      'alteroid-runner: TCP で待ち受けています。マネージャーと同じ器から届く口なので、' +
        '本番では ALTEROID_RUNNER_SOCKET を使ってください。\n',
    );
  }

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    lease?.stop();
    server.close();
    if (socketPath !== undefined) rmSync(socketPath, { force: true });
    // 走行中のマネージャーは畳む。生ログはこの中でデーモンへ渡される
    // （渡さずに消えると、manager_id から生ログへ降りる経路が切れる）。
    const forced = setTimeout(() => process.exit(0), 30_000);
    forced.unref();
    await host.shutdown().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  process.stdout.write(
    `alteroid-runner: ${listeningOn} （runner_id: ${runnerId} / 作業: ${workspacePath}` +
      `${childUser === undefined ? '' : ` / 子プロセス: uid ${childUser.uid}`}` +
      `${
        leaseTtlMs === null
          ? ' / 期限なし（自動移送の対象外になります）'
          : ` / 期限: ${Math.round(leaseTtlMs / 1000)}秒`
      }）\n`,
  );
}

/** 直接起動されたときだけ main を走らせる。 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    process.stderr.write(`alteroid-runner: 起動に失敗しました: ${String(error)}\n`);
    process.exit(1);
  });
}
