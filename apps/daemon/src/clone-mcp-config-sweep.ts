import { tmpdir } from 'node:os';

import {
  DEFAULT_SCRATCH_SWEEP_INTERVAL_MS,
  liveCloneMcpConfigDirPaths,
  reasonOf,
  sweepCloneMcpConfigDirs,
  writeStderrLine,
  type CloneMcpConfigSweepOptions,
  type CloneMcpConfigSweepResult,
  type JournalStore,
} from '@alteroid/core';

// runner の掃き（scratch の周期に乗る）と同じ値にする: 資格入りの残骸が /tmp に残る時間を、runner 側と同じ桁に揃えるため。
// 元は core の `DEFAULT_SCRATCH_SWEEP_INTERVAL_MS`（10 分）。別の値を置くと片方だけ残る時間が延びる
export const CLONE_MCP_CONFIG_SWEEP_EVERY_MS = DEFAULT_SCRATCH_SWEEP_INTERVAL_MS;

export interface CloneMcpConfigSweeperOptions {
  readonly journal: Pick<JournalStore, 'append'>;
  readonly sweep?: (options: CloneMcpConfigSweepOptions) => Promise<CloneMcpConfigSweepResult>;
  readonly now?: () => number;
  readonly tmpRoot?: string;
  readonly ownPid?: number;
  readonly liveDirs?: () => ReadonlySet<string>;
  readonly intervalMs?: number;
  readonly writeLine?: (line: string) => void;
}

export interface CloneMcpConfigSweeper {
  /** 1回掃く。掃きの失敗では投げない */
  runOnce(): Promise<void>;
  stop(): void;
}

// 失敗の同一性の鍵: 同じ失敗を毎周期書かないため（runner の掃きの `#mcpConfigSweepFailedNotified` と同じ作法）
const failureKey = (name: string, reason: string): string => `${name}\u0000${reason}`;
const SCAN_KEY_PREFIX = '__scan__\u0000';

export function startCloneMcpConfigSweeping(
  options: CloneMcpConfigSweeperOptions,
): CloneMcpConfigSweeper {
  const sweep = options.sweep ?? sweepCloneMcpConfigDirs;
  const now = options.now ?? Date.now;
  const writeLine = options.writeLine ?? writeStderrLine;
  const intervalMs = options.intervalMs ?? CLONE_MCP_CONFIG_SWEEP_EVERY_MS;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let notified = new Set<string>();

  const sweepOnce = async (): Promise<void> => {
    try {
      const { removed, failed, scanError } = await sweep({
        tmpRoot: options.tmpRoot ?? tmpdir(),
        liveDirs: options.liveDirs?.() ?? liveCloneMcpConfigDirPaths(),
        now: now(),
        ownPid: options.ownPid ?? process.pid,
      });
      if (stopped) return;
      const keys = [
        ...failed.map((f) => failureKey(f.name, f.reason)),
        ...(scanError === undefined ? [] : [`${SCAN_KEY_PREFIX}${scanError}`]),
      ];
      const previouslyNotified = notified;
      notified = new Set(keys);
      const newFailed = failed.filter((f) => !previouslyNotified.has(failureKey(f.name, f.reason)));
      const newScanError =
        scanError !== undefined && !previouslyNotified.has(`${SCAN_KEY_PREFIX}${scanError}`)
          ? scanError
          : undefined;
      if (removed.length === 0 && newFailed.length === 0 && newScanError === undefined) return;

      // 行の形は manager の `#onScratchSweep`（runner の掃きの日誌）に揃える。ファイルの中身は載せない（名前と理由だけ）
      const grounds = [
        ...(newScanError === undefined ? [] : [`走査の失敗: ${newScanError}`]),
        ...removed.map((name) => `  - 消した ${name}（directory）`),
        ...newFailed.map(
          (f) =>
            `  - 残した ${f.name}（directory） 理由 rm-failed: クローンの MCP 設定の残骸を掃けなかった: ${f.reason}`,
        ),
      ].join('\n');
      writeLine(
        `alteroidd: クローンの MCP 設定（資格入り）の残骸を片付けた（消した ${String(removed.length)} 件、` +
          `新しく残した ${String(newFailed.length)} 件${newScanError === undefined ? '' : '、走査の失敗あり'}）\n`,
      );
      await options.journal
        .append({
          type: 'decision',
          decision:
            'デーモンが /tmp に残っていたクローンの MCP 設定（資格入り）の一時ディレクトリを片付けた' +
            `（消した ${String(removed.length)} 件、新しく残した ${String(newFailed.length)} 件）。`,
          grounds,
        })
        .catch((error: unknown) => {
          writeLine(
            `alteroidd: クローンの MCP 設定の片付けを日誌へ残せませんでした: ${reasonOf(error)}\n`,
          );
        });
    } catch {
      // 掃きの失敗でデーモンを止めない
    }
  };

  const runOnce = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    // 重ねない: 前の掃きが長引いても同じ残骸を二重に消しに行かない
    inFlight ??= sweepOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  void runOnce();
  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref();

  return {
    runOnce,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
