import { CredentialsUnreadableError, readCredential } from './credentials.js';
import * as daemon from './daemon.js';

export const REMOTE_URL_ENV = 'ALTEROID_URL';

export const RUNNER_ID_ENV = 'ALTEROID_RUNNER_ID';

export interface Target {
  baseUrl: string;
  headers: Record<string, string>;
  remote: boolean;
  note: string | null;
}

function remoteUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env[REMOTE_URL_ENV] ?? '').trim().replace(/\/+$/, '');
  return value.length > 0 ? value : null;
}

// `ALTEROID_RUNNER_ID` が `WITHHELD_ENV_KEYS` に載ると、全部「runner の外」に見えて暗黙の起動が再発する: 子へ渡る前提のため
export function isRunnerContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[RUNNER_ID_ENV] ?? '').trim().length > 0;
}

export const RUNNER_NO_AUTOSTART_MESSAGE =
  'この器は runner(委譲先)なので、手元のデーモンを暗黙には起こしません。\n' +
  '本番を見るなら ALTEROID_URL を指定して alteroid login してください。\n' +
  'どうしてもこの器にデーモンを立てるなら、明示の alteroid daemon start を使ってください。';

export async function resolveTargetWithoutStarting(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Target | null> {
  const remote = remoteUrl(env);
  if (remote !== null) return remoteTarget(remote);

  const { info } = await daemon.status();
  if (info === null) return null;
  return localTarget(daemon.baseUrl(info), info.token);
}

// runner の器の中では暗黙に起こさない: 空のデーモンを本番と誤認し、器に残り続け、子の HOME に資格ファイルが作られるため
export async function resolveTarget(env: NodeJS.ProcessEnv = process.env): Promise<Target> {
  const remote = remoteUrl(env);
  if (remote !== null) return remoteTarget(remote);

  if (isRunnerContainer(env)) {
    const current = await daemon.status();
    if (current.presence === 'present' && current.info) {
      return localTarget(daemon.baseUrl(current.info), current.info.token);
    }
    throw new Error(RUNNER_NO_AUTOSTART_MESSAGE);
  }

  const info = await daemon.ensureRunning();
  return localTarget(daemon.baseUrl(info), info.token);
}

function localTarget(baseUrl: string, token: string): Target {
  return {
    baseUrl,
    headers: { authorization: `Bearer ${token}` },
    remote: false,
    note: null,
  };
}

async function remoteTarget(baseUrl: string): Promise<Target> {
  let credential: Awaited<ReturnType<typeof readCredential>>;
  try {
    credential = await readCredential(baseUrl);
  } catch (error) {
    // 「ログインしていない」と言い換えない: 在るのに読めないだけのため
    if (error instanceof CredentialsUnreadableError) {
      return { baseUrl, headers: {}, remote: true, note: error.message };
    }
    throw error;
  }
  if (credential === null) {
    return {
      baseUrl,
      headers: {},
      remote: true,
      note: `${baseUrl} にログインしていません（alteroid login）`,
    };
  }
  return {
    baseUrl,
    headers: { authorization: `Bearer ${credential.token}` },
    remote: true,
    note: null,
  };
}

// `apps/daemon` から import しない: デーモンの文言が変わったときに気づかず追随し、変わったことを検出できなくなるため
const NOT_OPERATOR_ERROR = '実行環境の持ち主だけが操作できる';
const NOT_GRANTED_ERROR = 'このアカウントには alteroid を使う許可が無い';

// `unknown` で解決策を書かない: 当てずっぽうで片方を出すと、状況によっては必ず嘘の案内になるため
export type ForbiddenKind = 'not_operator' | 'not_granted' | 'unknown';

export function forbiddenKindOf(body: unknown): ForbiddenKind {
  if (typeof body !== 'object' || body === null) return 'unknown';
  const error = (body as { error?: unknown }).error;
  if (error === NOT_OPERATOR_ERROR) return 'not_operator';
  if (error === NOT_GRANTED_ERROR) return 'not_granted';
  return 'unknown';
}

export function describeAuthFailure(status: number, target: Target): string | null {
  if (status === 401) {
    return target.remote
      ? `認証されませんでした。alteroid login でログインし直してください（${target.baseUrl}）`
      : '認証されませんでした。デーモンを起動し直してください（alteroid daemon stop && alteroid chat）';
  }
  if (status === 403) {
    return (
      'このアカウントには alteroid を使う許可がありません。\n' +
      'デーモンが動いている環境で次を実行してください:\n' +
      '  alteroid access list\n' +
      '  alteroid access grant <アカウント id>'
    );
  }
  return null;
}
