import {
  hasReportFiles,
  isExternalEvent,
  isHumanMessage,
  isManagerReport,
  isMixableSignal,
  mixableSignalChars,
  MIXED_SIGNAL_BATCH_BUDGET,
  type ExternalEvent,
  type HumanMessage,
  type ManagerReportMessage,
  type MixableSignal,
} from './clone-batch-prompts.js';
import type { CloneNotices } from './clone-notices.js';
import type { CloneRedeliveryState } from './clone-redelivery-state.js';
import { inboxEventShape, noteDroppedRecord } from './dropped-record.js';
import { inboxBacklogDedupeKey } from './inbox-backlog.js';
import type { Inbox } from './inbox.js';
import type { InboxEvent } from './schema.js';
import { describeMergedBatchTruncation } from './clone-turn-input-text.js';

// 上限を外さない: `drainWhile` に上限が無く、外すと起動直後に拾い直した在庫（報告369件など）が全部1本のプロンプトへ連結されるため
// 環境変数では差し替えない（読んでいた `ALTEROID_MERGED_BATCH_SIZE_LIMIT` は外した。`retired-env.ts`）。試験は `createClone` の `mergedBatchLimit` で小さくする
export const MERGED_BATCH_SIZE_LIMIT = 50;

/**
 * `Clone` が協力者へ渡す口。読むものは「呼ばれるまで読まない関数」で渡す（`#mergedBatchLimit` は constructor の中で入る）。
 * 全部同期: `#pump` の `await` の段を増やさないため。
 */
export interface CloneBatchMergePorts {
  /** `Clone` の `#mergedBatchLimit` */
  mergedBatchLimit(): number;
  /** `Clone` の `#delivery.inbox`（`drainWhile`・`countWhile` だけ読む） */
  inbox(): Pick<Inbox, 'drainWhile' | 'countWhile'>;
  /** `Clone` の `#delivery.redeliveryState`（`get` だけ読む） */
  redeliveryState(): Pick<CloneRedeliveryState, 'get'>;
  /** `Clone` の `#heldForUsage`。同じ Set を参照で受ける（コピーしない: 枠で保持した id の出入りを `Clone` 側が書くため。`has` だけ読む） */
  readonly heldForUsage: ReadonlySet<string>;
  /** `Clone` の `#notices`（`mergedBatchTruncation` を書く1箇所だけ） */
  readonly notices: Pick<CloneNotices, 'set'>;
}

/**
 * `external` の束ね鍵。`#foldPendingTokenPoolNotice`・`#restoreUnreadPass` も呼ぶので、協力者の外の自由関数にしてある。
 * 状態を持たず、`noteDroppedRecord` の跡を残す副作用だけ。
 */
// 跡に本文は残さない: `noteDroppedRecord` の「本文を出さない」約束を守るため
export function externalMergeKey(event: InboxEvent): string | null {
  try {
    return inboxBacklogDedupeKey(event);
  } catch (error) {
    noteDroppedRecord('external の束ね鍵の計算', inboxEventShape(event), error);
    return null;
  }
}

/**
 * 待ち行列の先頭から連続している合図を、1ターンの束にまとめる判定と取り出し（`Clone` の `#pump` が束ごとに呼ぶ）。
 * 状態は持たない（上限・待ち行列・枠で保持した id・配り直しの控え・断り書きの置き場は口から読み書きする）。
 */
export class CloneBatchMerge {
  readonly #ports: CloneBatchMergePorts;

  constructor(ports: CloneBatchMergePorts) {
    this.#ports = ports;
  }

  // 報告（`report`）をこの関数でまとめない: 対象・宛先の決め方・組み立てる本文が違うので `mergedManagerReportBatch` に分けてある。会話が違う発言と枠で保持した合図はまとめない: 応答の宛先が1つに決まらず、束ねると再試行1回が何件ぶんの仕事かが変わるため
  mergedHumanBatch(event: InboxEvent): HumanMessage[] | null {
    if (event.type !== 'human_message') return null;
    if (!this.mergeable(event)) return null;

    // 先頭から連続している分だけ集める: 間に別の起点が挟まっているのを飛び越えると、並んでいる順に読むという約束が崩れるため
    const rest = this.drainMergeableWithinLimit(
      (queued) => queued.type === 'human_message' && queued.conversationId === event.conversationId,
    );
    // 1件だけなら `null` を返す: まとめる側へ寄せると、いちばん多い「1件だけ」の本文に断り書きが載る形になるため
    if (rest.length === 0) return null;
    return [event, ...rest.filter(isHumanMessage)];
  }

  // `question` / `permission` はまとめない: 返事を待つ相手（`requestId`）が1件ごとに違いうるため。同じ `managerId` に限る: 複数のマネージャーを混ぜると「誰からの何件か」が言えなくなるため
  mergedManagerReportBatch(event: InboxEvent): ManagerReportMessage[] | null {
    if (!isManagerReport(event)) return null;
    if (!this.mergeable(event)) return null;

    const rest = this.drainMergeableWithinLimit(
      (queued) => isManagerReport(queued) && queued.managerId === event.managerId,
    );
    if (rest.length === 0) return null;
    return [event, ...rest.filter(isManagerReport)];
  }

