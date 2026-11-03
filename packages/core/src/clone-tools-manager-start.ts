// マネージャーへの委譲の道具のうち `manager_start`。`clone-tools-manager.ts` の `managerTools` が並びのまま連結する。
// このファイルから `clone-tools-manager.ts` を import しない（一方向）。他の道具とも使う補助は `clone-tools-manager-describe.ts` に在る。

import { z } from 'zod';
import { readAttachmentLimits } from './attachment.js';
import {
  attachmentRefsOf,
  loadManagerAttachments,
  ManagerAttachmentsRefusedError,
} from './manager-attachments.js';
import { taskStatusForJob } from './task.js';
import { describePidsSaturation } from './runner-protocol.js';
import { reasonOf } from './dropped-record.js';
import { type ManagerSummary } from './manager.js';
import { stripNul } from './nul-guard.js';
import { type Task } from './schema.js';
import { UnreadableTaskError } from './store.js';
import { describeStringLengthViolation, formatStringLengthJa } from './tool-arg-checks.js';
import {
  text,
  tool,
  NO_POOL,
  appendJournalOrThrow,
  appendJournalOrDrop,
} from './clone-tools-common.js';
import type { ToolContext, CloneToolsShared } from './clone-tools-context.js';
import { MANAGER_ATTACHMENTS_DESCRIPTION } from './clone-tools-manager-describe.js';

// 頼んだ値を実際の値として名乗らない
function describeStartedCwd(
  manager: Pick<ManagerSummary, 'cwd' | 'cwdConfirmed' | 'requestedCwd'>,
): string {
  if (manager.cwdConfirmed !== true) {
    return `実際の cwd は未確認（頼んだ値: ${manager.cwd}）`;
  }
  if (manager.requestedCwd !== undefined) {
    return `頼んだ cwd（${manager.requestedCwd}）はこの器に無かったので、${manager.cwd} で開いた`;
  }
  return `cwd: ${manager.cwd}`;
}

