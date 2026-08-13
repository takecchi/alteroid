#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { serve } from '@hono/node-server';

import {
  CLONE_MODEL,
  CLONE_MODEL_ENV_KEY,
  createClone,
  createLocalRunner,
  createRunnerRegistry,
  createScheduler,
  dailyReportEvent,
  missingDailyReportDates,
  resolveCloneModel,
  type RunnerClient,
  type Stores,
} from '@alteroid/core';

import { createApp } from './app.js';
import { planAuth } from './auth.js';
import { createJournalBus } from './journal-bus.js';
import { createHttpRunner, RunnerHttpError } from './runner-client.js';
import { clearRuntimeInfo, writeRuntimeInfo } from './runtime.js';
import { buildSchedule, readScheduleConfig } from './schedule.js';
import { openStorage } from './storage.js';

export { createApp, type AppDeps, type AppType } from './app.js';
export {
  AUTH_ENV,
  AUTH_WITHHELD_ENV_KEYS,
  GOOGLE_CLIENT_ID_ENV,
  GOOGLE_CLIENT_SECRET_ENV,
  PUBLIC_URL_ENV,
  TOKEN_TTL_ENV,
  planAuth,
  type AuthPlan,
  type Principal,
} from './auth.js';
/**
 * spec 生成専用のスタブで `createApp` を呼び、`/openapi.json` を叩いて JSON を
 * 得る（`apps/daemon/scripts/write-openapi.mjs` が使う本体）。デーモンを実際に
 * 起動せずに spec だけ欲しい呼び出し元（生成クライアントのビルドなど）向けに
 * ここからも引けるようにしておく。
 */
export { buildOpenApiDocument } from './openapi.js';
export { createJournalBus, type JournalBus } from './journal-bus.js';
export { openStorage, DATABASE_URL_ENV, type Storage } from './storage.js';
export { createHttpRunner, RunnerHttpError, type HttpRunnerOptions } from './runner-client.js';
export {
  buildSchedule,
  readScheduleConfig,
  DEFAULT_DAILY_REPORT_AT,
  DEFAULT_INITIATIVE_EVERY_MINUTES,
  DEFAULT_REPORT_LOOKBACK_DAYS,
  type ScheduleConfig,
} from './schedule.js';
export {
  parseRuntimeInfo,
  readRuntimeInfo,
  runtimeFilePath,
  type DaemonRuntimeInfo,
} from './runtime.js';

/**
 * 待ち受けるアドレス。既定は 127.0.0.1 のまま。
 *
 * **これは方針であって能力の削除ではない**（方針は設定で開けられる — north_star
 * 禁止2）。コンテナの外へ出したいなら開けられるが、開けた側が手前に境界
 * （リバースプロキシ・トンネル・認証）を置くこと。この API は叩けば
 * クローンのターンが起きる実行の口である。
 */
const DEFAULT_BIND = '127.0.0.1';

/**
 * runner が戻ってくるのを待つ上限と、待ち方。
 *
 * **同時に再デプロイされた runner を待てないと、デーモンが道連れで落ちる。**
 * 落ちている間はクローンのターンも `/approvals` への回答も受け付けられないので、
 * 「人間の不在で止まってよいのは承認待ちの仕事だけ」という前提が崩れる
 * （PRD「自律」）。器の入れ替えは分単位では終わらない方が珍しいので、そこまでは
 * 待つ。それを越えても繋がらないなら、黙って上がったふりをせずに落ちる。
 *
 * **ここは踏み込みが足りていない。** 待っている間デーモンは待ち受けを開かないが、
 * chat・日誌・日報・承認への回答は runner に一切依存しない。委譲先が不在なだけで
 * それらまで止めているのは、「人間の不在で止まってよいのは承認待ちの仕事だけ」
 * （PRD「自律」）に照らすと弱い。素直な形は「先に listen し、runner へは背景で
 * 繋ぎ直し続け、委譲だけが一時的に失敗する」である（roadmap M5 で runner の
 * 登録・生存判定を入れるときに一緒に倒す）。
 */
const RUNNER_CONNECT_WINDOW_MS = 120_000;
const RUNNER_CONNECT_MAX_DELAY_MS = 15_000;

/**
 * 委譲先を開く。
 *
 * `ALTEROID_RUNNER_URL` があれば、そこが manager-runner である（コンテナ構成）。
 * 無ければ同一プロセスの runner に落とす — `alteroid chat` を叩くだけで使える
 * というローカルの体験を、分離のために壊さないため。
 */
async function openRunner(workspace: string, withheldEnvKeys: string[]): Promise<RunnerClient> {
  const url = process.env.ALTEROID_RUNNER_URL;
  if (url !== undefined && url.length > 0) {
    const token = process.env.ALTEROID_RUNNER_TOKEN;
    if (token === undefined || token.length === 0) {
      // 鍵なしで繋がる制御面は、runner の中のマネージャーからも叩ける。
      // **その状態でつなぐくらいなら起動しない。**
      throw new Error(
        'ALTEROID_RUNNER_URL があるのに ALTEROID_RUNNER_TOKEN が無い' +
          '（runner の制御面は鍵で守る。runner には sha256 を渡すこと）',
      );
    }
    return connectRunner(url, token);
  }
  return createLocalRunner({
    runnerId: 'runner-local',
    workspacePath: workspace,
    withheldEnvKeys,
  });
}

