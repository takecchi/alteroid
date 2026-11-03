import type {
  ApplyPluginsResult,
  PluginDistributionService,
  createPluginPreviewStore,
} from '@alteroid/core';
import {
  isValidPluginName,
  normalizePluginDescription,
  parsePluginInput,
  PluginFetchError,
  PluginNameConflictError,
  summarizeFetchedPlugin,
  noteDroppedRecord,
  reasonOf,
} from '@alteroid/core';
import { describeRoute } from 'hono-openapi';
import {
  pluginInstallRequestSchema,
  pluginInstallResponseSchema,
  pluginPreviewRequestSchema,
  pluginPreviewResponseSchema,
  pluginRemoveResponseSchema,
  pluginsListResponseSchema,
} from './openapi.js';
import { principalRefOf } from './app-context.js';
import { Hono } from 'hono';
import type { AppDeps } from './app.js';
import type { AuthVariables } from './auth.js';
import {
  NO_ACCESS_GRANT_DESCRIPTION,
  jsonResponse,
  errorResponse,
  journalWriteFailedResponse,
  invalidWith,
  jsonBody,
  describeActor,
  appendJournalOrDrop,
  journalWriteFailedBody,
  kindOfError,
  describePluginDelivery,
} from './app-shared.js';

// `reasonOf` は各段の頭に `${name}: ` を付ける。`PluginFetchError` の message は人間向けの完結した文なので、web がそのまま出す本文からは自分のクラス名だけを外す（伏せ字・切り詰め・cause の連なりは `reasonOf` のまま）。web 側で頭を削らない: 文が変わると黙って外れる。
function reasonWithoutOwnName(error: Error): string {
  const reason = reasonOf(error);
  const head = `${error.name}: `;
  return reason.startsWith(head) ? reason.slice(head.length) : reason;
}

function describePluginSource(source: {
  kind: string;
  url: string;
  path?: string | undefined;
  sha: string;
  marketplace?: string | undefined;
  plugin?: string | undefined;
}): string {
  const where = `${source.url}${source.path === undefined ? '' : `（path: ${source.path}）`}`;
  return source.kind === 'marketplace'
    ? `marketplace ${source.marketplace ?? '?'} の ${source.plugin ?? '?'}（${where}）、SHA ${source.sha}`
    : `${where}、SHA ${source.sha}`;
}

// 配布が投げても失敗にしない: 保存は済んでいる（応答に失敗として載せ、失敗した runner へは名乗り直しで降ろし直す）。
async function applyPlugins(deps: {
  pluginDistribution?: PluginDistributionService | undefined;
}): Promise<ApplyPluginsResult> {
  if (deps.pluginDistribution === undefined) return { names: [], runners: [] };
  try {
    return await deps.pluginDistribution.apply();
  } catch (error) {
    return { names: [], runners: [{ runnerId: 'daemon', ok: false, error: reasonOf(error) }] };
  }
}

