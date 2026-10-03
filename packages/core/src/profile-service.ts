import { redactErrorText } from './denial-input-head.js';
import { reasonOf } from './dropped-record.js';
import {
  fingerprintOf,
  normalizeProfileScript,
  type PreparedProfile,
  type ProfileApplier,
  type ProfileApplyResult,
} from './profile.js';
import type {
  RunnerClient,
  RunnerProfileFingerprint,
  RunnerProfileResult,
  RunnerRegistry,
} from './runner-protocol.js';
import {
  compareProfileEntryNames,
  PROFILE_ENTRY_NAME,
  type EnvProfileEntry,
  type EnvProfileScope,
  type Stores,
} from './store.js';

/**
 * その撒く先が `target`（`'clone'` = デーモン自身＝クローンの SDK 子プロセス /
 * `'runner'` = runner＝マネージャー・作業者）に届くべきか。
 *
 * **ここ1か所で決める。** 合成・配布・降ろし直しが別々に判定すると、必ず1つだけ
 * 食い違い、「外したはずの側に本文が残る」が生まれる（環境変数の
 * `credential-service.ts` の `scopeAppliesTo` と同じ形・同じ理由）。
 */
export function profileScopeAppliesTo(
  scope: EnvProfileScope | undefined,
  target: 'clone' | 'runner',
): boolean {
  const normalized = scope ?? 'all';
  if (normalized === 'all') return true;
  return normalized === 'app' ? target === 'clone' : target === 'runner';
}

/** 合成の対象。`all` は撒く先を問わない全行（`GET /profile` の互換の `script` 用）。 */
export type ProfileComposeTarget = 'clone' | 'runner' | 'all';

/**
 * 行を**1本のスクリプトにつなげる**。**合成はここ1つに寄せる**（`apply` / `restore` /
 * `syncRunner` / runner への配布がすべてここを通る。別々に組み立てると、
 * 指紋・配った本文・クローンに効かせた本文が食い違う）。
 *
 * - 対象（`clone` / `runner`）に撒く先が掛かる行だけを、**名前のコード単位順**
 *   （`/etc/profile.d` と同じ方式。ロケールに依存しない）で並べる
 * - 行と行のあいだに空行を1つ入れる。**見出しは入れない**: 1行だけのとき（1本の時代の
 *   プロファイルは `default` 1行に移る）合成が元の本文とバイトまで一致し、アップグレードで
 *   指紋も器の中身も変わらない（再配布も起きない）。**決定的である**（同じ行の集合は常に
 *   同じ文字列になる ＝ 指紋が揺れない）
 * - 掛かる行が0なら `''`（＝**外す**。「何もしない」ではなく空を降ろす。撒く先を
 *   狭めた側から確実に外れる）
 * - 最後に `normalizeProfileScript` を**合成後の1本**に掛ける（保存・配布・指紋が同じ
 *   文字列を見る）
 *
 * runner のプロトコルと applier は変えない — 今までどおり1本の本文を受け取る。
 */
export function composeProfileScript(
  entries: readonly EnvProfileEntry[],
  target: ProfileComposeTarget,
): string {
  const parts = entries
    .filter((entry) => target === 'all' || profileScopeAppliesTo(entry.scope, target))
    .filter((entry) => entry.script.trim().length > 0)
    .sort((a, b) => compareProfileEntryNames(a.name, b.name))
    .map((entry) => (entry.script.endsWith('\n') ? entry.script : `${entry.script}\n`));
  return normalizeProfileScript(parts.join('\n'));
}

/** 合成後の本文の指紋（本文が空なら欠ける）。 */
export interface ComposedFingerprint {
  sha256?: string;
  bytes?: number;
}

function fingerprintOfComposed(script: string): ComposedFingerprint {
  return script.length === 0
    ? {}
    : { sha256: fingerprintOf(script), bytes: Buffer.byteLength(script) };
}

