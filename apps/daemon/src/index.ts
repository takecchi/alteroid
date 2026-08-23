#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { serve } from '@hono/node-server';

import {
  CLONE_MODEL,
  CLONE_MODEL_ENV_KEY,
  CLONE_PERMISSION_MODE_ENV_KEY,
  DEFAULT_PERMISSION_MODE,
  createClone,
  createLocalRunner,
  createProfileApplier,
  createProfileService,
  createProfileVessel,
  createRunnerRegistry,
  createScheduler,
  dailyReportEvent,
  missingDailyReportDates,
  placedClonePermissionMode,
  placedManagerModels,
  reasonOf,
  resolveCloneModel,
  resolveManagerModel,
  resolveWorkerModel,
  WITHHELD_ENV_KEYS,
  type RunnerClient,
  type RunnerSource,
  type SelfFacts,
  type Stores,
} from '@alteroid/core';

import { createApp, parseAllowedOrigins } from './app.js';
import { startUsagePolling } from './usage-poller.js';
import { planAuth } from './auth.js';
import { createJournalBus } from './journal-bus.js';
import {
  createHttpRunner,
  describeRunnerDropped,
  describeRunnerUnknown,
  managerIdOfRunnerPath,
  RunnerHttpError,
  type RunnerDroppedEventReport,
  type RunnerUnknownReport,
} from './runner-client.js';
import { clearRuntimeInfo, writeRuntimeInfo } from './runtime.js';
import { buildSchedule, readScheduleConfig } from './schedule.js';
import { openStorage } from './storage.js';

export { createApp, parseAllowedOrigins, type AppDeps, type AppType } from './app.js';
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
export {
  createHttpRunner,
  describeRunnerDropped,
  describeRunnerUnknown,
  managerIdOfRunnerPath,
  RUNNER_CALL_DEADLINE_MS,
  RunnerHttpError,
  RunnerUnknownError,
  type HttpRunnerOptions,
  type RunnerDroppedEventReport,
  type RunnerUnknownReport,
} from './runner-client.js';
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

/** 複数の runner を並べる環境変数（カンマ区切り）。単数形は後方互換で残す。 */
const RUNNER_URLS_ENV = 'ALTEROID_RUNNER_URLS';
const RUNNER_URL_ENV = 'ALTEROID_RUNNER_URL';

/**
 * 器がこのプロセスを畳むまでに与える猶予。**ここにあるのは写しである。**
 *
 * 正本は `railway/daemon.json` の `drainingSeconds` と `compose.yaml`（`app`）の
 * `stop_grace_period` で、**どちらも実行中のプロセスからは読めない**（Railway の
 * deploy 設定も compose の設定も環境変数として降りてこない）。環境変数で渡す形に
 * すると、猶予そのものと env がずれる二重管理が新しく増えるだけなので、写しを持って
 * 対応関係をここに書くほうを選んでいる。**あちらを変えるならここも変えること**
 * （`railway/README.md`「畳む時間を渡す」に逆向きの導線がある）。
 */
const SHUTDOWN_GRACE_MS = 60_000;

/**
 * SIGTERM から、自分で見切りをつけて `exit` するまで。
 *
 * **猶予と同着にしないための5秒である。** 猶予が切れる時刻には器の SIGKILL が来る
 * ので、ここを `SHUTDOWN_GRACE_MS` ちょうどにすると、「行儀よく終われなかったときに
 * それでも自分の意思で終わる」という最後の口が SIGKILL に負けて消える。**揃えない
 * こと。** 5秒は `process.exit(0)` が確実に先に走るための余裕であって、片付けに使う
 * 作業時間ではない。
 */
const FORCED_EXIT_MS = SHUTDOWN_GRACE_MS - 5_000;

