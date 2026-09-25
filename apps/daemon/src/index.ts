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
  DAEMON_RUNNER_REGISTRY_SOURCE,
  DAEMON_TOKEN_POOL_REOPENED_SOURCE,
  DEFAULT_PERMISSION_MODE,
  applyAppScopedEnvVars,
  seedDefaultEnvVars,
  createClone,
  createLocalRunner,
  createProfileApplier,
  createCredentialService,
  createMcpServerService,
  createProfileService,
  createProfileVessel,
  createRunnerRegistry,
  createScheduler,
  createTokenPoolService,
  createTokenRotator,
  noteDroppedRecord,
  tokenRestoreEntry,
  tokenRotationEntry,
  probeTokenCandidate,
  runTokenTrial,
  dailyReportEvent,
  installUncaughtNet,
  missingDailyReportDates,
  placedClonePermissionMode,
  placedManagerModels,
  reasonOf,
  resolveCloneModel,
  resolveManagerModel,
  resolveWorkerModel,
  staleObservedRecoveryForBlockedKey,
  staleObservedRecoveryNoticeEvent,
  WITHHELD_ENV_KEYS,
  writeStderrSync,
  type InboxEvent,
  type RunnerClient,
  type RunnerSource,
  type SelfFacts,
  type Stores,
  type TokenRotationEntry,
  type TokenRotationOutcome,
} from '@alteroid/core';

import { createApp, parseAllowedOrigins } from './app.js';
import { startTokenRotationWatch, type TokenRotationWatch } from './token-watch.js';
import {
  isRejectionForTrialBackoff,
  startTokenTrialWatch,
  type TokenTrialWatch,
} from './token-trial-watch.js';
import { TokenRotationJournalFold } from './token-rotation-journal-fold.js';
import { startUsagePolling } from './usage-poller.js';
import { startManagerPolling } from './manager-poller.js';
import { readArchiveFoldConfig, startArchiveFolding } from './archive-folder.js';
import { AUTH_WITHHELD_ENV_KEYS, planAuth } from './auth.js';
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
import { noteRunnerSwap } from './runner-swap-notice.js';
import { buildSchedule, readScheduleConfig } from './schedule.js';
import {
  createAgentTokenHolder,
  createRunnerTokenSync,
  createTokenSpread,
} from './token-spread.js';
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
export {
  ARCHIVE_FOLD_EVERY_ENV,
  ARCHIVE_FOLD_GRACE_MS,
  DEFAULT_ARCHIVE_FOLD_EVERY_MINUTES,
  foldArchiveOnce,
  readArchiveFoldConfig,
  startArchiveFolding,
  type ArchiveFolder,
  type ArchiveFolderOptions,
  type ArchiveFoldConfig,
  type FoldArchiveOnceOptions,
  type FoldArchiveOnceResult,
} from './archive-folder.js';

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
 * 認証トークン回りの日誌1行を、正常/異常のどちらの標準ストリームへ出すかを
 * `event` から一意に決める（Issue #420 の残件）。
 *
 * **「正常は stdout・異常は stderr」の規則は既に決まっている。** ここが決めるのは
 * 割り当てだけで、規則そのものを変える判断はここに持たせない——変えたくなったら
 * 実装せず人間に確認する。
 *
 * `rotated` / `not_rotated` / `restored` / `recovered` / `reopened` は正常（プールが
 * 仕事をした、何もしないという判断が付いた、または止まっていた鍵が開いた）。
 *
 * **`reopened`（現役の冷却が明けた。#833）が正常側に居る理由。** 運んでいる事実は
 * 「止まりが終わった」で、`recovered` と同じ向きである —— **根拠が観測ではなく
 * 時計だという違いは、標準ストリームの選び方には効かない**（そこは `event` と
 * 本文が言い分けている）。
 * `exhausted` / `sweep_stopped` / `restore_failed` / `parked` は異常（全層が
 * 止まる・候補を試し切れていない・起動時の撒き直しが失敗した）。詳細は
 * `.claude/skills/token-pool/SKILL.md` の `event` の表。
 *
 * **⚠️ `parked` が異常側に居る理由を潰さないこと。** あれは撒けてはいるので
 * `rotated` の側に見えるが、運ばれている事実は「**いま通る鍵が1本も無い**」で
 * ある（`earliestAt` まで全層が止まる）。正常な行に混ぜると、いちばん重い状態が
 * いちばん普通の状態と同じ場所へ出る（`schema.ts` の `token_rotation.event` の
 * doc と同じ理由）。
 *
 * **全値に対して網羅的である。数をここに書かない**（数のほうが先に腐る。
 * 数え上げの持ち主は `schema.ts` の `z.enum` である）。`token_rotation.event` へ
 * 新しい値が足されたら、`default` の `assertTokenRotationEventHandled` の引数が
 * `never` を受けられなくなり、`pnpm typecheck` がここで落ちる。**既定へは
 * 倒さない** — 倒すと新しい event が黙ってどちらかの標準ストリームへ流れてしまう。
 */
export function tokenRotationStream(event: TokenRotationEntry['event']): NodeJS.WritableStream {
  switch (event) {
    case 'rotated':
    case 'not_rotated':
    case 'restored':
    case 'recovered':
    case 'reopened':
      return process.stdout;
    case 'exhausted':
    case 'sweep_stopped':
    case 'restore_failed':
    case 'parked':
      return process.stderr;
    default:
      return assertTokenRotationEventHandled(event);
  }
}

/**
 * その結果は「**認証トークンが通る状態に戻った**」か。戻っていなければ `undefined`。
 *
 * ## なぜ切り出してあるか
 *
 * これは `main()` の中の3行だったが、**測れなかった** —— `main()` はデーモンを
 * 丸ごと起こすので、「起こす / 起こさない」の判定だけを確かめる術が無い。
 * **判定を間違えたときの壊れ方が非対称なので、ここは測れる形にしておく:**
 *
 * | 間違え方 | 何が起きるか | 見えるか |
 * | --- | --- | --- |
 * | 起こすべき回に起こさない | **止まったまま。**「復活したのに何もしない」 | **見えない**（何も起きないので） |
 * | 起こすべきでない回に起こす | 保持していた合図を1件無駄に焼き、同じところで止まる | 見える（日誌に失敗が並ぶ） |
 *
 * **出力・挙動は1文字も変えていない**（同じ式をそのまま関数にした）。
 *
 * ## 判定
 *
 * | `outcome` | 戻ったか | なぜ |
 * | --- | --- | --- |
 * | `rotated` | **戻った** | いま通る鍵に移った |
 * | `ignored` ＋ `recovered` | **戻った** | 止まっていた現役が、また通ることを観測できた |
 * | `ignored` ＋ `reopened` | **戻った** | 現役の冷却が明けた（#833。**時計**であって観測ではない） |
 * | `parked` | **まだ** | 撒いた鍵は `cooldownUntil` まで通らない |
 * | それ以外 | **まだ** | 何も変わっていない |
 */
export function reopenedTokenOf(
  outcome: TokenRotationOutcome,
): { tokenId: string; label: string; how: ReopenedHow } | undefined {
  if (outcome.kind === 'rotated') {
    return { tokenId: outcome.toTokenId, label: outcome.toLabel, how: '回した' };
  }
  // **`parked` をここへ入れないこと。** 撒けてはいるが、その鍵はまだ通らない
  // ——起こしても同じところで止まり、保持していた合図を1件無駄に焼く。
  // 冷却が明ければ枠の probe が `usable` を観測し、`recovered` として戻ってくる。
  if (outcome.kind === 'ignored' && outcome.recovered !== undefined) {
    // **`source` は拾わない。** ここが答えるのは「起こすべきか」だけで、
    // どちらの生産者（`account_probe` / `turn_success`）が観測したかは
    // 起こし方を分けない（#681 (1)）——宣言した戻り値の型に無い欄を
    // spread で紛れ込ませない。
    return {
      tokenId: outcome.recovered.tokenId,
      label: outcome.recovered.label,
      how: 'また通るようになった',
    };
  }
  /**
   * **冷却が明けた**（#833）。**`recovered` と同じ扱いで起こす** —— 止まっていた
   * 層にとって必要なのは「鍵がまた通る」ことであって、それを**誰が**確かめたか
   * ではない。
   *
   * **⚠️ ここを `parked` の側（起こさない）へ倒さないこと。** `parked` を起こさない
   * 理由は「撒いた鍵は `cooldownUntil` **まで**通らない」だが、こちらはその
   * `cooldownUntil` を**過ぎた**ときにしか立たない —— 同じ欄を見て、反対側に居る。
   *
   * **根拠の弱さ（観測ではなく時計）は `how` に出す。** 起こした後で結局枠なら、
   * その回の失敗が新しい観測として上がってくるので、判定はそこでやり直せる。
   */
  if (outcome.kind === 'ignored' && outcome.reopened !== undefined) {
    return {
      tokenId: outcome.reopened.tokenId,
      label: outcome.reopened.label,
      how: '冷却が明けた',
    };
  }
  return undefined;
}

/**
 * **何をもって「通る状態に戻った」と言っているか**（{@link reopenedTokenOf}）。
 *
 * **3値を潰さないこと。** 根拠の強さが違い、**読む側が次に確かめるものが違う**:
 *
 * | `how` | 根拠 |
 * | --- | --- |
 * | `回した` | 別の鍵へ移した（移す前に候補を probe している） |
 * | `また通るようになった` | **観測**（probe が枠を測った / ターンが実際に成功した） |
 * | `冷却が明けた` | **時計**（記録した期限を過ぎた。通ることは誰も確かめていない） |
 */
type ReopenedHow = '回した' | 'また通るようになった' | '冷却が明けた';

/** {@link reopenedTokenOf} が返す形。{@link describeReopenedTokenNotice} と共有する。 */
type ReopenedToken = { tokenId: string; label: string; how: ReopenedHow };

/**
 * **いま配る意味が在るか**（Issue #783）。
 *
 * ## 呼び手は2つある ── コピーを作らず、同じ実体をどちらも呼ぶ
 *
 * 呼ぶのはクローンの枠（`CloneHost.usageBlocked`）に関する経路が2つである。
 *
 * 1. **`CloneWakeGate.decide`**（このファイル、下）—— `wake()` が `clone.post(...)`
 *    越しに配るか畳むかを決める。
 * 2. **`createClone(...)` へ渡す `redeliveryGate`**（`main()` の中、下）——
 *    `packages/core/src/clone.ts` の `#restoreUnread`（前の器が終えられなかった
 *    合図を配り直す経路）は `post()` を通らず `#inbox.push` を直接呼ぶので、
 *    1の門を素通りする。同じ判定をもう一箇所へ注入してあるのはそのためである
 *    （`RedeliveryGate` の doc）。
 *
 * **どちらも `worthDeliveringNow` をそのまま呼ぶ——コピーしない。** 判定を
 * 2箇所に書き写すと、片方だけを直したときに黙ってずれる（`decide` は直った
 * のに配り直しの側は古いまま、というような食い違いが実行時にしか見えない）。
 * 1つの実体を2箇所が呼ぶ形にしてあれば、ここを直した瞬間に両方へ効く。
 *
 * **引数を増やして一般化はしない**（依頼者の決定 2026-09-10。呼び手を増やす
 * 設計はここでは作らない）——`blocked` を渡す先がさらに増えたときに、この名前を
 * そのまま再利用できれば足りる。
 *
 * 背景（判断材料としてのみ）: 台帳を一段割った結果、マネージャー側の枠の
 * 断りも同じ形で説明できると分かった——「委譲 X の137回目のターンが枠で
 * 断られた」は判断材料にならず、決められるのは「委譲 X は枠で止まっている」
 * の一段だけである。**この PR ではマネージャー側は実装しない**（別の委譲に
 * 出る）。
 *
 * ## 中身 —— 2つを見る（Issue #1051 で1つ増えた）
 *
 * | 見るもの | 偽のとき配らない理由 |
 * | --- | --- |
 * | `blocked` | 止まっていなければ、この合図は `#usageBlocked` を1文字も動かさない（上） |
 * | `releasePending` | **もう起こしてある。** 印（`#releaseRequested`）が立っている間は、2件目が立てるものが1つも無い |
 *
 * **後者が Issue #1051 の本体である。** 枠に当たっている間、ある層が 429 を
 * 踏むと現役の記録にまた冷却が書かれ、別の層のターンが成功した瞬間にそれが
 * 消えて「戻った」が1件立つ——この往復はミリ秒間隔で回る（歯は
 * `packages/core/src/token-rotator.test.ts` の「#1051: recovered は記録に対して
 * エッジだが、429 が記録を撃ち直すと何度でも立つ」）。往復のあいだ `blocked` は
 * ずっと真なので、**`blocked` だけを見る門はその全部を通していた**（実運用で
 * 同一本文が 35 ミリ秒に3件・24時間で 3297 件）。
 *
 * **⚠️ 「回復を1回に丸めている」のではない。** 記録の上では回復が本当に N 回
 * 起きており、日誌の `recovered` 行はその N 回を残す（下の describe「recovered の
 * 日誌行は…」）。ここが削るのは**クローンへ配る回数だけ**で、削ってよい根拠は
 * 「印が既に立っている」という**証明可能な無効性**である。
 *
 * **起こし損ねは作らない。** `#releaseRequested` は `#pump` の先頭で必ず
 * 消費される（`CloneHost.usageReleasePending` の doc）⟹ 配る回数は
 * 「クローンが実際に再試行できる回数」ちょうどに落ちる。
 */
