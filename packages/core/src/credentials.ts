import { createHash, randomUUID } from 'node:crypto';
import { chown, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * マネージャーの道具の鍵を、**走行中でも差し替えられる形**で持つ器。
 *
 * **なぜ環境変数ではだめなのか。** 鍵を `process.env` から子へ配ると、値は
 * runner のプロセスが起動した瞬間に凍る。プラットフォームは走っているプロセスの
 * 環境変数を書き換えられないので、人間が鍵を直しても**再起動するまで届かない**。
 * しかも env で渡す以上、**既に走っている SDK 子プロセスには永久に届かない**
 * （プロセスの環境変数は外から書き換えられない）。
 *
 * その結果どうなるかは実際に起きた: 人間は鍵を正しく差し替え、マネージャーは
 * 正しく 403 を報告し、両方とも正しいまま何時間も噛み合わなかった。直す手段が
 * 再起動しかない以上、**「鍵を直す」と「走行中の仕事を失う」が同じ操作**になる。
 *
 * だから鍵は器（ファイル）に置く。`git` も `gh` も**呼ばれるたびに読み直す**ので、
 * 差し替えは走行中のマネージャーにも次の呼び出しから届く。ここにあるのは鍵の
 * 置き場と経路だけで、判断は無い。
 *
 * **これは能力の制限ではない。** 下（外の世界）へ手を伸ばす鍵は渡すのが正しく
 * （AGENTS.md）、変えているのは配り方だけである。伏せるのは上（記憶）へ到達する
 * 鍵だけで、そちらは `WITHHELD_ENV_KEYS` の仕事である。
 */

/** 既定の置き場。`Dockerfile` の `gh` シムが見るのと同じ場所である。 */
export const DEFAULT_CREDENTIAL_DIR = '/run/alteroid/credentials';

/**
 * 起動時に環境変数から器へ移す鍵。
 *
 * ここに挙げたものだけを扱う。**環境変数を総なめにしない** — 何が鍵かを推測で
 * 決めると、鍵でないものを鍵として晒すか、鍵を取りこぼすかのどちらかになる。
 */
export const ROTATABLE_CREDENTIAL_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  /**
   * Claude の認証（Issue #393 PR3）。**枠に当たったときに人間が登録した次の
   * トークンへ差し替えるために、この口へ乗せる。**
   *
   * ## 足したことで実際に変わるのは2つだけである
   *
   * 1. **値が器のファイルになる**（`/run/alteroid/credentials/CLAUDE_CODE_OAUTH_TOKEN`、
   *    mode 0400、読み手の UID へ chown）。**マネージャーの UID から読める。**
   *    ただし**新しい露出ではない** — マネージャーは元から `#childEnv()` 経由で
   *    同じ値を env に持っている（`compose.yaml` の `x-shared-env` が runner へ
   *    渡している）。増えたのは「同じ値の、ディスク上の複製」である
   * 2. 子へ `ALTEROID_CLAUDE_CODE_OAUTH_TOKEN_FILE`（**所在だけ。値ではない**）が
   *    増える
   *
   * ## ⚠️ 複製は器の再起動を越えて残る
   *
   * `compose.yaml` はこの置き場を名前付き volume（`control`）に載せているので、
   * **書いたファイルはコンテナを作り直しても残る。** env にしか無かったものが、
   * 平文でディスクに残るようになる、という差である。`GH_TOKEN` は既に同じ扱いだが、
   * **こちらは Claude の資格そのものなので、断りをここに書いておく。**
   *
   * 消えるのは `set()` に空を渡したときだけである（`#write` の `rm`）。
   *
   * ## ⚠️ そして走っているセッションには届かない
   *
   * `GH_TOKEN` には呼び出しごとにファイルを読み直す `gh` シムが在るが、**こちらには
   * それに当たるものが無い。** SDK は起動時の env を読むので、**この鍵をここへ
   * 足しても、走行中のマネージャーが新しいトークンで走り直すことはない**
   * （Issue #393「走行中のセッションには届かない」）。効くのは
   * **これから起こす**マネージャーと作業者だけである。
   */
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/**
 * プロファイルが、鍵と同じ名前を宣言してしまっていないか。**名前だけを返す。**
 *
 * ## なぜこの検査が要るか
 *
 * `runner.ts` の `#childEnv()` は**プロファイルを鍵より後に重ねる**（逐語は
 * `grep -n 'プロファイルは鍵より後' packages/core/src/runner.ts`）。「人間が明示的に
 * 書いたほうが勝つ」という判断で、`GH_TOKEN` については正しい。
 *
 * **⟹ プロファイルに `CLAUDE_CODE_OAUTH_TOKEN` が書かれていると、回した鍵が
 * 黙って上書きされる。** 回し手は「撒いた」と報告し、正本も書き換わり、日誌にも
 * 残るのに、**子プロセスが受け取るのは古い値である。**
 *
 * **しかもプロファイルはクローン自身が `profile_write` で書ける。** ⟹ 意図せず
 * （あるいは意図して）**クローンが自分でローテーションを無効化できる。**
 *
 * ## 直し方をここで選ばない
 *
 * **重ね順を変えない。** `GH_TOKEN` のために正しい順序であり、動かすとそちらが
 * 壊れる。**プロファイルの側で名前を禁じることもしない** — 追加制限にあたる
 * （north_star 禁止2）。⟹ **検出して出す**だけにしてある。撒く側がこれを呼び、
 * 影になっている名前を日誌と報告へ載せる。
 *
 * **「撒いたのに効かない」を黙って起こさないことがこの関数の全部である。**
 */
export function credentialNamesShadowedByProfile(
  names: readonly string[],
  profileEnvNames: readonly string[],
): string[] {
  const declared = new Set(profileEnvNames);
  return names.filter((name) => declared.has(name));
}

/**
 * 鍵の名前として認めるかたち。**環境変数の名前そのものである。**
 *
 * ここを自由な文字列にしていたせいで、`../../../etc/cron.d/x` のような名前が
 * そのままファイル名になり、**root で器の外へ書けた**（空文字を渡せば削除もできた）。
 * 名前は器の中のファイル名になるのだから、パスとして解釈されうる形を最初から
 * 名前として認めない。
 *
 * 経路の途中で弾くのではなく**名前の定義そのものを狭める**のは、検査を1か所でも
 * 通り忘れたら穴になるからである。
 */
export const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * 鍵として配ってはいけない名前か。
 *
 * `WITHHELD_ENV_KEYS`（記憶ストアの所在・制御面の合鍵）を鍵の名前として渡されると、
 * **伏せたはずの環境変数を子プロセスへ注入し直せる**。伏せる仕組みと配る仕組みが
 * 別々にあると、後から足したほうが前からある守りを黙って越える。
 */
export function isWithheldCredentialName(name: string, withheld: readonly string[]): boolean {
  return withheld.includes(name);
}

/**
 * 鍵が合っているかを、**値を出さずに**照合するための指紋。
 *
 * 人間が置いた鍵とマネージャーが握っている鍵が同じかどうかは、これが無いと
 * 誰にも見えない。見えなければ「付けた」「付いてない」のすれ違いが起きる。
 */
export interface CredentialFingerprint {
  name: string;
  /** sha256（16進）の先頭12桁。**値そのものは決して出さない。** */
  sha256: string;
  updatedAt: string;
}

export interface CredentialEntry {
  name: string;
  /** 空文字は「鍵を外す」の意味（未設定へ戻す）。 */
  value: string;
}

export interface CredentialStore {
  /** 子へ配る現在値。env のスナップショットに**上書きで**重ねる。 */
  values(): Record<string, string>;
  /** 器の所在を子へ知らせる環境変数（パスは凍っても構わない。中身が動く）。 */
  env(): Record<string, string>;
  /** いま持っている鍵の指紋。値は出さない。 */
  fingerprints(): CredentialFingerprint[];
  /** 差し替える。走行中のマネージャーにも次の `git` / `gh` 呼び出しから届く。 */
  set(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]>;
  /** 起動時に、環境変数から拾った分を器へ書き出す。 */
  flush(): Promise<CredentialFingerprint[]>;
  /** 直近の書き込みに失敗していれば理由。器が無い構成を黙って隠さないための窓。 */
  readonly lastWriteError: string | undefined;
}

export interface CredentialStoreOptions {
  /** 置き場。既定は `DEFAULT_CREDENTIAL_DIR`。 */
  dir?: string;
  /** 起動時の種。既定は `process.env`。 */
  seed?: NodeJS.ProcessEnv;
  /** 扱う鍵の名前。既定は `ROTATABLE_CREDENTIAL_KEYS`。 */
  names?: readonly string[];
  /**
   * 読める主体。SDK 子プロセスを別 UID へ降ろしているなら、その UID を渡す。
   * 渡さなければ chown しない（同じ UID で走るローカル構成）。
   */
  reader?: { uid: number; gid: number };
  /** 現在時刻。テストで固定するため。 */
  now?: () => Date;
  /**
   * 子プロセスへ伏せる環境変数の名前。**この名前は鍵として受け付けない。**
   *
   * 伏せる仕組み（`WITHHELD_ENV_KEYS`）と配る仕組みが互いを知らないと、後から
   * 足したほうが前からある守りを黙って越える。ここで結び付けておく。
   */
  withheldEnvKeys?: readonly string[];
}

/** 値そのものを出さずに同一性だけ見せる。 */
export function fingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  return new Store(options);
}

