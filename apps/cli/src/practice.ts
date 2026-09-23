import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';

import { createClient, type DaemonClient } from './client.js';
import { resolveTarget } from './target.js';

/**
 * `alteroid practice` — 仕事のやり方を読む・書き換える・消す（#1055 段3③）。
 *
 * **`alteroid memory`（`memory.ts`）が型紙である。** サブコマンドの構成
 * （`list` / `show` / `edit` / `set` / `remove`）はそちらに揃えてある。
 *
 * **やり方に無い概念は写さない。**
 * - `PracticeStore` は human guard（`memory` の `markHumanTouched` に当たる
 *   保護状態）を持たない（`packages/core/src/store.ts` の `PracticeStore` の
 *   doc）。ここには対応する概念が無い
 * - `kind`（frontmatter の種別 `premise`/`fact`/`indexed` に相当するもの）は
 *   `practiceKindSchema` が自由文字列で、列挙ではない（`practiceKindSchema`
 *   の doc「⛔ ここを `z.enum` にしないこと」）。CLI でも固定の選択肢にしない
 *   — Web UI（`apps/web/app/routes/practice-detail.tsx`）で `<select>` を
 *   置かなかったのと同じ理由
 * - **`kind` / `title` はやり方の本体（`content`）とは別の必須フィールドで
 *   ある。** `PracticeStore.write` は `slug`/`kind`/`title`/`content` の
 *   全文置換で、`content` だけの部分更新は無い（`memory` の `PUT` が
 *   `{content}` だけで足りるのとの違い）。`set`/`edit` は `--kind`/`--title`
 *   を受け、既存のやり方を編集するときは省略すると現在の値を引き継ぐ
 *
 * **`apply` / `enforce` に当たるサブコマンドは無い。** やり方は読む素材で
 * あって実行される定義ではない（`docs/north_star.md`、段3②・#1316 と同じ
 * 設計）。
 *
 * **CLI 専用の HTTP 経路は無い。** #1316 で足した `GET`/`PUT`/`DELETE
 * /practices(/:slug)` にそのまま乗る（`docs/PRD.md`「Web UI は API の
 * 特権的な消費者ではない」と同じ理由が CLI にも効く——CLI もデーモンの
 * HTTP API の薄いクライアントに徹する）。
 *
 * **版の履歴（#1309）も同じ形。** `GET /practices/:slug/versions(/:version)`
 * にそのまま乗る——`history` サブコマンドと、`show --version` オプションで出す。
 */

/** 一覧に出す1件（`GET /practices` の要素）。 */
export interface PracticeSummary {
  slug: string;
  kind: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 本文の文字数（コードポイント数。保存された値ではなく本文から導出——#1340）。 */
  chars: number;
}

export async function practiceListCommand(): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const response = await client.practices.$get();
  if (!response.ok) {
    stdout.write('やり方の一覧を読めませんでした\n');
    return;
  }
  const { practices } = (await response.json()) as { practices: PracticeSummary[] };
  if (practices.length === 0) {
    // **「0 件」で終わらせない。** `memory list` と同じ理由——空なのか
    // 読めていないのかを、次の一手が無いと人間の側から区別できない。
    // **ただしここは異常ではない。** やり方が1件も無いのは正常な状態
    // （`practice_list` クローンの道具の文言と同じ語彙）。
    stdout.write('やり方はまだ1件も無い（これは正常な状態）。\n');
    stdout.write('置くには: alteroid practice edit <slug> --kind <種類> --title <題>\n');
    return;
  }
  for (const p of practices) {
    stdout.write(
      `  [${p.kind}] ${p.slug}  — ${p.title}` +
        ` (作成: ${p.createdAt} / 更新: ${p.updatedAt} / ${String(p.chars)} 文字)\n`,
    );
  }
}

export async function practiceShowCommand(
  slug: string,
  options: { version?: number } = {},
): Promise<void> {
  const client = await connect();
  if (client === null) return;

  if (options.version !== undefined) {
    const response = await client.practices[':slug'].versions[':version'].$get({
      param: { slug, version: String(options.version) },
    });
    if (!response.ok) {
      stdout.write(
        response.status === 400
          ? `版番号として成立しません: ${String(options.version)}\n`
          : `そんな版はありません: ${slug} 版${String(options.version)}\n`,
      );
      return;
    }
    const body = await response.json();
    const content = 'version' in body ? body.version.content : '';
    stdout.write(content.endsWith('\n') ? content : `${content}\n`);
    return;
  }

  const found = await read(client, slug);
  if (found === null) {
    stdout.write(`そんなやり方はありません: ${slug}\n`);
    return;
  }
  const content = found.content;
  stdout.write(content.endsWith('\n') ? content : `${content}\n`);
}

/**
 * やり方の版の履歴を出す（#1309）。**メタだけ**——本文は
 * `alteroid practice show <slug> --version <n>` で読む。
 */
export async function practiceHistoryCommand(slug: string): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const response = await client.practices[':slug'].versions.$get({ param: { slug } });
  if (!response.ok) {
    stdout.write('版の履歴を読めませんでした\n');
    return;
  }
  const { versions } = (await response.json()) as {
    versions: Array<{ version: number; kind: string; title: string; at: string; chars: number }>;
  };
  if (versions.length === 0) {
    stdout.write(`やり方 ${slug} の版はまだ無い（一度も書かれていないか、打ち間違い）。\n`);
    return;
  }
  for (const v of versions) {
    stdout.write(
      `  版${String(v.version)} [${v.kind}] ${v.title} (${v.at} / ${String(v.chars)} 文字)\n`,
    );
  }
  stdout.write(`本文は: alteroid practice show ${slug} --version <版番号>\n`);
}

