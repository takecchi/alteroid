import { lchownSync, lstatSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';

import type { ChildFileWriter, FileWriteOutcome, PlannedFile } from './runner-child-fs.js';

// パスの1段に使える名前か: SDK が渡す projectKey・sessionId でも、`/` や `..` を含めば書かない
function isPlainSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

/**
 * `base` から `dir` までの在る段が、どれも symlink でない実在のディレクトリかを確かめる。違えば投げる（書かない）。
 * runner（root のことがある）が、子が書ける設定ディレクトリの中へ書くため: 子が途中の段を symlink に差し替えておくと、
 * `mkdir -p` と `writeFile` はそれを辿り、root が子の選んだ場所にファイルを作って子へ渡してしまう（`wx` は最後の段の symlink しか断らない）。
 * 無い段は飛ばす（これから `mkdir` が作る）。作った後にもう一度呼んで、作る間の差し替えも拾う。
 */
export function assertNoSymlinkDirs(base: string, dir: string): void {
  const root = resolve(base);
  const target = resolve(dir);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('書き込み先が設定ディレクトリの外');
  }
  const segments = target === root ? [] : target.slice(root.length + 1).split(sep);
  let current = root;
  for (const segment of ['', ...segments]) {
    if (segment !== '') current = join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('設定ディレクトリの途中の段が symlink か、ディレクトリでない');
    }
  }
}

/**
 * resume の材料（生ログ）を、子のふだんの設定ディレクトリ `<configDir>/projects/<projectKey>/<sessionId>.jsonl` に置く。
 * SDK の一時ディレクトリ（`/tmp/claude-resume-*`）へ書かせない: CLI が終わると SDK が消し、鍵の回転で開き直すと会話が見つからず、
 * 長すぎた出力の保存もそこへ書かれて `/tmp/claude-*` を読まない担当から見えないため（2026-10-13）。
 * 形は SDK と同じ（1件ずつ JSON にして改行で区切る、0600）。
 * 既に在れば上書きしない（`'present'`）: そちらは CLI が書き続けた最新で、材料のほうが古いため。
 * `writer` があれば（子を別 UID で起こす構成）子の uid の子プロセスで置く: 持ち主は最初から子で、symlink を辿っても子が書ける場所にしか届かない（#5259）。
 * 無ければ runner 自身で置き、symlink の段を `assertNoSymlinkDirs` で断る。
 */
export async function placeSeedInConfigDir(
  configDir: string,
  key: { readonly projectKey: string; readonly sessionId: string },
  entries: readonly unknown[],
  writer?: ChildFileWriter,
): Promise<'placed' | 'present'> {
  const planned = planSeedFile(configDir, key, entries);
  if (writer !== undefined) return outcomeToPlaced((await writer([planned]))[0]);
  return (await writeNewHere(configDir, planned)) ? 'placed' : 'present';
}

function planSeedFile(
  configDir: string,
  key: { readonly projectKey: string; readonly sessionId: string },
  entries: readonly unknown[],
): PlannedFile {
  if (!isPlainSegment(key.projectKey) || !isPlainSegment(key.sessionId)) {
    throw new Error('projectKey か sessionId がパスの1段として使えない形');
  }
  return {
    path: join(configDir, 'projects', key.projectKey, `${key.sessionId}.jsonl`),
    body: entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
  };
}

function outcomeToPlaced(outcome: FileWriteOutcome | undefined): 'placed' | 'present' {
  if (outcome === undefined) throw new Error('子プロセスの応答が足りない');
  if (outcome.status === 'error') throw new Error(`子の uid で置けなかった: ${outcome.code}`);
  return outcome.status;
}

/**
 * runner 自身で置く（子を別 UID で起こさない構成）。symlink の段は `assertNoSymlinkDirs` で断る。
 * 子を別 UID で起こす構成はこちらを通らず、子の uid の子プロセスで置く（{@link ChildFileWriter}）。
 */
async function writeNewHere(configDir: string, file: PlannedFile): Promise<boolean> {
  const dir = dirname(file.path);
  assertNoSymlinkDirs(configDir, dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  assertNoSymlinkDirs(configDir, dir);
  try {
    await writeFile(file.path, file.body, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'EEXIST') return false;
    throw error;
  }
  return true;
}

export interface SubagentTranscriptSeed {
  readonly subpath: string;
  readonly entries: readonly unknown[];
}

function isAgentMetadataEntry(entry: unknown): entry is Record<string, unknown> {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { type?: unknown }).type === 'agent_metadata'
  );
}

