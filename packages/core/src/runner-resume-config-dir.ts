import { lchownSync, lstatSync, readdirSync } from 'node:fs';
import { chown, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path';

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
 */
export async function placeSeedInConfigDir(
  configDir: string,
  key: { readonly projectKey: string; readonly sessionId: string },
  entries: readonly unknown[],
  owner?: { readonly uid: number; readonly gid: number },
): Promise<'placed' | 'present'> {
  if (!isPlainSegment(key.projectKey) || !isPlainSegment(key.sessionId)) {
    throw new Error('projectKey か sessionId がパスの1段として使えない形');
  }
  const projectsDir = join(configDir, 'projects');
  const projectDir = join(projectsDir, key.projectKey);
  assertNoSymlinkDirs(configDir, projectDir);
  const created = await mkdir(projectDir, { recursive: true, mode: 0o700 });
  assertNoSymlinkDirs(configDir, projectDir);
  if (owner !== undefined && created !== undefined) {
    // 作った段だけ子へ渡す: 既に在る段（子の HOME など）の持ち主は変えないため
    for (const dir of [configDir, projectsDir, projectDir]) {
      if (dir === created || dir.startsWith(`${created}/`)) await chown(dir, owner.uid, owner.gid);
    }
  }
  const file = join(projectDir, `${key.sessionId}.jsonl`);
  const body = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
  try {
    await writeFile(file, body, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'EEXIST') return 'present';
    throw error;
  }
  if (owner !== undefined) await chown(file, owner.uid, owner.gid);
  return 'placed';
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

// `created`（`mkdir -p` が最初に作った段）から `dir` までの、作った段だけを子へ渡す
async function chownCreated(
  dir: string,
  created: string | undefined,
  owner: { readonly uid: number; readonly gid: number } | undefined,
): Promise<void> {
  if (owner === undefined || created === undefined) return;
  const chain: string[] = [];
  for (let current = dir; current === created || current.startsWith(`${created}${sep}`);) {
    chain.unshift(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const path of chain) await chown(path, owner.uid, owner.gid);
}

async function writeNew(
  file: string,
  body: string,
  owner: { readonly uid: number; readonly gid: number } | undefined,
): Promise<boolean> {
  try {
    await writeFile(file, body, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as { code?: unknown }).code === 'EEXIST') return false;
    throw error;
  }
  if (owner !== undefined) await chown(file, owner.uid, owner.gid);
  return true;
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
  owner?: { readonly uid: number; readonly gid: number },
): Promise<{ placed: number; rejected: string[] }> {
  if (!isPlainSegment(key.projectKey) || !isPlainSegment(key.sessionId)) {
    throw new Error('projectKey か sessionId がパスの1段として使えない形');
  }
  const sessionDir = join(configDir, 'projects', key.projectKey, key.sessionId);
  const rejected: string[] = [];
  let placed = 0;
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
    if (lines.length === 0 && metadata.length === 0) continue;
    const file = join(sessionDir, `${subpath}.jsonl`);
    assertNoSymlinkDirs(configDir, dirname(file));
    const created = await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    assertNoSymlinkDirs(configDir, dirname(file));
    // 持ち主は、主の記録の段（`projects/<projectKey>`）から下の、作った段だけ移す
    await chownCreated(dirname(file), created, owner);
    if (lines.length > 0) {
      const body = lines.map((entry) => `${JSON.stringify(entry)}\n`).join('');
      if (await writeNew(file, body, owner)) placed += 1;
    }
    const last = metadata.at(-1);
    if (last !== undefined) {
      const sidecar = Object.fromEntries(Object.entries(last).filter(([name]) => name !== 'type'));
      await writeNew(join(sessionDir, `${subpath}.meta.json`), JSON.stringify(sidecar), owner);
    }
  }
  return { placed, rejected };
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
 * 作業者の分（{@link placeSubagentsInConfigDir}）と同じ守りを掛ける: symlink の段を断る・`wx`（既にあれば上書きしない。Codex が書き続けた最新が在る）・0600・作った段だけ子へ渡す。
 * 危ない `relPath`・ファイル名の peer は置かずに `peerId` を `rejected` に返す。
 */
export async function placePeersInCodexHome(
  codexHome: string,
  peers: readonly PeerRolloutSeed[],
  owner?: { readonly uid: number; readonly gid: number },
): Promise<{ placed: string[]; present: string[]; rejected: string[]; droppedLines: number }> {
  const sessionsDir = join(codexHome, 'sessions');
  const result = {
    placed: [] as string[],
    present: [] as string[],
    rejected: [] as string[],
    droppedLines: 0,
  };
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
    const file = join(sessionsDir, relPath);
    assertNoSymlinkDirs(codexHome, dirname(file));
    const created = await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    assertNoSymlinkDirs(codexHome, dirname(file));
    await chownCreated(dirname(file), created, owner);
    const body = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
    if (await writeNew(file, body, owner)) result.placed.push(peer.peerId);
    else result.present.push(peer.peerId);
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
