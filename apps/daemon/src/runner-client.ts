import type {
  RunnerAnswerCommand,
  RunnerClient,
  RunnerCredentialFingerprint,
  RunnerEvent,
  RunnerManagerState,
  RunnerPlacementResources,
  RunnerResumeCommand,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerSetCredentialsCommand,
  RunnerStartCommand,
} from '@alteroid/core';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

import { RUNNER_CALL_DEADLINE_MS, RunnerUnknownError, settleWithinDeadline } from './deadline.js';

import {
  RunnerHttpError,
  runnerCredentialFingerprintSchema,
  runnerProfileFingerprintSchema,
  runnerProfileResultSchema,
  runnerEventSchema,
  runnerExecutionResourcesSchema,
  runnerManagerStateSchema,
  runnerPlacementResourcesSchema,
} from '@alteroid/core';

// **失敗の種別は口の定義（`@alteroid/core`）が持つ。** この経路だけの都合にすると、
// 同じ判断をインプロセスの runner 側で作り直すことになる。
export { RunnerHttpError } from '@alteroid/core';
export { RUNNER_CALL_DEADLINE_MS, RunnerUnknownError } from './deadline.js';

/**
 * 「期限内に応答が返らなかった」ことの報告。**日誌へ届けるためだけにある。**
 *
 * ここで分類を終わらせないこと。**この報告が言えるのは「返らなかった」だけ**で、
 * 失敗も死亡も「届かなかった」も言えない（{@link RunnerUnknownError}）。
 */
export interface RunnerUnknownReport {
  method: string;
  path: string;
  waitedMs: number;
  /**
   * `expired` = 期限が切れた（＝不明になった）。
   * `late` = 不明と言ったあとで**遅れて応答が返ってきた**（＝不明が解けた）。
   */
  phase: 'expired' | 'late';
  /** `late` のときだけ: 遅れて返ってきた応答が成功だったか。 */
  ok?: boolean;
  /** `late` で失敗だったときの中身。 */
  error?: unknown;
}

/**
 * 挑み直しの間隔の既定値（基準・上限）。
 *
 * **正本は `packages/core/src/runner-protocol.ts` の `REGISTRY_RETRY_BASE_MS` /
 * `REGISTRY_RETRY_MAX_MS`（名簿側の再接続）である。** あちらは export されて
 * いないので値だけをこちらへ写している — import できる関係ではなく、**形を
 * 揃えているだけ**である。名簿側とこの口は層が違うだけで、あるべき挙動
 * （待てば直るので回数では諦めず、間隔だけを伸ばして頭打ちにする）は同じ。
 */
const RUNNER_STREAM_RETRY_BASE_MS = 1_000;
const RUNNER_STREAM_RETRY_MAX_MS = 30_000;

/** `setTimeout` を `unref` して待つ（既定の `sleepFn`）。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // 名簿側の #scheduleOpen と同じ理由: 挑み直しの待ちで、止めたはずの
    // デーモンの終了を引き延ばさない。
    timer.unref?.();
  });
}

/**
 * manager-runner への HTTP の口（M4）。
 *
 * **繋ぎに行くのはこちら（デーモン）だけである。** runner はデーモンの所在も鍵も
 * 知らない。逆向きのコールバック URL を足すと、runner の中のマネージャーがその
 * 経路でデーモンの API（＝記憶）へ届くようになる（architecture.md「非対称な可視性」）。
 */
