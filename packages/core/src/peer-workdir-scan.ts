import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * peer のターンの間に、peer の作業場で変わったファイルを拾う（#4143）。
 *
 * Codex がコードでファイルを書いた（`commandExecution`）とき、道具の記録にはパスが残らない。
 * そこで、ターンの開始時刻以降に更新された通常ファイルを、ターンの終わりに作業場から探す。
 *
 * - `.git`・`node_modules` には降りない。symlink は辿らず、拾わない。
 * - 見る項目の数と深さに上限がある（{@link PEER_WORKDIR_SCAN_MAX_ENTRIES}・{@link PEER_WORKDIR_SCAN_MAX_DEPTH}）。
 *   打ち切ったら `truncated` に理由を書く（黙って「無い」に見せない）。
 * - 読めないディレクトリは飛ばし、数を `unreadable` に残す。
 */

/** 見る項目（ファイルとディレクトリ）の上限。 */
export const PEER_WORKDIR_SCAN_MAX_ENTRIES = 20_000;

/** 降りる深さの上限（作業場の直下が 1 段目）。 */
export const PEER_WORKDIR_SCAN_MAX_DEPTH = 8;

const SKIPPED_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules']);

export interface PeerWorkdirScan {
  /** 更新時刻が `sinceMs` 以降の通常ファイル（絶対パス。見つけた順）。 */
  readonly paths: readonly string[];
  /** 打ち切った理由（打ち切っていなければ無い）。 */
  readonly truncated?: string;
  /** 読めなかったディレクトリの数（0 なら無い）。 */
  readonly unreadable?: number;
}

/** {@link scanPeerWorkdir} の形（`PeerBrokerDeps` から差し込む）。 */
export type PeerWorkdirScanner = (dir: string, sinceMs: number) => Promise<PeerWorkdirScan>;

export async function scanPeerWorkdir(
  dir: string,
  sinceMs: number,
  limits: { maxEntries?: number; maxDepth?: number } = {},
): Promise<PeerWorkdirScan> {
  const maxEntries = limits.maxEntries ?? PEER_WORKDIR_SCAN_MAX_ENTRIES;
  const maxDepth = limits.maxDepth ?? PEER_WORKDIR_SCAN_MAX_DEPTH;
  const paths: string[] = [];
  let seen = 0;
  let unreadable = 0;
  let depthLimited = false;
  let countLimited = false;

  // 幅優先: 打ち切ったとき、浅いところ（peer が直に作ったもの）を先に拾っておくため
  let level: string[] = [dir];
  for (let depth = 1; level.length > 0 && !countLimited; depth += 1) {
    const next: string[] = [];
    for (const current of level) {
      let names: string[];
      try {
        names = await readdir(current);
      } catch {
        unreadable += 1;
        continue;
      }
      names.sort();
      for (const name of names) {
        if (seen >= maxEntries) {
          countLimited = true;
          break;
        }
        seen += 1;
        const path = join(current, name);
        let stat;
        try {
          stat = await lstat(path);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (SKIPPED_DIRS.has(name)) continue;
          if (depth >= maxDepth) depthLimited = true;
          else next.push(path);
          continue;
        }
        if (stat.isFile() && stat.mtimeMs >= sinceMs) paths.push(path);
      }
      if (countLimited) break;
    }
    level = next;
  }

  const reasons = [
    ...(countLimited ? [`${maxEntries} 項目を見たところで打ち切った`] : []),
    ...(depthLimited ? [`深さ ${maxDepth} 段より下は見ていない`] : []),
  ];
  return {
    paths,
    ...(reasons.length === 0 ? {} : { truncated: reasons.join('・') }),
    ...(unreadable === 0 ? {} : { unreadable }),
  };
}
