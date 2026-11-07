import { randomUUID } from 'node:crypto';

import { describeSelectionsViolation, foldSelections } from './approval-choices.js';
import {
  delegatedPermissionRuleOf,
  type DelegatedPermissionRuleService,
} from './delegated-permission-rules.js';
import { inboxEventShape, noteDroppedRecord } from './dropped-record.js';
import { collapseErrorCause } from './error-cause.js';
import { EXCHANGE_KIND_DECISION_PREFIX } from './exchange-kind.js';
import type { AnswerApprovalVia } from './host.js';
import { stripNul } from './nul-guard.js';
import { PERMISSION_GRANT_CONSENT_PHRASE } from './schema.js';
import type {
  ApprovalSelection,
  InboxEvent,
  JournalEntryInput,
  PendingApproval,
  PermissionGrant,
} from './schema.js';
import type { Stores } from './store.js';

export class ApprovalAlreadySettledError extends Error {
  constructor(
    readonly approvalId: string,
    readonly settled: 'answered' | 'withdrawn',
  ) {
    super(
      `承認待ち ${approvalId} は既に${settled === 'answered' ? '回答済み' : '取り下げ済み'}なので、回答しなかった`,
    );
    this.name = 'ApprovalAlreadySettledError';
  }
}

export class InvalidApprovalSelectionsError extends Error {
  constructor(
    readonly approvalId: string,
    readonly reason: string,
  ) {
    super(`承認待ち ${approvalId} への selections が不正なので、回答しなかった: ${reason}`);
    this.name = 'InvalidApprovalSelectionsError';
  }
}

// id はランダムにしない: `CloneApprovalAnswers#reconcileUndelivered` が同じ入力から同じ id を再現し、`InboxStore#put` の上書きで二重配達を避けるため
function humanAnswerEventId(approvalId: string, answeredAt: string): string {
  return `human-answer-${approvalId}-${answeredAt}`;
}

function buildHumanAnswerEvent(
  approval: Pick<PendingApproval, 'id' | 'conversationId'>,
  answer: string,
  answeredAt: string,
  via: AnswerApprovalVia | undefined,
  selections?: readonly ApprovalSelection[],
): Extract<InboxEvent, { type: 'human_answer' }> {
  return {
    type: 'human_answer',
    id: humanAnswerEventId(approval.id, answeredAt),
    at: answeredAt,
    approvalId: approval.id,
    answer,
    ...(selections === undefined ? {} : { selections: [...selections] }),
    ...(approval.conversationId === undefined ? {} : { conversationId: approval.conversationId }),
    ...(via === undefined ? {} : { answeredVia: via }),
  };
}

/**
 * `Clone` が協力者へ渡す口。
 * 口の戻りは Promise を直に返す（`(entry) => this.#journal(entry)`）: 間に `async` の関数を挟むと `await` の段が増え、
 * 回答の書き込みの順（`answerApproval`）と、起動時の拾い直し（`#restoreUnread`）の時機が動く。
 */
export interface CloneApprovalAnswersPorts {
  /** `Clone` の `#stores`。構築の途中でこの協力者を作るので、値ではなく読む関数にする（`#stores` は constructor の中で入る） */
  stores(): Pick<Stores, 'jobs' | 'inbox' | 'journal' | 'permissionGrants'>;
  /** `Clone` の `#journal`（書けなくても握る版） */
  journal(entry: JournalEntryInput): Promise<void>;
  /** `Clone` の `post` */
  post(event: InboxEvent): void;
  /** `Clone` の `#permissionRuleService`（無いこともある） */
  permissionRuleService(): DelegatedPermissionRuleService | undefined;
  /** `Clone` の `#untilStopped`（`#claimPendingUntilStopped` と共用なので `Clone` に残る） */
  untilStopped<T>(label: string, read: () => Promise<T>): Promise<T | undefined>;
  /** `Clone` の `#bootedAt` */
  bootedAt(): string;
}

/**
 * 人間の承認への回答の配達と、許可の記録を持つ協力者。
 * 状態は持たない（口越しにストアと `Clone` を読み書きするだけ）。
 * 公開メソッドは `answer`（`Clone#answerApproval` の本体）・`markDeliveredOnHandle`（`#handleHumanAnswer` から）・
 * `reopenDeliveryAfterFailure`（`#settleTurn` から）・`reconcileUndelivered`（`#restoreUnread` から）。
 */
