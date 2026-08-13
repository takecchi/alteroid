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
 * ## 効き方は3つ。**どこまで届くかは経路ごとに違う**
 *
 * 1. **SDK 子プロセスの起動時に1度評価して env へ畳む**（本命）。マネージャーも
 *    作業者も MCP サーバも、この env を継承した先で走る。**これから起こす仕事には
 *    差し替えが即座に効く**
 * 2. **`gh` のシム**（Dockerfile）が呼ばれるたびに読む。だから `gh` と、`gh` から
 *    資格情報を借りる `git` は、**走行中のマネージャーでも次の呼び出しから**
 *    新しいプロファイルを使う（`credentials.ts` と同じ形）
 * 3. **`BASH_ENV`**（＝`.zshenv` に当たる口）。効く場面では1コマンドごとに
 *    読み直される
 *
 * **3 に「走行中へ必ず届く」を期待しないこと。** bash が `BASH_ENV` を読むのは
 * 「スクリプトファイルとして起こされたとき」で、**プログラムから `bash -c` で
 * 起こされた場合（stdin が端末でない）は読まない**。さらに SDK の Bash ツールは
 * セッションごとの**永続シェル**なので、仮に読まれてもそのシェルの起動時1回である。
 *
 * したがって**走行中の仕事へ確実に届くのは 2 の経路だけ**で、それ以外は
 * 「次に起こす仕事から効く」が正しい。ここを取り違えると、鍵を差し替えたのに
 * 効かない相手が居ることに誰も気づけない（`alteroid profile status` は
 * *器に置かれたか*を見せるのであって、走行中のプロセスの中身は見せない）。
 *
 * ## 器が足しているもの（人間の本文には無い2行）
 *
 * - **再入の番人**。`BASH_ENV` は入れ子の bash にも継承されるので、プロファイルが
 *   スクリプトを呼び、そのスクリプトが bash なら、また読み直される。本文が
 *   コマンドを1つでも走らせていたら無限再帰になる。だから読み込み済みの印を
 *   立てて、内側では読まない
 * - **本文を包む関数**。source されたファイルの中の `return` は「そのファイルの
 *   読み込みそのもの」から戻るので、本文を直に置くと `[ -f ~/.foo ] || return 0`
 *   のような普通の早期リターン1つで、後ろに置いた後始末に到達しなくなる。
 *   関数に閉じ込めて、`return` をその関数からの復帰にする
 * - **伏せる鍵の `unset`**。本文が何を `export` しようと、**上（記憶）へ到達する鍵**
 *   だけは最後に落とす。配る仕組み（プロファイル）が伏せる仕組みを黙って越えない
 *   ようにするためで、`docker/alteroid-runner` が `exec` の前にやっているのと
 *   同じ形である
 *
 * ## そして「効いたか」を推測せず実測する
 *
 * 後始末が飛ばされうる書き方を**数え上げて弾く形にしない**。数え忘れた1つが
 * そのまま穴になるからで、実際に `return` を数え忘れている（しかも Node 側で
 * 差分から落としていたので、**保存時の検査は通るのに `BASH_ENV` 経由では
 * 漏れている**、という一番たちの悪い壊れ方をした）。
 *
 * だから保存する前に**実際に読ませて、伏せる鍵が残っていないかを見る**
 * （`ProfileEvaluation.leaked`）。残っていれば保存も配布もしない。
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
  /**
   * この器が本文の後で落とすと約束している名前。
   *
   * **一覧を二重に持たせないために出している。** 器（`unset` を書く側）と検査
   * （効いたかを見る側）が別々に一覧を持つと、片方だけ足したときに「すべての
   * プロファイルが拒否される」か「検査していないつもりの穴」のどちらかになる。
   */
  readonly withheldEnvKeys: readonly string[];
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

/** 本文を閉じ込める関数の名前。人間の名前空間と衝突しない形にしてある。 */
const PROFILE_BODY_FUNCTION = '__alteroid_profile_body';

/**
 * 器へ書く実体を組み立てる。
 *
 * **本文は関数の中に閉じ込める。** ここは一度間違えている — 以前は本文をそのまま
 * `if` の中へ置き、`unset` を `if` の外に出せば「本文が `return` しても到達する」
 * と書いていた。**間違いである。** source されたファイルの中の `return` は `if`
 * から抜けるのではなく、**そのファイルの読み込みそのものから戻る**。つまり
 * `[ -f ~/.foo ] || return 0` のような、プロファイルとしてまったく普通の早期
 * リターン1つで、末尾の `unset` に到達しなくなる。
 *
 * しかも壊れ方が静かだった。評価（`evaluateProfile`）は Node 側でも伏せる鍵を
 * 落としていたので、**保存時の検査は通る**。実際に効くのは `BASH_ENV` 経由の
 * 読み込みで、そちらにはその後処理が無い — 検査は「大丈夫」と言い、実物は
 * 漏れている、という一番たちの悪い形である。
 *
 * だから本文を関数にして、`return` を**その関数からの復帰**に閉じ込める。
 * 位置パラメータ（`$1` `$@`）は関数へそのまま渡すので、本文から見た意味は変わらない。
 * `export` も `PATH` への追記も関数の中から効く（シェル関数は環境を共有する）。
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
    '# 本文は関数の中で走らせる。**`return` をここからの復帰に閉じ込めるため。**',
    '# 直に置くと、本文の `return` がファイルの読み込みごと終わらせてしまい、',
    '# 下の `unset` に到達しない（伏せるはずの鍵が残る）。',
    `${PROFILE_BODY_FUNCTION}() {`,
    '# ここから人間が書いた本文 -------------------------------------------------',
    script.replace(/\s+$/, ''),
    '# ここまで人間が書いた本文 -------------------------------------------------',
    '  :',
    '}',
    // 位置パラメータをそのまま渡す（本文から見た `$1` `$@` の意味を変えない）。
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
      // `.zshenv` に当たる口。**効く場面では**1コマンドごとに読み直される。
      // ただし bash が読むのはスクリプトとして起こされたときで、`bash -c`
      // （stdin が端末でない）では読まれない。**走行中の仕事への配達をここに
      // 期待しないこと** — それは `gh` シムの経路が担っている。
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
  /**
   * **器が書いた `unset` を素通りして生き残った、伏せるはずの名前。**
   *
   * ここは実測である。「本文にこう書かれていたら危ない」を数え上げて弾く形に
   * すると、数え忘れた1つがそのまま穴になる（実際に `return` を数え忘れて、
   * *検査は通るのに実物は漏れている*という一番たちの悪い壊れ方をした）。
   * だから読み方を推測せず、**実際に読ませて、残っているかを見る**。
   *
   * 落とすのは呼び出し側の仕事だが、**落とすだけで済ませないこと** — 落として
   * 黙ると、`BASH_ENV` 経由（Node のフィルタが無い経路）で漏れ続ける。
   */
  leaked: string[];
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
        leaked: [],
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
    return { env: {}, leaked: [], output: tail(output), error: reason };
  } finally {
    clearTimeout(timer);
  }

  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(stdout) as Record<string, string>;
  } catch (error) {
    return {
      env: {},
      leaked: [],
      output: tail(output),
      error: `評価結果を読めなかった: ${String(error)}`,
    };
  }

  const diff: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (EPHEMERAL_ENV_KEYS.has(key)) continue;
    if (baseEnv[key] === value) continue;
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

  return { env: diff, leaked, output: tail(output) };
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
