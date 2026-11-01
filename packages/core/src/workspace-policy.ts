import { redactSecretsInText } from './denial-input-head.js';
import type { WorkspaceLocator } from './schema.js';

/**
 * workspace の運用選択。方針であって能力の制限ではないので設定で切り替わる
 * （選ばれなかった分岐を削らない。north_star 禁止2）。
 */
export type WorkspacePolicy =
  | { kind: 'runner-volume' }
  | { kind: 'shared-volume' }
  | { kind: 'git'; repository: string; ref: string }
  /** 理由を必ず持つ: 理由の無い「分からない」は値と同じ（取れない軸に 0 の行を作る）。 */
  | { kind: 'unknown'; reason: string };

/** `ALTEROID_WORKSPACE_KIND` を読む。 */
export const WORKSPACE_KIND_ENV_KEY = 'ALTEROID_WORKSPACE_KIND';
/** `=git` のときだけ要る。 */
export const WORKSPACE_REPOSITORY_ENV_KEY = 'ALTEROID_WORKSPACE_REPOSITORY';
/** `=git` のときの ref。省略時は `main`。 */
export const WORKSPACE_REF_ENV_KEY = 'ALTEROID_WORKSPACE_REF';

/** デーモンからは `/workspace` がボリュームか毎デプロイで消えるのかを知る手段が無い。運用者が明示しない限り `unknown`。 */
const UNVERIFIED_WORKSPACE_REASON =
  '器の workspace がボリュームかどうかを runner が名乗らないので、' +
  '入れ替えを跨いで残るかを確かめられない（roadmap M5「workspace locator の運用選択」）。';

/**
 * `ALTEROID_WORKSPACE_PATH` は作らない: `shared-volume` のパスは委譲の `cwd` を使う。別の env に書かせると
 * 実際に作業している場所と食い違いうる。
 * 読めない設定は `runner-volume` へ倒さない: 存在しない永続性を台帳が主張することになる
 * （`schema.ts` の `WorkspaceLocator`）。倒す先は理由つきの `unknown`（行に残るので後から読む人に届く）。
 */
export function workspaceLocatorFrom(
  policy: WorkspacePolicy,
  runnerId: string,
  cwd: string,
): WorkspaceLocator {
  switch (policy.kind) {
    case 'runner-volume':
      return { kind: 'runner-volume', runnerId, path: cwd };
    case 'shared-volume':
      return { kind: 'shared-volume', path: cwd };
    case 'git':
      return { kind: 'git', repository: policy.repository, ref: policy.ref };
    case 'unknown':
      return { kind: 'unknown', runnerId, path: cwd, reason: policy.reason };
    default: {
      const exhaustive: never = policy;
      throw new Error(`未知の WorkspacePolicy: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 移送で `runner-volume` を `unknown` へ落とすときの理由。 */
const RELOCATED_WORKSPACE_REASON =
  '別の runner へ移送した。移送で workspace の中身は運ばれていない（元の runner の volume に在った作業は、' +
  '移送先には無い）ので、移送先の volume に残ると言えない。';

/**
 * 別の runner へ移した後の locator。`runner-volume` は `unknown` へ落とす: 移送先へ付け替えると
 * 運ばれていない作業が移送先の volume に在ると主張し、元のまま残すと落ちた器を指し続ける。
 * `shared-volume` / `git` は `runnerId` を持たないので変えない。
 */
export function workspaceAfterRelocation(
  workspace: WorkspaceLocator | undefined,
  toRunnerId: string,
): WorkspaceLocator | undefined {
  if (workspace === undefined) return undefined;
  switch (workspace.kind) {
    case 'unknown':
      return { ...workspace, runnerId: toRunnerId };
    case 'runner-volume':
      return {
        kind: 'unknown',
        runnerId: toRunnerId,
        path: workspace.path,
        reason: RELOCATED_WORKSPACE_REASON,
      };
    default:
      return workspace;
  }
}

/** userinfo がアカウント名（`git@` 等）で、秘密ではない慣習の scheme。 */
const WORKSPACE_REPOSITORY_USERNAME_ONLY_PROTOCOLS: ReadonlySet<string> = new Set([
  'ssh:',
  'git+ssh:',
  'ssh+git:',
  'sftp:',
  'git:',
  'rsync:',
]);

/**
 * ssh 系 scheme の **パスワードの無い** userinfo（`ssh://git@host/…`）はアカウント名なので落とさない。
 * URL として読めない形は安全側に倒し、URL の解釈では落とせない資格を字面の伏せ字に任せる。
 */
function redactWorkspaceRepository(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return redactSecretsInText(raw, undefined);
  }
  if (parsed.host === '') return redactSecretsInText(raw, undefined);
  const keepUsername =
    parsed.password === '' && WORKSPACE_REPOSITORY_USERNAME_ONLY_PROTOCOLS.has(parsed.protocol);
  const hasCredential = keepUsername ? false : parsed.username !== '' || parsed.password !== '';
  if (!hasCredential && parsed.search === '' && parsed.hash === '') {
    return redactSecretsInText(raw, undefined);
  }
  if (!keepUsername) parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return redactSecretsInText(parsed.toString(), undefined);
}

export function resolveWorkspacePolicy(env: NodeJS.ProcessEnv = process.env): WorkspacePolicy {
  const kindRaw = env[WORKSPACE_KIND_ENV_KEY];
  const kind = kindRaw === undefined ? '' : kindRaw.trim();

  if (kind.length === 0) {
    return { kind: 'unknown', reason: UNVERIFIED_WORKSPACE_REASON };
  }
  if (kind === 'runner-volume') {
    return { kind: 'runner-volume' };
  }
  if (kind === 'shared-volume') {
    return { kind: 'shared-volume' };
  }
  if (kind === 'git') {
    const repositoryRaw = env[WORKSPACE_REPOSITORY_ENV_KEY];
    const repositoryTrimmed = repositoryRaw === undefined ? '' : repositoryRaw.trim();
    if (repositoryTrimmed.length === 0) {
      return {
        kind: 'unknown',
        reason:
          `${WORKSPACE_KIND_ENV_KEY}=git だが ${WORKSPACE_REPOSITORY_ENV_KEY} が無いので、` +
          '運用選択を決められない。',
      };
    }
    const refRaw = env[WORKSPACE_REF_ENV_KEY];
    const ref = refRaw === undefined ? '' : refRaw.trim();
    const repository = redactWorkspaceRepository(repositoryTrimmed);
    return { kind: 'git', repository, ref: ref.length === 0 ? 'main' : ref };
  }
  return {
    kind: 'unknown',
    reason: `${WORKSPACE_KIND_ENV_KEY}=${kind} は読めない（runner-volume / shared-volume / git のどれか）。`,
  };
}