export class CloneApprovalAnswers {
  readonly #ports: CloneApprovalAnswersPorts;

  constructor(ports: CloneApprovalAnswersPorts) {
    this.#ports = ports;
  }

  async answer(
    approvalId: string,
    suppliedAnswer: string,
    via?: AnswerApprovalVia,
    selections?: readonly ApprovalSelection[],
  ): Promise<void> {
    // `UnreadableApprovalError` をそのまま出す: 「存在しない」に畳むと、呼び手が「在るが読めない」（HTTP は 409）と言えなくなるため
    const approval = await this.#ports.stores().jobs.getApproval(approvalId);
    if (!approval) throw new Error(`承認待ち ${approvalId} は存在しない`);

    let answer = suppliedAnswer;
    if (selections !== undefined) {
      const violation = describeSelectionsViolation(approval.questions, selections, suppliedAnswer);
      if (violation !== null) throw new InvalidApprovalSelectionsError(approvalId, violation);
      answer = foldSelections(approval.questions ?? [], selections, suppliedAnswer);
    }

    const answeredAt = new Date().toISOString();
    // `answerDelivery: 'pending'` を先に書く: 受信箱への永続化までの間に落ちた行を、`reconcileUndelivered` が起動時に拾い直すため
    // `getApproval` の写しを `putApproval` で書き戻さない: 回答済み・取り下げ済みを見ないまま回答が立ち、同じ承認への2つの回答が両方通る（仕事が2回再開しうる）ため
    let settled: 'answered' | 'withdrawn' | undefined;
    const written = await this.#ports.stores().jobs.updateApproval(approvalId, (current) => {
      if (current.withdrawnAt !== undefined) {
        settled = 'withdrawn';
        return null;
      }
      if (current.answeredAt !== undefined) {
        settled = 'answered';
        return null;
      }
      return {
        ...current,
        answeredAt,
        answer,
        ...(selections === undefined ? {} : { selections: [...selections] }),
        answerDelivery: 'pending',
        ...(via === undefined ? {} : { answeredVia: via }),
      };
    });
    if (written === null) {
      if (settled !== undefined) throw new ApprovalAlreadySettledError(approvalId, settled);
      throw new Error(`承認待ち ${approvalId} は存在しない`);
    }

    await this.#ports.journal({
      type: 'escalation',
      question: approval.question,
      approvalId,
      answeredAt,
      answer,
      ...(via === undefined ? {} : { answeredVia: via }),
    });

    await this.#recordPermissionGrantIfConsented(approval, answer, answeredAt, via);

    const event = buildHumanAnswerEvent(approval, answer, answeredAt, via, selections);

    // 失敗しても投げない: ここは落ちたときの保険であり、ライブ配達（`post()`）を止める理由にならないため
    let delivery: 'pending' | 'delivered' = 'pending';
    try {
      await this.#ports.stores().inbox.put(event, event.at);
      delivery = 'delivered';
    } catch (error) {
      noteDroppedRecord('回答の配達印の先出し', inboxEventShape(event), error);
    }

    // 先出しが成功した回だけ配達済みの印を立てる: 失敗したまま立てると、受信箱に無いのに「配達済み」の行ができ、`reconcileUndelivered` が二度と拾い直さなくなるため
    if (delivery === 'delivered') {
      try {
        await this.#markAnswerDelivered(approvalId, answeredAt);
      } catch (error) {
        noteDroppedRecord('回答の配達印の確定', inboxEventShape(event), error);
      }
    }

    this.#ports.post(event);
  }

  // `via.kind === 'operator'` や `via === undefined` では記録しない: operator の token はクローン自身の Bash からも読め、クローンが `answer` を偽造できて人間の証拠にならないため
  // 記録に失敗しても投げない（日誌が書けない場合も同じ）: 許可の記録は副産物で、人間への回答という主作用を巻き込まないため
  async #recordPermissionGrantIfConsented(
    approval: PendingApproval,
    rawAnswer: string,
    answeredAt: string,
    via: AnswerApprovalVia | undefined,
  ): Promise<void> {
    const { permissionRequest } = approval;
    if (permissionRequest === undefined) return;

    // 同意の判定は NUL を落とした後の値で行う: 落とす前の値だと、行に残る値は定型文ちょうどなのに許可が記録されず、保存後の値を読む起動時の拾い直しと結果が食い違うため
    const answer = stripNul(rawAnswer);

    const grounds = `approvalId=${approval.id}・rule=${permissionRequest.rule}`;

    if (answer.trim() !== PERMISSION_GRANT_CONSENT_PHRASE) {
      await this.#ports.journal({
        type: 'decision',
        decision: `許可を記録しなかった: ${permissionRequest.rule}`,
        grounds: `回答が定型文（${PERMISSION_GRANT_CONSENT_PHRASE}）と一致しない（${grounds}）`,
      });
      return;
    }
    if (via === undefined) {
      await this.#ports.journal({
        type: 'decision',
        decision: `許可を記録しなかった: ${permissionRequest.rule}`,
        grounds: `回答の経路が指定されていない——既定は不許可（${grounds}）`,
      });
      return;
    }
    if (via.kind !== 'account') {
      await this.#ports.journal({
        type: 'decision',
        decision: `許可を記録しなかった: ${permissionRequest.rule}`,
        grounds:
          `回答の経路が実行環境の持ち主（operator。認証: ${via.auth}）だった——operator の資格は` +
          `クローンの器から読めるため、人間の証拠にならない（${grounds}）`,
      });
      return;
    }

    const grant: PermissionGrant = {
      id: randomUUID(),
      rule: permissionRequest.rule,
      allows: permissionRequest.allows,
      denies: permissionRequest.denies,
      approvalId: approval.id,
      answer,
      grantedAt: answeredAt,
      route: { principalKind: 'account', accountId: via.accountId },
    };
    // 日誌を先に書く: 許可は能力を広げる変更（分類器の判定より先に効く）なので、日誌に1行も無いまま効く窓を作らない。
    // 口の `journal` は書けなくても握って捨てるので使わず、`stores` の日誌を直に呼ぶ: 書けたかを知る必要があるため
    // 書けなければ許可だけ書かない: 人間への回答（主作用）は止めず、回答を受けたクローンへの知らせにも許可の結果は載せていない（本文は回答そのもの）
    try {
      await this.#ports.stores().journal.append({
        type: 'decision',
        decision: `許可を記録する: ${permissionRequest.rule}`,
        grounds: `許可されたアカウント（${via.accountId}）の回答（${grounds}）`,
      });
    } catch (error) {
      noteDroppedRecord(
        '許可の記録（日誌に書けないので許可を記録しなかった）',
        `approvalId=${approval.id}・rule=${permissionRequest.rule}`,
        error,
      );
      return;
    }
    try {
      await this.#ports.stores().permissionGrants.put(grant);
    } catch (error) {
      // 先の「許可を記録する」の行を打ち消す: 許可が無いのに「記録する」だけが残ると事実と食い違うため
      await this.#ports.journal({
        type: 'decision',
        decision: `直前の「許可を記録する」の行は効いていない（許可の記録に失敗した）: ${permissionRequest.rule}`,
        grounds: `${collapseErrorCause(error)}（${grounds}）`,
      });
      return;
    }
    // 委譲先へ配る（#4952）。前方一致も載せる（#5435）。載せない形の許可（`*` を含む prefix・空の prefix など）では配らない: 一覧は変わらないため
    // 待たない: 人間への回答という主作用を runner との往復で遅らせないため。配れなくても許可の記録は済んでいる（配れなかったことはサービスが日誌に残す）
    if (delegatedPermissionRuleOf(grant.rule) !== undefined) {
      void this.#ports
        .permissionRuleService()
        ?.pushAll(`許可 ${grant.id} が記録された（人間の request_permission への回答）`)
        .catch(() => undefined);
    }
  }

  // 読み直す1操作（`updateApproval`）で `answerDelivery` だけを書き換える: 読んだ写しで行を丸ごと書き戻すと、その間に入った取り下げ・2回目の回答を古い写しで消すため。現在の行が `'pending'` で `answeredAt` が同じときだけ書く
  async #markAnswerDelivered(approvalId: string, answeredAt: string): Promise<void> {
    await this.#ports
      .stores()
      .jobs.updateApproval(approvalId, (current) =>
        current.answerDelivery === 'pending' && current.answeredAt === answeredAt
          ? { ...current, answerDelivery: 'delivered' }
          : null,
      );
  }

  // 処理した時点で印を付け直す: 印の書き込みだけが落ちると `'pending'` のまま残り、起こし直しで空になる `#handledHumanAnswerIds` では二重配達を畳めず、起動時の拾い直しが同じ回答をもう一度配るため（約束は「少なくとも1回」で、回答を失うより二重に届く方が害が小さい）。書き込みの失敗は握って跡を残す
  async markDeliveredOnHandle(
    approval: PendingApproval | null,
    event: Extract<InboxEvent, { type: 'human_answer' }>,
  ): Promise<void> {
    if (approval === null || approval.answerDelivery !== 'pending') return;
    if (approval.answeredAt === undefined) return;
    if (humanAnswerEventId(approval.id, approval.answeredAt) !== event.id) return;
    try {
      await this.#markAnswerDelivered(approval.id, approval.answeredAt);
    } catch (error) {
      noteDroppedRecord('回答の配達印の確定（処理時）', inboxEventShape(event), error);
    }
  }

  // 枠以外の理由で失敗したターンに渡した回答は、配達の印を `'pending'` へ戻して起動時の拾い直し（`reconcileUndelivered`）に載せる（#4633）。
  // 回答だけを戻す: 人間の発言は消えても Task に残るが、回答は消えると、確認を出して止まった担当を再開させる経路そのものが切れるため。
  // 報告（manager_message）は P5 から Task に自動では載らない: 報告を読むターンが例外で終わって合図が受信箱から消えると、拾い直す網はもう無い（#5469 P5。既知の限界）。
  // 回数の上限は置かない: 決定的に失敗する回答は器の入れ替えのたびにターンを1本焼くが、戻すたびに日誌へ1行残し、人間が気づけるようにする（オーナーの判断、2026-10-14）。
  // 戻すのは、いまの行がこの合図を `'delivered'` にした回答のままのときだけ: その間に取り下げ・2回目の回答が入っていれば、古い合図で巻き戻さないため
  async reopenDeliveryAfterFailure(
    event: Extract<InboxEvent, { type: 'human_answer' }>,
  ): Promise<void> {
    let reopened = false;
    try {
      await this.#ports.stores().jobs.updateApproval(event.approvalId, (current) => {
        if (current.answerDelivery !== 'delivered' || current.answeredAt === undefined) {
          return null;
        }
        if (humanAnswerEventId(current.id, current.answeredAt) !== event.id) return null;
        reopened = true;
        return { ...current, answerDelivery: 'pending' };
      });
    } catch (error) {
      noteDroppedRecord('失敗したターンの回答の配達印の差し戻し', inboxEventShape(event), error);
      return;
    }
    if (!reopened) return;
    await this.#journalSelf(
      'outbound',
      `${EXCHANGE_KIND_DECISION_PREFIX}人間の回答（承認 ${event.approvalId}）を渡したターンが枠以外の理由で失敗したので、` +
        '配達の印を未配達（pending）へ戻した。次の起動（器の入れ替え）の拾い直しでもう一度配る。' +
        '同じ承認でこの行が何度も出るなら、その回答の処理は決定的に失敗している。',
    );
  }

  // `Clone#restoreUnreadPass` の前に置かない: 前で `await` すると `claimPending()` の時機が1往復遅れ、直後に `post()` された合図を「前の器の未読」として拾って同じ合図を2回配達へ乗せるため
  // 古い行（`answerDelivery` を持たない）は対象にしない: 遡って配り直すと、とっくに人間の目から消えた古い回答が今さら届くため
  // `claimedIds` に載っている行には印を付けるだけにする: 直前の `Clone#restoreUnreadPass` が配達の管轄に入れており、`inbox.put` も `post()` も重ねない（二重配達を避ける）。載っていない行だけ `post()` を呼ぶ
  async reconcileUndelivered(claimedIds: ReadonlySet<string>): Promise<void> {
    // 読めるまでやり直す（#4647 の `claimPending` と同じ理由）: 1回の失敗で諦めると、人間の回答は次の再起動まで配られず、担当は確認待ちのまま止まるため
    const list = await this.#ports.untilStopped('回答済み未配達の承認の読み直し', () =>
      this.#ports.stores().jobs.listApprovals({ pendingOnly: false }),
    );
    if (list === undefined) return;
    const approvals = list.entries;
    if (list.unreadable.length > 0) {
      noteDroppedRecord(
        `読めない承認待ち ${list.unreadable.length} 件の回答済み未配達の拾い直し`,
        '',
        new Error('行が読めない形で入っている。行は書き換えていない'),
      );
    }

    const undelivered = approvals.filter(
      (approval): approval is PendingApproval & { answeredAt: string; answer: string } =>
        approval.answeredAt !== undefined &&
        approval.answer !== undefined &&
        approval.answerDelivery === 'pending' &&
        approval.withdrawnAt === undefined &&
        approval.answeredAt < this.#ports.bootedAt(),
    );
    if (undelivered.length === 0) return;

    let reconciled = 0;
    for (const approval of undelivered) {
      const event = buildHumanAnswerEvent(
        approval,
        approval.answer,
        approval.answeredAt,
        approval.answeredVia,
        approval.selections,
      );
      // 配達より先に許可の記録を作り直す: 落ちた窓は `answer` の許可の記録より前にありうるので、配達だけ埋めると同意が黙って消えるため
      await this.#reconcilePermissionGrant(approval);
      try {
        if (claimedIds.has(event.id)) {
          await this.#markAnswerDelivered(approval.id, approval.answeredAt);
        } else {
          await this.#ports.stores().inbox.put(event, event.at);
          // 印の失敗は握って跡を残し、配達（`post()`）は止めない: 止めると次の再起動まで人間の回答が配られず、担当が確認待ちのまま止まるため。`'pending'` のまま残れば再起動で同じ回答がもう一度配られうるが、`inbox.put` は同じ id の上書きで、約束は「少なくとも1回」
          try {
            await this.#markAnswerDelivered(approval.id, approval.answeredAt);
          } catch (markError) {
            noteDroppedRecord(
              '回答の配達印の確定（拾い直し時）',
              inboxEventShape(event),
              markError,
            );
          }
          this.#ports.post(event);
        }
        reconciled += 1;
      } catch (error) {
        noteDroppedRecord('回答済み未配達の承認の拾い直し', inboxEventShape(event), error);
      }
    }

    if (reconciled > 0) {
      // 新しい `type: 'exchange'` の書き込み箇所は増やさず `type: 'decision'` を使う: `exchange-kind-coverage.test.ts` の分類表（`KINDS_BY_ENCLOSING`）に行を足さずに済ませるため
      await this.#ports.journal({
        type: 'decision',
        decision: `回答済みで未配達の承認を拾い直した（${reconciled} 件）`,
        grounds:
          '起動時、承認の行が answerDelivery=pending のまま残っていた' +
          '（issue #1977。プロセスが answerApproval の途中で落ちた痕跡）。',
      });
    }
  }

  // 呼び直すのは許可の記録の前提を満たす承認だけ: 満たさない承認で呼ぶと「記録しなかった」の日誌が二重に出るため。その `approvalId` の許可の記録が既に在れば何もしない: 落ちたのが記録の後だった場合に二重にしないため。失敗は握って、配達の拾い直しは止めない
  async #reconcilePermissionGrant(
    approval: PendingApproval & { answeredAt: string; answer: string },
  ): Promise<void> {
    if (approval.permissionRequest === undefined) return;
    if (approval.answer.trim() !== PERMISSION_GRANT_CONSENT_PHRASE) return;
    if (approval.answeredVia?.kind !== 'account') return;
    try {
      const grants = await this.#ports.stores().permissionGrants.list();
      if (grants.some((grant) => grant.approvalId === approval.id)) return;
      await this.#recordPermissionGrantIfConsented(
        approval,
        approval.answer,
        approval.answeredAt,
        approval.answeredVia,
      );
    } catch (error) {
      noteDroppedRecord(
        '回答済み未配達の承認の許可の記録の拾い直し',
        `approvalId=${approval.id}`,
        error,
      );
    }
  }

  // `Clone` の `#journalSelf` と同じ形で置く（走査の試験は、この private な helper の呼び出しの字面を数える。口を直に呼ぶ字面だと拾わない）。
  // async にせず口の Promise をそのまま返す: `await` / `void` の呼び出し側のタイミングを変えない。
  // 接頭辞（EXCHANGE_KIND_*_PREFIX）は呼び出し箇所の text に字面で置く（exchange-kind-coverage.test.ts が第2引数を走査する）。
  #journalSelf(role: 'inbound' | 'outbound', text: string): Promise<void> {
    return this.#ports.journal({ type: 'exchange', with: 'self', role, text });
  }
}
