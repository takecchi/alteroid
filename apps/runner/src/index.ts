#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createCredentialStore,
  createProfileVessel,
  createRunnerHost,
  DEFAULT_PROFILE_PATH,
  installUncaughtNet,
  MANAGER_PROVIDER_ENV_KEY,
  DEFAULT_AGENT_PROVIDER_ID,
  agentProviderOf,
  placedAgentProvider,
  resolveManagerProviderId,
  placedManagerModels,
  reasonOf,
  resolveManagerModel,
  resolveWorkerModel,
  runnerModelLabels,
  WITHHELD_ENV_KEYS,
  writeStderrSync,
  type RunnerChildUser,
} from '@alteroid/core';
import { createAdaptorServer } from '@hono/node-server';

import { createRunnerApp, formatOutboxShutdownReport, Outbox } from './app.js';
import { openPeerSocket } from './peer-socket.js';
import {
  TaskBreakdownReader,
  type ReclaimReapOptions,
  type ReclaimScanOptions,
  type ReclaimSessionView,
} from './tasks.js';

export {
  createRunnerApp,
  formatOutboxShutdownReport,
  Outbox,
  type OutboxPendingGroup,
  type OutboxShutdownSnapshot,
  type RunnerAppDeps,
  type RunnerAppType,
} from './app.js';

// ここに DB 接続や人格データの読み書きを足さない: マネージャーが同じ器の中から鍵を取れる状態に戻るため。
export function runnerIdOf(env: NodeJS.ProcessEnv = process.env): string {
  const given = env.ALTEROID_RUNNER_ID;
  if (given !== undefined && given.length > 0) return given;
  return 'runner-primary';
}

// 猶予は `railway/runner.json` の `drainingSeconds` と `compose.yaml` の `stop_grace_period` の写し: 実行中のプロセスからは読めないため。デーモン側と共有しない: Service ごとの設定で、片方だけ延ばす日があるため。
const SHUTDOWN_GRACE_MS = 60_000;

// `SHUTDOWN_GRACE_MS` ちょうどにしない: 猶予が切れる時刻には SIGKILL が来て、自分の意思で `exit` する最後の口が負けるため。
const FORCED_EXIT_MS = SHUTDOWN_GRACE_MS - 5_000;

export const DRAIN_WAIT_MS = 3_000;

export const DRAIN_POLL_INTERVAL_MS = 50;

// タイムアウトしても投げない: 待ち切れなかった分は、この後 `formatOutboxShutdownReport` が残りとして報告するため。
export async function waitForOutboxDrain(outbox: Outbox, maxWaitMs: number): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (outbox.pending > 0 && outbox.subscribed && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
  }
}

// `process.stderr.write` を使わない: fd がパイプだと非同期で、直後の `process.exit()` に巻き込まれて行が消えるため。
export async function drainAndReportOutbox(
  outbox: Outbox,
  options: { waitMs?: number; write?: (line: string) => void } = {},
): Promise<void> {
  if (outbox.subscribed) {
    await waitForOutboxDrain(outbox, options.waitMs ?? DRAIN_WAIT_MS);
  }
  const report = formatOutboxShutdownReport(outbox.describeForShutdown());
  if (report !== null) (options.write ?? writeStderrSync)(report);
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.length > 0 ? value : undefined;
}

// 両方置かれて食い違うときは黙って片方を選ばず落とす: 人間は「置いた」、runner は 401 を返し続け、どちらも正しいまま噛み合わないため。
export function tokenSha256Of(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const given = envValue(env, 'ALTEROID_RUNNER_TOKEN_SHA256');
  const raw = envValue(env, 'ALTEROID_RUNNER_TOKEN');
  if (raw === undefined) return given;

  const folded = createHash('sha256').update(raw, 'utf8').digest('hex');
  if (given !== undefined && given !== folded) {
    throw new Error(
      'ALTEROID_RUNNER_TOKEN と ALTEROID_RUNNER_TOKEN_SHA256 が食い違っている' +
        '（どちらか一方だけを置くこと。既定はデーモンと同じ ALTEROID_RUNNER_TOKEN）',
    );
  }
  return folded;
}

