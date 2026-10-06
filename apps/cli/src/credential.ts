import { stdin, stdout } from 'node:process';

import { CREDENTIAL_NAME } from '@alteroid/core/cli-light';
import { hasRunnerPushFailure } from '@alteroid/logic';

import { describeAuthFailure, forbiddenKindOf, resolveTarget, type Target } from './target.js';
import { confirmIrreversible, type ConfirmIo } from './confirm.js';
import { redactError } from './redact.js';
import { readInputFile } from './input-errors.js';

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
  /** 撒く先。'all'=共通(既定) / 'app'=clone だけ / 'runner'=manager だけ。 */
  scope: 'all' | 'app' | 'runner';
  /** シークレット可否。`false` の行だけ `value` が併走する。 */
  secret: boolean;
  /** `secret === false` の行だけ載る。 */
  value?: string;
}

interface CredentialsView {
  credentials: CredentialFingerprint[];
}

interface CredentialsUpdateView {
  credentials: CredentialFingerprint[];
  runners: { runnerId: string; ok: boolean; error?: string }[];
}

/** 撒く先の言い方。`profile.ts` も同じものを使う（環境変数と1文字違わず揃えるため）。 */
export function describeScope(scope: 'all' | 'app' | 'runner'): string {
  switch (scope) {
    case 'all':
      return 'all（共通）';
    case 'app':
      return 'app（clone だけ）';
    case 'runner':
      return 'runner（manager だけ）';
    default:
      // **送られてくる値である。** CLI とデーモンは別々に配られうるので、
      // 古い CLI が新しいデーモンの値を知らないことがある——投げずに
      // 「未知」とそのまま出す（`apps/web` の `describeUnknown` と同じ判断）。
      return `未知の撒く先（${String(scope)}）`;
  }
}

export async function credentialListCommand(): Promise<void> {
  const target = await resolveTarget();
  const view = (await request(target, '/credentials')) as CredentialsView;

  if (view.credentials.length === 0) {
    stdout.write('正本に置かれた環境変数はありません。\n');
    stdout.write(
      '**この状態では、マネージャーへ配られる環境変数はありません。**\n' +
        '（デーモンの器の環境変数も、runner の環境変数も配られません。正本が唯一の出所です。\n' +
        '　既存の器の GH_TOKEN などは、起動時に1度だけ正本へ移されています）\n',
    );
    stdout.write('置くには: alteroid credential set <名前> --file <path>\n');
    return;
  }

  stdout.write('\n');
  for (const entry of view.credentials) {
    stdout.write(`${entry.name}\n`);
    stdout.write(
      `  撒く先=${describeScope(entry.scope)} / ` +
        `${entry.secret ? 'シークレット' : '非シークレット'} / 更新 ${entry.updatedAt}\n`,
    );
    // **`secret === false` の行だけ値が載る。** シークレットの行は指紋だけ。
    stdout.write(
      entry.secret
        ? `  指紋 sha256=${entry.sha256}\n`
        : `  値=${entry.value ?? '（サーバがまだ値を返していない版）'}\n`,
    );
  }
  stdout.write('\n');
  // **「置いた」と「届いた」は別である。** 正本に在ることは、走っている runner の
  // 器に在ることを意味しない（配れなかった台は次の名乗りで追いつく）。
  stdout.write(
    '届いているかは runner 側の指紋と突き合わせます: alteroid runners\n' +
      '（値はどちらにも出ません。指紋が一致していれば同じものです）\n',
  );
}

export async function credentialSetCommand(
  name: string,
  options: { file?: string; scope?: string; secret?: boolean; yes?: boolean },
  io?: ConfirmIo,
): Promise<void> {
  if (
    options.scope !== undefined &&
    options.scope !== 'all' &&
    options.scope !== 'app' &&
    options.scope !== 'runner'
  ) {
    throw new Error(
      `--scope は all / app / runner のいずれかである（渡されたのは ${options.scope}）`,
    );
  }

  // 名前の形を、値を読む前に見る（空の標準入力で「値が空」とだけ言われて、本当の誤りが隠れない）。
  if (!CREDENTIAL_NAME.test(name)) {
    throw new Error(
      `名前 <name> は英大文字で始まり、英大文字・数字・_ だけで書く（渡されたのは ${name}。例: GH_TOKEN）`,
    );
  }

  // **既に在る名前を置き換えるときだけ確認する**（Issue #3201。`confirm.ts`）。在るかは
  // `GET /credentials`（名前と指紋の一覧。`credential list` / `remove` と同じ口）で見る。
  // **値は読まず、確認の文にも出さない。** 確認は入力を読む前に出す（標準入力を読み切ると、
  // 端末の `yes` を聞けない）。
  const target = await resolveTarget();
  const current = (await request(target, '/credentials')) as CredentialsView;
  if (current.credentials.some((entry) => entry.name === name)) {
    await confirmIrreversible(
      `環境変数 ${name} を置き換えます。前の値は残らず、読み出せないので戻すには元の値が要ります（runner の器の値も入れ替わります）。`,
      options,
      io,
    );
  }

  const raw =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readInputFile(options.file, '--file', '--file <path>、または標準入力（-）');
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

  const view = (await put(target, [
    {
      name,
      value,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.secret === undefined ? {} : { secret: options.secret }),
    },
  ])) as CredentialsUpdateView;
  stdout.write(
    hasRunnerPushFailure(view)
      ? `警告: ${name} は正本に置きましたが、一部の runner へ反映できていません。\n`
      : `${name} を置きました。\n`,
  );
  reportRunners(view);
  failOnPartialPush(view);
}

