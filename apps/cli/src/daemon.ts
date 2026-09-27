import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { stateDir } from './paths.js';

export interface DaemonRuntimeInfo {
  pid: number;
  port: number;
  startedAt: string;
  /** 起動ごとの本人確認用トークン。`/health` が返すものと一致して初めて本人。 */
  token: string;
}

/**
 * 本人確認の結果。2値（`boolean`）にすると「確かめられなかった」が黙って
 * 「居ない」側へ倒れる（`AGENTS.md`「静かに失敗する道具」の「判定できないと
 * いう3つ目の状態を持つ」）。ここは明示的に3値目を持つ。
 *
 * - `present` — 本人だと確認できた
 * - `absent` — 居ないと確認できた。応答があった上での否定（401/403/404 等・
 *   `operator` が `true` ではない）に加え、**接続拒否（`ECONNREFUSED`）も
 *   含む**——OS が「そのポートに listen しているプロセスが無い」と積極的に
 *   返してきた場合は、応答が無いのではなく「居ない」と確定できる
 *   （`isConnectionRefused`。#1765 の回帰修正）
 * - `unknown` — 確かめられなかった（タイムアウト・接続拒否以外の例外・
 *   不正な応答）。**「居ない」ではない。** 居るかもしれないが、確認する
 *   手段が今回は無かった、という意味
 */
export type Presence = 'present' | 'absent' | 'unknown';

export interface DaemonStatus {
  presence: Presence;
  info: DaemonRuntimeInfo | null;
}

export type StopOutcome =
  | 'stopped'
  | 'not-running'
  /** 居ないと確定できた（応答があった上での否定、または接続拒否）。PID は
   * 信用できないので触らず、状態ファイルだけ片付ける。 */
  | 'stale'
  /** 応答はあるが止まらない。 */
  | 'unresponsive'
  /** 確かめられなかった（タイムアウト等）。PID にも状態ファイルにも触って
   * いない——「居ない」と決め付けて片付けると、直後の `ensureRunning()` が
   * `absent`（＝居ないと確定済み）と読んでしまい、`start()` の安全弁
   * （`unknown` のときは spawn しない）を素通りする（Issue #1818）。 */
  | 'unknown';

function runtimeFile(): string {
  return join(stateDir(), 'daemon.json');
}

export function baseUrl(info: Pick<DaemonRuntimeInfo, 'port'>): string {
  return `http://127.0.0.1:${info.port}`;
}