export function worthDeliveringNow(blocked: boolean, releasePending: boolean): boolean {
  return blocked && !releasePending;
}

/**
 * `clone.post({ type: 'external', source: TOKEN_POOL_REOPENED_SOURCE, ... })`
 * （下、`wake()` の中）が使う送信元の名前。
 *
 * **名前付きの定数へ括ってある。** リテラル `'token-pool'` を発行側（`post` の
 * 呼び出し）と判定側（{@link isTokenPoolReopenedNotice}）の2箇所に直書きすると、
 * どちらかを直し忘れたときに黙ってずれる——1つの定数を両方が参照する形にして
 * あれば、直せば両方へ効く。
 *
 * **⚠️ 値そのものの正本は `packages/core` 側（`DAEMON_TOKEN_POOL_REOPENED_SOURCE`）
 * に移した（Issue #852）。** 台帳（`clone.ts` の `commitmentFor`）もこの文字列を
 * 判定に使うようになったが、`packages/core` は `apps/daemon` に依存できない
 * （deps が daemon → core の一方向）ので、正本を daemon 側に置いたまま core が
 * import することはできない。**この export はそのまま残す** — 外（`index.test.ts`
 * など）から `TOKEN_POOL_REOPENED_SOURCE` の名前で参照されている。
 */
export const TOKEN_POOL_REOPENED_SOURCE = DAEMON_TOKEN_POOL_REOPENED_SOURCE;

/**
 * 受信箱の合図が「認証トークンが通る状態に戻った」の通知
 * （`external` / `source: TOKEN_POOL_REOPENED_SOURCE`）か（Issue #783 続き）。
 *
 * **`createClone(...)` の `redeliveryGate` から呼ばれる。** `#restoreUnread`
 * （`packages/core/src/clone.ts`）は型を問わず全種類の合図を配り直すので、
 * この判定でまず「対象は token-pool の通知だけ」に絞ってから
 * {@link worthDeliveringNow} を当てる——他の型（人間の発言・マネージャーの
 * 報告など）まで畳んでしまわないためである。
 *
 * **型と `source` だけを見る。文言では判定しない**（`isSameTick` と同じ流儀）。
 */
export function isTokenPoolReopenedNotice(event: InboxEvent): boolean {
  return event.type === 'external' && event.source === TOKEN_POOL_REOPENED_SOURCE;
}

/**
 * **「認証トークンが通る状態に戻った」の合図を、クローンへ配るか畳むかの判定**
 * （Issue #783）。
 *
 * ## なぜ要るか —— クローンが枠で止まっていなければ、配ってもターンを1本焼くだけ
 *
 * この合図がクローンに対して果たす機能上の効果は1つしかない —— `clone.ts` の
 * `post()` の中の `if (this.#usageBlocked !== null) this.#releaseRequested =
 * true;`。**クローンが枠で止まっていなければ（`CloneHost.usageBlocked ===
 * false`）、この合図は1文字もそこを動かさない。** それでも配れば、受信箱を
 * 通ってモデルへ1ターン渡る——同じトークン id が9秒に25本届いた実運用の
 * 受信箱の詰まりは、ここを無条件に配っていたことが機能上の理由である。
 *
 * **合図そのものは本物の状態遷移である**（`token-rotator.ts` の `hasRejection`
 * の門が既に在り、`recovered` は記録の上で実際に状態が動いた回にしか出ない）。
 * ⟹ **減らすのは日誌でも母数でもなく、配る回数だけである。** 日誌
 * （`token_rotation` の `recovered` 行）はこの判定と無関係に必ず出る——
 * `tokenRotationEntry`（`token-rotator.ts`）は `settleTokenOutcome` の中で
 * この判定より前に計算され、配ったかどうかを見ずに `stores.journal.append`
 * まで届く（隣の describe「recovered の日誌行は、受信箱へ配ったかどうかと
 * 無関係に必ず出る」がその配線を固定している）。
 *
 * ## なぜ切り出してあるか
 *
 * 同じ理由（`reopenedTokenOf` の doc）。`wake()` は `main()` の中の閉包で、
 * 型でも実行時でも触れない。
 *
 * **「いま配る意味が在るか」の判定そのものは {@link worthDeliveringNow} が持つ。**
 * ここ（`CloneWakeGate`）が持つのはトークンごとの畳み込みカウントの管理だけで、
 * 判定を埋め込まない——理由は {@link worthDeliveringNow} の doc。
 *
 * ## `restore()` / `resumeStoppedByUsage()` はここを通らない
 *
 * **この門が絞るのはクローンへの合図だけである。** マネージャーはクローンと
 * 独立に枠で止まりうるので（`ManagerPool` は自分の記録で止まる／再開を判断
 * する）、ここへ巻き込むと「起こすべき委譲が起きない」壊し方になる。呼ぶ側
 * （`wake()`）は `restore()` / `resumeStoppedByUsage()` をこの判定と無関係に
 * 呼ぶこと。
 *
 * ## トークンごとに数え、配ったら 0 に戻す
 *
 * 畳んだ回数は {@link CloneWakeGate} がトークン id ごとに持つ。**実際に配った
 * 回にその場でリセットする** —— 次に同じトークンで畳み始めたら 1 から
 * 数え直す。この入れ物自体がリセットの起点になるので、呼ぶ側は消し忘れを
 * 気にしなくてよい。
 *
 * ## 3つ目の条件 —— 前に配ったものを覚える（Issue #1223）
 *
 * 上の2つ（`blocked` / `releasePending`）は**クローンのいまの状態**しか見て
 * おらず、**前にこのクローンへ何を伝えたかを1文字も覚えていない。** ⟹ 次の
 * 輪が閉じない:
 *
 * 1. クローンが枠で止まっている
 * 2. 合図が来る → `blocked && !releasePending` ⟹ **配る**（`#releaseRequested`
 *    が立つ）
 * 3. `#pump` が先頭でその印を消費する ⟹ `releasePending` が偽へ戻る
 * 4. クローンは再挑戦するが、まだ止まったまま（`how: '冷却が明けた'` は**時計**
 *    であって観測ではない —— 回した先の鍵がまた 429 のこともある）
 * 5. 同じ鍵・同じ `how` の合図がまた来る → `blocked && !releasePending` ⟹
 *    **また配る**
 *
 * ⟹ **本文までバイト単位で同一の合図が、クローンのターン1本につき1回、
 * 無限に配られる。** 実運用（2026-09-18〜19）で同一本文が2分半に60回以上配られ、
 * その間クローンは道具を1つも呼べず、会話ログが
 * `prompt is too long: 4,436,374 tokens > 1,000,000` で API に弾かれた。
 * **合流（`folded`）は効いていた** —— 各件が「この間に同じ合図が11件届き、1件に
 * まとめた」と名乗っている。効いていなかったのは**配達済みの印**の側である。
 *
 * **#1051 の手当て（`releasePending`）が畳むのはターンとターンのあいだの連発
 * だけで、ターンを跨いだ反復は1つも畳んでいない。**
 *
 * ⟹ **規則**: 「また通るようになった／冷却が明けた」をクローンへ配ってよいのは、
 * **前に配ったものと違うとき**だけ。同じものをもう一度配ってよいのは、**そのあいだに
 * 鍵が通らなくなったことを観測したとき**（{@link CloneWakeGate.observeUnusable}）
 * だけである。
 *
 * **⛔ 時間の窓（「N 秒以内の同一本文は捨てる」）でも件数の上限（「N 回配ったら
 * 止める」）でもない。** どちらも恣意的な定数で本物の合図を黙って失う＝能力の削除
 * （`docs/north_star.md` の禁止2）である。ここが持つのは**状態**（最後に配った
 * 合図の身元）だけで、**再武装は観測にだけ紐づく。**
 *
 * ## 4つ目の条件 —— `observeUnusable()` 自体が輪を戻すことがある（Issue #1223 再発）
 *
 * 3つ目の条件は「`observeUnusable()` を挟めば必ず新しい知らせとして配る」
 * ことを不変条件3として固定している（`index.test.ts` の同名の歯）。**これは
 * いまも正しい**——`exhausted` / `parked` は本物の「鍵が通らない」の観測で
 * あり、`told` を全消去してよい。**壊れていたのはその先である。**
 *
 * 本番（2026-09-23 観測）で次の輪が4〜6秒周期で回り続けた:
 *
 * 1. `turn_success` により、いまの現役が「また通るようになった」（`recovered`）
 * 2. **別のセッション**が同じ現役へ当たり、組織の月間支出上限などで
 *    `exhausted`（通る鍵が無い）を観測 → `observeUnusable()` が `told` を
 *    全消去する（3つ目の条件のとおり、正しい）
 * 3. 次の `turn_success` の「また通るようになった」が、印を失った `told` に
 *    対して**新しい知らせ**として配られる（3つ目の条件のとおり、正しい）
 * 4. `clone.post()` の中の `usageBlockAlwaysRearms` が token-pool の通知を
 *    resetsAt に関係なく常に再武装する（`usageBlockAlwaysRearms` の doc の
 *    3つ目の例外）ので、本物のターンが走り、また同じ理由で弾かれる → 1 に戻る
 *
 * ⟹ **3・4は、いま止まっている鍵についても resetsAt についても、何も新しい
 * ことを言っていない。** `usageBlockAlwaysRearms` が token-pool を無条件に
 * 再武装させてよい根拠は「プールへトークンを足す・削る・有効化すると
 * resetsAt の予定は無意味になる」（同 doc）ことだが、**同じ鍵の `turn_success`
 * による「また通るようになった」はプールを1文字も変えていない**——この根拠が
 * 当たらない。
 *
 * ⟹ **規則（4つ目）**: 3つ目の条件（`told` に無ければ配る）を満たしていても、
 * **`(a)` 根拠が観測（`また通るようになった`）で `(b)` いま止まっている
 * resetsAt が分かっていてまだ先で `(c)` 同じ鍵を指しているなら、畳む。**
 * `staleObservedRecoveryForBlockedKey`（`@alteroid/core`。
 * `packages/core/src/daemon-self-notice.ts`）が判定する——同じ判定を
 * `usageBlockAlwaysRearms` の呼び出し側（`post()`）と `redeliveryGate` も
 * 使う（同じ関数を複数の呼び手が使う。コピーは片方だけ直したときに黙って
 * ずれる）。
 *
 * **⚠️ `回した`（鍵の構成そのものが変わった）と `冷却が明けた`（resetsAt を
 * 過ぎた）はこの4つ目の対象外である**（`staleObservedRecoveryForBlockedKey`
 * の doc の表）。どちらも「試す価値がある新しい事実」——潰さない。
 *
 * **⛔ ここでも時間の窓・回数の上限は持ち込まない。** 見るのは状態
 * （resetsAt・鍵の同一性）だけである。
 */
