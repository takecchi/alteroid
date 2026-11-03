import type {
  ApplyMcpServersResult,
  ApplyProfileResult,
  EnvProfileEntry,
  McpServers,
  StoredMcpServers,
  ProfileService,
} from '@alteroid/core';
import {
  MCP_SERVER_NAME,
  composedFingerprints,
  composeProfileScript,
  mcpServerNames,
  PROFILE_ENTRY_NAME,
  McpServersConflictError,
  mcpServersVersionOf,
  ProfileInputError,
  ProfileRollbackFailedError,
  ProfileVersionMismatchError,
  redactProfileFailure,
  fingerprintOf,
  profileEntryVersionOf,
  reasonOf,
  NulNotAllowedError,
} from '@alteroid/core';
import { describeRoute } from 'hono-openapi';
import {
  mcpServersConflictResponseSchema,
  mcpServersResponseSchema,
  mcpServersUpdateRequestSchema,
  mcpServersUpdateResponseSchema,
  profileEntryUpdateRequestSchema,
  profileEntryDeleteQuery,
  profileConflictResponseSchema,
  profileErrorResponseSchema,
  profileResponseSchema,
  profileUpdateResponseSchema,
} from './openapi.js';
import { Hono } from 'hono';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  NO_ACCESS_GRANT_DESCRIPTION,
  jsonResponse,
  errorResponse,
  invalidWith,
  jsonBody,
  queryParams,
  describeActor,
  appendJournalOrDrop,
  kindOfError,
  describePluginDelivery,
} from './app-shared.js';

function mcpServersReadBody(stored: StoredMcpServers | null): {
  mcpServers: McpServers;
  updatedAt?: string;
  version: string;
} {
  return {
    mcpServers: stored?.mcpServers ?? {},
    ...(stored === null ? {} : { updatedAt: stored.updatedAt }),
    version: mcpServersVersionOf(stored),
  };
}

// 行の要約（本文を載せない）。409 の `current`・更新の応答・GET が同じ欄を同じ順で返す。
function profileEntryDigest(entry: EnvProfileEntry) {
  return {
    name: entry.name,
    scope: entry.scope,
    updatedAt: entry.updatedAt,
    sha256: fingerprintOf(entry.script),
    bytes: Buffer.byteLength(entry.script),
    version: profileEntryVersionOf(entry),
  };
}

function describeProfileEntries(entries: readonly EnvProfileEntry[]) {
  return {
    entries: entries.map((entry) => ({ ...entry, ...profileEntryDigest(entry) })),
    ...composedFingerprints(entries),
  };
}

// 書き換える2本の口（`PUT /profile/:name` / `DELETE /profile/:name`）はここ1か所に寄せる: 別々だと片方だけに検査や日誌が入って「人間が置くと弾かれるのにクローンが置くと通る」が生まれる。日誌を先に書く（書けなければ差し替えずに 500）。シェルの stderr は入力の行を引用し `set -x` は値ごと吐くので `redactProfileFailure` で伏せてから返す。値は日誌に1文字も書かない。
async function mutateProfile(
  deps: AppDeps,
  spec: {
    actor: string;
    route: string;
    subject?: string;
    run: (profile: ProfileService) => Promise<ApplyProfileResult>;
  },
): Promise<
  | { ok: true; body: ReturnType<typeof profileUpdateResponseSchema.parse> }
  | {
      ok: false;
      status: 400;
      body: {
        error: string;
        detail: string;
      };
    }
  | {
      ok: false;
      status: 409;
      body: ReturnType<typeof profileConflictResponseSchema.parse>;
    }
