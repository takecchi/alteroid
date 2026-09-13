import { createHash, randomUUID } from 'node:crypto';
import { chown, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { excerptLine } from './excerpt.js';

/**
 * `set()` が途中で止まったときの「適用済み」「未適用」の一覧を抜粋する厚み
 * （#409）。
 *
 * どちらも1バッチで差し替える鍵の本数ぶん伸びる。呼び手は apps/cli（人間の
 * 運用）と apps/daemon の管理 API から届くが、両方に上限が無かった——#1
 * （`配れなかった先`）と同じ形の穴である。
 */
const CREDENTIAL_BATCH_LIST_EXCERPT = 400;

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
   * ## ⚠️ そして走行中の「ターン」には届かない
   *
   * `GH_TOKEN` には呼び出しごとにファイルを読み直す `gh` シムが在るが、**こちらには
   * それに当たるものが無い。** SDK は起動時の env を読むので、この鍵を差し替えても
   * **いま走っているターンには届かない**（Issue #393「走行中のセッションには
   * 届かない」）。
   *
   * **⚠️ ただし「走っているマネージャー自身が永久に取り残される」わけではない
   * （直した。fix/recycle-manager-session-on-token-rotation）。** runner は
   * ターンの境界（入力待ち・確認待ちが無い・背景処理が無い・resume できる
   * 状態）でこのセッションを畳んで `resume` で開き直す
   * （`runner.ts` の `Host#setCredentials` / `#reopenForTokenRotation`）ので、
   * **次のターンから**新しい値で走る。効くのが即座なのは
   * **これから起こす**マネージャーと作業者で、**走行中のマネージャーは
   * 次のターンの境界から**である。
   */
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

/**
 * **正本を認証トークンのプールが持つ名前。** 名前→値の袋（`CredentialService`）
 * へは置かせない。
 *
 * ## なぜ拒むのか（`credentialNamesShadowedByProfile` は拒まないのに）
 *
 * プロファイルの側を拒まないのは、あちらが**中身を解釈しない自由記述**であり、
 * 名前を禁じると追加制限になるからである（そちらの doc）。こちらは違う——
 * **名前ごとに置く袋なので、置けば必ず名前ごとに配る。** そして配る契機に
 * `hello`（runner が名乗り直すたび）が含まれる:
 *
 * 1. 回し手がプールの現役を撒く（新しい値が器へ入る）
 * 2. runner が繋ぎ直す（デプロイ・再接続）
 * 3. 袋の `syncRunner` が**袋に入っている古い値**を降ろし直す
 *
 * ⟹ **回した鍵が、再接続のたびに黙って巻き戻る。** しかも器も日誌も「撒いた」と
 * 言うので、どこにも赤が出ない（`credentialNamesShadowedByProfile` が防いでいる
 * のと同じ壊れ方を、こちらは**自分で作り出す**）。
 *
 * **能力は1つも減らない。** この名前を置く口は在り、そちらのほうが強い
 * （`alteroid token add` は複数本を持って枠に当たったら回す）。ここで拒むのは
 * 「2つ目の正本を作らせない」ためであって、できることを削るためではない。
 *
 * **型で `ROTATABLE_CREDENTIAL_KEYS` に縛ってある**（`runner.ts` の
 * `AGENT_TOKEN_CREDENTIAL_NAME` と同じ理由）。裸のリテラルだと、名前が変わった
 * ときにここだけが古い名前を拒み続け、**新しい名前は素通りするのにテストも
 * typecheck も緑**という静かな壊れ方をする。
 *
 * **縛りは `satisfies` で掛け、宣言する型は `readonly string[]` にしてある。**
 * 型そのものを union にすると、`includes(<任意の名前>)` が「その union の値しか
 * 渡せない」と言って落ちる——**検査したい相手（器の外から来た任意の文字列）を
 * 検査できなくなる**ので、縛りと使い勝手を分けている。
 */
export const POOL_OWNED_CREDENTIAL_NAMES: readonly string[] = [
  'CLAUDE_CODE_OAUTH_TOKEN',
] satisfies readonly (typeof ROTATABLE_CREDENTIAL_KEYS)[number][];

/**
 * **クローンの器の環境変数が、正本より優先して配られる名前。** GitHub の
 * 認証だけを明示的に列挙してある（人間の決定 2026-09-12、Issue #865 の
 * 恒久策）。
 *
 * ## なぜこの名前だけか
 *
 * オーナーの仕様は逐語で「alteroidの作りとして環境変数はcloneと同じものを渡す
 * ように仕様として決めています」——**クローンが基準**であり、マネージャーは
 * それと同じものを受け取る。GitHub の資格（`GH_TOKEN` / `GITHUB_TOKEN`）は
 * この不一致が実害になった当の名前（Issue #865 の実測: マネージャーは
 * GitHub App の user-to-server トークン、クローンは classic PAT）なので、
 * ここへ明示的に挙げる。
 *
 * **`ROTATABLE_CREDENTIAL_KEYS` から `POOL_OWNED_CREDENTIAL_NAMES` を引いた
 * 集合の別名ではない。** 現状はたまたま同じ2要素になるが、将来
 * `ROTATABLE_CREDENTIAL_KEYS` に GitHub 以外の非プールの名前が増えても、
 * **ここへ明示的に足さない限りこの優先順位は広がらない**——広げる人は、
 * この配列に1行足す判断を必ず一度通ることになる（歯:
 * `credential-service.test.ts` の「GITHUB_CREDENTIAL_NAMES の外は正本のまま」）。
 *
 * ここに載っていない名前——`CLAUDE_CODE_OAUTH_TOKEN`（`POOL_OWNED_CREDENTIAL_NAMES`
 * で別途必ず除かれる）と、`ROTATABLE_CREDENTIAL_KEYS` に無い任意の名前
 * （PR #825「任意の名前→任意の値」）——は**従来どおり正本が勝つ**。
 *
 * **型で `ROTATABLE_CREDENTIAL_KEYS` に縛ってある**（`POOL_OWNED_CREDENTIAL_NAMES`
 * と同じ理由。裸のリテラルだと、名前が変わったときにここだけが古い名前を
 * 見続け、新しい名前は素通りするのに typecheck が緑という静かな壊れ方をする）。
 */
export const GITHUB_CREDENTIAL_NAMES: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
] satisfies readonly (typeof ROTATABLE_CREDENTIAL_KEYS)[number][];

