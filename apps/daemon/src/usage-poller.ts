import { fetchAccountUsage, type AccountUsageState, type UsageProbeQuery } from '@alteroid/core';

/**
 * アカウント全体の利用状況を定期的に取り直す。
 *
 * **なぜポーリングが要るのか。** `rate_limit_event` は**ターンを回している間しか
 * 届かない**（実測。idle なセッションには来ない）。だからマネージャーが1本も
 * 走っていない間、走らせる前に「いま投げてよいか」を判断する材料が無くなる。
 * それが必要な瞬間はまさに「これから重い仕事を投げるとき」なので、そこが空白に
 * なるのは困る。
 *
 * **1回あたりのコストはサブプロセス1本で、推論は走らない**（プロンプトを送らない。
 * 実測 300〜400ms・トークン消費ゼロ）。それでもプロセスではあるので、間隔は分単位に
 * してある — 枠は5時間 / 7日単位なので、秒を追いかける意味がない。
 */
export const USAGE_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * 取れないと分かってからも試し続ける間隔。
 *
 * **諦めて止めない。** codiva は「取れない」と分かったらポーリングを恒久停止して
 * いるが、alteroid では**それが嘘になる**。鍵は走行中に回せる設計
 * （`credentials.ts` / `POST /runners/credentials`）なので、「まだログインして
 * いない」は通常の状態であり、後から鍵が届いたら取れるようになる。恒久停止すると
 * その後ずっと「取れない」と表示し続ける。
 *
 * ただし毎回同じ間隔で叩くのも無駄なので、間隔だけ長くする。
 *
 * **⚠️ 使うのは「取れないと _分かった_」回だけである**（#681 の後始末）。
 * 理由が**言い分けられない**回（`cause: 'undetermined'`）にこれを当てると、
 * **「判定できない」を「取れない」へ倒したことになる** —— それは #681 が直した
 * 誤りを、時間の軸でもう一度作ることである（下の {@link intervalForState}）。
 */
export const USAGE_POLL_UNAVAILABLE_INTERVAL_MS = 30 * 60_000;

/**
 * 次に聞くまでの間隔を、**状態と理由から**決める（#681 の後始末）。
 *
 * ## 直す前は何が起きていたか
 *
 * `state === 'unavailable'` の器はすべて 30 分間隔だった。**そして本番はまさに
 * その器である**（#681 の実測。`cause: 'undetermined'`）⟹ **probe の周期は
 * 5分ではなく30分だった。**
 *
 * これは `.claude/skills/token-pool/SKILL.md` と `token-watch.ts` の doc が
 * 「復帰の下限は probe の周期（5分）」と書いていたものと食い違う ——
 * **判定が来ないこととは別に、聞く間隔そのものも違っていた**（#684 のレビューで
 * 気づいた範囲外の事実）。
 *
 * ## 分ける線は「取れないと分かったか」である
 *
 * | 状態 / 理由 | 間隔 | なぜ |
 * | --- | --- | --- |
 * | `ok` / `unknown` / `failed` | 通常（5分） | 取れている、または取れなかっただけ |
 * | `unavailable` + `not_logged_in` | **長い**（30分） | 鍵が届くまで答えは変わらない |
 * | `unavailable` + `non_first_party` | **長い**（30分） | このバックエンドでは原理的に取れない |
 * | `unavailable` + `undetermined` | **通常（5分）** | **取れないと分かっていない** |
 * | `unavailable` + 欄が無い | **通常（5分）** | 断定できない側へ倒す（下） |
 *
 * ## なぜ `undetermined` を通常の間隔へ倒すのか
 *
 * **「取れない」と断定できていないからである。** `undetermined` は「4つの原因の
 * うち3つは消えたが、残った1つ（profile スコープの不足）だと確かめてはいない」
 * という状態で（`usage-snapshot.ts` の `LimitsUnavailableCause`）、**鍵を取り直せば
 * 取れるようになりうる。** 鍵は走行中に回せる設計なので、それは*この器で普通に
 * 起こる*ことである ⟹ 長い間隔を当てると、**取れるようになった瞬間を平均15分
 * 見落とす。**
 *
 * **費用は「健全な器と同じ」までしか増えない。** probe は推論を1つも走らせない
 * サブプロセス1本で（実測 300〜400ms）、`ok` の器は元から5分ごとに叩いている。
 *
 * **⚠️ 3つ目の間隔を作らないこと。** 「`undetermined` は中間だから15分」は
 * **誰も正当化できない数**である（`AGENTS.md`「値が同じでも使い回さない」の裏面
 * ——**根拠の無い新しい数を作らない**）。線は「取れないと分かったか」の2値で足りる。
 *
 * ## 欄が無い回も通常の間隔へ倒す
 *
 * `cause` は optional である（`AccountUsageState` の doc: 版がずれる）。**無いのは
 * 「その版が言えなかった」であって「取れないと分かった」ではない** ⟹ 断定できない
 * 側、つまり聞き続ける側へ倒す。**同じプロセスの中で作る限り必ず付く**ので、
 * ここへ落ちるのは版が食い違ったときだけである。
 */