export interface HttpRunnerOptions {
  /** `http://runner:4518` か `unix:/run/alteroid/runner.sock`。 */
  baseUrl: string;
  /**
   * 制御面の合鍵。**デーモンだけが素の値を持つ。**
   *
   * runner 側にあるのは sha256 だけなので、runner の中で走るマネージャーが
   * `/proc/1/environ` を読めたとしても、この鍵は作れない。鍵が無ければ
   * `POST /managers/:id/answers` は通らない — マネージャーが自分宛の許可確認に
   * 自分で `allow` を返す経路を塞ぐ、いちばん内側の一枚である。
   */
  token: string;
  /** 主にテスト用。既定はグローバルの `fetch`（Unix ソケットなら node:http）。 */
  fetchFn?: typeof fetch;
  /**
   * ストリームが切れたときに待つ**基準**のミリ秒（既定 1000）。
   *
   * **名前は変えていないが意味は変わっている。** 以前は毎回この値を固定で
   * 待っていたが、いまは失敗するたびに倍々に伸びる列の出発点（＝基準）で
   * あり、繋ぎ直せたらここへ戻る。上限は `retryMaxDelayMs`。
   */
  retryDelayMs?: number;
  /**
   * バックオフの上限ミリ秒（既定 30000。`packages/core` の名簿側と同じ値）。
   *
   * **回数では諦めない。** 上限は「秒間に何度も叩かない」ための頭打ちであって、
   * 挑み直しをやめる制限ではない（諦めた先に残るのは、宛先を失ったまま誰にも
   * 知らされないデーモンである）。
   */
  retryMaxDelayMs?: number;
  /**
   * 挑み直しの待ちを差し替える口。**主にテスト用**（`fetchFn` と同じ作法）。
   * 既定は `setTimeout`（`unref` 済み）で実際に待つ。
   */
  sleepFn?: (ms: number) => Promise<void>;
  /**
   * 制御面の応答を待つ期限（既定 {@link RUNNER_CALL_DEADLINE_MS}）。**主にテスト用。**
   *
   * 運用でここを縮めないこと。**期限は「返らない」を掴むためのもので、「遅い」を
   * 打ち切るためのものではない**（`deadline.ts` の doc）。
   */
  deadlineMs?: number;
  /**
   * 期限が切れたこと（と、そのあと遅れて返ってきたこと）の受け口。
   *
   * **ここを繋がないと「不明」が誰にも届かない。** デーモンは日誌へ落とす
   * （`index.ts`）。runner-client 自身は日誌を知らない — 誰に知らせるかを選ぶのは
   * 上の層の仕事である。
   */
  onUnknown?: (report: RunnerUnknownReport) => void;
}

/**
 * 期限切れの宛先がマネージャー1本を指しているか（指しているならその id）。
 *
 * **日誌へ載せるかどうかの分かれ目である。** マネージャー宛の操作（`send` /
 * `stop` / `answer` / `resume` / `transcript`）の不明は、クローンの委譲そのものの
 * 話なので日誌へ残す。器の生死や設定の押し込み（`/health` / `/credentials` /
 * `/profile` / `GET /managers`）は**既に別の経路が持っている** — 名簿の生存判定と
 * `GET /runners`、`Pool.abort` の `sessionGone === undefined`（「止まったかは未確認」）
 * である。そこを日誌へも流すと**同じ契約が2つになる**うえ、黙って死んだ器へ挑み
 * 直すたびに1行増えて、`journal_read` の窓から本物の記録を押し出す。
 */
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

/**
 * 「不明」を日誌の1行にする。**この行を読む人はこの PR を読んでいない。**
 *
 * だから**言えること／言えないことを行の中に書く。** 期限切れは「失敗した」でも
 * 「runner が死んだ」でもないので、そう読めない文にしないと、読んだ側が勝手に
 * 断定へ畳む（再送すれば二重に実行され、引き取らせれば同じマネージャーが2台で
 * 走る）。
 *
 * **後から解けたことも同じ形で残す。** 「不明」だけが残って解決が残らないと、
 * 日誌を辿った人は永久に不明のままだと読む。
 */
export function describeRunnerUnknown(report: RunnerUnknownReport): string {
  const managerId = managerIdOfRunnerPath(report.path);
  // 委譲1本の話なら id を前置する。日誌の他の行（`manager.ts` の `#journal`）と
  // 同じ形にしておくと、マネージャーの記録を追う grep が1本で済む。
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

/** `unix:/path/to.sock` を取り出す（無ければ TCP）。 */
function socketPathOf(baseUrl: string): string | null {
  const match = /^unix:(?:\/\/)?(.+)$/.exec(baseUrl);
  return match?.[1] ?? null;
}

/** 接続して runner_id を確かめてから使う（宛先を台帳に残すため）。 */
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
  managers?: unknown;
  resources?: unknown;
}

