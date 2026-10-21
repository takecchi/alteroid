#!/usr/bin/env node
// 最初の import に置く（枠の大きさは最初に枠を使う処理で決まる。理由は packages/core/src/threadpool-size.ts）
import '@alteroid/core/threadpool-size';

import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  chownSync,
  constants,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createCredentialStore,
  createProfileVessel,
  createRunnerHost,
  defaultRunnerPluginsRoot,
  pruneRunnerPluginsOnBoot,
  runnerPluginsDirOptions,
  ANTHROPIC_ROUTE_NONE_LINE,
  DEFAULT_PROFILE_PATH,
  installUncaughtNet,
  agentProviderOf,
  placedManagerModels,
  reasonOf,
  readExecutionResources,
  applyAttachmentRequestTimeout,
  applyRunnerKeepAlive,
  resolveManagerModel,
  resolveWorkerModel,
  retiredLayerProviderNotices,
  WITHHELD_ENV_KEYS,
  writeStderrSync,
  type RunnerChildUser,
  type RunnerHost,
  writeStderrLine,
} from '@alteroid/core';
import { createAdaptorServer } from '@hono/node-server';

import { createRunnerApp, formatOutboxShutdownReport, Outbox } from './app.js';
import { openManagerToolsSocket } from './manager-tools-socket.js';
import { planPeerSocket } from './peer-socket.js';
import { gateDuringShutdown, waitForPickups } from './shutdown-pickups.js';
import {
  startReclaimSweep,
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

/** 入口で作る HTTP サーバ。要求の期限と keep-alive の持ち時間を掛けて返す（試験で配線を縛るために入口から切り出した。#4915）。 */
export function createRunnerHttpServer(
  fetchHandler: Parameters<typeof createAdaptorServer>[0]['fetch'],
): Server {
  // 既定（`createServer` を渡さない）は HTTP/1.1 の `node:http` のサーバ。型は HTTP/2 との合併なので絞る
  const server = createAdaptorServer({ fetch: fetchHandler }) as Server;
  // 大きいファイルの別口（2 GiB）が Node 既定の 300 秒で切られないように
  applyAttachmentRequestTimeout(server as unknown as { requestTimeout: number });
  // デーモンが心拍（10秒）を越えて接続を使い回せるように、サーバのほうが先に閉じないようにする（#4890）。
  // Node の既定は 5 秒で、そのままだとデーモンの接続は毎回切られ、名前解決と接続をやり直す。
  // SSE（`/events`）のように応答を流している最中の接続は、keep-alive の持ち時間では畳まれない。
  applyRunnerKeepAlive(server as unknown as { keepAliveTimeout: number; headersTimeout: number });
  return server;
}

// 黙って無視しない: 置いた人間は効いていると思ったままになるため。起動は止めない。
export function reportRetiredLayerProviderEnv(
  env: NodeJS.ProcessEnv,
  write: (line: string) => void = writeStderrSync,
): void {
  for (const notice of retiredLayerProviderNotices(env, 'alteroid-runner')) write(`${notice}\n`);
}

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

// 預けた物が取られるのを待つ上限（SIGTERM から）。forced exit（`FORCED_EXIT_MS`）より 5 秒手前にする: 待ち終えた後に口を閉じて exit する分を残すため
export const PICKUP_WAIT_LIMIT_MS = FORCED_EXIT_MS - 5_000;

// 預けた生ログがここまでに取られなければ、本文を載せて送り直す（SIGTERM から。#4896）。上限（`PICKUP_WAIT_LIMIT_MS`）の 20 秒手前: 大きい本文を SSE で流し切る時間を残すため
export const ARCHIVE_INLINE_AFTER_MS = PICKUP_WAIT_LIMIT_MS - 20_000;

// 畳みの時間の積み上げ（#4925。Railway の猶予 `SHUTDOWN_GRACE_MS` 60秒 → `FORCED_EXIT_MS` 55秒 → `PICKUP_WAIT_LIMIT_MS` 50秒）:
//   0秒 SIGTERM → 30秒 `ARCHIVE_INLINE_AFTER_MS`（`shutdown()` の途中でも、並行のタイマーが退避を送り直す）
//   → 50秒 `PICKUP_WAIT_LIMIT_MS`（`shutdown()` の完了と取られるのを待つ上限。口を閉じて exit へ進めるのは、`shutdown()` が終わってから）
//   → 最大 53秒 出し箱の流し切り（`DRAIN_WAIT_MS` 3秒）→ 55秒 forced exit → 60秒 SIGKILL
// `shutdown()` の待ちを 30秒で切らない: 未 push の確認・退避 ref の push の途中で exit すると、その作業が失われるため。

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

/**
 * 担当を畳み、SSE を流し切り、預けた物が取られてから口を閉じる（#4699）。
 * 口を先に閉じない: 畳みで預けた生ログと出し箱の退避先は、デーモンが HTTP で取りに来るため。閉じていると器の入れ替えのたびに失われる。
 * 畳みの間に入ってくる要求は、入口の門（`gateDuringShutdown`）が取りに来る分だけに絞る。
 */
export async function shutdownHandingOver(deps: {
  host: Pick<RunnerHost, 'shutdown' | 'pendingPickups'> &
    Partial<Pick<RunnerHost, 'inlineUnpickedArchives'>>;
  outbox: Outbox;
  closeListener: () => void;
  startedAt?: number;
  drainWaitMs?: number;
  pickupWaitLimitMs?: number;
  inlineArchivesAfterMs?: number;
  write?: (line: string) => void;
}): Promise<void> {
  const startedAt = deps.startedAt ?? Date.now();
  const limitMs = deps.pickupWaitLimitMs ?? PICKUP_WAIT_LIMIT_MS;
  const inlineAtMs = Math.min(deps.inlineArchivesAfterMs ?? ARCHIVE_INLINE_AFTER_MS, limitMs);
  const afterMs = (atMs: number): number => Math.max(0, startedAt + atMs - Date.now());

  // 送り直しの判定を `shutdown()` と並べて走らせる（#4925）: `shutdown()` が長引いても、SIGTERM から `inlineAtMs` で、
  // まだ取られていない退避を送り直す。二度は送らない: `inlineUnpickedArchives` が送った分を預かりから外す
  const inlineTimer = setTimeout(() => {
    if (
      !deps.outbox.subscribed ||
      deps.host.inlineUnpickedArchives === undefined ||
      deps.host.pendingPickups() === 0
    ) {
      return;
    }
    const sent = deps.host.inlineUnpickedArchives();
    if (sent > 0) {
      (deps.write ?? writeStderrSync)(
        `alteroid-runner: 畳みの途中で、デーモンが取りに来なかった生ログの退避 ${String(sent)} 件を、本文を載せて送り直した\n`,
      );
    }
  }, afterMs(inlineAtMs));

  // `shutdown()` の完了を待つのは、従来どおり待ちの上限（`limitMs`）まで: 終わる前に口を閉じて exit すると、
  // 畳みの途中の push・未 push の確認が切られる。上限を超えて終わらないときだけ、待ちの段へ進む
  let capTimer: NodeJS.Timeout | undefined;
  const cap = new Promise<void>((resolve) => {
    capTimer = setTimeout(resolve, afterMs(limitMs));
  });
  try {
    await Promise.race([deps.host.shutdown().catch(() => undefined), cap]);
  } finally {
    clearTimeout(capTimer);
  }

  try {
    await handOverPickups();
  } finally {
    clearTimeout(inlineTimer);
  }
  deps.closeListener();

  async function handOverPickups(): Promise<void> {
    await drainAndReportOutbox(deps.outbox, {
      ...(deps.drainWaitMs === undefined ? {} : { waitMs: deps.drainWaitMs }),
      ...(deps.write === undefined ? {} : { write: deps.write }),
    });

    // 1段目: 取られるのを待つ。ここまでに取られなかった預けた生ログは、本文を載せて送り直す（#4896）。
    // 上限ぎりぎりまで待ってから送ると、SSE に載せて流し切る時間が残らないため、上限より手前で一度切る
    let left = await waitForPickups({
      pending: () => deps.host.pendingPickups(),
      subscribed: () => deps.outbox.subscribed,
      deadlineAt: startedAt + inlineAtMs,
    });
    if (left > 0 && deps.outbox.subscribed && deps.host.inlineUnpickedArchives !== undefined) {
      const sent = deps.host.inlineUnpickedArchives();
      if (sent > 0) {
        (deps.write ?? writeStderrSync)(
          `alteroid-runner: デーモンが取りに来なかった生ログの退避 ${String(sent)} 件を、本文を載せて送り直した\n`,
        );
        await waitForOutboxDrain(deps.outbox, deps.drainWaitMs ?? DRAIN_WAIT_MS);
      }
    }
    // 2段目: 残り（出し箱の退避先など）を上限まで待つ
    left = await waitForPickups({
      pending: () => deps.host.pendingPickups(),
      subscribed: () => deps.outbox.subscribed,
      deadlineAt: startedAt + limitMs,
    });
    if (left > 0) {
      (deps.write ?? writeStderrSync)(
        `alteroid-runner: 畳みで預けた物のうち ${String(left)} 件を、デーモンが取りに来ないまま止まる（生ログの退避・出し箱の退避先）\n`,
      );
    }
  }
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

// 委譲の CLI の引き取り手（`tini -s`）を PATH から探す（#4494）。子の UID へ降ろさない構成では使わない: 委譲を自前で起こす経路（`spawnProcess`）がそもそも無いため。
// 見つからなければ `undefined`（CLI を直に起こす）。起動ログに出すので黙っては倒れない。
export function delegationSubreaperOf(
  env: NodeJS.ProcessEnv = process.env,
  childUser: RunnerChildUser | undefined = childUserOf(env),
  isExecutable: (path: string) => boolean = executableFile,
): string | undefined {
  if (childUser === undefined) return undefined;
  for (const dir of (envValue(env, 'PATH') ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, 'tini');
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
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
      ...(view.ownerListedSessionPidsOf === undefined
        ? {}
        : { ownerListedSessionPidsOf: view.ownerListedSessionPidsOf }),
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

  // 展開先を `/workspace` に置かない: 子の持ち物のため。置き場が volume の構成では前の器の展開物が残るので、起動時にまとめて消す
  const pluginsRoot = envValue(process.env, 'ALTEROID_PLUGINS_DIR') ?? defaultRunnerPluginsRoot();
  // 置き場が信頼できなければ片づけない: root 権限で他人が差し替えられるディレクトリの中を chmod・削除しないため
  const prunedPlugins = await pruneRunnerPluginsOnBoot(
    pluginsRoot,
    runnerPluginsDirOptions(),
    (line) => writeStderrLine(line),
  );
  if (prunedPlugins !== undefined && prunedPlugins.removed.length > 0) {
    process.stdout.write(
      `alteroid-runner: 前の器の plugin の展開物 ${prunedPlugins.removed.length} 件を消しました\n`,
    );
  }

  // ソケットはここでは開かない: 開く条件は Codex の資格で、届くのはデーモンが繋いだ後のため
  const peerPlan = planPeerSocket(process.env, childUser);
  // こちらは資格を待たずに開く: どの器のマネージャーにも出す道具のため
  const managerToolsHost = await openManagerToolsSocket(childUser);
  const delegationSubreaper = delegationSubreaperOf(process.env, childUser);
  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId,
    workspacePath,
    emit: (event) => {
      if (event.type === 'anthropic_route') {
        // 空になった（外れた）ときも1行出す: 出さないと、警告が消えたのか出し直しが無かったのか読めない
        const lines =
          event.anthropicRoute.length === 0 ? [ANTHROPIC_ROUTE_NONE_LINE] : event.anthropicRoute;
        for (const line of lines) process.stdout.write(`alteroid-runner: ${line}\n`);
      }
      outbox.push(event);
    },
    // 実効の値が変わったときの出し直し（`Bash の形の歯`）。新しいプロトコルの出来事は足さない
    log: (line) => process.stdout.write(`${line}\n`),
    credentials,
    pluginsRoot,
    peer: {
      openSocket: peerPlan.openSocket,
      models: peerPlan.models,
      reportsUsage: (provider) => agentProviderOf(provider).capabilities.usage,
    },
    ...(managerToolsHost === undefined ? {} : { managerTools: { host: managerToolsHost } }),
    profile,
    ...(childUser === undefined ? {} : { childUser }),
    // 自己失効はこの器だけが有効にする: 同一プロセスの `runner-local` では「デーモンだけが消える」ことが起こり得ないため。
    enforceLease: true,
    ...(delegationSubreaper === undefined ? {} : { delegationSubreaper }),
    // 器の pids が上限に近いとき、走っている担当に知らせる（runner-pids-pressure.ts）。cgroup が読めない器では `undefined` で、何も添えない
    readPidsFn: async () => (await readExecutionResources()).pids,
  });

  const reap: ReclaimReapOptions = {
    liveSessionPidsOf: () => host.delegationSessionPids().live,
    knownTerminatedSessionPidsOf: () => host.delegationSessionPids().knownTerminated,
    ownerListedSessionPidsOf: () => host.delegationSessionPids().ownerListed,
    // `live` の集合の大きさでは代用しない: `anyTrackedDelegationsOf` の理由と同じ。
    anyTrackedDelegationsOf: () => host.list().length > 0,
  };

  const reclaimScan = withTerminatedReclaimSessions(
    reclaimScanOf(process.env, childUser, reap),
    reap,
  );

  // 既定（`app.ts` 側の `new TaskBreakdownReader()`）に任せない: 降ろす UID を知らず、観測が動かないため。
  // 引き取り手（#4494）も観測に載せる: 起動ログにしか出ないと、クローンから効いているかを確かめられないため。走査があるのは子の UID へ降ろす構成だけなので、`null` は「探したが無かった」である
  const taskBreakdownReader = new TaskBreakdownReader({
    ...(reclaimScan === undefined
      ? {}
      : { reclaim: { ...reclaimScan, delegationSubreaper: delegationSubreaper ?? null } }),
  });

  // 回収が無効なら起こさない: 走査しても何も撃たず、`/proc` を読むだけになるため。
  const stopReclaimSweep =
    reclaimScan === undefined ? undefined : startReclaimSweep(taskBreakdownReader);

  const app = createRunnerApp({
    host,
    outbox,
    tokenSha256,
    taskBreakdownReader,
    managerModel: resolveManagerModel(process.env),
    workerModel: resolveWorkerModel(process.env),
  });
  let stopping = false;
  // 畳みの間は、デーモンが取りに来る要求だけを通す（#4699。`shutdown-pickups.ts`）
  const server = createRunnerHttpServer(gateDuringShutdown(app.fetch, () => stopping));

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

  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    const forced = setTimeout(() => process.exit(0), FORCED_EXIT_MS);
    forced.unref();
    await shutdownHandingOver({
      host,
      outbox,
      closeListener: () => {
        server.close();
        if (socketPath !== undefined) rmSync(socketPath, { force: true });
      },
    });

    // `host.shutdown()` より先に止めない: 畳んだ委譲の木が、終わるまで SIGKILL を受けられるように。
    stopReclaimSweep?.();

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

  // この時点の袋は0件・プロファイルも未着（後からデーモンが降ろす）。降りて変われば上の `emit` が出し直す。
  for (const line of host.anthropicRoute()) process.stdout.write(`alteroid-runner: ${line}\n`);

  // 既定 off の設定を黙って通さない: 開けた器か閉じた器か、起動行から読めるように。降りたプロファイルで変われば `log` が出し直す
  process.stdout.write(`alteroid-runner: ${host.bashShapeGuardLine()}\n`);
  process.stdout.write(`alteroid-runner: ${host.reportLanguageLine()}\n`);

  reportRetiredLayerProviderEnv(process.env);

  for (const notice of peerPlan.notices) process.stdout.write(`${notice}\n`);

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
      `${
        childUser === undefined
          ? ''
          : ` / 委譲の引き取り手: ${
              delegationSubreaper === undefined
                ? '無し（tini が PATH に無い。setsid で抜けた子孫は誰のものか分からず撃たれない）'
                : `${delegationSubreaper} -s`
            }`
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