/** clone 用・runner 用の合成後の指紋（`GET /profile`・`profile status` が突き合わせに使う）。 */
export function composedFingerprints(entries: readonly EnvProfileEntry[]): {
  clone: ComposedFingerprint;
  runner: ComposedFingerprint;
} {
  return {
    clone: fingerprintOfComposed(composeProfileScript(entries, 'clone')),
    runner: fingerprintOfComposed(composeProfileScript(entries, 'runner')),
  };
}

/**
 * 実行環境プロファイルを**置いて配る**までの1本道。
 *
 * ## なぜ「1本道」でなければならないか
 *
 * 更新は3段ある（① クローンの器へ commit ② 記憶ストアへ保存 ③ 各 runner へ配布）。
 * これを直列化しないと、**同時に2つ更新が入ったときに層ごとに違う本文が残る**。
 *
 *     A が ① → B が ①②③ → A が ②③   ⇒ クローン=B、ストア/runner=A
 *
 * どちらの呼び出しも成功を返すのに、これから起こすクローンの子と runner の仕事で
 * 環境が違い、デーモンを再起動するとストアの A へ突然戻る。鍵の更新なら「同じ時点
 * から仕事ごとに違う資格情報を使う」状態になり、しかも指紋を見ても食い違いの理由が
 * 分からない（3つとも「置けた」と答える）。
 *
 * **人間の口（`PUT /profile`）とクローンの道具（`profile_write`）を同じ経路に
 * 寄せた結果、この同時更新は現実に起きる。** クローンは自律ターン（時間起点・発意）
 * からも動くので、人間が `alteroid profile edit` している最中にクローンが書くことは
 * 普通に起こりうる。
 *
 * ## 2人目の書き手も同じ列に入れる
 *
 * runner が名乗り直したときの降ろし直し（`ManagerPool` の再接続処理）も、runner へ
 * 書く操作である。更新の最中に走ると、**古い本文を読んで新しい本文を上書きする**。
 * だから `syncRunner` もこの列を通す。
 *
 * **後勝ちにするが、1更新の全段が終わってから次を始める。** 途中で混ざらないこと
 * だけを保証すればよく、順番を決める仕組みは要らない（人間が最後に書いたものが
 * 残る、が素直な意味である）。
 */
