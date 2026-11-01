import type { CredentialService } from './credential-service.js';
import type { DelegatedPermissionRuleService } from './delegated-permission-rules.js';
import { reasonOf } from './dropped-record.js';
import { EXCHANGE_KIND_FAILURE_PREFIX, EXCHANGE_KIND_THINNING_PREFIX } from './exchange-kind.js';
import { JournalFoldWindow, foldedRunText } from './journal-fold.js';
import type { CodexAuthRunnerSync } from './manager.js';
import type { McpServerService } from './mcp-server-service.js';
import type { PluginDistributionService } from './plugin-distribution-service.js';
import type { ProfileService } from './profile-service.js';
import type { RunnerClient, RunnerRegistry } from './runner-protocol.js';
import type { JournalEntryInput } from './schema.js';

/** プロセス内の記憶で、デーモンを作り直せば消える（押し込みは繋ぎ直しのたびにやり直す）。 */
export interface RunnerPushOutcome {
  status: 'ok' | 'failed';
  at: string;
  /** 失敗の理由（原文。言い換えない）。 */
  error?: string;
}

/**
 * 3つの押し込みは互いに独立して落ちる（`PushLedger#specs` の doc）ので1つの状態へ畳まない:
 * 「どれが原因か」が見えなくなる。まだ試みていない欄は省き、`undefined` を「成功した」の
 * 既定値で埋めない（取れない軸に0の行を作らない）。
 */
export interface RunnerPushHealth {
  profile?: RunnerPushOutcome;
  credentials?: RunnerPushOutcome;
  agentToken?: RunnerPushOutcome;
  mcpServers?: RunnerPushOutcome;
  plugins?: RunnerPushOutcome;
  /** 委譲先の許可規則（#4952）。 */
  permissionRules?: RunnerPushOutcome;
}

/** `PushLedger#pushSetting` が見る、置く種類1つぶんの違い（#5871）。`PushLedger#specs` が表にする。 */
interface PushSpec {
  readonly kind: keyof RunnerPushHealth;
  /** `undefined` はその口を配線していない種類で、何もしない。返すのは「runner が断った」とき（投げずに失敗を報せる口）の理由と日誌の本文で、受け入れられたら `undefined`。 */
  readonly sync: ((runner: RunnerClient) => Promise<PushRefusal | undefined>) | undefined;
  /** 呼びが投げたときの日誌の本文。 */
  readonly thrown: (runnerId: string, reason: string) => string;
}

/** 結果を読まない種類（呼んで待つだけ。断りは投げて知らせる）の `sync`。`undefined` はその口を配線していない種類。 */
function viaSync(
  service: { syncRunner(runner: RunnerClient): Promise<unknown> } | undefined,
): PushSpec['sync'] {
  return service === undefined
    ? undefined
    : async (runner) => {
        await service.syncRunner(runner);
        return undefined;
      };
}

interface PushRefusal {
  /** 帳面（`RunnerPushOutcome.error`）へ書く理由。 */
  readonly error: string;
  /** 日誌の本文（接頭辞は `journalFailure` が付ける）。 */
  readonly body: string;
}

/** **能力の上限ではなく、混雑を作らないための間隔である。** 繋がったままの runner へ繋ぎ直しを待たずに挑み直す梯子。 */
const PUSH_RETRY_BASE_MS = 2_000;
const PUSH_RETRY_MAX_MS = 60_000;

/**
 * 既定の `JOURNAL_FOLD_IDLE_GAP_MS`（60秒）は使えない: 挑み直しは `PUSH_RETRY_MAX_MS`（60秒）で頭打ちなので、
 * 定常の空きが60秒を少し超え、毎回「途切れた」と判定されて何も畳まれない。
 */
export const PUSH_FAILURE_FOLD_IDLE_GAP_MS = PUSH_RETRY_MAX_MS * 2;

/** 既定（5分）だと60秒間隔の反復は5件ごとに要約が出て、行数が 1/5 にしかならない。 */
const PUSH_FAILURE_FOLD_MAX_SPAN_MS = 30 * 60_000;

