import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chown, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { redactErrorText } from './denial-input-head.js';

/**
 * 実行環境プロファイル — 人間の `.zprofile` / `.zshenv` に当たるものを、
 * 記憶ストアに1本置いて全層へ効かせる器。
 *
 * 環境変数の一覧を持たない: 用途が増えるたびにコードを改修することになり、
 * 人間が `~/.zshenv` を1行足せば済むことが実装作業になるため（north_star 禁止1）。
 * `credentials.ts` は置き換えない（あちらは鍵1つを走行中に回す細い口）。効く順は
 * credentials → profile で、プロファイルが後から上書きする。
 *
 * 走行中の仕事へ確実に届くのは `gh` シムの経路だけ。`BASH_ENV` は非対話の bash
 * （`bash -c` も `bash -lc`）が読み、対話シェル（`bash -ic`）だけが読まない。それでも
 * 走行中への配達は期待しない: マネージャーが Bash ツールで打つシェル自体はプロファイルを
 * 読まず、入れ子の bash は読む。機序は特定できておらず、「届く」とも「届かない」とも畳まない。
 * 番人 `ALTEROID_PROFILE_SOURCED` は入れ子の bash が読んだ時点で export され、そこから起こした
 * `node` / `pnpm` / `vitest` が継承するので、シェルを起こす試験は `env` を明示すること。
 * 密閉した側の逐語は
 * `grep -Fn -- '器の番人を継承しないよう env を明示する' packages/core/src/profile.test.ts`。
 *
 * `env -u <名前>` で秘密を外すときは `BASH_ENV` も外すこと: 残すと起きた bash が
 * プロファイルを読み直して同じ名前を入れ直し、外れなかったことがエラーにならない。
 *
 * 器が足すもの: 再入の番人（`BASH_ENV` は入れ子の bash にも継承され、本文がコマンドを
 * 走らせると無限再帰になる）、本文を包む関数（source されたファイルの `return` は読み込み
 * ごと終わらせ、後ろの `unset` に到達しなくなる）、伏せる鍵の `unset`。
 *
 * 後始末が飛ばされうる書き方を数え上げて弾かない: 数え忘れた1つが穴になる（`return` を
 * 数え忘れ、保存時の検査は通るのに `BASH_ENV` 経由では漏れた）。保存前に実際に読ませて、
 * 伏せる鍵が残っていないかを見る（`ProfileEvaluation.leaked`）。
 */

/** 読み込み済みの印。**子へ配る env には残さない**（残すと差し替えが届かなくなる）。 */
export const PROFILE_SOURCED_ENV_KEY = 'ALTEROID_PROFILE_SOURCED';

/** プロファイルの所在を子へ知らせる環境変数。 */
export const PROFILE_FILE_ENV_KEY = 'ALTEROID_PROFILE_FILE';

/** runner の器での既定の置き場。`Dockerfile` が用意するディレクトリと揃える。 */
export const DEFAULT_PROFILE_PATH = '/run/alteroid/profile/profile.sh';

/** 待ち続けるとマネージャーが1本も起きなくなるための上限（能力の制限ではない）。 */
export const PROFILE_EVAL_TIMEOUT_MS = 10_000;

/**
 * 評価結果から捨てる名前（シェルが必ず書き換えるもの）。
 *
 * この一覧だけに頼らない: macOS の CoreFoundation が注ぐ `__CF_USER_TEXT_ENCODING` のように
 * 数え忘れた1つが差分に載る。本線は `evaluateProfile` のベースライン計測で、こちらは2枚目。
 */
const EPHEMERAL_ENV_KEYS = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL', PROFILE_SOURCED_ENV_KEY]);

/**
 * 保存・配布・指紋が同じ1つの文字列を見るように入口で1度だけ形を決める。
 * 末尾の改行が食い違うと `PUT` と `GET` の sha256 が合わず、`alteroid profile status` が
 * 「届いていない」と言い続ける。
 */
export function normalizeProfileScript(script: string): string {
  if (script.trim().length === 0) return '';
  return script.endsWith('\n') ? script : `${script}\n`;
}

export function fingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/** 置いてあるプロファイルの同一性。本文は出さない。 */
export interface ProfileFingerprint {
  /** 人間が書いた本文の sha256（16進）先頭12桁。器が足した行は含めない。 */
  sha256: string;
  bytes: number;
  updatedAt: string;
}