/**
 * 作業者の `subpath` を、`<sessionDir>` の下の相対パスとして検める。通れば `subagents/` で始まる安全な形、通らなければ `undefined`。
 * SDK の resume の材料の書き出し（`sdk.mjs` の `M9e`）が断る形（空・絶対パス・`..` の段・`sessionDir` の外へ出る）に、NUL と
 * `subagents/` で始まらないものを足して断る: 作業者の記録以外を、SDK が知らない場所へ書かないため。
 */
export function safeSubagentSubpath(sessionDir: string, subpath: string): string | undefined {
  if (subpath.length === 0 || subpath.includes('\0')) return undefined;
  if (!subpath.startsWith('subagents/')) return undefined;
  if (isAbsolute(subpath) || win32.isAbsolute(subpath)) return undefined;
  if (subpath.split(/[\\/]/).includes('..')) return undefined;
  const base = resolve(sessionDir);
  if (!resolve(base, `${subpath}.jsonl`).startsWith(`${base}${sep}`)) return undefined;
  return subpath;
}

interface PlannedSubagentFile extends PlannedFile {
  /** `placed` に数えるか（jsonl は数え、`.meta.json` は数えない）。 */
  readonly counted: boolean;
}

/** 置く先と中身だけを決める（fs には触れない）。危ない `subpath` は置かずに `rejected` へ。 */
function planSubagentFiles(
  configDir: string,
  key: { readonly projectKey: string; readonly sessionId: string },
  subagents: readonly SubagentTranscriptSeed[],
): { files: PlannedSubagentFile[]; rejected: string[] } {
  if (!isPlainSegment(key.projectKey) || !isPlainSegment(key.sessionId)) {
    throw new Error('projectKey か sessionId がパスの1段として使えない形');
  }
  const sessionDir = join(configDir, 'projects', key.projectKey, key.sessionId);
  const rejected: string[] = [];
  const files: PlannedSubagentFile[] = [];
  for (const subagent of subagents) {
    const subpath = safeSubagentSubpath(sessionDir, subagent.subpath);
    if (subpath === undefined) {
      rejected.push(subagent.subpath);
      continue;
    }
    const metadata: Record<string, unknown>[] = [];
    const lines: unknown[] = [];
    for (const entry of subagent.entries) {
      if (isAgentMetadataEntry(entry)) metadata.push(entry);
      else lines.push(entry);
    }
    if (lines.length > 0) {
      files.push({
        path: join(sessionDir, `${subpath}.jsonl`),
        body: lines.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
        counted: true,
      });
    }
    const last = metadata.at(-1);
    if (last !== undefined) {
      const sidecar = Object.fromEntries(Object.entries(last).filter(([name]) => name !== 'type'));
      files.push({
        path: join(sessionDir, `${subpath}.meta.json`),
        body: JSON.stringify(sidecar),
        counted: false,
      });
    }
  }
  return { files, rejected };
}

/**
 * 作業者（サブエージェント）の記録を、主の記録の隣（`<configDir>/projects/<projectKey>/<sessionId>/<subpath>.jsonl`）に置く。
 * 形は SDK が `listSubkeys` を使って戻すときと同じ（`sdk.mjs` の `M9e`）: `agent_metadata` の行は jsonl に入れず、最後の1件から `type` を除いた JSON を
 * `<subpath>.meta.json` に書き、残りの行を1件ずつ JSON にして改行で区切る。どちらも 0600。jsonl に残る行が無ければ jsonl は作らない（SDK と同じ）。
 * 既に在るファイルは上書きしない（主と同じ理由: CLI が書き続けた最新が在る）。危ない `subpath` は置かずに、断った subpath を返す。
 */
export async function placeSubagentsInConfigDir(
  configDir: string,
  key: { readonly projectKey: string; readonly sessionId: string },
  subagents: readonly SubagentTranscriptSeed[],
  writer?: ChildFileWriter,
): Promise<{ placed: number; rejected: string[] }> {
  const { files, rejected } = planSubagentFiles(configDir, key, subagents);
  let placed = 0;
  if (writer !== undefined) {
    const outcomes = await writer(files);
    files.forEach((file, index) => {
      if (outcomeToPlaced(outcomes[index]) === 'placed' && file.counted) placed += 1;
    });
    return { placed, rejected };
  }
  for (const file of files) {
    if ((await writeNewHere(configDir, file)) && file.counted) placed += 1;
  }
  return { placed, rejected };
}

