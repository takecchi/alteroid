import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chown, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 実行環境プロファイル — 人間の `.zprofile` / `.zshenv` に当たるものを、
 * **記憶ストアに1本置いて全層へ効かせる**器。
 *
 * **なぜ要るのか。** 道具の鍵や環境変数を「器の環境変数」として増やしていくと、
 * 1つ足すたびに `credentials.ts` の一覧・`compose.yaml`・Railway の Variables・
 * Dockerfile のシムを直すことになる。**用途が増えるたびにコードを改修する**という
 * ことは、人間が Claude Code に対して `~/.zshenv` を1行足せば済ませていることが、
 * この階層では実装作業になっている、ということである。それはデグレードであって
 * 設計ではない（north_star 禁止1）。
 *
 * だからここでは、**環境変数の一覧を持たない**。人間が置くのはシェルスクリプト
 * 1本で、中身に何を書くかを器は知らない（`export` でも `eval $(...)` でも
 * `PATH` の追加でもよい）。増えるのは人間が書く行であって、実装ではない。
 *
 * **`credentials.ts` を置き換えるものではない。** あちらは「1つの鍵を、走行中に、
 * 名前を検査したうえで回す」ための細い口で、こちらは「実行環境そのものを丸ごと
 * 差し替える」ための太い口である。効く順序は **credentials → profile** で、
 * プロファイルが後から上書きする（人間が明示的に書いたほうが勝つ）。
 *
 * ## 効き方は3つ。どれも「走行中に届く」ことを壊さない
 *
 * 1. **`BASH_ENV`**（＝`.zshenv` そのもの）。マネージャーが叩くコマンドは
 *    Bash 経由なので、**1コマンドごとにこのファイルが読み直される**。人間が
 *    プロファイルを直せば、走行中のマネージャーにも次のコマンドから届く
 * 2. **SDK 子プロセスの起動時に1度評価して env へ畳む**。MCP サーバは Bash を
 *    経由せず CLI から直に起こされるので、これが無いと MCP の鍵だけが届かない
 *    （＝「MCP の鍵は結局 compose に書く」に逆戻りする）
 * 3. **`gh` のシム**（Dockerfile）が読む。`gh` が Bash を経由せず呼ばれても効く
 *
 * ## 器が足しているもの（人間の本文には無い2行）
 *
 * - **再入の番人**。`BASH_ENV` は入れ子の bash にも継承されるので、プロファイルが
 *   スクリプトを呼び、そのスクリプトが bash なら、また読み直される。本文が
 *   コマンドを1つでも走らせていたら無限再帰になる。だから読み込み済みの印を
 *   立てて、内側では読まない
 * - **伏せる鍵の `unset`**。本文が何を `export` しようと、**上（記憶）へ到達する鍵**
 *   だけは最後に落とす。配る仕組み（プロファイル）が伏せる仕組みを黙って越えない
 *   ようにするためで、`docker/alteroid-runner` が `exec` の前にやっているのと
 *   同じ形である。評価経路（2番）でも Node 側でもう一度落とす（二重の底）
 */

/** 読み込み済みの印。**子へ配る env には残さない**（残すと差し替えが届かなくなる）。 */
export const PROFILE_SOURCED_ENV_KEY = 'ALTEROID_PROFILE_SOURCED';

/** プロファイルの所在を子へ知らせる環境変数。 */
export const PROFILE_FILE_ENV_KEY = 'ALTEROID_PROFILE_FILE';

/** runner の器での既定の置き場。`Dockerfile` が用意するディレクトリと揃える。 */
export const DEFAULT_PROFILE_PATH = '/run/alteroid/profile/profile.sh';

/**
 * 評価の待ち上限。
 *
 * **これは能力の制限ではない**（north_star 禁止2 が禁じているのは、暴走を止める
 * ための実行回数・ターン数の上限である）。ここで止めているのは人間が書いた
 * プロファイルが返ってこない場合で、待ち続ければ**マネージャーが1本も起きなく
 * なる**。落ちたことは理由つきで表へ出す。
 */
export const PROFILE_EVAL_TIMEOUT_MS = 10_000;

/**
 * 評価結果から捨てる名前。
 *
 * シェルが必ず書き換えるもの（`_` `PWD` `SHLVL`）を差分として拾うと、
 * 「プロファイルが環境を変えた」という報告が毎回嘘になる。
 */