export function intervalForState(
  state: AccountUsageState,
  intervals: { normal: number; unavailable: number },
): number {
  if (state.state !== 'unavailable') return intervals.normal;
  // **数え上げで書く**（`switch` ではなく明示の2値）。`LimitsUnavailableCause` に
  // 値が増えたとき、**既定で「聞き続ける」側へ落ちる** —— 増えた値がどちらの意味
  // なのかは、足した人が決めてここへ書くべきものである。**黙って諦める側へ倒す
  // 形にしないこと**（それが #681 の誤りの形そのものである）。
  if (state.cause === 'not_logged_in' || state.cause === 'non_first_party') {
    return intervals.unavailable;
  }
  return intervals.normal;
}

export interface UsagePollerOptions {
  queryFn: UsageProbeQuery;
  /** probe を立てる作業ディレクトリ。 */
  cwd: string;
  /** 主にテスト用。 */
  intervalMs?: number;
  unavailableIntervalMs?: number;
  /** 外から畳む（デーモンの終了時）。 */
  signal?: AbortSignal;
  /**
   * probe のサブプロセスへ渡さない環境変数（#431）。
   *
   * **`storage.withheldEnvKeys`（記憶ストアへ到達する鍵）をそのまま渡すこと。**
   * ここを省略すると `fetchAccountUsage` は `env` を組み立てず、SDK の既定
   * （`Options.env` 省略時は `process.env` をそのまま子へ継承）が働く ——
   * つまり `usage-probe.ts` の `withheldEnvKeys` の doc が指す「一番広く
   * process.env を晒す」経路になる。
   */
  withheldEnvKeys?: readonly string[];
  /**
   * **probe の子プロセスへ重ねる env**（人間の決定 2026-09-07）。
   *
   * ## なぜ要るか —— 回した後、ここは別のアカウントを測っていた
   *
   * これが無かったあいだ、`fetchAccountUsage` は `env` を渡さないので子プロセスは
   * `process.env` をそのまま継承した ⟹ **測っていたのは常に「器の環境変数の
   * トークン」のアカウントで、回した後の現役ではない。** 回した先が別アカウント
   * なら、`GET /usage` の `account` とクローンが見る `accountUsage` は
   * **降りたトークンの枠を報告し続ける。**
   *
   * ⟹ `apps/daemon/src/index.ts` は {@link AgentTokenHolder} の `values()` を
   * ここへ渡す。**呼ばれるたびに読み直される**（構築時に凍らせない。回すのは
   * 走行中である）。**空を返せば1文字も変わらない** —— 既定の構成では
   * `values()` が空を返すので、器の環境変数がそのまま効く（受け入れ基準7）。
   */
  env?: () => NodeJS.ProcessEnv;
  /**
   * **1回ぶんの観測が終わるたびに呼ぶ**（人間の決定 2026-09-07）。
   *
   * ## なぜ要るか —— セッションが1本も走っていなくても届く唯一の観測である
   *
   * 認証トークンを回す契機（`packages/core/src/token-rotator.ts` の `observe`）は
   * **6つとも「セッションが回っているあいだ」に届く観測**である。⟹ 全層が枠で
   * 止まった状態は、**観測を上げる主体が1つも居ない状態**でもある。
   *
   * ここは違う —— **推論を1つも走らせない probe** なので、全層が止まっていても
   * 5分ごとに現役の枠を読める。⟹ その結果を回し手へ渡せば、
   * **「動く鍵がプールに残っているのに、誰も気づかないまま止まり続ける」が
   * 塞がる。**
   *
   * **判断はしない。** 状態をそのまま渡すだけで、`usable` / `unusable` /
   * `undecidable` の判定は `judgeTokenCandidate`（core）が持つ。
   *
   * **投げても・遅くてもポーリングを止めない**（下の実装が `void` で切り離す）。
   */
  onState?: (state: AccountUsageState) => void;
}