export interface CloneWakeGate {
  /**
   * @param reopened 起こす／畳む対象の合図（{@link ReopenedToken}）。**`tokenId`
   *   だけでなく `how` も要る** —— 身元は `(tokenId, how)` の組である
   *   （{@link ReopenedHow} の doc: 3値は根拠の強さが違い、読む側が次に確かめる
   *   ものが違う。潰さない）。
   * @param cloneBlocked いまのクローンの状態（`CloneHost.usageBlocked`）。
   * @param releasePending **もう起こしてあるか**（`CloneHost.usageReleasePending`。
   *   Issue #1051）。真なら畳む——印が立っている間、2件目の合図が立てるものは
   *   1つも無い。
   * @param staleSameKeyRecovery **同じ鍵・同じ resetsAt に対する使い回しか**
   *   （Issue #1223 再発。上の「4つ目の条件」）。真なら、3つ目の条件
   *   （`told` の一致）を満たしていなくても畳む。**呼び手が
   *   `staleObservedRecoveryForBlockedKey` を1回計算して渡す**——ここでは
   *   計算しない（`worthDeliveringNow` を埋め込まない設計と同じ理由。上の
   *   doc「`worthDeliveringNow` が持つ...ここが持つのは...カウントの管理
   *   だけ」）。**省略時は偽**（既存の呼び出し元を壊さない。判定できない
   *   ときは能力を削らない側へ倒す。AGENTS.md 地雷2）。
   * @returns
   *   - `{ kind: 'wake' }` —— 配る。`folded` はここまで畳んだ回数
   *     （まだ0回なら0。この呼び出しでカウンタは0へ戻る）
   *   - `{ kind: 'fold' }` —— 配らない。カウンタを1増やして畳む
   */
  decide(
    reopened: ReopenedToken,
    cloneBlocked: boolean,
    releasePending: boolean,
    staleSameKeyRecovery?: boolean,
  ): { kind: 'wake'; folded: number } | { kind: 'fold' };
  /**
   * **鍵が通らなくなったことを観測した**（Issue #1223）。配達済みの印を捨てて、
   * 同じ身元の合図をもう一度配れる状態へ戻す。
   *
   * **呼ぶのは `parked`（撒いた鍵はまだ通らない）と `exhausted`（通る鍵が無い）
   * の回である**（`settleTokenOutcome`）。そこを通った後の「また通るように
   * なった」は、同じ鍵・同じ `how` でも**本物の新しい知らせ**である。
   *
   * **畳み込みカウンタ（`folded`）は触らない。** あれは母数で、ここが消してよい
   * ものは配達済みの印だけである。
   */
  observeUnusable(): void;
}

/**
 * **配ったことを覚えておく身元**（Issue #1223）。`(tokenId, how)` の組を1つの
 * 文字列にする。
 *
 * **区切りに制御文字を使わず、長さを前置きする。** 見本は
 * `packages/core/src/usage-limits.ts` の `rateLimitMemoryKey`（逐語
 * `grep -Fn -- 'export function rateLimitMemoryKey' packages/core/src/usage-limits.ts`）
 * —— エスケープのつもりで書いた NUL のエスケープが実バイトとして保存され、CI の
 * `scripts/check-tracked-nul-bytes.test.ts` が実際に落ちた（#260）。**⟹ 踏みようの
 * 無い形にする。** 長さを前に置けば「`a` と `b:c`」と「`a:b` と `c`」が同じ鍵へ
 * 化けないことが、値の中身への仮定なしに決まる。
 *
 * **呼び手は2つある（#1298 で増えた）。** 元は {@link createCloneWakeGate} の
 * `told`（このプロセス内の再武装の判定）だけだったが、`wake()` が
 * `clone.post(...)` へ渡す `payload.identity`（{@link InboxEvent} の
 * `external` 分岐）にもそのまま使う——受信箱側の畳み込み（`inbox-backlog.ts`
 * の `inboxCollapseKey`）が「畳んだ件数に関係なく同じ出来事か」を判定する
 * 鍵として。**どちらも「`(tokenId, how)` が同じか」を問うている**ので、
 * 実装を複製せず1つの関数を両方の呼び手が呼ぶ（`inboxBacklogDedupeKey` の
 * doc「なぜ1箇所に閉じるか」と同じ理由）。
 */
function deliveredIdentity(reopened: ReopenedToken): string {
  return `${String(reopened.tokenId.length)}:${reopened.tokenId}${reopened.how}`;
}

/** {@link CloneWakeGate} を作る。呼び出しのたびに新しい状態を持つ。 */
export function createCloneWakeGate(): CloneWakeGate {
  const folded = new Map<string, number>();
  /**
   * **トークン id ごとの「最後に実際に配った合図の身元」**（Issue #1223。
   * {@link deliveredIdentity}）。あるトークンの欄が無ければ、そのトークンに
   * ついてはまだ何も配っていない／再武装した後である。
   *
   * ## ⚠️ 単一の変数ではなく、トークン id ごとに持つ理由
   *
   * 最初の実装は単一の変数（`let told: string | null`）だった。**プールに
   * 複数のトークンが在ると、それは崩れる** —— トークン A を配る（`told = A`）
   * → トークン B が別の身元で配られる（`told = B` で A の記録を上書き）
   * → その直後にトークン A の**同じ**身元がもう一度（本物の新しい観測が
   * 無いまま）来ると、`told === A の身元` は偽（いまは B）になり、**畳む
   * べきものが配られる。** 単一の変数は「直前に配ったのが誰か」しか覚えられず、
   * 「このトークンに何を配ったか」を覚えない。
   *
   * **トークンごとの `Map` にすれば、他のトークンの配達に巻き込まれない**
   * （`folded` が既にトークンごとの `Map` であることと同じ理由——`folded` も
   * 単一のカウンタなら同じ形で崩れていたはずである）。
   *
   * ## 全消去（`clear()`）は `observeUnusable()` のときだけ（#1223 再発の手当て）
   *
   * **以前はここで `!cloneBlocked`（クローンが動けている）でも全消去していた
   * ——それ自体が #1223 の輪をそのまま戻していた。** `decide` が呼ばれるのは
   * `reopened` が来た回、つまり token-rotator が**本物の状態遷移としてしか
   * 出さない**合図が来た回に限られる（{@link worthDeliveringNow} の doc
   * 「合図そのものは本物の状態遷移である」）。その中で `cloneBlocked` が
   * 偽の回は「クローンはいま動けている」という事実でしかなく、**その回の
   * 合図が指している特定のトークンについて何かが変わったことは1文字も
   * 意味しない。** それでも印を全部消していたため、`decide` が
   * `cloneBlocked === false` で呼ばれるたびに他のすべてのトークンの配達済み
   * の印まで再武装され、次に同じトークン・同じ `how` の合図が来ると（鍵は
   * 一度も通らなくなっていないのに）もう一度配っていた——実運用
   * （2026-09-18〜19 の再発。上位層が本番 DB を直接観測）で 04:05 / 04:07 /
   * 04:09 / 04:11 に同じ鍵・同じ根拠の起床が繰り返され、鍵は `usable` のまま
   * 一度も遷移していなかった。
   *
   * **いま全消去するのは `observeUnusable()`（鍵が通らなくなったと観測した）
   * だけである。** あれは `parked` / `exhausted` という**本物の観測**にしか
   * 紐づかない——「特定のどのトークンの事実か」を1つに絞れないのでトークン
   * 全体を再武装するのは変わらないが、**再武装の引き金そのものを観測
   * （エッジ）だけに絞った。** これで足りることは
   * `describe('🔴 #1051: 1回の再開の機会につき、配る合図は1件')`（`index.test.ts`）
   * の `fakeClone` が固定している——本物の `clone.ts` は「止まっていない →
   * 止まった」の遷移のたびに必ず先に `observeUnusable()` を呼ぶ
   * （`#noteUsageNotice` が `#observeForTokenRotation` を待ってから
   * `#usageBlocked` を立てる。`fakeClone` の doc に配線の逐語がある）ので、
   * #1051 が要求する「起こし損ねを作らない」不変条件はこの edge だけで満たせる
   * ——`cloneBlocked` の値そのものを見て消す必要は無かった。
   *
   * **⛔ 時間の窓や配達回数の上限は持ち込まない**（`docs/north_star.md` の
   * 禁止2）。ここが持つのは状態（最後に配った合図の身元）だけで、再武装は
   * 観測にだけ紐づく——この行き止まりは上の {@link CloneWakeGate} の doc
   * 「3つ目の条件」の規則そのものである。
   */
  const told = new Map<string, string>();
  return {
    decide(reopened, cloneBlocked, releasePending, staleSameKeyRecovery = false) {
      const tokenId = reopened.tokenId;
      if (!worthDeliveringNow(cloneBlocked, releasePending)) {
        // **配達済みの印はここでは触らない**（Issue #1223 再発の手当て。
        // 理由の全文は `told` の doc「全消去（`clear()`）は `observeUnusable()`
        // のときだけ」）。`worthDeliveringNow` が偽になる理由（止まっていない
        // ／もう起こしてある）は、どちらもこの特定のトークンの鍵が通らなく
        // なったことも通るようになったことも意味しない。`told` を消すのは
        // {@link CloneWakeGate.observeUnusable}（本物の観測）だけにする。
        folded.set(tokenId, (folded.get(tokenId) ?? 0) + 1);
        return { kind: 'fold' };
      }
      /**
       * **4つ目の条件**（Issue #1223 再発。{@link CloneWakeGate} の doc「4つ目
       * の条件」）。**3つ目の条件（`told` の一致）より前に見る**——
       * `observeUnusable()` が `told` を全消去した直後（＝3つ目の条件だけなら
       * 必ず `wake` になる回）こそ、この輪が実際に踏まれた形だからである。
       *
       * **`told` は更新しない。** 畳んだのは「新しい知らせに見えたが、実際は
       * 同じ鍵の同じ resetsAt への使い回しだった」であって、`told` に記録する
       * ような「本物の配達」が起きたわけではない——次にこの関数を呼ぶときも
       * 呼び手（`wake()`）が生きた `usageBlockedResetsAt` /
       * `usageBlockedTokenId` から同じ判定をやり直す。
       */
      if (staleSameKeyRecovery) {
        folded.set(tokenId, (folded.get(tokenId) ?? 0) + 1);
        return { kind: 'fold' };
      }
      /**
       * **前にこのトークンへ配ったものと同じなら畳む**（Issue #1223。3つ目の歯）。
       * ここへ来るのは `blocked && !releasePending`、つまり「止まっていて、
       * まだ起こしていない」回である —— #1051 の門はこれを通すので、**ターンを
       * 跨いだ反復を止めるのはここだけである。**
       *
       * **畳み込みカウンタは既存と同じように1増やす。** 母数は消さない
       * （{@link describeReopenedTokenNotice} が次に配る本文へ載せる）。
       */
      const identity = deliveredIdentity(reopened);
      if (told.get(tokenId) === identity) {
        folded.set(tokenId, (folded.get(tokenId) ?? 0) + 1);
        return { kind: 'fold' };
      }
      // **配る回で 0 へ戻す。** 消し忘れると、次に同じトークンで畳み始めたときに
      // 前回の回のぶんを引き継いでしまう。
      const count = folded.get(tokenId) ?? 0;
      folded.delete(tokenId);
      told.set(tokenId, identity);
      return { kind: 'wake', folded: count };
    },
    observeUnusable() {
      told.clear();
    },
  };
}

