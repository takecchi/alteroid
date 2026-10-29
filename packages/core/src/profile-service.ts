import { createHash } from 'node:crypto';

import { fingerprintOf } from './credentials.js';
import { redactErrorText } from './denial-input-head.js';
import { reasonOf } from './dropped-record.js';
import {
  normalizeProfileScript,
  type PreparedProfile,
  type ProfileApplier,
  type ProfileApplyResult,
  redactProfileFailure,
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

/** 判定をここ1か所に寄せるのは、別々に判定すると食い違い、外したはずの側に本文が残るから。 */
export function profileScopeAppliesTo(
  scope: EnvProfileScope | undefined,
  target: 'clone' | 'runner',
): boolean {
  const normalized = scope ?? 'all';
  if (normalized === 'all') return true;
  return normalized === 'app' ? target === 'clone' : target === 'runner';
}

export type ProfileComposeTarget = 'clone' | 'runner' | 'all';

/**
 * 見出しは入れない: 1行だけのとき合成が元の本文とバイトまで一致し、アップグレードで指紋が変わらない。
 * 掛かる行が0なら `''` を降ろす（「何もしない」にすると撒く先を狭めた側に本文が残る）。
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

/**
 * 本文が宣言する環境変数の名前を、評価せずに行から拾う（`export NAME=` / `export NAME` / `NAME=`）。
 * 評価しない: runner の環境を持たないデーモンが他人の本文を走らせると、副作用と鍵の露出が増えるため。
 * 拾えないものがある（`eval`・条件分岐の中・間接参照）: 警告の判定に使うだけで、置く・弾く判断には使わない。
 */
export function declaredProfileEnvNames(script: string): string[] {
  const names = new Set<string>();
  for (const line of script.split('\n')) {
    const code = line.replace(/(^|\s)#.*$/, '').trim();
    if (code.length === 0) continue;
    for (const segment of code.split(/[;&|]+/)) {
      const words = segment.trim().split(/\s+/);
      const isExport = words[0] === 'export' || words[0] === 'declare' || words[0] === 'typeset';
      for (const word of isExport ? words.slice(1) : words.slice(0, 1)) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)(=|$)/.exec(word);
        // 代入のない単語は export の後ろだけ名前に数える: 先頭の `ls` のようなコマンド名を拾わないため。
        if (match !== null && (isExport || match[2] === '=')) names.add(match[1] as string);
      }
    }
  }
  return [...names].sort();
}

/** runner へ渡る行（scope が `runner` / `all`）が宣言する名前。 */
export function runnerDeclaredEnvNames(entries: readonly EnvProfileEntry[]): string[] {
  return declaredProfileEnvNames(composeProfileScript(entries, 'runner'));
}

export interface ComposedFingerprint {
  sha256?: string;
  bytes?: number;
}

function fingerprintOfComposed(script: string): ComposedFingerprint {
  return script.length === 0
    ? {}
    : { sha256: fingerprintOf(script), bytes: Buffer.byteLength(script) };
}

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
 * 更新（クローンの器へ commit・記憶ストアへ保存・各 runner へ配布）を直列化する:
 * 同時に2つ入ると層ごとに違う本文が残り、どちらも成功を返すのに環境が割れる。
 * `syncRunner` も同じ列を通す: 更新の最中に走ると古い本文で新しい本文を上書きする。
 */
export interface ProfileService {
  read(): Promise<EnvProfileEntry[]>;
  /** `scope` を省略すると既存行の撒く先を保つ（本文だけ直して撒く先が `all` へ戻るのを避ける）。 */
  set(
    name: string,
    script: string,
    scope?: EnvProfileScope,
    options?: ProfileWriteOptions,
  ): Promise<ApplyProfileResult>;
  remove(
    name: string,
    options?: ProfileWriteOptions,
  ): Promise<ApplyProfileResult & { removed: boolean }>;
  clearAll(): Promise<ApplyProfileResult>;
  apply(script: string): Promise<ApplyProfileResult>;
  /** 記憶ストアへは書かない: 書くと `updatedAt` が最後にデーモンを起こした時刻になる。 */
  restore(): Promise<ProfileApplyResult | null>;
  syncRunner(runner: RunnerClient): Promise<RunnerProfileResult | null>;
  /** 即時の配布は `ManagerPool` の押し込みの帳面と挑み直しを通らないので、ここを購読して同じ帳面に積む。 */
  onPushed?(
    listener: (results: readonly (RunnerProfileResult & { runnerId: string })[]) => void,
  ): () => void;
}

