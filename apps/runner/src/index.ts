#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createCredentialStore,
  createProfileVessel,
  createRunnerHost,
  DEFAULT_PROFILE_PATH,
  installUncaughtNet,
  placedManagerModels,
  resolveManagerModel,
  resolveWorkerModel,
  WITHHELD_ENV_KEYS,
  writeStderrSync,
  type RunnerChildUser,
} from '@alteroid/core';
import { createAdaptorServer } from '@hono/node-server';

import { createRunnerApp, Outbox } from './app.js';

export { createRunnerApp, Outbox, type RunnerAppDeps, type RunnerAppType } from './app.js';

/**
 * alteroid-runner — マネージャーと作業者を隔離して走らせる常駐プロセス。
 *
 * ここには**記憶ストアへ到達する鍵が無い**。それがこのプロセスを分けた理由で
 * あり、M4 の受け入れ基準3（マネージャーから記憶ストアへの認証経路が存在しない）は
 * この分離で初めて構造的に成立する。
 *
 * **制御面もマネージャーから触らせない。** マネージャーはこの器の中で走る子プロセス
 * なので、この API を叩けてしまうと自分宛の許可確認に自分で `allow` を返せる。
 * 3枚で塞ぐ:
 *
 * 1. **待ち受けは Unix ソケット**（コンテナ構成）。TCP の口が無いので `curl
 *    http://127.0.0.1:...` の宛先自体が存在しない
 * 2. **ソケットの所有者はデーモンの UID・モード 0600**。別 UID の子プロセスは繋げない
 * 3. **子プロセスは別 UID で走る**。runner の `/proc/1/environ` も読めないので、
 *    合鍵（ハッシュしか置いていないが）にもソケットにも手が届かない
 *
 * **ここに DB 接続や人格データの読み書きを足さないこと。** 足した瞬間、マネージャーが
 * 同じ器の中から鍵を取れる状態に戻る。
 */
export function runnerIdOf(env: NodeJS.ProcessEnv = process.env): string {
  const given = env.ALTEROID_RUNNER_ID;
  if (given !== undefined && given.length > 0) return given;
  // 既定は固定名。M4 は1台構成であり、器を作り直しても同じ宛先として戻る
  // （台帳に残った runner_id と突き合わせられる）。
  return 'runner-primary';
}

/**
 * 器がこのプロセスを畳むまでに与える猶予。**ここにあるのは写しである。**
 *
 * 正本は `railway/runner.json` の `drainingSeconds` と `compose.yaml`（`runner`）の
 * `stop_grace_period` で、**どちらも実行中のプロセスからは読めない**（Railway の
 * deploy 設定も compose の設定も環境変数として降りてこない）。環境変数で渡す形に
 * すると、猶予そのものと env がずれる二重管理が新しく増えるだけなので、写しを持って
 * 対応関係をここに書くほうを選んでいる。**あちらを変えるならここも変えること**
 * （`railway/README.md`「畳む時間を渡す」に逆向きの導線がある）。
 *
 * **デーモン側（`apps/daemon/src/index.ts`）と同じ数だが、共有していない。** 猶予は
 * Service ごとの設定であり、片方だけ延ばしたくなる日がある（runner は生ログを渡し切る
 * 時間、デーモンは蒸留1本ぶん、と用途が違う）。1つに寄せると、その日に両方が動く。
 */
const SHUTDOWN_GRACE_MS = 60_000;

/**
 * SIGTERM から、自分で見切りをつけて `exit` するまで。
 *
 * **猶予と同着にしないための5秒である。** 猶予が切れる時刻には器の SIGKILL が来る
 * ので、ここを `SHUTDOWN_GRACE_MS` ちょうどにすると、「行儀よく終われなかったときに
 * それでも自分の意思で終わる」という最後の口が SIGKILL に負けて消える。**揃えない
 * こと。** 5秒は `process.exit(0)` が確実に先に走るための余裕であって、片付けに使う
 * 作業時間ではない。
 */
