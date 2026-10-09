import type {
  RunnerAnswerCommand,
  RunnerAnswerOutcome,
  RunnerAttachment,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEvent,
  RunnerExecutionResources,
  RunnerLegState,
  McpServers,
  RunnerManagerListing,
  RunnerManagerState,
  RunnerMcpServersFingerprint,
  RunnerOutboxContent,
  RunnerPlacementResources,
  RunnerPlugin,
  RunnerPluginFingerprintEntry,
  RunnerPluginsFingerprint,
  RunnerResumeCommand,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRevisionReport,
  RunnerSetCredentialsCommand,
  RunnerStartCommand,
  UnpushedWorkResult,
} from '@alteroid/core';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import {
  pluginPushDeadlineMs,
  RUNNER_CALL_DEADLINE_MS,
  RunnerUnknownError,
  settleWithinDeadline,
} from './deadline.js';

import {
  DEFAULT_SSE_HEARTBEAT_MS,
  RunnerHttpError,
  RunnerMcpServersUnsupportedError,
  RunnerPluginsUnsupportedError,
  encodeRunnerPlugin,
  runnerPluginFingerprintEntrySchema,
  runnerPluginsFingerprintSchema,
  RunnerCodexAuthUnsupportedError,
  buildRevisionSchema,
  codePointBoundary,
  reasonOf,
  redactErrorText,
  reportRunnerRevision,
  runnerCredentialFingerprintSchema,
  runnerMcpServersFingerprintSchema,
  runnerCodexAuthWriteBackSchema,
  runnerProfileFingerprintSchema,
  runnerProfileResultSchema,
  runnerAnswerResultSchema,
  runnerRescueRefDeleteResultSchema,
  type RunnerRescueRefDeleteRequest,
  type RunnerRescueRefDeleteResult,
  runnerEventSchema,
  runnerExecutionResourcesSchema,
  noteDroppedRunnerManagers,
  runnerManagerStateSchema,
  runnerPlacementResourcesSchema,
  runnerSessionOpenResultSchema,
  type RunnerResumeResult,
  unpushedWorkResultSchema,
} from '@alteroid/core';

// 失敗の種別を口の定義（`@alteroid/core`）に持たせる: この経路だけの都合にすると、同じ判断をインプロセスの runner 側で作り直すことになるため
export { RunnerHttpError } from '@alteroid/core';
export { RUNNER_CALL_DEADLINE_MS, RunnerUnknownError } from './deadline.js';

// 報告で分類を終わらせない: 言えるのは「返らなかった」だけで、失敗も死亡も「届かなかった」も言えないため
export interface RunnerUnknownReport {
  method: string;
  path: string;
  waitedMs: number;
  phase: 'expired' | 'late';
  ok?: boolean;
  error?: unknown;
}

// `onUnknown` を借りない: あちらは「こちらが投げた呼びが期限内に返らなかった」で、主語が違うため
// 本文は載せない（載せるのは `type` とバイト数だけ）: ここへ来るフレームにはマネージャーの報告が入りうるため
export type RunnerDroppedEventReport =
  | {
      phase: 'first';
      reason: 'unparsable' | 'unknown-shape';
      type?: string;
      bytes: number;
    }
  | {
      phase: 'closed';
      dropped: { key: string; count: number }[];
    };

// 名簿側（`runner-protocol.ts` の `REGISTRY_RETRY_BASE_MS` / `REGISTRY_RETRY_MAX_MS`）の値の写し: あちらは export されておらず import できないため
const RUNNER_STREAM_RETRY_BASE_MS = 1_000;
const RUNNER_STREAM_RETRY_MAX_MS = 30_000;

// heartbeat の間隔の2倍にする（1倍にしない）: 1倍だと「1回も届かないうちに閾値へ達する」余地が残り、「間隔をまたいだ」と言い切れないため
const CONNECTION_HEALTHY_THRESHOLD_MS = DEFAULT_SSE_HEARTBEAT_MS * 2;

// `/events` に無音の見張りを置く: 解決も棄却もしない `read()` は `#pump` を再接続ループごと止め、名簿の生存確認は別の接続を見ていて検出できないため
// 3倍にする（2倍にしない）: 2倍だと heartbeat が1回遅れただけの健全な接続を切るが、3倍なら1回まるごと落ちても耐え、続けて落ちたら切れるため
// 60000ms（`RUNNER_CALL_DEADLINE_MS`）に揃えない: 偶然の一致で、あちらは呼び出し全体の期限、こちらはバイトの間隔のため
// 300000ms（undici の既定値）に揃えない: 数の理由がこのシステムの中から導けなくなるため
const RUNNER_STREAM_SILENCE_TIMEOUT_MS = DEFAULT_SSE_HEARTBEAT_MS * 3;

// `unref` する: 見張りは接続が在るあいだ回るもので、止めたはずのデーモンの終了を引き延ばさないため
function defaultSetTimer(ms: number, onFire: () => void): () => void {
  const timer = setTimeout(onFire, ms);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 名簿側の #scheduleOpen と同じ理由: 挑み直しの待ちで、止めたはずの
    // デーモンの終了を引き延ばさない。
    timer.unref?.();
  });
}

// 繋ぎに行くのをデーモンだけにする: 逆向きのコールバック URL を足すと、runner の中のマネージャーがその経路でデーモンの API（＝記憶）へ届くようになるため
export interface HttpRunnerOptions {
  baseUrl: string;
  // 素の値を持つのはデーモンだけ: runner 側は sha256 だけなので、マネージャーが `/proc/1/environ` を読めてもこの鍵は作れず、自分宛の許可確認に自分で `allow` を返す経路を塞げるため
  token: string;
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
  // 回数では諦めない: 諦めた先に残るのは、宛先を失ったまま誰にも知らされないデーモンのため
  retryMaxDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  // 運用で縮めない: 縮めると heartbeat の遅れだけで健全な接続を切り始め、切るたびに runner が `hello` を書き直して `#reattach` が走るため
  silenceTimeoutMs?: number;
  // `sleepFn` を流用しない: 途中でやめる口が無く、読むたびに張ると取り消せないタイマーがバイトごとに積まれるため
  setTimerFn?: (ms: number, onFire: () => void) => () => void;
  // 運用で縮めない: 期限は「返らない」を掴むためのもので、「遅い」を打ち切るためのものではないため
  deadlineMs?: number;
  onUnknown?: (report: RunnerUnknownReport) => void;
  onDroppedEvent?: (report: RunnerDroppedEventReport) => void;
}

// 日誌へ載せるのはマネージャー宛の操作の不明だけ: 器の生死や設定の押し込みは別の経路が持っており、流すと同じ契約が2つになり、黙って死んだ器へ挑み直すたびに1行増えて `journal_read` の窓から本物の記録を押し出すため
export function managerIdOfRunnerPath(path: string): string | undefined {
  const match = /^\/managers\/([^/?]+)/.exec(path);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // 壊れた符号化でも宛先の判定だけはできる（素のまま返す）
    return match[1];
  }
}

