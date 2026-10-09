// 判定だけを持ち、実行は一切しない: `ManagerPool.abort` を呼ぶ判断・日誌・クローンへの通知は呼び出し元（`manager.ts`）が持つ。

// 環境変数の設定項目にしない: つまみを外に出すと、そこが実質の制限になる（閾値を上げることが「もっと逼迫するまで畳まない」という制限の追加に化ける）。
export const AUTO_FOLD_PIDS_PRESSURE_RATIO = 0.8;

// `max` が 0 以下（cgroup が壊れている・読めていない）なら「逼迫していない」側へ倒す: 逼迫と誤判定すると余計な委譲を畳みに行くが、見送っても畳む機会を1回逃すだけで実害は無い。
export function isPidsUnderPressure(pids: {
  readonly current: number;
  readonly max: number;
}): boolean {
  if (!(pids.max > 0)) return false;
  return pids.current / pids.max >= AUTO_FOLD_PIDS_PRESSURE_RATIO;
}

// `manager.ts` の `ManagerUnpushedWork` を import せず構造的に写す: `manager.ts` がこのファイルを呼ぶ側なので、import すると型だけの循環参照ができる。
export interface AutoFoldUnpushedWorkProbe {
  readonly kind: 'ok' | 'unavailable';
  readonly result?: {
    readonly worktrees: readonly {
      readonly unpushedCommitCount?: number;
      readonly uncommittedChangeCount?: number;
    }[];
    readonly truncatedAtCount?: number;
    readonly stoppedEarly?: true;
    // 載っているとき `worktrees` は未 push の実装を1本も含んでいない可能性がある。`truncatedAtCount` / `stoppedEarly` と同じ強さで、畳んではいけない。
    readonly scratchRootsUnknown?: string;
    // 同上。
    readonly unreadableDirCount?: number;
    readonly unreadableDirSample?: string;
  };
}

export type AutoFoldUnpushedWorkVerdict = 'clear' | 'blocked';

// `'clear'` はすべての作業ツリーで未 push も未コミットも無いと確かめられたときだけ。確かめられなかったものは全部 `'blocked'`（畳まない）に吸収し、「取れない」を「無かった」へ倒さない。
// `manager_stop`（force なし）が `done` の委譲に行う判断より厳しい: あちらは人間・クローンが明示的に呼ぶ操作だが、こちらは人が見ていない自動操作なので追加の安全弁として重ねる。
export function evaluateAutoFoldUnpushedWork(
  probe: AutoFoldUnpushedWorkProbe,
): AutoFoldUnpushedWorkVerdict {
  if (probe.kind === 'unavailable' || probe.result === undefined) return 'blocked';
  const { result } = probe;
  if (result.truncatedAtCount !== undefined || result.stoppedEarly === true) return 'blocked';
  if (result.scratchRootsUnknown !== undefined) return 'blocked';
  if (result.unreadableDirCount !== undefined) return 'blocked';
  for (const worktree of result.worktrees) {
    if (worktree.unpushedCommitCount === undefined || worktree.unpushedCommitCount > 0) {
      return 'blocked';
    }
    if (worktree.uncommittedChangeCount === undefined || worktree.uncommittedChangeCount > 0) {
      return 'blocked';
    }
  }
  return 'clear';
}

// 表示専用: 判定は `evaluateAutoFoldUnpushedWork` が単独で持ち、ここに判定のコピーを作らない。
// 「未 push（未コミット）がある」と「判定できない」を分けて数える: 混ぜると、畳めない理由が在るからか分からないからかを本文から区別できない。同じ作業ツリーが両方に数えられることがある（取れなかった軸が在るかと、取れた軸に正の値が在るかは別の問い）。
// 重複抑止の鍵（`classifyAutoFoldUnpushedWorkProbe`）はこの本文からは組み立てないので、文言を直しても鍵は動かない。
export function describeAutoFoldUnpushedWorkProbe(probe: AutoFoldUnpushedWorkProbe): string {
  if (probe.kind === 'unavailable' || probe.result === undefined) {
    return '未pushの確認ができなかった（確かめられなかったことを「無かった」に倒さない）';
  }
  const { result } = probe;
  if (result.truncatedAtCount !== undefined) {
    return `作業ツリーの探索を${String(result.truncatedAtCount)}件で打ち切っていた（全部は見ていない）`;
  }
  if (result.stoppedEarly === true) {
    return '呼び出しの期限切れで、一部の作業ツリーを調べる前に打ち切っていた（全部は見ていない）';
  }
  if (result.scratchRootsUnknown !== undefined) {
    return `他マネージャー/作業者の /tmp スクラッチディレクトリの有無を確かめられなかった（${result.scratchRootsUnknown}）`;
  }
  if (result.unreadableDirCount !== undefined) {
    const sample =
      result.unreadableDirSample === undefined ? '' : `（例: ${result.unreadableDirSample}）`;
    return (
      `作業ツリーの探索中に子ディレクトリの読み取りに${String(result.unreadableDirCount)}回` +
      `失敗していた（/tmp スクラッチの起点そのものの読み失敗を含む。見つかった分がすべてとは限らない）${sample}`
    );
  }
  const undetermined = result.worktrees.filter(
    (worktree) =>
      worktree.unpushedCommitCount === undefined || worktree.uncommittedChangeCount === undefined,
  );
  const hasWork = result.worktrees.filter(
    (worktree) =>
      (worktree.unpushedCommitCount !== undefined && worktree.unpushedCommitCount > 0) ||
      (worktree.uncommittedChangeCount !== undefined && worktree.uncommittedChangeCount > 0),
  );
  if (undetermined.length === 0 && hasWork.length === 0) {
    return '未pushの作業は無かった（この行が出ること自体が想定外）';
  }
  const parts: string[] = [];
  if (hasWork.length > 0) {
    parts.push(`未pushの実装・未コミットの変更がある作業ツリーが${String(hasWork.length)}本`);
  }
  if (undetermined.length > 0) {
    parts.push(`確認できなかった（判定できない）作業ツリーが${String(undetermined.length)}本`);
  }
  return `${parts.join('、')}あった`;
}

// `describeAutoFoldUnpushedWorkProbe` の本文は鍵にしない: 表示用の文で、文言だけを直しても呼び出し元が「理由が変わった」と誤読し、再び日誌へ書き始める。`probe` の構造だけから組み立てる。
// 件数も鍵に含める: 丸めると、件数が増減する経過が日誌から追えなくなる。迷ったら書く側に倒す。
export function classifyAutoFoldUnpushedWorkProbe(probe: AutoFoldUnpushedWorkProbe): string {
  if (probe.kind === 'unavailable' || probe.result === undefined) {
    return JSON.stringify({ kind: 'unavailable' });
  }
  const { result } = probe;
  return JSON.stringify({
    kind: 'ok',
    truncatedAtCount: result.truncatedAtCount ?? null,
    stoppedEarly: result.stoppedEarly === true,
    scratchRootsUnknown: result.scratchRootsUnknown ?? null,
    unreadableDirCount: result.unreadableDirCount ?? null,
    worktrees: result.worktrees.map((worktree) => ({
      unpushedCommitCount: worktree.unpushedCommitCount ?? null,
      uncommittedChangeCount: worktree.uncommittedChangeCount ?? null,
    })),
  });
}
