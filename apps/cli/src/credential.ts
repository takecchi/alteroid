import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';

import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';

/**
 * `alteroid credential` — マネージャーへ降ろす環境変数（名前→値の袋）。
 *
 * **器（`compose.yaml` の環境変数）を焼き直す代わりの口である。** 用途が増える
 * たびに環境変数を足していくと、「環境を直す」と「走行中の仕事を失う」が同じ
 * 操作になる（AGENTS.md 地雷表）。ここへ置いたものは記憶ストアが正本で、runner が
 * 名乗り直すたびに降り直す ＝ 器を作り直しても痩せない。
 *
 * **値は引数で渡せない。** `argv` は同じ器の他のプロセスから見える（`ps` 等）ので、
 * 秘密をそこへ置かない（`alteroid token add` と同じ作法）。ファイルか標準入力から
 * だけ受ける。
 *
 * **実行環境プロファイル（`alteroid profile`）との使い分け:**
 *
 * | | こちら | プロファイル |
 * | --- | --- | --- |
 * | 形 | 名前→値 | シェルスクリプト1本 |
 * | 走行中の `gh` / `git` | **届く**（器がファイルを持ち、道具が読み直す） | 届かない |
 * | 読み出し | 指紋だけ | 本文ごと返る |
 * | 向き | 秘密・身元 | `PATH`・`eval $(...)`・分岐 |
 */

interface CredentialFingerprint {
  name: string;
  /** sha256（16進）の先頭12桁。**値は返らない。** */
  sha256: string;
  updatedAt: string;
}

interface CredentialsView {
  credentials: CredentialFingerprint[];
}

interface CredentialsUpdateView {
  credentials: CredentialFingerprint[];
  runners: { runnerId: string; ok: boolean; error?: string }[];
}

export async function credentialListCommand(): Promise<void> {
  const target = await resolveTarget();
  const view = (await request(target, '/credentials')) as CredentialsView;

  if (view.credentials.length === 0) {
    stdout.write('正本に置かれた環境変数はありません。\n');
    stdout.write(
      '**この状態では、マネージャーは器の環境変数に在るものだけで走ります**' +
        '（`compose.yaml` の x-shared-env / Railway の Shared Variables）。\n',
    );
    stdout.write('置くには: alteroid credential set <名前> --file <path>\n');
    return;
  }

  stdout.write('\n');
  for (const entry of view.credentials) {
    stdout.write(`${entry.name}\n`);
    stdout.write(`  指紋 sha256=${entry.sha256} / 更新 ${entry.updatedAt}\n`);
  }
  stdout.write('\n');
  // **「置いた」と「届いた」は別である。** 正本に在ることは、走っている runner の
  // 器に在ることを意味しない（配れなかった台は次の名乗りで追いつく）。
  stdout.write(
    '届いているかは runner 側の指紋と突き合わせます: alteroid runners\n' +
      '（値はどちらにも出ません。指紋が一致していれば同じものです）\n',
  );
}

export async function credentialSetCommand(name: string, options: { file?: string }): Promise<void> {
  const raw =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readFile(options.file, 'utf8');
  /**
   * **末尾の改行だけを落とす。** `echo` やエディタが必ず足すので、そのまま置くと
   * 「見た目は同じなのに指紋が違う」鍵ができる。
   *
   * **内側の空白は落とさない**（`trim()` を使わない）——値の一部でありうる。
   * `alteroid token add` は `trim()` しているが、あちらが受けるのは1種類の
   * トークンだけで、ここは任意の値を受ける口である。
   */
  const value = raw.replace(/\r?\n$/, '');
  if (value.length === 0) {
    throw new Error(
      '値が空である（ファイルか標準入力から、空でない値を渡す）。' +
        `外すなら: alteroid credential remove ${name}`,
    );
  }

  const target = await resolveTarget();
  const view = (await put(target, [{ name, value }])) as CredentialsUpdateView;
  stdout.write(`${name} を置きました。\n`);
  reportRunners(view);
}

export async function credentialRemoveCommand(name: string): Promise<void> {
  const target = await resolveTarget();
  const current = (await request(target, '/credentials')) as CredentialsView;
  if (!current.credentials.some((entry) => entry.name === name)) {
    stdout.write(`${name} は正本に置かれていません。\n`);
    // **器の環境変数の側は消えない。** ここで黙ると、「外したのにマネージャーが
    // まだ持っている」理由が人間には分からない。
    stdout.write(
      'なお器の環境変数に同じ名前が在れば、マネージャーはそれで走り続けます' +
        '（この口が持つのは正本の側だけです）。\n',
    );
    return;
  }

  // 空文字が「外す」である（`PUT /credentials` の doc）。
  const view = (await put(target, [{ name, value: '' }])) as CredentialsUpdateView;
  stdout.write(`${name} を外しました。\n`);
  reportRunners(view);
}

/** 配布の結果を台ごとに出す。**畳んで1つの成否にしない。** */
function reportRunners(view: CredentialsUpdateView): void {
  if (view.runners.length === 0) {
    stdout.write('（runner が1台も繋がっていないので、配布はしていません。正本には在ります）\n');
    return;
  }
  for (const runner of view.runners) {
    stdout.write(
      runner.ok
        ? `  ${runner.runnerId}: 降ろしました\n`
        : `  ${runner.runnerId}: 降ろせませんでした（次に名乗ったときに追いつきます）: ${runner.error ?? '理由不明'}\n`,
    );
  }
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function put(target: Target, credentials: { name: string; value: string }[]) {
  return request(target, '/credentials', {
    method: 'PUT',
    body: JSON.stringify({ credentials }),
  });
}

async function request(target: Target, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: { ...target.headers, 'content-type': 'application/json' },
  });

  if (!response.ok) {
    if (response.status === 403) {
      /**
       * **`PUT /credentials` は実行環境の持ち主だけである**（`PUT /profile` と
       * 同じ強さ。任意の名前で任意の値を、これから起こすマネージャーの環境へ
       * 永続的に置ける口だから）。
       *
       * **403 は「持ち主でない」以外の理由でも返る**（ログイン済みだが未 grant）。
       * 本文を見ずに固定の文言を出すと、`access grant` で直る人へ「器の中で
       * 実行しろ」と案内してしまう（`apps/cli/src/token.ts` の同じ分岐と同じ
       * 理由）。
       */
      const body = await response.json().catch(() => ({}));
      const kind = forbiddenKindOf(body);
      if (kind === 'not_operator') {
        throw new Error(
          'マネージャーへ降ろす環境変数を置けるのは、その実行環境の持ち主だけです。\n' +
            'デーモンが動いているのと同じ環境で実行してください:\n' +
            '  docker compose exec app alteroid credential list\n',
        );
      }
      if (kind === 'not_granted') {
        throw new Error(
          describeAuthFailure(403, target) ??
            'このアカウントには alteroid を使う許可がありません。',
        );
      }
      // **どちらの理由か判別できない。** 「器の中で実行しろ」と「access grant
      // しろ」は解決策が正反対なので、当てずっぽうを出さずに止める。
      throw new Error(
        'マネージャーへ降ろす環境変数へのアクセスが拒否されました（403）。' +
          '理由を判別できなかったため、次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (typeof body.error === 'string') throw new Error(body.error);
    throw new Error(`${path} が失敗しました (${String(response.status)})`);
  }
  return response.json();
}
