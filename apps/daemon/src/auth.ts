import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

/**
 * デーモンの API の本人確認。
 *
 * **これは「何を許すか」の表ではない。** 誰がこのクローンの持ち主かを確かめる
 * だけで、通った先で何ができるかには一切触らない（クローンの権限境界は記憶を
 * 根拠にした判断のままである — PRD「権限境界」）。north_star 禁止2 が禁じている
 * のは能力の削除であって、器の入口を守ることではない。
 *
 * **鍵が無ければ何も要求しない。** `alteroid init` → `alteroid chat` が動く
 * ローカルの体験を、公開したい人の都合で壊さない。要るのは外へ出すときだけで、
 * そのときは開ける側が明示的に置く。
 *
 * 鍵はファイルでも渡せる。**環境変数だけにすると、走っているプロセスに差し替えが
 * 届かない**（runner の `GH_TOKEN` でまさにそれを踏んだ — `credentials.ts`）。
 * ファイルなら、デーモンを作り直さずに鍵を回せる＝走行中の仕事を殺さずに、
 * 失くした端末を締め出せる。
 */

/** 複数持てる。端末ごとに配れば、1本を失くしても残りを巻き込まずに消せる。 */
export interface ApiAuth {
  /** 1本でも鍵があるか（無ければ本人確認そのものをしない）。 */
  enabled(): Promise<boolean>;
  /** この文字列が配った鍵のどれかと一致するか。 */
  accepts(candidate: string): Promise<boolean>;
}

export interface ApiAuthOptions {
  /** 環境変数から来る鍵（カンマ区切りで複数）。器を作り直すまで凍る。 */
  tokens?: string;
  /**
   * 鍵を置いたファイル（1行1本）。**呼ばれるたびに読み直す**ので、
   * デーモンを止めずに鍵を回せる。
   */
  file?: string;
}

export function createApiAuth(options: ApiAuthOptions = {}): ApiAuth {
  return new Auth(options);
}

/** 環境から組み立てる（既定の配線）。 */
export function apiAuthFromEnv(env: NodeJS.ProcessEnv = process.env): ApiAuth {
  return createApiAuth({
    ...(env.ALTEROID_API_TOKEN === undefined ? {} : { tokens: env.ALTEROID_API_TOKEN }),
    ...(env.ALTEROID_API_TOKEN_FILE === undefined ? {} : { file: env.ALTEROID_API_TOKEN_FILE }),
  });
}

function split(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

class Auth implements ApiAuth {
  readonly #static: string[];
  readonly #file: string | undefined;
  /** ファイルの読み直しは mtime が動いたときだけ（毎回 I/O を叩かない）。 */
  #cache: { mtimeMs: number; tokens: string[] } | null = null;

  constructor(options: ApiAuthOptions) {
    this.#static = options.tokens === undefined ? [] : split(options.tokens);
    this.#file = options.file;
  }

  /**
   * **「鍵が配られているか」ではなく「守ると決められているか」を返す。**
   *
   * ファイルを指しているのに読めないとき、鍵の本数で判定すると「鍵が無い＝
   * 本人確認をしない」に落ちて、置いたつもりの守りが黙って全開になる。守ると
   * 決めた事実（鍵か置き場のどちらかが指定されていること）で判定し、読めない
   * ときは通さない側へ倒す。
   */
  async enabled(): Promise<boolean> {
    if (this.#file !== undefined) return true;
    return this.#static.length > 0;
  }

  /**
   * 一致の判定は定数時間で行い、**候補が何本あっても早く抜けない**。
   * 先に一致した本数から鍵の並びが漏れないようにするため。
   */
  async accepts(candidate: string): Promise<boolean> {
    const tokens = await this.#tokens();
    if (tokens.length === 0) return false;
    const given = digest(candidate);
    let matched = false;
    for (const token of tokens) {
      if (timingSafeEqual(given, digest(token))) matched = true;
    }
    return matched;
  }

  async #tokens(): Promise<string[]> {
    const fromFile = await this.#fromFile();
    return [...this.#static, ...fromFile];
  }

  async #fromFile(): Promise<string[]> {
    const path = this.#file;
    if (path === undefined) return [];
    try {
      const { mtimeMs } = await stat(path);
      if (this.#cache !== null && this.#cache.mtimeMs === mtimeMs) return this.#cache.tokens;
      const tokens = split(await readFile(path, 'utf8'));
      this.#cache = { mtimeMs, tokens };
      return tokens;
    } catch {
      // 読めないファイルを指されたら「鍵が無い」と同じに扱う。**ここで通さない。**
      // 置いたつもりの鍵が読めていないときに素通りさせるほうが危ない。
      this.#cache = null;
      return [];
    }
  }
}