export interface ProfileService {
  /** いま保存されている全行（名前のコード単位順）。 */
  read(): Promise<EnvProfileEntry[]>;
  /**
   * 1行を置く。**評価 → 保存 → 配布までを1つの区間として直列に行う。**
   *
   * `scope` を省略すると**既存行の撒く先を保つ**（無ければ `'all'`。環境変数の
   * `resolveEntryForWrite` と同じ）。本文だけ直したつもりで撒く先が `all` へ戻る、を
   * 作らない。**撒く先が掛からない側へは、本文ではなくその側の合成（行が0なら空）が
   * 降りる**（{@link composeProfileScript}）。
   *
   * 本文が空白だけの行は置けない（投げる。外すのは `remove`）。
   */
  set(name: string, script: string, scope?: EnvProfileScope): Promise<ApplyProfileResult>;
  /** 1行を外す。無ければ何も変えず `removed: false`。 */
  remove(name: string): Promise<ApplyProfileResult & { removed: boolean }>;
  /** 全行を外す（旧来の「空の `PUT /profile`」の意味）。 */
  clearAll(): Promise<ApplyProfileResult>;
  /**
   * 全行を、`default` 1行（`scope: 'all'`）に置き換える（旧来の全文置換
   * `PUT /profile { script }` の意味を保つ互換）。空白だけなら `clearAll` と同じ。
   */
  apply(script: string): Promise<ApplyProfileResult>;
  /**
   * 保存済みの行を合成し、クローンの器へ**効かせ直す**（デーモンの起動時）。
   *
   * **記憶ストアへは書かない。** 起動しただけで `updatedAt` が動くと、`profile
   * status` や `GET /profile` が見せる「更新」が「最後にデーモンを起こした時刻」に
   * なり、人間かクローンが最後に本文を変えた時刻という意味が失われる（本文を一度も
   * 変えていなくても監査情報が消える）。
   *
   * クローンに掛かる行が無ければ null（何も効かせない）。
   */
  restore(): Promise<ProfileApplyResult | null>;
  /**
   * 1台の runner へ、いま保存されている行の runner 用の合成を降ろし直す。
   *
   * **runner は記憶ストアを読めない**ので、器が作り直されたときに降ろすのはこちら
   * の責任である。既に同じものが載っていれば何もしない（再接続のたびに人間の
   * 書いたスクリプトを評価し直さない）。
   */
  syncRunner(runner: RunnerClient): Promise<RunnerProfileResult | null>;
  /**
   * **`set` / `remove` / `clearAll` の即時の配布の結果を知らせる（Issue #1699）。**
   * 返り値は購読を外す関数。
   *
   * 更新は保存の直後に、繋がっている runner へその場で直接配る。この経路は
   * `ManagerPool` の押し込みの帳面（`#pushHealth`）と挑み直し（`#schedulePushRetry`）を
   * 通らなかったので、一時的な障害で配り損ねても `runner_list` は前の「ok」のままで、
   * 挑み直しも予約されなかった（名乗りのときの配布は「諦めずに挑み直す」と約束して
   * いるのに）。`ManagerPool` がここを購読し、同じ帳面に積む——約束を1つにする。
   *
   * **任意の口である。** 偽物（テスト）は持たなくてよい。人間の口とクローンの道具は
   * 同じインスタンスを通るので、どちらの入口から書いても同じ扱いになる。
   */
  onPushed?(
    listener: (results: readonly (RunnerProfileResult & { runnerId: string })[]) => void,
  ): () => void;
}

/**
 * `apply()` の反映（`prepared.commit()`）が落ち、正本への書き戻し
 * （`stores.profile.replaceAll(previous)`）まで落ちたときに投げる（issue #2163）。
 *
 * **文言では見分けないこと。** 呼び出し側（`PUT /profile` / `PUT /profile/:name` の `app.ts`・
 * `profile_write` の `tools.ts`）はこれを `instanceof` で捕まえ、日誌の決定の
 * 行を状態どおり（正本は新しい版のまま・クローンは前の版）に書き換える。
 * `message` / `cause` は、この型を導入する前の `Error` と1文字も変えていない。
 */
/**
 * 行として置けない入力（名前の形・空の本文・大文字小文字だけが違う既存の名前）。
 * **何も変えていない**（保存も配布もしていない）。呼び出し側は文言ではなくこの型で
 * 見分け、利用者の誤りとして返す（500 にしない）。
 */
export class ProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileInputError';
  }
}

export class ProfileRollbackFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProfileRollbackFailedError';
  }
}

export interface ProfileServiceOptions {
  stores: Stores;
  /** クローン側の器。保存の前に「読めるか」を確かめる唯一の場所でもある。 */
  applier?: ProfileApplier;
  /** 委譲先。無ければ配布はしない（保存はする）。 */
  runners?: RunnerRegistry;
}

export interface ApplyProfileResult {
  /** 保存できたか。**読めなかったときは保存もしていない。** */
  stored: boolean;
  /** この操作の時刻。 */
  updatedAt?: string;
  /** 操作の後の全行（保存していないときは欠ける）。 */
  entries?: EnvProfileEntry[];
  /** 操作の後の、clone 用・runner 用の合成後の指紋（保存していないときは欠ける）。 */
  composed?: { clone: ComposedFingerprint; runner: ComposedFingerprint };
  /** クローン（デーモン自身）への反映結果。 */
  clone: ProfileApplyResult;
  /** 各 runner への配布結果。 */
  runners: (RunnerProfileResult & { runnerId: string })[];
}