/** 指紋の配列だけを取り出す（値は runner も返さないし、こちらも持たない）。 */
function fingerprintsOf(value: unknown): RunnerCredentialFingerprint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = runnerCredentialFingerprintSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

class HttpRunner implements RunnerClient {
  runnerId = 'runner-primary';
  workspacePath = '';
  readonly #baseUrl: string;
  readonly #socketPath: string | null;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #sleepFn: (ms: number) => Promise<void>;
  readonly #deadlineMs: number;
  readonly #onUnknown: ((report: RunnerUnknownReport) => void) | undefined;
  #controller: AbortController | null = null;
  #closed = false;
  /** 次に失敗したときに待つ長さ。失敗のたびに倍々に伸び、成功で基準へ戻る。 */
  #nextDelayMs: number;
  /** 直前の接続が失敗していて、まだ繋ぎ直せていないか。 */
  #backingOff = false;
  /** 直前に stderr へ書いた待ち時間。同じ値のときは書き直さない。 */
  #lastLoggedDelayMs: number | null = null;

  constructor(options: HttpRunnerOptions) {
    this.#socketPath = socketPathOf(options.baseUrl);
    // ソケットのときも URL の形は要る（ホスト名は使われない）
    this.#baseUrl =
      this.#socketPath === null ? options.baseUrl.replace(/\/$/, '') : 'http://runner';
    this.#token = options.token;
    this.#fetch = options.fetchFn ?? ((input, init) => this.#send(input, init));
    this.#retryBaseMs = options.retryDelayMs ?? RUNNER_STREAM_RETRY_BASE_MS;
    this.#retryMaxMs = options.retryMaxDelayMs ?? RUNNER_STREAM_RETRY_MAX_MS;
    this.#sleepFn = options.sleepFn ?? defaultSleep;
    this.#nextDelayMs = this.#retryBaseMs;
    this.#deadlineMs = options.deadlineMs ?? RUNNER_CALL_DEADLINE_MS;
    this.#onUnknown = options.onUnknown;
  }

  /**
   * Unix ソケット越しにも喋れる送信口。
   *
   * グローバルの `fetch` はソケットへ繋げないので、ソケットのときだけ node:http を
   * 使う。**ソケットにするのは、マネージャーと同じ器の中に TCP の口を開けない
   * ため**である（開いていれば `curl 127.0.0.1` の宛先になる）。
   */
  #send(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (this.#socketPath === null) return fetch(input, init);
    const url = new URL(typeof input === 'string' ? input : input.toString());
    return requestOverSocket(this.#socketPath, url, init ?? {});
  }