/**
 * 環境変数を1つ外す。**戻せない操作なので確認する**（Issue #3141。`confirm.ts`）。値は
 * `credential list` にも出ず（指紋だけ）、外すと正本から消える。戻すには元の値が要る。
 */
export async function credentialRemoveCommand(
  name: string,
  options: { yes?: boolean } = {},
): Promise<void> {
  const target = await resolveTarget();
  const current = (await request(target, '/credentials')) as CredentialsView;
  if (!current.credentials.some((entry) => entry.name === name)) {
    // 無い名前は例外にする（#3449。`token remove` と同じ）。打ち間違いを成功と同じ
    // 終わり方にしない。
    // **器の環境変数の側は消えない。** ここで黙ると、「外したのにマネージャーが
    // まだ持っている」理由が人間には分からないので、例外の文に入れる。
    throw new Error(
      `${name} は正本に置かれていません。\n` +
        'なおデーモン（クローン）の環境変数に同じ名前が在れば、そちらが配られます' +
        '（この口が持つのは正本の側だけです）。',
    );
  }

  await confirmIrreversible(
    `環境変数 ${name} を外します。値は読み出せないので、戻すには元の値が要ります（runner の器からも消えます）。`,
    options,
  );

  // 空文字が「外す」である（`PUT /credentials` の doc）。
  const view = (await put(target, [{ name, value: '' }])) as CredentialsUpdateView;
  stdout.write(
    hasRunnerPushFailure(view)
      ? `警告: ${name} は正本から外しましたが、一部の runner へ反映できていません。\n`
      : `${name} を外しました。\n`,
  );
  reportRunners(view);
  failOnPartialPush(view);
}

/**
 * 一部の runner へ反映できていなければ、見出しと台ごとの結果を出した**後で**例外にする
 * （`index.ts` が stderr へ出して終了コード 1。正本への保存は済んでいる）。
 */
function failOnPartialPush(view: CredentialsUpdateView): void {
  if (!hasRunnerPushFailure(view)) return;
  throw new Error(
    'runner への反映が一部失敗しました（正本への保存は済んでいます。失敗した runner へは次に名乗ったときに降ろし直します）',
  );
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
        : `  ${runner.runnerId}: 降ろせませんでした（次に名乗ったときに追いつきます）: ${runner.error === undefined ? '理由不明' : redactError(runner.error)}\n`,
    );
  }
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function put(
  target: Target,
  credentials: { name: string; value: string; scope?: string; secret?: boolean }[],
) {
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
       * **`PUT /credentials` は宣言済み owner だけである**（`requireOwner`。任意の
       * 名前で任意の値を、これから起こすマネージャーの環境へ永続的に置ける口
       * だから）。
       *
       * **⚠️ 2026-09-18、`requireOwner`（issue #1198。本来の形）へ置き換えた。**
       * 2026-09-17〜18 の間は「持ち主が端末から直に許可したアカウント」
       * （`grantedBy === 'operator'`）の近似（issue #1195）で通していたが、いまは
       * `ownerDeclaredAt` の宣言を見る——立てるのは `alteroid access owner <id>`
       * （`POST /access/:accountId/owner`。`requireOperator` で非伝播）。
       *
       * **この経路の門は `requireOwner` であって `requireOperator` ではない**
       * （`apps/daemon/src/app.ts` の配線）ので、この 403 が `not_operator` の
       * 本文で返ることは無い——`authenticate` を通った時点で principal は
       * operator か許可済みアカウントのどちらかであり、operator なら
       * `requireOwner` は常に通す。それでも `forbiddenKindOf` の判定はデーモンの
       * 応答だけを見て機械的に行い、ここで「来ないはず」を前提に分岐を省略しない
       * ——来た場合は `unknown` と同じ扱いにして、当てずっぽうの案内を出さない。
       *
       * **403 は「未宣言」以外の理由でも返る**（ログイン済みだが未 grant。
       * `authenticate` の側）。本文を見ずに固定の文言を出すと、`access grant`
       * で直る人へ「`access owner` を打て」と案内してしまう
       * （`apps/cli/src/token.ts` の同じ分岐と同じ理由）。
       */
      const body = await response.json().catch(() => ({}));
      const kind = forbiddenKindOf(body);
      if (kind === 'not_declared_owner') {
        throw new Error(
          describeAuthFailure(403, target, kind) ??
            '実行環境の持ち主として宣言されたアカウントだけが操作できます。',
        );
      }
      if (kind === 'not_granted') {
        throw new Error(
          describeAuthFailure(403, target, kind) ??
            'このアカウントには alteroid を使う許可がありません。',
        );
      }
      // `not_operator`（この経路では実際には来ない）と `unknown` は、どちらの
      // 手順で直るか判別できない場合として同じに扱う。当てずっぽうを出さずに
      // 止める（`target.ts` の `ForbiddenKind` の doc）。
      throw new Error(
        'マネージャーへ降ろす環境変数へのアクセスが拒否されました（403）。' +
          '理由を判別できなかったため、次にすべきことは案内しません。',
      );
    }
    const described = describeAuthFailure(response.status, target);
    if (described !== null) throw new Error(described);
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (typeof body.error === 'string') throw new Error(redactError(body.error));
    throw new Error(`${path} が失敗しました (${String(response.status)})`);
  }
  return response.json();
}
