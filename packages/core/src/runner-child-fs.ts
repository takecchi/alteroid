import type { ChildProcess } from 'node:child_process';
import { open, realpath } from 'node:fs/promises';

/**
 * 子（別 UID で起こす CLI）が書ける場所への書き込みと読み取りを、子の uid・gid に降りた子プロセスで行う口（#5259）。
 * runner（root のことがある）が子の書ける場所のパスを辿ると、子が途中の段を symlink に差し替えて、root の権限で子の選んだ場所へ
 * 書かせる・読ませる窓になる。子プロセスなら symlink を辿っても子が書ける・読める場所にしか届かない。
 *
 * 子プロセスの中身は {@link CHILD_FS_SCRIPT}（`process.execPath -e` で起こす）。パッケージに別の `.js` を同梱しない:
 * 置き場所の探索（src と dist で違う）と、tsup が共有チャンクへ括り出して直接起動を壊す形（`clone-tool-relay-protocol.ts` の先頭）を避け、
 * 子の uid から読めるかも気にしなくてよいため。入出力は JSON を stdin から1つ・stdout へ1つ、終了コードは 0（最後まで走った）と 2（入力が読めない）。
 */

export type ChildFsSpawn = (options: {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}) => ChildProcess;

export interface PlannedFile {
  readonly path: string;
  readonly body: string;
}

export type FileWriteOutcome =
  { readonly status: 'placed' | 'present' } | { readonly status: 'error'; readonly code: string };

/** 全部のファイルを1回の子プロセスで置く。結果は `files` と同じ順。ファイルごとの失敗は `error` で返し、子プロセスが落ちたときは投げる。 */
export type ChildFileWriter = (files: readonly PlannedFile[]) => Promise<FileWriteOutcome[]>;

export interface RolloutIo {
  /** 実体のパス。解決できなければ `code`（`ENOENT` など）。 */
  realpaths(paths: readonly string[]): Promise<({ path: string } | { code: string })[]>;
  /** `offset` から最大 `length` バイトと、そのときのファイルの大きさ。`offset` が大きさ以上なら `data` は空。読めなければ `code` 付きで投げる。 */
  readChunk(file: string, offset: number, length: number): Promise<{ size: number; data: Buffer }>;
}

const CHILD_FS_TIMEOUT_MS = 30_000;

/**
 * 子プロセスの中身。要求は `op` で分ける:
 * - `write`: `files` の各 `{path, body}` を、親の段を `mkdir -p`（0700）で作って `wx`・0600 で書く。既にあれば `present`。
 * - `realpath`: `paths` の各実体のパス。
 * - `read`: `file` の `offset` から最大 `length` バイトを base64 で、`size` と共に返す。
 * どれも `pid`（自分の pid）を返す: 書いたのが runner 本体ではないことを試験が確かめるため。
 */
