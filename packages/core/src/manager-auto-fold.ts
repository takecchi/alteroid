/**
 * Issue #1394 段④⑥ — 「手が空いた委譲を自動で畳んで pids を解放する」の、
 * 実際に畳む・畳まないを決める最後の2つの門だけを持つ純関数の置き場。
 *
 * 段⑤（`manager-fold-candidate.ts`）が持つ「畳む候補かどうか」の5条件判定は
 * ここでは扱わない——このファイルはその先、**候補になった委譲を実際に
 * 畳んでよいかどうか**の2つの門だけを持つ:
 *
 * - ④ 契機の門: pids が逼迫しているか（{@link isPidsUnderPressure}）
 * - ⑥ 畳み方の安全弁: 未 push の実装・未コミットの変更が無いか
 *   （{@link evaluateAutoFoldUnpushedWork}）
 *
 * どちらも副作用を持たない。実際に `manager_stop`（`ManagerPool.abort`）を
 * 呼ぶ判断・日誌・クローンへの通知は呼び出し元（`manager.ts` の
 * `ManagerPool`）が持つ——「数え上げの持ち主を1か所にする」を判定と実行の
 * 両方で守るため、このファイルは判定だけを持ち、実行は一切しない。
 */

/**
 * ④ の閾値。pids の現在値が上限のこの比率以上なら「逼迫している」とみなす
 * （Issue #1394 段④「例えば上限の80%以上」）。
 *
 * **環境変数の設定項目にしない。** `runner-protocol.ts` の
 * `chooseByResources` の doc が繰り返し言っている「つまみを外に出すと、
 * そこが実質の制限になる」と同じ論法——この比率を運用でいじれるようにすると、
 * 「pids の閾値を上げる」が実質「もっと逼迫するまで畳まない」という制限の
 * 追加に化ける。
 */
export const AUTO_FOLD_PIDS_PRESSURE_RATIO = 0.8;

/**
 * ④ 契機の門。pids が逼迫しているか。
 *
 * **`max` が 0 以下（cgroup が壊れている・読めていない）ときは判定できない
 * ——「逼迫していない」側へ倒す。** 逼迫と誤判定すると余計な委譲を畳みに行く
 * （誤って行動する側）が、逼迫していないと判定して見送っても、畳む機会を
 * 1回逃すだけで実害は無い（AGENTS.md「判定できないという3つ目の状態を持つ」
 * の非対称版——ここは3値ではなく2値だが、判定できないときに安全側（畳まない
 * 側）へ倒すという向きは同じ）。
 */
export function isPidsUnderPressure(pids: {
  readonly current: number;
  readonly max: number;
}): boolean {
  if (!(pids.max > 0)) return false;
  return pids.current / pids.max >= AUTO_FOLD_PIDS_PRESSURE_RATIO;
}

/**
 * ⑥ の安全弁が読む材料。`ManagerPool.unpushedWork()` の戻り値
 * （`manager.ts` の `ManagerUnpushedWork`）と同じ形を、**import せずに**
 * 構造的に写したものである。
 *
 * **なぜ import しないか。** `manager.ts`（`ManagerPool`）がこのファイルの
 * {@link evaluateAutoFoldUnpushedWork} を呼ぶ側になるので、逆にこのファイルが
 * `manager.ts` から型を import すると、値の循環は無くても型だけの循環参照が
 * 生まれる。TypeScript は `import type` の循環自体は解決できるが、ここは
 * そもそも避けられる——`ManagerUnpushedWork` の形は小さく安定しているので、
 * 構造的に同じ形をここでも宣言し、呼び出し元（`manager.ts`）はそのまま
 * `ManagerUnpushedWork` の値を渡せばよい（構造的型付けにより代入互換）。
 */
export interface AutoFoldUnpushedWorkProbe {
  readonly kind: 'ok' | 'unavailable';
  readonly result?: {
    readonly worktrees: readonly {
      readonly unpushedCommitCount?: number;
      readonly uncommittedChangeCount?: number;
    }[];
    /** 件数の上限で打ち切っていたら、これ以上見えていない分がありうる。 */
    readonly truncatedAtCount?: number;
    /** 期限切れで一部の作業ツリーを調べる前に打ち切っていたら `true`。 */
    readonly stoppedEarly?: true;
  };
}

export type AutoFoldUnpushedWorkVerdict = 'clear' | 'blocked';

