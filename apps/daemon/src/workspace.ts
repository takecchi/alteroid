import {
  DEFAULT_WORKSPACE_POLICY,
  workspacePolicySchema,
  type WorkspacePolicy,
} from '@alteroid/core';

/**
 * workspace の運用選択を環境変数から読む（roadmap M5）。
 *
 * runner が増えると、「落ちた器で触っていた作業を別の器から続けられるか」は
 * **器の外側の運用**で決まる。決め方は3つで、既定は M4 と同じ `runner-volume`
 * （器ごとの volume）である。
 *
 * | `ALTEROID_WORKSPACE_KIND` | 続きを別の器で開けるか |
 * |---|---|
 * | `runner-volume`（既定） | 不可。落ちれば未コミットの作業ごと失われる（そのことは人間へ報告される） |
 * | `shared-volume` | 可。全 runner が同じパスで同じ FS を見ている前提 |
 * | `git` | 可。マネージャー自身が clone し直して続ける（未コミット分は失われる） |
 *
 * **「無理なら黙って runner-volume に落とす」をしない。** 共有 FS でも git でも
 * ないのに移送できるつもりでいると、マネージャーが空のディレクトリの上で作業を
 * 続ける。設定が足りなければ、そう言ってから既定へ落とす。
 */
export interface WorkspaceConfig {
  policy: WorkspacePolicy;
  /** 人間へ見せる注意（起動ログに出す）。 */
  notes: string[];
}

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const found = env[key];
  return found !== undefined && found.length > 0 ? found : undefined;
}

export function readWorkspaceConfig(env: NodeJS.ProcessEnv = process.env): WorkspaceConfig {
  const notes: string[] = [];
  const kind = value(env, 'ALTEROID_WORKSPACE_KIND');
  if (kind === undefined) return { policy: DEFAULT_WORKSPACE_POLICY, notes };

  if (kind === 'shared-volume') {
    // パスを省いたら委譲時の cwd をそのまま使う（`ALTEROID_WORKSPACE` の値）。
    const path = value(env, 'ALTEROID_WORKSPACE_PATH');
    return { policy: { kind: 'shared-volume', ...(path === undefined ? {} : { path }) }, notes };
  }

  if (kind === 'git') {
    const repository = value(env, 'ALTEROID_WORKSPACE_REPOSITORY');
    if (repository === undefined) {
      notes.push(
        'ALTEROID_WORKSPACE_KIND=git だが ALTEROID_WORKSPACE_REPOSITORY が無いので、' +
          'runner ごとの volume として扱います（器が落ちた委譲は別の器へ移せません）。',
      );
      return { policy: DEFAULT_WORKSPACE_POLICY, notes };
    }
    const ref = value(env, 'ALTEROID_WORKSPACE_REF') ?? 'main';
    return { policy: { kind: 'git', repository, ref }, notes };
  }

  const parsed = workspacePolicySchema.safeParse({ kind });
  if (parsed.success) return { policy: parsed.data, notes };

  notes.push(
    `ALTEROID_WORKSPACE_KIND=${kind} は読めないので、runner ごとの volume として扱います` +
      '（runner-volume / shared-volume / git のどれかを指定してください）。',
  );
  return { policy: DEFAULT_WORKSPACE_POLICY, notes };
}