const FORCED_EXIT_MS = SHUTDOWN_GRACE_MS - 5_000;

/** 空文字は「未指定」。 */
function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * 制御面の合鍵の sha256（16進）。
 *
 * **素の値（`ALTEROID_RUNNER_TOKEN`）が来ていたら、ここで畳む。** 人間が置くのは
 * デーモンと同じ値ひとつでよい、という体験のためである。守りは変わらない — 素の値は
 * 畳んだ直後に環境から落とすし、器の起動スクリプト（`docker/alteroid-runner`）は
 * `exec` の前に落としているので、**runner のプロセスに素の鍵は残らない**。
 * ここに素の値が届くのは、スクリプトを通さず `node` を直に叩いたときだけである。
 *
 * 両方が置かれていて食い違うときは落とす。黙って片方を選ぶと、人間は「置いた」、
 * runner は 401 を返し続け、**どちらも正しいまま噛み合わない**（鍵まわりで実際に
 * 起きた壊れ方である）。
 */
export function tokenSha256Of(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const given = envValue(env, 'ALTEROID_RUNNER_TOKEN_SHA256');
  const raw = envValue(env, 'ALTEROID_RUNNER_TOKEN');
  if (raw === undefined) return given;

  const folded = createHash('sha256').update(raw, 'utf8').digest('hex');
  if (given !== undefined && given !== folded) {
    throw new Error(
      'ALTEROID_RUNNER_TOKEN と ALTEROID_RUNNER_TOKEN_SHA256 が食い違っている' +
        '（どちらか一方だけを置くこと。既定はデーモンと同じ ALTEROID_RUNNER_TOKEN）',
    );
  }
  return folded;
}

/**
 * 子プロセスを降ろす UID。
 *
 * **設定されているのに降ろせないなら落とす。** 同じ UID のまま走り続けると、
 * 境界があるつもりで無い状態になる（いちばん危ない）。
 */
export function childUserOf(env: NodeJS.ProcessEnv = process.env): RunnerChildUser | undefined {
  const uid = envValue(env, 'ALTEROID_RUNNER_CHILD_UID');
  if (uid === undefined) return undefined;
  const gid = envValue(env, 'ALTEROID_RUNNER_CHILD_GID') ?? uid;
  const home = envValue(env, 'ALTEROID_RUNNER_CHILD_HOME');
  return {
    uid: Number(uid),
    gid: Number(gid),
    ...(home === undefined ? {} : { home }),
  };
}

