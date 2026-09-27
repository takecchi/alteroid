import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { jobSchema, pendingApprovalSchema } from '@alteroid/core';
import type { Job, JobStore, PendingApproval } from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

/**
 * トップレベルの形だけを見る。**`jobs` の各要素はここでは検査しない**
 * （issue #1868）——`z.array(jobSchema)` にすると、1行の不正が配列全体を
 * 道連れにする（直す前の形。`#read()` の doc）。行ごとの検査は `#read()` が
 * `jobSchema.safeParse` で1行ずつ行う。
 *
 * **`approvals` はこれまでどおり配列全体を1回で検査する。** この Issue の
 * 担当範囲は「委譲の行（`jobs`）」だけで、承認待ちキューの挙動は変えない
 * ——承認の行が同じ穴を持つかどうかは別問題として残す。
 */
const fileSchema = z.object({
  jobs: z.array(z.unknown()).default([]),
  approvals: z.array(pendingApprovalSchema).default([]),
});

/**
 * `jobs.json` の中身。**検査を通った `jobs` と、形が不正で読めなかった
 * `invalidJobsRaw`（生の要素。パース前のまま）を分けて持つ。**
 *
 * `invalidJobsRaw` を消さずに持ち回るのが、この直しの核心である
 * （`FsCredentialVaultStore` の `CredentialFile`・issue #1740 と同じ形）。
 * `putJob` / `updateJob` / `clear` はいずれも最終的にこれを丸ごと
 * シリアライズし直す（`#serialize`）ので、ここへ入れなかった行は次の
 * 書き込みで消える——`jobs`（検査を通った行）だけを書けば、版ずれ・手編集で
 * できた不正な行が黙って消えることになる。
 */
interface JobFile {
  jobs: Job[];
  /** 行の形が不正で読めなかった、生の要素（パース前のまま）。 */
  invalidJobsRaw: unknown[];
  approvals: PendingApproval[];
}

const EMPTY: JobFile = { jobs: [], invalidJobsRaw: [], approvals: [] };

/**
 * 不正な行を要約する。**`issue.message` は使わない**——zod の既定メッセージが
 * 将来 `received`（実際の値）を含む形に変わっても、ここを通す限り値は漏れない。
 * 出すのは「どの欄が」だけである（`FsCredentialVaultStore` の
 * `summarizeInvalidFields` と同じ理由・同じ形）。
 */
function summarizeInvalidJobFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

/** 生の要素から、値を出さずに「id」だけを安全に取り出す（取れなければ `undefined`）。 */
function extractJobId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * 飛ばした job 行を stderr へ1行で要約する。**id 以外の値は絶対に載せない**
 * ——job の欄には人間の依頼文・マネージャーの報告がそのまま入りうる
 * （`noteDroppedRecord` の doc、#52 と同じ理由）。
 */