> {
  if (deps.profile === undefined) {
    return { ok: false, status: 400, body: { error: 'プロファイルの器が無い', detail: '' } };
  }
  const label = spec.subject === undefined ? '' : `（${spec.subject}）`;
  await deps.stores.journal.append({
    type: 'decision',
    decision: `実行環境プロファイルを差し替えようとしている${label}`,
    grounds: `${spec.actor}（${spec.route}）。値は書かない（鍵が入りうる）。`,
  });

  let result: ApplyProfileResult;
  try {
    result = await spec.run(deps.profile);
  } catch (error) {
    await appendJournalOrDrop(
      deps.stores,
      {
        type: 'decision',
        // 文言では見分けない（`ProfileRollbackFailedError` で見る）: 反映も書き戻しも落ちたときは状態どおりの行にする。
        decision:
          error instanceof ProfileRollbackFailedError
            ? `実行環境プロファイルの差し替えが途中で止まった（正本は新しい版のまま・クローンは前の版）${label}`
            : `実行環境プロファイルを差し替えられなかった${label}`,
        grounds: `${spec.actor}（${spec.route}、状態の変更が失敗）: ${kindOfError(error)}`,
      },
      '実行環境プロファイルの打ち消しの日誌',
      spec.route,
    );
    // `detail` に載せるのはこちらが組んだ文だけ（`NulNotAllowedError` の文は欄名と固定の説明だけ）で、送られてきた本文・値は載せない。
    if (error instanceof ProfileInputError || error instanceof NulNotAllowedError) {
      return {
        ok: false,
        status: 400,
        body: { error: 'プロファイルの入力が不正（保存していない）', detail: error.message },
      };
    }
    // 読んだ後に変わっていた: 何も変えていない。いまの行を本文抜きで添える（鍵を往復させない）
    if (error instanceof ProfileVersionMismatchError) {
      const current = error.current;
      return {
        ok: false,
        status: 409,
        body: profileConflictResponseSchema.parse({
          error: 'プロファイルの行が読んだ後に変わっている（変えていない）',
          detail:
            current === null
              ? '読んだ後に、その行は消されている（または読んだ後に作られた行ではない）'
              : `読んだ後に、行 ${current.name} が変わっている・作られている`,
          current: current === null ? null : profileEntryDigest(current),
        }),
      };
    }
    throw error;
  }

  if (!result.stored) {
    // 保存も配布もしていなくても打ち消しの行を足す: 記録が多すぎる側の穴は、記録の無い差し替えより安全側。
    await appendJournalOrDrop(
      deps.stores,
      {
        type: 'decision',
        decision: `実行環境プロファイルを差し替えられなかった（読めなかった）${label}`,
        grounds: `${spec.actor}（${spec.route}、評価で断られた）`,
      },
      '実行環境プロファイルの打ち消しの日誌',
      spec.route,
    );
    const failure = redactProfileFailure(result.clone, process.env);
    return {
      ok: false,
      status: 400,
      body: {
        error: 'プロファイルが読めなかったので保存していない',
        detail: [failure.error, failure.output].join('\n').trim(),
      },
    };
  }

  // 差し替え自体はもう効いているので、配布の成否は後から2行目として足す（落ちても 500 にしない。値は1文字も書かない）。
  const entries = result.entries ?? [];
  const composed = result.composed ?? composedFingerprints(entries);
  const allScript = composeProfileScript(entries, 'all');
  const allFingerprint =
    allScript.length === 0
      ? {}
      : { sha256: fingerprintOf(allScript), bytes: Buffer.byteLength(allScript) };
  await appendJournalOrDrop(
    deps.stores,
    {
      type: 'decision',
      decision:
        spec.subject === undefined
          ? // 旧来の全部差し替えは1本の時代と同じ文言: 日誌を読む側と歯がこの文言で見ている。
            allFingerprint.sha256 === undefined
            ? '実行環境プロファイルを外した'
            : `実行環境プロファイルを更新した（sha256 ${allFingerprint.sha256}・${String(allFingerprint.bytes)} bytes）`
          : `実行環境プロファイル（${spec.subject}）を更新した（クローン用 sha256 ${composed.clone.sha256 ?? 'なし'}・runner 用 sha256 ${composed.runner.sha256 ?? 'なし'}）`,
      grounds:
        `${spec.actor}（${spec.route}）。` +
        '値は書かない（鍵が入りうる）。クローンの次のセッションから効く。' +
        `runner への配布: ${describePluginDelivery(result.runners)}` +
        '（マネージャー・作業者には次に開くセッションから効く）。',
    },
    '実行環境プロファイルの日誌',
    spec.route,
  );

  return {
    ok: true,
    body: profileUpdateResponseSchema.parse({
      updatedAt: result.updatedAt ?? new Date().toISOString(),
      entries: entries.map(profileEntryDigest),
      composed,
      // 成功でも `set -x` の出力（値入り）は `output` に載るので伏せる。
      clone:
        result.clone.output === undefined
          ? result.clone
          : {
              ...result.clone,
              output: redactProfileFailure({ output: result.clone.output }, process.env).output,
            },
      runners: result.runners,
    }),
  };
}