const EPHEMERAL_ENV_KEYS = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL', PROFILE_SOURCED_ENV_KEY]);

/**
 * 保存・配布・指紋が**同じ1つの文字列**を見るように整える。
 *
 * **これが無いと指紋が一致しない。** 置き場（ファイル）は末尾の改行を足したくなる
 * 一方、指紋は受け取った本文から取るので、`PUT` が返した sha256 と `GET` が返す
 * sha256 が食い違う。食い違えば `alteroid profile status` は「届いていない」と
 * 言い続け、**人間が原因を切り分けるための道具そのものが嘘をつく**（鍵の指紋で
 * 同じ失敗をしている）。だから入口で1度だけ形を決める。
 */
export function normalizeProfileScript(script: string): string {
  if (script.trim().length === 0) return '';
  return script.endsWith('\n') ? script : `${script}\n`;
}

/** 値そのものを出さずに同一性だけ見せる（`credentials.ts` と同じ形）。 */
export function fingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/** 置いてあるプロファイルの同一性。**本文は出さない。** */
export interface ProfileFingerprint {
  /** 人間が書いた本文の sha256（16進）先頭12桁。器が足した行は含めない。 */
  sha256: string;
  bytes: number;
  updatedAt: string;
}

export interface ProfileVesselOptions {
  /** 置き場（ファイルそのもの）。 */
  path: string;
  /**
   * 読める主体。SDK 子プロセスを別 UID へ降ろしているなら、その UID を渡す。
   * 渡さなければ chown しない（同じ UID で走るローカル構成）。
   */
  reader?: { uid: number; gid: number };
  /**
   * 本文が何を書こうと最後に落とす名前（上＝記憶へ到達する鍵）。
   *
   * **静的に検査しない。** シェルスクリプトが何を `export` するかは読んでも
   * 分からない（`eval` がある）。だから「書かせない」ではなく「最後に落とす」で
   * 守る。検査で弾く形にすると、通り抜けた1つが穴になる。
   */
  withheldEnvKeys?: readonly string[];
  /** 現在時刻。テストで固定するため。 */
  now?: () => Date;
}

export interface ProfileVessel {
  readonly path: string;
  /** いま置いてある本文（人間が直すために要る）。無ければ undefined。 */
  script(): string | undefined;
  /** 置いてあるものの同一性。無ければ undefined。 */
  fingerprint(): ProfileFingerprint | undefined;
  /**
   * 子へ知らせる所在。**プロファイルが無ければ何も渡さない** —
   * 空の `BASH_ENV` を配ると、シェルが毎回無いファイルを探すだけになる。
   */
  env(): Record<string, string>;
  /** 差し替える。空文字は「プロファイルを外す」。 */
  set(script: string): Promise<ProfileFingerprint | undefined>;
  /**
   * 置く前に仮置きする。**壊れたプロファイルを本番の置き場に置かないため。**
   *
   * プロファイルは人間が書いたシェルスクリプトで、構文を間違えれば読めない。
   * そのまま `BASH_ENV` に載せると、以後すべてのコマンドが毎回エラーを吐く環境で
   * 走り、しかも原因はどこにも出ない。だから**評価してから置く**。
   */
  stage(script: string): Promise<StagedProfile>;
  /** 直近の書き込みに失敗していれば理由。器が無い構成を黙って隠さないための窓。 */
  readonly lastWriteError: string | undefined;
}

/** 仮置きされたプロファイル。評価してから `commit` する。 */
export interface StagedProfile {
  /** 評価に使う仮の置き場。**まだ誰にも配られていない。** */
  path: string;
  /** 本番の置き場へ移す。 */
  commit(): Promise<ProfileFingerprint | undefined>;
  /** 捨てる。本番の置き場は**触らない**（前のものが残る）。 */
  discard(): Promise<void>;
}

export function createProfileVessel(options: ProfileVesselOptions): ProfileVessel {
  return new Vessel(options);
}

/**
 * 器へ書く実体を組み立てる。
 *
 * 人間の本文の**前後**に器の行を足す。前に番人、後ろに `unset`。本文を挟む形に
 * するのは、本文が途中で `return` してもよい（＝プロファイルとして普通の書き方）
 * ようにするためではなく、**本文が何をしても最後の `unset` に到達させる**ためで
 * ある。`return` で抜けられると伏せる鍵が残るので、`unset` は番人の外に置く。
 */
