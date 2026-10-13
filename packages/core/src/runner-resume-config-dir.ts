import { lchownSync, lstatSync, readdirSync } from 'node:fs';
import { chown, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// パスの1段に使える名前か: SDK が渡す projectKey・sessionId でも、`/` や `..` を含めば書かない
function isPlainSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
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
  const created = await mkdir(projectDir, { recursive: true, mode: 0o700 });
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