  /** 名乗りを聞く。ここで得た runner_id が `manager_id → runner_id` の宛先になる。 */
  async hello(): Promise<void> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    if (typeof body.runnerId === 'string' && body.runnerId.length > 0) {
      this.runnerId = body.runnerId;
    }
    if (typeof body.workspacePath === 'string') this.workspacePath = body.workspacePath;
  }

  /**
   * 生きているかを聞く。**既存の `/health` を叩くだけ**で、新しい口は足さない。
   *
   * `hello()` と違って**名乗りの中身は取らない**。器が入れ替わって別の runner_id を
   * 返してきたとき、それは「同じ宛先が生きている」ではなく「走っていた仕事ごと
   * 入れ替わった」であり、ここで黙って runnerId を書き換えると台帳の鎖
   * （`manager_id → runner_id`）が音もなく繋ぎ変わる。ここで見るのは生死だけである。
   *
   * 本文は読み捨てる（読まずに放ると、10秒ごとに繋ぎが積み上がる）。
   */
  async ping(options?: { signal?: AbortSignal }): Promise<void> {
    const response = await this.#call('GET', '/health', undefined, options?.signal);
    await response.text().catch(() => '');
  }

  /**
   * 名乗りの中身を**読むが採らない**（M5 PR4 の判定材料）。
   *
   * 叩く先は `ping()` と同じ `GET /health` で、新しい口は足していない。違うのは
   * 本文を読むことだけである。**それでも `this.runnerId` / `this.workspacePath` は
   * 書き換えない** — 書き換えれば台帳の鎖（`manager_id → runner_id`）が音もなく
   * 繋ぎ変わる（`ping()` の項に書いてある元の理由）。ここが返すのは判定の材料で
   * あって、採用する値ではない。
   *
   * **`instanceId` を返さない runner とも繋がる。** そのときは `undefined` のままで、
   * 名簿は入れ替えを判定しない（「入れ替わっていない」とは読まない）。
   */
  async identity(options?: {
    signal?: AbortSignal;
  }): Promise<{ runnerId?: string; instanceId?: string } | undefined> {
    const response = await this.#call('GET', '/health', undefined, options?.signal);
    const body = (await response.json()) as HealthBody;
    return {
      ...(typeof body.runnerId === 'string' && body.runnerId.length > 0
        ? { runnerId: body.runnerId }
        : {}),
      ...(typeof body.instanceId === 'string' && body.instanceId.length > 0
        ? { instanceId: body.instanceId }
        : {}),
    };
  }
  /**
   * 配置の材料を渡す。**既存の `/health` を叩くだけ**で、新しい口は足さない
   * （`credentials()` / `profile()` と同じ作法である）。
   *
   * `ping()` と違って本文を読むが、**採るのは資源だけである。** `runnerId` /
   * `workspacePath` はここで採らない — 器が入れ替わったときに台帳の鎖
   * （`manager_id → runner_id`）が黙って繋ぎ変わるのを避けるためで、`ping()` に
   * 書いてある理由と同じである。だから資源を `ping()` に相乗りさせず、別の口にした。
   *
   * **宣言していない形は捨てる**（zod）。`resources` を返さない古い runner は
   * `managers` だけを名乗り、**それで不利にはならない**（埋めるのは配置側である）。
   * 材料は1つずつ検証する — まとめて弾くと、`cpu` の形が崩れただけで `managers` まで
   * 落ち、資源を報告できる器が「何も報告しない器」に見える。
   */
  async resources(options?: { signal?: AbortSignal }): Promise<RunnerPlacementResources> {
    const response = await this.#call('GET', '/health', undefined, options?.signal);
    const body = (await response.json()) as HealthBody;
    const parsed = runnerExecutionResourcesSchema.safeParse(body.resources ?? {});
    const managers = runnerPlacementResourcesSchema.shape.managers.safeParse(body.managers);
    return {
      ...(parsed.success ? parsed.data : {}),
      ...(managers.success && managers.data !== undefined ? { managers: managers.data } : {}),
    };
  }

  /**
   * イベントの受け取り。切れたら繋ぎ直す。
   *
   * **繋がっていない間の出来事は runner 側に溜まる**（Outbox）。ここで諦めると、
   * 誰も答えられない確認が runner に残り、マネージャーが永久に止まる。
   */
  async connect(onEvent: (event: RunnerEvent) => void): Promise<void> {
    void this.#pump(onEvent);
  }

  /**
   * 切れたら挑み直す。**間隔は固定ではなく、失敗が続くほど倍々に伸びて
   * `retryMaxMs` で頭打ちになる**（`packages/core` の名簿側の再接続と同じ形）。
   *
   * **リセットの契機は「読み切れた（例外なく終わった）」時点である。** 「繋がった
   * 時点」（`#stream()` が応答を受け取った直後）にしなかったのは意図的で、
   * 開いた直後に毎回すぐ死ぬ相手を相手にしたとき、繋がった瞬間にリセットする
   * 形だと失敗のたびに基準へ戻ってしまい、指数バックオフが一度も進まない
   * （`packages/core` の `#open` はまさに「繋がった」時点でリセットしており、
   * ここではその弱さを引き継がない形を選んでいる）。読み切れた＝一度は健全に
   * 届いた、を基準にすることで、開いてすぐ壊れる相手にもバックオフが効く。
   *
   * ログは**初回と、待ち時間が変わったときだけ**書く（同じ行を毎回吐かない）。
   * 加えて、**繋ぎ直せたときに1行書く** — 沈黙だけでは「直った」のか「諦めた」
   * のか読めないので、諦めていないことを見えるようにする。
   */
  async #pump(onEvent: (event: RunnerEvent) => void): Promise<void> {
    while (!this.#closed) {
      let failed = false;
      let failure: unknown;
      try {
        await this.#stream(onEvent);
      } catch (error) {
        if (this.#closed) return;
        failed = true;
        failure = error;
      }
      if (this.#closed) return;

      if (!failed && this.#backingOff) {
        process.stderr.write(`alteroidd: runner のストリームに繋ぎ直せた\n`);
        this.#backingOff = false;
      }

      const waitMs = failed ? this.#nextDelayMs : this.#retryBaseMs;

      if (failed) {
        this.#backingOff = true;
        if (this.#lastLoggedDelayMs !== waitMs) {
          process.stderr.write(
            `alteroidd: runner のストリームが切れました: ${String(failure)}（次は${waitMs}ms後に再試行）\n`,
          );
          this.#lastLoggedDelayMs = waitMs;
        }
      } else {
        this.#lastLoggedDelayMs = null;
      }

      // 次に使う値を決める。失敗なら倍々に伸ばして頭打ち、成功なら基準へ戻す。
      this.#nextDelayMs = failed ? Math.min(waitMs * 2, this.#retryMaxMs) : this.#retryBaseMs;

      await this.#sleepFn(waitMs);
    }
  }

  async #stream(onEvent: (event: RunnerEvent) => void): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;
    const response = await this.#fetch(`${this.#baseUrl}/events`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${this.#token}` },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new Error(`runner の /events に繋げない (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // SSE のフレームは空行区切り。`data:` 行だけを拾う。
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data.length > 0) {
          try {
            const parsed = runnerEventSchema.safeParse(JSON.parse(data));
            if (parsed.success) onEvent(parsed.data);
          } catch {
            // 壊れた1フレームでストリームごと落とさない
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  }

  /**
   * マネージャーを起こす。**この1つだけ期限を付けていない。**
   *
   * 付けると、期限切れ（＝不明）が呼ぶ側で**確定的な失敗**に化ける。
   * `packages/core/src/manager.ts` の `Pool.start` は `runner.start()` が投げたら
   * `#records.delete(managerId)` して投げ直す実装で、`#persist` はその後にあるから
   * 台帳にも1行も残らない。`Pool.list()` は `#records` と台帳しか見ない（runner へは
   * 訊かない）ので、**runner 側で走り出していても `manager_list` から消える** —
   * 止める手も残らない。「黙って失われる」であり、無期限に待つより悪い。
   *
   * 直すには呼ぶ側（`packages/core`）が「不明」を運べる必要がある。ここに期限だけを
   * 先に足すと、その日まで消える委譲が出る。**だから待つ方を選んでいる。**
   */
  async start(command: RunnerStartCommand): Promise<void> {
    await this.#callWithoutDeadline('POST', '/managers', command);
  }

  async resume(command: RunnerResumeCommand): Promise<void> {
    await this.#call('POST', `/managers/${encodeURIComponent(command.managerId)}/resume`, command);
  }

  async send(managerId: string, text: string): Promise<void> {
    await this.#call('POST', `/managers/${encodeURIComponent(managerId)}/messages`, { text });
  }

  async answer(managerId: string, answer: RunnerAnswerCommand): Promise<boolean> {
    const response = await this.#call(
      'POST',
      `/managers/${encodeURIComponent(managerId)}/answers`,
      answer,
    );
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  }

  async stop(managerId: string): Promise<void> {
    await this.#call('DELETE', `/managers/${encodeURIComponent(managerId)}`);
  }

  async list(): Promise<RunnerManagerState[]> {
    const response = await this.#call('GET', '/managers');
    const body = (await response.json()) as { managers?: unknown };
    if (!Array.isArray(body.managers)) return [];
    return body.managers.flatMap((entry) => {
      const parsed = runnerManagerStateSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async credentials(): Promise<RunnerCredentialFingerprint[]> {
    const response = await this.#call('GET', '/health');
    const body = (await response.json()) as HealthBody;
    return fingerprintsOf(body.credentials);
  }

  /**
   * 鍵を差し替える。**器は作り直さない。**
   *
   * 走行中のマネージャーにも、器（ファイル）越しに次の `git` / `gh` 呼び出しから
   * 届く。ここが無いと鍵の更新に再デプロイが要り、そのたびに走っている仕事が死ぬ。
   */
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
    const parsed = runnerProfileFingerprintSchema.safeParse(body.profile);
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * 実行環境プロファイルを差し替える。**器は作り直さない。**
   *
   * これから起こす仕事には即座に効く。走行中の仕事へ届くのは `gh` シムが
   * ファイルを読み直す経路だけである（`profile.ts`）。runner はこれを自分で
   * 取りに行けない（記憶ストアの鍵を持たないため）ので、**繋ぎ直しのたびに
   * 降ろし直すのはデーモンの責任**である。
   */
  async setProfile(script: string): Promise<RunnerProfileResult> {
    const response = await this.#call('POST', '/profile', { script });
    const parsed = runnerProfileResultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { ok: false, error: 'runner の応答を読めなかった' };
  }

  /**
   * 走行中セッションの生ログ。**取れなければ `null`**（呼ぶ側は退避済みへ降りる）。
   *
   * 期限切れもここでは `null` になる。**`null` は「無い」ではなく「取れなかった」**で、
   * それはこの口が前からそう答えている（404 も接続断も `null` である）。期限切れが
   * 潰れないよう、不明そのものは `onUnknown` から日誌へ出る。
   */
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

  /**
   * ストリームを閉じるだけ。**runner のマネージャーは止めない。**
   * デーモンの都合（再起動・更新）で、走っている人の仕事を殺さない。
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#controller?.abort();
    this.#controller = null;
  }

  /**
   * 期限付きで叩く。**この経路を通る限り、応答を無期限に待つことは無い。**
   *
   * 期限が切れたら {@link RunnerUnknownError} を投げる。**投げるのは「返らなかった」
   * であって「失敗した」ではない** — `RunnerHttpError` の系列にわざと乗せていない
   * （あちらは status を持つ＝相手が答えた証拠である）。
   *
   * **相手は止めない。** ここで `AbortController` を作らないのは意図で、期限は
   * 待つのをやめるためだけにある（`deadline.ts`）。だから投げた要求はそのまま走り、
   * 遅れて返ってきたら `late` として報告する（本文は読み捨てて繋ぎを畳む）。
   *
   * **諦める回数の上限は持たない。** ここが決めるのは「いつ不明と言うか」だけで、
   * 挑み直すかどうかは呼ぶ側（名簿・クローン）が決める。
   */
  async #call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const waitedMs = this.#deadlineMs;
    const settled = await settleWithinDeadline(
      this.#callWithoutDeadline(method, path, body, signal),
      waitedMs,
      (late) => {
        // 遅れて返ってきた本文は読み捨てる（読まずに放ると繋ぎが積み上がる）。
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

  /**
   * 期限を付けずに叩く。**呼んでよいのは `start()` だけである**（その理由は
   * `start()` の doc）。増やすときは「期限切れが呼ぶ側で何に化けるか」を先に見る。
   */
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
      // 名簿の probe 期限で中断されたら、繋ぎもそこで畳む（返らない繋ぎを残さない）。
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new RunnerHttpError(
        `runner ${method} ${path} が失敗した (${response.status}) ${detail}`,
        response.status,
      );
    }
    return response;
  }
}

/** node:http で Unix ソケットへ投げ、`fetch` と同じ形の応答に均す。 */
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
        // 本文はそのまま流す（SSE は開いたまま読み続ける）
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