export interface ProfileVesselOptions {
  path: string;
  /** SDK 子プロセスを別 UID へ降ろしているなら、その UID。渡さなければ chown しない。 */
  reader?: { uid: number; gid: number };
  /**
   * 本文が何を書こうと最後に落とす名前（上＝記憶へ到達する鍵）。
   * 静的に検査しない: `eval` があり、何を `export` するかは読んでも分からず、弾く形は
   * 通り抜けた1つが穴になる。
   */
  withheldEnvKeys?: readonly string[];
  now?: () => Date;
}

export interface ProfileVessel {
  readonly path: string;
  /**
   * 器と検査が別々に一覧を持つと、片方だけ足したときに全プロファイルが拒否されるか、
   * 検査していないつもりの穴になるため、器の一覧をここから出す。
   */
  readonly withheldEnvKeys: readonly string[];
  script(): string | undefined;
  fingerprint(): ProfileFingerprint | undefined;
  /** プロファイルが無ければ何も渡さない: 空の `BASH_ENV` はシェルが毎回無いファイルを探すだけになる。 */
  env(): Record<string, string>;
  /** 空文字は「プロファイルを外す」。 */
  set(script: string): Promise<ProfileFingerprint | undefined>;
  /** 壊れたプロファイルを `BASH_ENV` に載せると全コマンドがエラーを吐くので、評価してから置くための仮置き。 */
  stage(script: string): Promise<StagedProfile>;
  readonly lastWriteError: string | undefined;
}

export interface StagedProfile {
  /** 評価に使う仮の置き場。まだ誰にも配られていない。 */
  path: string;
  commit(): Promise<ProfileFingerprint | undefined>;
  /** 本番の置き場は触らない（前のものが残る）。 */
  discard(): Promise<void>;
}

export function createProfileVessel(options: ProfileVesselOptions): ProfileVessel {
  return new Vessel(options);
}

const PROFILE_BODY_FUNCTION = '__alteroid_profile_body';

/**
 * 本文を関数に閉じ込める: 本文を直に `if` の中へ置くと、source されたファイルの `return`
 * （`[ -f ~/.foo ] || return 0` など）がファイルの読み込みごと終わらせ、末尾の `unset` に
 * 到達しない。Node 側の評価も伏せる鍵を落とすので、保存時の検査は通るのに `BASH_ENV` 経由では漏れる。
 *
 * 番人の条件式は、組み立てた本文への `toContain` では守れない（`ALTEROID_PROFILE_SOURCED` は
 * `export` の行にも出るので、条件式を壊しても当たり続ける）。守っているのは `profile.test.ts` の
 * 挙動を測る2本（「入れ子のシェルで本文を二度読まない」「親の環境に器の番人が立っていても同じ結果になる」）。
 */
