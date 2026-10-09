import { reasonOf } from './dropped-record.js';
import {
  mcpServerNames,
  mcpServersFingerprintOf,
  mcpServersVersionOf,
  type McpServers,
  type StoredMcpServers,
  type WriteMcpServersOptions,
} from './mcp-servers.js';
import {
  RunnerMcpServersUnsupportedError,
  type RunnerClient,
  type RunnerMcpServersFingerprint,
  type RunnerRegistry,
} from './runner-protocol.js';
import type { Stores } from './store.js';

// インスタンスは1つだけ作って全経路へ渡す: 人間の口と runner の降ろし直しを同じ列に入れて直列化するので、
// 2つ作ると列が2本になり、古い登録が新しい登録を上書きする。
// 返すのは名前と指紋だけ（`env` / `headers` / `args` には鍵が入りうる）。
export interface McpServerService {
  read(): Promise<StoredMcpServers | null>;
  /** 空の `{}` は「登録を外す」。形が不正・`ifMatch` の版違いなら器が投げ、保存も配布もしない。 */
  apply(servers: McpServers, options?: WriteMcpServersOptions): Promise<ApplyMcpServersResult>;
  /** 古い runner（口が 404）は `RunnerMcpServersUnsupportedError` を投げる。口を持たない偽物へは `null`（押し込みを試みたことにしない）。 */
  syncRunner(runner: RunnerClient): Promise<{ mcpServers?: RunnerMcpServersFingerprint } | null>;
  // 任意の口: `apply()` の即時の配布は `ManagerPool` の押し込みの帳面と挑み直しを通らないので、`ManagerPool` が購読して同じ帳面に積む。
  onPushed?(listener: (results: readonly McpServersRunnerResult[]) => void): () => void;
}

export interface McpServerServiceOptions {
  stores: Stores;
  runners?: RunnerRegistry;
}

export interface McpServersRunnerResult {
  runnerId: string;
  ok: boolean;
  mcpServers?: RunnerMcpServersFingerprint;
  /** 一時障害と混ぜない: 疑う先が「待てば直る」ではなく「runner の版」だから。 */
  unsupported?: true;
  error?: string;
}

export interface ApplyMcpServersResult {
  updatedAt: string;
  version: string;
  names: string[];
  sha256?: string;
  runners: McpServersRunnerResult[];
}

export function createMcpServerService(options: McpServerServiceOptions): McpServerService {
  const { stores, runners } = options;
  const pushListeners = new Set<(results: readonly McpServersRunnerResult[]) => void>();

  // 前の失敗で列が止まらないように、常に解決する形で繋ぐ。
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  return {
    read: () => stores.mcpServers.read(),

    apply: (servers: McpServers, writeOptions?: WriteMcpServersOptions) =>
      serial(async () => {
        // 投げたら配布もしない: 正本に無い版を runner へ配ると、次の名乗りで正本の版へ巻き戻る。
        const stored = await stores.mcpServers.write(servers, writeOptions);
        const names = mcpServerNames(stored.mcpServers);
        const pushed = await pushAll(stored.mcpServers);
        for (const listener of pushListeners) {
          try {
            listener(pushed);
          } catch {
            // 帳面に積めなかっただけで、配布の結果そのものは下で返す。
          }
        }
        return {
          updatedAt: stored.updatedAt,
          version: mcpServersVersionOf(stored),
          names,
          ...(names.length === 0 ? {} : { sha256: mcpServersFingerprintOf(stored.mcpServers) }),
          runners: pushed,
        };
      }),

    onPushed: (listener) => {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },

    syncRunner: (runner: RunnerClient) =>
      serial(async () => {
        if (runner.setMcpServers === undefined) return null;
        const stored = await stores.mcpServers.read();
        const servers = stored?.mcpServers ?? {};
        const want =
          Object.keys(servers).length === 0 ? undefined : mcpServersFingerprintOf(servers);

        // 指紋が読めなかったときは「差がある」に倒す（同じ登録を置き直すのは無害で、降ろし損なうと連携が0本のまま走る）。
        // 「読めなかった」を `undefined`（何も載っていない）に潰さない: `want === undefined`（外した）のとき
        // 「一致」になり、外したはずの登録（鍵を含む）が runner に残り続ける。
        let unreadable = false;
        let current: RunnerMcpServersFingerprint | undefined;
        try {
          current = await runner.mcpServers?.();
        } catch {
          unreadable = true;
        }
        const matches = want === undefined ? current === undefined : current?.sha256 === want;
        if (!unreadable && matches) return null;

        const placed = await runner.setMcpServers(servers);
        return placed === undefined ? {} : { mcpServers: placed };
      }),
  };

  async function pushAll(servers: McpServers): Promise<McpServersRunnerResult[]> {
    if (runners === undefined) return [];
    const open = await runners.list();
    return Promise.all(
      open
        .filter((runner) => runner.setMcpServers !== undefined)
        .map(async (runner): Promise<McpServersRunnerResult> => {
          try {
            const placed = await runner.setMcpServers?.(servers);
            return {
              runnerId: runner.runnerId,
              ok: true,
              ...(placed === undefined ? {} : { mcpServers: placed }),
            };
          } catch (error) {
            return {
              runnerId: runner.runnerId,
              ok: false,
              ...(error instanceof RunnerMcpServersUnsupportedError
                ? { unsupported: true as const }
                : {}),
              error: reasonOf(error),
            };
          }
        }),
    );
  }
}