/**
 * `$EDITOR` で本文を開いて、閉じたら反映する。
 *
 * **無い slug でも開ける**（`memory edit` と同じ——`PUT` は全文置換で、
 * 存在しない slug でも作られる）。**`--kind`/`--title` は省略できる**が、
 * 意味は状況で変わる——既存のやり方なら現在の値を引き継ぎ、新しいやり方
 * なら両方とも必須（`practiceKindSchema` が `kind` に `min(1)` を課す
 * ので、省略したまま新規作成しようとすると人間に分かる形で断る）。
 */
export async function practiceEditCommand(
  slug: string,
  options: { kind?: string; title?: string } = {},
): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const current = await read(client, slug);

  const kind = options.kind ?? current?.kind;
  const title = options.title ?? current?.title;
  if (kind === undefined || title === undefined) {
    stdout.write(
      '新しいやり方には --kind と --title が両方必要です: ' +
        'alteroid practice edit <slug> --kind <種類> --title <題>\n',
    );
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'alteroid-practice-'));
  const path = join(dir, `${slug}.md`);
  try {
    await writeFile(path, current?.content ?? template(slug), 'utf8');
    await openEditor(path);
    const edited = await readFile(path, 'utf8');

    if (
      current !== null &&
      edited === current.content &&
      kind === current.kind &&
      title === current.title
    ) {
      // **書き換えていないなら書き込まない**（`memory edit` と同じ理由——
      // 同じ内容でも `PUT` は日誌へ `decision` を積むので、押し戻すたびに
      // 「人間が書き換えた」という跡が実際には無かった変更ぶん増える）。
      stdout.write('変更はありません。\n');
      return;
    }
    await write(client, slug, kind, title, edited);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * ファイル（または標準入力）の内容で丸ごと置き換える。
 *
 * **`--kind`/`--title` の省略時は既存の値を引き継ぐ**（`edit` と同じ規則）。
 * 新規作成では両方必須。
 */
export async function practiceSetCommand(
  slug: string,
  options: { file?: string; kind?: string; title?: string } = {},
): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const current = await read(client, slug);

  const kind = options.kind ?? current?.kind;
  const title = options.title ?? current?.title;
  if (kind === undefined || title === undefined) {
    stdout.write(
      '新しいやり方には --kind と --title が両方必要です: ' +
        'alteroid practice set <slug> --kind <種類> --title <題>\n',
    );
    return;
  }

  const content =
    options.file === undefined || options.file === '-'
      ? await readAll()
      : await readFile(options.file, 'utf8');
  await write(client, slug, kind, title, content);
}

/**
 * やり方を1つ消す。
 *
 * **確認を求めない**（`memory remove` と同じ理由——Web UI に確認の段が
 * 無く、CLI にだけ `--yes` を要求すると「CLI だけができないこと」を作る）。
 * 消した事実は日誌に残る。
 */
export async function practiceRemoveCommand(slug: string): Promise<void> {
  const client = await connect();
  if (client === null) return;
  const response = await client.practices[':slug'].$delete({ param: { slug } });
  if (!response.ok) {
    // **「無い」と「名前として不正」を混ぜない**（`memory remove` と同じ
    // 理由——デーモンが 404 と 400 で分けているものを1つに潰すと、
    // 打ち間違いなのか消えたのかが読めなくなる）。
    stdout.write(
      response.status === 400
        ? `やり方の名前として成立しません: ${slug}\n`
        : `そんなやり方はありません: ${slug}\n`,
    );
    return;
  }
  stdout.write(`消しました: ${slug}\n`);
}

async function connect(): Promise<DaemonClient | null> {
  const target = await resolveTarget();
  if (target.note !== null) {
    stdout.write(`${target.note}\n`);
    return null;
  }
  return createClient(target.baseUrl, target.headers);
}

/** 無ければ `null`。 */
async function read(
  client: DaemonClient,
  slug: string,
): Promise<{ kind: string; title: string; content: string } | null> {
  const response = await client.practices[':slug'].$get({ param: { slug } });
  if (!response.ok) return null;
  const body = await response.json();
  return 'practice' in body
    ? { kind: body.practice.kind, title: body.practice.title, content: body.practice.content }
    : null;
}

async function write(
  client: DaemonClient,
  slug: string,
  kind: string,
  title: string,
  content: string,
): Promise<void> {
  const response = await client.practices[':slug'].$put({
    param: { slug },
    json: { kind, title, content },
  });
  if (!response.ok) {
    stdout.write(
      `書き換えられませんでした: ${slug}（種類・題・スラッグのどれかが不正かもしれません）\n`,
    );
    return;
  }
  stdout.write(`書き換えました: ${slug}\n`);
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
 * **「何をしてよいかの表」を書かせない**（`memory` の `template` と同じ
 * 理由——`permissions.yaml` 的な一覧にしない、AGENTS.md 地雷表3行目）。
 */
function template(slug: string): string {
  return `# ${slug}

（ここに仕事のやり方を書きます。これは実行される定義ではなく、読んで
従うかどうかはそのときのクローンが決めます）
`;
}
