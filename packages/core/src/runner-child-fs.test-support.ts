import { spawn } from 'node:child_process';

import type { ChildFsSpawn } from './runner-child-fs.js';

/** 起こした子プロセスの pid（試験が「runner 本体ではない別のプロセスが書いた」を確かめる）。 */
export const spawnedPids: (number | undefined)[] = [];

/**
 * 試験用の子プロセスの起こし方: uid を降ろさず（試験は root ではない）、本物の子プロセスで書かせる。
 * 実運用の `spawnAsUser` と違うのは `uid`・`gid` を渡さない点だけ。
 */
export const sameUidSpawn: ChildFsSpawn = (options) => {
  const child = spawn(options.command, options.args, {
    env: options.env as NodeJS.ProcessEnv,
    signal: options.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  spawnedPids.push(child.pid);
  return child;
};
