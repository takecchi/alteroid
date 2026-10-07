import { reasonOf } from './dropped-record.js';
import {
  isPluginScopeForRunner,
  pluginsFingerprintOf,
  type PluginFingerprintEntry,
  type PluginSummary,
} from './plugins.js';
import {
  RunnerPluginsUnsupportedError,
  type RunnerClient,
  type RunnerPluginsFingerprint,
  type RunnerRegistry,
} from './runner-protocol.js';
import type { Stores } from './store.js';

/**
 * 記憶ストアの plugin を**runner へ配る**1本道（`mcp-server-service.ts` の写し）。
 *
 * 書き手が2人いる —— 入れ口の後の配布（`apply`）と、runner が名乗り直したときの降ろし直し
 * （`ManagerPool` の `#pushPlugins`）。後者が前者の最中に走ると、古い一覧を読んで新しい一覧を
 * 上書きする。だから両方をこの列に入れる。**インスタンスは1つだけ作って全経路へ渡すこと**。
 *
 * ## MCP の登録と違うところ
 *
 * - **配るのは scope が `all` / `runner` のものだけ。** `app` はクローン（daemon）側が持つので
 *   runner へは送らない。
 * - **1本ずつ送る。** 本体は最大 64MiB あり、全部を1本の本文にすると上限と往復の失敗が大きくなる。
 *   runner の指紋と比べ、差のある plugin だけを送り、最後に残す名前の一覧を送って余りを外させる。
 * - **runner は受けて検査してメモリに持つだけ**で、展開はしない（展開・セッションへの接続は後の段）。
 *
 * ## 中身を外へ出さない
 *
 * 返すのは名前と指紋だけ。files の中身は結果にも日誌にも載せない。
 */
export interface PluginDistributionService {
  /**
   * いま正本に在る plugin を、繋がっている全 runner へ配る。**保存はしない**（保存は入れ口の仕事で、
   * 保存した後に呼ぶ）。形が不正で投げた入れ口は、ここへ来ない。
   */
  apply(): Promise<ApplyPluginsResult>;
  /**
   * 1台の runner へ、正本に在る plugin を降ろし直す。**同じ版が載っていれば何もせず `null`。**
   * 口を持たない実装（偽物）へも `null`。**古い runner（口が 404）は
   * `RunnerPluginsUnsupportedError` を投げる。**
   */
  syncRunner(runner: RunnerClient): Promise<{ plugins?: RunnerPluginsFingerprint } | null>;
  /** `apply()` の即時の配布の結果を知らせる。返り値は購読を外す関数（`McpServerService.onPushed` と同じ）。 */
  onPushed?(listener: (results: readonly PluginsRunnerResult[]) => void): () => void;
}

export interface PluginDistributionServiceOptions {
  stores: Stores;
  /** 委譲先。無ければ `apply` は何も配らない。 */
  runners?: RunnerRegistry;
}

/** 1台の runner への配布結果。**名前と指紋だけ**（files の中身は載せない）。 */
export interface PluginsRunnerResult {
  runnerId: string;
  ok: boolean;
  /** 置いた後の指紋。何も持たない状態なら無い。 */
  plugins?: RunnerPluginsFingerprint;
  /** 相手が口を持たない古い runner だった。一時障害と混ぜない。 */
  unsupported?: true;
  error?: string;
}

export interface ApplyPluginsResult {
  /** 配る対象にした plugin の名前（昇順）。 */
  names: string[];
  /** 配る対象の一覧の指紋。空なら無い。runner が返す指紋と同じ関数で作る。 */
  sha256?: string;
  runners: PluginsRunnerResult[];
}

