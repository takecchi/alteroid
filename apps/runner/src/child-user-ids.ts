import type { RunnerChildUser } from '@alteroid/core';

/**
 * 子の利用者を、所有者の指定に要る `{uid, gid}` だけへ絞る（`home` は渡さない）。
 * 資格・プロファイルの読み手・peer と道具のソケットの所有者は、どれも同じ形で受ける。
 */
export function childUserIds(
  childUser: RunnerChildUser | undefined,
): { uid: number; gid: number } | undefined {
  return childUser === undefined ? undefined : { uid: childUser.uid, gid: childUser.gid };
}