function idOf(name: string, raw: string): number {
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(
      `${name} は非負の整数でなければならない（受け取った値: ${JSON.stringify(raw)}）`,
    );
  }
  return Number(raw);
}

// UID が runner 自身と同じなら落とす: 境界にならず、孤児の回収が runner 自身まで候補に入れるため。
export function childUserOf(
  env: NodeJS.ProcessEnv = process.env,
  ownUid: number | undefined = process.getuid?.(),
): RunnerChildUser | undefined {
  const uid = envValue(env, 'ALTEROID_RUNNER_CHILD_UID');
  if (uid === undefined) return undefined;
  const gid = envValue(env, 'ALTEROID_RUNNER_CHILD_GID') ?? uid;
  const uidNumber = idOf('ALTEROID_RUNNER_CHILD_UID', uid);
  const gidNumber = idOf('ALTEROID_RUNNER_CHILD_GID', gid);
  if (ownUid !== undefined && uidNumber === ownUid) {
    throw new Error(
      `ALTEROID_RUNNER_CHILD_UID が runner 自身の UID（${String(ownUid)}）と同じ。` +
        '降ろす先が自分と同じでは境界にならないので起動しない（root と別の UID を置くこと）。',
    );
  }
  const home = envValue(env, 'ALTEROID_RUNNER_CHILD_HOME');
  return {
    uid: uidNumber,
    gid: gidNumber,
    ...(home === undefined ? {} : { home }),
  };
}

// `Number(env ?? '')` で読まない: `Number('')` は 0 で、UID 未設定でも uid 0 へ chown しに行くため。
export function socketOwnerOf(
  env: NodeJS.ProcessEnv = process.env,
): { uid: number; gid: number } | undefined {
  const rawUid = envValue(env, 'ALTEROID_RUNNER_SOCKET_UID');
  if (rawUid === undefined) return undefined;
  const uid = Number(rawUid);
  if (!Number.isInteger(uid)) return undefined;
  return { uid, gid: Number(envValue(env, 'ALTEROID_RUNNER_SOCKET_GID') ?? uid) };
}

export const RECLAIM_ENV_KEY = 'ALTEROID_RUNNER_RECLAIM';

// 切れる口を残す: 回収は人間が PC でできること（長時間のバックグラウンドジョブ）を器が奪いうるため。
export function reclaimScanOf(
  env: NodeJS.ProcessEnv = process.env,
  childUser: RunnerChildUser | undefined = childUserOf(env),
  reap?: ReclaimReapOptions,
): ReclaimScanOptions | undefined {
  const raw = envValue(env, RECLAIM_ENV_KEY) ?? 'reclaim';
  if (raw === 'off') return undefined;
  // 知らない値は既定へ倒さず落とす: `Off` と書いて観測が動き続けると、「置いた」と「効いている」が食い違ったまま気づけないため。
  if (raw !== 'observe' && raw !== 'reclaim') {
    throw new Error(
      `${RECLAIM_ENV_KEY} に知らない値が置かれている: ${JSON.stringify(raw)}` +
        '（この版が受け付けるのは observe と reclaim と off だけである。' +
        '黙って既定へ倒れると「置いた」と「効いている」が食い違ったまま残る）',
    );
  }
  if (childUser === undefined) return undefined;
  return { childUid: childUser.uid, ...(raw === 'reclaim' && reap !== undefined ? { reap } : {}) };
}

// `off`（`undefined`）はそのまま返す: 観測ごと止める切れる口のため。
export function withTerminatedReclaimSessions(
  scan: ReclaimScanOptions | undefined,
  view: ReclaimSessionView,
): ReclaimScanOptions | undefined {
  if (scan === undefined || scan.reap !== undefined) return scan;
  return {
    ...scan,
    sessions: {
      liveSessionPidsOf: view.liveSessionPidsOf,
      knownTerminatedSessionPidsOf: view.knownTerminatedSessionPidsOf,
      ...(view.anyTrackedDelegationsOf === undefined
        ? {}
        : { anyTrackedDelegationsOf: view.anyTrackedDelegationsOf }),
    },
  };
}