export function createPluginDistributionService(
  options: PluginDistributionServiceOptions,
): PluginDistributionService {
  const { stores, runners } = options;
  const pushListeners = new Set<(results: readonly PluginsRunnerResult[]) => void>();

  // 直列化の実体（`mcp-server-service.ts` の `serial` と同じ形）。
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** runner へ撒く対象（scope が `all` / `runner`）。files は引かない。 */
  async function wanted(): Promise<PluginSummary[]> {
    return (await stores.plugins.list()).filter((summary) => isPluginScopeForRunner(summary.scope));
  }

  function fingerprintOf(summaries: readonly PluginSummary[]): PluginFingerprintEntry[] {
    return summaries.map((s) => ({
      name: s.name,
      sha: s.source.sha,
      contentSha256: s.contentSha256,
    }));
  }

  async function syncOne(
    runner: RunnerClient,
  ): Promise<{ plugins?: RunnerPluginsFingerprint } | null> {
    if (runner.setPlugin === undefined || runner.retainPlugins === undefined) return null;
    const summaries = await wanted();

    // **指紋が読めなかったときは「差がある」に倒す**（全部送り直す）。同じ plugin を置き直すのは
    // 無害で、送り損ねると plugin が0本のまま走る。**「読めなかった」を「何も持っていない」に
    // 潰さない**ので、外したはずの plugin が runner に残り続けることも無い。
    let unreadable = false;
    let current: RunnerPluginsFingerprint | undefined;
    try {
      current = await runner.plugins?.();
    } catch {
      unreadable = true;
    }
    const have = new Map((current?.plugins ?? []).map((p) => [p.name, p]));
    const differing = summaries.filter((summary) => {
      const held = have.get(summary.name);
      return (
        unreadable ||
        held === undefined ||
        held.sha !== summary.source.sha ||
        held.contentSha256 !== summary.contentSha256
      );
    });
    const wantedNames = new Set(summaries.map((s) => s.name));
    const extra = [...have.keys()].some((name) => !wantedNames.has(name));
    if (!unreadable && differing.length === 0 && !extra) return null;

    const names: string[] = [];
    for (const summary of summaries) {
      if (!differing.includes(summary)) {
        names.push(summary.name);
        continue;
      }
      // 一覧を読んだ後に外された plugin は送らず、残す名前にも入れない。
      const stored = await stores.plugins.get(summary.name);
      if (stored === null || !isPluginScopeForRunner(stored.scope)) continue;
      await runner.setPlugin({
        name: stored.name,
        sourceSha: stored.source.sha,
        scope: stored.scope,
        enableHooks: stored.enableHooks,
        enableMcp: stored.enableMcp,
        contentSha256: stored.contentSha256,
        files: stored.files,
      });
      names.push(summary.name);
    }
    // 全部送れたときだけ余りを外す。途中で投げたらここへ来ない（前の状態が残り、挑み直しで揃う）。
    const placed = await runner.retainPlugins(names);
    return placed === undefined ? {} : { plugins: placed };
  }

  async function pushAll(): Promise<PluginsRunnerResult[]> {
    if (runners === undefined) return [];
    const open = await runners.list();
    return Promise.all(
      open
        .filter((runner) => runner.setPlugin !== undefined && runner.retainPlugins !== undefined)
        .map(async (runner): Promise<PluginsRunnerResult> => {
          try {
            const placed = await syncOne(runner);
            return {
              runnerId: runner.runnerId,
              ok: true,
              ...(placed?.plugins === undefined ? {} : { plugins: placed.plugins }),
            };
          } catch (error) {
            return {
              runnerId: runner.runnerId,
              ok: false,
              ...(error instanceof RunnerPluginsUnsupportedError
                ? { unsupported: true as const }
                : {}),
              error: reasonOf(error),
            };
          }
        }),
    );
  }

  return {
    apply: () =>
      serial(async () => {
        const summaries = await wanted();
        const pushed = await pushAll();
        for (const listener of pushListeners) {
          try {
            listener(pushed);
          } catch {
            // 帳面に積めなかっただけで、配布の結果そのものは下で返す。
          }
        }
        return {
          names: summaries.map((s) => s.name),
          ...(summaries.length === 0
            ? {}
            : { sha256: pluginsFingerprintOf(fingerprintOf(summaries)) }),
          runners: pushed,
        };
      }),

    syncRunner: (runner) => serial(() => syncOne(runner)),

    onPushed: (listener) => {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },
  };
}