export async function main(): Promise<void> {
  const runnerId = runnerIdOf();
  const workspacePath = process.env.ALTEROID_WORKSPACE || process.cwd();

  // 合鍵は**ハッシュだけを持つ**。素の値で渡されたら畳んで、環境からは落とす。
  const tokenSha256 = tokenSha256Of();
  if (tokenSha256 === undefined) {
    throw new Error(
      'ALTEROID_RUNNER_TOKEN が要る（制御面の本人確認。' +
        'デーモンと同じ値を置くこと。sha256 を直に渡すなら ALTEROID_RUNNER_TOKEN_SHA256）',
    );
  }
  // 子プロセスへ配る env は `WITHHELD_ENV_KEYS` でも落ちるが、**この器の環境からも
  // 消す**。二重の底であって、どちらか一方に頼らない。
  delete process.env.ALTEROID_RUNNER_TOKEN;

  const childUser = childUserOf();
  if (childUser !== undefined && process.getuid?.() !== 0) {
    throw new Error(
      'ALTEROID_RUNNER_CHILD_UID が指定されているが、UID を降ろす特権が無い。' +
        '同じ UID で走らせると子プロセスが制御面に手を届かせるので起動しない。',
    );
  }

  /**
   * マネージャーの道具の鍵は、env のスナップショットではなく器から配る。
   *
   * env のまま配ると、鍵はこのプロセスが起動した瞬間に凍る。人間が鍵を直しても
   * 器を作り直すまで届かず、**「鍵を直す」と「走行中の仕事を失う」が同じ操作**に
   * なる（`credentials.ts` に経緯）。読む主体は SDK 子プロセスなので、降ろす UID で
   * 読めるようにしておく。
   */
  const credentials = createCredentialStore({
    ...(envValue(process.env, 'ALTEROID_CREDENTIAL_DIR') === undefined
      ? {}
      : { dir: process.env.ALTEROID_CREDENTIAL_DIR as string }),
    ...(childUser === undefined ? {} : { reader: { uid: childUser.uid, gid: childUser.gid } }),
    // 伏せる鍵は鍵として配れない。**伏せる仕組みと配る仕組みを結び付けておく** —
    // 別々のままだと、後から足した配る側が前からある守りを黙って越える。
    withheldEnvKeys: WITHHELD_ENV_KEYS,
  });
  const seeded = await credentials.flush();
  process.stdout.write(
    `alteroid-runner: 鍵 ${seeded.length} 件を器へ置きました${seeded
      .map((entry) => ` ${entry.name}=${entry.sha256}`)
      .join('')}\n`,
  );

  /**
   * 実行環境プロファイル（`.zprofile` 相当）の器。
   *
   * **runner は中身を取りに行かない。** 記憶ストアを読める runner は、その中の
   * 子プロセス（＝マネージャー）が鍵に届く runner である（M4 受け入れ基準3）。
   * デーモンが繋いだときに降ろしてくるので、ここでは置き場を用意するだけでよい。
   */
  const profilePath = envValue(process.env, 'ALTEROID_PROFILE_FILE') ?? DEFAULT_PROFILE_PATH;
  // **前の器の置き土産を引き継がない。** 置き場は volume なので、器を作り直しても
  // ファイルは残る。残ったものを配ると、デーモンが降ろす前の一瞬だけ古い
  // プロファイルが効く（しかも指紋は「無い」と答えるので誰も気づけない）。
  rmSync(profilePath, { force: true });
  const profile = createProfileVessel({
    path: profilePath,
    ...(childUser === undefined ? {} : { reader: { uid: childUser.uid, gid: childUser.gid } }),
    withheldEnvKeys: WITHHELD_ENV_KEYS,
  });

  const outbox = new Outbox();
  const host = createRunnerHost({
    runnerId,
    workspacePath,
    emit: (event) => outbox.push(event),
    credentials,
    profile,
    ...(childUser === undefined ? {} : { childUser }),
    /**
     * **貸し出し期限の自己失効はこの器（コンテナで走る常駐プロセス）だけが有効にする**
     * （roadmap M5 PR4）。同一プロセスの `runner-local`（`alteroid chat` のローカル
     * 実行）では「デーモンだけが消える」ことが構造的に起こり得ないので、既定は
     * false のままにしてある（`RunnerHostOptions.enforceLease` の doc）。
     */
    enforceLease: true,
  });

  const app = createRunnerApp({ host, outbox, tokenSha256 });
  const server = createAdaptorServer({ fetch: app.fetch });

  server.on('error', (error: unknown) => {
    // 直後に process.exit(1) が来るので `process.stderr.write` は使わない
    // （fd がパイプだと POSIX 上は非同期で、書いた行が exit に巻き込まれて
    // 失われることがある。#248）。`writeStderrSync` は fd 2 へ同期で書く。
    writeStderrSync(`alteroid-runner: 待ち受けに失敗しました: ${String(error)}\n`);
    process.exit(1);
  });

  const socketPath = envValue(process.env, 'ALTEROID_RUNNER_SOCKET');
  let listeningOn: string;

  if (socketPath !== undefined) {
    // 古いソケットが残っていると listen できない（器の作り直しで残る）
    rmSync(socketPath, { force: true });
    mkdirSync(dirname(socketPath), { recursive: true });
    await new Promise<void>((resolve) => server.listen({ path: socketPath }, resolve));
    // **デーモンだけが繋げる持ち主にする。** 子プロセス（別 UID）は繋げない。
    const ownerUid = Number(envValue(process.env, 'ALTEROID_RUNNER_SOCKET_UID') ?? '');
    if (Number.isInteger(ownerUid)) {
      const ownerGid = Number(envValue(process.env, 'ALTEROID_RUNNER_SOCKET_GID') ?? ownerUid);
      chownSync(socketPath, ownerUid, ownerGid);
    }
    chmodSync(socketPath, 0o600);
    listeningOn = `unix:${socketPath}`;
  } else {
    const port = Number(process.env.ALTEROID_RUNNER_PORT ?? '4518');
    const hostname = process.env.ALTEROID_RUNNER_BIND || '127.0.0.1';
    await new Promise<void>((resolve) => server.listen({ port, host: hostname }, resolve));
    listeningOn = `http://${hostname}:${port}`;
    // TCP は開発用の逃げ道である。マネージャーは同じ器の中に居るので、鍵が漏れれば
    // 制御面に手が届く。**本番はソケットにすること。**
    process.stdout.write(
      'alteroid-runner: TCP で待ち受けています。マネージャーと同じ器から届く口なので、' +
        '本番では ALTEROID_RUNNER_SOCKET を使ってください。\n',
    );
  }

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    server.close();
    if (socketPath !== undefined) rmSync(socketPath, { force: true });
    // 走行中のマネージャーは畳む。生ログはこの中でデーモンへ渡される
    // （渡さずに消えると、manager_id から生ログへ降りる経路が切れる）。
    const forced = setTimeout(() => process.exit(0), FORCED_EXIT_MS);
    forced.unref();
    await host.shutdown().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // 層とモデル帯の対応は設計判断であり、変更には人間の承認が要る（AGENTS.md 地雷5）。
  // **ここが正本なので、黙って通さない** — 上位帯から降りたことは人間が意図した
  // ときだけ起きるべきで、起動ログに出ていなければ誰も気づけない。デーモン側にも
  // 同じ行が出るが、あちらが読んでいるのは自己認識に載せる宣言であって、実際に
  // SDK セッションへ渡っているのはこのプロセスが解いた値である。
  for (const { key, value, fallback } of placedManagerModels(process.env)) {
    process.stdout.write(
      `alteroid-runner: ${key} が置かれています（既定 ${fallback} → ${value}）。` +
        `以後この runner が起こすセッションはこの帯で走ります。` +
        `既定へ戻すにはこの環境変数を外してください\n`,
    );
  }

  process.stdout.write(
    `alteroid-runner: ${listeningOn} （runner_id: ${runnerId} / 作業: ${workspacePath}` +
      `${childUser === undefined ? '' : ` / 子プロセス: uid ${childUser.uid}`}` +
      ` / 帯: ${resolveManagerModel(process.env)} → ${resolveWorkerModel(process.env)}）\n`,
  );
}

/** 直接起動されたときだけ main を走らせる。 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  // **未捕捉の例外・未処理の Promise 拒否に、観測だけの網を張る（#438）。**
  //
  // **ここに置くのは窓を最小にするためである。** module のトップレベルに置くと
  // `main` を import するテストにまで網が張られ、`main()` の中に置くと `main()` の
  // 頭までの窓が無駄に開く。**それでも import 中に投げた例外はこの網より前で、
  // そこは今日と同じ（Node 既定のスタック + exit 1）である** — 悪化はしないが
  // 覆ってもいない（`uncaught-net.ts`「覆っていない窓」）。
  //
  // **`uncaughtException` へ「上げない」こと。** 上げると既定の終了が止まり、
  // 器が「壊れた」と判定できる唯一の材料（プロセスの終了）が消える。理由の全文と
  // 実測の表は `uncaught-net.ts` に在る。
  installUncaughtNet('alteroid-runner');

  main().catch((error: unknown) => {
    // 同じ理由で `writeStderrSync` を使う（直上の `server.on('error')` と同型。#248）。
    writeStderrSync(`alteroid-runner: 起動に失敗しました: ${String(error)}\n`);
    process.exit(1);
  });
}
