import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { commitmentSchema } from '@alteroid/core';
import type { Commitment, CommitmentClosedBy, CommitmentStore } from '@alteroid/core';
import { z } from 'zod';

const fileSchema = z.object({
  commitments: z.array(commitmentSchema).default([]),
});

type CommitmentFile = z.infer<typeof fileSchema>;

/**
 * 片付いた行をここまで残して切る。
 *
 * **未了の行は数に関係なく1件も切らない。** 切った瞬間にこの器の目的（忘れさせない
 * こと）が消えるので、上限は「片付いた行だけ」に掛かる。
 *
 * 上限が要るのは fs 版が**毎回ファイル全体を書き直す**器だからである。自動 open は
 * 人間の発言のたびに1行増えるので、片付いた行を無限に積むと1回の open の費用が
 * 台帳の齢に比例して増えていく（人間の発言が遅くなる形で表に出る）。
 *
 * **切ってよい根拠は、永続の記録が日誌側にあることである。** 何をいつ引き受けて
 * 何をもって片付けたかは日誌（追記専用）に残っており、ここが持つのは「まだ
 * 片付いていないか」の状態と、日報が拾う直近の片付きだけである。日報の材料として
 * 要るのは直近の分なので、古い片付きが落ちても人間が読むものは欠けない。
 *
 * 500 なのは、自動 open の粒度（人間の発言1つ）で見て数日〜数週間ぶんが残る量で
 * ありながら、1枚の JSON として人間が開いて読める大きさに収まるためである。
 */
export const CLOSED_HISTORY_LIMIT = 500;

/**
 * 引き受けたまま終わっていない仕事の台帳 = 1枚の JSON。
 *
 * ジョブ台帳・継続中の依頼と同じディレクトリに置く。**人間が開いて読めること**を
 * 保つ形にしておく（「クローンが何を引き受けたまま抱えているか」が人間から見えない
 * のは可観測性の穴になる）。
 */
export class FsCommitmentStore implements CommitmentStore {
  readonly #dir: string;
  readonly #path: string;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'commitments.json');
  }

  async list(options?: { includeClosed?: boolean }): Promise<Commitment[]> {
    const all = (await this.#read()).commitments;
    // 未了は古い順。齢が判断の材料なので、放置されているものから見せる
    const open = all
      .filter((entry) => entry.closedAt === undefined)
      .sort((a, b) => a.at.localeCompare(b.at));
    if (options?.includeClosed !== true) return open;
    const closed = all
      .filter((entry) => entry.closedAt !== undefined)
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
    return [...open, ...closed];
  }

  async get(id: string): Promise<Commitment | null> {
    return (await this.#read()).commitments.find((entry) => entry.id === id) ?? null;
  }

  /**
   * 未了として開く。**既に在れば何もしない。**
   *
   * **読みと書きを同じ排他区間に入れること。** 分けると、同じ id の open が並行に
   * 来たときに両方が「無い」を読んで両方が書き、後から書いた側が先の行を上書きする。
   * 受信箱の合図は配り直されうる（`InboxStore` の取引）ので、その id を使う自動 open
   * は**同じ id で二度呼ばれるのが普通**である。上書きしてしまえば、一度片付けた
   * 仕事が配り直しのたびに開き直る。
   */
  async open(entry: Commitment): Promise<boolean> {
    return this.#update((file) => {
      // 閉じた行も含めて見る（片付いたものを開き直さない）
      if (file.commitments.some((existing) => existing.id === entry.id)) {
        return { next: file, result: false };
      }
      return {
        next: trimClosed({
          commitments: [...file.commitments, commitmentSchema.parse(entry)],
        }),
        result: true,
      };
    });
  }

  /**
   * 片付いたことを記録する。**行は消さない**（何を片付けたかが日報の材料から落ちる）。
   *
   * ここも「読む→既に閉じていないか見る→書く」を同じ排他区間で行う。分けると、
   * 二重に届いた片付けが両方 `true` を返し、呼び出し側が「いま自分が閉じた」と
   * 誤って二重に報告する。
   */
  async close(id: string, at: string, reason: string, by: CommitmentClosedBy): Promise<boolean> {
    return this.#update((file) => {
      const found = file.commitments.find((entry) => entry.id === id);
      // 無い / 既に閉じている。どちらも「いま自分が閉じた」ではない
      if (found === undefined || found.closedAt !== undefined) {
        return { next: file, result: false };
      }
      return {
        next: trimClosed({
          commitments: file.commitments.map((entry) =>
            entry.id === id
              ? { ...entry, closedAt: at, closedReason: reason, closedBy: by }
              : entry,
          ),
        }),
        result: true,
      };
    });
  }

  async #read(): Promise<CommitmentFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      return fileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { commitments: [] };
      throw error;
    }
  }

  /**
   * read-modify-write を直列化する（デーモン1プロセス前提の最小の排他）。
   *
   * `mutate` は書き込む内容と、呼び出し側へ返す値の両方を決める。**読んだ結果に
   * 基づいて書くかどうかを決める操作**（`open` / `close`）を、この区間の外へ出さないこと。
   */
  async #update<T>(
    mutate: (file: CommitmentFile) => { next: CommitmentFile; result: T },
  ): Promise<T> {
    const run = this.#chain.then(async () => {
      const { next, result } = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(tmp, this.#path);
      return result;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }
}

/**
 * 片付いた行だけを新しい順に `CLOSED_HISTORY_LIMIT` 件まで切り詰める。
 *
 * **未了の行には触れない。** 判定に使うのは `closedAt` の有無だけで、件数や齢では
 * ない（「古い未了から捨てる」は忘れさせないという目的の否定である）。
 */
function trimClosed(file: CommitmentFile): CommitmentFile {
  const closed = file.commitments.filter((entry) => entry.closedAt !== undefined);
  if (closed.length <= CLOSED_HISTORY_LIMIT) return file;

  const kept = new Set(
    [...closed]
      .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
      .slice(0, CLOSED_HISTORY_LIMIT)
      .map((entry) => entry.id),
  );
  return {
    commitments: file.commitments.filter(
      (entry) => entry.closedAt === undefined || kept.has(entry.id),
    ),
  };
}