export interface UsagePoller {
  /** いま分かっていること。**「まだ取っていない」も状態として返る。** */
  state(): AccountUsageState;
  /** いま取り直す（`GET /usage` が呼ばれたときに古すぎるなら使う）。 */
  refresh(): Promise<AccountUsageState>;
  stop(): void;
}

export function startUsagePolling(options: UsagePollerOptions): UsagePoller {
  const interval = options.intervalMs ?? USAGE_POLL_INTERVAL_MS;
  const unavailableInterval = options.unavailableIntervalMs ?? USAGE_POLL_UNAVAILABLE_INTERVAL_MS;

  let current: AccountUsageState = { state: 'unknown' };
  let inFlight: Promise<AccountUsageState> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  options.signal?.addEventListener('abort', stop, { once: true });

  const refresh = async (): Promise<AccountUsageState> => {
    // 重ねない。遅い probe でサブプロセスが積み上がるのを防ぐ。
    if (inFlight !== null) return inFlight;
    // **現役の env は呼ばれるたびに読み直す**（`UsagePollerOptions.env` の doc）。
    // 空なら渡さない —— 空の `env` を渡すと `fetchAccountUsage` が `env` を
    // 組み立ててしまい、既定の構成の挙動が変わりうる。
    const env = options.env?.();
    inFlight = fetchAccountUsage(options.queryFn, {
      cwd: options.cwd,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
      ...(options.withheldEnvKeys === undefined
        ? {}
        : { withheldEnvKeys: options.withheldEnvKeys }),
    })
      .then((next) => {
        // **知らせるのは「この回に取れたもの」であって、覚えている値ではない。**
        // 下の `current` は「取れなかったことで取れていた値を捨てない」ために
        // 古い `ok` を保つので、そちらを渡すと**同じ観測を何度も新しい観測として
        // 渡す**ことになる（回し手はそれを毎回の probe 結果として扱う）。
        //
        // **切り離して呼ぶ。** ここで待つと、聞き手が遅いぶんだけ次の probe が
        // 遅れる（ポーリングの間隔が聞き手に依存する形になる）。
        if (options.onState !== undefined) {
          const notify = options.onState;
          const handoff = setTimeout(() => {
            // **投げてもポーリングを止めない。** ここは probe の後始末であって、
            // 聞き手の失敗はこの観測の失敗ではない。**黙らせない**（跡を残す）。
            try {
              notify(next);
            } catch (error) {
              process.stderr.write(
                `alteroidd: 枠の観測を見張りへ渡せませんでした: ${String(error)}\n`,
              );
            }
          }, 0);
          handoff.unref?.();
        }
        // **取れなかったことで、取れていた値を捨てない。** 一時的な失敗のたびに
        // 表示が消えると、人間もクローンも「使い切ったのか観測できないのか」を
        // 区別できない。ok を保ち続け、次に ok が来たら差し替える。
        if (next.state === 'ok' || current.state !== 'ok') current = next;
        return current;
      })
      .catch(() => current) // fetchAccountUsage は投げない契約だが、ここでも塞ぐ
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  /**
   * 次の間隔を決める。**判定は {@link intervalForState} 1箇所に閉じてある** ——
   * ここと起動直後の2箇所で同じ式を書いていたので、**片方だけ直す形が作れた**
   * （実際、`state === 'unavailable'` の判定は2箇所に重複していた）。
   */
  const nextInterval = (state: AccountUsageState) =>
    intervalForState(state, { normal: interval, unavailable: unavailableInterval });

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void refresh().then((state) => {
        // 取れないと**分かった**構成なら間隔だけ伸ばす（止めない — 鍵は後から
        // 届きうる）。**言い分けられない回は伸ばさない**（#681 の後始末）。
        schedule(nextInterval(state));
      });
    }, delay);
    // 観測が終了を引き止めないように。
    timer.unref?.();
  };

  // 起動直後に1回。**待たない** — デーモンの起動を probe の速さに縛らない。
  void refresh().then((state) => schedule(nextInterval(state)));

  return {
    state: () => current,
    refresh,
    stop,
  };
}
