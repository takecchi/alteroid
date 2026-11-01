import { readAttachmentLimits, type AttachmentStore } from './attachment.js';
import { estimateAttachmentBodyBytes } from './manager-attachments.js';
import { outboxFetchDeadlineMs } from './manager-outbox-fetch.js';
import { reasonOf } from './dropped-record.js';
import { runnerAttachmentBodyLimit } from './runner-attachments.js';
import {
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS,
  RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE,
} from './runner-protocol.js';
import type { RunnerAttachment, RunnerClient } from './runner-protocol.js';

/**
 * `Pool` が口として渡すもの。`awaitHello` は「hello を受けるまで少し待つ」、`hasCapability` は名乗りの記憶を読むだけ。
 * `openAttachment` は呼ぶたびに置き場を引く（置き場を握らない: 呼び出しの時点の `stores.attachments` を使う）。
 */
export interface AttachmentStagerPorts {
  awaitHello: (runnerId: string) => Promise<boolean>;
  hasCapability: (runnerId: string, capability: string) => boolean;
  openAttachment: (id: string) => ReturnType<AttachmentStore['open']>;
}

/**
 * 添付を runner へ載せる前の断り判定と、大きいファイルの下ろし（`Pool` から切り出した。振る舞いは変えていない）。
 * 上限は hello が名乗ったものだけを持つ（{@link AttachmentStager.noteHello}）。
 */
export class AttachmentStager {
  readonly #ports: AttachmentStagerPorts;
  /** 名乗らない器は持たない。 */
  readonly #bodyLimits = new Map<string, number>();
  /** 名乗らない器は持たない。 */
  readonly #stageLimits = new Map<string, number>();

  constructor(ports: AttachmentStagerPorts) {
    this.#ports = ports;
  }

  /** hello が上限を名乗らないときは前の値を消す（同じ runnerId の器が入れ替わって版が下がりうるので持ち越さない）。 */
  noteHello(runnerId: string, bodyLimit: number | undefined, stageLimit: number | undefined): void {
    if (bodyLimit === undefined) {
      this.#bodyLimits.delete(runnerId);
    } else {
      this.#bodyLimits.set(runnerId, bodyLimit);
    }
    if (stageLimit === undefined) {
      this.#stageLimits.delete(runnerId);
    } else {
      this.#stageLimits.set(runnerId, stageLimit);
    }
  }

  /** 名乗らない版（旧い runner）は `attachments` 欄を黙って捨てて 200 を返すので、送らずに断る。 */
  async refusal(
    runner: RunnerClient,
    attachments: readonly RunnerAttachment[],
    text: string,
  ): Promise<string | undefined> {
    await this.#ports.awaitHello(runner.runnerId);
    if (this.#ports.hasCapability(runner.runnerId, RUNNER_CAPABILITY_MANAGER_ATTACHMENTS)) {
      // 大きいファイルを黙って落とさない: 受け手が名乗っていない・上限を超える・押す口が無いときは、理由を言って何も送らない。
      for (const item of attachments) {
        if (item.staged !== true) continue;
        const label = `${item.id}（${item.name}, ${item.size} バイト）`;
        if (
          !this.#ports.hasCapability(runner.runnerId, RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE)
        ) {
          return (
            `大きいファイル ${label} は、runner（runnerId=${runner.runnerId}）が大きいファイルの受け取り` +
            `（${RUNNER_CAPABILITY_MANAGER_ATTACHMENTS_STAGE}）を名乗っていない（旧い版か、名乗りをまだ受けていない）ので下ろせない`
          );
        }
        const stageLimit = this.#stageLimits.get(runner.runnerId);
        if (stageLimit === undefined || item.size > stageLimit) {
          return (
            `大きいファイル ${label} は、runner（runnerId=${runner.runnerId}）が受けられる大きさ` +
            `（${stageLimit === undefined ? '上限を名乗っていない' : `上限 ${stageLimit} バイト`}）を超えるので下ろせない`
          );
        }
        if (runner.stageAttachment === undefined) {
          return `大きいファイル ${label} を押す口を、この runner への接続（runnerId=${runner.runnerId}）が持っていない`;
        }
      }
      const named = this.#bodyLimits.get(runner.runnerId);
      const limit = named ?? runnerAttachmentBodyLimit(readAttachmentLimits().limits);
      const estimate = estimateAttachmentBodyBytes(attachments, text);
      if (estimate > limit) {
        return (
          `添付を載せた本文の見積もり ${estimate} バイトが、runner（runnerId=${runner.runnerId}）の上限 ` +
          `${limit} バイトを超える（${named === undefined ? '上限を名乗らない版なので、デーモン側の既定値' : 'runner が名乗った値'}）。` +
          '添付を減らすか、小さくして送り直すこと'
        );
      }
      return undefined;
    }
    return (
      `runner（runnerId=${runner.runnerId}）は担い手への添付の受け渡しを名乗っていない` +
      '（旧い版か、名乗りをまだ受けていない）。添付は黙って捨てられるので送らない'
    );
  }

  /** 押す向きの経路だけにする: runner からデーモンへ取りに行く経路は作らない。失敗したら命令を送らずに断る理由を返す。 */
  async stage(
    runner: RunnerClient,
    managerId: string,
    attachments: readonly RunnerAttachment[],
  ): Promise<string | undefined> {
    for (const item of attachments) {
      if (item.staged !== true) continue;
      const label = `${item.id}（${item.name}, ${item.size} バイト）`;
      const stage = runner.stageAttachment?.bind(runner);
      if (stage === undefined) return `大きいファイル ${label} を押す口が無い`;
      // 期限は1つずつのファイルに掛ける。応答しない runner を最長1時間（runner 側の持ち時間）待たない
      const deadlineMs = outboxFetchDeadlineMs(item.size);
      const signal = AbortSignal.timeout(deadlineMs);
      const timedOut = `大きいファイル ${label} を runner へ下ろせなかった: 時間の上限（${Math.round(deadlineMs / 100) / 10} 秒）を超えた`;
      let opened: Awaited<ReturnType<AttachmentStore['open']>>;
      try {
        opened = await this.#ports.openAttachment(item.id);
        if (opened === undefined) {
          return `大きいファイル ${label} は読む間に置き場から消えた（保持期限）`;
        }
        const pushing = stage(
          managerId,
          {
            id: item.id,
            name: item.name,
            mediaType: item.mediaType,
            size: item.size,
            sha256: item.sha256,
          },
          opened.stream,
          { signal },
        );
        // `signal` を見ない実装でも期限で抜ける（遅れた拒否は握る）
        pushing.catch(() => undefined);
        const aborted = new Promise<'aborted'>((resolve) => {
          signal.addEventListener('abort', () => resolve('aborted'), { once: true });
        });
        if ((await Promise.race([pushing.then(() => 'done' as const), aborted])) === 'aborted') {
          return timedOut;
        }
      } catch (error) {
        // `signal` を見る実装（`fetch`）は期限で拒否する。理由は時間切れとして言う
        if (signal.aborted) return timedOut;
        return `大きいファイル ${label} を runner へ下ろせなかった: ${reasonOf(error)}`;
      } finally {
        // 読み切らずに断られた回に、置き場の読みを残さない。
        opened?.stream.destroy();
      }
    }
    return undefined;
  }
}