  // `source` だけでなく `payload` まで一致を条件にする: 中身の違う合図まで混ぜると、重要な1件が同じ出所の重複の中に埋もれるため
  // 「中身が同じか」は `inboxBacklogDedupeKey` を再利用して独自の比較を書かない: 畳み込みの鍵が2つに割れるため
  // 鍵が作れない場合は束ねない: `JSON.stringify` が投げうり、この関数は `#pump` の `try` の外で呼ばれるので、投げると受信箱のループが死ぬため
  mergedExternalBatch(event: InboxEvent): ExternalEvent[] | null {
    if (event.type !== 'external') return null;
    if (!this.mergeable(event)) return null;

    const key = externalMergeKey(event);
    if (key === null) return null;

    // `queued.type === 'external'` は鍵と重複するが残す: TypeScript は文字列の一致から型を絞れないため
    const rest = this.drainMergeableWithinLimit(
      (queued) => queued.type === 'external' && externalMergeKey(queued) === key,
    );
    if (rest.length === 0) return null;
    return [event, ...rest.filter(isExternalEvent)];
  }

  /**
   * 起点の違う合図（別々の担当からの報告・質問・確認、外部イベント）を、待ち行列の先頭から連続している分だけ1ターンにまとめる。
   * 1件ずつ別のターンで読むと、合図の数だけ長い文脈をまるごと読み直すことになり、それが費用の大半だったため（2026-10-26、トークン節約の依頼〈会話 3d91a736〉と承認 a6048e8a に基づく teto の決め。architecture.md「同時実行モデル」）。
   * 束ねないもの: 人間の発言と人間の回答（返事の行き先が会話ごとに違う。挟まったらそこで止まる）・タイマーなど別の起点（止まる）・
   * 枠で保持した合図（`mergeable`）・配り直し（`redeliveryState`）・添付を持つ合図（画像の予算が束の中で割り振れないため）。
   */
  // 字数の予算を超える分は束に入れず次のターンへ回す（束の中で本文を省かない）: 省くと、質問・確認が requestId ごと見えなくなるため
  mixedSignalBatch(event: InboxEvent): MixableSignal[] | null {
    if (!this.mixable(event)) return null;
    const rest = this.drainMixableWithinBudget(mixableSignalChars(event), 1);
    if (rest.length === 0) return null;
    return [event, ...rest.filter(isMixableSignal)];
  }

  /**
   * 同じ担当の報告の束（`mergedManagerReportBatch`）の続きに、混合の束に入る合図が連続しているときは、1つの混合の束にまとめる。
   * 広げるのは「同じ担当の束がすべて混合の束の条件を満たし、本文の合計が予算に収まる」ときだけ: 収まらない束は、古い側を省く従来の同じ担当の束の本文のまま（混合は予算超過分を次のターンへ回すので、扱いが違う）。
   * 続きが無ければ `null`（従来の同じ担当の束をそのまま使う）。
   */
  extendReportBatchToMixed(reports: ManagerReportMessage[]): MixableSignal[] | null {
    if (!reports.every((report) => this.mixable(report))) return null;
    const total = reports.reduce((sum, report) => sum + mixableSignalChars(report), 0);
    if (total > MIXED_SIGNAL_BATCH_BUDGET) return null;
    const rest = this.drainMixableWithinBudget(total, reports.length);
    if (rest.length === 0) return null;
    return [...reports, ...rest.filter(isMixableSignal)];
  }

  drainMixableWithinBudget(initialTotal: number, alreadyTaken: number): InboxEvent[] {
    let total = initialTotal;
    return this.drainMergeableWithinLimit((queued) => {
      if (!this.mixable(queued)) return false;
      const chars = mixableSignalChars(queued);
      if (total + chars > MIXED_SIGNAL_BATCH_BUDGET) return false;
      total += chars;
      return true;
    }, alreadyTaken);
  }

  mixable(event: InboxEvent): event is MixableSignal {
    if (!isMixableSignal(event)) return false;
    if (!this.mergeable(event)) return false;
    if (this.#ports.redeliveryState().get(event.id) !== undefined) return false;
    return event.type === 'manager_message'
      ? !hasReportFiles(event)
      : (event.attachments?.length ?? 0) === 0;
  }

  // `1` から数え始める: 呼び出し元が `event` 自身を先頭に足すので、`taken` を `0` から始めると上限より1件多く束ねるため
  // 「本当に届いた件数」とは名乗らない: 処理済みの分は待ち行列に残っておらず測りようがなく、言えるのは待ち行列の先頭に残っている件数だけのため
  // `alreadyTaken` は既に束に入っている件数（同じ担当の束を混合へ広げるときの続きの数え始め）
  drainMergeableWithinLimit(
    predicate: (queued: InboxEvent) => boolean,
    alreadyTaken = 1,
  ): InboxEvent[] {
    const limit = this.#ports.mergedBatchLimit();
    let taken = alreadyTaken;
    const matchesRule = (queued: InboxEvent): boolean =>
      predicate(queued) && this.mergeable(queued);
    const rest = this.#ports.inbox().drainWhile((queued) => {
      if (taken >= limit) return false;
      const matches = matchesRule(queued);
      if (matches) taken += 1;
      return matches;
    });
    // `rest.length === 0` でも計算する: `limit === 1` だと `rest` は必ず空になるが、待ち行列の先頭に同じ束に入るはずだった合図は残りうるため
    const remainingHead = this.#ports.inbox().countWhile(matchesRule);
    if (remainingHead > 0) {
      this.#ports.notices.set(
        'mergedBatchTruncation',
        describeMergedBatchTruncation(
          {
            limit,
            batchSize: taken,
            remainingHead,
          },
          Date.now(),
        ),
      );
    }
    return rest;
  }

  // `#heldForUsage` は外したままにする: 再試行は「新しい合図1件につき高々1回」で、束ねるとその1回が何件ぶんの仕事かが変わるため
  mergeable(event: InboxEvent): boolean {
    return !this.#ports.heldForUsage.has(event.id);
  }
}