export function renderProfileFile(script: string, withheldEnvKeys: readonly string[]): string {
  const lines = [
    '# このファイルは alteroid が書いている。直接編集しても次の差し替えで消える。',
    `# 本文の差し替えは \`alteroid profile set\` / \`PUT /profile\`。`,
    '',
    `if [ -z "\${${PROFILE_SOURCED_ENV_KEY}:-}" ]; then`,
    // 入れ子の bash が同じファイルをもう一度読まないようにする印。本文が
    // コマンドを走らせていると、これが無い場合に無限再帰する。
    `  ${PROFILE_SOURCED_ENV_KEY}=1; export ${PROFILE_SOURCED_ENV_KEY}`,
    '',
    '# ここから人間が書いた本文 -------------------------------------------------',
    script.replace(/\s+$/, ''),
    '# ここまで人間が書いた本文 -------------------------------------------------',
    '',
    'fi',
  ];

  if (withheldEnvKeys.length > 0) {
    lines.push(
      '',
      '# 上（記憶）へ到達する鍵は、本文が何をしても最後に落とす。番人の外に置いて',
      '# あるのは、本文が `return` で抜けてもここへ到達させるためである。',
      `unset ${withheldEnvKeys.join(' ')}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

class Vessel implements ProfileVessel {
  readonly path: string;
  readonly #reader: { uid: number; gid: number } | undefined;
  readonly #withheld: readonly string[];
  readonly #now: () => Date;
  #held: { script: string; updatedAt: string } | undefined;
  #lastWriteError: string | undefined;

  constructor(options: ProfileVesselOptions) {
    this.path = options.path;
    this.#reader = options.reader;
    this.#withheld = options.withheldEnvKeys ?? [];
    this.#now = options.now ?? (() => new Date());
  }

  script(): string | undefined {
    return this.#held?.script;
  }

  fingerprint(): ProfileFingerprint | undefined {
    if (this.#held === undefined) return undefined;
    return {
      sha256: fingerprintOf(this.#held.script),
      bytes: Buffer.byteLength(this.#held.script),
      updatedAt: this.#held.updatedAt,
    };
  }

  env(): Record<string, string> {
    if (this.#held === undefined) return {};
    return {
      [PROFILE_FILE_ENV_KEY]: this.path,
      // `.zshenv` と同じ効き方。**1コマンドごとに読み直される**ので、走行中の
      // マネージャーにもプロファイルの差し替えが次のコマンドから届く。
      BASH_ENV: this.path,
      // bash 以外（dash / ash）のための同じ意味の変数。害は無い。
      ENV: this.path,
    };
  }

  async set(script: string): Promise<ProfileFingerprint | undefined> {
    const staged = await this.stage(script);
    return staged.commit();
  }

  async stage(script: string): Promise<StagedProfile> {
    const at = this.#now().toISOString();
    const next = script.trim().length === 0 ? undefined : { script, updatedAt: at };

    if (next === undefined) {
      // 外すだけなら仮置きするものが無い。`commit` で消す。
      return {
        path: this.path,
        commit: async () => {
          await this.#erase();
          return undefined;
        },
        discard: async () => undefined,
      };
    }

    await mkdir(dirname(this.path), { recursive: true, mode: 0o711 });
    const staging = `${this.path}.${randomUUID().slice(0, 8)}`;
    try {
      // 0400 で作ってから rename する。作ってから絞ると、その隙間で他人が読める。
      await writeFile(staging, renderProfileFile(next.script, this.#withheld), { mode: 0o400 });
      if (this.#reader !== undefined) await chown(staging, this.#reader.uid, this.#reader.gid);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      this.#lastWriteError = String(error);
      throw new Error(`プロファイルを器へ置けなかった: ${String(error)}`, { cause: error });
    }

    return {
      path: staging,
      commit: async () => {
        try {
          await rename(staging, this.path);
          this.#lastWriteError = undefined;
        } catch (error) {
          await rm(staging, { force: true }).catch(() => undefined);
          this.#lastWriteError = String(error);
          throw new Error(`プロファイルを器へ置けなかった: ${String(error)}`, { cause: error });
        }
        // **器へ入ってから** memory を進める（置けなかったものを「配っている」と言わない）。
        this.#held = next;
        return this.fingerprint();
      },
      discard: async () => {
        await rm(staging, { force: true }).catch(() => undefined);
      },
    };
  }

  async #erase(): Promise<void> {
    try {
      await rm(this.path, { force: true });
      this.#held = undefined;
      this.#lastWriteError = undefined;
    } catch (error) {
      this.#lastWriteError = String(error);
      throw new Error(`プロファイルを外せなかった: ${String(error)}`, { cause: error });
    }
  }

  get lastWriteError(): string | undefined {
    return this.#lastWriteError;
  }
}

// ---------------------------------------------------------------------------
// 評価（SDK 子プロセスの env へ畳む）
// ---------------------------------------------------------------------------

/** 子プロセスの起こし方。runner は別 UID へ降ろすので差し替えられるようにしてある。 */
export type ProfileSpawn = (options: {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}) => ChildProcess;

export interface ProfileEvaluation {
  /** 元の env から**変わった分だけ**。そのまま重ねれば効く。 */
  env: Record<string, string>;
  /** プロファイルが出した出力（人間が原因を見るための窓）。 */
  output: string;
  /** 失敗していれば理由。**成功と区別できる形で返す**（黙って空を返さない）。 */
  error?: string;
}

export interface EvaluateProfileOptions {
  path: string;
  /** 重ねる前の env。差分はこれと比べて取る。 */
  baseEnv: NodeJS.ProcessEnv;
  withheldEnvKeys?: readonly string[];
  spawnFn?: ProfileSpawn;
  timeoutMs?: number;
  /** 評価に使うシェル。既定は `/bin/sh`。 */
  shell?: string;
  /** env を JSON で吐かせる node。既定は自分自身。 */
  nodePath?: string;
}

/**
 * プロファイルを1度だけ評価して、env の差分を取る。
 *
 * **なぜ Node で読み直すのか。** `BASH_ENV` は Bash を経由するものにしか効かない。
 * MCP サーバは CLI が直に起こすので、これが無いと「MCP の鍵だけはプロファイルに
 * 書いても効かない」という穴が残り、結局 compose へ書き戻すことになる。
 *
 * 本文の標準出力は**捨てずに stderr 側へ寄せる**。捨てると人間が原因を見る窓が
 * 無くなり、混ぜると env の JSON が壊れる。
 */
export async function evaluateProfile(options: EvaluateProfileOptions): Promise<ProfileEvaluation> {
  const {
    path,
    baseEnv,
    withheldEnvKeys = [],
    spawnFn,
    timeoutMs = PROFILE_EVAL_TIMEOUT_MS,
    shell = '/bin/sh',
    nodePath = process.execPath,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  // `$0` に本文、`$1` に node。`. "$0" >&2` で本文の標準出力を stderr へ寄せる。
  const program =
    '. "$0" >&2 || exit 97; exec "$1" -e \'process.stdout.write(JSON.stringify(process.env))\'';

  // 番人の印は渡さない（渡すと本文が読まれずに素通りする）。
  const env: Record<string, string | undefined> = { ...baseEnv };
  delete env[PROFILE_SOURCED_ENV_KEY];

  const spawnChild: ProfileSpawn =
    spawnFn ??
    ((spawnOptions) =>
      nodeSpawn(spawnOptions.command, spawnOptions.args, {
        env: spawnOptions.env,
        signal: spawnOptions.signal,
        stdio: ['ignore', 'pipe', 'pipe'],
      }));

  let stdout = '';
  let output = '';

  try {
    const child = spawnChild({
      command: shell,
      args: ['-c', program, path, nodePath],
      env,
      signal: controller.signal,
    });
    child.stdin?.end();
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      output += chunk;
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode));
    });

    if (code !== 0) {
      return {
        env: {},
        output: tail(output),
        error:
          code === 97
            ? `プロファイルの読み込みが失敗した（${shell} が非 0 で終了）`
            : `プロファイルの評価が失敗した（終了コード ${String(code)}）`,
      };
    }
  } catch (error) {
    const reason = controller.signal.aborted
      ? `プロファイルの評価が ${String(timeoutMs)}ms 以内に終わらなかった（返ってこないコマンドを書いていないか）`
      : String(error);
    return { env: {}, output: tail(output), error: reason };
  } finally {
    clearTimeout(timer);
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(stdout) as Record<string, string>;
  } catch (error) {
    return { env: {}, output: tail(output), error: `評価結果を読めなかった: ${String(error)}` };
  }

  const diff: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (EPHEMERAL_ENV_KEYS.has(key)) continue;
    if (baseEnv[key] === value) continue;
    diff[key] = value;
  }
  // **伏せるのは最後。** 本文が何を `export` しても、上（記憶）へ到達する鍵は
  // 配らない。器が書いた `unset` と二重にしてあるのは、片方を通り忘れても
  // 穴にしないためである。
  for (const key of withheldEnvKeys) delete diff[key];

  return { env: diff, output: tail(output) };
}

/** 人間が読む窓であって記録ではない。長い出力で日誌を溢れさせない。 */
function tail(text: string, limit = 4_000): string {
  return text.length <= limit ? text : `…（前略）\n${text.slice(-limit)}`;
}

// ---------------------------------------------------------------------------
// 置く・評価する・配る をひとまとめにする
// ---------------------------------------------------------------------------

export interface ProfileApplyResult {
  profile?: ProfileFingerprint;
  /** 置いたものが実際に読めたか。**読めなければ置いていない。** */
  ok: boolean;
  error?: string;
  output?: string;
  /** 評価の結果、増減した環境変数の名前。**値は含めない。** */
  names?: string[];
}

/**
 * 器と評価をひとまとめにしたもの。
 *
 * **クローン（デーモン）とマネージャー（runner）で同じものを使う。** 層ごとに
 * 別実装にすると、必ず片方だけに直しが入って挙動がずれる（「クローンでは効く
 * のにマネージャーでは効かない」は、人間から見れば理由の無いデグレードである）。
 */
export interface ProfileApplier {
  readonly vessel: ProfileVessel;
  fingerprint(): ProfileFingerprint | undefined;
  /**
   * 子へ重ねる env。
   *
   * 評価済みの差分（Bash を経由しない子＝MCP サーバへ効かせる）と、所在
   * （`BASH_ENV`。走行中のコマンドへ毎回届かせる）の両方。**片方では足りない。**
   */
  env(): Record<string, string>;
  /** 置く前に評価し、壊れていれば置かない（前のものが残る）。 */
  apply(script: string): Promise<ProfileApplyResult>;
}

export interface ProfileApplierOptions {
  vessel: ProfileVessel;
  /** 評価するときの土台。**実際に配るものと同じ env を渡すこと。** */
  baseEnv: () => NodeJS.ProcessEnv;
  withheldEnvKeys?: readonly string[];
  /** 別 UID で読ませるなら渡す。**読む主体を配る先と揃える。** */
  spawnFn?: ProfileSpawn;
}

export function createProfileApplier(options: ProfileApplierOptions): ProfileApplier {
  const { vessel, baseEnv, withheldEnvKeys = [], spawnFn } = options;
  let applied: Record<string, string> = {};

  return {
    vessel,
    fingerprint: () => vessel.fingerprint(),
    env: () => ({ ...applied, ...vessel.env() }),
    async apply(script: string): Promise<ProfileApplyResult> {
      const staged = await vessel.stage(script);

      if (script.trim().length === 0) {
        await staged.commit();
        applied = {};
        return { ok: true };
      }

      const evaluation = await evaluateProfile({
        path: staged.path,
        baseEnv: baseEnv(),
        withheldEnvKeys,
        ...(spawnFn === undefined ? {} : { spawnFn }),
      });

      if (evaluation.error !== undefined) {
        // **壊れているものは置かない。** `BASH_ENV` に載せてしまうと、以後
        // すべてのコマンドが毎回エラーを吐く環境で走り、原因はどこにも出ない。
        await staged.discard();
        return { ok: false, error: evaluation.error, output: evaluation.output };
      }

      const fingerprint = await staged.commit();
      applied = evaluation.env;
      return {
        ...(fingerprint === undefined ? {} : { profile: fingerprint }),
        ok: true,
        output: evaluation.output,
        // **値は返さない。** 何が増えたかは人間の確認に要るが、値は指紋と同じで
        // ここに晒すものではない。
        names: Object.keys(evaluation.env).sort(),
      };
    },
  };
}