/** 呼び出し側は文言ではなくこの型で見分け、利用者の誤りとして返す（500 にしない）。 */
export class ProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileInputError';
  }
}

/** 呼び出し側は文言ではなく `instanceof` で見分け、日誌の決定を状態どおりに書き換える。 */
export class ProfileRollbackFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProfileRollbackFailedError';
  }
}

/**
 * プロファイルの1行の版（`GET /profile` の各行の `version`。書き込みの `ifMatch` で前提にする）。
 * 本文と撒く先から作る: 撒く先だけを変えるのも更新である（外れる側が出る）。`updatedAt` は含めない（巻き戻しで戻せる監査情報のため）。
 */
export function profileEntryVersionOf(entry: Pick<EnvProfileEntry, 'script' | 'scope'>): string {
  return createHash('sha256')
    .update(JSON.stringify([entry.script, entry.scope]), 'utf8')
    .digest('hex');
}

/**
 * 書き込みの `ifMatch` がいまの行と食い違った（読んだ後に変わった・作られた・消された）。何も変えていない。
 * `current` はいまの行（無ければ `null`）。message には本文を載せない（鍵が入りうる）。
 */
export class ProfileVersionMismatchError extends Error {
  readonly current: EnvProfileEntry | null;
  constructor(name: string, current: EnvProfileEntry | null) {
    super(
      current === null
        ? `プロファイルの行 ${name} は読んだ後に消されている（変えていない）`
        : `プロファイルの行 ${name} は読んだ後に変わっている・作られている（変えていない）`,
    );
    this.name = 'ProfileVersionMismatchError';
    this.current = current;
  }
}

/**
 * 書き込みの前提にする版。`string` はその版の行が在ること、`null` は行が無いこと（無いときだけ作る）。
 * 省けば今までどおり比べない。比べるのは更新の列（`serial`）の中: 列の外で比べると、比べてから書くまでに別の書き手が入れる。
 */
export interface ProfileWriteOptions {
  ifMatch?: string | null;
}

function assertProfileVersion(
  name: string,
  previous: readonly EnvProfileEntry[],
  ifMatch: string | null | undefined,
): void {
  if (ifMatch === undefined) return;
  const current = previous.find((entry) => entry.name === name) ?? null;
  const matches =
    ifMatch === null
      ? current === null
      : current !== null && profileEntryVersionOf(current) === ifMatch;
  if (!matches) throw new ProfileVersionMismatchError(name, current);
}

export interface ProfileServiceOptions {
  stores: Stores;
  applier?: ProfileApplier;
  runners?: RunnerRegistry;
}

export interface ApplyProfileResult {
  stored: boolean;
  updatedAt?: string;
  entries?: EnvProfileEntry[];
  composed?: { clone: ComposedFingerprint; runner: ComposedFingerprint };
  clone: ProfileApplyResult;
  runners: (RunnerProfileResult & { runnerId: string })[];
}