function describeSkippedJobRow(params: { index: number; reason: string; id?: string }): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: jobs の不正な行を読み飛ばしました` +
    `（${params.index + 1} 行目、${params.reason}）${idNote}`
  );
}

/**
 * ジョブと承認待ちキュー = 1枚の JSON。
 *
 * M1 で使うのは承認待ちだけ（`ask_human` の行き先）。ジョブ本体は M2 で
 * manager_id と SDK session_id の対応を持つ器になる。
 */
export class FsJobStore implements JobStore {
  readonly #dir: string;
  readonly #path: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.#path = join(dir, 'jobs.json');
  }

  async listJobs(): Promise<Job[]> {
    return (await this.#read()).jobs;
  }

  async putJob(job: Job): Promise<void> {
    await this.#update((file) => {
      const jobs = file.jobs.filter((existing) => existing.id !== job.id);
      jobs.push(jobSchema.parse(job));
      // **書き込む id と一致する壊れた行は置き換える**（`FsCredentialVaultStore.put`
      // と同じフォローアップ。issue #1740）。直したはずの id の壊れた行が
      // `invalidJobsRaw` として残り続けると、ファイルに同じ id が2行並び、
      // 以後 `listJobs()` のたびに直したはずの跡が出続ける——「直した」という
      // 呼び手の意図に対する驚きになる。
      const invalidJobsRaw = file.invalidJobsRaw.filter((raw) => extractJobId(raw) !== job.id);
      return { ...file, jobs, invalidJobsRaw };
    });
  }

  /**
   * 現在の値を排他区間（`withPathLock`）の中で読み直し、`mutate` で書き換えて
   * 書く（Issue #1674。`JobStore.updateJob` の doc）。**現在値を読むのも書くのも
   * 同じロックの区間の中**——`schedules.ts` の `editRequest` と同じ形。ここは
   * `#update`（戻り値を持たない）を共有せず独立させてある——`#update` は
   * `putApproval` / `clear`（担当が別）も使っているので、戻り値の形を変える
   * ために触ると、この変更の範囲が承認待ちキューの実装にまで広がってしまう。
   *
   * **`found` は検査を通った `jobs` からしか探さない。** id が壊れた行
   * （`invalidJobsRaw`）にしか無ければ「無い」と同じ扱いになる——壊れた行は
   * `mutate` に渡せる形をそもそも持たないので、これは正しい（`JobStore.updateJob`
   * の「無ければ何もせず `null`」と同じ意味）。
   */
  async updateJob(id: string, mutate: (current: Job) => Job): Promise<Job | null> {
    return withPathLock(this.#path, async () => {
      const file = await this.#read();
      const found = file.jobs.find((entry) => entry.id === id);
      if (found === undefined) return null;
      // 同期のまま最後まで書き換える（`mutate` に await を挟ませない——区間の
      // 外へ出ると排他の意味が崩れる。`CommitmentStore.open` の同じ注意）。
      const next = jobSchema.parse(mutate(found));
      const jobs = file.jobs.map((entry) => (entry.id === id ? next : entry));
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(
        this.#path,
        `${JSON.stringify(this.#serialize({ ...file, jobs }), null, 2)}\n`,
      );
      return next;
    });
  }

  async listApprovals(options: { pendingOnly?: boolean } = {}): Promise<PendingApproval[]> {
    const { approvals } = await this.#read();
    // **未回答かつ未取り下げだけを「保留」とする（#963）。** 取り下げも
    // `answeredAt` と同じく「もう保留ではない」終端の一形態である
    // （`pendingApprovalSchema.withdrawnAt` の doc）。
    return options.pendingOnly
      ? approvals.filter((a) => a.answeredAt === undefined && a.withdrawnAt === undefined)
      : approvals;
  }

  async getApproval(id: string): Promise<PendingApproval | null> {
    const { approvals } = await this.#read();
    return approvals.find((approval) => approval.id === id) ?? null;
  }

  async putApproval(approval: PendingApproval): Promise<void> {
    await this.#update((file) => {
      const approvals = file.approvals.filter((existing) => existing.id !== approval.id);
      approvals.push(pendingApprovalSchema.parse(approval));
      return { ...file, approvals };
    });
  }

  /**
   * ジョブと承認待ちを両方消す（`JobStore.clear` の doc）。
   *
   * **壊れた行（`invalidJobsRaw`）も一緒に消す**（issue #1868）。以前はここで
   * 壊れた行を残していた——`putJob` / `updateJob` が「読めない行を判断材料も
   * 無いまま黙って消さない」約束を守るのと同じ理由からだったが、`clear()` は
   * それらとは性質が違う。`clear()` はワークスペースのリセット専用の全消去
   * 操作で、pg 実装は表の行を `DELETE` で全部消す（`PgJobStore.clear` の
   * doc）——行の中身が壊れているかどうかは関係なく消える。fs だけが
   * `invalidJobsRaw` を生かして残すと、同じ `clear()` の意味が実装ごとに
   * 変わってしまう（fs だけ「リセットしたのに壊れた行が残っている」状態に
   * なる）。
   */
  async clear(): Promise<{ jobs: number; approvals: number }> {
    let removed = { jobs: 0, approvals: 0 };
    await this.#update((file) => {
      removed = { jobs: file.jobs.length, approvals: file.approvals.length };
      return { jobs: [], invalidJobsRaw: [], approvals: [] };
    });
    return removed;
  }

  /**
   * `jobs.json` を読む。**`jobs` は行ごとに検査し、不正な1行だけを飛ばす**
   * （issue #1868。以前は `fileSchema.parse` で `jobs` 配列全体を1回に検査して
   * いたため、1行でも不正だと `listJobs()` が丸ごと例外を投げ、正しい行も
   * 読めなくなっていた——pg 実装は issue #224 の作法で最初からこの形だった）。
   *
   * **飛ばすのは行の形が不正なとき（`status` が enum に無い・欄が欠けている・
   * 型が違う、など）だけである。** ファイルそのものが JSON として読めない・
   * トップレベルの形が違う（`jobs` が配列でない等）ときは、いまの振る舞い
   * （例外）のままにしてある——それは1行の問題ではないため（`approvals` も
   * 同様、こちらは行ごとの検査そのものを導入していない）。
   *
   * 飛ばした行は stderr へ1行の跡を残し（`describeSkippedJobRow`。**値は
   * summary 等の本文を含めず、id だけ**）、`invalidJobsRaw` として生の形のまま
   * 保持する——`putJob` / `updateJob` / `clear` がこれを書き戻すことで、
   * 版ずれ・手編集でできた不正な行を黙って消さない。
   */
  async #read(): Promise<JobFile> {
    try {
      const raw = await readFile(this.#path, 'utf8');
      const top = fileSchema.parse(JSON.parse(raw));
      const jobs: Job[] = [];
      const invalidJobsRaw: unknown[] = [];
      top.jobs.forEach((rawJob, index) => {
        const result = jobSchema.safeParse(rawJob);
        if (result.success) {
          jobs.push(result.data);
          return;
        }
        invalidJobsRaw.push(rawJob);
        process.stderr.write(
          `${describeSkippedJobRow({
            index,
            reason: summarizeInvalidJobFields(result.error.issues),
            id: extractJobId(rawJob),
          })}\n`,
        );
      });
      return { jobs, invalidJobsRaw, approvals: top.approvals };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  /**
   * `JobFile` をディスク上の形へ直す。**検査を通った `jobs` と `invalidJobsRaw`
   * を1本の `jobs` 配列へ合流させる**——分けたまま書くと、次の `#read()` が
   * `fileSchema`（トップレベルの形しか見ない）を通すときに未知のキー
   * （`invalidJobsRaw`）として黙って捨てられ、壊れた行を持ち回る意味が消える。
   */
  #serialize(file: JobFile): { jobs: unknown[]; approvals: PendingApproval[] } {
    return { jobs: [...file.jobs, ...file.invalidJobsRaw], approvals: file.approvals };
  }

  /**
   * read-modify-write を直列化する（issue #1113 / #1050 — `withPathLock` で
   * プロセス内・プロセス間の両方を排他する。advisory の強さは `file-lock.ts`
   * の doc を見よ）。
   */
  async #update(mutate: (file: JobFile) => JobFile): Promise<void> {
    await withPathLock(this.#path, async () => {
      const next = mutate(await this.#read());
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(this.#path, `${JSON.stringify(this.#serialize(next), null, 2)}\n`);
    });
  }
}