const DROPPED_TYPE_LIMIT = 64;

// `type` が読めなければ付けない: 「取れなかった」を `'(不明)'` のような値にすると、それが `type` の1つとして数えられてしまうため
function typeOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = (raw as { type?: unknown }).type;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const flat = value.replaceAll(/\s+/gu, ' ');
  return flat.slice(0, codePointBoundary(flat, DROPPED_TYPE_LIMIT));
}

export function describeRunnerDropped(report: RunnerDroppedEventReport): string {
  if (report.phase === 'closed') {
    const detail = report.dropped.map(({ key, count }) => `${key}×${count}`).join(' / ');
    return `runner から降りてきた出来事を解釈できずに捨てた（この接続の合計）: ${detail}`;
  }
  const what =
    report.reason === 'unparsable' ? 'JSON として読めなかった' : 'こちらのスキーマに合わなかった';
  const type = report.type === undefined ? '（type も読めない）' : `type=${report.type}`;
  return `runner から降りてきた出来事を解釈できずに捨てた（初出）: ${what} ${type} bytes=${report.bytes}`;
}

// 言えること／言えないことを行の中に書く: 期限切れは「失敗した」でも「runner が死んだ」でもなく、そう読めない文にしないと、読んだ側が断定へ畳んで再送で二重に実行され、引き取りで同じマネージャーが2台で走るため
export function describeRunnerUnknown(report: RunnerUnknownReport): string {
  const managerId = managerIdOfRunnerPath(report.path);
  const head = managerId === undefined ? '' : `[${managerId}] `;
  const where = `${report.method} ${report.path}`;
  const waited = `${String(report.waitedMs)}ms`;
  if (report.phase === 'late') {
    return report.ok === true
      ? `${head}runner の ${where} が、期限（${waited}）を過ぎてから成功で返った。` +
          '**不明は解けた**（あの操作は届いていて、応答だけが遅れていた）。'
      : `${head}runner の ${where} が、期限（${waited}）を過ぎてから失敗で返った: ${String(report.error)}。` +
          '**不明は解けた**（届いたかどうかはこの失敗の中身で決まる）。';
  }
  return (
    `${head}runner の ${where} が ${waited} 以内に応答を返さなかった。**言えるのはそれだけである** — ` +
    '届いたかどうかは分かっていない。失敗とは限らないので同じ操作を送り直すと二重に実行され、' +
    'runner が死んだとも限らないので別の runner へ引き取らせると同じマネージャーが2台で走る。' +
    '待つのをやめただけで、runner 側の実行は止めていない（遅れて返ってきたらこの日誌に続きが載る）。'
  );
}

function socketPathOf(baseUrl: string): string | null {
  const match = /^unix:(?:\/\/)?(.+)$/.exec(baseUrl);
  return match?.[1] ?? null;
}

export async function createHttpRunner(options: HttpRunnerOptions): Promise<RunnerClient> {
  const client = new HttpRunner(options);
  await client.hello();
  return client;
}

interface HealthBody {
  runnerId?: unknown;
  instanceId?: unknown;
  workspacePath?: unknown;
  credentials?: unknown;
  profile?: unknown;
  mcpServers?: unknown;
  plugins?: unknown;
  managers?: unknown;
  resources?: unknown;
  revision?: unknown;
  pendingEvents?: unknown;
  oldestPendingAt?: unknown;
}

// 形が壊れていても投げず `unknown` に倒す: ネットワーク越しの入力（runner の版・改造された応答）を信用しない側のため
function revisionReportOf(value: unknown): RunnerRevisionReport {
  const parsed = buildRevisionSchema.safeParse(value);
  if (!parsed.success) return { status: 'unknown' };
  return reportRunnerRevision(parsed.data);
}

// まとめて `safeParse` せず材料ごとに検証する: 丸ごと1回で通すと、材料が1つ壊れただけで残り全部が道連れで消えるため
// 鍵を数え上げずスキーマの `shape` を回す: 書き並べると、次に材料が増えたときここが黙って落とすため
function executionResourcesOf(value: unknown): RunnerExecutionResources {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(runnerExecutionResourcesSchema.shape)) {
    const parsed = field.safeParse(raw[key]);
    // `undefined` を「読めた」にしない: 材料が欠けている runner の欄を作らないため
    if (parsed.success && parsed.data !== undefined) picked[key] = parsed.data;
  }
  return picked as RunnerExecutionResources;
}

function fingerprintsOf(value: unknown): RunnerCredentialFingerprint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = runnerCredentialFingerprintSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

// `String(failure)` を使わず `cause` を見る: `Error.prototype.toString()` は `cause` を落とし、`TypeError: terminated` の本当の理由（`SocketError` か `BodyTimeoutError` か）は `cause.code` でしか区別できないため
// `reasonOf` を広げず専用の畳み方をここに置く: `reasonOf` は他の呼び出し元が依存する契約を持ち、ここで足したいのは undici の固定語彙（`cause.code`）で契約の中身が違うため
function causeInfoOf(failure: unknown): { text: string; code: string } | undefined {
  if (!(failure instanceof Error) || failure.cause === undefined) return undefined;
  const cause = failure.cause;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
      ? cause.code
      : '';
  return { text: reasonOf(cause), code };
}

function causeSuffixOf(info: ReturnType<typeof causeInfoOf>): string {
  if (info === undefined) return '';
  return ` cause=${info.text}${info.code === '' ? '' : ` code=${info.code}`}`;
}

// 上限を超えたら忘れて数え直す: 無制限の帳面を作らないため
const DROPPED_MANAGER_KEY_LIMIT = 256;

class HttpRunner implements RunnerClient {
  runnerId = 'runner-primary';
  workspacePath = '';
  revision?: RunnerRevisionReport;
  instanceId?: string;
  readonly #baseUrl: string;
  // `options.baseUrl` の原文を別に持つ: `#baseUrl` は unix ソケットのとき `'http://runner'` のダミーへ書き換わり、そのままログへ出すと unix ソケットの runner がすべて同じ文字列で名乗ってしまうため
  readonly #displayBaseUrl: string;
  readonly #socketPath: string | null;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #sleepFn: (ms: number) => Promise<void>;
  readonly #nowFn: () => number;
  readonly #deadlineMs: number;
  readonly #silenceTimeoutMs: number;
  readonly #setTimerFn: (ms: number, onFire: () => void) => () => void;
  readonly #onUnknown: ((report: RunnerUnknownReport) => void) | undefined;
  readonly #onDroppedEvent: ((report: RunnerDroppedEventReport) => void) | undefined;
  #controller: AbortController | null = null;
  #closed = false;
  #noReconnect = false;
  #streamActive = false;
  #streamEndWaiters: Array<() => void> = [];
  #nextDelayMs: number;
  #backingOff = false;
  // 同じ値のときは書き直さない: 待ち幅が上限へ張り付いて失敗し続けても同じ行を積まないため
  #lastLoggedDelayMs: number | null = null;
  // 待ち時間の間引きに `cause.code` も効かせる: 張り付いた区間で `code` が別物へ切り替わっても書かれないと、どちらが起きているか見分けられないため
  #lastLoggedCauseCode = '';
  // `#lastLoggedDelayMs` と別のフィールドで持つ: 共有すると、同じ `waitMs` のまま失敗と静かな終わりが交互に起きたとき、片方が書いた直後にもう片方が「値が変わっていない」と誤読して黙るため
  #lastLoggedQuietDelayMs: number | null = null;
  // 接続ごとの最初の `id:` では max を取らず置き換える: runner が入れ替わると連番は1から数え直され、max を取り続けると古い高い値が `Last-Event-ID` に残って新しい runner の `sentSince` が何も返さず、無音切断で届かなかった分を取りこぼすため
  #lastEventId: number | null = null;

