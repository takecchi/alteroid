import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  jobSchema,
  prepareApprovalForWrite,
  prepareJobForWrite,
  pendingApprovalSchema,
  UnreadableApprovalError,
  UnreadableJobError,
} from '@alteroid/core';
import type {
  ApprovalList,
  Job,
  JobStore,
  PendingApproval,
  UnreadableApproval,
  UnreadableJob,
} from '@alteroid/core';
import { z } from 'zod';

import { writeFileAtomic } from './atomic.js';
import { withPathLock } from './file-lock.js';

/**
 * トップレベルの形だけを見る。**`jobs` / `approvals` のどちらも、各要素は
 * ここでは検査しない**——`z.array(jobSchema)` / `z.array(pendingApprovalSchema)`
 * にすると、1行の不正が配列全体を道連れにする（直す前の形。`#read()` の doc）。
 * 行ごとの検査は `#read()` がそれぞれ `jobSchema.safeParse` /
 * `pendingApprovalSchema.safeParse` で1行ずつ行う。
 *
 * **経緯（issue #1868 → #1928）。** `jobs` 側は #1868（PR #1884）でこの形に
 * 直った。そのとき `approvals` は「この Issue の担当範囲は委譲の行（`jobs`）
 * だけ」として `z.array(pendingApprovalSchema)` のまま残し、コメントに
 * 「承認の行が同じ穴を持つかどうかは別問題として残す」と書いていた——
 * 別問題ではあったが、同じ穴ではあった。#1928 で確かめて同じ形にそろえた。
 */
const fileSchema = z.object({
  jobs: z.array(z.unknown()).default([]),
  approvals: z.array(z.unknown()).default([]),
});

/**
 * `jobs.json` の中身。**検査を通った `jobs` / `approvals` と、それぞれ形が
 * 不正で読めなかった `invalidJobsRaw` / `invalidApprovalsRaw`（生の要素。
 * パース前のまま）を分けて持つ。**
 *
 * `invalidJobsRaw` / `invalidApprovalsRaw` を消さずに持ち回るのが、この
 * 直しの核心である（`FsCredentialVaultStore` の `CredentialFile`・issue
 * #1740 と同じ形。approvals 側は #1928 で jobs 側 #1868 にそろえた）。
 * `putJob` / `updateJob` / `putApproval` / `clear` はいずれも最終的にこれを
 * 丸ごとシリアライズし直す（`#serialize`）ので、ここへ入れなかった行は次の
 * 書き込みで消える——検査を通った行だけを書けば、版ずれ・手編集で
 * できた不正な行が黙って消えることになる。
 */
interface JobFile {
  jobs: Job[];
  /** 行の形が不正で読めなかった、生の要素（パース前のまま）。 */
  invalidJobsRaw: unknown[];
  approvals: PendingApproval[];
  /** 承認待ちの行の形が不正で読めなかった、生の要素（パース前のまま）。issue #1928。 */
  invalidApprovalsRaw: unknown[];
}

const EMPTY: JobFile = { jobs: [], invalidJobsRaw: [], approvals: [], invalidApprovalsRaw: [] };

/**
 * 不正な行を要約する。**`issue.message` は使わない**——zod の既定メッセージが
 * 将来 `received`（実際の値）を含む形に変わっても、ここを通す限り値は漏れない。
 * 出すのは「どの欄が」だけである（`FsCredentialVaultStore` の
 * `summarizeInvalidFields` と同じ理由・同じ形）。**`jobs` / `approvals`
 * どちらの行にも使う共通の関数**（issue #1928 で jobs 専用から共通化した）。
 */
function summarizeInvalidFields(issues: readonly { path: readonly PropertyKey[] }[]): string {
  const fields = [
    ...new Set(issues.map((issue) => (issue.path.length > 0 ? String(issue.path[0]) : '(root)'))),
  ];
  return fields.length > 0 ? `不正な欄: ${fields.join(',')}` : '不正な行';
}

