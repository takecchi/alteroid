// マネージャーへの委譲の道具のうち `manager_stop`。`clone-tools-manager.ts` の `managerTools` が並びのまま連結する。
// このファイルから `clone-tools-manager.ts` を import しない（一方向）。他の道具とも使う補助は `clone-tools-manager-describe.ts` に在る。

import { z } from 'zod';
import { describeManagerState } from './digest.js';
import { reasonOf } from './dropped-record.js';
import { excerptLine } from './excerpt.js';
import { type ManagerSummary } from './manager.js';
import type { ManagerUnpushedWork } from './unpushed-work-observation.js';
import { isEmptyCompleteUnpushedWorkObservation } from './unpushed-work-observation-format.js';
import { text, tool, NO_POOL } from './clone-tools-common.js';
import type { ToolContext } from './clone-tools-context.js';

// `LIST_REPORT_EXCERPT`（`clone-tools-manager-list.ts`）を使い回さない: 用途ごとに別に置く
const MANAGER_STOP_FOLDED_TURN_EXCERPT = 240;

// 短めに切る: `manager_stop` 自体の応答が長々と待たされるほうが実害で、`pool.unpushedWork()` は失敗しても構わない設計のため
const MANAGER_STOP_UNPUSHED_WORK_TIMEOUT_MS = 5_000;

// ファイル名・差分の中身・コミットメッセージ・author を文言に含めない
function describeUnpushedWork(probe: ManagerUnpushedWork): string {
  if (probe.kind === 'unavailable') {
    return `未 push の実装・未コミットの変更: **確かめられなかった**（${probe.reason}）。`;
  }
  const { result } = probe;
  if (result.worktrees.length === 0) {
    // 「見つからなかった」と言い切らない: 探せなかっただけで未 push の実装が残っている可能性があるため
    const uncertain: string[] = [];
    if (result.scratchRootsUnknown !== undefined) {
      uncertain.push(
        '他マネージャー/作業者の /tmp スクラッチディレクトリの有無は確かめられなかった' +
          `（${result.scratchRootsUnknown}）`,
      );
    }
    if (result.unreadableDirCount !== undefined) {
      uncertain.push(
        `${result.cwd} の下の子ディレクトリの読み取りに${String(result.unreadableDirCount)}回失敗した` +
          '（/tmp スクラッチの起点そのものの読み失敗を含む）' +
          '——その下に未 push の実装が残っていた可能性がある',
      );
    }
    return uncertain.length === 0
      ? `未 push の実装・未コミットの変更: 作業ツリーが見つからなかった（${result.cwd} の下を探索した）。`
      : `未 push の実装・未コミットの変更: ${result.cwd} の下には作業ツリーが見つからなかったが、` +
          `${uncertain.join('、')}。**確認できていない。**`;
  }
  const lines = result.worktrees.map((worktree) => {
    const branch = worktree.branch ?? '(枝を指していない、または確かめられなかった)';
    const unpushed =
      worktree.unpushedCommitCount === undefined
        ? `未 push: 確かめられなかった（${worktree.unpushedCommitCountUnknown ?? '理由不明'}）`
        : `未 push ${String(worktree.unpushedCommitCount)}本`;
    const uncommitted =
      worktree.uncommittedChangeCount === undefined
        ? `未コミット: 確かめられなかった（${worktree.uncommittedChangeCountUnknown ?? '理由不明'}）`
        : `未コミット ${String(worktree.uncommittedChangeCount)}件`;
    return `  - ${worktree.relativePath}（枝: ${branch}）: ${unpushed} / ${uncommitted}`;
  });
  const truncatedNote =
    result.truncatedAtCount === undefined
      ? ''
      : `\n  ⚠️ 作業ツリーの探索は${String(result.truncatedAtCount)}件で打ち切った——さらに在る可能性がある。`;
  const stoppedEarlyNote =
    result.stoppedEarly === true
      ? '\n  ⚠️ 呼び出し元の期限切れで、一部の作業ツリーは調べる前に打ち切った（各行の理由を見よ）。'
      : '';
  const scratchRootsUnknownNote =
    result.scratchRootsUnknown === undefined
      ? ''
      : `\n  ⚠️ 他マネージャー/作業者の /tmp スクラッチディレクトリの有無を確かめられなかった` +
        `（${result.scratchRootsUnknown}）——そこに未 push の実装が残っている可能性があり、` +
        '上の一覧には含まれていない。';
  const unreadableDirNote =
    result.unreadableDirCount === undefined
      ? ''
      : `\n  ⚠️ ${result.cwd} の下で子ディレクトリの読み取りに${String(result.unreadableDirCount)}件` +
        '失敗した（/tmp スクラッチの起点そのものの読み失敗を含む）——そこに未 push の実装が残っている可能性があり、上の一覧には含まれていない。';
  return (
    `未 push の実装・未コミットの変更（${result.cwd} の下、${String(result.worktrees.length)}本の作業ツリー）:\n` +
    lines.join('\n') +
    truncatedNote +
    stoppedEarlyNote +
    scratchRootsUnknownNote +
    unreadableDirNote +
    '\n  ⚠️ 未 push の数は fetch していない remote-tracking ref を基準にしており、' +
    '実際には push 済みでも多めに出ることがある（安全側の誤り）。'
  );
}