  #legStreamOpenSince: number | null = null;
  #legLastByteAt: number | null = null;
  #legEverConnected = false;
  // 「いま開いている」から「開いていない」へ遷移した瞬間だけ書き換える: 再試行のたびに現在時刻で上書きすると、本当に落ちた時刻が読めなくなるため
  #legDownSince: number | null = null;
  #legLastFailureReason: string | undefined;
  #legNextRetryAt: number | null = null;

  // 読むたびに生フィールドから組み立て直す（キャッシュしない）: 古い状態を返す余地を作らないため
  get legState(): RunnerLegState {
    if (this.#legStreamOpenSince !== null) {
      return {
        status: 'connected',
        since: new Date(this.#legStreamOpenSince).toISOString(),
        ...(this.#legLastByteAt === null
          ? {}
          : { lastByteAt: new Date(this.#legLastByteAt).toISOString() }),
      };
    }
    if (!this.#legEverConnected) return { status: 'never-connected' };
    return {
      status: 'down',
      ...(this.#legDownSince === null ? {} : { since: new Date(this.#legDownSince).toISOString() }),
      ...(this.#legLastFailureReason === undefined
        ? {}
        : { lastFailureReason: this.#legLastFailureReason }),
      ...(this.#legNextRetryAt === null
        ? {}
        : { nextRetryAt: new Date(this.#legNextRetryAt).toISOString() }),
    };
  }

  // 「聞けたか」を `runnerId` の既定値（`'runner-primary'`）で判定せず別のフラグで持つ: 一度も接続できていない段階の既定値をログへ出すと、取れていない値が取れた値の顔をして出るため
  #runnerIdKnown = false;

  readonly #droppedManagerKeys = new Set<string>();

  get runnerIdKnown(): boolean {
    return this.#runnerIdKnown;
  }

  // 値（`=== ''`）で代用せず別のフラグで持つ: 本当に空文字を名乗る runner と一度も聞けていない runner を区別するため
  #workspacePathKnown = false;

  get workspacePathKnown(): boolean {
    return this.#workspacePathKnown;
  }

  constructor(options: HttpRunnerOptions) {
    this.#socketPath = socketPathOf(options.baseUrl);
    this.#displayBaseUrl = options.baseUrl;
    this.#baseUrl =
      this.#socketPath === null ? options.baseUrl.replace(/\/$/, '') : 'http://runner';
    this.#token = options.token;
    this.#fetch = options.fetchFn ?? ((input, init) => this.#send(input, init));
    this.#retryBaseMs = options.retryDelayMs ?? RUNNER_STREAM_RETRY_BASE_MS;
    this.#retryMaxMs = options.retryMaxDelayMs ?? RUNNER_STREAM_RETRY_MAX_MS;
    this.#sleepFn = options.sleepFn ?? defaultSleep;
    this.#nowFn = options.nowFn ?? Date.now;
    this.#nextDelayMs = this.#retryBaseMs;
    this.#deadlineMs = options.deadlineMs ?? RUNNER_CALL_DEADLINE_MS;
    this.#silenceTimeoutMs = options.silenceTimeoutMs ?? RUNNER_STREAM_SILENCE_TIMEOUT_MS;
    this.#setTimerFn = options.setTimerFn ?? defaultSetTimer;
    this.#onUnknown = options.onUnknown;
    this.#onDroppedEvent = options.onDroppedEvent;
  }

  // ソケットのときだけ node:http を使う: グローバルの `fetch` はソケットへ繋げず、ソケットにするのはマネージャーと同じ器の中に TCP の口を開けないため
  #send(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (this.#socketPath === null) return fetch(input, init);
    const url = new URL(typeof input === 'string' ? input : input.toString());
    return requestOverSocket(this.#socketPath, url, init ?? {});
  }

  async hello(): Promise<void> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    if (typeof body.runnerId === 'string' && body.runnerId.length > 0) {
      this.runnerId = body.runnerId;
      this.#runnerIdKnown = true;
    }
    // 空文字を「聞けていない」とは弾かない: 本当に空の作業ディレクトリを名乗る runner と一度も聞けていない相手が `''` に潰れて区別が消えるため
    if (typeof body.workspacePath === 'string') {
      this.workspacePath = body.workspacePath;
      this.#workspacePathKnown = true;
    }
    // `revision` が無ければ触らない: 無条件に呼ぶと、フィールド不在の古い runner まで `unknown` へ倒れ、「訊けたが分からない」と「報告する口が無い」が区別できなくなるため
    if (body.revision !== undefined) {
      this.revision = revisionReportOf(body.revision);
    }
    if (typeof body.instanceId === 'string' && body.instanceId.length > 0) {
      this.instanceId = body.instanceId;
    }
  }

  // 名乗りの中身を取らない: 別の runner_id を返されたとき黙って書き換えると台帳の鎖（`manager_id → runner_id`）が音もなく繋ぎ変わるため。本文は読み捨てる: 読まずに放ると10秒ごとに繋ぎが積み上がるため
  async ping(options?: { signal?: AbortSignal }): Promise<void> {
    const response = await this.#call('GET', '/health', undefined, options?.signal);
    await response.text().catch(() => '');
  }

  // 読むが採らない（`this.runnerId` / `this.workspacePath` を書き換えない）: 書き換えると台帳の鎖が音もなく繋ぎ変わるため
  // `revision` は常に返す（`known` か `unknown`）: 「応答は返ってきたのに版の状態が分からない」を作らず、名簿が `unheard` と混同しないため
  // 欄を1つずつ `safeParse` する: まとめて弾くと、この欄の形が崩れただけで `runnerId` / `instanceId` / `revision` まで道連れになるため
  async identity(options?: { signal?: AbortSignal }): Promise<
    | {
        runnerId?: string;
        instanceId?: string;
        revision: RunnerRevisionReport;
        pendingEvents?: number;
        oldestPendingAt?: string;
        managers?: number;
      }
    | undefined
  > {
    const response = await this.#call('GET', '/health', undefined, options?.signal);
    const body = (await response.json()) as HealthBody;
    const pendingEvents = runnerPlacementResourcesSchema.shape.pendingEvents.safeParse(
      body.pendingEvents,
    );
    const managers = runnerPlacementResourcesSchema.shape.managers.safeParse(body.managers);
    const oldestPendingAt = runnerPlacementResourcesSchema.shape.oldestPendingAt.safeParse(
      body.oldestPendingAt,
    );
    return {
      ...(typeof body.runnerId === 'string' && body.runnerId.length > 0
        ? { runnerId: body.runnerId }
        : {}),
      ...(typeof body.instanceId === 'string' && body.instanceId.length > 0
        ? { instanceId: body.instanceId }
        : {}),
      revision: revisionReportOf(body.revision),
      ...(pendingEvents.success && pendingEvents.data !== undefined
        ? { pendingEvents: pendingEvents.data }
        : {}),
      ...(oldestPendingAt.success && oldestPendingAt.data !== undefined
        ? { oldestPendingAt: oldestPendingAt.data }
        : {}),
      // 取れなかった回を 0 で埋めない: 件数を名乗らない器に対して `GET /managers` を引かなくなるため
      ...(managers.success && managers.data !== undefined ? { managers: managers.data } : {}),
    };
  }
  // 採るのは資源だけにする（`runnerId` / `workspacePath` を採らず、`ping()` に相乗りさせない）: 器が入れ替わったとき台帳の鎖が黙って繋ぎ変わるため
  // 材料は1つずつ検証する: まとめて弾くと、`cpu` の形が崩れただけで `managers` まで落ち、資源を報告できる器が「何も報告しない器」に見えるため
  async resources(options?: { signal?: AbortSignal }): Promise<RunnerPlacementResources> {
    const response = await this.#call('GET', '/health', undefined, options?.signal);
    const body = (await response.json()) as HealthBody;
    const resources = executionResourcesOf(body.resources);
    const managers = runnerPlacementResourcesSchema.shape.managers.safeParse(body.managers);
    // `/health` 直下から1つずつ検証する: まとめて弾くと、`resources` の形が崩れただけでこの2欄まで落ち、値を出している runner が「何も報告しない器」に見えるため
    const pendingEvents = runnerPlacementResourcesSchema.shape.pendingEvents.safeParse(
      body.pendingEvents,
    );
    const oldestPendingAt = runnerPlacementResourcesSchema.shape.oldestPendingAt.safeParse(
      body.oldestPendingAt,
    );
    return {
      ...resources,
      ...(managers.success && managers.data !== undefined ? { managers: managers.data } : {}),
      ...(pendingEvents.success && pendingEvents.data !== undefined
        ? { pendingEvents: pendingEvents.data }
        : {}),
      ...(oldestPendingAt.success && oldestPendingAt.data !== undefined
        ? { oldestPendingAt: oldestPendingAt.data }
        : {}),
    };
  }

  // 切れても繋ぎ直す: 諦めると、誰も答えられない確認が runner に残り、マネージャーが永久に止まるため
  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    void this.#pump(onEvent);
  }

  // runner を名乗る: 本番には runner が複数台あり独立した backoff 状態を持つので、名乗らないと待ちの下降が1台のリセットか別の台の行かをログから判定できないため
  // `runnerId` は聞けたときだけ出す: 既定値 `'runner-primary'` を出すと、取れていない値が取れた値の顔をして出るため
  #describeSelf(): string {
    return `runner (${this.#displayBaseUrl}${this.#runnerIdKnown ? ` / ${this.runnerId}` : ''})`;
  }

  // 「繋がった時点」でリセットしない: 開いた直後に毎回すぐ死ぬ相手を相手にすると、失敗のたびに基準へ戻って指数バックオフが一度も進まないため
  // 「一度でも出来事が届いたら」でリセットしない: runner は `/events` を開いた直後に無条件で `hello` を書くので「繋がった」とほぼ同義になるため
  // 「経過時間だけ」でリセットしない: event loop が詰まってソケットだけ開いている接続は `bodyTimeout` まで生き延び、時間が経ったことは相手が生きている証拠にならないため。判定は「閾値を超えた後に `reader.read()` が中身を返した瞬間」で、フレームの中身は見ない
  // 閾値未満で例外も投げず静かに閉じた枝にも専用の行を書く: 同じ間隔で切れ続ける沈黙と「直った」が、ログの不在だけでは見分けが付かないため。「切れました」は使わない: 例外が起きていないのに書くと嘘になるため
  // 「繋ぎ直せた」は健全と判定した瞬間に `markHealthy` の中で書く: 接続の終了を待つと、繋がったまま長く生きている接続でこの行が出ず、次に切れたときの「切れました」とセットでしか読めないため
  async #pump(onEvent: (event: RunnerEvent) => void): Promise<void> {
    while (!this.#closed && !this.#noReconnect) {
      let failed = false;
      let failure: unknown;
      let healthy = false;
      this.#streamActive = true;
      try {
        await this.#stream(onEvent, () => {
          healthy = true;
          // 回復は正常な出来事なので stdout へ書く（正常は stdout・異常は stderr）
          if (this.#backingOff) {
            process.stdout.write(`alteroidd: ${this.#describeSelf()} のストリームに繋ぎ直せた\n`);
            this.#backingOff = false;
          }
        });
      } catch (error) {
        if (this.#closed || this.#noReconnect) return;
        failed = true;
        failure = error;
      } finally {
        this.#streamActive = false;
        for (const wake of this.#streamEndWaiters.splice(0)) wake();
      }
      // 失敗の行も書かない: 畳み始めた runner が exit したのは失敗ではないため
      if (this.#closed || this.#noReconnect) return;

      const waitMs = healthy ? this.#retryBaseMs : this.#nextDelayMs;

      if (failed) {
        this.#backingOff = true;
        this.#legLastFailureReason = `${reasonOf(failure)}${causeSuffixOf(causeInfoOf(failure))}`;
        // ログが書けないことを理由に再接続をやめない: ここは `#stream` を包む `catch` の外側で、投げれば `#pump` ごと死に、この runner へ二度と繋ぎ直されないため
        this.#neverEscapes(() => {
          const causeInfo = causeInfoOf(failure);
          const causeCode = causeInfo?.code ?? '';
          if (this.#lastLoggedDelayMs !== waitMs || this.#lastLoggedCauseCode !== causeCode) {
            process.stderr.write(
              `alteroidd: ${this.#describeSelf()} のストリームが切れました: ${reasonOf(failure)}${causeSuffixOf(causeInfo)}（次は${waitMs}ms後に再試行）\n`,
            );
            this.#lastLoggedDelayMs = waitMs;
            this.#lastLoggedCauseCode = causeCode;
          }
        });
      } else if (healthy) {
        this.#lastLoggedDelayMs = null;
        this.#lastLoggedCauseCode = '';
        this.#lastLoggedQuietDelayMs = null;
      } else {
        // dedup のキーを失敗経路と別（`#lastLoggedQuietDelayMs`）にする: 同じ `waitMs` のまま失敗と静かな終わりが交互に起きても、互いの dedup 状態を消し合わないため
        // `#backingOff` もここで立てる: 立てないと、静かに閉じ続けた区間から回復しても「繋ぎ直せた」が一度も出ず、入りの端だけ出て出の端が出ないため
        // 宛先は stderr: 静かな閉じは正常ではなく（健全なら `#stream()` は `bodyTimeout` まで生き続ける）、回復だけが正常で stdout のため
        this.#backingOff = true;
        this.#legLastFailureReason = 'ストリームが持続しないまま終わった';
        this.#neverEscapes(() => {
          if (this.#lastLoggedQuietDelayMs !== waitMs) {
            process.stderr.write(
              `alteroidd: ${this.#describeSelf()} のストリームが持続しないまま終わった（次は${waitMs}ms後に再試行）\n`,
            );
            this.#lastLoggedQuietDelayMs = waitMs;
          }
        });
      }

      this.#nextDelayMs = healthy ? this.#retryBaseMs : Math.min(waitMs * 2, this.#retryMaxMs);

      // `this.#nowFn()` を使わない: 呼ぶと、まだ繋がっていない失敗の周回が足場（最初の呼び出しは 0、以降は閾値）の1回目を横取りし、後で成功する周回の `connectedAt` が 0 を貰えず「持続した」判定が二度と成立しなくなるため
      this.#legNextRetryAt = Date.now() + waitMs;

      // 差し替えられた待ちが投げても `#pump` を殺さず、既定の待ちへ落として間隔だけは守る: 待たずに回ると秒間に何度も runner を叩くため
      try {
        await this.#sleepFn(waitMs);
      } catch {
        await defaultSleep(waitMs);
      }
    }
  }

  // 握り潰した先を報告しない: 包んでいるのは「知らせる」処理そのもの（stderr への1行）で、別の宛先を作っても壊れ方が1つ増えるだけのため
  #neverEscapes(body: () => void): void {
    try {
      body();
    } catch {
      // 何もしない（doc を参照）。
    }
  }

  // 見張りを `fetch()` の前に張る: 固着は応答ヘッダが返る前にも起こり（Unix ソケット経路は期限を持たない）、`#read` の中だけを見張るとそこへ到達しない固着が残るため
  // 切ったことは例外にして自分で投げ直す（`abort()` の効き方に賭けない）: 正常終了として返すと `#pump` は失敗と数えず、`切れました` の行も出ず固着がログから消えるため
  async #stream(onEvent: (event: RunnerEvent) => void, markHealthy: () => void): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;

    // ここで `#nowFn()` を呼ばない: 呼び出し番号で値を返す既存の足場（`nowFnAtExactThreshold`）の番号が全部ずれるため。「まだ1バイトも来ていない」は `null` で表す
    let lastByteAt: number | null = null;
    let openedAt: number | null = null;
    let silent = false;
    // 入れ物に包む: 素の `let` だと代入が閉包の中でしか起きず、`finally` の時点で `never` に絞り込まれる（TS2349）ため
    const watchdog: { cancel: (() => void) | null } = { cancel: null };
    // バイトが届くたびにタイマーを作り直さない: 発火したときに測り直して残りぶんだけ張り直せば生きているタイマーは常に1本で、流量に関係なく一定のため
    const armWatchdog = (ms: number): void => {
      watchdog.cancel = this.#setTimerFn(ms, () => {
        if (lastByteAt !== null) {
          const idleMs = this.#nowFn() - lastByteAt;
          if (idleMs < this.#silenceTimeoutMs) {
            armWatchdog(this.#silenceTimeoutMs - idleMs);
            return;
          }
        }
        silent = true;
        controller.abort();
      });
    };
    const silenceFailure = (): Error =>
      new Error(
        `runner の /events が ${String(this.#silenceTimeoutMs)}ms のあいだ無音だった（heartbeat が途絶えた）`,
      );

    armWatchdog(this.#silenceTimeoutMs);
    try {
      const response = await this.#fetch(`${this.#baseUrl}/events`, {
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${this.#token}`,
          ...(this.#lastEventId === null ? {} : { 'last-event-id': String(this.#lastEventId) }),
        },
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) {
        throw new Error(`runner の /events に繋げない (${response.status})`);
      }

      const connectedAt = this.#nowFn();
      // `connectedAt` を使い回す: 新しい `#nowFn()` 呼び出しを増やすと `nowFnAtExactThreshold` 型の足場を壊すため
      this.#legStreamOpenSince = connectedAt;
      openedAt = connectedAt;
      this.#legEverConnected = true;
      this.#legLastByteAt = null;
      this.#legNextRetryAt = null;
      const reader = response.body.getReader();
      // 接続1本ぶんで数える: プロセス単位で畳むと、器が入れ替わって新しい runner が同じ `type` を出し始めたときに「前に見たから」で黙るため
      const dropped = new Map<string, number>();
      const summarize = (): void => {
        if (dropped.size === 0) return;
        this.#onDroppedEvent?.({
          phase: 'closed',
          dropped: [...dropped].map(([key, count]) => ({ key, count })),
        });
      };

      try {
        await this.#read(reader, onEvent, dropped, () => {
          // `#nowFn()` の呼び出しを1バイトにつき1回のままにする: 増やすと `nowFnAtExactThreshold` 型の足場が壊れるため
          const now = this.#nowFn();
          lastByteAt = now;
          this.#legLastByteAt = now;
          if (now - connectedAt >= CONNECTION_HEALTHY_THRESHOLD_MS) markHealthy();
        });
      } finally {
        summarize();
      }
      // `AbortError` のままにしない: `#pump` が書く `切れました` の行が「何が起きたか」を名乗れなくなるため
      if (silent) throw silenceFailure();
    } catch (error) {
      if (silent) throw silenceFailure();
      throw error;
    } finally {
      watchdog.cancel?.();
      // ここで新しく `#nowFn()` を呼ばない: この `finally` は全ての試行の後で走るので、呼び出し番号を数える足場を壊すため。代わりに「最後にバイトを受け取った時刻（無ければ接続した時刻）」を使い回す
      if (this.#legStreamOpenSince !== null) {
        this.#legDownSince = lastByteAt ?? openedAt;
        this.#legStreamOpenSince = null;
      }
    }
  }

  async #read(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onEvent: (event: RunnerEvent) => void,
    dropped: Map<string, number>,
    onBytes: () => void,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    let firstIdSeen = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      onBytes();
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = frame.split('\n');
        const data = lines
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');

        // `id:` を `data:` と独立に読む: `data` がスキーマに合わなかった／壊れていてもフレーム自体は届いており、取り直しても同じ結果にしかならないため
        const idLine = lines.find((line) => line.startsWith('id:'));
        if (idLine !== undefined) {
          const seq = Number(idLine.slice(3).trim());
          if (Number.isInteger(seq) && seq >= 0) {
            if (!firstIdSeen || this.#lastEventId === null || seq > this.#lastEventId) {
              this.#lastEventId = seq;
            }
            firstIdSeen = true;
          }
        }

        if (data.length > 0) {
          try {
            const raw: unknown = JSON.parse(data);
            const parsed = runnerEventSchema.safeParse(raw);
            if (parsed.success) onEvent(parsed.data);
            // 黙って落とさない: runner が新しい種類の出来事を出し始めても、跡が残らないと気づく主体が誰も居ないため
            else this.#noteDropped(dropped, 'unknown-shape', typeOf(raw), data.length);
          } catch {
            // 壊れた1フレームでストリームごと落とさず、黙って捨てもしない（取れない `type` を 0 として積まず、バイト数だけを渡す）
            this.#noteDropped(dropped, 'unparsable', undefined, data.length);
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  // 初出をその場で1行出す: 閉じるときのまとめだけだと、デーモンが拾われない例外で死んだとき `type` の存在そのものが失われる（失ってよいのは量で、存在ではない）ため
  #noteDropped(
    dropped: Map<string, number>,
    reason: 'unparsable' | 'unknown-shape',
    type: string | undefined,
    bytes: number,
  ): void {
    const key = type === undefined ? reason : `${reason}:${type}`;
    const seen = dropped.get(key) ?? 0;
    dropped.set(key, seen + 1);
    if (seen > 0) return;
    this.#onDroppedEvent?.({
      phase: 'first',
      reason,
      ...(type === undefined ? {} : { type }),
      bytes,
    });
  }

  // この1つだけ期限を付けない: 付けると期限切れ（＝不明）が呼ぶ側で確定的な失敗に化け、`Pool.start` が `#records` から消して台帳にも残さず、runner 側で走り出していても `manager_list` から消えて止める手も残らない（無期限に待つより悪い）ため
  // 戻り値の `cwd` を「頼んだ値のまま」で埋めない: ローリング再デプロイの窓では、この変更前の runner が `{ ok: true }` だけを返すため。1欄ずつ検証し、他欄の形崩れに巻き込まれない
  async start(command: RunnerStartCommand): Promise<{ cwd?: string; sessionGeneration?: string }> {
    const response = await this.#callWithoutDeadline('POST', '/managers', command);
    const body = (await response.json()) as { cwd?: unknown; sessionGeneration?: unknown };
    const cwd = runnerSessionOpenResultSchema.shape.cwd.safeParse(body.cwd);
    const generation = runnerSessionOpenResultSchema.shape.sessionGeneration.safeParse(
      body.sessionGeneration,
    );
    return {
      ...(cwd.success && cwd.data !== undefined ? { cwd: cwd.data } : {}),
      ...(generation.success && generation.data !== undefined
        ? { sessionGeneration: generation.data }
        : {}),
    };
  }

  async resume(command: RunnerResumeCommand): Promise<RunnerResumeResult> {
    const response = await this.#call(
      'POST',
      `/managers/${encodeURIComponent(command.managerId)}/resume`,
      command,
    );
    const body = (await response.json()) as {
      cwd?: unknown;
      reusedLiveSession?: unknown;
      sessionGeneration?: unknown;
    };
    const cwd = runnerSessionOpenResultSchema.shape.cwd.safeParse(body.cwd);
    const generation = runnerSessionOpenResultSchema.shape.sessionGeneration.safeParse(
      body.sessionGeneration,
    );
    // 欄が無い・形が崩れた回は `false` へ倒さず `undefined`（分からない）にする: 古い runner は短絡したかを名乗れないため
    const reused = runnerSessionOpenResultSchema.shape.reusedLiveSession.safeParse(
      body.reusedLiveSession,
    );
    return {
      ...(cwd.success && cwd.data !== undefined ? { cwd: cwd.data } : {}),
      ...(reused.success && reused.data !== undefined ? { reusedLiveSession: reused.data } : {}),
      ...(generation.success && generation.data !== undefined
        ? { sessionGeneration: generation.data }
        : {}),
    };
  }

  async send(
    managerId: string,
    text: string,
    attachments?: readonly RunnerAttachment[],
  ): Promise<boolean> {
    await this.#call('POST', `/managers/${encodeURIComponent(managerId)}/messages`, {
      text,
      // 添付が無ければ欄ごと省く: 欄を知らない古い runner は黙って捨てるので、添付を送る前に `ManagerPool` が名乗りを確かめているため
      ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
    });
    return true;
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<RunnerAnswerOutcome> {
    const response = await this.#call(
      'POST',
      `/managers/${encodeURIComponent(managerId)}/answers`,
      answer,
    );
    const body = (await response.json()) as { ok?: unknown; decision?: unknown };
    // 1つずつ検証する: まとめて弾くと、`ok` の形が崩れただけで `decision` まで落ちるため
    const decision = runnerAnswerResultSchema.shape.decision.safeParse(body.decision);
    return {
      delivered: body.ok === true,
      // 欠けた回を allow/deny の既定値へ倒さず欄そのものを省く: ローリング再デプロイの窓では、この変更前の runner が `decision` を持たない応答を返すため
      ...(decision.success && decision.data !== undefined ? { decision: decision.data } : {}),
    };
  }

  async stop(managerId: string): Promise<void> {
    await this.#call('DELETE', `/managers/${encodeURIComponent(managerId)}`);
  }

  // `signal` を受ける: 10秒ごとの生存確認がこの口も叩くので、期限で中断できないと返らない1回が `RUNNER_CALL_DEADLINE_MS` まで居座り、次の周期の呼び出しと積み重なるため
  async list(options?: { signal?: AbortSignal }): Promise<RunnerManagerState[]> {
    return (await this.listWithUnreadable(options)).states;
  }

  async listWithUnreadable(options?: { signal?: AbortSignal }): Promise<RunnerManagerListing> {
    const response = await this.#call('GET', '/managers', undefined, options?.signal);
    const body = (await response.json()) as { managers?: unknown };
    if (!Array.isArray(body.managers)) return { states: [], unreadableIds: [] };
    // スキーマに合わない要素を黙っては飛ばさない（値は載せず `managerId` と落ちた欄の名前だけ残す）: 飛ばした委譲は Pool から見て「runner に居ない」側に落ち、待っていた確認まで捨てられうるのに、跡が無いと理由を誰も追えないため
    const dropped: { managerId: string | undefined; fields: string[] }[] = [];
    const managers = body.managers.flatMap((entry) => {
      const parsed = runnerManagerStateSchema.safeParse(entry);
      if (parsed.success) return [parsed.data];
      const rawId =
        typeof entry === 'object' && entry !== null
          ? (entry as { managerId?: unknown }).managerId
          : undefined;
      const fields = [
        ...new Set(
          parsed.error.issues.map((issue) => issue.path.map(String).join('.')).filter(Boolean),
        ),
      ];
      dropped.push({
        managerId: typeof rawId === 'string' && rawId !== '' ? rawId : undefined,
        fields,
      });
      return [];
    });
    // 同じ組は初出だけ残す: `list()` は生存確認で周期的に呼ばれるので、毎回出すと跡でログを埋めるため
    const fresh = dropped.filter(({ managerId, fields }) => {
      const key = `${managerId ?? ''}|${fields.join(',')}`;
      if (this.#droppedManagerKeys.has(key)) return false;
      if (this.#droppedManagerKeys.size >= DROPPED_MANAGER_KEY_LIMIT) {
        this.#droppedManagerKeys.clear();
      }
      this.#droppedManagerKeys.add(key);
      return true;
    });
    if (fresh.length > 0) noteDroppedRunnerManagers(this.#describeSelf(), fresh);
    return {
      states: managers,
      unreadableIds: dropped.flatMap(({ managerId }) =>
        managerId === undefined ? [] : [managerId],
      ),
    };
  }

  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    return fingerprintsOf(body.credentials);
  }

  async setCredentials(
    credentials: RunnerSetCredentialsCommand['credentials'],
  ): Promise<RunnerCredentialFingerprint[]> {
    const response = await this.#call('POST', '/credentials', { credentials });
    const body = (await response.json()) as { credentials?: unknown };
    return fingerprintsOf(body.credentials);
  }

  async profile(): Promise<RunnerProfileFingerprint | undefined> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    // 欄が在るのに形が読めなかったときは投げる（`undefined` へ倒さない）: `syncRunner` が「外したプロファイルと一致」と読み、外したはずのプロファイルが runner に残り続けるため
    if (body.profile === undefined || body.profile === null) return undefined;
    const parsed = runnerProfileFingerprintSchema.safeParse(body.profile);
    if (!parsed.success) throw new Error('runner の /health の profile の欄を読めなかった');
    return parsed.data;
  }

  async setProfile(script: string): Promise<RunnerProfileResult> {
    const response = await this.#call('POST', '/profile', { script });
    const parsed = runnerProfileResultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { ok: false, error: 'runner の応答を読めなかった' };
  }

  // 欄が在るのに形が読めなかったときは投げる（`undefined` へ倒さない）: `syncRunner` が「外した登録と一致」と読み、外したはずの登録が runner に残り続けるため
  async mcpServers(): Promise<RunnerMcpServersFingerprint | undefined> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    if (body.mcpServers === undefined || body.mcpServers === null) return undefined;
    const parsed = runnerMcpServersFingerprintSchema.safeParse(body.mcpServers);
    if (!parsed.success) throw new Error('runner の /health の mcpServers の欄を読めなかった');
    return parsed.data;
  }

  // 404 は「口を持たない（古い版）」に変える: 一時障害と混ぜると、呼び出し側が挑み直しを積み続けるため
  // 応答の形が読めなかったときは投げる: 戻り値は指紋だけで、読めないことを表す場所が例外しかなく、「置けた」と読んで指紋を作らないため
  async setMcpServers(servers: McpServers): Promise<RunnerMcpServersFingerprint | undefined> {
    let response: Response;
    try {
      response = await this.#call('POST', '/mcp-servers', { mcpServers: servers });
    } catch (error) {
      if (error instanceof RunnerHttpError && error.status === 404) {
        throw new RunnerMcpServersUnsupportedError(this.runnerId);
      }
      throw error;
    }
    const body = (await response.json()) as { ok?: unknown; mcpServers?: unknown };
    if (body.ok !== true) throw new Error('runner の応答を読めなかった（MCP の登録）');
    if (body.mcpServers === undefined) return undefined;
    const parsed = runnerMcpServersFingerprintSchema.safeParse(body.mcpServers);
    if (!parsed.success) throw new Error('runner の応答を読めなかった（MCP の登録の指紋）');
    return parsed.data;
  }

  // 欄が在るのに形が読めなかったときは投げる（「持っていない」へ倒さない）: 外したはずの plugin が runner に残り続けるため
  async plugins(): Promise<RunnerPluginsFingerprint | undefined> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    if (body.plugins === undefined || body.plugins === null) return undefined;
    const parsed = runnerPluginsFingerprintSchema.safeParse(body.plugins);
    if (!parsed.success) throw new Error('runner の /health の plugins の欄を読めなかった');
    return parsed.data;
  }

  async setPlugin(plugin: RunnerPlugin): Promise<RunnerPluginFingerprintEntry> {
    let response: Response;
    try {
      // 期限を本文の大きさに見合うぶんだけ延ばす: 本文は base64 で約 4/3 倍になるため
      const bodyBytes = Math.ceil(
        (plugin.files.reduce((sum, file) => sum + file.content.byteLength, 0) * 4) / 3,
      );
      response = await this.#call(
        'POST',
        `/plugins/${encodeURIComponent(plugin.name)}`,
        encodeRunnerPlugin(plugin),
        undefined,
        pluginPushDeadlineMs(this.#deadlineMs, bodyBytes),
      );
    } catch (error) {
      if (error instanceof RunnerHttpError && error.status === 404) {
        throw new RunnerPluginsUnsupportedError(this.runnerId);
      }
      throw error;
    }
    const body = (await response.json()) as { ok?: unknown; plugin?: unknown };
    if (body.ok !== true) throw new Error('runner の応答を読めなかった（plugin）');
    const parsed = runnerPluginFingerprintEntrySchema.safeParse(body.plugin);
    if (!parsed.success) throw new Error('runner の応答を読めなかった（plugin の指紋）');
    return parsed.data;
  }

  async retainPlugins(names: readonly string[]): Promise<RunnerPluginsFingerprint | undefined> {
    let response: Response;
    try {
      response = await this.#call('PUT', '/plugins', { names });
    } catch (error) {
      if (error instanceof RunnerHttpError && error.status === 404) {
        throw new RunnerPluginsUnsupportedError(this.runnerId);
      }
      throw error;
    }
    const body = (await response.json()) as { ok?: unknown; plugins?: unknown };
    if (body.ok !== true) throw new Error('runner の応答を読めなかった（plugin の一覧）');
    if (body.plugins === undefined) return undefined;
    const parsed = runnerPluginsFingerprintSchema.safeParse(body.plugins);
    if (!parsed.success) throw new Error('runner の応答を読めなかった（plugin の一覧の指紋）');
    return parsed.data;
  }

  // 404 は「口を持たない（古い版）」に変える: 一時障害と混ぜると呼び出し側が挑み直しを積み続けるため
  // 値は例外の文にも載せない: 秘密のため
  async setCodexAuth(push: { value: string; revision: string } | null): Promise<void> {
    let response: Response;
    try {
      response = await this.#call('POST', '/codex-auth', { codexAuth: push });
    } catch (error) {
      if (error instanceof RunnerHttpError && error.status === 404) {
        throw new RunnerCodexAuthUnsupportedError(this.runnerId);
      }
      throw error;
    }
    const body = (await response.json()) as { ok?: unknown };
    if (body.ok !== true)
      throw new Error('runner の応答を読めなかった（Codex の ChatGPT ログイン）');
  }

  async takeCodexAuthWriteBack(
    fingerprint: string,
  ): Promise<{ value: string; baseRevision: string; fingerprint: string } | null> {
    let response: Response;
    try {
      response = await this.#call('POST', '/codex-auth/write-back', { fingerprint });
    } catch (error) {
      if (error instanceof RunnerHttpError && error.status === 404) return null;
      throw error;
    }
    const body = (await response.json()) as { ok?: unknown; writeBack?: unknown };
    if (body.ok !== true) throw new Error('runner の応答を読めなかった（Codex の書き戻し）');
    if (body.writeBack === null || body.writeBack === undefined) return null;
    const parsed = runnerCodexAuthWriteBackSchema.safeParse(body.writeBack);
    if (!parsed.success) throw new Error('runner の応答を読めなかった（Codex の書き戻しの形）');
    return parsed.data;
  }

  async transcript(managerId: string): Promise<string | null> {
    try {
      const response = await this.#call(
        'GET',
        `/managers/${encodeURIComponent(managerId)}/transcript`,
      );
      return await response.text();
    } catch {
      return null;
    }
  }

  // 404 だけを `undefined`（無い）にする: 接続断・期限切れ・ほかの非2xx も `undefined` にすると、「取れなかった」と「無い」が混ざるため
  async openOutboxFile(
    managerId: string,
    fileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<RunnerOutboxContent | undefined> {
    let response: Response;
    try {
      response = await this.#call(
        'GET',
        `/managers/${encodeURIComponent(managerId)}/outbox/${encodeURIComponent(fileId)}`,
        undefined,
        options?.signal,
      );
    } catch (error) {
      if (error instanceof RunnerHttpError && error.status === 404) return undefined;
      throw error;
    }
    if (response.body === null) throw new Error('runner の応答に本文が無い（出し箱の取り出し）');
    const size = Number(response.headers.get('content-length'));
    return {
      ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
      body: Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
    };
  }

  async deleteOutboxFile(
    managerId: string,
    fileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    await this.#call(
      'DELETE',
      `/managers/${encodeURIComponent(managerId)}/outbox/${encodeURIComponent(fileId)}`,
      undefined,
      options?.signal,
    );
  }

  // 取れなければ `undefined`（0 と混ぜない）: 呼び出し側が「確かめられなかった」として扱うため
  async unpushedWork(
    managerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<UnpushedWorkResult | undefined> {
    try {
      const response = await this.#call(
        'GET',
        `/managers/${encodeURIComponent(managerId)}/unpushed-work`,
        undefined,
        options?.signal,
      );
      const parsed = unpushedWorkResultSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  // 消えたと言えるのは runner が `removed` を返したときだけ: 期限切れ・非2xx・古い runner（口を持たない）・応答が読めないのどれも `failed` に倒す（古い runner の 404 は口が無いのか経路の不調なのか分けられず `other`）
  async deleteRescueRef(
    request: RunnerRescueRefDeleteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RunnerRescueRefDeleteResult> {
    try {
      const response = await this.#call('POST', '/rescue-refs/delete', request, options?.signal);
      const parsed = runnerRescueRefDeleteResultSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : { outcome: 'failed', kind: 'other' };
    } catch (error) {
      return {
        outcome: 'failed',
        kind: error instanceof RunnerUnknownError ? 'timeout' : 'other',
      };
    }
  }

  awaitStreamEnd(): Promise<void> {
    this.#noReconnect = true;
    if (!this.#streamActive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#streamEndWaiters.push(resolve);
    });
  }

  // runner のマネージャーは止めない: デーモンの都合（再起動・更新）で、走っている人の仕事を殺さないため
  async close(): Promise<void> {
    this.#closed = true;
    this.#controller?.abort();
    this.#controller = null;
  }

  // `RunnerHttpError` の系列に乗せない（`RunnerUnknownError`）: あちらは status を持つ＝相手が答えた証拠で、期限切れは「返らなかった」であって「失敗した」ではないため
  // `AbortController` を作らない: 期限は待つのをやめるためだけにあり、投げた要求はそのまま走って遅れて返ったら `late` として報告するため
  async #call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    deadlineMs?: number,
  ): Promise<Response> {
    const waitedMs = deadlineMs ?? this.#deadlineMs;
    const settled = await settleWithinDeadline(
      this.#callWithoutDeadline(method, path, body, signal),
      waitedMs,
      (late) => {
        // 遅れて返ってきた本文は読み捨てる: 読まずに放ると繋ぎが積み上がるため
        if (late.ok) void late.value.text().catch(() => '');
        this.#onUnknown?.({
          method,
          path,
          waitedMs,
          phase: 'late',
          ok: late.ok,
          ...(late.ok ? {} : { error: late.error }),
        });
      },
    );
    if (settled.outcome === 'settled') return settled.value;
    if (settled.outcome === 'failed') throw settled.error;
    this.#onUnknown?.({ method, path, waitedMs, phase: 'expired' });
    throw new RunnerUnknownError({ method, path, waitedMs });
  }

  // 呼んでよいのは `start()` だけ: 期限切れが呼ぶ側で確定的な失敗に化けるため
  async #callWithoutDeadline(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      const detail = runnerErrorBodyOf(await response.text().catch(() => ''));
      throw new RunnerHttpError(
        `runner ${method} ${path} が失敗した (${response.status}) ${detail}`,
        response.status,
      );
    }
    return response;
  }
}

