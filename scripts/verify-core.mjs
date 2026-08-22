/**
 * `pnpm verify` の「走るか、無料で返すか」の判定だけを切り出したもの。
 *
 * **切り出したのはテストのためである。** 判定を `verify.mjs` の中に置いたままだと、
 * 歯を書くには `pnpm build` から始まる一式を実際に走らせるしかなく、**測りたいもの
 * （指紋の判定）より桁違いに重いものを毎回走らせることになる。** 出力・挙動は1文字も
 * 変えていない（`verify.mjs` はこの2つを呼ぶだけになった）。
 *
 * 範囲・なぜその範囲か・見ていないものは `verify.mjs` の冒頭に在る。**あちらが正本。**
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ツリーの指紋。**読めなければ `null`** を返し、呼ぶ側は必ず走る側へ倒す
 * （「判定できない」を「変わっていない」へ倒さない）。
 */
export function fingerprint(repo) {
  const list = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  if (list.status !== 0 || head.status !== 0) return null;

  const hash = createHash('sha256');
  hash.update('HEAD:' + head.stdout.trim() + '\n');
  // **並びを固定する。** git の出力順に依存させると、環境で答えが変わりうる。
  for (const path of list.stdout.split('\0').filter(Boolean).sort()) {
    hash.update(path + '\0');
    try {
      hash.update(readFileSync(join(repo, path)));
    } catch {
      // 消えた・読めないファイルも「その状態」として指紋へ畳む（無視しない）。
      hash.update('<unreadable>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

/**
 * 無料で返してよいか。
 *
 * **倒す先は常に「走る」である。** 指紋が取れない・記録が無い・記録が壊れている・
 * `--force` — どれも `skip: false` になる。**「判定できない」を「変わっていない」へ
 * 倒さないこと**（倒すと、いちばん危ないときに黙って緑を名乗る）。
 */
export function decideSkip({ repo, recordPath, force = false }) {
  const current = fingerprint(repo);
  if (force) return { skip: false, reason: 'force', fingerprint: current };
  if (current === null) return { skip: false, reason: 'no-fingerprint', fingerprint: null };
  if (!existsSync(recordPath)) return { skip: false, reason: 'no-record', fingerprint: current };
  try {
    const saved = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (saved.fingerprint === current) {
      return { skip: true, reason: 'unchanged', fingerprint: current, at: saved.at };
    }
    return { skip: false, reason: 'changed', fingerprint: current };
  } catch {
    // 記録が壊れていたら走る側へ倒す（読めない記録を信じない）。
    return { skip: false, reason: 'broken-record', fingerprint: current };
  }
}