/**
 * 生の要素から、値を出さずに「id」だけを安全に取り出す（取れなければ `undefined`）。
 * **`jobs` / `approvals` どちらの行にも使う共通の関数**（issue #1928）。
 */
function extractRowId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * 生の承認の行が、回答済み・取り下げ済みと分かるか（`pendingOnly` で読めない行を
 * 除くかの判断にだけ使う）。**値は返さず真偽だけ**。
 */
function isSettledRaw(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const row = raw as Record<string, unknown>;
  const set = (v: unknown): boolean => v !== undefined && v !== null;
  return set(row.answeredAt) || set(row.withdrawnAt);
}

/**
 * 読めなかった生の承認の行を、値を出さずに要約する（`#read()` の stderr の跡と同じ
 * 検査をやり直す。**不正な欄名だけ**）。
 */
function summarizeRawApprovalProblem(raw: unknown): string {
  const result = pendingApprovalSchema.safeParse(raw);
  return result.success ? '不正な行' : summarizeInvalidFields(result.error.issues);
}

/**
 * 読めなかった生の job 行を、値を出さずに要約する（`listUnreadableJobs()` 用。
 * `summarizeRawApprovalProblem` と同じ形。**不正な欄名だけ**）。
 */
function summarizeRawJobProblem(raw: unknown): string {
  const result = jobSchema.safeParse(raw);
  return result.success ? '不正な行' : summarizeInvalidFields(result.error.issues);
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
 * 飛ばした approval 行を stderr へ1行で要約する。**id 以外の値は絶対に
 * 載せない**——`question` / `context` には人間の依頼文がそのまま入りうる
 * （`describeSkippedJobRow` と同じ理由。issue #1928）。
 */
function describeSkippedApprovalRow(params: {
  index: number;
  reason: string;
  id?: string;
}): string {
  const idNote = params.id === undefined ? '' : ` id=${JSON.stringify(params.id)}`;
  return (
    `alteroid: approvals の不正な行を読み飛ばしました` +
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

  /**
   * `listJobs()` が飛ばした行を、本文を載せずに返す（issue #2345。`listApprovals()` の
   * `unreadable` と同じ作り方）。id と不正な欄名だけを持つ。
   */
  async listUnreadableJobs(): Promise<UnreadableJob[]> {
    const { invalidJobsRaw } = await this.#read();
    return invalidJobsRaw.map((raw): UnreadableJob => {
      const id = extractRowId(raw);
      const reason = summarizeRawJobProblem(raw);
      return id === undefined ? { reason } : { id, reason };
    });
  }

  async putJob(rawJob: Job): Promise<void> {
    // id（鍵）の NUL は断り、本文は落として残す（issue #3011）。
    const job = prepareJobForWrite(rawJob);
    await this.#update((file) => {
      const jobs = file.jobs.filter((existing) => existing.id !== job.id);
      jobs.push(jobSchema.parse(job));
      // **書き込む id と一致する壊れた行は置き換える**（`FsCredentialVaultStore.put`
      // と同じフォローアップ。issue #1740）。直したはずの id の壊れた行が
      // `invalidJobsRaw` として残り続けると、ファイルに同じ id が2行並び、
      // 以後 `listJobs()` のたびに直したはずの跡が出続ける——「直した」という
      // 呼び手の意図に対する驚きになる。
      const invalidJobsRaw = file.invalidJobsRaw.filter((raw) => extractRowId(raw) !== job.id);
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
   * （`invalidJobsRaw`）にしか無ければ、`mutate` に渡せる形をそもそも持たない
   * ので書かない——ただし **`null`（無い）とは分ける**。`UnreadableJobError` を
   * 投げ、行は1バイトも変えない（ファイルを書き戻さない。`JobStore.updateJob`
   * の doc）。「読めない」を「無い」へ倒すと、呼び出し元が「台帳に居ない」と
   * 言い切ってしまう。跡は `#read()` が飛ばした行ごとに stderr へ残している
   * （`describeSkippedJobRow`。id のみ）。
   */
  async updateJob(id: string, mutate: (current: Job) => Job): Promise<Job | null> {
    return withPathLock(this.#path, async () => {
      const file = await this.#read();
      const found = file.jobs.find((entry) => entry.id === id);
      if (found === undefined) {
        if (file.invalidJobsRaw.some((raw) => extractRowId(raw) === id)) {
          throw new UnreadableJobError({ id });
        }
        return null;
      }
      // 同期のまま最後まで書き換える（`mutate` に await を挟ませない——区間の
      // 外へ出ると排他の意味が崩れる。`CommitmentStore.open` の同じ注意）。
      const next = prepareJobForWrite(jobSchema.parse(mutate(found)));
      const jobs = file.jobs.map((entry) => (entry.id === id ? next : entry));
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(
        this.#path,
        `${JSON.stringify(this.#serialize({ ...file, jobs }), null, 2)}\n`,
      );
      return next;
    });
  }

  async listApprovals(options: { pendingOnly?: boolean } = {}): Promise<ApprovalList> {
    const { approvals, invalidApprovalsRaw } = await this.#read();
    // **未回答かつ未取り下げだけを「保留」とする（#963）。** 取り下げも
    // `answeredAt` と同じく「もう保留ではない」終端の一形態である
    // （`pendingApprovalSchema.withdrawnAt` の doc）。
    const entries = options.pendingOnly
      ? approvals.filter((a) => a.answeredAt === undefined && a.withdrawnAt === undefined)
      : approvals;
    // **読めない行は飛ばして消さず、`unreadable` に別欄で返す**（issue #2298）。
    // 読めない行に `answeredAt` / `withdrawnAt` が立っていれば、`pendingOnly` では
    // 「もう保留ではない」側へ寄せて除く（pg が列で絞るのと揃える）。**どちらも読めない
    // ときは数える側へ倒す**。本文は載せず、id と不正な欄名だけを持つ。
    const unreadable = invalidApprovalsRaw
      .filter((raw) => options.pendingOnly !== true || !isSettledRaw(raw))
      .map((raw): UnreadableApproval => {
        const id = extractRowId(raw);
        const reason = summarizeRawApprovalProblem(raw);
        return id === undefined ? { reason } : { id, reason };
      });
    return { entries, unreadable };
  }

  async getApproval(id: string): Promise<PendingApproval | null> {
    const { approvals, invalidApprovalsRaw } = await this.#read();
    const found = approvals.find((approval) => approval.id === id);
    if (found !== undefined) return found;
    // 壊れた行（`invalidApprovalsRaw`）にしか無ければ「無い」ではなく「読めない」。
    if (invalidApprovalsRaw.some((raw) => extractRowId(raw) === id)) {
      throw new UnreadableApprovalError({ id });
    }
    return null;
  }

  async putApproval(rawApproval: PendingApproval): Promise<void> {
    // id（鍵）の NUL は断り、本文は落として残す（issue #3011）。
    const approval = prepareApprovalForWrite(rawApproval);
    await this.#update((file) => {
      const approvals = file.approvals.filter((existing) => existing.id !== approval.id);
      approvals.push(pendingApprovalSchema.parse(approval));
      // **書き込む id と一致する壊れた行は置き換える**（`putJob` と同じ
      // フォローアップ。issue #1740 / #1868）。直したはずの id の壊れた行が
      // `invalidApprovalsRaw` として残り続けると、ファイルに同じ id が2行
      // 並び、以後 `listApprovals()` のたびに直したはずの跡が出続ける
      // ——「直した」という呼び手の意図に対する驚きになる（issue #1928）。
      const invalidApprovalsRaw = file.invalidApprovalsRaw.filter(
        (raw) => extractRowId(raw) !== approval.id,
      );
      return { ...file, approvals, invalidApprovalsRaw };
    });
  }

  /**
   * 現在の値を排他区間（`withPathLock`）の中で読み直し、`mutate` で書き換えて
   * 書く（issue #2007。`JobStore.updateApproval` の doc）。**`updateJob`
   * （上）と同じ独立させ方**——`#update`（戻り値を持たない）は `putApproval` /
   * `clear` も使っているので、そちらを触ると変更の範囲が承認待ちキューの
   * 実装全体へ広がってしまう。
   *
   * **`found` は検査を通った `approvals` からしか探さない。** id が壊れた行
   * （`invalidApprovalsRaw`）にしか無ければ、`mutate` に渡せる形が無いので書かない
   * ——ただし **`null`（無い）とは分け**、`UnreadableApprovalError` を投げる。
   * ファイルは書き戻さない（`updateJob` の同じ注意）。
   *
   * **`mutate` が `null` を返したら何も書かない**（`JobStore.updateApproval`
   * の「`updateJob` には無い拡張」）。壊れた行（`invalidApprovalsRaw`）の
   * 持ち回りは、書く回だけ関係する——書かない回はファイルへ一切触れない
   * ので、`putApproval` が守る「書き込む id と一致する壊れた行は置き換える」
   * （issue #1928）の対象にもならない。
   */
  async updateApproval(
    id: string,
    mutate: (current: PendingApproval) => PendingApproval | null,
  ): Promise<PendingApproval | null> {
    return withPathLock(this.#path, async () => {
      const file = await this.#read();
      const found = file.approvals.find((entry) => entry.id === id);
      if (found === undefined) {
        if (file.invalidApprovalsRaw.some((raw) => extractRowId(raw) === id)) {
          throw new UnreadableApprovalError({ id });
        }
        return null;
      }
      // 同期のまま最後まで書き換える（`updateJob` と同じ注意——`mutate` に
      // await を挟ませない）。
      const result = mutate(found);
      if (result === null) return null;
      const next = prepareApprovalForWrite(pendingApprovalSchema.parse(result));
      const approvals = file.approvals.map((entry) => (entry.id === id ? next : entry));
      // 書き込む id と一致する壊れた行は置き換える（`putApproval` と同じ
      // フォローアップ。issue #1740 / #1868 / #1928）。
      const invalidApprovalsRaw = file.invalidApprovalsRaw.filter(
        (raw) => extractRowId(raw) !== id,
      );
      await mkdir(this.#dir, { recursive: true });
      await writeFileAtomic(
        this.#path,
        `${JSON.stringify(this.#serialize({ ...file, approvals, invalidApprovalsRaw }), null, 2)}\n`,
      );
      return next;
    });
  }

  /**
   * ジョブと承認待ちを両方消す（`JobStore.clear` の doc）。
   *
   * **壊れた行（`invalidJobsRaw` / `invalidApprovalsRaw`）も一緒に消す**
   * （issue #1868、approvals 側は #1928）。以前はここで壊れた行を残していた
   * ——`putJob` / `updateJob` / `putApproval` が「読めない行を判断材料も
   * 無いまま黙って消さない」約束を守るのと同じ理由からだったが、`clear()` は
   * それらとは性質が違う。`clear()` はワークスペースのリセット専用の全消去
   * 操作で、pg 実装は表の行を `DELETE` で全部消す（`PgJobStore.clear` の
   * doc）——行の中身が壊れているかどうかは関係なく消える。fs だけが
   * `invalidJobsRaw` / `invalidApprovalsRaw` を生かして残すと、同じ
   * `clear()` の意味が実装ごとに変わってしまう（fs だけ「リセットしたのに
   * 壊れた行が残っている」状態になる）。
   *
   * **返す件数も、消した壊れた行を数える**（issue #1892、approvals 側は
   * #1928）。pg 実装は `DELETE … RETURNING` の行数をそのまま返すので、
   * 壊れた行も件数に入る。fs だけが検査を通った行だけを数えると、同じ状態で
   * 呼んだ `clear()` の件数が実装ごとに食い違い、`POST /reset` の応答が
   * 実際に消えた件数より少なく出る。
   */
  async clear(): Promise<{ jobs: number; approvals: number }> {
    let removed = { jobs: 0, approvals: 0 };
    await this.#update((file) => {
      removed = {
        jobs: file.jobs.length + file.invalidJobsRaw.length,
        approvals: file.approvals.length + file.invalidApprovalsRaw.length,
      };
      return { jobs: [], invalidJobsRaw: [], approvals: [], invalidApprovalsRaw: [] };
    });
    return removed;
  }

  /**
   * `jobs.json` を読む。**`jobs` と `approvals` の両方を、行ごとに検査して
   * 不正な1行だけを飛ばす**（`jobs` は issue #1868、`approvals` は #1928。
   * 以前は `fileSchema.parse` でそれぞれの配列全体を1回に検査していたため、
   * 1行でも不正だと `listJobs()` / `listApprovals()` が丸ごと例外を投げ、
   * 正しい行も読めなくなっていた——`#read()` は `jobs` と `approvals` を
   * 同時に返す1つの関数なので、**どちらの配列で例外が起きても両方が道連れに
   * なる**。pg 実装（`PgJobStore`）は issue #224 の作法で、jobs も approvals も
   * 最初からこの形だった。
   *
   * **飛ばすのは行の形が不正なとき（enum に無い値・欄が欠けている・型が
   * 違う、など）だけである。** ファイルそのものが JSON として読めない・
   * トップレベルの形が違う（`jobs` / `approvals` が配列でない等）ときは、
   * いまの振る舞い（例外）のままにしてある——それは1行の問題ではないため。
   *
   * 飛ばした行は stderr へ1行の跡を残し（`describeSkippedJobRow` /
   * `describeSkippedApprovalRow`。**値は summary / question / context 等の
   * 本文を含めず、id だけ**）、`invalidJobsRaw` / `invalidApprovalsRaw` として
   * 生の形のまま保持する——`putJob` / `updateJob` / `putApproval` / `clear`
   * がこれを書き戻すことで、版ずれ・手編集でできた不正な行を黙って消さない。
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
            reason: summarizeInvalidFields(result.error.issues),
            id: extractRowId(rawJob),
          })}\n`,
        );
      });
      const approvals: PendingApproval[] = [];
      const invalidApprovalsRaw: unknown[] = [];
      top.approvals.forEach((rawApproval, index) => {
        const result = pendingApprovalSchema.safeParse(rawApproval);
        if (result.success) {
          approvals.push(result.data);
          return;
        }
        invalidApprovalsRaw.push(rawApproval);
        process.stderr.write(
          `${describeSkippedApprovalRow({
            index,
            reason: summarizeInvalidFields(result.error.issues),
            id: extractRowId(rawApproval),
          })}\n`,
        );
      });
      return { jobs, invalidJobsRaw, approvals, invalidApprovalsRaw };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
      throw error;
    }
  }

  /**
   * `JobFile` をディスク上の形へ直す。**検査を通った `jobs` / `approvals` と、
   * それぞれの `invalidJobsRaw` / `invalidApprovalsRaw` を1本の配列へ合流
   * させる**——分けたまま書くと、次の `#read()` が `fileSchema`（トップ
   * レベルの形しか見ない）を通すときに未知のキー（`invalidJobsRaw` /
   * `invalidApprovalsRaw`）として黙って捨てられ、壊れた行を持ち回る意味が
   * 消える。
   */
  #serialize(file: JobFile): { jobs: unknown[]; approvals: unknown[] } {
    return {
      jobs: [...file.jobs, ...file.invalidJobsRaw],
      approvals: [...file.approvals, ...file.invalidApprovalsRaw],
    };
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
