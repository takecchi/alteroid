import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';

import { createClient, type DaemonClient } from './client.js';
import { resolveTarget } from './target.js';

/**
 * `alteroid memory` — 記憶（人格）を読む・書き換える・消す。
 *
 * **読めるのに直せない面を作らない。** `docs/PRD.md`「インターフェース」は3面
 * （CLI・HTTP API・Web UI）で同じことができると書いており、起こせることの列挙に
 * **「記憶の書き換え」**がある。それまで CLI は `chat` の `/memory` で**読むだけ**で、
 * `PUT` / `DELETE /memory/:slug` に到達できなかった（`apps/cli/src` に `$put` は
 * 1件も無かった）。
 *
 * **記憶を人間が直せることは M1 の受け入れ基準3そのものである**（「人間がその
 * Markdown を手で書き換える → 次の会話でクローンの判断に反映される」）。ローカルの
 * fs 構成ならファイルを直に開けるが、pg 構成やコンテナの向こうではそれができない —
 * つまり**器を替えると受け入れ基準が満たせなくなる**状態だった。
 *
 * 形は `alteroid profile`（実行環境プロファイル）に合わせてある。人間が同じ手つきで
 * 使えることのほうが、コマンド名の短さより効く。
 */

/**
 * 一覧に出す1件（`GET /memory` の要素）。
 *
 * **`export` してあるのは `chat.ts` の `/memory` から使うため。** あちらは
 * 同じ `GET /memory` を見ながら、この一覧が持つ4項目（概要・作成・更新・
 * 鮮度の印）を1つも出していなかった（#235 はトップレベルの
 * `alteroid memory list` だけを直し、`chat` の中の重複実装は残っていた）。
 * 型と整形ロジック（`formatCreatedAt` / `freshnessMarker`）をここから
 * 再利用し、`chat.ts` 側で新しい言い方を発明しないようにする。
 */
export interface MemorySummary {
  slug: string;
  title: string;
  kind: 'premise' | 'fact';
  description?: string;
  descriptionFreshness: { kind: 'fresh' | 'stale' | 'unknown' | 'absent' };
  /** 最後に本文が変わった時刻。 */
  updatedAt: string;
  /**
   * 作成時刻。**根拠が無ければ `unknown`。**
   *
   * `GET /memory` は #220 からこの2状態で返す（日誌に最初の書き込みが無ければ
   * `unknown`。ファイルの mtime は使わない）。**空欄にしないこと** — 空欄だと
   * 「取れていない」のか「読み忘れ」なのか区別できない。
   */
  createdAt: { kind: 'known'; at: string } | { kind: 'unknown' };
}

/**
 * 作成時刻を1行に出す形。**根拠が無ければ「不明」と明言する。**
 *
 * クローンの `memory_list`（`packages/core/src/memory.ts` の
 * `formatMemoryCreatedAt`）と同じ言葉にしてある。**片方だけ空欄にすると、
 * 人間とクローンが同じ記憶を見て違う判断をする。**
 *
 * `export` してあるのは `chat.ts` の `/memory` から使うため（同上）。
 */
export function formatCreatedAt(createdAt: MemorySummary['createdAt']): string {
  return createdAt.kind === 'known' ? createdAt.at : '不明';
}

export async function memoryListCommand(): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const response = await client.memory.$get();
  if (!response.ok) {
    stdout.write('記憶の一覧を読めませんでした\n');
    return;
  }
  const { documents } = (await response.json()) as { documents: MemorySummary[] };
  if (documents.length === 0) {
    // **「0 件」で終わらせない。** 次の一手が無いと、空なのか読めていないのかが
    // 人間の側から区別できない。
    stdout.write('記憶はまだ空です。\n');
    stdout.write('置くには: alteroid memory edit <slug>\n');
    return;
  }
  for (const doc of documents) {
    const marker = freshnessMarker(doc.descriptionFreshness.kind);
    const desc = doc.description === undefined ? '' : ` — ${marker}${doc.description}`;
    // 5項目: slug（id）/ title（名前）/ description（概要）/ 作成 / 更新。
    // 括弧の中の形は `memory_list` に揃えてある。
    stdout.write(
      `  [${doc.kind}] ${doc.slug}  — ${doc.title}` +
        ` (作成: ${formatCreatedAt(doc.createdAt)} / 更新: ${doc.updatedAt})${desc}\n`,
    );
  }
}

/**
 * 印は要旨の前に置く（`memory_list` ツール・プロンプトの目次と同じ約束。
 * `packages/core/src/memory.ts` の doc）。**代理指標である** — `fresh` は
 * 「要旨が最後の本文変更以降に書かれた」ことしか意味しない。
 *
 * `export` してあるのは `chat.ts` の `/memory` から使うため（同上）。
 */