export function createProfileService(options: ProfileServiceOptions): ProfileService {
  const { stores, applier, runners } = options;
  const pushListeners = new Set<
    (results: readonly (RunnerProfileResult & { runnerId: string })[]) => void
  >();

  // 前の失敗で列が止まらないように、常に解決する形で繋ぐ。
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work, work);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  interface Plan {
    rows: EnvProfileEntry[];
    write: () => Promise<void>;
  }

  /**
   * どの段で落ちても旧版で揃える: 失敗を返したのに1層だけ新版が残ると、次に runner が
   * 名乗った時点で `syncRunner` がそれを配り、分裂が黙って広がる。
   * clone に掛かる行が無い側へは空を効かせる: 「触らない」だと前の本文（鍵を含みうる）が残る。
   */
  async function transact(
    plan: (previous: EnvProfileEntry[]) => Plan,
  ): Promise<ApplyProfileResult> {
    // 更新はこの列の中でしか起きないので、ここで読んだものが直前の版である。
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

    if (prepared !== null && !prepared.ok) {
      await prepared.discard();
      return { stored: false, clone, runners: [] };
    }

    try {
      await write();
    } catch (error) {
      // 正本へ書けなかったものをクローンに効かせると、失敗を返したのにクローンだけ新しい本文で走る。
      await prepared?.discard();
      await stores.profile.replaceAll(previous).catch(() => undefined);
      throw error;
    }

    try {
      await prepared?.commit();
    } catch (error) {
      // 戻さないと、失敗を返したのに正本だけ新版が残り、次の `syncRunner` で runner へ配られる。
      await prepared?.discard();
      try {
        // 通常の書き込みで戻すと `updatedAt` が失敗した時刻へ進み、成功していない更新が最後の変更に見える。
        await stores.profile.replaceAll(previous);
      } catch (rollbackError) {
        // 正本=新版・クローン=旧版が残るので、人間が直せるよう両方の理由を出す。`cause` は書き戻しの失敗。
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
    for (const listener of pushListeners) {
      try {
        listener(results);
      } catch {
        // 購読者の例外で応答を落とさない。
      }
    }

    const entries = await stores.profile.list();
    return {
      stored: true,
      updatedAt: at,
      entries,
      // 指紋は合成後の本文から直に取る: 器の有無で出たり消えたりすると突き合わせる手段が構成によって消える。
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

  const clearPlan = (): Plan => ({
    rows: [],
    write: async () => void (await stores.profile.clear()),
  });

  return {
    read: () => stores.profile.list(),

    set: (name, script, scope, writeOptions) =>
      serial(() => {
        entryName(name);
        // 保存・配布・指紋が同じ文字列を見ないと、置いた指紋と読んだ指紋が食い違う。
        const normalized = normalizeProfileScript(script);
        if (normalized.length === 0) {
          throw new ProfileInputError('空の本文は行として置けない（外すなら remove / clearAll）');
        }
        return transact((previous) => {
          assertProfileVersion(name, previous, writeOptions?.ifMatch);
          const existing = previous.find((entry) => entry.name === name);
          // 大文字小文字を区別しないファイルシステム（macOS）で fs 版の `<name>.sh` が同じファイルになり、片方が黙ってもう片方を上書きする。
          const clash = previous.find(
            (entry) => entry.name !== name && entry.name.toLowerCase() === name.toLowerCase(),
          );
          if (clash !== undefined) {
            throw new ProfileInputError(
              `大文字小文字だけが違う行 ${clash.name} が既にある（別の行としては置けない）`,
            );
          }
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

    remove: (name, writeOptions) =>
      serial(async () => {
        entryName(name);
        let removed = false;
        const result = await transact((previous) => {
          assertProfileVersion(name, previous, writeOptions?.ifMatch);
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
        return applier.apply(script);
      }),

    onPushed: (listener) => {
      pushListeners.add(listener);
      return () => pushListeners.delete(listener);
    },

    syncRunner: (runner: RunnerClient) =>
      serial(async () => {
        const script = composeProfileScript(await stores.profile.list(), 'runner');

        // 「読めなかった」を `undefined`（何も載っていない）に潰さない: 潰すと `script` が空のとき
        // 「一致」になり、外したはずのプロファイル（鍵を含みうる）が runner に残り続ける。
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

        return redactRunnerResult(await runner.setProfile(script));
      }),
  };

  async function pushAll(script: string): Promise<(RunnerProfileResult & { runnerId: string })[]> {
    if (runners === undefined) return [];
    return Promise.all(
      (await runners.list()).map(async (runner) => {
        try {
          return {
            runnerId: runner.runnerId,
            ...redactRunnerResult(await runner.setProfile(script)),
          };
        } catch (error) {
          return redactRunnerResult({
            runnerId: runner.runnerId,
            ok: false,
            error: reasonOf(error),
          });
        }
      }),
    );
  }
}

/**
 * runner の結果も、クローンの結果と同じく出口で伏せる: runner は別の器で、入口の伏せ字に頼ると
 * 差し替えた器の出力が素通りするため（`redactProfileFailure` の注記と同じ理由）。無い欄は足さない。
 */
function redactRunnerResult<T extends { error?: string | undefined; output?: string | undefined }>(
  result: T,
): T {
  const redacted = redactProfileFailure(result, process.env);
  return {
    ...result,
    ...(result.error === undefined ? {} : { error: redacted.error }),
    ...(result.output === undefined ? {} : { output: redacted.output }),
  };
}