/**
 * 主の記録と作業者の記録を、1回の子プロセスでまとめて置く（子を別 UID で起こす構成。resume のたびに起こす子プロセスを1本にするため）。
 * 主の記録が置けなければ投げる（呼び手は SDK の一時ディレクトリへ落とす）。作業者の記録の失敗は投げずに `subagentFailure` に返す（主の resume は止めない）。
 */
export async function placeResumeMaterialAsChild(
  configDir: string,
  key: { readonly projectKey: string; readonly sessionId: string },
  seed: readonly unknown[],
  subagents: readonly SubagentTranscriptSeed[],
  writer: ChildFileWriter,
): Promise<{
  seed: 'placed' | 'present';
  subagents: { placed: number; rejected: string[] };
  subagentFailure?: string;
}> {
  const seedFile = planSeedFile(configDir, key, seed);
  const planned = planSubagentFiles(configDir, key, subagents);
  const outcomes = await writer([seedFile, ...planned.files]);
  const seedResult = outcomeToPlaced(outcomes[0]);
  let placed = 0;
  const failedCodes = new Set<string>();
  planned.files.forEach((file, index) => {
    const outcome = outcomes[index + 1];
    if (outcome === undefined || outcome.status === 'error') {
      failedCodes.add(outcome?.code ?? 'MISSING');
    } else if (outcome.status === 'placed' && file.counted) {
      placed += 1;
    }
  });
  return {
    seed: seedResult,
    subagents: { placed, rejected: planned.rejected },
    ...(failedCodes.size === 0
      ? {}
      : { subagentFailure: `子の uid で置けなかった: ${[...failedCodes].join(', ')}` }),
  };
}

export interface PeerRolloutSeed {
  readonly peerId: string;
  readonly threadId: string;
  readonly relPath: string;
  readonly entries: readonly unknown[];
}

/**
 * peer（Codex）の rollout の置き場の相対パス（`CODEX_HOME/sessions/` から下）を検める。通れば `relPath`、通らなければ `undefined`。
 * 断る形: 空・NUL・絶対パス・`..` の段・`sessions/` の外へ出る・ファイル名が `rollout-` で始まり `<threadId>.jsonl` で終わらない。
 * ファイル名の条件は Codex が thread を探す条件そのもの（違う名前では `no rollout found` で断られる）で、同時に、資格など
 * rollout 以外のファイルを `CODEX_HOME` の下へ作らせないための歯でもある。
 */
export function safePeerRolloutRelPath(
  sessionsDir: string,
  relPath: string,
  threadId: string,
): string | undefined {
  if (relPath.length === 0 || relPath.includes('\0')) return undefined;
  if (!isPlainSegment(threadId)) return undefined;
  if (isAbsolute(relPath) || win32.isAbsolute(relPath)) return undefined;
  const segments = relPath.split(/[\\/]/);
  if (segments.includes('..') || segments.includes('')) return undefined;
  const name = segments[segments.length - 1] ?? '';
  if (!name.startsWith('rollout-') || !name.endsWith(`${threadId}.jsonl`)) return undefined;
  const base = resolve(sessionsDir);
  if (!resolve(base, relPath).startsWith(`${base}${sep}`)) return undefined;
  return relPath;
}

/** `ordinal` で重複を落として並べる。`ordinal` を持たない行は rollout の行ではないので捨てる（数を `dropped` に返す）。 */
export function orderRolloutEntries(entries: readonly unknown[]): {
  lines: Record<string, unknown>[];
  dropped: number;
} {
  const byOrdinal = new Map<number, Record<string, unknown>>();
  let dropped = 0;
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const ordinal = record.ordinal;
    if (record.type === 'alteroid_peer_meta') continue;
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0) {
      dropped += 1;
      continue;
    }
    if (!byOrdinal.has(ordinal)) byOrdinal.set(ordinal, record);
  }
  const lines = [...byOrdinal.entries()].sort((a, b) => a[0] - b[0]).map(([, entry]) => entry);
  return { lines, dropped };
}

/**
 * peer（Codex）の rollout を `<codexHome>/sessions/<relPath>` へ書き戻す（`peer_reply` が `thread/resume` で起こせるように）。
 * 作業者の分（{@link placeSubagentsInConfigDir}）と同じ守りを掛ける: `wx`（既にあれば上書きしない。Codex が書き続けた最新が在る）・0600。
 * `writer` があれば（子を別 UID で起こす構成）全 peer のファイルを1回の子の uid の子プロセスで置く。持ち主は最初から子で、symlink は子が書ける場所にしか届かないので、段の検めも持ち主の付け替えも要らない。無ければ runner 自身で置き、symlink の段を断る。
 * 危ない `relPath`・ファイル名の peer は置かずに `peerId` を `rejected` に返す。
 */