/**
 * TCP keepalive の初回プローブまでの待ち時間（ms）。
 *
 * **`server.timeout`（Node の socket アイドルタイムアウト）は入れない。** あれは
 * 「無通信で `timeout` ms」を見るが、`write()` を呼ぶたびに（相手に届いたかどうかは
 * 関係なく）タイマーがリセットされる（実測: ローカルの `net` サーバで `setTimeout(1000)`
 * を張り、400ms ごとに `write()` し続けると `timeout` は発火せず、書き込みを止めた
 * 約800ms後に発火した——ちょうど最後の書き込みから1000msの近傍である）。
 * SSE の heartbeat（`@alteroid/core` の `sse-heartbeat.ts`）と組み合わせると**発火しない設定**になり、
 * heartbeat が無い経路（将来増えるなら）では逆に「イベントが来ないだけの健全な
 * 長時間接続」を時間で切ってしまう。掃除したいのは**死んだ接続**であって
 * **静かな接続**ではない——静かなことを理由に切るのは、長時間つないでおく能力を
 * 削ることになる（north_star 禁止2）。
 *
 * 代わりに **TCP keepalive** を使う。こちらは OS が相手に生死を確かめにいく
 * （プローブに応答が無ければ OS 自身が接続を諦める）ので、アプリが書き込んで
 * いない間も効く。**ただし検知にかかる時間は OS の設定に依存し、Node からは
 * `initialDelay`（最初のプローブまでの待ち）しか制御できない** ——
 * プローブの間隔・回数（Linux の `tcp_keepalive_intvl` / `tcp_keepalive_probes`）は
 * カーネル側の設定で、コンテナ環境では触れないこともある。「無音死を確実に
 * N 秒で検知する」とは言えない——言えるのは「検知される経路が生まれる」までである。
 * fd の枯渇を防ぐという今回の目的には、既定（Linux で probes=9, intvl=75s なら
 * この待ち時間 + 十数分程度）でも十分間に合う。
 *
 * ## ⚠️ ここの方針を、デーモンが**繋ぎに行く**側へ当てはめないこと（#323）
 *
 * 上の「静かなことを理由に切らない」は**デーモンが受ける側**の話である。
 * **繋ぎに行く側の `GET /events`（daemon → runner の SSE）には、意図して
 * 無音の見張りが置いてある** —— `apps/daemon/src/runner-client.ts` の
 * `RUNNER_STREAM_SILENCE_TIMEOUT_MS`。
 *
 * **矛盾していない。** 違うのは**相手が黙る自由を持つかどうか**である。ここは
 * 受ける側の全経路が対象で、heartbeat を持たない経路が将来増えれば「イベントが
 * 来ないだけの健全な長時間接続」を切ってしまう。あちらは `/events` ただ1本で、
 * **相手（runner）は接続のたびに無条件で `startSseHeartbeat` を回す**
 * （`apps/runner/src/app.ts` の `/events`）。**＝ あの経路の健全な接続は、契約
 * として無音にならない。** だからあそこでの無音は「静か」ではなく「死んで
 * いる」の観測である。
 *
 * **この節が在るのは、片側にしか理由を書かないと消されるからである。** ここの
 * 方針だけを読んだ人には、あちらの見張りが違反に見える。理由の全文は
 * `RUNNER_STREAM_SILENCE_TIMEOUT_MS` の doc に在る。
 */
const TCP_KEEPALIVE_DELAY_MS = 30_000;

/**
 * 起動時の種になる runner の宛先。
 *
 * `ALTEROID_RUNNER_URLS`（カンマ区切り）と `ALTEROID_RUNNER_URL`（単数）の両方を
 * 読む。**単数形を落とさない** — 既に動いている構成が、名簿を複数化しただけで
 * 委譲先を失うことになる。空白と重複は落とすが、それ以外は書かれたまま使う。
 */
export function parseRunnerUrls(env: NodeJS.ProcessEnv): string[] {
  const raw = [...(env[RUNNER_URLS_ENV] ?? '').split(','), env[RUNNER_URL_ENV] ?? ''];
  const urls: string[] = [];
  for (const value of raw) {
    const url = value.trim();
    if (url.length === 0 || urls.includes(url)) continue;
    urls.push(url);
  }
  return urls;
}

/**
 * 委譲先の**開き方**を並べる。**ここでは1台も開かない。**
 *
 * 開くのは名簿の仕事（背景）である。ここが接続を返す形だと、デーモンは runner が
 * 上がるまで待ち受けを開けず、その間 chat も日誌も承認も止まる — 委譲先が不在な
 * だけで、runner に一切依存しない経路まで止めていることになる（PRD「自律」）。
 *
 * **方針の誤りだけはここで落とす。** 鍵が無いのに URL があるのは待っても直らない
 * 誤りで、その状態で繋ぐくらいなら起動しない（鍵なしで繋がる制御面は、runner の
 * 中のマネージャーからも叩ける）。
 */