const RUNNER_ERROR_BODY_LIMIT = 512;

// 巨大な本文で走査が伸びないように、伏せ字を通す前に読む量を切る
const RUNNER_ERROR_BODY_READ_LIMIT = 8192;

// 伏せ字（`redactErrorText`）を通してから切る: 順序が逆だと、切り口で割れたトークンの断片がどの伏せ字にも合わずに残るため
function runnerErrorBodyOf(body: string): string {
  const redacted = redactErrorText(body.slice(0, RUNNER_ERROR_BODY_READ_LIMIT), process.env);
  return redacted.length > RUNNER_ERROR_BODY_LIMIT || body.length > RUNNER_ERROR_BODY_READ_LIMIT
    ? `${redacted.slice(0, codePointBoundary(redacted, RUNNER_ERROR_BODY_LIMIT))}…`
    : redacted;
}

function requestOverSocket(socketPath: string, url: URL, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers ?? {});
    const outgoing: Record<string, string> = {};
    headers.forEach((value, key) => {
      outgoing[key] = value;
    });

    const req = httpRequest(
      {
        socketPath,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: outgoing,
      },
      (res) => {
        const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        resolve(
          new Response(body, {
            status: res.statusCode ?? 500,
            headers: Object.entries(res.headers).flatMap(([key, value]) =>
              typeof value === 'string' ? [[key, value] as [string, string]] : [],
            ),
          }),
        );
      },
    );

    req.on('error', reject);
    const signal = init.signal;
    if (signal) signal.addEventListener('abort', () => req.destroy(), { once: true });
    if (typeof init.body === 'string') req.write(init.body);
    req.end();
  });
}