/**
 * 「認証トークンが通る状態に戻った」の合図の本文（Issue #783）。
 *
 * **畳んだぶんが在れば一文を足す。** 文言は `manager.ts` の
 * `mergeSynthesizedNoticeFragments` の見本に寄せてある——あちらは「1つの
 * 出来事について N 件の知らせをまとめた」と、まとめて出す形。ここは出すのを
 * 1件に絞って残りは配らない形なので、「N 件を1件にまとめた」と言い方を
 * 変えている（母数は消していないことを本文からも読めるようにする）。
 *
 * **`folded` が0のときは何も足さない。** 畳んでいない回に断り書きを付けると、
 * いちばん多い「畳んでいない」場合の本文に余計な一文が乗る
 * （`mergeSynthesizedNoticeFragments` の「1件のときは前置きを付けない」と
 * 同じ理由）。
 *
 * **畳んだ回（`folded > 0`）は観測時刻も名乗る（Issue #1375）。** この本文は
 * 「通る状態に戻った」を常に現在形で言うが、畳んだ回は受信箱の滞留や
 * `pendingTokenWake` の据え置きで**配るのが遅れうる**——読み手が実際に目に
 * するのは、事実そのものより後である。**現在形の文言は変えない**（決めたのは
 * 「時刻を名乗る」であって「言い方を変える」ではない）。代わりに `observedAt`
 * （呼び出し側が `clone.post(...)` の `at` に使うのと**同じ** UTC ISO 8601
 * 文字列。この関数を呼ぶ時点でこの本文の内容——`reopened` の中身——を確定
 * させた瞬間の値である）を添え、読み手が「この本文はいつの観測か」を自分で
 * 判断できるようにする。**畳んでいない回（`folded <= 0`）の本文は1文字も
 * 変えない**——単発の合図は遅れが積み上がらないので、この断り書きの対象では
 * ない。
 */
export function describeReopenedTokenNotice(
  reopened: ReopenedToken,
  folded: number,
  observedAt: string,
): string {
  const base =
    `認証トークンが通る状態に戻った（${reopened.how}）: ` +
    `「${reopened.label}」（id ${reopened.tokenId}）。` +
    '枠で止まっていた仕事は、ここから再開できる。';
  if (folded <= 0) return base;
  // 配った1件に、畳んで届かなかった folded 件を足すと、この間に実際に届いた総数。
  return (
    `${base}（この間に同じ合図が ${String(folded + 1)} 件届き、1件にまとめた。` +
    `本文は ${observedAt} の観測である）`
  );
}

/**
 * `tokenRotationStream` の網羅性チェック専用。呼ばれること自体が保証で、
 * `event` の型が `never` でなくなった時点（＝ 未対応の値が足された時点）で
 * 呼び出し側が型エラーになる。実行時にここへ来ることは型が守っている限り
 * 起こらないので、`console.warn` で安全側へ倒す代わりに例外にしてある——
 * `entry.event` はこのプロセスが直前に組み立てた値であり、別デプロイを跨いで
 * 読み直した値ではないため（`commitments.tsx` の `assertClosedByHandled` が
 * 緩い保存層からの読み直し値を相手にするのとは前提が違う）。
 */