interface Held {
  value: string;
  updatedAt: string;
}

class Store implements CredentialStore {
  readonly #dir: string;
  readonly #reader: { uid: number; gid: number } | undefined;
  readonly #now: () => Date;
  readonly #held = new Map<string, Held>();
  /** 扱う鍵の名前（所在を子へ知らせる対象）。中身の有無とは別に決まる。 */
  readonly #names: readonly string[];
  readonly #withheld: readonly string[];
  /** 器へ書けなかったことを、黙って握り潰さないための印。 */
  #lastWriteError: string | undefined;

  constructor(options: CredentialStoreOptions) {
    this.#dir = options.dir ?? DEFAULT_CREDENTIAL_DIR;
    this.#reader = options.reader;
    this.#now = options.now ?? (() => new Date());

    const seed = options.seed ?? process.env;
    const names = options.names ?? ROTATABLE_CREDENTIAL_KEYS;
    this.#withheld = options.withheldEnvKeys ?? [];
    // 名前として成立しないものは、種の時点で落とす（器の外を指す名前を持ち込ませない）
    this.#names = names.filter(
      (name) => CREDENTIAL_NAME.test(name) && !isWithheldCredentialName(name, this.#withheld),
    );
    const at = this.#now().toISOString();
    for (const name of this.#names) {
      const value = seed[name];
      // 空文字は「置かれていない」と同じに扱う。空の鍵を配ると、鍵が無い場合より
      // 悪い壊れ方（`empty ident` 相当の即死）をする経路がある。
      if (typeof value !== 'string' || value.length === 0) continue;
      this.#held.set(name, { value, updatedAt: at });
    }
  }