export function profileRoutes(deps: AppDeps) {
  return (
    new Hono<{ Variables: AuthVariables }>()
      // 読み側も書き側と同じ門にする: 本文には `GH_TOKEN` のような鍵が丸ごと入りうるので、`GET` が緩いと `PUT` を締めても意味が無い。本文を返す: 読み直せないと typo ひとつ直せない（指紋しか返さないのは runner の制御面で、守る相手が違う）。
      .get(
        '/profile',
        describeRoute({
          tags: ['profile'],
          summary: '実行環境プロファイル（.zprofile 相当。名前付きの行の集まり）を読む',
          description:
            '器の環境変数を増やす代わりに、名前付きのシェルスクリプトの行を記憶ストアへ置く。' +
            '行ごとに撒く先（all=クローンと runner の両方 / app=クローンだけ / runner=runner だけ）を持ち、' +
            '名前のコード単位順（/etc/profile.d と同じ）につなげて効かせる。',
          responses: {
            200: jsonResponse(
              'プロファイルの行（本文つき）と、合成後の指紋。置かれていなければ行は空。',
              profileResponseSchema,
            ),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
          },
        }),
        async (c) => {
          const entries = await deps.stores.profile.list();
          return c.json(profileResponseSchema.parse(describeProfileEntries(entries)));
        },
      )

      // 名前の形が不正なら 400: 名前は fs 版の器の中でファイル名になる。
      .put(
        '/profile/:name',
        describeRoute({
          tags: ['profile'],
          summary: '実行環境プロファイルの1行を置く',
          description:
            '名前付きの行を置く（無ければ作る）。行は名前のコード単位順につなげて効かせる。' +
            '置く前に評価する（撒く先が runner だけの行は、デーモンでは評価できないので runner が評価する）。' +
            '読めなければ保存も配布もせず、理由を返す（前のものが残る）。' +
            '`ifMatch`（`GET /profile` の各行の `version`）を渡すと、読んだ後にその行が変わっていたとき何も変えずに 409。' +
            '`ifMatch: null` は「行が無いときだけ作る」。省けば今までどおり比べない。',
          responses: {
            200: jsonResponse(
              '行を置いた後の全行と、クローンと各 runner への反映結果。',
              profileUpdateResponseSchema,
            ),
            400: jsonResponse(
              'プロファイルが読めなかった（保存していない）、または名前・本文・撒く先の形が不正。' +
                '送られてきた本文は返さない。',
              profileErrorResponseSchema,
            ),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            409: jsonResponse(
              '`ifMatch` がいまの行と食い違う（読んだ後に変わった・作られた・消された。何も変えていない）。' +
                '`current` にいまの行（本文は載せない。無ければ `null`）を添える。',
              profileConflictResponseSchema,
            ),
          },
        }),
        jsonBody(profileEntryUpdateRequestSchema, (where) => ({
          error: 'プロファイルの入力の形が不正（保存していない）',
          detail: where === '' ? '本文の形が不正である' : `形が不正な項目: ${where}`,
        })),
        async (c) => {
          const name = c.req.param('name');
          if (!PROFILE_ENTRY_NAME.test(name)) {
            return c.json(
              {
                error: 'プロファイルの行の名前の形が不正（保存していない）',
                detail: `名前は ${PROFILE_ENTRY_NAME.source} の形にすること`,
              },
              400,
            );
          }
          const { script, scope, ifMatch } = c.req.valid('json');
          const outcome = await mutateProfile(deps, {
            actor: describeActor(c.get('principal')),
            route: 'PUT /profile/:name',
            subject: `行 ${name}`,
            run: (profile) =>
              profile.set(name, script, scope, ifMatch === undefined ? undefined : { ifMatch }),
          });
          if (outcome.ok) return c.json(outcome.body, 200);
          return outcome.status === 409 ? c.json(outcome.body, 409) : c.json(outcome.body, 400);
        },
      )

      .delete(
        '/profile/:name',
        describeRoute({
          tags: ['profile'],
          summary: '実行環境プロファイルの1行を外す',
          description:
            '名前付きの行を外す。他の行は変えない。無い名前は 404（何も変えない）。' +
            '外した行が、クローンか runner のどちらかに掛かる最後の1行だったなら、その側から環境が外れる。' +
            'クエリの `ifMatch`（`GET /profile` の各行の `version`）を渡すと、読んだ後にその行が変わっていたとき外さずに 409。' +
            '省けば今までどおり比べない。',
          responses: {
            200: jsonResponse(
              '行を外した後の全行と、クローンと各 runner への反映結果。',
              profileUpdateResponseSchema,
            ),
            400: jsonResponse('名前の形が不正、または反映に失敗した。', profileErrorResponseSchema),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            404: errorResponse('その名前の行は無い。'),
            409: jsonResponse(
              '`ifMatch` がいまの行と食い違う（読んだ後に変わった。外していない）。' +
                '`current` にいまの行（本文は載せない）を添える。',
              profileConflictResponseSchema,
            ),
          },
        }),
        queryParams(profileEntryDeleteQuery, (where) => ({
          error: 'プロファイルの入力の形が不正（何も変えていない）',
          detail: where === '' ? 'クエリの形が不正である' : `形が不正な項目: ${where}`,
        })),
        async (c) => {
          const name = c.req.param('name');
          if (!PROFILE_ENTRY_NAME.test(name)) {
            return c.json(
              {
                error: 'プロファイルの行の名前の形が不正（何も変えていない）',
                detail: `名前は ${PROFILE_ENTRY_NAME.source} の形にすること`,
              },
              400,
            );
          }
          if (deps.profile === undefined) {
            return c.json({ error: 'プロファイルの器が無い', detail: '' }, 400);
          }
          // 無い名前は日誌も書かず 404: 「外そうとしている」を残さない。
          if (!(await deps.profile.read()).some((entry) => entry.name === name)) {
            return c.json({ error: `プロファイルに行 ${name} は無い` }, 404);
          }
          const { ifMatch } = c.req.valid('query');
          const outcome = await mutateProfile(deps, {
            actor: describeActor(c.get('principal')),
            route: 'DELETE /profile/:name',
            subject: `行 ${name}（外す）`,
            run: (profile) => profile.remove(name, ifMatch === undefined ? undefined : { ifMatch }),
          });
          if (outcome.ok) return c.json(outcome.body, 200);
          return outcome.status === 409 ? c.json(outcome.body, 409) : c.json(outcome.body, 400);
        },
      )

      // `GET` も `PUT` と同じ門にする: 登録の `env` / `headers` には鍵が丸ごと入りうるので、読み側が緩いと書き側を締めても意味が無い。stdio の登録はクローンの SDK 子プロセスが起こすコマンドで、クローンの env（記憶ストアの鍵を含む）を継承する＝「次のセッションで任意のコマンドを走らせる」口でもある。門を `requireOperator` へ締めるかは人間の判断（締めるなら `scripts/require-operator-routes.test.ts` の一覧を付け替える）。
      .get(
        '/mcp-servers',
        describeRoute({
          tags: ['mcp-servers'],
          summary: 'MCP サーバの登録（.mcp.json 相当）を読む',
          description:
            '人間の MCP 連携の登録を記憶ストアから返す。クローンの本セッションと蒸留に' +
            '（次のセッションから）、マネージャー・作業者に（runner へ降ろしたうえで、次に開く' +
            'セッションから）効く。',
          responses: {
            200: jsonResponse(
              '登録そのもの（値を含む）と、その版（`version`。`PUT` の `ifMatch` へ渡す）。' +
                '置かれていなければ空の `mcpServers`。',
              mcpServersResponseSchema,
            ),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
          },
        }),
        async (c) => {
          const stored = await deps.stores.mcpServers.read();
          return c.json(mcpServersResponseSchema.parse(mcpServersReadBody(stored)));
        },
      )

      // 保存と配布は同じ列を通す（`mcp-server-service.ts`）: 名乗り直しの降ろし直しと混ざって古い登録で上書きしない。日誌には名前だけを書く（値には鍵が入りうる）。能力を広げる口なので日誌を先に書き、書けなければ差し替えずに 500。空の `mcpServers`（狭める使い方）も口ごとに1つの扱いとして同じ（閉じる側に倒す）。
      .put(
        '/mcp-servers',
        describeRoute({
          tags: ['mcp-servers'],
          summary: 'MCP サーバの登録を差し替える',
          description:
            '`.mcp.json` をそのまま貼れる形（`{ "mcpServers": { … } }`）。置く前に形を' +
            '検査し、通らなければ保存しない（前のものが残る）。保存したら繋がっている runner へ' +
            '降ろし、runner ごとの結果（名前と指紋だけ）を返す。本文の `ifMatch`（`GET` の ' +
            '`version`）が省略でなく、いまの版と違えば何も書かず 409（`current` がいまの登録）。' +
            `「${MCP_SERVER_NAME}」は alteroid 自身の MCP サーバの名前なので使えない。`,
          responses: {
            200: jsonResponse(
              '差し替えた後の登録の名前と指紋、runner ごとの配布結果（値は返さない）。',
              mcpServersUpdateResponseSchema,
            ),
            400: errorResponse(
              '形が不正（保存していない）。**送られてきた値は応答に載せない**' +
                '（どの欄が不正かだけを返す）。',
            ),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            409: jsonResponse(
              '`ifMatch` が読んだ後に変わっていた（書いていない）。`current` がいまの登録' +
                '（`GET` と同じ形。値を含むので `GET` と同じ門の内側にだけ返す）。',
              mcpServersConflictResponseSchema,
            ),
          },
        }),
        // 既定の 400 を使わない（`PUT /profile/:name` と同じ理由）: 本文をそのまま `data` に載せて返すので、欄の綴りを1つ間違えただけで `env` / `headers` の鍵が応答へ載る。
        jsonBody(
          mcpServersUpdateRequestSchema,
          invalidWith('MCP サーバの登録の形が不正（保存していない）'),
        ),
        async (c) => {
          // 前の登録は日誌のためにしか使わない（全文置換なので差分の計算も配布も前を見ない）: 保存済みの登録が壊れていても置き直す口を塞がず、「読めなかった」と書いて進む。「なし」とは書き分ける（前は空だったと取り違えない）。理由は `reasonOf` を通す。
          let previousText: string;
          try {
            const previous = await deps.stores.mcpServers.read();
            const before = previous === null ? [] : mcpServerNames(previous.mcpServers);
            previousText = before.length === 0 ? 'なし' : before.join(', ');
          } catch (error) {
            previousText = `読めなかった（${reasonOf(error)}）`;
          }
          const { mcpServers: servers, ifMatch } = c.req.valid('json');
          const writeOptions = ifMatch === undefined ? undefined : { ifMatch };
          const names = mcpServerNames(servers);

          await deps.stores.journal.append({
            type: 'decision',
            decision:
              names.length === 0
                ? 'MCP サーバの登録を外そうとしている'
                : `MCP サーバの登録を差し替えようとしている（${names.join(', ')}）`,
            grounds:
              `${describeActor(c.get('principal'))}（PUT /mcp-servers）。` +
              `前の登録: ${previousText}。` +
              '値は書かない（鍵が入りうる）。',
          });

          // 本番の配線（`index.ts`）は必ず渡す。渡されていない構成は、保存だけして配らない道を黙って作らず、配線の誤りとして落とす（打ち消しの日誌を書いて 500）。
          let applied: ApplyMcpServersResult;
          try {
            if (deps.mcpServers === undefined) {
              throw new Error('McpServerService が渡されていない（createApp の mcpServers）');
            }
            applied = await deps.mcpServers.apply(servers, writeOptions);
          } catch (error) {
            await appendJournalOrDrop(
              deps.stores,
              {
                type: 'decision',
                decision:
                  names.length === 0
                    ? 'MCP サーバの登録を外せなかった'
                    : `MCP サーバの登録を差し替えられなかった（${names.join(', ')}）`,
                grounds: `${describeActor(c.get('principal'))}（PUT /mcp-servers、状態の変更が失敗）`,
              },
              'MCP サーバ登録の打ち消しの日誌',
              `count=${String(names.length)}`,
            );
            // NUL は入力の誤りで 400: 文は欄名と固定の説明だけで、値を載せない。
            if (error instanceof NulNotAllowedError) {
              return c.json(
                { error: `MCP サーバの登録が不正（保存していない）: ${error.message}` },
                400,
              );
            }
            // `current` の鍵の有無で他の 409 と見分けられる。
            if (error instanceof McpServersConflictError) {
              return c.json(
                {
                  error: 'MCP サーバの登録が読んだ後に変わっています（書き換えていません）',
                  current: mcpServersReadBody(error.current),
                },
                409,
              );
            }
            throw error;
          }
          // 差し替え自体はもう効いているので、後で分かった配布結果は2行目として足す（落ちても 500 にしない。値は書かない）。
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision:
                names.length === 0
                  ? 'MCP サーバの登録を外した'
                  : `MCP サーバの登録を差し替えた（${names.join(', ')}）`,
              grounds:
                `${describeActor(c.get('principal'))}（PUT /mcp-servers）。` +
                `前の登録: ${previousText}。` +
                '値は書かない（鍵が入りうる）。クローンの次のセッションから効く。' +
                `runner への配布: ${describePluginDelivery(applied.runners)}` +
                '（マネージャーには次に開くセッションから効く）。',
            },
            'MCP サーバ登録の日誌',
            `count=${String(names.length)}`,
          );
          return c.json(
            mcpServersUpdateResponseSchema.parse({
              names,
              updatedAt: applied.updatedAt,
              version: applied.version,
              ...(applied.sha256 === undefined ? {} : { sha256: applied.sha256 }),
              appliesFrom:
                'クローンの次のセッションから。マネージャー・作業者は、配布できた runner で次に開くセッションから',
              runners: applied.runners,
            }),
          );
        },
      )
  );
}