export async function main(): Promise<void> {
  const runnerId = runnerIdOf();
  const workspacePath = process.env.ALTEROID_WORKSPACE || process.cwd();

  const tokenSha256 = tokenSha256Of();
  if (tokenSha256 === undefined) {
    throw new Error(
      'ALTEROID_RUNNER_TOKEN が要る（制御面の本人確認。' +
        'デーモンと同じ値を置くこと。sha256 を直に渡すなら ALTEROID_RUNNER_TOKEN_SHA256）',
    );
  }
  // `WITHHELD_ENV_KEYS` に頼らず、この器の環境からも消す: 二重の底にするため。
  delete process.env.ALTEROID_RUNNER_TOKEN;

  const childUser = childUserOf();
  if (childUser !== undefined && process.getuid?.() !== 0) {
    throw new Error(
      'ALTEROID_RUNNER_CHILD_UID が指定されているが、UID を降ろす特権が無い。' +
        '同じ UID で走らせると子プロセスが制御面に手を届かせるので起動しない。',
    );
  }

  const credentials = createCredentialStore({
    ...(envValue(process.env, 'ALTEROID_CREDENTIAL_DIR') === undefined
      ? {}
      : { dir: process.env.ALTEROID_CREDENTIAL_DIR as string }),
    ...(childUser === undefined ? {} : { reader: { uid: childUser.uid, gid: childUser.gid } }),
    // 自分の env を種にしない: 冷却中の死んだ鍵が器に載り、デーモンが上書きするまでの窓で使われるため。空を渡すのは「省略」（`process.env`）と意味が違う。
    seed: {},
    withheldEnvKeys: WITHHELD_ENV_KEYS,
  });
  await credentials.flush();
  const stale = await credentials.purge();
  process.stdout.write(
    `alteroid-runner: 鍵は自分の env から拾いません（クローンが降ろすまで0件）${
      stale.length === 0
        ? ''
        : `。前の器の置き土産 ${stale.length} 件を消しました: ${stale.join(', ')}`
    }\n`,
  );

  const profilePath = envValue(process.env, 'ALTEROID_PROFILE_FILE') ?? DEFAULT_PROFILE_PATH;
  // 前の器の置き土産を引き継がない: volume にファイルが残り、デーモンが降ろす前の一瞬だけ古いプロファイルが効くため。
  rmSync(profilePath, { force: true });
  const profile = createProfileVessel({
    path: profilePath,
    ...(childUser === undefined ? {} : { reader: { uid: childUser.uid, gid: childUser.gid } }),
    withheldEnvKeys: WITHHELD_ENV_KEYS,
  });

  const managerProvider = agentProviderOf(resolveManagerProviderId(process.env));

  const peerOpening = await openPeerSocket(process.env, managerProvider.id, childUser);
  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId,
    workspacePath,
    emit: (event) => outbox.push(event),
    managerProvider: managerProvider.id,
    credentials,
    ...(peerOpening.host === undefined
      ? {}
      : {
          peer: {
            host: peerOpening.host,
            peers: peerOpening.peers,
            reportsUsage: (provider) => agentProviderOf(provider).capabilities.usage,
          },
        }),
    profile,
    ...(childUser === undefined ? {} : { childUser }),
    // 自己失効はこの器だけが有効にする: 同一プロセスの `runner-local` では「デーモンだけが消える」ことが起こり得ないため。
    enforceLease: true,
  });

  const reap: ReclaimReapOptions = {
    liveSessionPidsOf: () => host.delegationSessionPids().live,
    knownTerminatedSessionPidsOf: () => host.delegationSessionPids().knownTerminated,
    // `live` の集合の大きさでは代用しない: `anyTrackedDelegationsOf` の理由と同じ。
    anyTrackedDelegationsOf: () => host.list().length > 0,
  };

  const reclaimScan = withTerminatedReclaimSessions(
    reclaimScanOf(process.env, childUser, reap),
    reap,
  );

  // 既定（`app.ts` 側の `new TaskBreakdownReader()`）に任せない: 降ろす UID を知らず、観測が動かないため。
  const taskBreakdownReader = new TaskBreakdownReader({
    ...(reclaimScan === undefined ? {} : { reclaim: reclaimScan }),
  });

  const app = createRunnerApp({
    host,
    outbox,
    tokenSha256,
    taskBreakdownReader,
    managerProvider: managerProvider.id,
    models: runnerModelLabels(managerProvider.id, process.env),
  });
  const server = createAdaptorServer({ fetch: app.fetch });

  server.on('error', (error: unknown) => {
    // `process.stderr.write` を使わない: fd がパイプだと非同期で、直後の exit に巻き込まれて行が消えるため。
    writeStderrSync(`alteroid-runner: 待ち受けに失敗しました: ${reasonOf(error)}\n`);
    process.exit(1);
  });

  const socketPath = envValue(process.env, 'ALTEROID_RUNNER_SOCKET');
  let listeningOn: string;

  if (socketPath !== undefined) {
    rmSync(socketPath, { force: true });
    mkdirSync(dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
    const owner = socketOwnerOf(process.env);
    if (owner !== undefined) chownSync(socketPath, owner.uid, owner.gid);
    chmodSync(socketPath, 0o600);
    listeningOn = `unix:${socketPath}`;
  } else {
    const port = Number(process.env.ALTEROID_RUNNER_PORT ?? '4518');
    const hostname = process.env.ALTEROID_RUNNER_BIND || '127.0.0.1';
    await new Promise<void>((resolve) => server.listen({ port, host: hostname }, resolve));
    listeningOn = `http://${hostname}:${port}`;
    process.stdout.write(
      'alteroid-runner: TCP で待ち受けています。マネージャーと同じ器から届く口なので、' +
        '本番では ALTEROID_RUNNER_SOCKET を使ってください。\n',
    );
  }

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    server.close();
    if (socketPath !== undefined) rmSync(socketPath, { force: true });
    peerOpening.host?.close();
    const forced = setTimeout(() => process.exit(0), FORCED_EXIT_MS);
    forced.unref();
    await host.shutdown().catch(() => undefined);

    await drainAndReportOutbox(outbox);

    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // 置かれた帯を黙って通さない: 上位帯から降りたことが起動ログに出ていないと、誰も気づけないため。
  for (const { key, value, fallback } of placedManagerModels(process.env)) {
    process.stdout.write(
      `alteroid-runner: ${key} が置かれています（既定 ${fallback} → ${value}）。` +
        `以後この runner が起こすセッションはこの帯で走ります。` +
        `既定へ戻すにはこの環境変数を外してください\n`,
    );
  }

  const placedProvider = placedAgentProvider(process.env, MANAGER_PROVIDER_ENV_KEY);
  if (placedProvider !== null) {
    process.stdout.write(
      `alteroid-runner: ${MANAGER_PROVIDER_ENV_KEY} が置かれています` +
        `（既定 ${DEFAULT_AGENT_PROVIDER_ID} → ${managerProvider.id}）。` +
        `以後この runner が起こすマネージャーと作業者はこの provider で走ります\n`,
    );
  }

  for (const notice of peerOpening.notices) process.stdout.write(`${notice}\n`);

  process.stdout.write(
    `alteroid-runner: ${listeningOn} （runner_id: ${runnerId} / 作業: ${workspacePath}` +
      `${childUser === undefined ? '' : ` / 子プロセス: uid ${childUser.uid}`}` +
      ` / 孤児の観測: ${
        reclaimScan === undefined
          ? '切'
          : reclaimScan.reap === undefined
            ? 'observe（終端した委譲の木だけ畳む。素性の分からない孤児は撃たない）'
            : '回収（撃つ。既定）'
      }` +
      ` / 帯: ${resolveManagerModel(process.env)} → ${resolveWorkerModel(process.env)}）\n`,
  );
}

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
  // module のトップレベルにも `main()` の中にも置かない: 前者は `main` を import するテストにまで網が張られ、後者は `main()` の頭までの窓が開くため。
  installUncaughtNet('alteroid-runner');

  main().catch((error: unknown) => {
    writeStderrSync(`alteroid-runner: 起動に失敗しました: ${reasonOf(error)}\n`);
    process.exit(1);
  });
}
