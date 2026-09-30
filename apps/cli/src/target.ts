import { CredentialsUnreadableError, readCredential } from './credentials.js';
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
 *
 * **例外が1つある——runner の器の中では「居なければ起こす」をしない。**
 * 詳細と理由は {@link resolveTarget} と {@link isRunnerContainer} の doc に
 * まとめてある（#2093。ここに複製しない）。
 */

export const REMOTE_URL_ENV = 'ALTEROID_URL';

/**
 * runner の器の中かどうかを示す印。`apps/runner/src/index.ts` の
 * `runnerIdOf` が読む変数と同じもの——子（マネージャー・作業者）の
 * セッションにも env として届く。
 */
export const RUNNER_ID_ENV = 'ALTEROID_RUNNER_ID';

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

/**
 * いま runner の器の中（委譲されたマネージャー・作業者のセッション）で
 * 動いているかどうか。
 *
 * **#2093 —— なぜここで区別するか。** runner の器の中で `alteroid` の CLI を
 * 打つと、手元に居ないデーモンを暗黙に起こしてしまい、次の3つが起きる:
 * 1. **誤認** —— 起きるのは器の中だけの、runner 1台・履歴0件の空のデーモン
 *    だが、デーモンの版はイメージに焼き込まれた版を名乗るので本番と区別が
 *    つかない。打った側は本番の姿を見たと誤解しうる
 * 2. **資源** —— 起きたデーモンは detached で unref され、器に残り続ける
 *    (pids・メモリ。#1334 と同じ場所を食う)
 * 3. **鍵** —— `~/.alteroid/credentials.json` が runner の子の HOME に
 *    新しく作られる
 *
 * **印を `ALTEROID_RUNNER_ID` にした理由** —— `apps/runner/src/index.ts` の
 * `runnerIdOf` が読む変数と同じもので、runner が子プロセス(マネージャー・
 * 作業者のセッション)を起こすときの env に乗って届く。値そのものは見ない
 * (どの runner かは関係ない)。在って空でなければ「runner の中」とだけ判定する。
 *
 * **依存 —— 子へ渡す env が将来絞られると、この印が届かなくなって黙って
 * 効かなくなる。** 現状 `ALTEROID_RUNNER_ID` は `packages/core/src/runner.ts`
 * の `WITHHELD_ENV_KEYS` に載っていないので子へ渡るが、載せる変更が
 * 独立に入れば、ここは全部「runner の外」に見えてしまい、暗黙の起動が
 * 再発する —— 気づく歯が無い。触るなら、ここのコメントと歯
 * (`target.test.ts` の runner 判定のテスト)を一緒に見ること。
 */
export function isRunnerContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[RUNNER_ID_ENV] ?? '').trim().length > 0;
}

/**
 * runner の器の中で、暗黙の起動を断るときの文言。
 *
 * env の値(`ALTEROID_RUNNER_ID` の中身など)は載せない —— 変数の名前だけ言う。
 */
export const RUNNER_NO_AUTOSTART_MESSAGE =
  'この器は runner(委譲先)なので、手元のデーモンを暗黙には起こしません。\n' +
  '本番を見るなら ALTEROID_URL を指定して alteroid login してください。\n' +
  'どうしてもこの器にデーモンを立てるなら、明示の alteroid daemon start を使ってください。';