function runnerSeeds(options: {
  workspace: string;
  withheldEnvKeys: string[];
  profilePath: string;
  /**
   * 「期限内に応答が返らなかった」の受け口。**日誌へ落とすのはここより上**である
   * （`main()` が `stores.journal` を持っている）。
   */
  onRunnerUnknown: (report: RunnerUnknownReport) => void;
  onRunnerDropped: (report: RunnerDroppedEventReport) => void;
}): RunnerSource[] {
  const urls = parseRunnerUrls(process.env);
  if (urls.length > 0) {
    const token = process.env.ALTEROID_RUNNER_TOKEN;
    if (token === undefined || token.length === 0) {
      throw new Error(
        `${RUNNER_URLS_ENV} / ${RUNNER_URL_ENV} があるのに ALTEROID_RUNNER_TOKEN が無い` +
          '（runner の制御面は鍵で守る。runner には sha256 を渡すこと）',
      );
    }
    return urls.map((url) => ({
      label: url,
      open: () => openHttpRunner(url, token, options.onRunnerUnknown, options.onRunnerDropped),
    }));
  }
  return [
    {
      label: '同一プロセス',
      open: async () =>
        createLocalRunner({
          runnerId: 'runner-local',
          workspacePath: options.workspace,
          withheldEnvKeys: options.withheldEnvKeys,
          // **ローカルでもプロファイルを効かせる。** コンテナ構成でだけ `.zprofile`
          // が効く形にすると、器が違うだけでできることが変わる（M4 受け入れ基準1）。
          // クローン側とは別のファイルにする — こちらには伏せる鍵の `unset` が付く。
          profile: createProfileVessel({
            path: options.profilePath,
            withheldEnvKeys: [...WITHHELD_ENV_KEYS, ...options.withheldEnvKeys],
          }),
        }),
    },
  ];
}

/**
 * HTTP の runner を1回だけ開く。**ここでは粘らない**（挑み直すのは名簿の仕事）。
 *
 * 鍵を拒まれたことは**恒久的な失敗のまま持ち上げる**。ここで素の `Error` に
 * 包み直すと、名簿は「待てば直る」と読んで永久に叩き続け、設定の誤りが
 * 「なぜか繋がらない」として隠れる（`isRetryableRunnerError`）。
 */
async function openHttpRunner(
  baseUrl: string,
  token: string,
  onUnknown: (report: RunnerUnknownReport) => void,
  onDroppedEvent: (report: RunnerDroppedEventReport) => void,
): Promise<RunnerClient> {
  try {
    return await createHttpRunner({ baseUrl, token, onUnknown, onDroppedEvent });
  } catch (error) {
    if (error instanceof RunnerHttpError && (error.status === 401 || error.status === 403)) {
      throw new RunnerHttpError(
        `runner (${baseUrl}) に鍵を拒まれた（${error.status}）。` +
          'ALTEROID_RUNNER_TOKEN と runner の ALTEROID_RUNNER_TOKEN_SHA256 が揃っているか確かめること。',
        error.status,
      );
    }
    throw error;
  }
}

/**
 * 委譲先の器を一行で説明する（クローンの自己認識に載る）。
 *
 * **同一プロセスであることを隠さない。** ローカル構成では既知の穴が残っており
 * （マネージャーが `/proc/1/environ` から記憶ストアの鍵に届く）、それを承知で
 * 動いているのが事実である。事実を伏せた自己認識は自己認識ではない。
 *
 * **「繋がっている」とも言わない。** 名簿は動的で、ここに並ぶのは宛先であって
 * 生死ではない（生死は `GET /runners` が返す）。
 */