/** 押し込む相手の設定の送り口。無いものは何もしない種類になる。 */
export interface PushLedgerServices {
  profile: ProfileService | undefined;
  credentials: CredentialService | undefined;
  mcpServers: McpServerService | undefined;
  plugins: PluginDistributionService | undefined;
  permissionRules: DelegatedPermissionRuleService | undefined;
  codexAuth: CodexAuthRunnerSync | undefined;
  syncRunnerToken: ((runner: RunnerClient) => Promise<void>) | undefined;
}

export interface PushLedgerDeps {
  readonly services: PushLedgerServices;
  readonly runners: RunnerRegistry;
  /** `Pool` の `#journal` そのもの（日誌が落ちても投げない口）。async の皮で包まない。 */
  readonly journal: (entry: JournalEntryInput) => Promise<void>;
  readonly now: () => number;
  /** デーモンの停止の旗を読む。 */
  readonly stopped: () => boolean;
  /** 繋ぎ直し中か接続中の押し込み（あれば挑み直しはそれを待つ）。 */
  readonly pendingPush: (runnerId: string, runner: RunnerClient) => Promise<void> | undefined;
}

type DirectPushKind = keyof RunnerPushHealth;

/**
 * runner へ押し込んだ設定の成否の帳面と、失敗した種類の挑み直し。`Pool` が1つ持つ。
 * 帳面（`#health`）の持ち主はここだけで、外は `healthOf` / `knownRunnerIds` で読む。
 */
export class PushLedger {
  readonly #deps: PushLedgerDeps;
  readonly #health = new Map<string, RunnerPushHealth>();
  /** `Pool` の繋ぎ直しの待ち（`hello` を待つ）とは別: こちらは繋がったままの runner へ自分から挑み直す。 */
  readonly #retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #retryDelays = new Map<string, number>();
  readonly #failureFolds = new Map<string, JournalFoldWindow>();

  constructor(deps: PushLedgerDeps) {
    this.#deps = deps;
  }

  healthOf(runnerId: string): RunnerPushHealth | undefined {
    return this.#health.get(runnerId);
  }

