import { readCredential } from './credentials.js';
import * as daemon from './daemon.js';

/**
 * どのデーモンへ、どの資格で繋ぐか。
 *
 * 2通りある。
 *
 * - **手元のデーモン**（既定）— 居なければ起こし、`state/daemon.json` の token を
 *   提示する。これは*実行環境の持ち主*の資格であり、ログインしていなくても通る。
 *   守っているのはファイルの許可であって、新しい秘密ではない。
 * - **別のデーモン**（`ALTEROID_URL`）— 起こさない。`alteroid login` で受け取った
 *   アクセストークンを提示する。クラウドに常駐させたものへ手元から繋ぐ形である。
 *
 * ここを1箇所にまとめてあるのは、経路ごとに「どっちの鍵を出すか」を書くと必ず
 * 食い違うからである。
 */

export const REMOTE_URL_ENV = 'ALTEROID_URL';

export interface Target {
  baseUrl: string;
  /** 付ける認証ヘッダ（無ければ空）。 */
  headers: Record<string, string>;
  remote: boolean;
  /** ログイン済みでないために資格を出せていないなら、その旨。 */
  note: string | null;
}

function remoteUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env[REMOTE_URL_ENV] ?? '').trim().replace(/\/+$/, '');
  return value.length > 0 ? value : null;
}

/** 起こさずに接続先だけ決める（`daemon status` のように生死を見る用途）。 */
export async function resolveTargetWithoutStarting(): Promise<Target | null> {
  const remote = remoteUrl();
  if (remote !== null) return remoteTarget(remote);

  const { info } = await daemon.status();
  if (info === null) return null;
  return localTarget(daemon.baseUrl(info), info.token);
}

/** 接続先を決める。手元のデーモンなら居なければ起こす。 */
export async function resolveTarget(): Promise<Target> {
  const remote = remoteUrl();
  if (remote !== null) return remoteTarget(remote);

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
  const credential = await readCredential(baseUrl);
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

/**
 * デーモンが返す 403 の本文（`apps/daemon/src/app.ts`）のうち、案内を分ける
 * 根拠にする2つの逐語。
 *
 * **ここへ複製する。`apps/daemon` からは import しない。** import すれば
 * `forbiddenKindOf` はデーモン側の定数と自己整合するだけになり、デーモンの
 * 文言が変わった瞬間に気づかず追随してしまう（変わったことを検出する歯が
 * 無くなる）。CLI はサーバの契約として本文を受け取る側なので、その契約を
 * 自分の言葉で1回だけ書き写しておく——ずれたら CLI 側のテストが落ちる形に
 * するためである。
 */
const NOT_OPERATOR_ERROR = '実行環境の持ち主だけが操作できる';
const NOT_GRANTED_ERROR = 'このアカウントには alteroid を使う許可が無い';

/**
 * 403 の理由。`not_operator` と `not_granted` は意味も解決策も正反対
 * （前者は「器の中で実行しろ」、後者は「持ち主に access grant してもらえ」）。
 * `unknown` は「本文からはどちらとも判別できない」——当てずっぽうで片方を
 * 出すと、状況によっては必ず嘘の案内になる。
 */
export type ForbiddenKind = 'not_operator' | 'not_granted' | 'unknown';

/**
 * 403 の応答本文から、どちらの理由で拒否されたかを判別する。
 *
 * 判別できないときは `'unknown'` を返す。呼び出し側はこのとき解決策を
 * 書かないこと（`token.ts` / `profile.ts` / `access.ts` の doc を見よ）。
 */
export function forbiddenKindOf(body: unknown): ForbiddenKind {
  if (typeof body !== 'object' || body === null) return 'unknown';
  const error = (body as { error?: unknown }).error;
  if (error === NOT_OPERATOR_ERROR) return 'not_operator';
  if (error === NOT_GRANTED_ERROR) return 'not_granted';
  return 'unknown';
}

/**
 * 認証まわりの失敗を、人間が次にやることの分かる文言にする。
 *
 * 401 と 403 は意味がまるで違う（やり直せば直るのか、人間の操作が要るのか）ので、
 * 同じ「失敗しました」に潰さない。
 */
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