export const CHILD_FS_SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let out;
  try {
    out = handle(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch (error) {
    process.stderr.write(String(error && error.message));
    process.exit(2);
  }
  out.pid = process.pid;
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
});
function codeOf(error) {
  return typeof (error && error.code) === 'string' ? error.code : 'UNKNOWN';
}
function handle(request) {
  if (request.op === 'write') {
    return {
      results: request.files.map((file) => {
        if (typeof file.path !== 'string' || !path.isAbsolute(file.path) || typeof file.body !== 'string') {
          throw new Error('bad write request');
        }
        try {
          fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o700 });
        } catch (error) {
          return { status: 'error', code: codeOf(error) };
        }
        try {
          fs.writeFileSync(file.path, file.body, { flag: 'wx', mode: 0o600 });
          return { status: 'placed' };
        } catch (error) {
          return codeOf(error) === 'EEXIST' ? { status: 'present' } : { status: 'error', code: codeOf(error) };
        }
      }),
    };
  }
  if (request.op === 'realpath') {
    return {
      results: request.paths.map((p) => {
        try {
          return { path: fs.realpathSync(p) };
        } catch (error) {
          return { code: codeOf(error) };
        }
      }),
    };
  }
  if (request.op === 'read') {
    let fd;
    try {
      fd = fs.openSync(request.file, 'r');
      const size = fs.fstatSync(fd).size;
      const length = Math.max(0, Math.min(size - request.offset, request.length));
      const buffer = Buffer.alloc(length);
      const bytesRead = length === 0 ? 0 : fs.readSync(fd, buffer, 0, length, request.offset);
      return { ok: true, size, data: buffer.subarray(0, bytesRead).toString('base64') };
    } catch (error) {
      return { ok: false, code: codeOf(error) };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  throw new Error('unknown op');
}
`;

/** 子の uid に降りた子プロセスへ要求を1つ渡し、応答の JSON を返す。落ちた・時間切れ・読めない応答は投げる。 */
async function runChildFs(
  spawnChild: ChildFsSpawn,
  env: Record<string, string | undefined>,
  request: unknown,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHILD_FS_TIMEOUT_MS);
  try {
    const child = spawnChild({
      command: process.execPath,
      args: ['-e', CHILD_FS_SCRIPT],
      env,
      signal: controller.signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    if (child.stdin === null) throw new Error('子プロセスの stdin が開けない');
    // 子が先に落ちると EPIPE になる: 落ちた理由は `close` の側で返す
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(request));
    const code = await exited;
    if (code !== 0) {
      const detail = Buffer.concat(stderr).toString('utf8').slice(0, 200);
      throw new Error(`子の uid の子プロセスが落ちた（終了コード ${String(code)}）${detail}`);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(stdout).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null)
      throw new Error('子プロセスの応答が読めない');
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export function childFileWriter(
  spawnChild: ChildFsSpawn,
  env: Record<string, string | undefined>,
): ChildFileWriter {
  return async (files) => {
    if (files.length === 0) return [];
    const response = await runChildFs(spawnChild, env, {
      op: 'write',
      files: files.map(({ path, body }) => ({ path, body })),
    });
    const results = response.results as FileWriteOutcome[] | undefined;
    if (!Array.isArray(results) || results.length !== files.length) {
      throw new Error('子プロセスの応答の件数が合わない');
    }
    return results;
  };
}

export const localRolloutIo: RolloutIo = {
  async realpaths(paths) {
    const results: ({ path: string } | { code: string })[] = [];
    for (const path of paths) {
      try {
        results.push({ path: await realpath(path) });
      } catch (error) {
        results.push({ code: codeOf(error) });
      }
    }
    return results;
  },
  async readChunk(file, offset, length) {
    const handle = await open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      const want = Math.max(0, Math.min(size - offset, length));
      const buffer = Buffer.alloc(want);
      const { bytesRead } =
        want === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, want, offset);
      return { size, data: buffer.subarray(0, bytesRead) };
    } finally {
      await handle.close();
    }
  },
};

export function childRolloutIo(
  spawnChild: ChildFsSpawn,
  env: Record<string, string | undefined>,
): RolloutIo {
  return {
    async realpaths(paths) {
      const response = await runChildFs(spawnChild, env, { op: 'realpath', paths });
      const results = response.results as ({ path: string } | { code: string })[] | undefined;
      if (!Array.isArray(results) || results.length !== paths.length) {
        throw new Error('子プロセスの応答の件数が合わない');
      }
      return results;
    },
    async readChunk(file, offset, length) {
      const response = await runChildFs(spawnChild, env, { op: 'read', file, offset, length });
      if (response.ok !== true) {
        throw Object.assign(new Error('子の uid で記録を読めない'), {
          code: typeof response.code === 'string' ? response.code : 'UNKNOWN',
        });
      }
      return {
        size: response.size as number,
        data: Buffer.from(response.data as string, 'base64'),
      };
    },
  };
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}