/** 起こさずに接続先だけ決める（`daemon status` のように生死を見る用途）。 */
export async function resolveTargetWithoutStarting(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Target | null> {
  const remote = remoteUrl(env);
  if (remote !== null) return remoteTarget(remote);

  const { info } = await daemon.status();
  if (info === null) return null;
  return localTarget(daemon.baseUrl(info), info.token);
}

/**
 * 接続先を決める。手元のデーモンなら、既定では居なければ起こす。
 *
 * **例外 —— runner の器の中({@link isRunnerContainer})では起こさない
 * (#2093)。** `ALTEROID_URL` が無く、かつ runner の器の中なら:
 * - 手元のデーモンが既に居れば(`daemon.status()` が `present`)、そのまま
 *   繋ぐ —— 読むだけの操作まで塞ぐ理由が無い
 * - 居なければ(`presence` が `absent` / `unknown`)、起こさずに
 *   {@link RUNNER_NO_AUTOSTART_MESSAGE} を投げる
 *
 * **明示の `alteroid daemon start`(`index.ts` の `daemonStartCommand`)は
 * ここを通らない。** `daemon.start()` / `daemon.startWithRecovery()` を直接
 * 呼ぶ別経路であり、この関数が塞ぐのは「暗黙の」起動だけ —— 起こす能力
 * そのものは runner の中でも残す。
 *
 * **`env` を渡せるのはテストのため。** 省略時は `process.env` —— 挙動は
 * これまでと1文字も変わらない。
 */
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
    // 在るのに読めない（権限・壊れ）は「ログインしていない」ではない（#2447）。
    // 文は資格の値を含まない（パスと code まで）。
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

/**
 * デーモンが返す 403 の本文（`apps/daemon/src/app.ts`）のうち、案内を分ける
 * 根拠にする3つの逐語。
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
 * `requireOwner`（issue #1198）が返す本文。`apps/daemon/src/app.ts` の
 * `requireOwner` の逐語（`grep -Fn -- '実行環境の持ち主として宣言されたアカウントだけが操作できる' apps/daemon/src/app.ts`）。
 * `NOT_OPERATOR_ERROR` とは別の状態を指す——こちらは「ログインして許可も
 * 得ているが、その端末から宣言されていない」であり、直し方も別
 * （`alteroid access owner <id>`。器の中で実行しろ、ではない）。
 */
const NOT_DECLARED_OWNER_ERROR = '実行環境の持ち主として宣言されたアカウントだけが操作できる';

/**
 * 403 の理由。`not_operator` と `not_granted` は意味も解決策も正反対
 * （前者は「器の中で実行しろ」、後者は「持ち主に access grant してもらえ」）。
 * `not_declared_owner` は issue #1198 で足した3つ目——`access grant` は
 * 済んでいるが `alteroid access owner` による宣言がまだ無い状態で、
 * `PUT /credentials` `POST /reset` のような `requireOwner` 経路だけが返す。
 * `unknown` は「本文からはどちらとも判別できない」——当てずっぽうで片方を
 * 出すと、状況によっては必ず嘘の案内になる。
 */
export type ForbiddenKind = 'not_operator' | 'not_granted' | 'not_declared_owner' | 'unknown';

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
  if (error === NOT_DECLARED_OWNER_ERROR) return 'not_declared_owner';
  return 'unknown';
}

/**
 * 認証まわりの失敗を、人間が次にやることの分かる文言にする。
 *
 * 401 と 403 は意味がまるで違う（やり直せば直るのか、人間の操作が要るのか）ので、
 * 同じ「失敗しました」に潰さない。
 *
 * **`kind` を渡すと 403 の案内が変わる。** 省略時（`'unknown'`）は従来どおり
 * `access grant` の案内を返す——`chat.ts` / `inbox.ts` のように `forbiddenKindOf`
 * を呼ばずにここへ丸投げしている経路は、その挙動のままでよい（それらの経路は
 * `authenticate` だけが門なので、403 はほぼ必ず未許可が理由である）。
 */
export function describeAuthFailure(
  status: number,
  target: Target,
  kind: ForbiddenKind = 'unknown',
): string | null {
  if (status === 401) {
    return target.remote
      ? `認証されませんでした。alteroid login でログインし直してください（${target.baseUrl}）`
      : '認証されませんでした。デーモンを起動し直してください（alteroid daemon stop && alteroid chat）';
  }
  if (status === 403) {
    if (kind === 'not_declared_owner') {
      return (
        '実行環境の持ち主として宣言されたアカウントだけが操作できます' +
        '（alteroid access grant だけでは足りません）。\n' +
        'デーモンが動いている環境で次を実行してください:\n' +
        '  alteroid access list\n' +
        '  alteroid access owner <アカウント id>'
      );
    }
    return (
      'このアカウントには alteroid を使う許可がありません。\n' +
      'デーモンが動いている環境で次を実行してください:\n' +
      '  alteroid access list\n' +
      '  alteroid access grant <アカウント id>'
    );
  }
  return null;
}