function assertTokenRotationEventHandled(event: never): never {
  throw new Error(`alteroidd: 認証トークンの日誌で未知の event: ${String(event)}`);
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

  /**
   * **alteroid 自身の運用設定を、環境変数の袋（DB 正本）へ播種してから反映する。**
   * `TZ` / `ALTEROID_ALLOWED_ORIGINS` / 自律のスケジュール等を「器を焼き直さないと
   * 直せない」ままにしないための口である（`env-vars-boot.ts` の doc）。
   *
   * **ここで（この後の CORS・認証・スケジュールの組み立てより前で）行う。** 反映は
   * `process.env` を書き換えるだけなので、後続のコードが読む `process.env.X` は
   * すべて素通りで新しい値を受け取る——各所を個別に直さずに済む。
   *
   * 播種・反映のどちらも失敗を投げない（`env-vars-boot.ts` の doc）ので、ここで
   * `await` しても起動を止めない。
   */
  await seedDefaultEnvVars(stores);
  await applyAppScopedEnvVars(stores);

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

  /**
   * 器を1つ失った（`onLost`）ことを、日誌へ構造化して残す。
   *
   * **以前は `announce()` で知らせるだけで、日誌には残らなかった**——後から
   * 頻度を数える手段が無かった（#916 c2-4 から切り出した #1381）。`onLost`
   * はここでは無条件に `relocateOnLost` を呼ぶ（奪ってよいかは貸し出し期限が
   * 判定する）ので、`onSwap` 側の `noteRunnerSwap` のような「起こすかどうか」
   * の分岐は要らない——起きたことをそのまま記録するだけでよい。
   *
   * `external_event` にするのは `reportRunnerDropped` / `reportRunnerUnknown`
   * と同じ理由——これは**デーモンから見た外側の観測**であって、クローンを
   * 起こすかどうかの `decision`（`onSwap` 側）とは違う。
   *
   * **記録の失敗でデーモンを止めない。** 落ちたときだけ stderr に出す
   * （`reportRunnerDropped` と同じ作法）。
   */
  const reportRunnerLost = (report: { label: string; runnerId?: string; error: string }): void => {
    const summary =
      `runner (${report.label}${report.runnerId === undefined ? '' : ` / ${report.runnerId}`}) を` +
      `失いました（onLost）: ${report.error}`;
    void stores.journal
      .append({ type: 'external_event', source: 'runner', summary })
      .catch((error: unknown) => {
        process.stderr.write(
          `alteroidd: runner を失ったことを日誌へ残せませんでした: ${reasonOf(error)}\n` +
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
   * クローンの受信箱へ入れる口。**クローンが立ち上がるより先に名簿が動きうる**ので、
   * 宛先は後から差し替える（`takeOverOnSwap` / `relocateOnLost` と同じ形。
   * `announce` を `let` にして丸ごと差し替えるのではなく、こちらだけを `let` にして
   * `announce` は `const` にしてある — こうすると `announce` の中身（stderr へは
   * 必ず書く、クローンへは持てるときだけ渡す）が起動の前半・後半で変わらず、
   * 読む側が2つの定義を突き合わせる必要が無い。
   */
  let postToClone: ((text: string) => void) | undefined = undefined;
  /**
   * 挑み直しても直らない失敗の行き先。
   *
   * **人間（stderr）とクローン（受信箱）の両方へ出す。** 片方だけだと、ログを
   * 見ていない人間か、事実を知らないクローンのどちらかが取り残される。stderr は
   * 最初から使えるので直接書き、クローンの受信箱は `postToClone` が持てるように
   * なってから届く（それまでは黙って落ちる——起動直後にここへ来る事象は稀で、
   * 稀だからこそ stderr にだけでも残る形にしてある）。
   */
  const announce = (text: string): void => {
    process.stderr.write(`alteroidd: ${text}\n`);
    postToClone?.(text);
  };
  /**
   * 器の入れ替えを見たときに引き取りを起こす口。**宛先は後から差し替える。**
   *
   * `announce` と同じ形にしてある（クローンが立ち上がるより先に名簿が動きうる）。
   * 直に `takeOver` を呼ぶ形にすると、まだ初期化されていない `const` を触る経路が
   * 残る — 起きるのは稀な順序のときだけなので、**起きたときにしか分からない**。
   */
  let takeOverOnSwap: (runnerId?: string) => void = () => {};
  /**
   * 宛先が黙ったときに移送を起こす口。**宛先は後から差し替える。**
   *
   * `takeOverOnSwap` と同じ形にしてある（クローンが立ち上がるより先に名簿が
   * 動きうる）。
   */
  let relocateOnLost: (runnerId?: string) => void = () => {};
  const runners = createRunnerRegistry([], {
    notify: ({ label, error }) => {
      announce(
        `runner (${label}) を開けず、挑み直しても直らない失敗だったので諦めました: ${error}`,
      );
    },
    /**
     * 一度は繋がった runner が黙った。
     *
     * **いまはここが移送の契機でもある（roadmap M5 PR5）。** かつては「知らせる
     * ところまでが責任」で、走っていた仕事を別の器へ移さずにいた——二重実行を
     * 止める仕組み（fencing）がまだ無かったからである。**fencing は #160 で
     * 入っている**（`lease.ts` の `judgeLease` / `ManagerPool` の関門
     * `#claimForResume` / runner 側が命令ごとに見る `fence`）。
     *
     * だからここから `relocateFrom(runnerId)` を呼んで取り直しを起こしてよい。
     * **奪ってよいかの判定はこの先の関門（貸し出し期限）が持つ** — まだ持ち主が
     * 握っている委譲は、この呼びでは動かされずに挑み直しの梯子へ載るだけである
     * （「実は生きていた器と移送先とで同じマネージャーが2本走る」という以前の
     * 懸念は、この関門が塞いでいる）。
     */
    onLost: ({ label, runnerId, error }) => {
      announce(
        `runner (${label}${runnerId === undefined ? '' : ` / ${runnerId}`}) が` +
          `名乗らなくなりました。新しい委譲の宛先からは外し、` +
          `そこで走っていた委譲の移送を試みます` +
          `（貸し出し期限が切れていない委譲は、切れてから自動で移します）: ${error}`,
      );
      reportRunnerLost({ label, runnerId, error });
      relocateOnLost(runnerId);
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
     *
     * ## ただし、クローンを起こすのは対象が1本以上ありそうなときだけ
     *
     * runner は3台あり、デプロイのたびに最低3回ここが呼ばれる。以前は
     * `announce(...)` を無条件に呼んでいたため、**引き取り対象の委譲が0本の
     * ときも毎回クローンを起こしていた**——依頼者は24時間で6回起こされ、6回とも
     * 「何もしない」と答えている。
     *
     * **stderr へは今まで通り無条件に書く**（人間はログを見れば全部わかる）。
     * クローンを起こすかどうかだけを `noteRunnerSwap`
     * （`runner-swap-notice.ts`）に委ねる——台帳と名簿を突き合わせ、対象が
     * 0本と積極的に数え切れたときだけ起こさない。**数えられない・読めないときは
     * 必ず起こす側へ倒す**（`runner-swap-notice.ts` の doc「設計の芯」）。
     *
     * 起こさなかった回も、判断そのもの（何本と数えて起こさなかったか）は
     * `journal` の `decision` として必ず残る——`reportRunnerUnknown` /
     * `reportRunnerDropped` が `external_event` を直に書くのと同じ「クローンを
     * 起こさずに記録だけ残す」作法だが、こちらは `decision` を使う。
     * `external_event` にすると `clone.post({ type: 'external', ... })` と
     * 同じ見え方になり、「起こしたのか起こしていないのか」が日誌から区別できなく
     * なるためである。
     */
    onSwap: ({ label, runnerId, before, after }) => {
      const text =
        `runner (${label}${runnerId === undefined ? '' : ` / ${runnerId}`}) に` +
        `別のプロセスが応え始めました（器の入れ替え）。` +
        `そこで走っていた委譲の引き取りを試みます` +
        `（貸し出し期限が切れていない委譲は、切れてから自動で引き取ります）: ` +
        `${before} → ${after}`;
      process.stderr.write(`alteroidd: ${text}\n`);
      // `runners` はこのコールバックを包む `createRunnerRegistry(...)` の戻り値を
      // 束ねる `const` で、参照するのはコールバックが実際に呼ばれる実行時
      // （構築が終わった後）なので TDZ にはならない。**万一それでも投げたら**
      // `aliveRunnerIds()` の try/catch がそれを拾い、「名簿を読めなかった」＝
      // 起こす側へ倒れる（`noteRunnerSwap` の doc）。
      void noteRunnerSwap({
        notice: text,
        runnerId,
        listJobs: () => stores.jobs.listJobs(),
        // 「生きている」＝ `state === 'connected'`。`relocateFrom`
        // （`packages/core/src/manager.ts`）が移送先を選ぶときと同じ条件——
        // `RunnerEntry` は `alive` という欄を持たない（それは内部の
        // `RegistryEntry` にしか無い）ので、公開の名簿が持つ `state` で揃える。
        aliveRunnerIds: () =>
          new Set(
            runners
              .entries()
              .flatMap((entry) =>
                entry.state === 'connected' && entry.runnerId !== undefined ? [entry.runnerId] : [],
              ),
          ),
        journal: (entry) => stores.journal.append(entry),
        wake: postToClone,
        warn: (message) => process.stderr.write(`alteroidd: ${message}\n`),
      });
      takeOverOnSwap(runnerId);
    },
  });
  const runnerDescription = describeRunner();

  // 層とモデル帯の対応は設計判断であり、変更には人間の承認が要る（AGENTS.md 地雷5）。
  // 差し替えられていたら**黙って通さない** — 上位帯から降りたことは人間が意図した
  // ときだけ起きるべきで、起動ログに出ていなければ誰も気づけない。
  const cloneModel = resolveCloneModel();
  if (cloneModel !== CLONE_MODEL) {
    process.stdout.write(
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
    process.stdout.write(
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
    process.stdout.write(
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

  /**
   * 人間の MCP 連携の登録を置いて runner へ配る1本道（#325 段3）。**インスタンスは1つだけ。**
   *
   * 人間の口（`PUT /mcp-servers`）と、runner が名乗り直したときの降ろし直し
   * （`ManagerPool` の `#pushMcpServers`）は同じものを書き換えるので、別インスタンスを
   * 持つと直列化の意味が消える（`profileService` と同じ理由）。
   */
  const mcpServerService = createMcpServerService({ stores, runners });

  /**
   * マネージャーへ降ろす環境変数（名前→値）の1本道。**インスタンスは1つだけ。**
   *
   * 人間の口（`PUT /credentials`）と、runner が名乗り直したときの降ろし直し
   * （`ManagerPool` 経由）は同じものを書き換えるので、別インスタンスを持つと
   * 直列化の意味が消える（`profileService` と同じ理由）。
   *
   * **伏せる鍵の名前を渡す。** 渡し忘れると「伏せたはずの環境変数を鍵の名前として
   * 注入し直せる」穴が開く（器の側と同じ拒否を、400 を返せる位置にも置く）。
   */
  const credentialService = createCredentialService({
    stores,
    runners,
    withheldEnvKeys: [...WITHHELD_ENV_KEYS, ...storage.withheldEnvKeys],
    /**
     * **GitHub の名前で、正本の行より器の環境変数の値が優先して配られている**
     * （Issue #865 の恒久策、2026-09-12）ことを知らせる。正本にその名前の行が
     * 在り、かつこのデーモンの器の env にも別の値が在るときだけ立つ
     * （`cloneEnvShadowedNames` の doc）。
     *
     * **値も指紋も渡ってこない**（`onCloneEnvShadowed` の型）ので、ここで
     * 出す行にも名前しか載らない。**⚠️ 「正本が勝つ」だった以前の仕様は、
     * GitHub の名前について反転した**（`resolveCredentialRows`）——ここは
     * 知らせるだけで、勝敗の決定そのものはしない。
     *
     * 連続した同じ食い違いは呼ばれない（`createCredentialService` 側で
     * 抑止済み）ので、ここで頻度を気にする必要は無い。
     */
    onCloneEnvShadowed: (names) => {
      process.stderr.write(
        `alteroidd: GitHub の名前で、正本の行よりこのデーモンの器の環境変数の値が` +
          `優先して配られています（マネージャーもクローンも、器の環境変数の値で` +
          `走っています。正本のその行は配られていません）: ${names.join(', ')}。` +
          `正本のその行を外しても配られる値は変わりません（どちらにしても器の` +
          `環境変数の値が配られます）。揃えるには、正本の値を器の環境変数に` +
          `合わせて置き直すか（alteroid credential set <名前>）、器の環境変数の` +
          `側を変えてください（この HTTP の口からは変えられません）\n`,
      );
    },
  });

  /**
   * 認証トークンのプール（Issue #393「PR1 プールの器」）。**回さない**——ここで
   * 作るのは器の読み書きの口だけで、検知・切替は回し手が持つ（`createTokenRotator`）。
   *
   * `profileService` と同じく**インスタンスは1つだけ**。人間の口（`PUT /tokens`）と
   * クローンの道具（まだ無い。Issue #456）が別インスタンスを持つと、直列化の意味が
   * 消える。
   */
  const tokenPoolService = createTokenPoolService({
    stores,
    /**
     * **人間が鍵を足した / 外した / 戻した / 並べ替えた瞬間を契機にする**
     * （人間の決定 2026-09-07）。
     *
     * ここが無かったあいだ、`PUT /tokens` は記憶ストアを書くだけだった ⟹
     * **全層が枠で止まっている器へ新しい鍵を1本足しても、何も起きなかった。**
     * 回すには誰かがもう一度本番で失敗して観測を上げる必要があり、そのとき
     * 全層は止まっているので観測を上げる主体が1つも居ない。
     *
     * **CLI もここへ来る**（`alteroid token add` / `enable` / `policy` は
     * HTTP を通る）⟹ 人間のどの口からでも届く。
     */
    onChanged: (change) => {
      tokenWatch?.poke(change === 'settings' ? 'settings_changed' : 'pool_changed');
    },
  });

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
  process.stdout.write(`alteroidd: ${authPlan.description}\n`);

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
   * 認証トークンの回し手（Issue #393 PR3）。**デーモンの中の1本。**
   *
   * ここで組み立てる部品は4つ——現役をクローンへ渡す箱、撒く口、回し手本体、
   * そして見張り（`token-watch.ts`）。**判定も選択も回し手が持つ**ので、
   * クローンとマネージャーと見張りは観測と契機を渡すだけになる。
   *
   * **箱（`agentTokenHolder`）を先に作る。** 枠の probe（下の `usagePoller`）が
   * **現役の env でアカウントを測る**ために要る —— 渡さないと probe は器の
   * 環境変数を継承し、**回した後は降りたトークンのアカウントを測り続ける。**
   */
  const agentTokenHolder = createAgentTokenHolder();

  /**
   * 認証トークンの見張り（`token-watch.ts`）。
   *
   * **前方参照である。** 見張りは回し手を要るが、回し手より先に契機を渡す側
   * （`tokenPoolService` の `onChanged` / 下の `usagePoller` の `onState`）が
   * 組み立てられる。closure は呼ばれた瞬間の束縛を見るので、**呼ばれるより先に
   * 両方とも作られていれば壊れない**（同じ形の前方参照が `scheduler` と
   * `clone` のあいだに既に在る）。
   *
   * **`undefined` のあいだの契機は落ちる。** それは起動の数十ミリ秒だけで、
   * その直後に `reason: 'startup'` の見直しが1回走るので、落ちた契機の分も
   * そこで拾える。
   */
  // **`= undefined` を明示する。** `let` の宣言だけだと `prefer-const` が
  // 「一度も再代入されていない」と数えて `const` を勧めてくるが、`const` には
  // できない（上の closure がこの束縛を参照する）。
  let tokenWatch: TokenRotationWatch | undefined = undefined;
  /**
   * ダメ元の試し（Issue #1501。`token-trial-watch.ts`）。**`tokenWatch` と同じ
   * 理由で `undefined` を明示する。** `settleTokenOutcome` / `tokenRotator` を
   * 要るので、`tokenWatch` と同じ地点（クローンの後）で組み立てる。
   */
  let tokenTrialWatch: TokenTrialWatch | undefined = undefined;

  /**
   * **畳まれるのを待っている「再開の合図」**（人間の決定 2026-09-07）。
   *
   * 認証トークンを回した瞬間にクローンがターンの最中だと、セッションが畳まれるのは
   * **そのターンが終わってから**である。⟹ 合図をその手前で入れると、**古い鍵の
   * ターンに消費されて、そのターンは死ぬ**（実運用で26分の沈黙になった形。
   * `Clone.recycleSessionForToken` の doc に実測の表が在る）。
   *
   * だからここへ置いておき、`onTokenSessionRecycled` が鳴った瞬間に入れる。
   *
   * **高々1つしか持たない。** 畳むより先に2回回ったら、**後の1回だけが要る** ——
   * 前の回の合図は「もう古い鍵の話」であり、入れても同じ結論を2回焼くだけである。
   */
  let pendingTokenWake: (() => void) | undefined = undefined;

  /**
   * **「認証トークンが通る状態に戻った」の合図を、クローンへ配るか畳むか**
   * （Issue #783。{@link CloneWakeGate} の doc）。
   *
   * デーモンの寿命ぶん1つだけ持つ——`wake()` は呼ばれるたびに新しい closure だが、
   * トークンごとの畳み込みカウントは呼び出しをまたいで覚えている必要がある。
   */
  const cloneWakeGate = createCloneWakeGate();

  /**
   * **`token_rotation` の日誌行を畳む窓**（issue #1311 段B。
   * {@link TokenRotationJournalFold}）。
   *
   * デーモンの寿命ぶん1つだけ持つ——`token-rotation-journal-fold.ts` の doc の
   * とおり、書く経路（`settleTokenOutcome`）はデーモンに1本しか無いので
   * `cloneWakeGate` と同じく単一のインスタンスでよい。**止まるときに
   * `flush()` を呼ぶ**（下の `shutdown()`）。
   */
  const tokenRotationJournalFold = new TokenRotationJournalFold();

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
   *
   * **⚠️ ここは「セッションを1本も使わずに枠を測れる」唯一の場所である**
   * （人間の決定 2026-09-07）。回し手へ届く6つの検知点はどれもセッション由来
   * なので、**全層が止まると観測を上げる主体が1つも居なくなる。** ここを
   * 見張りへ繋いだのがその穴の塞ぎ方である（`token-watch.ts` の doc）。
   */
  const usagePoller = startUsagePolling({
    queryFn: query,
    cwd: paths.root,
    // **現役のトークンで測る。** 呼ばれるたびに読み直す（回すのは走行中である）。
    // 既定の構成では空を返すので、器の環境変数がそのまま効く（受け入れ基準7）。
    env: () => agentTokenHolder.values(),
    // **測った結果を見張りへ渡す。** 判定（`judgeTokenCandidate`）は見張りが通す。
    onState: (state) => {
      tokenWatch?.observeAccount(state);
    },
    // **記憶ストアへ到達する鍵を probe の子プロセスへ渡さない（#431）。**
    // `Runner` / `createProfileVessel` へ渡しているのと同じ `storage.withheldEnvKeys`。
    withheldEnvKeys: storage.withheldEnvKeys,
  });

  /**
   * **器の環境変数（`CLAUDE_CODE_OAUTH_TOKEN`）へのフォールバックは廃止した**
   * （人間の決定。トークンプールは100% DB 駆動にする——`alteroid token add` で
   * 実トークンを登録することが唯一の入口であり、プールに通る行が無い状態を
   * 器の環境変数の値で埋め合わせる経路はどこにも残さない）。
   *
   * **⚠️ かつて（2026-09-12〜2026-09-14、#866・#832）はここに `agentTokenFromEnv`
   * という関数があり、`hasEnvToken` オプション・probe の env 分岐・`ensureEnvToken()`
   * の呼び出し・`createRunnerTokenSync` への2つ目の引数として使われていた。**
   * 全部撤去した——プールが選んだトークンの `value` だけを probe・撒く先の両方が
   * 使う。
   */
  const tokenRotator = createTokenRotator({
    stores,
    probe: {
      // **本番の仕事で試さない**（Issue #393 の設計の骨）。推論が走らない probe。
      probe: (token) =>
        probeTokenCandidate(query, {
          token: token.value,
          cwd: paths.root,
          // **同上（#431）。** 候補トークンの観測でも記憶ストアの鍵は渡さない。
          withheldEnvKeys: storage.withheldEnvKeys,
        }),
    },
    spread: createTokenSpread({
      runners,
      clone: agentTokenHolder,
      // **プロファイルが評価済みで持っている env の名前**。取れなければ空を返す
      // ——その場合は影を検出できないが、「影が無い」とは主張しない
      // （`createTokenSpread` の doc）。
      profileEnvNames: () => Promise.resolve(Object.keys(profile.env())),
      onShadowed: (names) => {
        process.stderr.write(
          `alteroidd: 実行環境プロファイルが認証の鍵と同じ名前を宣言しています。` +
            `回した鍵はこれで上書きされます: ${names.join(', ')}\n`,
        );
      },
    }),
  });

  // **クローンを作る前に撒き直す。** `createClone` は構築の中でループを回し始める
  // ので、後にすると最初のターンが撒く前の状態のまま走る窓ができる。
  //
  // **繋がっていない runner へは、ここでは届かない。** 後から上がってくる分は
  // `syncRunnerToken`（`ManagerPool#connectTo`）が追いつかせる。
  {
    const restored = await tokenRotator
      .restore()
      .catch((error: unknown) => ({ kind: 'failed' as const, why: String(error) }));
    // **何も起きていないとき（`none`）は黙る。** 既定の構成では毎回の起動で出る
    // ことになり、意味のある行が埋もれる。
    // **日誌にも残す。** 標準出力・標準エラーは器のログへ流れて消えるが、日誌は
    // 記憶ストアに残り、クローンも人間も後から辿れる。
    // **`restore()` そのものが投げた場合と、`TokenRestoreOutcome` が返る場合を
    // 分けたまま同じ種別へ載せる。** 前者は `TokenRestoreOutcome` ではないので
    // `tokenRestoreEntry` を通せない（型が受けない）。
    const entry =
      restored.kind === 'failed'
        ? ({
            type: 'token_rotation' as const,
            event: 'restore_failed' as const,
            text: `認証トークン: 起動時の撒き直しが落ちた。${restored.why}`,
          } satisfies TokenRotationEntry)
        : tokenRestoreEntry(restored);
    if (entry !== null) {
      // **`event` から行き先を決める**（Issue #420 の残件）。`restored`（正常）は
      // stdout、`restore_failed`（異常）は stderr——`tokenRotationStream` に分類を
      // 1箇所へ閉じてある。
      tokenRotationStream(entry.event).write(
        `alteroidd: ${entry.text.split('\n')[0] ?? entry.text}\n`,
      );
      // **落ちても黙って消さない**（回した側と同じ作法）。直す前はここが
      // `.catch(() => undefined)` で、追記が落ちたことがどこにも残らなかった。
      await stores.journal.append(entry).catch((error: unknown) => {
        noteDroppedRecord('認証トークンの撒き直し', 'journal', error);
      });
    }
  }

  const clone = createClone({
    stores,
    accountUsage: () => usagePoller.state(),
    // **`scheduler` はこの直後（下）に作る。** ここは同じ形の前方参照が既に
    // 在る場所である — 数行下の `onUsageObservation` が `clone` 自身を
    // 同じやり方で参照している（closure は呼ばれた瞬間の束縛を見るので、
    // 呼ばれるより先に両方とも作られていれば壊れない）。
    scheduler: () => scheduler.list(),
    cwd: paths.root,
    runners,
    profile,
    profileService,
    credentialService,
    // **クローンの子プロセス（`Bash` / MCP / 作業者を含む）にもログイン基盤の
    // 鍵を渡さない**（Issue #1495 ①）。`storage.withheldEnvKeys` はここでは
    // 使わない——pg 構成では `ALTEROID_DATABASE_URL` を含んでおり、それは
    // クローンが記憶ストアへ到達するために要る鍵だからである
    // （`CloneOptions.withheldEnvKeys` の doc）。
    withheldEnvKeys: [...AUTH_WITHHELD_ENV_KEYS],
    mcpServerService,
    self,
    // 現役のトークン。**値ではなく関数**——構築時に凍らせない（`CloneOptions` の doc）。
    credentials: () => agentTokenHolder.values(),
    tokenIdentity: () => agentTokenHolder.identity(),
    // 後から上がってきた runner に追いつかせる（プロファイルの `syncRunner` と同じ位置）。
    syncRunnerToken: createRunnerTokenSync(agentTokenHolder),
    /**
     * **セッションが実際に畳まれた ⟹ 待たせていた再開の合図を、いま入れる**
     * （人間の決定 2026-09-07。`pendingTokenWake` の doc）。
     *
     * ここから先に入れる合図は、**次の `#ensureQuery()` が起こす新しい鍵の
     * セッション**で受け取られる。手前で入れると古い鍵のターンに消費される。
     *
     * **取り出してから呼ぶ。** 呼んだ後に消すと、合図の中で例外が出た回だけ
     * 残り続け、次に畳まれたときにもう一度入る。
     */
    onTokenSessionRecycled: () => {
      const wake = pendingTokenWake;
      pendingTokenWake = undefined;
      wake?.();
    },
    onUsageObservation: async (observation) => {
      // **成功の観測は `observe` へは1文字も渡さない**（#681 (1)。
      // `TokenRotatorObservation.succeeded` の doc）。あちらは枠の観測しか
      // 扱わないので、成功は別の生産者（`TokenRotator.reconsider` の
      // `turn_success`）へ振る——`tokenWatch` が世代の門を掛けた上で
      // `reconsider` を呼び、結果は `onOutcome`（下の `settleTokenOutcome` と
      // 同じ1本）へ流れる。ここで `return` するのは、この observation を
      // 二重に処理しないためである。
      if (observation.succeeded === true) {
        tokenWatch?.observeTurnSuccess(observation.observedBy);
        return;
      }
      // **偽陽性の退き方（Issue #1501 設計点8）の材料。** 本物の拒否
      // （セッション由来。`observedBy.tokenId` が名乗る鍵）が、試しで通した
      // 直後の窓のあいだに届いたら、その鍵の試しの間隔を倍にする。ここは
      // 材料を渡すだけで、日誌にも受信箱にも触らない——それは直後の
      // `tokenRotator.observe` → `settleTokenOutcome` が普段どおり行う。
      // **状態の変化だけでなく、いまの状態も見る**（issue #1543。
      // `isRejectionForTrialBackoff` の doc）。
      if (isRejectionForTrialBackoff(observation)) {
        tokenTrialWatch?.noteRejection(observation.observedBy.tokenId);
      }
      const outcome = await tokenRotator.observe(observation);
      // **当たった文言をそのまま添える**（Issue #393「言い換えずそのまま残す」）。
      // 人間が claude.ai と突き合わせられることと、回復の見込みの分類が効くことの
      // 両方がこれに乗っている。
      await settleTokenOutcome(outcome, {
        ...(observation.notice === undefined ? {} : { noticeText: observation.notice.text }),
      });
    },
    ...(storage.sessionStore === undefined ? {} : { sessionStore: storage.sessionStore }),
    /**
     * **`#restoreUnread` の門**（Issue #783 続き。`RedeliveryGate` の doc）。
     *
     * token-pool の「通る状態に戻った」通知だけを、`wake()` の門
     * （{@link CloneWakeGate.decide}）と**同じ実体**（`worthDeliveringNow`）で
     * 判定し直す——それ以外の型（人間の発言・マネージャーの報告など）は常に配る
     * （`true`）。
     *
     * **⚠️ Issue #1223 再発で4つ目の門が増えた。** `#restoreUnread` は
     * `post()` を一度も通らないので（`RedeliveryGate` の doc）、
     * `usageBlockAlwaysRearms`（`clone.ts` の `post()`）が持つ4つ目の条件の
     * 例外（同じ鍵・同じ resetsAt に対する使い回しは再武装しない）も自動では
     * 掛からない。**`wake()`（`CloneWakeGate.decide`）と同じ関数**
     * （`staleObservedRecoveryNoticeEvent`）をここでも呼び、`worthDeliveringNow`
     * が真でも同じ理由で畳む。コピーではなく同じ実体を呼ぶことは
     * `index.test.ts` の「歯1」が固定している。
     */
    redeliveryGate: (
      event,
      { usageBlocked, releasePending, usageBlockedResetsAt, usageBlockedTokenId },
    ) =>
      isTokenPoolReopenedNotice(event)
        ? worthDeliveringNow(usageBlocked, releasePending) &&
          !staleObservedRecoveryNoticeEvent(event, usageBlockedResetsAt, usageBlockedTokenId)
        : true,
  });

  /**
   * 生ログの末尾から「ターンが終わっているらしい」という助言を計算し直す
   * （Issue #567）。**知らせるだけ** —— `ManagerPool#probeTurnEnds` の doc の
   * とおり、`status` を動かす・委譲を abort する・貸し出し期限を縮める、の
   * どれもしない。`clone.managers` が要るので `clone` の後に作る。
   */
  const managerPoller = startManagerPolling({
    managers: clone.managers,
  });

  /**
   * 退避済み生ログ（`archive`）の古い写しを定期的に自動で畳む（issue #698。
   * `archive-folder.ts`）。**`clone.managers` が要るので `clone` の後に作る**
   * ——走行中の委譲が抱えている行を `guardArchiveRemoval` で落とすため
   * （`managerPoller` と同じ理由）。
   *
   * `ALTEROID_ARCHIVE_FOLD_EVERY` が `off` 系の綴りなら周期を仕込まない
   * （`readArchiveFoldConfig` が `null` を返し、`startArchiveFolding` は
   * タイマーを1つも起こさない）。読めなかった設定値は `schedule` と同じ形で
   * stderr へ流す。
   */
  const archiveFoldConfig = readArchiveFoldConfig();
  for (const note of archiveFoldConfig.notes) process.stderr.write(`alteroidd: ${note}\n`);
  const archiveFolder = startArchiveFolding({
    stores,
    managers: clone.managers,
    everyMinutes: archiveFoldConfig.everyMinutes,
  });

  /**
   * 回し手が出した結果1件を片付ける。**観測から来た回と、状態から来た回で同じ
   * ここを通る**（人間の決定 2026-09-07）。
   *
   * ## なぜ1本にするか
   *
   * 直す前は `onUsageObservation` の中だけに在った。見張り（`token-watch.ts`）を
   * 足すときに同じ処理をもう1本書くと、**片方だけが `parked` を知らない・片方
   * だけがセッションを作り直す**という食い違いが静かに生まれる —— そして
   * 「出なかった」は出ていないので気づけない（`tokenRotationEntry` の doc が
   * stderr と日誌について同じことを言っている）。
   *
   * ## 何をするか（4つ）
   *
   * 1. **指名が変わったらクローンのセッションを作り直す**（env は起動時に凍る）
   * 2. **通る鍵になったら、止まっていた層を起こす**（クローンへ合図1つ＋
   *    マネージャーの引き取り。人間の決定 2026-09-07。下に理由の全文が在る）
   * 3. **標準出力・標準エラーへ1行**（`event` から行き先を決める。Issue #420）
   * 4. **日誌へ1件**（落ちても回した事実は消さない。正本は `active` の側）
   */
  async function settleTokenOutcome(
    outcome: TokenRotationOutcome,
    observed?: { noticeText?: string },
  ): Promise<void> {
    const entry = tokenRotationEntry(outcome, observed);

    // **指名が変わったらクローンのセッションを畳んで作り直す**（Issue #393 PR4）。
    // env は起動時に凍るので、これをやらないとクローンは古いトークンのまま
    // 再挑戦して、同じところで止まる。
    //
    // **`parked` も含む。** あちらも指名が変わっている（撒いた鍵はまだ通らないが、
    // **冷却が明けた後に古い鍵のまま挑む**のが最悪の形である）。
    //
    // **印を立てるだけである** —— いま走っているターンは最後まで走る
    // （`recycleSessionForToken` の doc）。
    //
    // **返り値を捨てないこと。** `'deferred'`（走行中のターンが終わってから畳む）
    // のときに下の再開の合図を先に入れると、**その合図は古い鍵のターンに消費され、
    // そのターンは死ぬ** —— 実運用で26分の沈黙になった形である
    // （`recycleSessionForToken` の doc に実測の表が在る）。
    const recycled =
      outcome.kind === 'rotated' || outcome.kind === 'parked'
        ? clone.recycleSessionForToken()
        : 'now';

    /*
     * **通る鍵になったら、止まっていた層を起こす**（人間の決定 2026-09-07）。
     *
     * ## なぜ要るか —— 撒くだけでは、止まったものは止まったままである
     *
     * 枠に当たったクローンは `#usageBlocked` が立ってターンを回さず、**解除の
     * 契機は新しい合図の到着だけである**（`clone.ts` の `#usageBlocked` の doc:
     * タイマーを持たない）。マネージャーも同じで、枠で落ちたセッションは
     * **引き取り（`restore()`）が走るまで**再開しない。
     *
     * ⟹ 撒いただけでは、**鍵が通るようになった瞬間に誰も動かない。** 人間の
     * 逐語: 「limitが来て止まってトークン回して復活したら復活させたことを
     * cloneやmanagerに通知する必要があるのでは？なぜならlimit来て止まっている
     * のでセッションを再開する必要があるでしょ」
     *
     * ## ⚠️ 2026-08-25 の決定を、この場合について覆した
     *
     * あのとき「受信箱への通知は入れない」と決めた理由は**「回した事実を知らせる
     * 価値が無い」**（`.claude/skills/token-pool/SKILL.md` の冒頭）。ここで入れて
     * いるのは**知らせ**ではなく**再開の契機**である —— 止まっている層は、合図が
     * 来ないかぎり自分では動けない。**知らせなら要らないが、契機は要る。**
     *
     * ## 通る鍵になった回だけである（`parked` では起こさない）
     *
     * | `outcome` | 起こすか | なぜ |
     * | --- | --- | --- |
     * | `rotated` | **起こす** | いま通る鍵に移った |
     * | `recovered` | **起こす** | 止まっていた現役が、また通ることを観測できた |
     * | `parked` | **起こさない** | 撒いた鍵は `cooldownUntil` まで通らない。起こしても同じところで止まり、**保持していた合図を1件無駄に焼く** |
     *
     * `parked` の側は放置ではない —— 冷却が明ければ枠の probe（5分ごと）が
     * `usable` を観測し、`recovered` としてここへ戻ってくる。
     *
     * ## 起こし方は層で違う
     *
     * - **クローン**: 受信箱へ合図を、**枠で止まっているときだけ**1つ入れる
     *   （Issue #783。{@link CloneWakeGate}）。これが `#releaseRequested` を立て、
     *   保持していた合図が FIFO のまま配り直される。止まっていない回は配っても
     *   ターンを1本焼くだけで何もしないので畳む——畳んでも母数は消えない
     *   （`recovered` の日誌行はこの判定と無関係に必ず出る。上の doc）
     * - **マネージャー**: `restore()`。台帳に `running` / `waiting_human` で
     *   残っている委譲を、runner に居なければ resume する。**新しい経路は作らない**
     *   —— runner の名乗りと器の入れ替えが既に通っている1本に乗るだけである
     *   （二重に走らないことは `ManagerPool` 側が見ている）。**クローンの門とは
     *   無関係に呼ぶ** —— マネージャーはクローンと独立に枠で止まりうるので、
     *   ここを一緒に絞ると「起こすべき委譲が起きない」壊し方になる
     */
    /**
     * **鍵が通らなくなったことを観測した回**（Issue #1223。
     * {@link CloneWakeGate.observeUnusable}）。**`reopenedTokenOf` より前に呼ぶ。**
     *
     * `parked`（撒いた鍵はまだ通らない）と `exhausted`（通る鍵が無い）は、
     * どちらも「鍵が通らない」を観測した回である。⟹ **そこを通った後の「また
     * 通るようになった」は、同じ鍵・同じ `how` でも本物の新しい知らせ**なので、
     * 配達済みの印を捨てて、もう一度配れる状態へ戻す。
     *
     * **この2つは `reopenedTokenOf` が `undefined` を返す側なので、下の `wake()`
     * とは排他である** —— 同じ回に印を捨てて配る、という順序は起こらない。
     */
    if (outcome.kind === 'parked' || outcome.kind === 'exhausted') {
      cloneWakeGate.observeUnusable();
    }

    const reopened = reopenedTokenOf(outcome);
    if (reopened !== undefined) {
      /**
       * **合図を入れるのは「新しい鍵で受け取れる」ようになってからである**
       * （人間の決定 2026-09-07）。
       *
       * | `recycled` | いつ入れるか | なぜ |
       * | --- | --- | --- |
       * | `'now'` | **すぐ** | セッションが無い ⟹ 次に起こす分がもう新しい鍵である |
       * | `'deferred'` | **畳まれた後**（`onTokenSessionRecycled`） | いま走っているターンは古い鍵のままで、そこへ入れると合図がそのターンに消費される |
       *
       * **⚠️ 走行中のターンが古い鍵で死ぬことは、これでも直らない。** env は
       * プロセス起動時に凍るので、ターンを途中で殺さない限り避けられず、
       * 途中で殺さないのは意図した設計である（`recycleSessionForToken` の doc）。
       * **直せるのは「その後すぐ再開する」ところまでである。**
       */
      const wake = () => {
        // **クローンの門（Issue #783。{@link CloneWakeGate}）。** クローンが
        // いま枠で止まっていなければ、この合図は `clone.ts` の `post()` の中の
        // `this.#releaseRequested = true;` を1文字も動かさない——ターンを
        // 1本焼くだけで何もしない。だから配らず畳む。
        //
        // **日誌は無関係に必ず出る。** `entry`（`tokenRotationEntry` の結果）は
        // この判定より前に計算済みで、この後の日誌への追記はここで畳んでも
        // 変わらず通る——母数は日誌の `recovered` 行に残る（隣の describe
        // 「recovered の日誌行は、受信箱へ配ったかどうかと無関係に必ず出る」）。
        //
        // **4つ目の条件（Issue #1223 再発）を1回だけ計算し、`decide` と `why`
        // の両方で使い回す。** `CloneWakeGate` の doc「4つ目の条件」——
        // `usageBlockAlwaysRearms`（`clone.ts` の `post()`）・`redeliveryGate`
        // （下、`createClone(...)` の配線）と**同じ関数**（`@alteroid/core` の
        // `staleObservedRecoveryForBlockedKey`）を呼ぶ。コピーすると片方だけ
        // 直したときに黙ってずれる（`worthDeliveringNow` の doc「呼び手は
        // 2つある」と同じ理由）。
        const observedRecovery = reopened.how === 'また通るようになった';
        const staleSameKeyRecovery = staleObservedRecoveryForBlockedKey({
          observedRecovery,
          reopenedTokenId: reopened.tokenId,
          blockedResetsAt: clone.usageBlockedResetsAt,
          blockedTokenId: clone.usageBlockedTokenId,
        });
        const decision = cloneWakeGate.decide(
          reopened,
          clone.usageBlocked,
          clone.usageReleasePending,
          staleSameKeyRecovery,
        );
        if (decision.kind === 'fold') {
          // **安く跡を残す**（Issue #783）。永続化はしない——`schema.ts` の
          // enum を触る判断は人間が持つ。既存の口（標準出力）へ1行だけ足す。
          // **畳んだ理由を言い分ける（Issue #1051、#1223 で3つ目・#1223 再発で
          // 4つ目が増えた）。** 4つは読む側が次に確かめるものが違う——1つ目は
          // 「クローンは動いている」、2つ目は「クローンは止まっているが、もう
          // 起こしてある（まだ試していない）」、3つ目は「クローンは止まって
          // いて、起こしてもいないが、同じ合図を既に配ってある（クローンは
          // 受け取ったうえでまだ止まっている）」、4つ目は「クローンは止まって
          // いて、まだ配ってもいないが、同じ鍵の同じ resetsAt を指しているだけ
          // で、根拠は観測なのにプールの構成は何も変わっていない」。潰すと、
          // 往復（#1051）が起きているのか、ターンを跨いだ反復（#1223）が
          // 起きているのか、同じ鍵の使い回し（#1223 再発）が起きているのか、
          // 本当に静かなのかが跡から読めなくなる。
          //
          // **3つ目・4つ目の判定を `decision` から読まない。** `decide` が
          // 返すのは配るか畳むかだけで、理由の内訳は持たない——3つ目は「2つの
          // 窓が偽の場合を除いた残り」として復元できたが、4つ目は `decide` の
          // 外で計算した `staleSameKeyRecovery` をそのまま使う（`decide` の
          // 内部で4つ目を3つ目より先に見ている——`CloneWakeGate` の doc「4つ目
          // の条件」——ので、この局所変数と `decide` の判定は必ず一致する）。
          const why = !clone.usageBlocked
            ? 'クローンは枠で止まっていないので起こさない'
            : clone.usageReleasePending
              ? 'クローンは枠で止まっているが、再開の印が既に立っている（もう起こしてあるので重ねない）'
              : staleSameKeyRecovery
                ? '同じ鍵・同じ回復予定時刻（resetsAt）に対する観測ベースの使い回しで、プールの構成は変わっていない'
                : '前に同じ合図（同じ鍵・同じ根拠）を配ってあり、そのあいだ鍵が通らなくなったことを観測していない';
          process.stdout.write(
            `alteroidd: 認証トークンが通る状態に戻った合図を畳んだ（${why}）: ` +
              `「${reopened.label}」（id ${reopened.tokenId}）\n`,
          );
        } else {
          // **本文へ焼く観測時刻と、合図自身の `at` は同じ値にする**（Issue
          // #1375）。この本文（`reopened` の中身）を確定させるのはここであり、
          // 別々に `new Date()` を2回呼ぶと本文の内側と外側でズレた時刻を
          // 名乗ることになる——`describeReopenedTokenNotice` の doc「同じ
          // UTC ISO 8601 文字列」はこの一致を指す。
          const observedAt = new Date().toISOString();
          clone.post({
            type: 'external',
            id: randomUUID(),
            at: observedAt,
            source: TOKEN_POOL_REOPENED_SOURCE,
            payload: {
              text: describeReopenedTokenNotice(reopened, decision.folded, observedAt),
              // **構造化した2欄（Issue #1223 再発）。** `text` は人間向けの
              // 本文で、こちらは `usageBlockAlwaysRearms`（`clone.ts` の
              // `post()`）と `redeliveryGate`（下）が「文言を読まずに」
              // 4つ目の条件を判定するための欄（`tokenPoolReopenedPayload` の
              // doc）。
              tokenId: reopened.tokenId,
              observedRecovery,
            },
            // **畳み込みの鍵を `payload` から独立させる（#1298）。**
            // `payload.text` は畳んだ件数（`decision.folded`）を含むので、
            // それを鍵に使うと同じ出来事でも件数が違うだけで別の鍵になり、
            // 受信箱側の畳み込み（`inboxCollapseKey`）が1件も効かなかった。
            // `deliveredIdentity` は `(tokenId, how)` だけの安定した身元
            // ——`CloneWakeGate` が「配達済みの合図と同じか」を見るのに
            // 既に使っている同じ関数を、鍵の側にもそのまま渡す。
            identity: deliveredIdentity(reopened),
          });
        }
        // **ここから下はクローンの門と無関係——常に呼ぶ。** マネージャーは
        // クローンと独立に枠で止まりうるので、上の畳み込みに巻き込むと
        // 「起こすべき委譲が起きない」壊し方になる。
        //
        // **待たない。** 引き取りは runner へ問い合わせる（落ちうる・遅い）ので、
        // 回した結果の記録をそれに縛らない。**黙って落とさない**（跡を残す）。
        //
        // **2本を順に通す。片方だけでは届かない相手が居る:**
        //
        // | 口 | 起こす相手 |
        // | --- | --- |
        // | `restore()` | 台帳にしか無い委譲（デーモンが入れ替わった等）で、`running` / `waiting_human` の分 |
        // | `resumeStoppedByUsage()` | **枠で止まった委譲**（像は在り、台帳は `done` / `failed` / `lost`）。`restore()` は先頭の `#records.has` で必ず見送る |
        //
        // **順番はこの向きで固定する。** `restore()` が先に台帳の分を `running`
        // へ戻すので、同じ委譲が両方に当たっても後者のホワイトリスト
        // （`done` / `failed` / `lost`）から外れて二重には起こさない。逆順・
        // 並行にすると、同じ委譲へ一言が2つ入る窓ができる（`#resuming` の
        // 歯止めは同じ session を二本起こすことは防ぐが、`send()` が2回
        // 通ることそのものは止めない）。
        void clone.managers
          .restore()
          .then(() => clone.managers.resumeStoppedByUsage())
          .then((nudged) => {
            // **0本のときは黙る。** 枠で止まった委譲が無い回（既定の構成では
            // ほとんどがそれ）に毎回1行出ると、意味のある行が埋もれる。
            if (nudged.length === 0) return;
            process.stdout.write(
              `alteroidd: 認証トークンが戻ったので、枠で止まっていた委譲へ続きを促しました: ${nudged.join(', ')}\n`,
            );
          })
          .catch((error: unknown) => {
            process.stderr.write(
              `alteroidd: 認証トークンが戻った後のマネージャーの引き継ぎに失敗しました: ${String(error)}\n`,
            );
          });
      };
      if (recycled === 'now') wake();
      else pendingTokenWake = wake;
    }

    if (entry === null) return;
    // **`event` から行き先を決める**（Issue #420 の残件）——`tokenRotationStream` に
    // 分類を1箇所へ閉じてある。
    //
    // **畳み（issue #1311 段B）の外で、常に書く。** stdout の1行と、この上の
    // 副作用（`recycleSessionForToken` / `cloneWakeGate.observeUnusable` /
    // `reopened` の wake）は畳みの有無と無関係——畳むのは下の日誌への追記だけ
    // である（`token-rotation-journal-fold.ts` の doc）。
    tokenRotationStream(entry.event).write(
      `alteroidd: ${entry.text.split('\n')[0] ?? entry.text}\n`,
    );

    // **同じ本文の連なりは日誌へ1行にまとめる**（issue #1311 段B。
    // {@link TokenRotationJournalFold}）。`summary` が在れば、畳んだ連なりの
    // 要約を**先に**書く——日誌は時系列で読まれるので、要約より後に次の1件目が
    // 来る必要がある。
    const folded = tokenRotationJournalFold.observe(entry, Date.now());
    if (folded.summary !== undefined) {
      // **日誌への追記が落ちても回した事実は消えない**（正本は記憶ストアの
      // `active` の側に在る）。要約が落ちても、畳んだ連なりの1件目は既に
      // 書かれている——失うのは畳んだ件数の内訳だけである。
      await stores.journal.append(folded.summary).catch((error: unknown) => {
        noteDroppedRecord('認証トークンの切替（畳んだ要約）', 'journal', error);
      });
    }
    if (!folded.write) return;
    // **日誌への追記が落ちても回した事実は消えない**（正本は記憶ストアの
    // `active` の側に在る）。ここで投げ直すと、回せたのに「回し手が落ちた」
    // として報告されることになる。
    await stores.journal.append(entry).catch((error: unknown) => {
      noteDroppedRecord('認証トークンの切替', 'journal', error);
    });
  }

  /**
   * 認証トークンの見張りを回し始める（`token-watch.ts`）。
   *
   * **`clone` の後に作る。** `settleTokenOutcome` が `clone` を要るので、
   * 見張りが最初の見直しを走らせる前にクローンが在る必要がある。
   */
  tokenWatch = startTokenRotationWatch({
    rotator: tokenRotator,
    onOutcome: (outcome) => settleTokenOutcome(outcome),
  });

  /**
   * ダメ元の試し（Issue #1501。`token-trial-watch.ts`）。**`tokenWatch` と同じ
   * 理由で `clone` の後に作る。**
   *
   * 試す口（`TokenTrialPort`）はここで組み立てる —— `runTokenTrial` に、
   * クローンの層と同じモデルのエイリアス（`cloneModel`。`ALTEROID_CLONE_MODEL`
   * が在ればその値）を渡す。層とモデル帯を揃えるのは、枠がモデル別のことが
   * あり、試しが通っても層とモデルが違えば層は通らない偽陽性を防ぐためである
   * （PR 本文の「確かめていないこと」も見よ——マネージャー・作業者のモデル別の
   * 枠はこれでも測れない）。
   */
  tokenTrialWatch = startTokenTrialWatch({
    stores,
    trial: {
      trial: (token) =>
        runTokenTrial(query, {
          token: token.value,
          cwd: paths.root,
          model: cloneModel,
          // **同上（#431）。** 試しの子プロセスへも記憶ストアの鍵は渡さない。
          withheldEnvKeys: storage.withheldEnvKeys,
        }),
    },
    reconsider: (input) => tokenRotator.reconsider(input),
    recordTrialVerdict: (input) => tokenRotator.recordTrialVerdict(input),
    onOutcome: (outcome) => settleTokenOutcome(outcome),
  });

  /**
   * **起動直後に1回見直す**（人間の決定 2026-09-07）。
   *
   * 引き取り（`restore()`、上）は「記憶ストアが言っている現役を、消えた撒き先へ
   * もう一度置く」だけで、**選び直さない**（あちらの doc）。⟹ 記録の上で現役が
   * 冷却中のまま起きた器では、**引き取りの直後は「通らない鍵が全コンテナに
   * 撒かれている」状態である。** ここで見直すと、通る候補が在ればそちらへ移り、
   * 無ければいちばん早く戻る鍵へ park する。
   *
   * **順序に意味がある** —— 先に記録どおりの状態を作り、そのうえで見直す。
   * 逆にすると、撒き直せていない状態を見て判定することになる。
   */
  tokenWatch.poke('startup');

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
  // stderr への書き出しは `announce` 本体が既に持っているので、ここでは
  // クローンへの経路だけを差し替える。
  postToClone = (text: string): void => {
    clone.post({
      type: 'external',
      id: randomUUID(),
      at: new Date().toISOString(),
      source: DAEMON_RUNNER_REGISTRY_SOURCE,
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
  runners.subscribe(() => {
    void takeOver();
    /*
     * **runner が載ったことも、認証トークンを見直す契機にする**（人間の決定
     * 2026-09-07）。
     *
     * **現役をその runner へ降ろすのは `ManagerPool` の側である**
     * （`#connectTo` / `#reattach` の `#pushAgentToken`。runner の名乗り
     * （`hello`）はストリームが繋がるたびに来るので、**繋ぎ直しの瞬間ごとに
     * 降りる**）。ここが足すのはそれとは別の1つ ——
     * **「撒く先が無かったせいで撒けていなかった回」を拾い直す。**
     *
     * `createTokenSpread` は runner が1台も繋がっていないとき
     * `ok: false`（「繋がっている runner が1台も無い」）を返して終わる。
     * デーモンが先に起きる構成ではこれが普通に起こる ⟹ その後で runner が
     * 上がってきた瞬間に見直せば、**指名と実際が揃っているかを確かめ直せる。**
     */
    tokenWatch?.poke('runner_connected');
  });
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
    // **器が入れ替わったら、認証トークンも見直す。** 現役をその runner へ
    // 降ろすのは `#reattach`（`#pushAgentToken`）だが、**指名そのものが古い
    // ときはそれでは直らない** —— 入れ替えのあいだに冷却が明けていることが
    // 普通に起こる（器の入れ替えは分単位で、枠は5時間単位である）。
    tokenWatch?.poke('runner_connected');
  };
  /**
   * 宛先が黙ったので、いま開いている別の器へ移送を試みる（`onLost` の doc。
   * roadmap M5 PR5）。
   *
   * **新しい梯子は作らない** — `relocateFrom` は `ManagerPool` 側の既存の予約
   * （`#reattach` / `#scheduleReattach`）にそのまま乗る。ここは呼ぶだけである。
   */
  relocateOnLost = (runnerId) => {
    if (runnerId !== undefined) clone.managers.relocateFrom(runnerId);
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
    process.stdout.write(
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
    credentials: credentialService,
    mcpServers: mcpServerService,
    tokens: tokenPoolService,
    clearSessionLog: storage.clearSessionLog,
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
    // 直後に process.exit(1) が来るので `process.stderr.write` は使わない
    // （fd がパイプだと POSIX 上は非同期で、書いた行が exit に巻き込まれて
    // 失われることがある。#248）。`writeStderrSync` は fd 2 へ同期で書く。
    writeStderrSync(`alteroidd: 待ち受けに失敗しました (port ${port}): ${String(error)}\n`);
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
    managerPoller.stop();
    // 自動で畳む周期も止める（止めたはずのデーモンが背景で `archive.list()` を
    // 読み続けない。`usagePoller` / `managerPoller` と同じ理由）。
    archiveFolder.stop();
    // **見張りも畳む。** 止めたはずのデーモンが背景で probe を焼き続けない
    // （`usagePoller` と同じ理由。`token-watch.ts`）。
    tokenWatch?.stop();
    // **ダメ元の試しも畳む**（同じ理由。`token-trial-watch.ts`）。
    tokenTrialWatch?.stop();
    // **`token_rotation` の畳み残しを吐き出す**（issue #1311 段B。
    // `TokenRotationJournalFold.flush` の doc）。器が落ちた場合に失うのは
    // 窓の中の件数だけで、連なりの1件目は既に書いてある——ここは「呼べるなら
    // 呼ぶ」の実行であって、無くても壊れない。
    const foldedAtShutdown = tokenRotationJournalFold.flush();
    if (foldedAtShutdown !== undefined) {
      await stores.journal.append(foldedAtShutdown).catch((error: unknown) => {
        noteDroppedRecord('認証トークンの切替（畳んだ要約、停止時）', 'journal', error);
      });
    }
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
    // **後追いだと日誌の上で分かるように `schedule_catchup` を運ぶ。** 定刻の発火
    // （`dailyReportEntry.event`）は `cause` を渡さない ＝ 省略時の既定
    // （`schedule`）のまま。ここだけが後追いの発生源（`missingDailyReportDates`）
    // なので、区別する印を付けられるのもここだけである。
    for (const date of missed) clone.post(dailyReportEvent(date, new Date(), 'schedule_catchup'));
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
  // **未捕捉の例外・未処理の Promise 拒否に、観測だけの網を張る（#438）。**
  //
  // **ここに置くのは窓を最小にするためである。** module のトップレベルに置くと
  // `main` を import するテストにまで網が張られ、`main()` の中に置くと `main()` の
  // 頭までの窓が無駄に開く。**それでも import 中に投げた例外はこの網より前で、
  // そこは今日と同じ（Node 既定のスタック + exit 1）である** — 悪化はしないが
  // 覆ってもいない（`uncaught-net.ts`「覆っていない窓」）。
  //
  // **`uncaughtException` へ「上げない」こと。** 上げると既定の終了が止まり、
  // 器が「壊れた」と判定できる唯一の材料（プロセスの終了）が消える。理由の全文と
  // 実測の表は `uncaught-net.ts` に在る。
  installUncaughtNet('alteroidd');

  main().catch((error: unknown) => {
    // 同じ理由で `writeStderrSync` を使う（直上の `server.on('error')` と同型。#248）。
    writeStderrSync(`alteroidd: 起動に失敗しました: ${String(error)}\n`);
    process.exit(1);
  });
}