export function renderProfileFile(script: string, withheldEnvKeys: readonly string[]): string {
  const lines = [
    '# このファイルは alteroid が書いている。直接編集しても次の差し替えで消える。',
    `# 本文の差し替えは \`alteroid profile set\` / \`PUT /profile\`。`,
    '',
    `if [ -z "\${${PROFILE_SOURCED_ENV_KEY}:-}" ]; then`,
    `  ${PROFILE_SOURCED_ENV_KEY}=1; export ${PROFILE_SOURCED_ENV_KEY}`,
    '',
    '# 本文は関数の中で走らせる。**`return` をここからの復帰に閉じ込めるため。**',
    '# 直に置くと、本文の `return` がファイルの読み込みごと終わらせてしまい、',
    '# 下の `unset` に到達しない（伏せるはずの鍵が残る）。',
    `${PROFILE_BODY_FUNCTION}() {`,
    '# ここから人間が書いた本文 -------------------------------------------------',
    script.replace(/\s+$/, ''),
    '# ここまで人間が書いた本文 -------------------------------------------------',
    '  :',
    '}',
    `${PROFILE_BODY_FUNCTION} "$@"`,
    `unset -f ${PROFILE_BODY_FUNCTION} 2>/dev/null || true`,
    'fi',
  ];

  if (withheldEnvKeys.length > 0) {
    lines.push(
      '',
      '# 上（記憶）へ到達する鍵は、本文が何をしても最後に落とす。',
      '#',
      '# **番人（if）の外に置いてある。** 本文の `return` は関数で閉じてあるので',
      '# もう素通りされないが、`if` の中で何が起きてもここへ到達させたい。',
      '# ここが飛ばされていないことは、保存する前に実物を読ませて確かめている',
      '# （`evaluateProfile` の `leaked`）— 抜け道を数え上げて塞ぐ形にすると、',
      '# 数え忘れた1つがそのまま穴になるからである。',
      `unset ${withheldEnvKeys.join(' ')}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

class Vessel implements ProfileVessel {
  readonly path: string;
  get withheldEnvKeys(): readonly string[] {
    return this.#withheld;
  }
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
      BASH_ENV: this.path,
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
      // 作ってから絞ると、その隙間で他人が読める。
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
        // 器へ入ってから進める: 置けなかったものを「配っている」と言わない。
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

/** runner は別 UID へ降ろすので差し替えられる。 */
export type ProfileSpawn = (options: {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}) => ChildProcess;

export interface ProfileEvaluation {
  /** 元の env から変わった分だけ。 */
  env: Record<string, string>;
  /** プロファイルが出した出力（人間が原因を見るための窓）。 */
  output: string;
  /** 成功と区別できる形で返す（黙って空を返さない）。 */
  error?: string;
  /**
   * 器が書いた `unset` を素通りして生き残った、伏せるはずの名前。
   * 落とすだけで済ませない: 落として黙ると、Node のフィルタが無い `BASH_ENV` 経由で漏れ続ける。
   */
  leaked: string[];
}

export interface EvaluateProfileOptions {
  path: string;
  /** 重ねる前の env。 */
  baseEnv: NodeJS.ProcessEnv;
  withheldEnvKeys?: readonly string[];
  spawnFn?: ProfileSpawn;
  timeoutMs?: number;
  /** 既定は `/bin/sh`。 */
  shell?: string;
  /** 既定は自分自身。 */
  nodePath?: string;
}

/**
 * プロファイルを1度だけ評価して、env の差分を取る。
 *
 * Node で読み直す: `BASH_ENV` は Bash 経由にしか効かず、CLI が直に起こす MCP サーバには
 * 鍵がプロファイルに書いても効かなくなる。
 *
 * 本文の標準出力は捨てずに stderr 側へ寄せる。捨てると人間が原因を見る窓が
 * 無くなり、混ぜると env の JSON が壊れる。
 *
 * 差分は `baseEnv` ではなく、同じ shell・node・env で本文を読まない1回（実測したベースライン）と
 * 比べる: 器と OS は本文が何も書かなくても env を増やす（macOS の `__CF_USER_TEXT_ENCODING`。
 * Linux の CI では出ず、手元でだけ落ちる）。捨てる名前の一覧へ足す形は、数え忘れた1つが
 * 同じ嘘になり、注ぐ側が OS と shell と node の版で変わるので採らない。
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

  // `$1` に node。env をそのまま JSON で吐かせる。
  const printEnv = '"$1" -e \'process.stdout.write(JSON.stringify(process.env))\'';
  // `$0` に本文。`. "$0" >&2` で本文の標準出力を stderr へ寄せる。
  const withProfile = `. "$0" >&2 || exit 97; exec ${printEnv}`;
  // **本文を読まない同じ1回。** 器と OS が勝手に足すものだけが現れる。
  const withoutProfile = `exec ${printEnv}`;

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

  /**
   * **シェルの stderr は、伏せてから切る（issue #2429）。** 構文エラーは入力の行を
   * そのまま引用し、`set -x` は `+ export GH_TOKEN=<値>` を吐く。ここから出た文は
   * `PUT /profile` の応答（400 の `detail` も 200 の `clone.output` も）・
   * クローンの道具 `profile_write` の戻り・CLI の表示のすべてに載るので、出口ごとに
   * 伏せず、集める場所（ここ）で1回伏せる。**先に切ると切り口で割れた鍵の断片が
   * 伏せ字のどれにも合わずに残る**ので、順は「伏せる→切る」。診断に要る文
   * （行番号・`syntax error`）は値ではないので残る。
   */
  const redactionEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  function scrub(text: string): string {
    return tail(redactErrorText(text.slice(-PROFILE_REDACT_INPUT_LIMIT), redactionEnv));
  }

  /** 1回起こして env を JSON で受け取る。失敗は理由つきで返す（黙って空を返さない）。 */
  async function capture(
    program: string,
  ): Promise<{ env?: Record<string, string>; output: string; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

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
          output: scrub(output),
          error:
            code === 97
              ? `プロファイルの読み込みが失敗した（${shell} が非 0 で終了）`
              : `プロファイルの評価が失敗した（終了コード ${String(code)}）`,
        };
      }
    } catch (error) {
      const reason = controller.signal.aborted
        ? `プロファイルの評価が ${String(timeoutMs)}ms 以内に終わらなかった（返ってこないコマンドを書いていないか）`
        : redactErrorText(String(error), redactionEnv);
      return { output: scrub(output), error: reason };
    } finally {
      clearTimeout(timer);
    }

    try {
      return { env: JSON.parse(stdout) as Record<string, string>, output: scrub(output) };
    } catch (error) {
      // `JSON.parse` の例外は、パースできなかった箇所の周りの本文（＝ env の値）を
      // メッセージへ引くことがある。伏せる。
      return {
        output: scrub(output),
        error: `評価結果を読めなかった: ${redactErrorText(String(error), redactionEnv)}`,
      };
    }
  }

  // **本文を読む側を先に走らせる。** 逆順にすると、本文の構文エラーを人間へ返す前に
  // ベースラインの失敗を返してしまい、いちばん多い「書き間違えた」が読めなくなる。
  const evaluated = await capture(withProfile);
  if (evaluated.error !== undefined || evaluated.env === undefined) {
    return {
      env: {},
      leaked: [],
      output: evaluated.output,
      error: evaluated.error ?? '評価結果を読めなかった',
    };
  }
  const parsed = evaluated.env;

  // ベースラインが取れなければ `baseEnv` と比べる（＝この直しの前の挙動）。
  // **本文を読む側が通った後なので、ここが落ちるのは器の異常だけである** — その場合に
  // 人間のプロファイルを置けなくするより、器と OS が足した分が差分に混じるほうがまだ軽い。
  const baseline = await capture(withoutProfile);
  const reference: NodeJS.ProcessEnv = baseline.env ?? baseEnv;

  const diff: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (EPHEMERAL_ENV_KEYS.has(key)) continue;
    if (reference[key] === value) continue;
    diff[key] = value;
  }
  // **器が書いた `unset` が本当に効いたかを、ここで実測する。**
  //
  // 土台（`baseEnv`）からは既に伏せる鍵が抜いてある。それでも読み終えた環境に
  // 残っているなら、それは本文が置いて `unset` が届かなかった、ということである。
  // ここを「黙って落とす」だけにしていたせいで、`BASH_ENV` 経由（Node のフィルタが
  // 無い経路）では漏れているのに保存時の検査は通る、という状態を作った。
  const leaked = withheldEnvKeys.filter((key) => parsed[key] !== undefined);

  // **伏せるのは最後。** 実測して弾くのとは別に、ここでも落とす（片方を通り忘れても
  // 穴にしないため）。
  for (const key of withheldEnvKeys) delete diff[key];

  // 人間へ見せる窓は**本文を読んだ側**のもの。ベースラインは本文を読んでいないので
  // 出力を持たない（混ぜると「プロファイルが出したもの」ではなくなる）。
  return { env: diff, leaked, output: evaluated.output };
}

/** 人間が読む窓であって記録ではない。長い出力で日誌を溢れさせない。 */
function tail(text: string, limit = PROFILE_FAILURE_TEXT_LIMIT): string {
  return text.length <= limit ? text : `${TAIL_MARK}${text.slice(-limit)}`;
}

const TAIL_MARK = '…（前略）\n';

/** 失敗の文（error・output）を応答・道具の戻りへ載せる長さの上限。 */
export const PROFILE_FAILURE_TEXT_LIMIT = 4_000;

/** 伏せ字へ渡す入力の上限。巨大な stderr を丸ごと正規表現に掛けない（末尾側を残す）。 */
const PROFILE_REDACT_INPUT_LIMIT = 100_000;

/**
 * 評価の失敗（`ProfileApplyResult` の `error` / `output`）を、応答・道具の戻りへ
 * 載せられる形にする（issue #2429）。
 *
 * `evaluateProfile` の側でも伏せてあるが、**出口でも同じ関数を通す**——
 * 器（`ProfileApplier`）はテストや別実装に差し替えられるので、出口が入口の伏せ字に
 * 頼り切ると、差し替えた器の出力が素通りする。**伏せてから切る順**（先に切ると
 * 切り口で割れた鍵の断片が残る）。
 */
export function redactProfileFailure(
  failure: { error?: string | undefined; output?: string | undefined },
  env: NodeJS.ProcessEnv | undefined = process.env,
): { error: string; output: string } {
  const scrubbed = (text: string): string => {
    const redacted = redactErrorText(text.slice(-PROFILE_REDACT_INPUT_LIMIT), env);
    // 入口（`evaluateProfile`）で切った印つきの文を、もう一度切って印を壊さない。
    return redacted.length <= PROFILE_FAILURE_TEXT_LIMIT + TAIL_MARK.length
      ? redacted
      : tail(redacted);
  };
  return {
    error: scrubbed(failure.error ?? '理由不明'),
    output: scrubbed(failure.output ?? ''),
  };
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
  /**
   * **評価だけ済ませて、置くのは待つ。**
   *
   * 評価と反映を1つにしていると、記憶ストアへの保存が落ちたときに「クローンだけが
   * 新しい本文を持っている」状態が残る（保存できていない ＝ 誰も成功と言っていない
   * 更新を、これから起こすクローンの子だけが使う）。だから正本（記憶ストア）へ
   * 書けたことを確かめてから `commit` する。
   *
   * 評価に落ちたものは `ok: false` で返り、`commit` しても何も起きない。
   */
  prepare(script: string): Promise<PreparedProfile>;
}

/** 評価まで済んで、まだ置かれていないプロファイル。 */
export interface PreparedProfile extends ProfileApplyResult {
  /** 器へ移して、子へ配る env を差し替える。 */
  commit(): Promise<ProfileFingerprint | undefined>;
  /** 捨てる。**いま効いているものは何も変わらない。** */
  discard(): Promise<void>;
}

export interface ProfileApplierOptions {
  vessel: ProfileVessel;
  /** 評価するときの土台。**実際に配るものと同じ env を渡すこと。** */
  baseEnv: () => NodeJS.ProcessEnv;
  /**
   * 検査する名前。**既定は器（`vessel`）が約束している一覧。**
   * 器が落とさない名前をここだけで要求しても、拒否が増えるだけで穴は塞がらない。
   */
  withheldEnvKeys?: readonly string[];
  /** 別 UID で読ませるなら渡す。**読む主体を配る先と揃える。** */
  spawnFn?: ProfileSpawn;
}

export function createProfileApplier(options: ProfileApplierOptions): ProfileApplier {
  // **既定は器が約束している一覧そのもの。** ここを別々に渡せる形にしたまま
  // 使うと、器が `unset` を書かない名前を検査だけが要求して、まっとうな
  // プロファイルが全部拒否される（実際にテストで踏んだ）。
  const { vessel, baseEnv, withheldEnvKeys = vessel.withheldEnvKeys, spawnFn } = options;
  let applied: Record<string, string> = {};

  /** 置かずに終わるときの形。`commit` しても何も起きない。 */
  function rejected(result: ProfileApplyResult, discard: () => Promise<void>): PreparedProfile {
    return {
      ...result,
      commit: async () => vessel.fingerprint(),
      discard,
    };
  }

  return {
    vessel,
    fingerprint: () => vessel.fingerprint(),
    env: () => ({ ...applied, ...vessel.env() }),
    async apply(script: string): Promise<ProfileApplyResult> {
      const prepared = await this.prepare(script);
      if (!prepared.ok) {
        await prepared.discard();
        return prepared;
      }
      await prepared.commit();
      return prepared;
    },
    async prepare(script: string): Promise<PreparedProfile> {
      const staged = await vessel.stage(script);

      if (script.trim().length === 0) {
        return {
          ok: true,
          commit: async () => {
            const fingerprint = await staged.commit();
            applied = {};
            return fingerprint;
          },
          discard: () => staged.discard(),
        };
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
        return rejected({ ok: false, error: evaluation.error, output: evaluation.output }, () =>
          staged.discard(),
        );
      }

      if (evaluation.leaked.length > 0) {
        // **器の `unset` を素通りしたものは置かない。**
        //
        // 落として配るだけでは足りない。ここで配る env から消しても、実際に効くのは
        // `BASH_ENV` 経由の読み込みで、そちらに Node のフィルタは無い。置いた時点で
        // 境界が消えるので、置かずに理由を返す（前のものが残る）。
        return rejected(
          {
            ok: false,
            error:
              `プロファイルが ${evaluation.leaked.join(' ')} を残している` +
              '（上＝記憶へ到達する鍵は、プロファイルからは置けない）。' +
              '本文の early return やシェル組み込みの再定義で、器が最後に置いている ' +
              'unset が飛ばされていないか確かめること',
            output: evaluation.output,
          },
          () => staged.discard(),
        );
      }

      return {
        // **指紋は本文から先に決まる。** 置く前に呼び出し側へ返せないと、
        // 保存の順序を組み替えられない。
        profile: {
          sha256: fingerprintOf(script),
          bytes: Buffer.byteLength(script),
          updatedAt: new Date().toISOString(),
        },
        ok: true,
        output: evaluation.output,
        // **値は返さない。** 何が増えたかは人間の確認に要るが、値は指紋と同じで
        // ここに晒すものではない。
        names: Object.keys(evaluation.env).sort(),
        commit: async () => {
          const fingerprint = await staged.commit();
          applied = evaluation.env;
          return fingerprint;
        },
        discard: () => staged.discard(),
      };
    },
  };
}