export function pluginsRoutes(
  deps: AppDeps,
  pluginPreviews: ReturnType<typeof createPluginPreviewStore>,
) {
  return (
    new Hono<{ Variables: AuthVariables }>()
      // 門は `authenticate` だけ（許可済みのアカウントが通る。MCP 連携の登録と同じ範囲）: plugin は skills・agents・commands をクローンとマネージャーの実行に持ち込む。クローンの道具からは入れられない（道具を足さない）。
      .get(
        '/plugins',
        describeRoute({
          tags: ['plugins'],
          summary: '入れてある plugin の一覧（files は含まない）',
          responses: {
            200: jsonResponse('入れてある plugin の要約。', pluginsListResponseSchema),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
          },
        }),
        async (c) =>
          c.json(pluginsListResponseSchema.parse({ plugins: await deps.stores.plugins.list() })),
      )

      // 確定（`POST /plugins`）は預かりを取り直さず保存する: 確認の後に取り元が動いても、見せたものと入れるものがずれない。enableHooks でも展開器はいまは hooks を出さない。
      .post(
        '/plugins/preview',
        describeRoute({
          tags: ['plugins'],
          summary: 'plugin を取って中身の要約を返す（まだ入れない）',
          responses: {
            200: jsonResponse(
              '要約と、確定に使う previewId（期限つき）。',
              pluginPreviewResponseSchema,
            ),
            400: errorResponse(
              '入力・取り元の中身が不正（上限超過・path が無い・名前が使えない など）。',
            ),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            502: errorResponse('取り元から取れなかった（接続・時間・サイズの上限）。'),
            503: errorResponse('取得の口が無い、または公式 marketplace の URL が未設定。'),
          },
        }),
        jsonBody(pluginPreviewRequestSchema, invalidWith('plugin の取り元の指定が不正')),
        async (c) => {
          const fetcher = deps.pluginFetcher;
          if (fetcher === undefined) {
            return c.json({ error: 'plugin を取る口が無い構成' }, 503);
          }
          const body = c.req.valid('json');
          let fetched;
          try {
            fetched = await fetcher.fetch(
              body.kind === 'url'
                ? {
                    kind: 'url',
                    url: body.url,
                    ...(body.path === undefined ? {} : { path: body.path }),
                    ...(body.ref === undefined ? {} : { ref: body.ref }),
                    ...(body.sha === undefined ? {} : { sha: body.sha }),
                  }
                : { kind: 'marketplace', plugin: body.plugin },
            );
          } catch (error) {
            if (!(error instanceof PluginFetchError)) throw error;
            const status =
              error.kind === 'invalid' ? 400 : error.kind === 'unavailable' ? 502 : 503;
            return c.json({ error: reasonWithoutOwnName(error) }, status);
          }
          // 同じ名前の plugin が既にあれば、確定が置き換えになることを言う。その時点の SHA は預かりに結び付け、確定で突き合わせる（#4797）
          const current = (await deps.stores.plugins.list()).find((p) => p.name === fetched.name);
          const { previewId, expiresAt } = pluginPreviews.put(fetched, current?.source.sha ?? null);
          return c.json(
            pluginPreviewResponseSchema.parse({
              previewId,
              expiresAt,
              summary: summarizeFetchedPlugin(fetched),
              ...(current === undefined
                ? {}
                : {
                    replaces: {
                      name: current.name,
                      source: current.source,
                      sha: current.source.sha,
                      installedAt: current.installedAt,
                    },
                  }),
            }),
          );
        },
      )

      // 日誌を先に書き、書けなければ入れずに 500（能力を広げる口。`PUT /mcp-servers` と同じ）。中身は日誌に書かない。
      .post(
        '/plugins',
        describeRoute({
          tags: ['plugins'],
          summary: 'プレビューした plugin を入れる（確定）',
          responses: {
            200: jsonResponse(
              '入れた plugin と、runner ごとの配布結果。',
              pluginInstallResponseSchema,
            ),
            400: errorResponse('入力が不正、または保存できない形（何も保存していない）。'),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            404: errorResponse('previewId が無い（期限切れ・確定済み・別のデーモン）。'),
            409: errorResponse(
              '名前が既存の名前と大文字小文字だけ違う、または、プレビューの後に同じ名前の plugin が変わった（入った・消えた・入れ替わった）。',
            ),
            500: journalWriteFailedResponse('日誌が書けなかったので入れていない。'),
          },
        }),
        jsonBody(pluginInstallRequestSchema, invalidWith('plugin の確定の指定が不正')),
        async (c) => {
          const { previewId, scope, enableHooks, enableMcp } = c.req.valid('json');
          const fetched = pluginPreviews.get(previewId);
          if (fetched === undefined) {
            return c.json(
              {
                error:
                  'プレビューが見つからない（期限切れ、確定済み、または別のデーモン）。もう一度プレビューから',
              },
              404,
            );
          }
          // 外から来た説明は弾かずに整える: 飾りのせいで入れられなくしない。
          const description = normalizePluginDescription(fetched.description);
          const input = {
            name: fetched.name,
            ...(description === undefined ? {} : { description }),
            source: fetched.source,
            scope,
            enableHooks,
            enableMcp,
            files: fetched.files,
            installedAt: new Date().toISOString(),
            installedBy: principalRefOf(c.get('principal')),
          };
          // 日誌より前に保存できる形かを確かめる: 保存できないものの「入れようとしている」を残さない。
          try {
            parsePluginInput(input);
          } catch (error) {
            return c.json(
              { error: `plugin を保存できない形（入れていない）: ${reasonOf(error)}` },
              400,
            );
          }

          // プレビューの時点の同じ名前の SHA（無ければ null）と、いまのを突き合わせる。違えば入れずに断る（古いプレビューでの巻き戻し・見せていない置き換えを止める。#4797）
          const previewedSha = pluginPreviews.existingShaOf(previewId) ?? null;
          const previous = (await deps.stores.plugins.list()).find((p) => p.name === fetched.name);
          if ((previous?.source.sha ?? null) !== previewedSha) {
            return c.json(
              {
                error:
                  'プレビューの後に、同じ名前の plugin が変わった（または入った・消えた）。もう一度プレビューしてから確定すること',
              },
              409,
            );
          }
          const previousText =
            previous === undefined ? '新規' : `置き換え（前の SHA: ${previous.source.sha}）`;
          const flags = `scope: ${scope}、hooks: ${enableHooks ? '有効' : '無効'}、.mcp.json: ${enableMcp ? '有効' : '無効'}`;
          const actor = describeActor(c.get('principal'));

          try {
            await deps.stores.journal.append({
              type: 'decision',
              decision: `plugin を入れようとしている（${fetched.name}）`,
              grounds:
                `${actor}（POST /plugins）。取り元: ${describePluginSource(fetched.source)}。` +
                `${flags}。${previousText}。中身は書かない。`,
            });
          } catch (error) {
            noteDroppedRecord(
              'plugin を入れる日誌（入れていない）',
              `name=${fetched.name}`,
              kindOfError(error),
            );
            return c.json(journalWriteFailedBody(), 500);
          }

          let stored;
          try {
            stored = await deps.stores.plugins.put(input);
          } catch (error) {
            await appendJournalOrDrop(
              deps.stores,
              {
                type: 'decision',
                decision: `plugin を入れられなかった（${fetched.name}）`,
                grounds: `${actor}（POST /plugins、状態の変更が失敗）`,
              },
              'plugin を入れる打ち消しの日誌',
              `name=${fetched.name}`,
            );
            if (error instanceof PluginNameConflictError) {
              return c.json({ error: reasonOf(error) }, 409);
            }
            throw error;
          }
          pluginPreviews.discard(previewId);

          const applied = await applyPlugins(deps);
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: `plugin を入れた（${fetched.name}）`,
              grounds:
                `${actor}（POST /plugins）。取り元: ${describePluginSource(fetched.source)}。` +
                `${flags}。runner への配布: ${describePluginDelivery(applied.runners)}。`,
            },
            'plugin を入れた日誌',
            `name=${fetched.name}`,
          );
          return c.json(
            pluginInstallResponseSchema.parse({
              plugin: stored,
              appliesFrom:
                'クローンの次のセッションから。マネージャー・作業者は、配布できた runner で次に開くセッションから',
              runners: applied.runners,
            }),
          );
        },
      )

      .delete(
        '/plugins/:name',
        describeRoute({
          tags: ['plugins'],
          summary: 'plugin を外す',
          responses: {
            200: jsonResponse(
              '外した plugin の名前と、runner ごとの配布結果。',
              pluginRemoveResponseSchema,
            ),
            403: errorResponse(NO_ACCESS_GRANT_DESCRIPTION),
            404: errorResponse('その名前の plugin は入っていない。'),
            500: journalWriteFailedResponse('日誌が書けなかったので外していない。'),
          },
        }),
        async (c) => {
          const name = c.req.param('name');
          if (!isValidPluginName(name))
            return c.json({ error: `plugin ${name} は入っていない` }, 404);
          // `list()` は壊れた行が1つあると全体が投げるので使わない: `get` の失敗は「取り元不明」として外せるようにする（外せない壊れた行が残り続けない）。在るかは `remove()` の戻り値で決める。
          let found: Awaited<ReturnType<typeof deps.stores.plugins.get>> | 'unreadable';
          try {
            found = await deps.stores.plugins.get(name);
          } catch {
            found = 'unreadable';
          }
          if (found === null) return c.json({ error: `plugin ${name} は入っていない` }, 404);
          const actor = describeActor(c.get('principal'));
          const flags =
            found === 'unreadable'
              ? '取り元不明（行を読めなかった）'
              : `scope: ${found.scope}、取り元: ${describePluginSource(found.source)}`;

          // 日誌を先に書き、書けなければ消さずに 500: 記録の無い変更を作らない。
          try {
            await deps.stores.journal.append({
              type: 'decision',
              decision: `plugin を外そうとしている（${name}）`,
              grounds: `${actor}（DELETE /plugins/:name）。${flags}。`,
            });
          } catch (error) {
            noteDroppedRecord(
              'plugin を外す日誌（外していない）',
              `name=${name}`,
              kindOfError(error),
            );
            return c.json(journalWriteFailedBody(), 500);
          }

          let removed: boolean;
          try {
            removed = await deps.stores.plugins.remove(name);
          } catch (error) {
            await appendJournalOrDrop(
              deps.stores,
              {
                type: 'decision',
                decision: `plugin を外せなかった（${name}）`,
                grounds: `${actor}（DELETE /plugins/:name、状態の変更が失敗）`,
              },
              'plugin を外す打ち消しの日誌',
              `name=${name}`,
            );
            throw error;
          }
          if (!removed) return c.json({ error: `plugin ${name} は入っていない` }, 404);

          const applied = await applyPlugins(deps);
          await appendJournalOrDrop(
            deps.stores,
            {
              type: 'decision',
              decision: `plugin を外した（${name}）`,
              grounds:
                `${actor}（DELETE /plugins/:name）。${flags}。` +
                `runner への配布: ${describePluginDelivery(applied.runners)}。`,
            },
            'plugin を外した日誌',
            `name=${name}`,
          );
          return c.json(
            pluginRemoveResponseSchema.parse({
              name,
              appliesFrom:
                'クローンの次のセッションから。マネージャー・作業者は、配布できた runner で次に開くセッションから',
              runners: applied.runners,
            }),
          );
        },
      )
  );
}