/**
 * プロファイルが、鍵と同じ名前を宣言してしまっていないか。**名前だけを返す。**
 *
 * ## なぜこの検査が要るか
 *
 * `runner.ts` の `#childEnv()` は**プロファイルを鍵より後に重ねる**（逐語は
 * `grep -Fn -- 'プロファイルは鍵より後' packages/core/src/runner.ts`）。「人間が明示的に
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
  /**
   * **正本のこの行が、クローンの器の環境変数の値に優先順位で負けていて
   * 配られていない**ときだけ `true`。**既定では付けない**（この行を持たない
   * 器は、この旗を理由に何も変わらない——`false` を敷き詰めると「明示的に
   * 食い違っていないと確かめた」という意味になってしまい、見ていないものと
   * 見て揃っていたものの区別が付かない）。
   *
   * 真になるのは、正本にこの名前の行が在り（**GitHub の名前
   * ——`GITHUB_CREDENTIAL_NAMES`——に限る**）、かつクローンの器の環境変数にも
   * 空でない別の値が在るときだけである（Issue #865 の実測を機に、人間が
   * 2026-09-12 に決めた恒久策）。検出条件は `credential-service.ts` の
   * `cloneEnvShadowedNames` に置いてある。
   *
   * **⚠️ 「正本が在れば器の env より正本が勝つ」だった以前の仕様は、この名前に
   * ついて反転した**（`resolveCredentialRows`、2026-09-12。オーナーの仕様
   * 「クローンへ渡す環境変数と同じものをマネージャーへ渡す」——クローンが
   * 基準）。**⟹ この旗が立っているとき、正本のその行はマネージャーにも
   * クローンにも配られていない。両方ともクローンの器の環境変数の値で走る。**
   * 正本のその行を外しても配られる値は変わらない——直すには、正本の値を
   * クローンの器の環境変数に合わせて置き直すか、器の環境変数の側を変える
   * （この HTTP の口からは変えられない）。
   *
   * `CredentialStore`（runner 側の器）はこの旗を立てない——runner には
   * 「クローンの器の env」という比較対象がそもそも無い。
   */
  shadowsCloneEnv?: boolean;
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
  /**
   * **いま持っていない鍵のファイルを置き場から消す。** 消した名前を返す。
   *
   * ## なぜ要るか
   *
   * 置き場が volume の構成（`compose.yaml` の `control`）では、**器を作り直しても
   * ファイルが残る。** 残ったものは、デーモンが降ろす前の一瞬だけ効く —— しかも
   * `gh` シムは呼ばれるたびにファイルを読むので、**memory が空でも古い鍵で
   * 認証が通る。** ＝「runner は自分では鍵を持たない」が、前の器の置き土産で
   * 破れる（実行環境プロファイル側の `rmSync` と同じ穴で、同じ直し方である）。
   *
   * **消すのは「名前として成立するもの」だけ**（`CREDENTIAL_NAME`）。置き場に
   * 他人のファイルが在る構成を壊さない。**いま持っている鍵は消さない** ——
   * 降ろされた直後に呼ばれても、降りた鍵を自分で消さないため。
   */
  purge(): Promise<string[]>;
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
   *
   * **「扱う鍵」は `#names`（起動時に env から拾う表）だけではない。** `set()` は
   * 表を見ずに任意の名前を受け付ける（検査は名前の形と伏せる鍵の拒否だけ）ので、
   * デーモンが降ろしてきた名前は表に無い。表だけを見ていると、**配ったのに所在を
   * 知らせない鍵**ができる — それは `GITHUB_TOKEN` で既に踏んだのと同じ形
   * （器には在るのに、読み直す道具へ所在が届かない）である。だから和を出す。
   *
   * **順序は表が先、降りてきた鍵が後。** どちらも同じ値（`join(dir, name)`）に
   * なるので勝ち負けは無いが、読む人にとって「既定の表 → 後から足された分」の
   * 並びのほうが素直である。
   *
   * **外したときの振る舞いは、表の分と降りてきた分で違う。** 表の名前は種が無くても
   * 所在を知らせ続けるが（`names` は「この器が扱うと宣言した集合」である）、降りて
   * きた名前は外すと所在も消える（あちらは「いま在る鍵」でしかない）。どちらも
   * 指す先のファイルは無いので、読む道具から見た結果は同じ（ENOENT）である。
   */
  env(): Record<string, string> {
    const out: Record<string, string> = { ALTEROID_CREDENTIAL_DIR: this.#dir };
    for (const name of new Set([...this.#names, ...this.#held.keys()])) {
      out[`ALTEROID_${name}_FILE`] = join(this.#dir, name);
    }
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
            `（適用済み: ${
              applied.length === 0
                ? 'なし'
                : excerptLine(applied.join(', '), CREDENTIAL_BATCH_LIST_EXCERPT)
            }` +
            ` / 未適用: ${excerptLine(
              entries
                .slice(applied.length)
                .map((rest) => rest.name)
                .join(', '),
              CREDENTIAL_BATCH_LIST_EXCERPT,
            )}）: ${String(error)}`,
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

  /**
   * 持っていない鍵のファイルを消す（前の器の置き土産を引き継がない）。
   *
   * **置き場が無い構成では何もしない**（ローカルの同一プロセス runner 等）。
   * 読めないことと「残っていない」ことを同じ扱いにしてよいのは、どちらの場合も
   * **配る側から見て古い鍵が効かない**という結論が同じだからである。
   */
  async purge(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#dir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of entries) {
      // 名前として成立しないもの（他人のファイル・書き込み中の staging）は触らない。
      if (!CREDENTIAL_NAME.test(name)) continue;
      // いま持っている鍵は消さない（降りた直後に呼ばれても自分の鍵を落とさない）。
      if (this.#held.has(name)) continue;
      try {
        await rm(join(this.#dir, name), { force: true });
        removed.push(name);
      } catch (error) {
        // **黙って握り潰さない。** 消せなかったファイルは古い鍵として効き続ける。
        this.#lastWriteError = String(error);
      }
    }
    return removed;
  }

  /** 直近の書き込みに失敗していれば理由。成功していれば undefined。 */
  get lastWriteError(): string | undefined {
    return this.#lastWriteError;
  }
}
