import { join } from 'node:path';

import {
  createManagerToolsSocketHost,
  DEFAULT_MANAGER_TOOLS_SOCKET_DIR,
  MANAGER_TOOLS_MCP_SERVER_NAME,
  MANAGER_TOOLS_SOCKET_FILENAME,
  reasonOf,
  type ManagerToolsSocketHost,
  type RunnerChildUser,
} from '@alteroid/core';

/**
 * マネージャー自身の道具（MCP `alteroid-manager`。#2987）のソケットを起動時に開く。peer と違い資格を待たない。
 *
 * 開けなくても runner は止めない: 道具が出ないだけで、委譲そのものは動くため。理由は stderr に1行出す。
 */
export async function openManagerToolsSocket(
  childUser: RunnerChildUser | undefined,
  dir: string = DEFAULT_MANAGER_TOOLS_SOCKET_DIR,
  write: (line: string) => void = (line) => process.stderr.write(line),
): Promise<ManagerToolsSocketHost | undefined> {
  try {
    return await createManagerToolsSocketHost({
      socketPath: join(dir, MANAGER_TOOLS_SOCKET_FILENAME),
      ...(childUser === undefined ? {} : { childUser: { uid: childUser.uid, gid: childUser.gid } }),
    });
  } catch (error) {
    write(
      `alteroid-runner: MCP ${MANAGER_TOOLS_MCP_SERVER_NAME} のソケットを開けなかった` +
        `（マネージャーに output_record を出さない）: ${reasonOf(error)}\n`,
    );
    return undefined;
  }
}
