import { reasonOf } from './dropped-record.js';
import {
  isPluginScopeForRunner,
  pluginsFingerprintOf,
  type PluginFingerprintEntry,
  type PluginSummary,
} from './plugins.js';
import {
  type RunnerClient,
  type RunnerPluginsFingerprint,
  type RunnerRegistry,
} from './runner-protocol.js';
import { createSerialQueue } from './serial-queue.js';
import type { Stores } from './store.js';

/**
 * 配布を並行に走らせない:`apply` と runner 再接続時の降ろし直しが重なると古い一覧が新しい一覧を上書きするので、
 * 両方をこの列に入れる（インスタンスは1つだけ作って全経路へ渡す）。files の中身は結果にも日誌にも載せない。
 */
export interface PluginDistributionService {
  apply(): Promise<ApplyPluginsResult>;
  /** 同じ版が載っていれば `null`。 */
  syncRunner(runner: RunnerClient): Promise<{ plugins?: RunnerPluginsFingerprint } | null>;
  onPushed?(listener: (results: readonly PluginsRunnerResult[]) => void): () => void;
}

export interface PluginDistributionServiceOptions {
  stores: Stores;
  runners?: RunnerRegistry;
}

export interface PluginsRunnerResult {
  runnerId: string;
  ok: boolean;
  plugins?: RunnerPluginsFingerprint;
  error?: string;
}

export interface ApplyPluginsResult {
  names: string[];
  sha256?: string;
  runners: PluginsRunnerResult[];
}

export function createPluginDistributionService(
  options: PluginDistributionServiceOptions,
): PluginDistributionService {
  const { stores, runners } = options;
  const pushListeners = new Set<(results: readonly PluginsRunnerResult[]) => void>();

  const { run: serial } = createSerialQueue();

  async function wanted(): Promise<PluginSummary[]> {
    return (await stores.plugins.list()).filter((summary) => isPluginScopeForRunner(summary.scope));
  }

  function fingerprintOf(summaries: readonly PluginSummary[]): PluginFingerprintEntry[] {
    return summaries.map((s) => ({
      name: s.name,
      sha: s.source.sha,
      contentSha256: s.contentSha256,
      enableHooks: s.enableHooks,
      enableMcp: s.enableMcp,
    }));
  }

  async function syncOne(
    runner: RunnerClient,
  ): Promise<{ plugins?: RunnerPluginsFingerprint } | null> {
    if (runner.setPlugin === undefined || runner.retainPlugins === undefined) return null;
    const summaries = await wanted();

    // 指紋が読めなかったら「差がある」に倒して全部送り直す: 「何も持っていない」に潰すと送り損ねて plugin が0本のまま走る。
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
        held.contentSha256 !== summary.contentSha256 ||
        held.enableHooks !== summary.enableHooks ||
        held.enableMcp !== summary.enableMcp
      );
    });
    const wantedNames = new Set(summaries.map((s) => s.name));
    const extra = [...have.keys()].some((name) => !wantedNames.has(name));
    if (!unreadable && differing.length === 0 && !extra) return null;

    const names: string[] = [];
    const failures: unknown[] = [];
    for (const summary of summaries) {
      if (!differing.includes(summary)) {
        names.push(summary.name);
        continue;
      }
      try {
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
      } catch (error) {
        // 1本の失敗で残りの送りと余りの片づけを止めない: 失敗が続く plugin があると、ほかの plugin が旧版のまま・外した plugin が残ったままになる。
        // 失敗した plugin は runner が今持っている版を残す（外すと、直るまで旧版の道具まで欠ける）。
        failures.push(error);
        if (have.has(summary.name)) names.push(summary.name);
      }
    }
    const placed = await runner.retainPlugins(names);
    // 最後にまとめて投げる: 帳面と挑み直しは失敗を見て動く。
    if (failures.length > 0) throw failures[0];
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