  values(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, held] of this.#held) out[name] = held.value;
    return out;
  }

  /**
   * 子へ知らせる**所在**（値ではない）。
   *
   * 扱う鍵ぜんぶに `ALTEROID_<NAME>_FILE` を出す。GH_TOKEN だけを特別扱いすると、
   * 「回せる」と言いながら回らない鍵ができる（実際に `GITHUB_TOKEN` がそうなっていた
   * — 器には置かれるのに、走行中のマネージャーへ届く経路がどこにも無かった）。
   */
  env(): Record<string, string> {
    const out: Record<string, string> = { ALTEROID_CREDENTIAL_DIR: this.#dir };
    for (const name of this.#names) out[`ALTEROID_${name}_FILE`] = join(this.#dir, name);
    return out;
  }

  fingerprints(): CredentialFingerprint[] {
    return [...this.#held].map(([name, held]) => ({
      name,
      sha256: fingerprintOf(held.value),
      updatedAt: held.updatedAt,
    }));
  }

  async set(entries: readonly CredentialEntry[]): Promise<CredentialFingerprint[]> {
    // **名前は器の中のファイル名になる。** パスとして解釈されうる形を受けない。
    for (const entry of entries) {
      if (!CREDENTIAL_NAME.test(entry.name)) {
        throw new Error(
          `鍵の名前として認められない: ${JSON.stringify(entry.name)}（英大文字・数字・_ のみ）`,
        );
      }
      if (isWithheldCredentialName(entry.name, this.#withheld)) {
        throw new Error(
          `${entry.name} は子プロセスへ伏せる鍵なので、鍵として配れない` +
            '（伏せる仕組みを鍵の仕組みで越えさせない）',
        );
      }
    }

    const at = this.#now().toISOString();

    /**
     * **1鍵ずつ、器へ入ってから memory を進める。**
     *
     * まとめて memory を進めてから書くと、途中で失敗したときに戻す先が無い。
     * ディスクは複数ファイルにまたがるので、後から巻き戻しても「1件目は新値・
     * memory は旧値」という食い違いが残る（巻き戻し自体も失敗しうる）。
     *
     * だから**バッチの原子性を装わない**。1鍵ごとには不可分（staging → rename）で、
     * バッチ全体は途中で止まりうる。止まったことは例外で知らせ、どこまで進んだかは
     * 指紋を見れば分かる — **指紋は常に器の中身と一致している**、という約束のほうを
     * 守る。食い違いを見つけるための道具が嘘をつかないことが、ここでは最優先である。
     */
    const applied: string[] = [];
    for (const entry of entries) {
      const held = entry.value.length === 0 ? undefined : { value: entry.value, updatedAt: at };
      try {
        await this.#commit(entry.name, held);
      } catch (error) {
        this.#lastWriteError = String(error);
        throw new Error(
          `鍵の差し替えが ${entry.name} で止まった` +
            `（適用済み: ${applied.length === 0 ? 'なし' : applied.join(', ')}` +
            ` / 未適用: ${entries
              .slice(applied.length)
              .map((rest) => rest.name)
              .join(', ')}）: ${String(error)}`,
          { cause: error },
        );
      }
      applied.push(entry.name);
    }
    this.#lastWriteError = undefined;
    return this.fingerprints();
  }

  /**
   * 1鍵を器へ入れ、**入ってから** memory を進める。
   *
   * 順序が逆だと、書けなかった鍵を配ってしまう（走行中のマネージャーは器を読み、
   * これから起きるマネージャーは memory を読むので、両者が食い違う）。
   */
  async #commit(name: string, held: Held | undefined): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o711 });
    const path = join(this.#dir, name);

    if (held === undefined) {
      await rm(path, { force: true });
      this.#held.delete(name);
      return;
    }

    const staging = `${path}.${randomUUID().slice(0, 8)}`;
    try {
      // 改行を足さない。`cat` した値がそのまま鍵になる。
      await writeFile(staging, held.value, { mode: 0o400 });
      if (this.#reader !== undefined) {
        await chown(staging, this.#reader.uid, this.#reader.gid);
      }
      await rename(staging, path);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
    this.#held.set(name, held);
  }

  /**
   * 起動時に、環境変数から拾った分を器へ書き出す。
   *
   * **ここだけは書けなくても memory を落とさない。** 起動時にはまだ器を読む
   * マネージャーが1人も居ないので食い違いようがなく、逆に memory を捨てると
   * 「器が用意できないローカルでは鍵がまったく配られない」という能力の欠落に
   * なる（env 経由の経路は残っているのに）。失敗は `lastWriteError` に残す。
   */
  async flush(): Promise<CredentialFingerprint[]> {
    for (const [name, held] of [...this.#held]) {
      try {
        await this.#commit(name, held);
        this.#lastWriteError = undefined;
      } catch (error) {
        this.#lastWriteError = String(error);
        process.stderr.write(
          `alteroid-runner: 鍵を器へ書けませんでした（走行中の差し替えは届きません）: ${this.#lastWriteError}\n`,
        );
      }
    }
    return this.fingerprints();
  }

  /** 直近の書き込みに失敗していれば理由。成功していれば undefined。 */
  get lastWriteError(): string | undefined {
    return this.#lastWriteError;
  }
}