export function managerStopTool(context: ToolContext) {
  // クローン用の停止を別に作らない: 挙動が2種類あると、人間とクローンで見えている状態が食い違うため
  // マネージャーには渡さない: 自分や隣の仕事を止められると M4 の制御面分離が意味を失うため
  return tool(
    'manager_stop',
    [
      'マネージャーを止める。人間が Web UI から押す停止と同じもので、その1本だけが止まる。',
      '暴走しているとき、報告を出したのに終わらないとき、依頼自体が要らなくなったときに使う。',
      '止めたあと本当に止まったかを確かめて返すので、返ってきた状態まで読むこと。',
      '⚠️ いまターンの途中（running）の委譲は既定では止めない——畳むと進行中の作業が' +
        '失われるため。それでも止めるなら force: true を渡すこと。' +
        '止める前に一覧を読めなかったときも、走行中かどうか判定できないので同じく断る。',
    ].join(' '),
    {
      managerId: z.string().describe('manager_list に出ている id'),
      reason: z
        .string()
        .optional()
        .describe('なぜ止めたか。日誌と、その仕事の記録に残る。後から辿れるように書く'),
      force: z
        .boolean()
        .optional()
        .describe(
          'いまターンの途中（status: running）の委譲でも止める。既定（false/省略）だと、' +
            'running の委譲は abort を呼ばずに断って理由を返す——畳むと、そのターンが抱えて' +
            'いる進行中の作業（起こした作業者など。作業ツリーが見つかれば未 push の実装・監視中の CI も）が' +
            '失われるため。' +
            '止める前に一覧を読めなかったとき（走行中か判定できない）も同じく断る。' +
            '断りを読んだうえで、それでも畳んでよいと判断したら true で呼び直すこと。',
        ),
    },
    async ({ managerId, reason, force }) => {
      if (!context.managers) return NO_POOL;
      const pool = context.managers;
      // 3状態にする: `pool.list()` の失敗を `[]` に倒すと「居ない」と「読めなかった」が区別できないため
      type ManagerLookup =
        | { kind: 'found'; manager: ManagerSummary }
        | { kind: 'absent' }
        | { kind: 'unreadable'; reason: string };
      const find = async (): Promise<ManagerLookup> => {
        let list: ManagerSummary[];
        try {
          list = await pool.list();
        } catch (error: unknown) {
          return { kind: 'unreadable', reason: reasonOf(error) };
        }
        const manager = list.find((entry) => entry.managerId === managerId);
        return manager === undefined ? { kind: 'absent' } : { kind: 'found', manager };
      };

      const beforeLookup = await find();
      const before = beforeLookup.kind === 'found' ? beforeLookup.manager : undefined;

      if (beforeLookup.kind === 'unreadable' && force !== true) {
        return text(
          `[${managerId}] 止めていない。**いまの状態を一覧から読めなかった**ので、` +
            '走行中（running）かどうか判定できない — 走行中なら、畳むと、そのターンの' +
            '進行中の作業（起こした作業者など）が失われる。\n' +
            `読めなかった原因: ${beforeLookup.reason}\n` +
            'manager_list で状態を確かめること。読めても判断が同じなら、🔴 force: true で' +
            '呼び直すと止まる。',
        );
      }

      // running は既定で abort を呼ばずに断る: クローンには人間の画面のようにターンが走っている様子が見えないため
      // `force` を必ず残す: 暴走している委譲を止める道を塞ぐほうが、誤って畳むより危険なため
      // `waiting_human` は含めない: クローン自身が立てた問いで、待っていること自体は既に知っているため
      if (before?.status === 'running' && force !== true) {
        // 要点を先頭・短くする: 「⚠ の1行を足す」形の断りは読まれても流されるため、核心（force で止まる）を長い説明の奥に埋めない
        const lastReportLine =
          before.lastReportAt === undefined
            ? '直近の報告は一度も届いていない。'
            : `直近の報告は ${before.lastReportAt}` +
              '（最後に終えたターンのもの。いま走っているターンの中身ではない）。';

        // この調べものが失敗しても断りは必ず返す: 止める道が塞がっていないことを守るため、例外を投げない設計でも念のため捕まえる
        const unpushedWork = await pool
          .unpushedWork(managerId, {
            signal: AbortSignal.timeout(MANAGER_STOP_UNPUSHED_WORK_TIMEOUT_MS),
            source: 'stop-refusal',
          })
          .catch((error: unknown): ManagerUnpushedWork => ({
            kind: 'unavailable',
            reason: `確かめようとして例外が飛んだ: ${reasonOf(error)}`,
          }));

        // 具体（未 push・CI）は作業ツリーが見つかったか探索に失敗したときだけ足す: git を使わない仕事に git/CI 前提の文面を毎回出さないため
        const gitConcrete =
          unpushedWork.kind === 'unavailable' ||
          !isEmptyCompleteUnpushedWorkObservation({
            kind: 'observed',
            worktrees: unpushedWork.result.worktrees,
            truncatedAtCount: unpushedWork.result.truncatedAtCount,
            stoppedEarly: unpushedWork.result.stoppedEarly,
            scratchRootsUnknown: unpushedWork.result.scratchRootsUnknown,
            unreadableDirCount: unpushedWork.result.unreadableDirCount,
          });
        return text(
          `[${managerId}] 止めていない。**いまターンの途中**（running）— 畳むと、そのターンの進行中の作業が失われる` +
            (gitConcrete
              ? '（未 push の実装・起こした作業者・監視中の CI など）'
              : '（起こした作業者など）') +
            '。🔴 force: true で止まる。\n' +
            `${lastReportLine} ターンの中身は manager_report で先に読めること。` +
            (gitConcrete ? `\n${describeUnpushedWork(unpushedWork)}` : ''),
        );
      }

      const result = await pool.abort(managerId, reason, 'clone');

      if (result.outcome === 'unreadable') {
        // 読めない行を「居ない」と言わない
        return text(`${managerId} は止められなかった: ${result.detail}`);
      }
      if (result.outcome === 'absent') {
        if (beforeLookup.kind === 'unreadable') {
          // 読めなかったことを「居ない」と言い切らない
          return text(
            `${managerId} は止められなかった: ${result.detail}\n` +
              `止める前の状態を一覧から読めなかった（${beforeLookup.reason}）ので、` +
              '台帳にあるかどうかは分からない。manager_list で今あるものを確かめること。',
          );
        }
        if (!before) {
          return text(
            `${managerId} は居ない（id が違うか、台帳からも消えている）。` +
              'manager_list で今あるものが見える。',
          );
        }
        return text(
          `${managerId} は止められなかった: ${result.detail}\n` +
            `台帳では ${before.status} で、このデーモンからは話しかけられない（live: false）。` +
            '走らせていた器がもう無いので、止める手そのものが残っていない。',
        );
      }

      const afterLookup = await find();
      const after = afterLookup.kind === 'found' ? afterLookup.manager : undefined;
      // 読めなかったときは「消えている」と言わない
      const afterUnreadable =
        afterLookup.kind === 'unreadable'
          ? `止めた後の状態を一覧から読めなかった（${afterLookup.reason}）`
          : undefined;

      if (result.outcome === 'not_stopped') {
        return text(
          `[${managerId}] ${result.detail}\n` +
            `**止まっていない。** runner には ${managerId} のセッションがまだ残っている。` +
            `いまの状態: ${afterUnreadable ?? (after === undefined ? '一覧から消えている' : describeManagerState(after.status, after.live, after.awaitingBackground))}。` +
            ' manager_list で確かめ、必要ならもう一度止めること。',
        );
      }

      if (result.outcome === 'unknown') {
        // 「止めた」とも「止まっていない」とも言い切らない
        return text(
          `[${managerId}] ${result.detail}\n` +
            '止まったかは**未確認**である（runner に確認が取れなかった）。' +
            'manager_list で状態を確かめること。',
        );
      }

      const lines = [`[${managerId}] ${result.detail}`];

      if (before?.status === 'done') {
        // 「走っている手は無い」と断定しない: `done` はマネージャー自身のターンが終わっただけで、作業者の生存はデーモンから見えないため
        lines.push(
          'もともと待機中（done）だった仕事である。マネージャー自身のターンは終わっていたので、' +
            '畳んだのは記録である。ただし **`done` は「その下で誰も動いていない」ことまでは' +
            '意味しない** — 作業者が走っているかどうかはデーモンからは見えていない。',
        );
      }
      lines.push(
        afterUnreadable !== undefined
          ? `${afterUnreadable}。manager_list で状態を確かめること。`
          : after === undefined
            ? '一覧からも消えている。'
            : `いまの状態: ${describeManagerState(after.status, after.live, after.awaitingBackground)}。`,
      );
      // 届いていない本文を待ってこの応答を止めない: report イベントは HTTP 越しの runner では後から届くため、届いていれば抜粋を、届いていなければ `manager_report` への案内を出す
      lines.push(
        after?.lastFoldedTurn === undefined
          ? '畳んだターンの本文はまだ台帳に届いていない（別経路で後から届くことがある）。' +
              `届けば台帳へ残るので、manager_report ${managerId} で後から読めること。`
          : `畳んだターンの本文（${after.lastFoldedTurn.at} 受信）: ` +
              `${excerptLine(after.lastFoldedTurn.text, MANAGER_STOP_FOLDED_TURN_EXCERPT)} ` +
              `全文は manager_report ${managerId} で読めること。`,
      );
      return text(lines.join('\n'));
    },
  );
}