export function freshnessMarker(kind: 'fresh' | 'stale' | 'unknown' | 'absent'): string {
  switch (kind) {
    case 'stale':
      return '⚠古い要旨: ';
    case 'unknown':
      return '？鮮度不明: ';
    default:
      return '';
  }
}

export async function memoryShowCommand(slug: string): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const content = await read(client, slug);
  if (content === null) {
    stdout.write(`そんな記憶はありません: ${slug}\n`);
    return;
  }
  stdout.write(content.endsWith('\n') ? content : `${content}\n`);
}

/**
 * `$EDITOR` で開いて、閉じたら反映する。
 *
 * **無い slug でも開ける。** 記憶を新しく作るのも「人間が直せる」に含まれる
 * （`PUT` は全文置換で、存在しない slug でも作られる）。空から始めるときだけ
 * 雛形を入れる。
 */
export async function memoryEditCommand(slug: string): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const current = await read(client, slug);

  const dir = await mkdtemp(join(tmpdir(), 'alteroid-memory-'));
  const path = join(dir, `${slug}.md`);
  try {
    await writeFile(path, current ?? template(slug), 'utf8');
    await openEditor(path);
    const edited = await readFile(path, 'utf8');

    if (current !== null && edited === current) {
      // **書き換えていないなら書き込まない。** 同じ本文でも `PUT` は日誌へ
      // `memory_update` を積むので、押し戻すたびに「人間が書き換えた」が
      // 増えていく（後から経緯を読む側が、実際には無かった変更を数える）。
      stdout.write('変更はありません。\n');
      return;
    }
    await write(client, slug, edited);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** ファイル（または標準入力）の内容で丸ごと置き換える。 */
export async function memorySetCommand(
  slug: string,
  options: { file?: string } = {},
): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const content =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readFile(options.file, 'utf8');
  await write(client, slug, content);
}

/**
 * 記憶を1つ消す。
 *
 * **確認を求めない。** Web には確認の段が無く（ボタン1つで消える）、CLI にだけ
 * `--yes` を要求すると「CLI だけができないこと」を作る。消した事実は日誌に残るので、
 * 記憶から消えても記録からは消えない（`DELETE /memory/:slug` の description）。
 */
export async function memoryRemoveCommand(slug: string): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const response = await client.memory[':slug'].$delete({ param: { slug } });
  if (!response.ok) {
    // **「無い」と「名前として不正」を混ぜない**（デーモンが 404 と 400 で分けて
    // いるものを、こちらで1つに潰すと直し方が読めなくなる）。
    stdout.write(
      response.status === 400
        ? `記憶の名前として成立しません: ${slug}\n`
        : `そんな記憶はありません: ${slug}\n`,
    );
    return;
  }
  stdout.write(`消しました: ${slug}\n`);
}

/**
 * 繋ぎ先を決めて型付きクライアントを作る。**繋げない理由はそのまま出す。**
 *
 * 例外にしないのは `usage.ts` と揃えるためである（`alteroid: Error: …` の形に
 * すると、「ログインしていません」という人間向けの案内が例外の見た目で出る）。
 */
async function connect(): Promise<DaemonClient | null> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return null;
  }
  return createClient(target.baseUrl, target.headers);
}

/** 無ければ `null`。**空文字と区別する**（空の記憶は在りうる）。 */
async function read(client: DaemonClient, slug: string): Promise<string | null> {
  const response = await client.memory[':slug'].$get({ param: { slug } });
  if (!response.ok) return null;
  const body = await response.json();
  return 'document' in body ? body.document.content : null;
}

async function write(client: DaemonClient, slug: string, content: string): Promise<void> {
  const response = await client.memory[':slug'].$put({ param: { slug }, json: { content } });
  if (!response.ok) {
    stdout.write(`書き換えられませんでした: ${slug}（記憶の名前が不正かもしれません）\n`);
    return;
  }
  stdout.write(`書き換えました: ${slug}\n`);
  // **どこに効くかを言う。** 記憶はクローンのシステムプロンプトに載るので、
  // 次のターンから判断の材料になる（M1 受け入れ基準3）。
  stdout.write('（次の会話からクローンの判断に入ります）\n');
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function openEditor(path: string): Promise<void> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? 'vi';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: 'inherit', shell: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${editor} が異常終了しました (${String(code)})`));
    });
  });
}

/**
 * 空から始めるときの雛形。
 *
 * **「何をしてよいかの表」を書かせない。** 記憶は判断の根拠を置く場所であって、
 * 許可する行為の一覧ではない（一覧を作ると AGENTS.md 地雷表3行目の
 * `permissions.yaml` と同じ形になる）。
 */
function template(slug: string): string {
  return `# ${slug}

（ここにクローンへ渡したい根拠を書きます。価値観・判断の基準・背景など）

- 記憶は次の会話からクローンの判断に入ります
- 鍵やトークンは書かないでください（記憶はシステムプロンプトに載ります。
  それは実行環境プロファイル: alteroid profile edit の仕事です）
`;
}