export function createProfileService(options: ProfileServiceOptions): ProfileService {
  const { stores, applier, runners } = options;
  const pushListeners = new Set<
    (results: readonly (RunnerProfileResult & { runnerId: string })[]) => void
  >();

  /**
   * 直列化の実体。**次の更新は前の更新の全段が終わってから始まる。**
   *
   * 前の失敗で列が止まらないように、常に解決する形で繋ぐ（失敗は呼び出し側へ
   * 返るので、列に残す必要は無い）。
   */
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 1行の変更の計画。`rows` は変更後の行の集合、`write` は正本へ書く操作。 */
  interface Plan {
    rows: EnvProfileEntry[];
    write: () => Promise<void>;
  }

  /**
   * **全ての更新（`set` / `remove` / `clearAll` / `apply`）が通る1本の列。**
   *
   * 順序は「前の集合を読む → 新しい集合から clone 用と runner 用を合成 → clone を
   * 評価（prepare）→ 正本へ書く → clone へ反映（commit）→ runner へ配布」で、
   * **どの段で落ちても旧版（行の集合ごと）で揃える**。
   *
   * 評価と反映を1つにしていた頃は、記憶ストアへの保存が落ちると「クローンだけが
   * 新しい本文を持つ」状態が残った。保存できていない ＝ 誰も成功と言っていない
   * 更新を、これから起こすクローンの子だけが使う、という一番たちの悪い分裂である
   * （しかも再起動するとストアの古い値へ戻る）。正本は記憶ストアで、クローンの器は
   * そこから導かれるもの、という向きに揃える:
   *
   * - 評価で落ちた: 保存も反映もしない
   * - 保存で落ちた: 用意したものを捨てる
   * - 反映で落ちた: 正本を書き戻す（戻せなければ、その事実を理由つきで投げる）
   *
   * 「失敗を返したのに、どこか1層だけ新版」を残さないことが要点である。残すと、
   * 次に runner が名乗った時点で `syncRunner` がそれを配り、分裂が黙って広がる。
   *
   * **clone に掛かる行が無くなった側へは空（＝外す）を効かせる。** 「触らない」に
   * すると、撒く先を狭めたとき、前の本文（鍵を含みうる）がその側に残り続ける。
   */
  async function transact(
    plan: (previous: EnvProfileEntry[]) => Plan,
  ): Promise<ApplyProfileResult> {
    // 途中で落ちたときに戻す先。**この列の中でしか更新は起きない**ので、
    // ここで読んだものが「直前の版」であることが保証されている。
    const previous = await stores.profile.list();
    const { rows, write } = plan(previous);
    const cloneScript = composeProfileScript(rows, 'clone');
    const runnerScript = composeProfileScript(rows, 'runner');
    const at = new Date().toISOString();

    const prepared: PreparedProfile | null =
      applier === undefined
        ? null
        : await applier.prepare(cloneScript).catch((error: unknown): PreparedProfile => ({
            ok: false,
            error: redactErrorText(String(error), process.env),
            commit: async () => undefined,
            discard: async () => undefined,
          }));

    // 呼び出し側へ返すのは「結果」だけ（`commit` / `discard` は器の都合）。
    const clone: ProfileApplyResult =
      prepared === null
        ? { ok: true }
        : {
            ok: prepared.ok,
            ...(prepared.profile === undefined ? {} : { profile: prepared.profile }),
            ...(prepared.error === undefined ? {} : { error: prepared.error }),
            ...(prepared.output === undefined ? {} : { output: prepared.output }),
            ...(prepared.names === undefined ? {} : { names: prepared.names }),
          };

    // 読めないものは保存も配布もしない（前のものが残る）。
    if (prepared !== null && !prepared.ok) {
      await prepared.discard();
      return { stored: false, clone, runners: [] };
    }

    try {
      await write();
    } catch (error) {
      // **正本へ書けなかったものは、クローンにも効かせない。** ここで捨てないと、
      // 呼び出し側が失敗を受け取ったのにクローンだけが新しい本文で走る。
      await prepared?.discard();
      // 途中まで書けているかもしれない（複数行にまたがる操作）。戻せるものは戻す。
      await stores.profile.replaceAll(previous).catch(() => undefined);
      throw error;
    }

    // ここから先は「保存できた」が確定している。器へ移す。
    try {
      await prepared?.commit();
    } catch (error) {
      /**
       * **正本を書き戻す。**
       *
       * ここで戻さないと、失敗を返したのに正本だけが新版という状態が残る。
       * しかもそれは黙って広がる — 次に runner が名乗れば `syncRunner` が
       * 正本を読んで新版を配るので、今度は「クローンだけ旧版」という別の
       * 分裂になる。デーモンを起こし直しても、器の不調が続いていれば収束しない。
       *
       * **戻す先は確定している。** 更新はこの列の中でしか起きないので、
       * 読んだときの集合が「直前の版」であることが保証されている。
       */
      await prepared?.discard();
      try {
        // **本文・撒く先・更新日時を組で戻す。** 通常の書き込みで戻すと本文は元に
        // 戻っても `updatedAt` が失敗した時刻へ進み、成功していない更新が「最後の
        // 変更」として `profile status` に出る（起動のたびに動いていたのと同じ壊れ方）。
        await stores.profile.replaceAll(previous);
      } catch (rollbackError) {
        // **黙って握り潰さない。** ここまで来ると正本＝新版・クローン＝旧版が
        // 残るので、人間が手で直せるように両方の理由を出す。
        // `cause` は直近で捕まえたもの（書き戻しの失敗）。反映の失敗は本文に
        // 残してあるので、どちらも失われない。
        throw new ProfileRollbackFailedError(
          'プロファイルをクローンへ反映できず、正本を書き戻すこともできなかった' +
            `（正本だけ新版のまま残っている）: 反映=${redactErrorText(String(error), process.env)} / 書き戻し=${redactErrorText(String(rollbackError), process.env)}`,
          { cause: rollbackError },
        );
      }
      throw new Error(
        `プロファイルをクローンへ反映できなかったので、正本も元へ戻した: ${redactErrorText(String(error), process.env)}`,
        { cause: error },
      );
    }

    const results = await pushAll(runnerScript);
    // 購読者（`ManagerPool`）の例外で、人間・クローンへの応答を落とさない。
    for (const listener of pushListeners) {
      try {
        listener(results);
      } catch {
        // 帳面に積めなかっただけで、配布の結果そのものは下で返す。
      }
    }

    const entries = await stores.profile.list();
    return {
      stored: true,
      updatedAt: at,
      entries,
      // **指紋は合成後の本文から直に取る。** 器の有無で出たり出なかったりすると、
      // 「届いているか」を突き合わせる手段が構成によって消える。
      composed: composedFingerprints(entries),
      clone,
      runners: results,
    };
  }

  function entryName(name: string): string {
    if (!PROFILE_ENTRY_NAME.test(name)) {
      throw new ProfileInputError(
        `プロファイルの行の名前の形が不正である（${PROFILE_ENTRY_NAME.source}）`,
      );
    }
    return name;
  }

  /** 全行を外す計画。 */
  const clearPlan = (): Plan => ({
    rows: [],
    write: async () => void (await stores.profile.clear()),
  });

  return {
    read: () => stores.profile.list(),

    set: (name, script, scope) =>
      serial(() => {
        entryName(name);
        // **入口で形を決める。** 保存・配布・指紋が同じ文字列を見ないと、置いた
        // 指紋と読んだ指紋が食い違い、届いているかを見る道具が嘘をつく。
        const normalized = normalizeProfileScript(script);
        if (normalized.length === 0) {
          throw new ProfileInputError('空の本文は行として置けない（外すなら remove / clearAll）');
        }
        return transact((previous) => {
          const existing = previous.find((entry) => entry.name === name);
          // **大文字小文字だけが違う名前は別の行として置かない。** 大文字小文字を区別しない
          // ファイルシステム（macOS）で fs 版の `<name>.sh` が同じファイルになり、片方が
          // 黙ってもう片方を上書きする。器によって挙動が変わらないよう、入口（ここ）で弾く。
          const clash = previous.find(
            (entry) => entry.name !== name && entry.name.toLowerCase() === name.toLowerCase(),
          );
          if (clash !== undefined) {
            throw new ProfileInputError(
              `大文字小文字だけが違う行 ${clash.name} が既にある（別の行としては置けない）`,
            );
          }
          // **省略は「既存を保つ」。**
          const resolved: EnvProfileScope = scope ?? existing?.scope ?? 'all';
          const row: EnvProfileEntry = {
            name,
            script: normalized,
            scope: resolved,
            updatedAt: new Date().toISOString(),
          };
          return {
            rows: [...previous.filter((entry) => entry.name !== name), row],
            write: async () => void (await stores.profile.set(name, normalized, resolved)),
          };
        });
      }),

    remove: (name) =>
      serial(async () => {
        entryName(name);
        let removed = false;
        const result = await transact((previous) => {
          removed = previous.some((entry) => entry.name === name);
          return {
            rows: previous.filter((entry) => entry.name !== name),
            write: async () => void (await stores.profile.remove(name)),
          };
        });
        return { ...result, removed };
      }),

    clearAll: () => serial(() => transact(clearPlan)),

    apply: (script: string) =>
      serial(() => {
        const normalized = normalizeProfileScript(script);
        if (normalized.length === 0) return transact(clearPlan);
        return transact(() => ({
          rows: [
            {
              name: 'default',
              script: normalized,
              scope: 'all',
              updatedAt: new Date().toISOString(),
            },
          ],
          write: async () => {
            await stores.profile.clear();
            await stores.profile.set('default', normalized, 'all');
          },
        }));
      }),

    restore: () =>
      serial(async () => {
        const entries = await stores.profile.list();
        if (applier === undefined) return null;
        const script = composeProfileScript(entries, 'clone');
        if (script.length === 0 && entries.length === 0) return null;
        // 記憶ストアには書かない（`updatedAt` は本文を変えた人のものである）。
        // クローンに掛かる行が無いときは空を効かせる（外す）。
        return applier.apply(script);
      }),

    onPushed: (listener) => {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },

    syncRunner: (runner: RunnerClient) =>
      serial(async () => {
        // **runner に掛かる行が無ければ、降ろすのは空である**（外す向き）。
        const script = composeProfileScript(await stores.profile.list(), 'runner');

        // 既に同じものが載っていれば触らない。指紋が**読めなかった**ときは「差がある」に
        // 倒す（降ろす）。
        //
        // **「読めなかった」を `undefined`（何も載っていない）に潰さない（#2508）。**
        // 潰すと `script` が空（外した）のとき「一致」になり、外したはずのプロファイル
        // （鍵を含みうる）が runner に残り続ける。空を降ろすのは外す向きなので安全側である。
        let unreadable = false;
        let current: RunnerProfileFingerprint | undefined;
        try {
          current = await runner.profile();
        } catch {
          unreadable = true;
        }
        const same =
          script.length === 0 ? current === undefined : current?.sha256 === fingerprintOf(script);
        if (!unreadable && same) return null;

        return runner.setProfile(script);
      }),
  };

  async function pushAll(script: string): Promise<(RunnerProfileResult & { runnerId: string })[]> {
    if (runners === undefined) return [];
    return Promise.all(
      (await runners.list()).map(async (runner) => {
        try {
          return { runnerId: runner.runnerId, ...(await runner.setProfile(script)) };
        } catch (error) {
          return { runnerId: runner.runnerId, ok: false, error: reasonOf(error) };
        }
      }),
    );
  }
}