/**
 * runner へ繋ぐ。**居なければ、戻ってくるまで待つ。**
 *
 * 待つのは「繋がらない」ときだけである。**方針の誤りは待っても直らない**ので、
 * 鍵が無いときは上の `openRunner` が、鍵を拒まれたときはここが即座に落とす。
 * 粘るのは器の入れ替え（デプロイ・再起動）だけを相手にしている。
 */
async function connectRunner(baseUrl: string, token: string): Promise<RunnerClient> {
  const deadline = Date.now() + RUNNER_CONNECT_WINDOW_MS;
  let delay = 1_000;
  for (;;) {
    try {
      return await createHttpRunner({ baseUrl, token });
    } catch (error) {
      // **鍵を拒まれたなら、待っても直らない。** ここで粘ると、設定の誤りが
      // 「器の入れ替え中かもしれません」という嘘のメッセージで2分間隠れる。
      if (error instanceof RunnerHttpError && (error.status === 401 || error.status === 403)) {
        throw new Error(
          `runner (${baseUrl}) に鍵を拒まれました（${error.status}）。` +
            'ALTEROID_RUNNER_TOKEN と runner の ALTEROID_RUNNER_TOKEN_SHA256 が揃っているか確かめてください。',
          { cause: error },
        );
      }
      if (Date.now() >= deadline) throw error;
      // **黙って待たない。** 上がらない理由を探す人間が最初に見るのはここである。
      process.stderr.write(
        `alteroidd: runner (${baseUrl}) に繋がりません。` +
          `${Math.round(delay / 1000)} 秒後に試し直します: ${String(error)}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, RUNNER_CONNECT_MAX_DELAY_MS);
    }
  }
}

/**
 * alteroidd — 常駐デーモン。
 *
 * 常駐は自律の前提であり、後から足す機能ではない（PRD）。M1 の時点で人間が
 * chat を開いていなくてもクローンは生きている。
 */
export async function main(): Promise<void> {
  // 記憶の置き場（ローカルの fs か、クラウドの PostgreSQL か）。器が違っても
  // 上の階層は同じものを見る（roadmap M4 受け入れ基準1）。
  const storage = await openStorage();
  const { paths } = storage;

  // 日誌を購読できる形にしてから配る。**クローンもデーモンも同じ器を使う**ので、
  // どこから追記されても `GET /journal/stream` に流れる（人間が聞きに行かなくても
  // 承認待ちが出たことに気づける）。ここを通さない書き手を作らないこと。
  const journalBus = createJournalBus(storage.stores.journal);
  const stores: Stores = { ...storage.stores, journal: journalBus.journal };

  // クローンのセッションは人格データディレクトリを基準に置く。呼び出し元の
  // カレントディレクトリに依存させると、別の場所から起動した瞬間に resume が
  // 迷子になる（同一性は記憶に宿るとはいえ、無駄に文脈を捨てない）。
  // マネージャーの既定の作業ディレクトリ。人間が Claude Code を開く場所と同じ
  // 意味を持つので、クローンの cwd（人格データの置き場）とは別に決める。
  // クローンが `manager_start` に cwd を渡せば、そのつど別の場所も使える。
  const workspace = process.env.ALTEROID_WORKSPACE || process.cwd();

  // 委譲先（manager-runner）。**別プロセスが既定**である — 同じ器で走らせる限り、
  // マネージャーは `/proc/1/environ` からデーモンの環境変数＝記憶ストアの鍵に届く。
  // ローカルで runner を立てていないときだけ、同一プロセスの runner へ落とす
  // （その場合は既知の穴が残る。塞ぐのはコンテナ構成の役目である）。
  const runners = createRunnerRegistry([await openRunner(workspace, storage.withheldEnvKeys)]);

  // 層とモデル帯の対応は設計判断であり、変更には人間の承認が要る（AGENTS.md 地雷5）。
  // 差し替えられていたら**黙って通さない** — 上位帯から降りたことは人間が意図した
  // ときだけ起きるべきで、起動ログに出ていなければ誰も気づけない。
  const cloneModel = resolveCloneModel();
  if (cloneModel !== CLONE_MODEL) {
    process.stderr.write(
      `alteroidd: クローンのモデル帯を ${CLONE_MODEL} から ${cloneModel} へ差し替えています` +
        `（${CLONE_MODEL_ENV_KEY}）。既定へ戻すにはこの環境変数を外してください\n`,
    );
  }

  const clone = createClone({
    stores,
    cwd: paths.root,
    runners,
    ...(storage.sessionStore === undefined ? {} : { sessionStore: storage.sessionStore }),
  });
  const port = Number(process.env.ALTEROID_PORT ?? '4517');
  const hostname = process.env.ALTEROID_BIND || DEFAULT_BIND;

  // 起動ごとに作り直す。状態ファイルが残っていても、別プロセスを自分だと
  // 誤認させない（PID の再利用で無関係なプロセスを止めないため）。
  const token = randomUUID();

  // 時間起点のジョブ（起点② / ④）。発火は必ずクローンの受信箱を通る。
  const schedule = readScheduleConfig();
  for (const note of schedule.notes) process.stderr.write(`alteroidd: ${note}\n`);
  const scheduler = createScheduler({
    entries: buildSchedule(schedule),
    post: (event) => clone.post(event),
  });

  // **受け口を開ける前に**、走行中だったマネージャーを台帳から拾い直す。知らせない
  // と器を作り直した瞬間に走っていた仕事がクローンから見て消えるし（roadmap M4
  // 受け入れ基準2）、引き取る前に chat を開けると、同じ仕事をクローンが二重に
  // 起こしうる。
  const restored = await clone.managers.restore().catch((error: unknown) => {
    process.stderr.write(`alteroidd: マネージャーの引き継ぎに失敗しました: ${String(error)}\n`);
    return [];
  });
  if (restored.length > 0) {
    process.stdout.write(
      `alteroidd: 再起動前のマネージャーを引き継ぎました: ${restored
        .map((manager) => manager.managerId)
        .join(', ')}\n`,
    );
  }

  // 入口の認証。**設定されていなければ従来どおり要求しない** — 境界の導入が
  // 実質のデグレードにならないようにする（north_star「立ち戻るための問い」）。
  const authPlan = planAuth(process.env, { port });
  process.stderr.write(`alteroidd: ${authPlan.description}\n`);

  const app = createApp({
    clone,
    stores,
    token,
    shutdown: () => void shutdown(),
    scheduler,
    storage: storage.description,
    runners,
    journalEvents: journalBus,
    auth: { plan: authPlan },
  });
  // 開けたこと自体は方針の変更であって禁止事項ではない。ただし**黙って**外へ
  // 出さない — ここは叩けばクローンのターンが起きる実行の口である。
  if (hostname !== DEFAULT_BIND && hostname !== 'localhost' && hostname !== '::1') {
    process.stderr.write(
      authPlan.enabled
        ? `alteroidd: ${hostname} で待ち受けます。認証は有効ですが、` +
            'TLS は手前の層（リバースプロキシ・トンネル）で終端してください' +
            '（トークンが平文で流れます）。\n'
        : `alteroidd: ${hostname} で待ち受けます。この API に認証はありません。` +
            '手前に境界（リバースプロキシ・トンネル・認証）を置いてください。\n',
    );
  }

  const server = serve({ fetch: app.fetch, port, hostname });

  server.on('error', (error: unknown) => {
    process.stderr.write(`alteroidd: 待ち受けに失敗しました (port ${port}): ${String(error)}\n`);
    process.exit(1);
  });

  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;

    // 先に受け口を閉じて runtime 情報を消す。クローンの後片付け（最後の蒸留）が
    // 長引いても、CLI からは「止まった」と見えるようにする。
    scheduler.stop();
    server.close();
    await clearRuntimeInfo(paths.state).catch(() => undefined);

    const forced = setTimeout(() => process.exit(0), 30_000);
    forced.unref();
    try {
      await clone.stop();
    } catch {
      // 片付けに失敗しても落ちる
    }
    await storage.close().catch(() => undefined);
    process.exit(0);
  }

  await writeRuntimeInfo(paths.state, {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    token,
  });

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  scheduler.start();

  // 締め時刻に自分が動いていなければ、その日の日報は誰も作らない。「日報は毎日
  // 生成される」は要件なので、動いていなかった日の分を起動時に拾い直す。
  if (schedule.dailyReportAt !== null) {
    const missed = await missingDailyReportDates({
      journal: stores.journal,
      at: schedule.dailyReportAt,
      now: new Date(),
      lookbackDays: schedule.reportLookbackDays,
    }).catch(() => []);
    for (const date of missed) clone.post(dailyReportEvent(date));
    if (missed.length > 0) {
      process.stdout.write(`alteroidd: 取りこぼした日報を作ります: ${missed.join(', ')}\n`);
    }
  }

  process.stdout.write(
    `alteroidd: http://${hostname}:${port} （記憶: ${storage.description} / 作業: ${workspace}）\n`,
  );
}

/**
 * 直接起動されたときだけ main を走らせる。
 * `import.meta.url` は realpath 済み・パーセントエンコード済みなので、
 * argv[1] を素の文字列と比べると空白入りパスや symlink で誤判定する。
 */
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
    process.stderr.write(`alteroidd: 起動に失敗しました: ${String(error)}\n`);
    process.exit(1);
  });
}