export async function placePeersInCodexHome(
  codexHome: string,
  peers: readonly PeerRolloutSeed[],
  writer?: ChildFileWriter,
): Promise<{ placed: string[]; present: string[]; rejected: string[]; droppedLines: number }> {
  const sessionsDir = join(codexHome, 'sessions');
  const result = {
    placed: [] as string[],
    present: [] as string[],
    rejected: [] as string[],
    droppedLines: 0,
  };
  const planned: { peerId: string; file: PlannedFile }[] = [];
  for (const peer of peers) {
    const relPath = safePeerRolloutRelPath(sessionsDir, peer.relPath, peer.threadId);
    if (relPath === undefined) {
      result.rejected.push(peer.peerId);
      continue;
    }
    const { lines, dropped } = orderRolloutEntries(peer.entries);
    result.droppedLines += dropped;
    if (lines.length === 0) {
      result.rejected.push(peer.peerId);
      continue;
    }
    planned.push({
      peerId: peer.peerId,
      file: {
        path: join(sessionsDir, relPath),
        body: lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
      },
    });
  }
  const outcomes = writer === undefined ? undefined : await writer(planned.map(({ file }) => file));
  for (const [index, { peerId, file }] of planned.entries()) {
    const placed =
      outcomes === undefined
        ? await writeNewHere(codexHome, file)
        : outcomeToPlaced(outcomes[index]) === 'placed';
    (placed ? result.placed : result.present).push(peerId);
  }
  return result;
}

/**
 * SDK が resume の材料（生ログ・資格・設定）を書き出す一時ディレクトリの名前の頭。
 * SDK は `os.tmpdir()` の直下に mode 0700 で作り、子の `CLAUDE_CONFIG_DIR` をそこへ差し替える。
 * 作るのは runner（root）なので、別の UID で起こす子はそのままでは入れず、resume が会話を見つけられずに終わる。
 */
const SDK_RESUME_CONFIG_DIR_PREFIX = 'claude-resume-';

/**
 * 子へ渡す env が SDK の resume の一時ディレクトリを指していればそのパスを返す。
 * 名前と置き場所の両方で絞る: 人間がプロファイルで置いた `CLAUDE_CONFIG_DIR` の持ち主まで書き換えないため。
 */
export function sdkResumeConfigDirOf(
  env: Readonly<Record<string, string | undefined>>,
  tmp: string = tmpdir(),
): string | undefined {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir === undefined || dir.length === 0) return undefined;
  if (dirname(dir) !== tmp) return undefined;
  if (!basename(dir).startsWith(SDK_RESUME_CONFIG_DIR_PREFIX)) return undefined;
  return dir;
}

/**
 * 生ログのパス（`<設定ディレクトリ>/projects/<projectKey>/<sessionId>.jsonl`）が SDK の resume の一時ディレクトリの中なら、その会話の id を返す。
 * 一時ディレクトリはプロセスが終わると SDK が消すので、同じ id で開き直しても会話が見つからない。
 */
export function sessionIdInSdkResumeConfigDir(
  transcriptPath: string,
  tmp: string = tmpdir(),
): string | undefined {
  const configDir = dirname(dirname(dirname(transcriptPath)));
  if (basename(dirname(dirname(transcriptPath))) !== 'projects') return undefined;
  if (sdkResumeConfigDirOf({ CLAUDE_CONFIG_DIR: configDir }, tmp) === undefined) return undefined;
  const name = basename(transcriptPath);
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : undefined;
}

/** 1行でも読めなければ `undefined`: 欠けた会話から resume すると、欠けたことに気づかないまま続くため。 */
export function parseTranscriptEntries(text: string): unknown[] | undefined {
  const entries: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      return undefined;
    }
  }
  return entries.length === 0 ? undefined : entries;
}

/**
 * 木の持ち主を子へ移す。根は最後に移す: 根が root の 0700 のうちは他の子（同じ UID の別の委譲）が中へ入れず、移し終える前の中身に触れられないため。
 * symlink は辿らず、リンクそのものの持ち主だけを移す。
 */
export function chownTreeSync(
  root: string,
  uid: number,
  gid: number,
  chown: (path: string, uid: number, gid: number) => void = lchownSync,
): void {
  if (lstatSync(root).isDirectory()) {
    for (const name of readdirSync(root)) chownTreeSync(join(root, name), uid, gid, chown);
  }
  chown(root, uid, gid);
}