async function readRuntimeInfo(): Promise<DaemonRuntimeInfo | null> {
  try {
    const raw = await readFile(runtimeFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DaemonRuntimeInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null;
    // token の無い状態ファイルは本人確認できない = stale 扱い
    if (typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
    return parsed as DaemonRuntimeInfo;
  } catch {
    return null;
  }
}

/**
 * **接続拒否（誰も listen していないと確定できる）かどうか。**
 *
 * Node の `fetch`（undici）は接続に失敗すると `TypeError: fetch failed` を
 * 投げ、実際の理由は `error.cause` に載る（実測: Node 22.23.3 / undici 内蔵版。
 * `http://127.0.0.1:<閉じたポート>/` へ `fetch` した実物で確認した——
 * `err.cause.code === 'ECONNREFUSED'`、`err.cause.syscall === 'connect'`）。
 * **タイムアウト**（`AbortSignal.timeout` が発火したとき）は形が違う——
 * `err.name === 'TimeoutError'` で `err.cause` は無い（同じく実測）。
 *
 * `ECONNREFUSED` は OS の TCP スタックが「そのポートに listen している
 * プロセスが無い」と積極的に返してきた場合だけに立つ——応答が無い
 * （タイムアウト）・経路が無い（`ECONNRESET`・`EHOSTUNREACH` 等）・
 * 相手はいるが求めた形で応答しない（JSON 不正等）とは区別できる。
 * **だからこれだけを `'absent'`（居ないと確定）に倒し、それ以外の失敗は
 * 全部 `'unknown'` のままにする**（#1765 の回帰修正 — 元は全例外を
 * `'unknown'` にしていたため、デーモンが異常終了して古い状態ファイルが
 * 残った場合に `start()` が永久に spawn できなくなっていた）。
 */
function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause: unknown = (error as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return false;
  return (cause as NodeJS.ErrnoException).code === 'ECONNREFUSED';
}

/**
 * 本人確認。ポートが空いていることではなく、**そこにいるのが自分の記録した
 * デーモンであること**を確かめる。PID は使わない — 異常終了で状態ファイルが
 * 残ったあと、OS が同じ PID を別プロセスに配ることがあるため。
 *
 * **タイムアウト・接続拒否以外の例外は `absent` ではなく `unknown` を返す。**
 * 応答が遅い・一時的にネットワークが不調・JSON が壊れている、といった
 * 「確かめられなかった」場合を「居ない」に畳むと、本当は生きているデーモンに
 * 対して呼び出し側が「居ない」と誤解し、安全のはずの分岐を誤った前提の上で
 * 実行してしまう（#1765）。
 *
 * **ただし接続拒否（{@link isConnectionRefused}）だけは `absent` にする。**
 * デーモンが異常終了して状態ファイルだけが残った場合、そのポートには誰も
 * listen していない——これは「確かめられなかった」ではなく「居ないと確定
 * できた」である。ここを `unknown` のままにすると、`start()` が安全側の
 * つもりで spawn を拒み続け、状態ファイルを手で消すまで `alteroid` の
 * どのコマンドもデーモンを起こせなくなる（#1765 の回帰。`chat` のたびに
 * `ensureRunning()` を通るので、クラッシュのたびに CLI が使えなくなる形で
 * 表に出る）。
 */
async function verify(info: DaemonRuntimeInfo): Promise<Presence> {
  try {
    // **トークンを送って、認められるかを見る。** かつては `/health` が返す token と
    // 突き合わせていたが、この値は「許可を付与できる資格」そのものになったので、
    // 無認証で読める応答には載せられない。提示して `operator` が返ることは、
    // 突き合わせと同じ強さで本人確認になる（かつ秘密を配らない）。
    const response = await fetch(`${baseUrl(info)}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1500),
    });
    // 応答があった上での否定（401/403/404 等）は「本人ではない」と確定できる。
    if (!response.ok) return 'absent';
    const body = (await response.json()) as { operator?: unknown };
    return body.operator === true ? 'present' : 'absent';
  } catch (error) {
    // 接続拒否（誰も listen していないと確定できる）だけは `absent`。
    // タイムアウト・`ECONNRESET`・DNS 失敗・不正な応答の JSON パース失敗
    // など、それ以外はすべて「確かめられなかった」として `unknown` に残す。
    if (isConnectionRefused(error)) return 'absent';
    return 'unknown';
  }
}

/**
 * 記憶がどこにあるかをデーモンに聞く（ローカルのパス / PostgreSQL）。
 * 応答に無い（古いデーモン）なら null。接続情報そのものは返らない。
 */
export async function storageOf(info: DaemonRuntimeInfo | null): Promise<string | null> {
  if (!info) return null;
  try {
    const response = await fetch(`${baseUrl(info)}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { storage?: unknown };
    return typeof body.storage === 'string' && body.storage.length > 0 ? body.storage : null;
  } catch {
    return null;
  }
}

export async function status(): Promise<DaemonStatus> {
  const info = await readRuntimeInfo();
  if (!info) return { presence: 'absent', info: null };
  return { presence: await verify(info), info };
}

function daemonEntrypoint(): string {
  // @alteroid/daemon の実体を解決する（CLI は core を持たないので子プロセスで起こす）
  return fileURLToPath(import.meta.resolve('@alteroid/daemon'));
}

/** 常駐は自律の前提（PRD）。chat のたびに起こすのではなく、居なければ起こす。 */
export async function start(): Promise<DaemonRuntimeInfo> {
  const current = await status();
  if (current.presence === 'present' && current.info) return current.info;
  if (current.presence === 'unknown') {
    // **安全側 — 確かめられないまま2本目を起こさない。** 記録された状態ファイルは
    // 片付けない: 応答が無かっただけで、既に生きている本物のデーモンかも
    // しれない。ここで新しいプロセスを spawn すると、ポート衝突や記憶ストア
    // への二重書き込みの疑いに繋がる（#1765 段2）。
    throw new Error(
      '既存の alteroidd の生死を確かめられませんでした（応答が無いかタイムアウトしました）。' +
        '二重起動を避けるため起動を中止しました。ネットワークや負荷を確認してから、' +
        '必要なら `alteroid daemon status` で状態を見てからやり直してください。',
    );
  }

  // 子プロセスの出力を捨てない。捨てると「起動しない理由」が永久に分からなくなる。
  await mkdir(stateDir(), { recursive: true });
  const logPath = join(stateDir(), 'daemon.log');
  const log = openSync(logPath, 'a');

  const child = spawn(process.execPath, [daemonEntrypoint()], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(250);
    const next = await status();
    if (next.presence === 'present' && next.info) return next.info;
  }
  throw new Error(`デーモンの起動を確認できませんでした（ログ: ${logPath}）`);
}

/** `stopDaemon` が触る外界。テストで差し替えるためだけに切り出してある。 */
export interface StopDeps {
  readInfo(): Promise<DaemonRuntimeInfo | null>;
  /**
   * 3値（{@link Presence}）で返す。**`boolean` に畳まない** — 畳むと
   * 「確かめられなかった」が「居ない」側へ倒れ、`stopDaemon` が状態ファイルを
   * 消してしまう（Issue #1818。旧 `StopDeps.verify: boolean` 契約の穴）。
   */
  verify(info: DaemonRuntimeInfo): Promise<Presence>;
  requestShutdown(info: DaemonRuntimeInfo): Promise<void>;
  /** SIGTERM。**本人確認できたときだけ**呼んでよい。 */
  terminate(pid: number): void;
  clearInfo(): Promise<void>;
  wait(ms: number): Promise<void>;
}

/**
 * デーモンを止める。
 *
 * **本人確認できない限り、記録された PID へシグナルを送らない。** 状態ファイルの
 * PID は、デーモンが SIGKILL やクラッシュや OS 再起動で正常終了できなかった場合に
 * 残る。その PID を OS が別プロセスへ再利用していたら、シグナルはそのプロセスを
 * 殺してしまう。本人だと確かめられないときは、状態ファイルを片付けて手を引く。
 *
 * **「確かめられなかった」（`unknown`）と「居ないと確定できた」（`absent`）は
 * 別に扱う（Issue #1818）。** 以前は `StopDeps.verify` が `boolean` で、
 * `unknown` を `false` へ畳んでいた——`false` の側は「記録は残っているが本人
 * ではない」という**確定した否定**の意味で `clearInfo()`（状態ファイルの
 * 削除）まで行っていたため、`unknown` もここを通って状態ファイルが消えて
 * いた。直後に `ensureRunning()` が走ると、状態ファイルが無いので
 * `status()` は `absent` を返す——`unknown` ではない。`start()` の安全弁は
 * `presence === 'unknown'` のときしか働かないので、この `absent` は弁を
 * 素通りして2本目の spawn まで進んでしまう。**「確かめられなかった」を
 * 状態ファイルの削除で「居ないと確定した」にすり替えないこと** — `unknown`
 * のときは PID にも状態ファイルにも触らず、`'unknown'` をそのまま返す。
 */
export async function stopDaemon(deps: StopDeps): Promise<StopOutcome> {
  const info = await deps.readInfo();
  if (!info) return 'not-running';

  const presence = await deps.verify(info);
  if (presence === 'unknown') {
    // 確かめられなかった。生きているかもしれない本物のデーモンを見捨てない
    // ——PID にも状態ファイルにも触らない（Issue #1818）。
    return 'unknown';
  }
  if (presence === 'absent') {
    // 記録は残っているが本人ではない（または既に居ない）。PID には触らない。
    await deps.clearInfo();
    return 'stale';
  }

  // ここから先は本人だと確認できている（presence === 'present'）。
  try {
    await deps.requestShutdown(info);
  } catch {
    deps.terminate(info.pid);
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await deps.wait(250);
    // ここは `absent`（居ないと確定）のときだけ止まったと判定する。
    // `unknown` はループを継続する——`present` だったときと同様、
    // 「まだ止まったと確認できていない」以上のことは言えない（Issue #1818 と
    // 同じ理由: 確かめられないことを片方の確定へ倒さない）。
    if ((await deps.verify(info)) === 'absent') {
      await deps.clearInfo();
      return 'stopped';
    }
    // 折り返し地点で応答があるならシグナルで押す（本人確認済みなので安全）
    if (attempt === 20) deps.terminate(info.pid);
  }
  return 'unresponsive';
}

export async function stop(): Promise<StopOutcome> {
  return stopDaemon({
    readInfo: readRuntimeInfo,
    // `StopDeps.verify` は3値（`Presence`）の契約——このファイルの `verify`
    // がそのまま渡せる（Issue #1818。以前はここで `boolean` へ畳んでいた）。
    verify,
    async requestShutdown(info) {
      const response = await fetch(`${baseUrl(info)}/shutdown`, {
        method: 'POST',
        // デーモンは本文の無い POST に application/json を要求する（ブラウザの
        // 単純リクエストで他人が止められないようにするため）。認証が有効なら
        // 実行環境の持ち主として名乗る必要もある。
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${info.token}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`shutdown が失敗した (${response.status})`);
    },
    terminate(pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // 既に居ない
      }
    },
    async clearInfo() {
      await rm(runtimeFile(), { force: true });
    },
    wait: sleep,
  });
}

/** 起動していなければ起こしてから接続先を返す。 */
export async function ensureRunning(): Promise<DaemonRuntimeInfo> {
  const current = await status();
  if (current.presence === 'present' && current.info) return current.info;
  // `unknown` のときも `start()` へ渡す — 安全側の判断（起こすかどうか）は
  // `start()` に一本化してある。ここで別の分岐を持つと、2箇所が同じ判断を
  // 別々に持つことになり、片方だけ直して他方が古いままになりうる。
  // **`startWithRecovery()` はここからは絶対に呼ばない。** 回復（状態
  // ファイルの退避 → 起動し直し）は、人間が明示のフラグを付けたときだけ
  // 起きる操作であって、`chat` などが毎回通るこの経路の既定にしてはいけない
  // （Issue #1851）。
  return start();
}

/**
 * 指定したパスが存在するかどうか（`stat` が成功するか）。**内容は見ない** —
 * 退避先の名前が既に使われているかどうかだけを知りたい（`quarantineRuntimeFile`
 * が使う）。
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 状態ファイル（`runtimeFile()`）を **消すのではなく名前を変えて退避する。**
 * `daemon.json` → `daemon.json.stale-<UTC の時刻>`（コロン・ドットはファイル名に
 * 使えない環境があるので `-` に置き換える）。**退避先が既に在れば、上書きせず
 * 別の名前にする**（同じ秒に2回 `--force` を打った場合など）。
 *
 * 呼び出し前提: `runtimeFile()` が実際に存在すること（`presence === 'unknown'`
 * は `readRuntimeInfo()` が成功した場合にしか立たないので、`startWithRecovery`
 * から呼ぶ限りこの前提は常に満たされる）。
 */
async function quarantineRuntimeFile(): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${runtimeFile()}.stale-${stamp}`;
  let target = base;
  let attempt = 0;
  while (await pathExists(target)) {
    attempt += 1;
    target = `${base}-${attempt}`;
  }
  await rename(runtimeFile(), target);
  return target;
}

/**
 * 退避した記録の PID が生きているかを**表示だけする**（止めはしない。
 * Issue #1851）。`process.kill(pid, 0)` はシグナルを送らず存在確認だけする
 * 慣用の形——例外を投げなければ生きている。`ESRCH` は「その PID のプロセスは
 * 居ない」、`EPERM` は「居るが権限が無くてシグナルを送れない」（＝存在はする）
 * ので生きている側に数える。それ以外の失敗は判定できないので `null`。
 */
function pidAppearsAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

/**
 * `alteroid daemon start --force` の中身（Issue #1851。#1823 の帰結）。
 *
 * PR #1779 / #1823 で `start()` は `presence === 'unknown'`（本人確認が
 * ずっと確かめられない）のとき、安全側に倒れて spawn せず例外を投げる。
 * これは正しい既定だが、`verify()` がずっと `unknown` を返す状況
 * （無関係な別プロセスが同じポートを掴んでいる・ファイアウォールで応答が
 * 黙って落ちる、など）では、`stop()` も `start()` も状態ファイルに触れず
 * CLI からは回復できない——手で `runtimeFile()` を消すしかなかった。
 *
 * ここは**その手動の回避策を、明示のフラグの下でだけ再現する**。
 * 既定の安全弁（`start()` / `ensureRunning()`）は1文字も変えていない——
 * この関数は `start()` を**呼ぶ側**であって、`start()` 自体の分岐には
 * 触れていない。
 *
 * 分岐（`presence` ごと）:
 * - `present`（本人確認できた）: 退避しない。**二重に起こさない** —
 *   `--force` を付けていても、本物が既に動いているなら何もせず返す。
 * - `absent`（居ないと確定——接続拒否 or 応答があった上での否定）:
 *   退避は要らない。今までどおりの経路（`start()`）で片付ける。
 * - `unknown`（確かめられなかった）: ここが本題。状態ファイルを退避 →
 *   退避した記録の PID が生きているかを表示だけ → `start()` を呼んで
 *   起こし直す（退避済みなので `start()` からは `absent` に見え、通常の
 *   spawn 経路を通る）。
 */
export type StartWithRecoveryOutcome =
  | { kind: 'already-present'; info: DaemonRuntimeInfo }
  | { kind: 'started'; info: DaemonRuntimeInfo }
  | {
      kind: 'recovered';
      info: DaemonRuntimeInfo;
      quarantinedTo: string;
      previousPid: number;
      previousPidAlive: boolean | null;
    };

export async function startWithRecovery(): Promise<StartWithRecoveryOutcome> {
  const current = await status();
  if (current.presence === 'present' && current.info) {
    return { kind: 'already-present', info: current.info };
  }
  if (current.presence === 'absent') {
    return { kind: 'started', info: await start() };
  }
  // presence === 'unknown'。`status()` は `readRuntimeInfo()` が読めたときだけ
  // `verify()` を呼ぶので、ここでは常に `info` が存在する（型のためだけの防御）。
  if (!current.info) {
    throw new Error('内部エラー: unknown と判定されたのに状態ファイルを読めていません');
  }
  const previousPid = current.info.pid;
  const previousPidAlive = pidAppearsAlive(previousPid);
  const quarantinedTo = await quarantineRuntimeFile();
  const info = await start();
  return { kind: 'recovered', info, quarantinedTo, previousPid, previousPidAlive };
}