/**
 * ⑥ の安全弁。「畳んでよいほど安全か」を1語で返す。
 *
 * **`'clear'` を返すのは、すべての作業ツリーについて未 push のコミットも
 * 未コミットの変更も無いと確かめられたときだけ。** それ以外は全部
 * `'blocked'` に倒す——確かめられなかった（`unavailable`）・打ち切った
 * （`truncatedAtCount` / `stoppedEarly`）・1件でも未 push/未コミットが在る
 * （数値そのもの）・数値自体が取れていない（`*Unknown`）のどれもここに
 * 含める。**「取れない」を「無かった」へ倒さない**（AGENTS.md「取れない軸に
 * 0の行を作る」の裏）——このファイルは判定できない状態を全部安全側
 * （畳まない）へ吸収する。
 *
 * これは `tools.ts` の `manager_stop`（force なし）が `running` の委譲に
 * 対して行う判断より**厳しい**。あちらは `status: 'done'` の委譲には
 * 未push確認を一切行わずそのまま `abort()` へ進む（人間・クローンが明示的に
 * 呼ぶ操作であり、`manager_report` 等で先に中身を確認できる前提があるため）。
 * こちらは人が見ていない自動操作なので、既存の門をそのまま通すだけでなく、
 * 追加の安全弁として重ねる。
 */
export function evaluateAutoFoldUnpushedWork(
  probe: AutoFoldUnpushedWorkProbe,
): AutoFoldUnpushedWorkVerdict {
  if (probe.kind === 'unavailable' || probe.result === undefined) return 'blocked';
  const { result } = probe;
  if (result.truncatedAtCount !== undefined || result.stoppedEarly === true) return 'blocked';
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

/**
 * {@link evaluateAutoFoldUnpushedWork} が `'blocked'` を返した理由を、
 * 日誌・クローンへの通知に使える1行にする。**判定のコピーは作らない**
 * ——ここは `evaluateAutoFoldUnpushedWork` と同じ入力を読んで文言だけを
 * 組み立てる、表示専用の関数である。
 */
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
  const flagged = result.worktrees.filter(
    (worktree) =>
      worktree.unpushedCommitCount === undefined ||
      worktree.unpushedCommitCount > 0 ||
      worktree.uncommittedChangeCount === undefined ||
      worktree.uncommittedChangeCount > 0,
  );
  if (flagged.length === 0) return '未pushの作業は無かった（この行が出ること自体が想定外）';
  return `未pushの実装・未コミットの変更、または確認できなかった作業ツリーが${String(flagged.length)}本あった`;
}

/**
 * {@link evaluateAutoFoldUnpushedWork} が `'blocked'` を返した理由を、
 * **同じ委譲・同じ理由の見送りを日誌へ積み続けないための、揺れない鍵**に
 * する（Issue #1394 の留保。呼び出し元 `manager.ts` の `#autoFoldOne` が、
 * 前回書いた鍵と比べて日誌へ書くかどうかを決める）。
 *
 * **{@link describeAutoFoldUnpushedWorkProbe} の本文そのものは鍵にしない。**
 * あちらは表示用の日本語の文で、文言だけを直しても呼び出し元は「理由が
 * 変わった」と誤読し、直しただけで再び書き始める。こちらは `probe` の
 * 構造だけから鍵を組み立てる、表示に依存しない値である。
 *
 * **未pushの件数・未コミットの件数もそのまま鍵に含める。** 「件数が動いても
 * `blocked` のままなら同じ理由」と丸めることもできるが、件数が動いたのに
 * 日誌へ何も残らないと、増えている／減っている経過が追えなくなる。
 * **迷ったら書く側に倒す**——件数が1つでも動けば鍵も変わり、もう一度書く。
 */
export function classifyAutoFoldUnpushedWorkProbe(probe: AutoFoldUnpushedWorkProbe): string {
  if (probe.kind === 'unavailable' || probe.result === undefined) {
    return JSON.stringify({ kind: 'unavailable' });
  }
  const { result } = probe;
  return JSON.stringify({
    kind: 'ok',
    truncatedAtCount: result.truncatedAtCount ?? null,
    stoppedEarly: result.stoppedEarly === true,
    worktrees: result.worktrees.map((worktree) => ({
      unpushedCommitCount: worktree.unpushedCommitCount ?? null,
      uncommittedChangeCount: worktree.uncommittedChangeCount ?? null,
    })),
  });
}