  /** 帳面に載っている runner（名指せなかった失敗の宛先に使う）。 */
  knownRunnerIds(): string[] {
    return [...this.#health.keys()];
  }

  /**
   * `connectTo`（繋いだとき）と `reattach`（繋ぎ直したとき）が共有する、置く並びの全部。表の並び（鍵が先）→ codex 認証 → 認証トークン。
   * 1つ失敗しても残りは置く（`pushSetting` は投げない）。
   * codex 認証の失敗は相手の側が日誌に残す。
   * 認証トークンを降ろし忘れない: 器が入れ替わっていれば置いた鍵も消えており、器の環境変数（＝回す前のトークン）のまま走るのに、その食い違いは「マネージャーの側からは見えない」。「実害が出にくい」を「要らない」と読まない。
   */
  async pushEnvironmentTo(runner: RunnerClient): Promise<void> {
    const specs = this.#specs();
    for (const spec of specs.ordered) await this.#pushSetting(spec, runner);
    await this.#deps.services.codexAuth?.syncRunner(runner).catch(() => undefined);
    await this.#pushSetting(specs.agentToken, runner);
  }

  // 日誌の行はここでは書かない: 即時の配布の失敗を日誌へ残すのは呼び出し元（`app.ts` / `tools.ts`）で、ここでも書くと二重になる。
  recordDirectPushResults(
    kind: DirectPushKind,
    results: readonly { runnerId: string; ok: boolean; error?: string }[],
  ): void {
    if (this.#deps.stopped()) return;
    const at = this.#nowIso();
    for (const result of results) {
      this.#notePushOutcome(
        result.runnerId,
        kind,
        result.ok
          ? { status: 'ok', at }
          : { status: 'failed', at, error: result.error ?? '理由不明' },
      );
      this.settleRetry(result.runnerId);
    }
  }

  settleRetry(runnerId: string): void {
    const health = this.#health.get(runnerId);
    const stillFailing =
      health !== undefined && Object.values(health).some((outcome) => outcome?.status === 'failed');
    if (!stillFailing) {
      this.#retryDelays.delete(runnerId);
      return;
    }
    this.#scheduleRetry(runnerId);
  }

  /** 日誌の畳みの吐き出しと挑み直しの予約の取り消し（`Pool#stop` が停止の旗を立てた後に呼ぶ）。 */
  stop(): void {
    this.#flushFailureFolds();
    for (const timer of this.#retryTimers.values()) clearTimeout(timer);
    this.#retryTimers.clear();
    this.#retryDelays.clear();
  }

  #nowIso(): string {
    return new Date(this.#deps.now()).toISOString();
  }

  /**
   * runner へ置く設定の表（#5871）。置く種類ごとの違い（呼ぶ口・失敗の文言）だけをここに持ち、成否の記録・日誌・続け方は `pushSetting` の1本が受け持つ。
   * 並びは `pushEnvironmentTo` が使う順そのもの: 鍵を先に降ろす（#4841）。runner はプロファイルを受け取った時点の env（鍵を含む）で評価して固めるので、後に降ろすと `"$GH_TOKEN"` や gh を叩く行が鍵の無い env で評価されたまま残る。
   * 種類ごとに別の呼びにする: 片方が落ちても片方は降りるべき（プロファイルの評価が落ちた器へ、無関係な鍵まで降りないことを避ける）。
   * 日誌には値・本文を書かない: 失敗の理由は runner の文言をそのまま運ぶが、各 `parse*` が値を載せない形で作っている（files の中身・規則の command の全文・MCP の値）。
   * `sync` が無い（その口を配線していない）種類は何もしない。
   */
  #specs(): { readonly ordered: readonly PushSpec[]; readonly agentToken: PushSpec } {
    const { profile, credentials, mcpServers, plugins, permissionRules, syncRunnerToken } =
      this.#deps.services;
    return {
      ordered: [
        {
          kind: 'credentials',
          // runner が自分で取りに行く形にしない: 取りに行けるなら runner に記憶ストアの鍵があることになる（AGENTS.md「runner に記憶ストアの鍵を足さないこと」）。
          // プロファイルと別の呼びにする: 1つにまとめると、プロファイルの評価が落ちた器へは無関係な鍵まで降りない。
          sync: viaSync(credentials),
          thrown: (runnerId, reason) =>
            `${runnerId} へマネージャーの環境変数を降ろせなかった（この runner で起こすマネージャーは、器の環境変数に在るものだけで走る）: ${reason}`,
        },
        {
          kind: 'profile',
          // 失敗しても委譲は止めないが、降りていないことは日誌に残す: 黙って古い環境で走ると「鍵が届いていない」のか「権限が足りない」のかを切り分けられない。
          sync:
            profile === undefined
              ? undefined
              : async (runner) => {
                  // 更新と同じ列に入れる: 直に読んで直に書くと、更新の最中に古い本文で上書きしうる。
                  const result = await profile.syncRunner(runner);
                  if (result === null || result.ok) return undefined;
                  // `result.output` は日誌へ書かず長さだけを書く: 生の stderr にはシェルが返した行や echo から鍵の値そのものが乗りうり、日誌は永続でクローンも人間も後から読む。
                  const outputChars = result.output?.length ?? 0;
                  return {
                    error: result.error ?? '理由不明',
                    body:
                      `${runner.runnerId} に実行環境プロファイルを置けなかった（前のものが残っている）: ` +
                      `${result.error ?? '理由不明'}` +
                      (outputChars === 0
                        ? ''
                        : `（プロファイルの出力 ${outputChars} 文字は記録しない——鍵の値が入りうる。` +
                          '出力は profile_write / PUT /profile/:name で書き直したときの応答で読める）'),
                  };
                },
          thrown: (runnerId, reason) =>
            `${runnerId} へ実行環境プロファイルを降ろせなかった: ${reason}`,
        },
        {
          kind: 'mcpServers',
          sync: viaSync(mcpServers),
          thrown: (runnerId, reason) =>
            `${runnerId} へ MCP サーバの登録を降ろせなかった（この runner で起こすマネージャー・作業者は、記憶ストアの登録を持たずに走る）: ${reason}`,
        },
        {
          kind: 'plugins',
          sync: viaSync(plugins),
          thrown: (runnerId, reason) =>
            `${runnerId} へ plugin を降ろせなかった（この runner で起こすマネージャー・作業者は、記憶ストアの plugin を持たずに走る）: ${reason}`,
        },
        {
          kind: 'permissionRules',
          // 委譲先の許可規則（#4952）。
          sync: viaSync(permissionRules),
          thrown: (runnerId, reason) =>
            `${runnerId} へ委譲先の許可規則を降ろせなかった（この runner で起こすマネージャー・作業者には、人間が承認した許可が規則として載っていない。前に降りた一覧が残っていればそれが効いている）: ${reason}`,
        },
      ],
      // 失敗しても委譲は止めない。ただし黙って古いトークンで走らせない: 跡を残す。
      agentToken: {
        kind: 'agentToken',
        sync: viaSync(syncRunnerToken && { syncRunner: syncRunnerToken }),
        thrown: (runnerId, reason) =>
          `${runnerId} に認証トークンを降ろせなかった（この runner で起こすマネージャーは、器の環境変数に認証トークンが入っていればそれで走り、入っていなければ資格を1つも持たずに走る——どちらになるかは器の env 次第で、ここからは分からない）: ${reason}`,
      },
    };
  }

  /**
   * 投げ直さない: 委譲経路を日誌の失敗で止めず、応答を受け取って判断し直す相手がここには居ない（tools.ts の `appendJournalOrThrow` とは非対称）。
   * `this.#journalFailure` を経由し、直に日誌の store へ append しない: 日誌 append の失敗を配布の失敗として書いてしまううえ、append 自体が落ちると跡が残らない（`Pool#journal` は `self_dropped` へ残す）。
   */
  async #pushSetting(spec: PushSpec, runner: RunnerClient): Promise<void> {
    if (this.#deps.stopped() || spec.sync === undefined) return;
    const runnerId = runner.runnerId;
    try {
      const refusal = await spec.sync(runner);
      if (refusal === undefined) {
        this.#notePushOutcome(runnerId, spec.kind, { status: 'ok', at: this.#nowIso() });
        return;
      }
      this.#notePushOutcome(runnerId, spec.kind, {
        status: 'failed',
        at: this.#nowIso(),
        error: refusal.error,
      });
      await this.#journalFailure(runnerId, spec.kind, refusal.body);
    } catch (error) {
      this.#notePushOutcome(runnerId, spec.kind, {
        status: 'failed',
        at: this.#nowIso(),
        error: reasonOf(error),
      });
      await this.#journalFailure(runnerId, spec.kind, spec.thrown(runnerId, reasonOf(error)));
    }
  }

  /** 種類を名指しで置き直す（失敗した種類だけを挑み直す `retryFailedPushes` が使う）。 */
  async #pushKind(kind: keyof RunnerPushHealth, runner: RunnerClient): Promise<void> {
    const specs = this.#specs();
    const spec = [...specs.ordered, specs.agentToken].find((candidate) => candidate.kind === kind);
    if (spec !== undefined) await this.#pushSetting(spec, runner);
  }

  // 同じ本文が続くあいだは2件目以降を畳む: 直らない障害では挑み直しのたびに同じ行が毎分積まれるため。
  // 畳むのは日誌の1行だけ。帳面（`#health`）・挑み直し・クローンへの通知は畳まない。
  async #journalFailure(
    runnerId: string,
    kind: keyof RunnerPushHealth,
    body: string,
  ): Promise<void> {
    // 接頭辞は書く箇所の字面に置く（`exchange-kind-coverage.test.ts` の静的検査が読む）。
    const text = `${EXCHANGE_KIND_FAILURE_PREFIX}${body}`;
    const key = `${runnerId}\u0000${kind}`;
    let fold = this.#failureFolds.get(key);
    if (fold === undefined) {
      fold = new JournalFoldWindow({
        idleGapMs: PUSH_FAILURE_FOLD_IDLE_GAP_MS,
        maxSpanMs: PUSH_FAILURE_FOLD_MAX_SPAN_MS,
      });
      this.#failureFolds.set(key, fold);
    }
    const folded = fold.observe(text, text, this.#deps.now());
    if (folded.flush !== undefined) {
      await this.#deps.journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(folded.flush)}`,
      });
    }
    if (folded.write) {
      await this.#deps.journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_FAILURE_PREFIX}${body}`,
      });
    }
  }

  #flushFailureFold(runnerId: string, kind: keyof RunnerPushHealth): void {
    const key = `${runnerId}\u0000${kind}`;
    const fold = this.#failureFolds.get(key);
    if (fold === undefined) return;
    this.#failureFolds.delete(key);
    const flushed = fold.flush();
    if (flushed === undefined) return;
    void this.#deps.journal({
      type: 'exchange',
      with: 'self',
      role: 'outbound',
      text: `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(flushed)}`,
    });
  }

  #flushFailureFolds(): void {
    for (const fold of this.#failureFolds.values()) {
      const flushed = fold.flush();
      if (flushed === undefined) continue;
      void this.#deps.journal({
        type: 'exchange',
        with: 'self',
        role: 'outbound',
        text: `${EXCHANGE_KIND_THINNING_PREFIX}${foldedRunText(flushed)}`,
      });
    }
    this.#failureFolds.clear();
  }

  // `runnerId` が無い runner には書かない: 名乗る前の runner は `RunnerOverview` にも `runnerId` 無しの行で出るので紐づけようがない。
  #notePushOutcome(
    runnerId: string | undefined,
    kind: keyof RunnerPushHealth,
    outcome: RunnerPushOutcome,
  ): void {
    if (runnerId === undefined) return;
    if (outcome.status === 'ok') this.#flushFailureFold(runnerId, kind);
    const health = this.#health.get(runnerId) ?? {};
    health[kind] = outcome;
    this.#health.set(runnerId, health);
  }

  // 間隔は伸ばすが、挑み直しを諦めない（north_star 禁止2）。
  #scheduleRetry(runnerId: string): void {
    if (this.#deps.stopped()) return;
    if (this.#retryTimers.has(runnerId)) return;
    const delay = this.#retryDelays.get(runnerId) ?? PUSH_RETRY_BASE_MS;
    this.#retryDelays.set(runnerId, Math.min(delay * 2, PUSH_RETRY_MAX_MS));
    const timer = setTimeout(() => {
      this.#retryTimers.delete(runnerId);
      if (!this.#deps.stopped()) void this.#retryFailedPushes(runnerId);
    }, delay);
    timer.unref?.();
    this.#retryTimers.set(runnerId, timer);
  }

  // 直っている種類は撒き直さない: 種類ごとに独立して落ちる。
  // 繋ぎ直し中の押し込みがあれば待つ: 二重に撒くと日誌が無駄に二重の跡を残す。
  async #retryFailedPushes(runnerId: string): Promise<void> {
    if (this.#deps.stopped()) return;
    const health = this.#health.get(runnerId);
    if (health === undefined) return;

    // 名簿を引けなかったのは一時障害だが、居ないと答えられたのは別（`Pool#reattach` と同じ区別）: 居ない runner は戻ってこないので諦め、一時障害は予約し直す。
    let lookupFailed = false;
    const runner = await this.#deps.runners.get(runnerId).catch(() => {
      lookupFailed = true;
      return null;
    });
    if (runner === null) {
      if (lookupFailed) this.settleRetry(runnerId);
      return;
    }

    const inFlight = this.#deps.pendingPush(runnerId, runner);
    if (inFlight !== undefined) await inFlight.catch(() => undefined);
    if (this.#deps.stopped()) return;

    // 並びは繋いだときと別（既存の順を保つ）。
    for (const kind of [
      'profile',
      'credentials',
      'agentToken',
      'mcpServers',
      'plugins',
      'permissionRules',
    ] as const) {
      if (health[kind]?.status === 'failed') await this.#pushKind(kind, runner);
    }
    this.settleRetry(runnerId);
  }
}
