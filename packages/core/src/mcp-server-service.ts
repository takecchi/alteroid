import {
  mcpServerNames,
  mcpServersFingerprintOf,
  type McpServers,
  type StoredMcpServers,
} from './mcp-servers.js';
import {
  RunnerMcpServersUnsupportedError,
  type RunnerClient,
  type RunnerMcpServersFingerprint,
  type RunnerRegistry,
} from './runner-protocol.js';
import type { Stores } from './store.js';

/**
 * 人間の MCP 連携の登録を**置いて、runner へ配る**までの1本道（#325 段3）。
 *
 * **実行環境プロファイルの `profile-service.ts` の写しである。** 理由も同じで、
 * 書き手が2人いる —— 人間の口（`PUT /mcp-servers`）と、runner が名乗り直した
 * ときの降ろし直し（`ManagerPool` の `#pushMcpServers`）。後者が更新の最中に走ると
 * **古い登録を読んで新しい登録を上書きする**（正本＝新・runner＝旧の分裂が、次の
 * 名乗りまで黙って残る）。だから両方をこの列に入れる。
 *
 * **インスタンスは1つだけ作って全経路へ渡すこと**（`apps/daemon/src/index.ts`）。
 * 2つ作ると列が2本になり、直列化の意味が消える。
 *
 * ## プロファイルと違うところ
 *
 * - **クローンの器へ commit する段が無い。** クローンは登録を記憶ストアから
 *   セッションを組むたびに読む（`clone.ts` の `#buildOptions`。段2）ので、正本へ
 *   保存した時点でクローンへの反映は済んでいる（次のセッションから効く）
 * - **置く前の評価（シェルの実行）が無い。** 形の検査は器の `write` が
 *   `parseMcpServers` で行い、不正なら投げて何も書かない
 * - **runner は登録をメモリにだけ持つ**（`runner.ts` の `Host#setMcpServers`）。
 *   器を作り直せば消えるので、名乗りのたびの降ろし直しが唯一の復元経路である
 *
 * ## 値を外へ出さない
 *
 * 返すのは名前と指紋だけ（`env` / `headers` / `args` には鍵が入りうる）。runner の
 * 失敗理由（`error`）も runner が返す文言をそのまま運ぶが、その文言は
 * `parseMcpServers` が値を載せない形で作っている。
 */
export interface McpServerService {
  /** いま保存されている登録。 */
  read(): Promise<StoredMcpServers | null>;
  /**
   * 差し替える。**保存 → 配布までを1つの区間として直列に行う。** 空の `{}` は
   * 「登録を外す」。形が不正なら器の `write` が投げ、保存も配布もしない
   * （前のものが残る）。
   */
  apply(servers: McpServers): Promise<ApplyMcpServersResult>;
  /**
   * 1台の runner へ、いま保存されている登録を降ろし直す。
   *
   * **runner は記憶ストアを読めない**ので、器が作り直されたときに降ろすのはこちら
   * の責任である。既に同じ版（指紋が一致）が載っていれば何もせず `null` を返す。
   * 口を持たない実装（`RunnerClient.setMcpServers` が無い偽物など）へも何もせず
   * `null` を返す（押し込みを試みたことにしない）。
   *
   * **古い runner（口が 404）は `RunnerMcpServersUnsupportedError` を投げる。**
   */
  syncRunner(runner: RunnerClient): Promise<{ mcpServers?: RunnerMcpServersFingerprint } | null>;
}

export interface McpServerServiceOptions {
  stores: Stores;
  /** 委譲先。無ければ配布はしない（保存はする）。 */
  runners?: RunnerRegistry;
}

/** 1台の runner への配布結果。**名前と指紋だけ**（値は載せない）。 */
export interface McpServersRunnerResult {
  runnerId: string;
  ok: boolean;
  /** 置いた後の指紋。外した（空の登録）なら無い。 */
  mcpServers?: RunnerMcpServersFingerprint;
  /**
   * 相手が口を持たない古い runner だった（`RunnerMcpServersUnsupportedError`）。
   * **一時障害と混ぜない** —— 疑う先が「待てば直る」ではなく「runner の版」だから。
   */
  unsupported?: true;
  error?: string;
}

export interface ApplyMcpServersResult {
  updatedAt: string;
  /** 保存した登録の名前（昇順）。 */
  names: string[];
  /** 保存した登録の指紋。空の登録（外した）なら無い。 */
  sha256?: string;
  /** 各 runner への配布結果。 */
  runners: McpServersRunnerResult[];
}

export function createMcpServerService(options: McpServerServiceOptions): McpServerService {
  const { stores, runners } = options;

  // 直列化の実体（`profile-service.ts` の `serial` と同じ形）。前の失敗で列が
  // 止まらないように、常に解決する形で繋ぐ。
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

    apply: (servers: McpServers) =>
      serial(async () => {
        // 形が不正ならここで投げる（器の `write` が `parseMcpServers` を通す）。
        // 投げたら配布もしない —— 正本に無い版を runner へ配ると、次の名乗りで
        // 正本の版へ巻き戻る（しかも誰も成功と言っていない版が一時的に効く）。
        const stored = await stores.mcpServers.write(servers);
        const names = mcpServerNames(stored.mcpServers);
        return {
          updatedAt: stored.updatedAt,
          names,
          // **指紋は正本から取る。** runner が返す指紋と同じ関数を通すので、
          // 突き合わせれば「届いているか」がそのまま言える。
          ...(names.length === 0 ? {} : { sha256: mcpServersFingerprintOf(stored.mcpServers) }),
          runners: await pushAll(stored.mcpServers),
        };
      }),

    syncRunner: (runner: RunnerClient) =>
      serial(async () => {
        if (runner.setMcpServers === undefined) return null;
        const stored = await stores.mcpServers.read();
        const servers = stored?.mcpServers ?? {};
        const want =
          Object.keys(servers).length === 0 ? undefined : mcpServersFingerprintOf(servers);

        // **既に同じ版が載っていれば触らない。** 指紋が取れなかったときは「差がある」に
        // 倒す（降ろす）—— 同じ登録を置き直すのは無害で、降ろし損なうと連携が0本の
        // まま走る（`credential-service.ts` の `syncRunner` と同じ倒し方）。
        const current = await runner.mcpServers?.().catch(() => undefined);
        if (want === undefined ? current === undefined : current?.sha256 === want) return null;

        const placed = await runner.setMcpServers(servers);
        return placed === undefined ? {} : { mcpServers: placed };
      }),
  };

  async function pushAll(servers: McpServers): Promise<McpServersRunnerResult[]> {
    if (runners === undefined) return [];
    const open = await runners.list();
    return Promise.all(
      open
        // 口を持たない実装へは「配った」とも「失敗した」とも言わない（数えない）。
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
              error: String(error),
            };
          }
        }),
    );
  }
}
