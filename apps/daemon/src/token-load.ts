import {
  fetchAccountUsage,
  reasonOf,
  type AccountUsageState,
  type AgentToken,
  type UsageProbeQuery,
} from '@alteroid/core';

import { startPeriodicRun } from './periodic-runner.js';
import { USAGE_POLL_INTERVAL_MS } from './usage-poller.js';

/** 鍵1本ぶんの最後の観測。`GET /tokens` の `loads` の1行（#6633）。 */
export interface TokenLoad {
  tokenId: string;
  state: AccountUsageState;
}

/**
 * 鍵ごとの枠の観測を、デーモンのメモリにだけ持つ帳面（#6633）。
 *
 * 保存しない: 枠は数分で動くので、再起動をまたいで持ち越した値は「いまの枠」として読めないため。
 * 測っていない鍵の行は作らない: 0% の行を作ると「空いている」と読める（取れない軸に 0 の行を作らない）。
 */
export interface TokenLoadBook {
  record(tokenId: string, state: AccountUsageState): void;
  /** プールから消えた鍵の行を落とす。 */
  retain(tokenIds: ReadonlySet<string>): void;
  snapshot(): TokenLoad[];
}

export function createTokenLoadBook(): TokenLoadBook {
  const loads = new Map<string, AccountUsageState>();
  return {
    record(tokenId, state) {
      // `unknown` は観測ではない（まだ測っていない）: 前の観測を消して「まだ分からない」へ戻さないため
      if (state.state === 'unknown') return;
      loads.set(tokenId, state);
    },
    retain(tokenIds) {
      for (const tokenId of [...loads.keys()]) {
        if (!tokenIds.has(tokenId)) loads.delete(tokenId);
      }
    },
    snapshot() {
      return [...loads].map(([tokenId, state]) => ({ tokenId, state }));
    },
  };
}

export interface TokenLoadSamplingOptions {
  queryFn: UsageProbeQuery;
  cwd: string;
  // `storage.withheldEnvKeys` をそのまま渡す（`startUsagePolling` と同じ理由: 省略すると子へ `process.env` を丸ごと継承する）
  withheldEnvKeys: readonly string[];
  tokens: () => Promise<AgentToken[]>;
  /** 現役の鍵の id。現役は既存の枠の probe（`startUsagePolling`）が測るので、ここでは測らない。 */
  activeTokenId: () => string | undefined;
  book: TokenLoadBook;
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface TokenLoadSampler {
  /** 1周ぶん測る。周回中に呼ばれたら、その周回の完了を待つ（2本並べない）。 */
  sampleOnce(): Promise<void>;
  stop(): void;
}

// 測るのは「使いうる鍵」だけ: 人間が外した鍵・失効した鍵を測っても配る先にならず、失効した鍵は probe を焼くだけのため。
// 冷却中の鍵は測る: 冷却の期限は推測のことがあり、使用率は「いつ戻るか」の材料になるため
function measurable(token: AgentToken): token is AgentToken & { value: string } {
  return (
    token.value !== undefined && token.disabledAt === undefined && token.invalidatedAt === undefined
  );
}

/**
 * 現役以外の鍵の枠を、周期ごとに1本ずつ直列に測る（#6633）。
 *
 * 直列にする: probe は1本ごとに SDK の子プロセスを起こすので、並べると鍵の本数ぶん同時に起きて器を圧すため。
 * プロンプトは1つも送らない（`fetchAccountUsage` は枠を読むだけ）ので、測ること自体は枠を使わない。
 */
export function startTokenLoadSampling(options: TokenLoadSamplingOptions): TokenLoadSampler {
  const interval = options.intervalMs ?? USAGE_POLL_INTERVAL_MS;
  // 周回の途中で止められたかを、1本ごとの境で見る
  let stopped = false;

  const sampleRound = async (): Promise<void> => {
    const tokens = await options.tokens();
    options.book.retain(new Set(tokens.map((token) => token.id)));
    const active = options.activeTokenId();
    for (const token of tokens) {
      if (stopped || options.signal?.aborted === true) return;
      if (token.id === active || !measurable(token)) continue;
      let state: AccountUsageState;
      try {
        state = await fetchAccountUsage(options.queryFn, {
          cwd: options.cwd,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          env: { CLAUDE_CODE_OAUTH_TOKEN: token.value },
          withheldEnvKeys: options.withheldEnvKeys,
        });
      } catch (error) {
        // 1本の失敗で周回を止めない。理由は値を含まない（`reasonOf` は例外の型と文言だけ）
        state = { state: 'failed', at: new Date().toISOString(), reason: reasonOf(error) };
      }
      options.book.record(token.id, state);
    }
  };

  // 重ねない・止める・次の予約は `startPeriodicRun` が持つ（投げても次を予約する）
  const periodic = startPeriodicRun({
    intervalMs: interval,
    signal: options.signal,
    run: sampleRound,
  });
  return {
    sampleOnce: periodic.refresh,
    stop: () => {
      stopped = true;
      periodic.stop();
    },
  };
}