function describeRunner(): string {
  const urls = parseRunnerUrls(process.env);
  return urls.length > 0
    ? `別プロセスの manager-runner（${urls.join(', ')}）。マネージャーはそこで走り、記憶ストアの鍵を持たない。` +
        '繋ぐのは背景なので、上がっていなければ委譲だけが待たされる'
    : '同一プロセスの runner（ローカル構成）。マネージャーはデーモンと同じ器で走るので、記憶ストアへの経路が残っている';
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
  //
  // **ここでは開かない。** 宛先（開き方）を数えるだけで、繋ぐのは待ち受けを開いた
  // 後の背景である。開き終わるまで待つ形だと、runner の入れ替えに巻き込まれて
  // chat も日誌も承認も止まる（PRD「自律」）。
  /**
   * 「不明」を日誌へ落とす。**ここを繋がないと期限を付けた意味が無い。**
   *
   * ファイルの中で正しく分類できても、クローンの受信箱に「まだ走っている」しか
   * 出ないなら、クローンは永久に待つ（＝直したことにならない）。日誌はクローンが
   * `journal_read` で読む既存の経路で、`apps/daemon` から書けるのもここだけである。
   * **新しい通知の仕組みは足さない** — 同じ契約が2つになる。
   *
   * `external_event` にするのは、これが**デーモンから見た外側の観測**だからである
   * （マネージャーとのやり取りではない）。マネージャーの id は文面に載る。
   *
   * **載せるのはマネージャー1本を指す不明だけである。** 器の生死や設定の押し込みの
   * 不明は既に別の経路が持っており（名簿の生存判定・`GET /runners`・`Pool.abort` の
   * 「止まったかは未確認」）、そこを日誌へも流すと同じ契約が2つになる。**加えて、
   * 黙って死んだ器へ挑み直すたびに1行増える** — 名簿の再挑戦は上限を持たない
   * （持たせない）ので、`journal_read` の窓が同じ行で埋まり、本物の記録が押し出される。
   * 残らないわけではない: 日誌へ載せないぶんは stderr（`daemon.log`）に出る。
   *
   * **記録の失敗でデーモンを止めない。** 落ちたときだけ stderr に出す — 日誌が
   * 書けなかったことまで黙って消えると、「不明」が二重に消える。
   */
  const reportRunnerUnknown = (report: RunnerUnknownReport): void => {
    if (managerIdOfRunnerPath(report.path) === undefined) {
      process.stderr.write(`alteroidd: ${describeRunnerUnknown(report)}\n`);
      return;
    }
    void stores.journal
      .append({ type: 'external_event', source: 'runner', summary: describeRunnerUnknown(report) })
      .catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: runner の期限切れを日誌へ残せませんでした: ${String(error)}\n` +
            `  ${describeRunnerUnknown(report)}\n`,
        );
      });
  };

  /**
   * **解釈できずに捨てた出来事を、日誌へ残す。**
   *
   * これが無いと、runner が新しい種類の出来事を出し始めても**届いていないことを
   * 観測できる場所が1つも無い**（`describeRunnerDropped` の doc）。
   *
   * **日誌に落ちなかったときは stderr へ。** `reportRunnerUnknown` と同じ形で、
   * 「残せなかった」ことまで残す。
   */
  const reportRunnerDropped = (report: RunnerDroppedEventReport): void => {
    const summary = describeRunnerDropped(report);
    void stores.journal
      .append({ type: 'external_event', source: 'runner', summary })
      .catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: runner の捨てた出来事を日誌へ残せませんでした: ${reasonOf(error)}\n` +
            `  ${summary}\n`,
        );
      });
  };

  const seeds = runnerSeeds({
    workspace,
    withheldEnvKeys: storage.withheldEnvKeys,
    profilePath: join(paths.state, 'runner-profile.sh'),
    onRunnerUnknown: reportRunnerUnknown,
    onRunnerDropped: reportRunnerDropped,
  });

  /**
   * 挑み直しても直らない失敗の行き先。
   *
   * **人間（stderr）とクローン（受信箱）の両方へ出す。** 片方だけだと、ログを
   * 見ていない人間か、事実を知らないクローンのどちらかが取り残される。クローンが
   * 立ち上がるより先に失敗しうるので、宛先は後から差し替える。
   */
  let announce = (text: string): void => {
    process.stderr.write(`alteroidd: ${text}\n`);
  };
  /**
   * 器の入れ替えを見たときに引き取りを起こす口。**宛先は後から差し替える。**
   *
   * `announce` と同じ形にしてある（クローンが立ち上がるより先に名簿が動きうる）。
   * 直に `takeOver` を呼ぶ形にすると、まだ初期化されていない `const` を触る経路が
   * 残る — 起きるのは稀な順序のときだけなので、**起きたときにしか分からない**。
   */
  let takeOverOnSwap: (runnerId?: string) => void = () => {};
  const runners = createRunnerRegistry([], {
    notify: ({ label, error }) => {
      announce(
        `runner (${label}) を開けず、挑み直しても直らない失敗だったので諦めました: ${error}`,
      );
    },
    /**
     * 一度は繋がった runner が黙った。**知らせるところまでが今の責任である。**
     *
     * ここで走っていた仕事を別の器へ移さないのは、二重実行を止める仕組み
     * （fencing）がまだ無いからである。先に動かすと、実は生きていた器と移送先とで
     * 同じマネージャーが2本走る — 黙っているのは器かもしれないし、経路かもしれない。
     */
    onLost: ({ label, runnerId, error }) => {
      announce(
        `runner (${label}${runnerId === undefined ? '' : ` / ${runnerId}`}) が` +
          `名乗らなくなりました。新しい委譲の宛先からは外しています` +
          `（走っていた仕事の移送はまだ行いません）: ${error}`,
      );
    },
    /**
     * 同じ宛先に別のプロセスが応え始めた（器が入れ替わった）。
     *
     * **`onLost` では拾えない事象である。** 器が入れ替わっても `/health` は応え
     * 続けるので、生死の判定からは何も起きていないように見える — これまでは
     * **黙って入れ替わっていた**（roadmap 受け入れ基準6 の「一度開いた宛先が黙って
     * 入れ替わった場合」）。
     *
     * **ここを引き取りの契機にする（roadmap 受け入れ基準6）。**
     *
     * 以前は知らせるだけだった。「入れ替わったことが見える」と「古いプロセスがもう
     * 動いていない」は別で、後者を言う材料が無かったからである。いまは貸し出し期限
     * （`packages/core/src/lease.ts`）がその材料を持つので、**引き取りそのものを
     * ここから起こしてよい** — 奪ってよいかの判定は `ManagerPool` の関門
     * （`#claimForResume`）が持っていて、まだ持ち主が握っている委譲は**この呼びでは
     * 起こされずに挑み直しの梯子へ載る。**
     *
     * つまりここが約束するのは「引き取りを試みる」までで、「引き取れた」ではない。
     * **その線を知らせの文言でも崩さないこと。**
     *
     * **起こす口は2つあり、どちらか片方では足りない。**
     *
     * - `reattachRunner(runnerId)` — 走行中だった委譲（デーモンの像に載っている分）。
     *   **入れ替えで拾いたいのは主にこちらである**
     * - `takeOver()`（`restore()`） — 台帳にしか無い委譲。像に載っている分はあちらの
     *   先頭で見送られるので、**`restore()` だけに繋いだ版は1本も拾えなかった**
     *
     * **知らせる相手は人間とクローンの両方。** 入れ替わった器の中で走っていた
     * マネージャーは消えている可能性があるので、クローンが `manager_list` を見て
     * 判断できるようにする。ログだけに出すと、その判断材料がクローンへ届かない。
     */
    onSwap: ({ label, runnerId, before, after }) => {
      announce(
        `runner (${label}${runnerId === undefined ? '' : ` / ${runnerId}`}) に` +
          `別のプロセスが応え始めました（器の入れ替え）。` +
          `そこで走っていた委譲の引き取りを試みます` +
          `（貸し出し期限が切れていない委譲は、切れてから自動で引き取ります）: ` +
          `${before} → ${after}`,
      );
      takeOverOnSwap(runnerId);
    },
  });
  const runnerDescription = describeRunner();

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

  /**
   * クローンの権限モードの差し替えも表へ出す。
   *
   * **能力の制限ではなく実行環境の設定である**（`permission-mode.ts`）。それでも
   * 黙らせない理由は帯と同じで、締める側へ倒した効果は「道具が使えない」という
   * 分かりにくい形で出るからである。**値が読めない綴りでもそのまま出す** —
   * この直後の `createClone` が理由つきで落とすので、その前に何が置かれていたかを
   * 見せておく（落ちた後のログだけでは、置いた本人が綴りを疑えない）。
   */
  const placedClonePermission = placedClonePermissionMode();
  if (placedClonePermission !== null) {
    process.stderr.write(
      `alteroidd: ${CLONE_PERMISSION_MODE_ENV_KEY} が置かれています` +
        `（既定 ${DEFAULT_PERMISSION_MODE} → ${placedClonePermission}）。` +
        `これは実行環境の設定であって、クローンの道具を減らすものではありません\n`,
    );
  }

  /**
   * マネージャーと作業者の帯も同じ扱いで表へ出す。
   *
   * **ただし正本はここではない。** この2つを実際に SDK へ渡すのは runner であり
   * （`packages/core/src/runner.ts` の `#buildOptions`）、こちらが読んでいるのは
   * 自己認識に載せる**宣言**のためである。両者が一致するのは器の作りによる —
   * `compose.yaml` の `x-shared-env` と Railway の Shared Variables は app と
   * runner へ同じ値を渡し、**役ごとに違うのは `ALTEROID_DATABASE_URL` だけ**
   * という不変条件がある。片方だけに Service 変数で上書きを載せればここは
   * ずれるので、実際に渡っている値は runner の起動ログで確かめること。
   */
  const placedManagerTiers = placedManagerModels();
  for (const { key, value, fallback } of placedManagerTiers) {
    process.stderr.write(
      `alteroidd: ${key} が置かれています（既定 ${fallback} → ${value}）。` +
        `実際にセッションへ渡すのは runner なので、効いているかは runner の起動ログで確かめてください\n`,
    );
  }

  /**
   * 実行環境プロファイル（`.zprofile` 相当）をクローンへ効かせる器。
   *
   * **クローンにも効かせる**のは、人間の `.zshenv` が「Claude Code に頼むとき」
   * にも「自分で端末を叩くとき」にも同じように効くからである。クローンは人間の
   * 写像であって、道具を持たない存在ではない（north_star「適用範囲」）。
   *
   * **プロファイルからは伏せる名前を置かせない。** クローンから記憶ストアの鍵を
   * 取り上げるという意味ではない — クローンの子は `process.env` からこれまでどおり
   * 本物の値を受け取る。禁じているのは「プロファイル経由でその名前を*差し替える*」
   * ことで、ここを開けると、保存の入口（＝ここ）を通ったものがそのまま runner へ
   * 降り、下の層の境界を上書きできてしまう。
   *
   * **保存する前に弾ける唯一の場所でもある。** ここが素通りすると、壊れた
   * プロファイルが記憶ストアに残り、以後の再接続のたびに配布が失敗し続ける。
   */
  const profile = createProfileApplier({
    vessel: createProfileVessel({
      path: join(paths.state, 'profile.sh'),
      withheldEnvKeys: [...WITHHELD_ENV_KEYS, ...storage.withheldEnvKeys],
    }),
    baseEnv: () => process.env,
  });

  /**
   * 置いて配るまでの1本道。**インスタンスは1つだけ作って全経路へ渡す。**
   *
   * 人間の口（`PUT /profile`）・クローンの道具（`profile_write`）・runner の
   * 再接続時の降ろし直しは、どれも同じものを書き換える。別のインスタンスを持つと
   * 直列化の意味が消え、層ごとに違う本文が残る。
   */
  const profileService = createProfileService({ stores, applier: profile, runners });

  // 置いてあるものを起動時に1度効かせる。**器を作り直しても環境が痩せない**
  // ことが、この仕組みを環境変数と別に持つ理由そのものである。
  {
    // **効かせ直すだけで、保存はし直さない。** ここで書くと、デーモンを起こした
    // だけで `updatedAt` が動き、「人間かクローンが最後に本文を変えた時刻」という
    // 意味が消える（本文を一度も変えていなくても監査情報が失われる）。
    const applied = await profileService
      .restore()
      .catch((error: unknown) => ({ ok: false, error: String(error), output: undefined }));
    if (applied !== null && !applied.ok) {
      // **黙って古い環境で走らせない。** 何が効いていないかが見えないと、
      // 「鍵が届いていない」のか「鍵の権限が足りない」のかを誰も切り分けられない。
      process.stderr.write(
        `alteroidd: 実行環境プロファイルを読めませんでした（クローンには効きません）: ${applied.error ?? '理由不明'}\n`,
      );
    }
  }

  const port = Number(process.env.ALTEROID_PORT ?? '4517');
  const hostname = process.env.ALTEROID_BIND || DEFAULT_BIND;

  // 入口の認証。**設定されていなければ従来どおり要求しない** — 境界の導入が
  // 実質のデグレードにならないようにする（north_star「立ち戻るための問い」）。
  const authPlan = planAuth(process.env, { port });
  process.stderr.write(`alteroidd: ${authPlan.description}\n`);

  // クローンが自分自身を把握するための材料。**事実を知っているのはここだけ**なので
  // ここで組み立てる（core 側で環境変数を読み直すと出所が2つになる）。
  // 鍵は入れないこと — そのままシステムプロンプトへ載る。
  const self: SelfFacts = {
    storage: storage.description,
    // **パスだけを渡さない。** pg 構成でここに残るのは state だけで記憶ではない
    // （storage.ts）。「記憶: PostgreSQL」と並べたときに矛盾して見えないようにする。
    local:
      storage.kind === 'pg'
        ? `${paths.root}（デーモンのローカル状態だけ。記憶は上の器にあり、ここには無い）`
        : `${paths.root}（記憶もここにある。人間が直接開いて書き換える）`,
    workspace,
    // **クローン自身の cwd は workspace とは別に渡す。** クローンへ渡している
    // `cwd`（下の createClone）と同じ値でなければ、自己認識が嘘になる。
    cwd: paths.root,
    runner: runnerDescription,
    // **待ち受けアドレスではなく人間が叩く先を渡す。** `ALTEROID_BIND=0.0.0.0` は
    // 「どこで待つか」であって入口ではないし、TLS を手前で終端すれば scheme も違う。
    entrypoint: authPlan.publicBaseUrl,
    auth: authPlan.description,
    // 差し替えが置かれていればそれを載せる。**固定値を載せると自己認識が嘘になる**
    // （人間が帯を動かしたのに、クローンは既定を自分の帯だと思ったまま判断する）。
    models: { clone: cloneModel, manager: resolveManagerModel(), worker: resolveWorkerModel() },
  };

  /**
   * アカウント全体の利用状況（claude.ai 側の値）。
   *
   * **使い捨ての probe で読む。実セッションに相乗りしない** — 実測で、ターンを
   * 回した直後のセッションへ usage 要求を出すと
   * `ProcessTransport is not ready for writing` で失敗する。マネージャーは常に
   * ターンを回しているので、相乗りする設計は必ず詰まる。推論は走らないので
   * トークンは消費しない。
   *
   * **未ログインでも止めない。** alteroid は鍵を走行中に回せる設計なので、
   * 「まだログインしていない」は通常の状態であり、後から鍵が届いたら取れる。
   */
  const usagePoller = startUsagePolling({ queryFn: query, cwd: paths.root });

  const clone = createClone({
    stores,
    accountUsage: () => usagePoller.state(),
    cwd: paths.root,
    runners,
    profile,
    profileService,
    self,
    ...(storage.sessionStore === undefined ? {} : { sessionStore: storage.sessionStore }),
  });

  // 起動ごとに作り直す。状態ファイルが残っていても、別プロセスを自分だと
  // 誤認させない（PID の再利用で無関係なプロセスを止めないため）。
  const token = randomUUID();

  // 時間起点のジョブ（起点② / ④）。発火は必ずクローンの受信箱を通る。
  const schedule = readScheduleConfig();
  for (const note of schedule.notes) process.stderr.write(`alteroidd: ${note}\n`);
  const scheduler = createScheduler({
    entries: buildSchedule(schedule),
    post: (event) => clone.post(event),
    // 継続中の依頼（クローンか人間が仕込んだもの）。**器を作り直しても残る。**
    // 「定期的に見ておいて」がデーモン再起動で消えたら、それは自律の穴である。
    // 既定の仕込み（日報・発意 tick）の位相もここに置く（同じ理由。位相を持たないと
    // 再起動のたびに `now + 周期` へ戻り、短い間隔の再デプロイで発意が一度も来ない）。
    schedules: stores.schedules,
    // 位相の読み書きが落ちたことを黙らせない。時計は止まらないので、ここが唯一
    // 「効いていない」に気づける場所である。
    onError: (message) => {
      process.stderr.write(`alteroidd: ${message}\n`);
    },
  });

  // 挑み直しても直らない失敗は、ここからクローンの受信箱にも入る（次のターンで
  // 気づける）。日誌にも残るので、後から「いつ繋がらなくなったか」を追える。
  announce = (text: string): void => {
    process.stderr.write(`alteroidd: ${text}\n`);
    clone.post({
      type: 'external',
      id: randomUUID(),
      at: new Date().toISOString(),
      source: 'runner-registry',
      payload: { text },
    });
  };

  /**
   * 走行中だったマネージャーを台帳から拾い直す。
   *
   * **契機は「runner が開けたとき」である。** 起動時に1度きりだと、runner を待たずに
   * 立ち上がる構成（＝この PR で入れた形）では、まだ誰も繋がっていない名簿を見て
   * 「引き取るものは無い」と結論してしまう。runner が上がった瞬間に引き取るのが
   * 正しい契機で、これは器だけが入れ替わった再デプロイでも同じ形になる。
   *
   * 二重に走らないことは `ManagerPool` 側が見ている（`#resumeOnce`）。
   */
  const takeOver = async (): Promise<void> => {
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
  };
  runners.subscribe(() => void takeOver());
  /*
   * 器の入れ替えも契機にする（`onSwap`）。**2つとも起こす** — 走行中だった委譲は
   * `reattachRunner`、台帳にしか無い委譲は `restore()` が拾う（片方だけでは片側が
   * 落ちる。`onSwap` の doc）。
   *
   * **同時に2本走らないことは `ManagerPool` 側が見ている**（`restore()` は列に並べ、
   * 取り直しは runner ごとに1本＋予約に畳む）。こちらで数を絞ると、絞った回に現れた
   * 委譲が拾われない。
   */
  takeOverOnSwap = (runnerId) => {
    if (runnerId !== undefined) {
      void clone.managers.reattachRunner(runnerId).catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: 入れ替わった runner (${runnerId}) の取り直しに失敗しました: ${String(error)}\n`,
        );
      });
    }
    void takeOver();
  };

  // 画面（apps/web）を別オリジンに置く配置のための境界設定。既定は空＝今まで通り
  // CORS ヘッダを返さない。捨てた値は黙って飲み込まない（許可したつもりとの差が
  // 境界の穴になる）。
  const { origins: allowedOrigins, rejected } = parseAllowedOrigins(
    process.env.ALTEROID_ALLOWED_ORIGINS,
  );
  for (const value of rejected) {
    process.stderr.write(
      `alteroidd: ALTEROID_ALLOWED_ORIGINS の "${value}" を無視しました` +
        '（scheme://host[:port] の形だけを受け付けます。* と経路付きは不可）\n',
    );
  }
  if (allowedOrigins.length > 0) {
    process.stderr.write(
      `alteroidd: 次のオリジンからのブラウザ呼び出しを許可します: ${allowedOrigins.join(', ')}\n`,
    );
  }

  const app = createApp({
    clone,
    stores,
    token,
    shutdown: () => void shutdown(),
    scheduler,
    storage: storage.description,
    runners,
    journalEvents: journalBus,
    accountUsage: () => usagePoller.state(),
    allowedOrigins,
    auth: { plan: authPlan },
    profile: profileService,
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

  // TCP keepalive（`TCP_KEEPALIVE_DELAY_MS` の JSDoc に理由）。`serve()` は素の
  // `http.Server` を返すので、標準の `connection` イベントへ直接差し込める。
  server.on('connection', (socket) => {
    socket.setKeepAlive(true, TCP_KEEPALIVE_DELAY_MS);
  });

  server.on('error', (error: unknown) => {
    process.stderr.write(`alteroidd: 待ち受けに失敗しました (port ${port}): ${String(error)}\n`);
    process.exit(1);
  });

  // **待ち受けを開けてから runner へ繋ぐ。** 逆にすると、runner が上がるまでの間
  // chat も日誌も日報も承認への回答も受け付けられない。それらは runner に一切
  // 依存していないので、委譲先の不在に巻き込ませない（PRD「自律」）。
  //
  // 名簿は繋がるまで挑み直し続ける。だから、この間に届いた委譲だけが待たされる。
  for (const seed of seeds) {
    void runners.register(seed).catch((error: unknown) => {
      process.stderr.write(
        `alteroidd: runner (${seed.label}) を名簿に載せられません: ${String(error)}\n`,
      );
    });
  }

  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;

    // 先に受け口を閉じて runtime 情報を消す。クローンの後片付け（最後の蒸留）が
    // 長引いても、CLI からは「止まった」と見えるようにする。
    scheduler.stop();
    usagePoller.stop();
    server.close();
    // 名簿の挑み直しも畳む（止めたはずのデーモンが背景で runner を叩き続けない）。
    await runners.stop().catch(() => undefined);
    await clearRuntimeInfo(paths.state).catch(() => undefined);

    const forced = setTimeout(() => process.exit(0), FORCED_EXIT_MS);
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

  // 仕込んであった依頼を先に読み直す。ここを通さないと、前回の会話で仕込んだ
  // 継続中の依頼が、次の刻み（最大1分）まで存在しないことになる。
  await scheduler.refresh().catch((error: unknown) => {
    process.stderr.write(`alteroidd: 継続中の依頼を読み込めませんでした: ${String(error)}\n`);
  });
  scheduler.start();

  const standing = scheduler.list().filter((entry) => entry.request !== undefined);
  if (standing.length > 0) {
    process.stdout.write(
      `alteroidd: 継続中の依頼: ${standing.map((entry) => entry.kind).join(', ')}\n`,
    );
  }

  // 締め時刻に自分が動いていなければ、その日の日報は誰も作らない。「日報は毎日
  // 生成される」は要件なので、動いていなかった日の分を起動時に拾い直す。
  if (schedule.dailyReportAt !== null) {
    // 日誌を読めないだけで起動は止めない。**ただし黙って飛ばさない** — 黙って
    // `[]` を返すと「取りこぼしは無かった」と見分けが付かず、日報の欠落だけが
    // 後に残る（`scheduler.refresh` と同じ扱い）。
    //
    // 理由は `reasonOf` を通す。**ここは日誌を読んだ失敗である**ので、素の
    // `String(error)` を残すと、本文入りの例外を投げるストア実装が現れた日に
    // ここだけが無防備なまま漏らす（そして誰も気づかない）。
    const missed = await missingDailyReportDates({
      journal: stores.journal,
      at: schedule.dailyReportAt,
      now: new Date(),
      lookbackDays: schedule.reportLookbackDays,
    }).catch((error: unknown) => {
      process.stderr.write(
        `alteroidd: 取りこぼした日報を調べられませんでした（この起動では拾い直しません）: ${reasonOf(error)}\n`,
      );
      return [];
    });
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