export function managerStartTool(context: ToolContext, shared: CloneToolsShared) {
  const { stores, getWorkConversationId } = shared;
  return tool(
    'manager_start',
    [
      'マネージャー（あなたが起こす Claude Code）に仕事を任せる。',
      '起動して即返るので、完了を待たずに次の判断へ移ってよい。同時に何本走らせてもよい。',
      '依頼できるのは実装だけではない。調査・設計の相談・外部サービスの確認・レビューも同じように頼める。',
      'Codex に作業を頼めるマネージャーの器があれば（runner_list の peer の行）、依頼文に「Codex にやらせて」と' +
        '書けば、マネージャーが peer で Codex に頼む。その器を runnerId で名指しできる。',
      '置き先は資源で自動配置される（runner_list の説明を参照）。新しいプロセスを起こせない' +
        '（pids 飽和）と判定された器は、飽和していない器が居れば自動配置から外れる。' +
        '全台が飽和でも、runnerId で名指ししても断らず起こす——置き先が飽和と判定されていれば' +
        '応答に「⚠ 置き先の runner は pids 飽和と判定されている: 材料」の行が付くので、' +
        '落ちる前提で読むこと。',
      'failed / lost の前任の後継を立てるときは supersedes に前任の managerId を渡すこと。' +
        '渡さないと、鍵の回転で前任が起き上がって二重になりうる。' +
        '前任が終わっていない（running / waiting_human / 生きている done）と断られる——先に manager_stop で止めること。',
    ].join(' '),
    {
      request: z
        .string()
        .describe(
          `依頼内容。人間が Claude Code に書くのと同じ粒度で、背景と狙いを添えて書く（${formatStringLengthJa({ min: 1 })}。空白だけは断る）`,
        ),
      cwd: z.string().optional().describe('作業ディレクトリ。省略時はデーモンの既定'),
      attachments: z.array(z.string().min(1)).optional().describe(MANAGER_ATTACHMENTS_DESCRIPTION),
      runnerId: z
        .string()
        .optional()
        .describe(
          '置き先の器を名指しで指名する（runner_list / manager_list が出す runnerId）。' +
            'これは配置の指名であって本数の制限ではない——省略すれば資源による自動配置。' +
            '指名した器が名簿に無い・使えない・名前が重複のときは失敗し、他の器へは' +
            '自動で落とさない（返ってきた文言をそのまま読むこと）。',
        ),
      supersedes: z
        .string()
        .optional()
        .describe(
          '前任の managerId（manager_list に出ている id）。failed / lost の前任の後継を立てるときに渡す。' +
            '前任の枠で止まった印を下ろし、自動の起こし直しの対象から外す。' +
            '前任が終わっていなければ断られる（先に manager_stop で止めること）。',
        ),
      taskId: z
        .string()
        .optional()
        .describe(
          'この委譲を結び付ける task の id（task_list）。渡すと task は待ちになり、委譲が終わる・失敗する・lost になると' +
            '判断待ち（needs_decision）に戻って、報告にもこの id が付く。閉じた task と、走っている委譲が既にある task は断られる（1つの task に走らせる委譲は同時に1本まで）。' +
            '人間の依頼の task のために委譲するときは渡すこと。渡さないと task に結び付かず、起点の会話へ返答した時点で、器が task を自動で done にする。',
        ),
    },
    async (rawArgs) => {
      const { request, cwd, runnerId, attachments, supersedes, taskId } = rawArgs as unknown as {
        request: string;
        supersedes?: string | undefined;
        cwd?: string | undefined;
        attachments?: string[] | undefined;
        runnerId?: string | undefined;
        taskId?: string | undefined;
      };
      if (!context.managers) return NO_POOL;
      // 空の依頼を断る: 日誌に「起こそうとしている」と書き、runner へ何もしない依頼を渡して1本ぶんの器を使うことになるため
      const requestError = describeStringLengthViolation('request', stripNul(request), {
        min: 1,
      });
      if (requestError !== null) return text(`${requestError}起こしていない。`);
      if (stripNul(request).trim().length === 0) {
        return text('request が空白だけなので起こしていない。任せたい仕事を書いて渡すこと。');
      }
      // task は日誌にも委譲にも触れる前に確かめる: 結び付かない委譲を黙って走らせると、終わっても task が動かず、渡したつもりのクローンが気づけないため
      if (taskId !== undefined) {
        let linked: Task | null;
        try {
          linked = await stores.tasks.get(taskId);
        } catch (error) {
          if (error instanceof UnreadableTaskError) {
            return text(`task ${taskId} は読めない形で入っている。マネージャーは起こしていない。`);
          }
          throw error;
        }
        if (linked === null) {
          return text(
            `task ${taskId} は無い（task_list で実在する id を確かめること）。マネージャーは起こしていない。`,
          );
        }
        if (linked.status === 'done' || linked.status === 'cancelled') {
          return text(
            `task ${taskId} は閉じている（${linked.status}）。続きを頼むなら先に task_set_status で queued へ戻すこと。マネージャーは起こしていない。`,
          );
        }
        // 1つの task に同時に走る委譲は1本まで: 2本目が先に終わると、1本目が走っているのに task が判断待ちへ倒れる
        const running = (await stores.jobs.listJobs()).filter(
          (job) => job.taskId === taskId && taskStatusForJob(job.status) === 'waiting',
        );
        if (running.length > 0) {
          return text(
            `task ${taskId} には走っている委譲がある（${running.map((job) => `${job.id}: ${job.status}`).join('、')}）。` +
              '1つの task に同時に走らせる委譲は1本までなので、マネージャーは起こしていない。' +
              'その委譲が終わるのを待つか、manager_stop で止めてから頼むこと。' +
              '止められない（器が消えて running のまま残っている等）ときは、taskId を付けずに起こすか、task_set_status で task を動かすこと。',
          );
        }
      }
      // conversationId はクローンに渡させず呼び出し文脈から自動で読む: 手で維持する欄を新しく作らないため
      // 返信の宛先ではなく仕事の会話を読む: 報告を受けた内部ターンで続きを委譲したとき、起点が途切れないため
      const conversationId = getWorkConversationId();

      // 添付は日誌にも命令にも触れる前に読む: 見つからなければ何も送らず日誌も書かないため
      const handover = await loadManagerAttachments(
        stores,
        attachments ?? [],
        context.attachmentLimits ?? readAttachmentLimits().limits,
      );
      if (!handover.ok) return text(handover.message);
      const handedRefs = attachmentRefsOf(handover.attachments);
      const handedNote =
        handedRefs.length === 0
          ? ''
          : `（添付 ${handedRefs.length} 件を渡す: ${handedRefs.map((ref) => `${ref.id} ${ref.name}`).join(', ')}）`;

      // 日誌を先に書く: 書けなければ起こさずに道具のエラーで返すため
      await appendJournalOrThrow(
        'manager_start',
        stores.journal,
        {
          type: 'decision',
          decision: `マネージャーを起こそうとしている${
            runnerId === undefined ? '' : `（指名: runnerId=${runnerId}）`
          }${handedNote}: ${request}`,
          grounds: '委譲の判断',
        },
        'act-not-performed',
      );

      let started: ManagerSummary;
      try {
        started = await context.managers.start({
          request,
          ...(cwd === undefined ? {} : { cwd }),
          ...(runnerId === undefined ? {} : { runnerId }),
          ...(supersedes === undefined ? {} : { supersedes }),
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(taskId === undefined ? {} : { taskId }),
          ...(handover.attachments.length === 0 ? {} : { attachments: handover.attachments }),
        });
      } catch (error) {
        await appendJournalOrDrop('manager_start', stores.journal, {
          type: 'decision',
          decision: `マネージャーを起こせなかった${
            runnerId === undefined ? '' : `（指名: runnerId=${runnerId}）`
          }${handedNote}: ${request}`,
          grounds: `委譲しようとしたが、状態の変更が失敗した: ${reasonOf(error)}`,
        });
        if (error instanceof ManagerAttachmentsRefusedError) {
          return text(`${reasonOf(error)}。マネージャーは起こしていない。`);
        }
        throw error;
      }

      // 日誌より先に控える: 日誌の追記が落ちても、起こした事実は変わらない（自動 done がこの委譲を見落とさない）
      context.noteDelegationStarted?.(taskId);
      await appendJournalOrDrop('manager_start', stores.journal, {
        type: 'decision',
        decision:
          `マネージャー ${started.managerId} を起こした（${describeStartedCwd(started)}` +
          `${runnerId === undefined ? '' : `, 指名: runnerId=${runnerId}`}）${handedNote}: ${request}`,
        grounds: '委譲の判断',
      });
      // pids 飽和の置き先でも断らない: 起こしたうえで、材料つきで知らせる
      const saturation =
        started.runnerId === undefined
          ? undefined
          : context.managers.runnerPidsSaturation?.(started.runnerId);
      return text(
        `マネージャー ${started.managerId} を起こした（${describeStartedCwd(started)}、` +
          `runner: ${started.runnerId ?? '未記録'}）。` +
          '報告・質問は後から受信箱に届く。' +
          (saturation === undefined
            ? ''
            : `\n⚠ 置き先の runner は pids 飽和と判定されている: ${describePidsSaturation(saturation)}。` +
              'この委譲は新しいプロセスを起こせず落ちるかもしれない——' +
              'runner_list で他の器を見て、必要なら止めて別の器へ置き直すこと。'),
      );
    },
  );
}
