import { readFileSync, writeFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { fingerprintOf } from './credentials.js';
import { createCredentialService } from './credential-service.js';
import { createDelegatedPermissionRuleService } from './delegated-permission-rules.js';
import { setStderrSinkForTesting } from './dropped-record.js';
import { createMcpServerService } from './mcp-server-service.js';
import { createPluginDistributionService } from './plugin-distribution-service.js';
import type { PluginInput } from './plugins.js';
import type { PreparedProfile, ProfileApplier } from './profile.js';
import { composeProfileScript, createProfileService } from './profile-service.js';
import { fakeRunnerClient } from './runner-client.test-support.js';
import type { RunnerClient, RunnerRegistry } from './runner-protocol.js';
import { fakeRunnerRegistry } from './runner-registry.test-support.js';
import type { PermissionGrant } from './schema.js';
import type { Stores } from './store.js';
import { createMemoryStores } from './testing.js';

// 配布サービス5つ（credential-service・profile-service・mcp-server-service・plugin-distribution-service・delegated-permission-rules）の
// 振る舞いを、場面ごとにコミットした固定値（push-services-behavior-pin.json）と丸ごと比べる。
// 5つは同じ骨格（apply で保存して配る・syncRunner で名乗りに合わせる・runner ごとの結果を集めて onPushed で知らせる）を別々に持っているので、
// 骨格をまとめるときに、呼びの並び・返り値・日誌・stderr・購読の結果が1文字も変わらないことを機械で確かめる歯。
//
// 記録するもの（場面ごと）:
//   - out: 返り値（apply の結果・syncRunner の戻り・pushAll の結果。投げたときは名前と文言）。HTTP の応答になる値
//   - events: 呼びの並び。偽の runner・ストア・日誌・名簿・適用器への呼びを、呼び始め（`>`）と戻り（`<`）の両方で並べる。
//     各行の頭の数字は「マイクロタスクの世代」（`ticks`）: 場面の間ずっと自分を積み直すマイクロタスクを1本回し、世代を数えている。
//     サービスの中の await が1段増える・減ると、後ろの呼びの数字が1つ動くので、await の段が固定値に写る
//   - journal: 日誌へ足された行の全文（種類・本文・grounds・id・at）
//   - stderr: 握って stderr へ出た行の全文
//   - onPushed の知らせは events に `onPushed …`（permission rules は `unnamed` の印つき）として並ぶ
//
// 固定値の作り直し（意図して振る舞いを変えたときだけ。PR 本文に理由を書く）:
//   UPDATE_PUSH_SERVICES_PIN=1 pnpm -C <作業ツリー> --filter @alteroid/core exec vitest run src/push-services-behavior-pin.test.ts --maxWorkers=2
//   pnpm -C <作業ツリー> exec prettier --write packages/core/src/push-services-behavior-pin.json
// 手で json を書き換えない。作り直したら `git diff` で、どの場面の何が動いたかを読む。
//
// 時計は Date だけを固定する（実時間の待ちは使わない）。秘密: 値はすべて作りもの（FAKE_…）。json に長い [A-Za-z0-9_./@-] の連続を作らない
// （`scripts/agents-md-references.test.ts` の走査が二乗の時間になる）。

const BASE_ISO = '2026-11-08T00:00:00.000Z';
const PIN_URL = new URL('./push-services-behavior-pin.json', import.meta.url);
const UPDATE = process.env.UPDATE_PUSH_SERVICES_PIN === '1';

interface Ev {
  t: number;
  e: string;
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function show(value: unknown): string {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (item === undefined) return '<undefined>';
    if (typeof item === 'function') return '<fn>';
    // 長い文字列は長さに畳む（json に長い連続を作らない）
    if (typeof item === 'string' && item.length > 100) return `<str ${String(item.length)} chars>`;
    if (item instanceof Uint8Array) return `<bytes ${String(item.byteLength)}>`;
    if (
      typeof item === 'object' &&
      item !== null &&
      (item as { type?: unknown }).type === 'Buffer' &&
      Array.isArray((item as { data?: unknown }).data)
    ) {
      return `<bytes ${String((item as { data: unknown[] }).data.length)}>`;
    }
    return item;
  });
  if (text === undefined) return 'undefined';
  return text.length > 500 ? `${text.slice(0, 500)}…(${String(text.length)})` : text;
}

async function settle(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return { ok: await run() };
  } catch (error) {
    return { threw: { name: nameOf(error), message: messageOf(error) } };
  }
}

interface FailRule {
  error: Error;
  /** 1 から数えて n 回目の呼びだけ落とす。無ければ毎回 */
  nth?: number;
}

class Ctx {
  readonly base = createMemoryStores();
  readonly ev: Ev[] = [];
  tick = 0;
  readonly fails = new Map<string, FailRule>();
  readonly counts = new Map<string, number>();

  log(e: string): void {
    this.ev.push({ t: this.tick, e });
  }

  fail(op: string, message: string, nth?: number): void {
    this.fails.set(op, { error: new Error(message), ...(nth === undefined ? {} : { nth }) });
  }

  /** `prefix.name` の名前で、呼び始めと戻りを events に並べる。`fail` で指した呼びは呼び始めの後に落とす */
  trace<T extends object>(prefix: string, target: T, names: readonly string[]): T {
    const out = { ...target } as Record<string, unknown>;
    for (const name of names) {
      const fn = (target as Record<string, (...args: unknown[]) => unknown>)[name];
      if (typeof fn !== 'function') throw new Error(`${prefix}.${name} が無い`);
      const op = `${prefix}.${name}`;
      out[name] = async (...args: unknown[]) => {
        const count = (this.counts.get(op) ?? 0) + 1;
        this.counts.set(op, count);
        this.log(`> ${op} ${show(args)}`);
        try {
          const rule = this.fails.get(op);
          if (rule !== undefined && (rule.nth === undefined || rule.nth === count))
            throw rule.error;
          const result = await fn.apply(target, args);
          this.log(`< ${op} ${show(result)}`);
          return result;
        } catch (error) {
          this.log(`< ${op} threw ${nameOf(error)}: ${messageOf(error)}`);
          throw error;
        }
      };
    }
    return out as T;
  }

  stores(): Stores {
    const b = this.base;
    return {
      ...b,
      credentials: this.trace('credentials', b.credentials, [
        'list',
        'put',
        'updatePendingRemovals',
        'listPendingRemovals',
      ]),
      mcpServers: this.trace('mcpServers', b.mcpServers, ['read', 'write']),
      plugins: this.trace('plugins', b.plugins, ['list', 'get']),
      profile: this.trace('profile', b.profile, ['list', 'set', 'remove', 'clear', 'replaceAll']),
      permissionGrants: this.trace('permissionGrants', b.permissionGrants, ['list']),
      journal: this.trace('journal', b.journal, ['append']),
    };
  }

  runner(id: string, overrides: Partial<RunnerClient> = {}): RunnerClient {
    const runner = fakeRunnerClient({ runnerId: id, ...overrides });
    return this.trace(id, runner, [
      'credentials',
      'setCredentials',
      'profile',
      'setProfile',
      'mcpServers',
      'setMcpServers',
      'plugins',
      'setPlugin',
      'retainPlugins',
      'setPermissionRules',
    ]);
  }

  registry(runners: readonly RunnerClient[]): RunnerRegistry {
    return fakeRunnerRegistry({
      list: async () => {
        this.log('> registry.list');
        const rule = this.fails.get('registry.list');
        if (rule !== undefined) {
          this.log(`< registry.list threw Error: ${rule.error.message}`);
          throw rule.error;
        }
        this.log(`< registry.list ${String(runners.length)} runners`);
        return [...runners];
      },
    });
  }

  watch(
    subscribe: (listener: (results: readonly unknown[], scope?: unknown) => void) => () => void,
  ): void {
    subscribe((results, scope) => {
      this.log(`onPushed ${show(results)}${scope === undefined ? '' : ` scope=${show(scope)}`}`);
    });
  }
}

interface Scenario {
  name: string;
  /** 通る分岐の覚え書き（読み手のため。判定には使わない） */
  covers: string;
  run: (c: Ctx) => Promise<unknown>;
}

// ---- 材料（作りものだけ） ----

const FAKE = 'FAKE_NOT_A_REAL_VALUE';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const cfp = (name: string, sha: string) => ({ name, sha256: sha, updatedAt: BASE_ISO });
const mfp = (sha: string, names: string[]) => ({ sha256: sha, names, updatedAt: BASE_ISO });
const pfp = (sha: string) => ({ sha256: sha, bytes: 10, updatedAt: BASE_ISO });
const pluginFp = (name: string, sha: string, contentSha256 = 'c1') => ({
  name,
  sha,
  contentSha256,
  enableHooks: true,
  enableMcp: true,
});

function pluginInput(name: string, overrides: Partial<PluginInput> = {}): PluginInput {
  return {
    name,
    source: { kind: 'url', url: 'https://example.invalid/plugins.git', sha: SHA_A },
    scope: 'all',
    files: [
      {
        path: '.claude-plugin/plugin.json',
        executable: false,
        content: Buffer.from('dummy-content'),
      },
    ],
    installedAt: BASE_ISO,
    installedBy: 'tester',
    ...overrides,
  } as PluginInput;
}

function grant(id: string, rule: string, extra: Partial<PermissionGrant> = {}): PermissionGrant {
  return {
    id,
    rule,
    allows: ['x'],
    denies: ['y'],
    approvalId: `ap-${id}`,
    answer: '許可します',
    grantedAt: BASE_ISO,
    route: { principalKind: 'account', accountId: 'acc-1' },
    ...extra,
  };
}

const SERVERS = { github: { command: 'gh-mcp', env: { GITHUB_TOKEN: FAKE } } };
const SERVERS_2 = { linear: { command: 'linear-mcp', env: { LINEAR_TOKEN: FAKE } } };

// ---- credential ----

function credService(
  c: Ctx,
  runners: readonly RunnerClient[] | null,
  options: { onAppliedThrows?: boolean } = {},
) {
  const service = createCredentialService({
    stores: c.stores(),
    ...(runners === null ? {} : { runners: c.registry(runners) }),
    withheldEnvKeys: ['WITHHELD_KEY'],
    onApplied: (names) => {
      c.log(`onApplied ${show(names)}`);
      if (options.onAppliedThrows === true) throw new Error('畳み直しの印を立てられない（test）');
    },
  });
  c.watch((listener) => service.onPushed(listener));
  return service;
}

const CRED_SCENARIOS: Scenario[] = [
  {
    name: 'credential/apply-no-runners',
    covers: '名簿が無い構成: 正本へ置くだけ。runners は空。onApplied にクローン側の名前',
    run: async (c) => {
      const service = credService(c, null);
      return settle(() => service.apply([{ name: 'GH_TOKEN', value: `${FAKE}_A` }]));
    },
  },
  {
    name: 'credential/apply-two-runners',
    covers:
      '2台へ並行に配る（範囲 app の行は runner へ載せない・非シークレットの行は値つきの指紋）。runner ごとの指紋が結果と onPushed に並ぶ',
    run: async (c) => {
      const a = c.runner('runner-a', { setCredentials: async () => [cfp('GH_TOKEN', 'sha-a')] });
      const b = c.runner('runner-b', { setCredentials: async () => [cfp('GH_TOKEN', 'sha-b')] });
      const service = credService(c, [a, b]);
      return settle(() =>
        service.apply([
          { name: 'GH_TOKEN', value: `${FAKE}_A` },
          { name: 'APP_ONLY', value: `${FAKE}_B`, scope: 'app' },
          { name: 'PLAIN_NAME', value: 'plain', secret: false },
        ]),
      );
    },
  },
  {
    name: 'credential/apply-one-runner-fails',
    covers: '1台が落ちる: その runner だけ ok:false（理由は1行）。もう1台は ok。onPushed に両方',
    run: async (c) => {
      const a = c.runner('runner-a', { setCredentials: async () => [cfp('GH_TOKEN', 'sha-a')] });
      const b = c.runner('runner-b', {
        setCredentials: async () => {
          throw new Error('runner b is down');
        },
      });
      const service = credService(c, [a, b]);
      return settle(() => service.apply([{ name: 'GH_TOKEN', value: `${FAKE}_A` }]));
    },
  },
  {
    name: 'credential/apply-removal',
    covers:
      '外す指示（value が空）: 正本から消え、runner へは value 空で配る。外した名前は updatePendingRemovals の add に覚える',
    run: async (c) => {
      await c.base.credentials.put([{ name: 'GH_TOKEN', value: `${FAKE}_A` }]);
      const a = c.runner('runner-a', { setCredentials: async () => [] });
      const service = credService(c, [a]);
      return settle(() => service.apply([{ name: 'GH_TOKEN', value: '' }]));
    },
  },
  {
    name: 'credential/apply-narrowed-scope',
    covers:
      '範囲を runner に配らない側へ狭めた行（all → app）: runner へは外す合図（value 空）を送る。pending に add',
    run: async (c) => {
      await c.base.credentials.put([{ name: 'GH_TOKEN', value: `${FAKE}_A`, scope: 'all' }]);
      const a = c.runner('runner-a', { setCredentials: async () => [] });
      const service = credService(c, [a]);
      return settle(() => service.apply([{ name: 'GH_TOKEN', value: `${FAKE}_B`, scope: 'app' }]));
    },
  },
  {
    name: 'credential/apply-rejections',
    covers:
      '保存の検査で断る8通り（空の一覧・名前の形・伏せる鍵・プール所有・環境変数所有・重複・長すぎる名前・secret の後からの変更）: 投げる。runner へは何も呼ばず、正本も変えない（list だけ）',
    run: async (c) => {
      await c.base.credentials.put([{ name: 'SECRETISH', value: `${FAKE}_S`, secret: true }]);
      const a = c.runner('runner-a');
      const service = credService(c, [a]);
      const out: unknown[] = [];
      const attempts: {
        name: string;
        entries: { name: string; value: string; secret?: boolean }[];
      }[] = [
        { name: 'empty', entries: [] },
        { name: 'bad-name', entries: [{ name: 'lower', value: 'x' }] },
        { name: 'withheld', entries: [{ name: 'WITHHELD_KEY', value: 'x' }] },
        { name: 'pool-owned', entries: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'x' }] },
        { name: 'env-file-owned', entries: [{ name: 'ALTEROID_PUBLIC_URL', value: 'x' }] },
        {
          name: 'duplicate',
          entries: [
            { name: 'DUP_NAME', value: 'x' },
            { name: 'DUP_NAME', value: 'y' },
          ],
        },
        { name: 'too-long', entries: [{ name: 'A'.repeat(129), value: 'x' }] },
        { name: 'secret-change', entries: [{ name: 'SECRETISH', value: 'x', secret: false }] },
      ];
      for (const attempt of attempts) {
        out.push({
          name: attempt.name,
          ...((await settle(() => service.apply(attempt.entries))) as object),
        });
      }
      return out;
    },
  },
  {
    name: 'credential/apply-overlong-stderr',
    covers:
      '正本に長すぎる名前の行が残っている: apply のたびに調べ、名前の組が変わったときだけ stderr に1行（2回目は出ない）。その行は runner へ配らない',
    run: async (c) => {
      await c.base.credentials.put([{ name: 'B'.repeat(129), value: `${FAKE}_L` }]);
      const a = c.runner('runner-a', { setCredentials: async () => [] });
      const service = credService(c, [a]);
      const first = await settle(() => service.apply([{ name: 'GH_TOKEN', value: `${FAKE}_A` }]));
      const second = await settle(() => service.apply([{ name: 'GH_TOKEN', value: `${FAKE}_B` }]));
      return { first, second };
    },
  },
  {
    name: 'credential/apply-on-applied-throws',
    covers:
      'onApplied（クローンの畳み直しの印）が投げても apply は成功のまま返す（例外は握る）。配布が失敗してもクローンへは知らせる',
    run: async (c) => {
      const a = c.runner('runner-a', {
        setCredentials: async () => {
          throw new Error('runner a is down');
        },
      });
      const service = credService(c, [a], { onAppliedThrows: true });
      return settle(() => service.apply([{ name: 'GH_TOKEN', value: `${FAKE}_A` }]));
    },
  },
  {
    name: 'credential/apply-store-failures',
    covers:
      '保存（put）が落ちる: 配らず投げる。updatePendingRemovals が落ちる: 保存済みのまま配らず投げる',
    run: async (c) => {
      const a = c.runner('runner-a', { setCredentials: async () => [] });
      const service = credService(c, [a]);
      c.fail('credentials.put', 'put が落ちた（test）');
      const putFails = await settle(() =>
        service.apply([{ name: 'GH_TOKEN', value: `${FAKE}_A` }]),
      );
      c.fails.delete('credentials.put');
      c.fail('credentials.updatePendingRemovals', 'pending が書けない（test）');
      const pendingFails = await settle(() =>
        service.apply([{ name: 'GH_TOKEN', value: `${FAKE}_B` }]),
      );
      return { putFails, pendingFails };
    },
  },
  {
    name: 'credential/apply-roster-fails',
    covers:
      '名簿（runners.list）が落ちる: 保存は済み、配る段で投げる（apply が失敗する）。onPushed には何も知らせない',
    run: async (c) => {
      const service = credService(c, [c.runner('runner-a')]);
      c.fail('registry.list', '名簿が引けない（test）');
      return settle(() => service.apply([{ name: 'GH_TOKEN', value: `${FAKE}_A` }]));
    },
  },
  {
    name: 'credential/sync-nothing',
    covers: '正本に行も外す名前も無い: runner の指紋を読まずに null',
    run: async (c) => {
      const a = c.runner('runner-a');
      const service = credService(c, []);
      return settle(() => service.syncRunner(a));
    },
  },
  {
    name: 'credential/sync-match',
    covers: '指紋が一致: 降ろさず null',
    run: async (c) => {
      await c.base.credentials.put([{ name: 'GH_TOKEN', value: `${FAKE}_A` }]);
      const a = c.runner('runner-a', {
        credentials: async () => [cfp('GH_TOKEN', fingerprintOf(`${FAKE}_A`))],
      });
      const service = credService(c, []);
      return settle(() => service.syncRunner(a));
    },
  },
  {
    name: 'credential/sync-behind',
    covers: '指紋が違う行・runner に無い行だけを降ろす（差の分だけ送る）',
    run: async (c) => {
      await c.base.credentials.put([
        { name: 'GH_TOKEN', value: `${FAKE}_A` },
        { name: 'NPM_TOKEN', value: `${FAKE}_N` },
      ]);
      const a = c.runner('runner-a', {
        credentials: async () => [cfp('GH_TOKEN', 'old-sha')],
        setCredentials: async () => [cfp('GH_TOKEN', 'new-sha')],
      });
      const service = credService(c, []);
      return settle(() => service.syncRunner(a));
    },
  },
  {
    name: 'credential/sync-unreadable',
    covers: 'runner の指紋が読めない（credentials が投げる）: 差がある側に倒して全部降ろす',
    run: async (c) => {
      await c.base.credentials.put([{ name: 'GH_TOKEN', value: `${FAKE}_A` }]);
      const a = c.runner('runner-a', {
        credentials: async () => {
          throw new Error('指紋が読めない（test）');
        },
        setCredentials: async () => [],
      });
      const service = credService(c, []);
      return settle(() => service.syncRunner(a));
    },
  },
  {
    name: 'credential/sync-pending-removals',
    covers:
      '外した名前の外し直し: runner がまだ持っていれば value 空で送る。持っていなければ空振りで null（持っているかの確認だけ）',
    run: async (c) => {
      await c.base.credentials.updatePendingRemovals({ add: ['OLD_TOKEN'], forget: [] });
      const holds = c.runner('runner-holds', {
        credentials: async () => [cfp('OLD_TOKEN', 'sha-old')],
        setCredentials: async () => [],
      });
      const empty = c.runner('runner-empty', { credentials: async () => [] });
      const service = credService(c, []);
      const first = await settle(() => service.syncRunner(holds));
      const second = await settle(() => service.syncRunner(empty));
      return { first, second };
    },
  },
];

// ---- profile ----

function fakeApplier(
  c: Ctx,
  options: { prepareOk?: boolean; commitFails?: boolean } = {},
): ProfileApplier {
  const prepared = (script: string): PreparedProfile => ({
    ok: options.prepareOk !== false,
    ...(options.prepareOk === false ? { error: '構文が壊れている（test）' } : {}),
    commit: async () => {
      c.log(`> applier.commit ${show(script)}`);
      if (options.commitFails === true) throw new Error('クローンへ反映できない（test）');
      return undefined;
    },
    discard: async () => {
      c.log('> applier.discard');
    },
  });
  return {
    prepare: async (script: string) => {
      c.log(`> applier.prepare ${show(script)}`);
      return prepared(script);
    },
    apply: async (script: string) => {
      c.log(`> applier.apply ${show(script)}`);
      return { ok: true };
    },
  } as unknown as ProfileApplier;
}

function profileService(c: Ctx, runners: readonly RunnerClient[] | null, applier?: ProfileApplier) {
  const service = createProfileService({
    stores: c.stores(),
    ...(runners === null ? {} : { runners: c.registry(runners) }),
    ...(applier === undefined ? {} : { applier }),
  });
  c.watch((listener) => service.onPushed(listener));
  return service;
}

const PROFILE_SCENARIOS: Scenario[] = [
  {
    name: 'profile/set-bare',
    covers: '適用器も名簿も無い構成: 保存だけ。clone は ok:true、runners は空',
    run: async (c) => {
      const service = profileService(c, null);
      return settle(() => service.set('base', 'export FAKE_A=1'));
    },
  },
  {
    name: 'profile/set-two-runners',
    covers:
      '2台へ配る（本文は runner 向けに合成）。結果の runner ごとの欄（指紋・ok）と composed の指紋',
    run: async (c) => {
      const a = c.runner('runner-a', {
        setProfile: async () => ({ ok: true, profile: pfp('pa') }),
      });
      const b = c.runner('runner-b', {
        setProfile: async () => ({ ok: true, profile: pfp('pb'), names: ['FAKE_A'] }),
      });
      const service = profileService(c, [a, b]);
      return settle(() => service.set('base', 'export FAKE_A=1'));
    },
  },
  {
    name: 'profile/set-runner-failures',
    covers:
      '1台は投げる（ok:false・理由は1行）、1台は ok:false の結果を返す（error・output を伏せ字を通して載せる）。onPushed に両方',
    run: async (c) => {
      const a = c.runner('runner-a', {
        setProfile: async () => {
          throw new Error('runner a is down');
        },
      });
      const b = c.runner('runner-b', {
        setProfile: async () => ({ ok: false, error: '評価に落ちた（test）', output: 'line 1' }),
      });
      const service = profileService(c, [a, b]);
      return settle(() => service.set('base', 'export FAKE_A=1'));
    },
  },
  {
    name: 'profile/set-with-applier',
    covers:
      '適用器あり: prepare → 保存（set）→ commit → 配る → 読み直し（list）の並び。clone の欄は prepare の結果',
    run: async (c) => {
      const a = c.runner('runner-a', { setProfile: async () => ({ ok: true }) });
      const service = profileService(c, [a], fakeApplier(c));
      return settle(() => service.set('base', 'export FAKE_A=1', 'all'));
    },
  },
  {
    name: 'profile/set-prepare-rejects',
    covers:
      '適用器の評価に落ちる（prepare が ok:false）: discard して stored:false を返す。保存も配布もしない',
    run: async (c) => {
      const a = c.runner('runner-a');
      const service = profileService(c, [a], fakeApplier(c, { prepareOk: false }));
      return settle(() => service.set('base', 'export FAKE_A=(('));
    },
  },
  {
    name: 'profile/set-write-fails',
    covers:
      '正本へ書けない（set が落ちる）: discard → replaceAll(previous) で戻して投げる。配らない',
    run: async (c) => {
      const a = c.runner('runner-a');
      const service = profileService(c, [a], fakeApplier(c));
      c.fail('profile.set', '正本へ書けない（test）');
      return settle(() => service.set('base', 'export FAKE_A=1'));
    },
  },
  {
    name: 'profile/set-commit-fails',
    covers:
      'クローンへの反映（commit）が落ちる: discard → replaceAll で正本を戻し、「正本も元へ戻した」エラーを投げる。配らない',
    run: async (c) => {
      const a = c.runner('runner-a');
      const service = profileService(c, [a], fakeApplier(c, { commitFails: true }));
      return settle(() => service.set('base', 'export FAKE_A=1'));
    },
  },
  {
    name: 'profile/set-commit-fails-rollback-fails',
    covers:
      'commit が落ち、正本を戻すことも落ちる: ProfileRollbackFailedError（両方の理由）を投げる',
    run: async (c) => {
      const a = c.runner('runner-a');
      const service = profileService(c, [a], fakeApplier(c, { commitFails: true }));
      c.fail('profile.replaceAll', '戻せない（test）');
      return settle(() => service.set('base', 'export FAKE_A=1'));
    },
  },
  {
    name: 'profile/set-input-rejections',
    covers:
      '入力の検査で断る4通り（名前の形・空の本文・ifMatch の版違い・大文字小文字だけが違う行）: 投げる。保存も配布もしない',
    run: async (c) => {
      await c.base.profile.set('existing', 'export FAKE_E=1', 'all');
      const a = c.runner('runner-a');
      const service = profileService(c, [a]);
      const out: unknown[] = [];
      out.push({
        name: 'bad-name',
        ...((await settle(() => service.set('bad name!', 'x'))) as object),
      });
      out.push({
        name: 'empty',
        ...((await settle(() => service.set('base', '  \n '))) as object),
      });
      out.push({
        name: 'if-match-stale',
        ...((await settle(() =>
          service.set('existing', 'export FAKE_E=2', undefined, { ifMatch: 'stale-version' }),
        )) as object),
      });
      out.push({
        name: 'case-clash',
        ...((await settle(() => service.set('EXISTING', 'export FAKE_E=3'))) as object),
      });
      return out;
    },
  },
  {
    name: 'profile/remove-and-clear',
    covers: '行を外す（在る・無い）→ 全部外す。外した後の本文（空）を配る。removed の真偽',
    run: async (c) => {
      await c.base.profile.set('one', 'export FAKE_1=1', 'all');
      await c.base.profile.set('two', 'export FAKE_2=2', 'runner');
      const a = c.runner('runner-a', { setProfile: async () => ({ ok: true }) });
      const service = profileService(c, [a]);
      const removed = await settle(() => service.remove('one'));
      const missing = await settle(() => service.remove('ghost'));
      const cleared = await settle(() => service.clearAll());
      return { removed, missing, cleared };
    },
  },
  {
    name: 'profile/apply-whole-script',
    covers: 'apply: 空の本文は全部外す、中身があれば default 1行に置き換える',
    run: async (c) => {
      const a = c.runner('runner-a', { setProfile: async () => ({ ok: true }) });
      const service = profileService(c, [a]);
      const filled = await settle(() => service.apply('export FAKE_A=1'));
      const emptied = await settle(() => service.apply(''));
      return { filled, emptied };
    },
  },
  {
    name: 'profile/roster-fails',
    covers:
      '名簿が読めない: 保存・クローンは済んでいるので投げず、runnersUnconfirmed に（伏せた）理由。runners は空で、onPushed には知らせない',
    run: async (c) => {
      const service = profileService(c, [c.runner('runner-a')]);
      c.fail('registry.list', '名簿が引けない（test）');
      return settle(() => service.set('base', 'export FAKE_A=1'));
    },
  },
  {
    name: 'profile/read-after-write-fails',
    covers: '保存後の読み直し（list）が落ちる: 書いた行（rows）で代用して返す',
    run: async (c) => {
      const service = profileService(c, null);
      // 1回目の list は更新前の読み。2回目（保存後の読み直し）だけ落とす
      c.fail('profile.list', '読み直せない（test）', 2);
      return settle(() => service.set('base', 'export FAKE_A=1'));
    },
  },
  {
    name: 'profile/restore',
    covers:
      'restore: 適用器が無ければ null。あれば合成した clone 向けの本文を適用器へ。行も本文も無ければ null',
    run: async (c) => {
      const bare = profileService(c, null);
      const noApplier = await settle(() => bare.restore());
      const empty = profileService(c, null, fakeApplier(c));
      const nothing = await settle(() => empty.restore());
      await c.base.profile.set('base', 'export FAKE_A=1', 'all');
      const filled = await settle(() => empty.restore());
      return { noApplier, nothing, filled };
    },
  },
  {
    name: 'profile/sync-nothing',
    covers: '行が無く runner も何も持っていない: null（読めて、空と一致）',
    run: async (c) => {
      const a = c.runner('runner-a');
      const service = profileService(c, null);
      return settle(() => service.syncRunner(a));
    },
  },
  {
    name: 'profile/sync-match',
    covers: '指紋が一致: 降ろさず null',
    run: async (c) => {
      await c.base.profile.set('base', 'export FAKE_A=1', 'all');
      const rows = await c.base.profile.list();
      const script = composeProfileScript(rows, 'runner');
      const a = c.runner('runner-a', { profile: async () => pfpOf(script) });
      const service = profileService(c, null);
      return settle(() => service.syncRunner(a));
    },
  },
  {
    name: 'profile/sync-different-and-removed',
    covers:
      '指紋が違う: 全文を降ろす。行が無いのに runner が持っている（外したはずのプロファイルが残る）: 空の本文を降ろす',
    run: async (c) => {
      const differing = c.runner('runner-differs', {
        profile: async () => pfp('old-sha'),
        setProfile: async () => ({ ok: true }),
      });
      const stale = c.runner('runner-stale', {
        profile: async () => pfp('left-over'),
        setProfile: async () => ({ ok: true }),
      });
      const service = profileService(c, null);
      await c.base.profile.set('base', 'export FAKE_A=1', 'all');
      const diff = await settle(() => service.syncRunner(differing));
      await c.base.profile.clear();
      const removed = await settle(() => service.syncRunner(stale));
      return { diff, removed };
    },
  },
  {
    name: 'profile/sync-unreadable',
    covers: 'runner の指紋が読めない: 一致扱いにせず降ろす（行が無くても空を降ろす）',
    run: async (c) => {
      const a = c.runner('runner-a', {
        profile: async () => {
          throw new Error('指紋が読めない（test）');
        },
        setProfile: async () => ({ ok: true }),
      });
      const service = profileService(c, null);
      return settle(() => service.syncRunner(a));
    },
  },
];

function pfpOf(script: string) {
  return { sha256: fingerprintOf(script), bytes: Buffer.byteLength(script), updatedAt: BASE_ISO };
}

// ---- mcp ----

function mcpService(c: Ctx, runners: readonly RunnerClient[] | null) {
  const service = createMcpServerService({
    stores: c.stores(),
    ...(runners === null ? {} : { runners: c.registry(runners) }),
  });
  c.watch((listener) => service.onPushed(listener));
  return service;
}

const MCP_SCENARIOS: Scenario[] = [
  {
    name: 'mcp/apply-no-runners',
    covers: '名簿が無い構成: 保存だけ。runners は空。名前と指紋（sha256）と版を返す',
    run: async (c) => settle(() => mcpService(c, null).apply(SERVERS)),
  },
  {
    name: 'mcp/apply-two-runners',
    covers: '2台へ並行に配る。runner ごとの指紋が結果と onPushed に並ぶ',
    run: async (c) => {
      const a = c.runner('runner-a', { setMcpServers: async () => mfp('ma', ['github']) });
      const b = c.runner('runner-b', { setMcpServers: async () => mfp('mb', ['github']) });
      return settle(() => mcpService(c, [a, b]).apply(SERVERS));
    },
  },
  {
    name: 'mcp/apply-one-runner-fails',
    covers: '1台が落ちる: その runner だけ ok:false。もう1台は ok',
    run: async (c) => {
      const a = c.runner('runner-a', { setMcpServers: async () => mfp('ma', ['github']) });
      const b = c.runner('runner-b', {
        setMcpServers: async () => {
          throw new Error('runner b is down');
        },
      });
      return settle(() => mcpService(c, [a, b]).apply(SERVERS));
    },
  },
  {
    name: 'mcp/apply-empty-removes',
    covers: '空の登録（外す）: names は空で sha256 は付かない。runner へも空を配る',
    run: async (c) => {
      await c.base.mcpServers.write(SERVERS);
      const a = c.runner('runner-a', { setMcpServers: async () => undefined });
      return settle(() => mcpService(c, [a]).apply({}));
    },
  },
  {
    name: 'mcp/apply-no-fingerprint-back',
    covers:
      'runner の置いた結果が指紋を返さない（undefined）: ok:true で mcpServers の欄は付かない',
    run: async (c) => {
      const a = c.runner('runner-a', { setMcpServers: async () => undefined });
      return settle(() => mcpService(c, [a]).apply(SERVERS));
    },
  },
  {
    name: 'mcp/apply-store-rejects',
    covers:
      '正本への書き込みが断られる（store が投げる／ifMatch の版違い）: 配らず投げる。runner へは何も呼ばない',
    run: async (c) => {
      await c.base.mcpServers.write(SERVERS);
      const a = c.runner('runner-a');
      const service = mcpService(c, [a]);
      c.fail('mcpServers.write', '書き込みが断られた（test）', 1);
      const rejected = await settle(() => service.apply(SERVERS_2));
      const stale = await settle(() => service.apply(SERVERS_2, { ifMatch: 'stale-version' }));
      return { rejected, stale };
    },
  },
  {
    name: 'mcp/apply-roster-fails',
    covers: '名簿が落ちる: 保存は済み、配る段で投げる。onPushed には何も知らせない',
    run: async (c) => {
      const service = mcpService(c, [c.runner('runner-a')]);
      c.fail('registry.list', '名簿が引けない（test）');
      return settle(() => service.apply(SERVERS));
    },
  },
  {
    name: 'mcp/sync-nothing',
    covers: '正本に登録が無く runner も何も持っていない: null',
    run: async (c) => {
      const a = c.runner('runner-a');
      return settle(() => mcpService(c, null).syncRunner(a));
    },
  },
  {
    name: 'mcp/sync-match',
    covers: '指紋が一致: 降ろさず null',
    run: async (c) => {
      const stored = await c.base.mcpServers.write(SERVERS);
      void stored;
      const { mcpServersFingerprintOf } = await import('./mcp-servers.js');
      const a = c.runner('runner-a', {
        mcpServers: async () => mfp(mcpServersFingerprintOf(SERVERS), ['github']),
      });
      return settle(() => mcpService(c, null).syncRunner(a));
    },
  },
  {
    name: 'mcp/sync-different-and-removed',
    covers:
      '指紋が違う: 全文を降ろす。登録が無いのに runner が持っている（外したはずの鍵入りの登録が残る）: 空を降ろす',
    run: async (c) => {
      const differing = c.runner('runner-differs', {
        mcpServers: async () => mfp('old-sha', ['github']),
        setMcpServers: async () => mfp('new-sha', ['github']),
      });
      const stale = c.runner('runner-stale', {
        mcpServers: async () => mfp('left-over', ['github']),
        setMcpServers: async () => undefined,
      });
      const service = mcpService(c, null);
      await c.base.mcpServers.write(SERVERS);
      const diff = await settle(() => service.syncRunner(differing));
      await c.base.mcpServers.write({});
      const removed = await settle(() => service.syncRunner(stale));
      return { diff, removed };
    },
  },
  {
    name: 'mcp/sync-unreadable-and-set-fails',
    covers: 'runner の指紋が読めない: 差ありに倒して降ろす。降ろす口が落ちたら投げる',
    run: async (c) => {
      await c.base.mcpServers.write(SERVERS);
      const reads = c.runner('runner-reads', {
        mcpServers: async () => {
          throw new Error('指紋が読めない（test）');
        },
        setMcpServers: async () => mfp('sha', ['github']),
      });
      const breaks = c.runner('runner-breaks', {
        mcpServers: async () => undefined,
        setMcpServers: async () => {
          throw new Error('降ろせない（test）');
        },
      });
      const service = mcpService(c, null);
      const unreadable = await settle(() => service.syncRunner(reads));
      const setFails = await settle(() => service.syncRunner(breaks));
      return { unreadable, setFails };
    },
  },
];

// ---- plugin ----

function pluginService(c: Ctx, runners: readonly RunnerClient[] | null) {
  const service = createPluginDistributionService({
    stores: c.stores(),
    ...(runners === null ? {} : { runners: c.registry(runners) }),
  });
  c.watch((listener) => service.onPushed(listener));
  return service;
}

const PLUGIN_SCENARIOS: Scenario[] = [
  {
    name: 'plugin/apply-no-runners',
    covers: '名簿が無い構成: 配らない。names と sha256（一覧の指紋）を返す',
    run: async (c) => {
      await c.base.plugins.put(pluginInput('p-one'));
      return settle(() => pluginService(c, null).apply());
    },
  },
  {
    name: 'plugin/apply-no-plugins',
    covers:
      '載せる plugin が1本も無い: names は空で sha256 は付かない。runner が何も持っていなければ一致で null（runner ごとの結果は ok:true だけ）',
    run: async (c) => {
      const a = c.runner('runner-a', { plugins: async () => undefined });
      return settle(() => pluginService(c, [a]).apply());
    },
  },
  {
    name: 'plugin/apply-two-runners',
    covers:
      '2台へ: 持っていない runner へ setPlugin → retainPlugins([名前])。runner ごとに指紋が結果と onPushed に並ぶ（範囲 app の plugin は載せない）',
    run: async (c) => {
      await c.base.plugins.put(pluginInput('p-one'));
      await c.base.plugins.put(pluginInput('p-app', { scope: 'app' }));
      const make = (id: string, sha: string) =>
        c.runner(id, {
          plugins: async () => undefined,
          setPlugin: async (plugin) =>
            pluginFp(plugin.name, plugin.sourceSha, plugin.contentSha256),
          retainPlugins: async () => ({
            sha256: sha,
            plugins: [pluginFp('p-one', SHA_A)],
            updatedAt: BASE_ISO,
          }),
        });
      return settle(() =>
        pluginService(c, [make('runner-a', 'ra'), make('runner-b', 'rb')]).apply(),
      );
    },
  },
  {
    name: 'plugin/apply-already-matching',
    covers: 'runner が同じ版（sha・内容の指紋・フック・MCP）を持つ: 何も送らず null',
    run: async (c) => {
      const stored = await c.base.plugins.put(pluginInput('p-one'));
      const a = c.runner('runner-a', {
        plugins: async () => ({
          sha256: 'x',
          plugins: [pluginFp('p-one', SHA_A, stored.contentSha256)],
          updatedAt: BASE_ISO,
        }),
      });
      return settle(() => pluginService(c, [a]).apply());
    },
  },
  {
    name: 'plugin/apply-differing-and-extra',
    covers:
      'runner が古い版の p-one と、載せない p-old を持つ: p-one を送り直し、retainPlugins は載せる名前だけ（余りを外す）',
    run: async (c) => {
      await c.base.plugins.put(pluginInput('p-one'));
      const a = c.runner('runner-a', {
        plugins: async () => ({
          sha256: 'x',
          plugins: [pluginFp('p-one', SHA_B, 'old-content'), pluginFp('p-old', SHA_A)],
          updatedAt: BASE_ISO,
        }),
        setPlugin: async (plugin) => pluginFp(plugin.name, plugin.sourceSha, plugin.contentSha256),
        retainPlugins: async () => ({
          sha256: 'r',
          plugins: [pluginFp('p-one', SHA_A)],
          updatedAt: BASE_ISO,
        }),
      });
      return settle(() => pluginService(c, [a]).apply());
    },
  },
  {
    name: 'plugin/apply-one-plugin-fails',
    covers:
      '2本のうち1本の setPlugin が落ちる: 残りの送りと retainPlugins は続け（失敗した plugin は runner が今持つ版を残す名前に入れる）、最後に最初の失敗を投げる（runner の結果は ok:false）',
    run: async (c) => {
      await c.base.plugins.put(pluginInput('p-a'));
      await c.base.plugins.put(pluginInput('p-b'));
      const a = c.runner('runner-a', {
        plugins: async () => ({
          sha256: 'x',
          plugins: [pluginFp('p-a', SHA_B, 'old-content')],
          updatedAt: BASE_ISO,
        }),
        setPlugin: async (plugin) => pluginFp(plugin.name, plugin.sourceSha, plugin.contentSha256),
        retainPlugins: async () => undefined,
      });
      c.fail('runner-a.setPlugin', 'p-a を置けない（test）', 1);
      return settle(() => pluginService(c, [a]).apply());
    },
  },
  {
    name: 'plugin/apply-unreadable',
    covers: 'runner の plugins が読めない: 差ありに倒して全部送り直す。retain も送る',
    run: async (c) => {
      await c.base.plugins.put(pluginInput('p-one'));
      const a = c.runner('runner-a', {
        plugins: async () => {
          throw new Error('一覧が読めない（test）');
        },
        setPlugin: async (plugin) => pluginFp(plugin.name, plugin.sourceSha, plugin.contentSha256),
        retainPlugins: async () => undefined,
      });
      return settle(() => pluginService(c, [a]).apply());
    },
  },
  {
    name: 'plugin/apply-roster-fails',
    covers: '名簿が落ちる: 投げる。onPushed には何も知らせない',
    run: async (c) => {
      const service = pluginService(c, [c.runner('runner-a')]);
      c.fail('registry.list', '名簿が引けない（test）');
      return settle(() => service.apply());
    },
  },
  {
    name: 'plugin/apply-list-fails',
    covers: '正本の一覧（plugins.list）が落ちる: apply が投げる。配らない',
    run: async (c) => {
      const service = pluginService(c, [c.runner('runner-a')]);
      c.fail('plugins.list', '一覧が読めない（test）');
      return settle(() => service.apply());
    },
  },
  {
    name: 'plugin/sync-runner',
    covers:
      'syncRunner: 一致なら null。runner が何も持っていなければ送って {plugins}。retainPlugins が指紋を返さなければ {}',
    run: async (c) => {
      const stored = await c.base.plugins.put(pluginInput('p-one'));
      const service = pluginService(c, null);
      const same = c.runner('runner-same', {
        plugins: async () => ({
          sha256: 'x',
          plugins: [pluginFp('p-one', SHA_A, stored.contentSha256)],
          updatedAt: BASE_ISO,
        }),
      });
      const fresh = c.runner('runner-fresh', {
        plugins: async () => undefined,
        setPlugin: async (plugin) => pluginFp(plugin.name, plugin.sourceSha, plugin.contentSha256),
        retainPlugins: async () => ({
          sha256: 'r',
          plugins: [pluginFp('p-one', SHA_A)],
          updatedAt: BASE_ISO,
        }),
      });
      const noFp = c.runner('runner-nofp', {
        plugins: async () => undefined,
        setPlugin: async (plugin) => pluginFp(plugin.name, plugin.sourceSha, plugin.contentSha256),
        retainPlugins: async () => undefined,
      });
      return {
        same: await settle(() => service.syncRunner(same)),
        fresh: await settle(() => service.syncRunner(fresh)),
        noFp: await settle(() => service.syncRunner(noFp)),
      };
    },
  },
];

// ---- permission rules ----

function permissionService(c: Ctx, runners: readonly RunnerClient[] | null) {
  const s = c.stores();
  const service = createDelegatedPermissionRuleService({
    stores: { permissionGrants: s.permissionGrants, journal: s.journal },
    ...(runners === null ? {} : { runners: c.registry(runners) }),
  });
  c.watch((listener) => service.onPushed(listener));
  return service;
}

const placedRule = async () => ({ count: 2, changed: true });

const PERMISSION_SCENARIOS: Scenario[] = [
  {
    name: 'permission-rules/push-no-registry',
    covers: '名簿が無い構成: 何も配らず [] を返す（日誌も書かない）',
    run: async (c) => settle(() => permissionService(c, null).pushAll('許可が足された')),
  },
  {
    name: 'permission-rules/push-two-runners-changed',
    covers:
      '2台とも一覧が変わった: runner ごとに「配った」の日誌を 1 行ずつ順に書き、続けて auto mode で捨てられる見込みの行（python の前方一致）。結果は count・changed つき。取り消し済み・載せない形の許可は数えない',
    run: async (c) => {
      await c.base.permissionGrants.put(grant('g1', 'Bash(gh pr view 12)'));
      await c.base.permissionGrants.put(grant('g2', 'Bash(python:*)'));
      await c.base.permissionGrants.put(grant('g3', 'Bash(git status)', { revokedAt: BASE_ISO }));
      await c.base.permissionGrants.put(grant('g4', 'Bash(*)'));
      const a = c.runner('runner-a', { setPermissionRules: placedRule });
      const b = c.runner('runner-b', { setPermissionRules: placedRule });
      return settle(() => permissionService(c, [a, b]).pushAll('許可が足された'));
    },
  },
  {
    name: 'permission-rules/push-unchanged',
    covers:
      '一覧が変わっていない（changed:false）: 「配った」の行は残すが、auto mode の行は積まない',
    run: async (c) => {
      await c.base.permissionGrants.put(grant('g2', 'Bash(python:*)'));
      const a = c.runner('runner-a', {
        setPermissionRules: async () => ({ count: 1, changed: false }),
      });
      return settle(() => permissionService(c, [a]).pushAll('名乗り直し'));
    },
  },
  {
    name: 'permission-rules/push-one-runner-fails',
    covers:
      '1台が落ちる: ok:false。日誌には「配れなかった（前の一覧が残っている）」の行。もう1台は成功の行',
    run: async (c) => {
      await c.base.permissionGrants.put(grant('g1', 'Bash(gh pr view 12)'));
      const a = c.runner('runner-a', { setPermissionRules: placedRule });
      const b = c.runner('runner-b', {
        setPermissionRules: async () => {
          throw new Error('runner b is down');
        },
      });
      return settle(() => permissionService(c, [a, b]).pushAll('許可が足された'));
    },
  },
  {
    name: 'permission-rules/push-grants-unreadable',
    covers:
      '許可の一覧が読めない: 日誌に「配れなかった（許可の一覧を読めなかった）」を1行・名簿は読めるので runner ごとの失敗を onPushed に知らせ、[] を返す（投げない）',
    run: async (c) => {
      const a = c.runner('runner-a');
      const b = c.runner('runner-b');
      const service = permissionService(c, [a, b]);
      c.fail('permissionGrants.list', '許可の一覧が読めない（test）');
      return settle(() => service.pushAll('許可が足された'));
    },
  },
  {
    name: 'permission-rules/push-roster-unreadable',
    covers:
      '許可は読めるが名簿が引けない: 日誌は書かず、名指しなし（unnamed）の失敗を onPushed に知らせ、[] を返す',
    run: async (c) => {
      await c.base.permissionGrants.put(grant('g1', 'Bash(gh pr view 12)'));
      const service = permissionService(c, [c.runner('runner-a')]);
      c.fail('registry.list', '名簿が引けない（test）');
      return settle(() => service.pushAll('許可が足された'));
    },
  },
  {
    name: 'permission-rules/push-both-unreadable',
    covers: '許可も名簿も読めない: 日誌1行と、名指しなし（unnamed）の失敗の知らせ。[] を返す',
    run: async (c) => {
      const service = permissionService(c, [c.runner('runner-a')]);
      c.fail('permissionGrants.list', '許可の一覧が読めない（test）');
      c.fail('registry.list', '名簿が引けない（test）');
      return settle(() => service.pushAll('許可が足された'));
    },
  },
  {
    name: 'permission-rules/push-journal-fails',
    covers: '日誌が書けない: 握って stderr に1行（noteDroppedRecord）。配布の結果は変わらない',
    run: async (c) => {
      await c.base.permissionGrants.put(grant('g1', 'Bash(gh pr view 12)'));
      const a = c.runner('runner-a', { setPermissionRules: placedRule });
      const service = permissionService(c, [a]);
      c.fail('journal.append', '日誌が落ちた（test）');
      return settle(() => service.pushAll('許可が足された'));
    },
  },
  {
    name: 'permission-rules/sync-runner',
    covers:
      'syncRunner: 常に送る（指紋は比べない）。changed:true なら「配った」と auto mode の日誌、false なら日誌なし。落ちたら投げる（日誌と挑み直しは呼び手）',
    run: async (c) => {
      await c.base.permissionGrants.put(grant('g2', 'Bash(python:*)'));
      const service = permissionService(c, null);
      const changed = c.runner('runner-changed', { setPermissionRules: placedRule });
      const same = c.runner('runner-same', {
        setPermissionRules: async () => ({ count: 1, changed: false }),
      });
      const fails = c.runner('runner-fails', {
        setPermissionRules: async () => {
          throw new Error('runner is down');
        },
      });
      return {
        changed: await settle(() => service.syncRunner(changed)),
        same: await settle(() => service.syncRunner(same)),
        fails: await settle(() => service.syncRunner(fails)),
      };
    },
  },
];

const SCENARIOS: Scenario[] = [
  ...CRED_SCENARIOS,
  ...PROFILE_SCENARIOS,
  ...MCP_SCENARIOS,
  ...PLUGIN_SCENARIOS,
  ...PERMISSION_SCENARIOS,
];
const ALL_KEYS = SCENARIOS.map((scenario) => scenario.name);

// ---- 記録 ----

interface Pinned {
  out: unknown;
  events: string[];
  journal: Record<string, unknown>[];
  stderr: string[];
}

interface PinFile {
  counts: Record<string, number>;
  scenarios: Record<string, Pinned>;
}

function plain<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' && item.length > 100 ? `<str ${String(item.length)} chars>` : item,
    ),
  ) as T;
}

async function runScenario(scenario: Scenario): Promise<Pinned> {
  vi.setSystemTime(new Date(BASE_ISO));
  const c = new Ctx();
  const stderr: string[] = [];
  setStderrSinkForTesting((line) => {
    stderr.push(line);
  });
  // 自分を積み直すマイクロタスクを1本回して、await の世代を数える（上限を置く: 暴走で場面が止まらなくならないように）
  let spinning = true;
  const spin = (): void => {
    if (!spinning) return;
    c.tick += 1;
    if (c.tick < 100_000) queueMicrotask(spin);
  };
  queueMicrotask(spin);
  let out: unknown;
  try {
    out = await scenario.run(c);
  } finally {
    spinning = false;
    setStderrSinkForTesting(null);
  }
  const journal = await c.base.journal.list({ order: 'asc' });
  return {
    out: plain(out),
    events: c.ev.map((entry) => `${String(entry.t)} ${entry.e}`),
    journal: plain(journal) as unknown as Record<string, unknown>[],
    stderr,
  };
}

async function runAll(): Promise<Record<string, Pinned>> {
  const out: Record<string, Pinned> = {};
  for (const scenario of SCENARIOS) out[scenario.name] = await runScenario(scenario);
  return out;
}

describe('配布サービス5つの呼びの並び・返り値・日誌・stderr の固定（場面ごと）', () => {
  let actual: Record<string, Pinned> = {};
  let pinned: PinFile = { counts: {}, scenarios: {} };
  let pinnedRaw = '';

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(BASE_ISO));
    actual = await runAll();
    if (UPDATE) {
      const file: PinFile = {
        counts: Object.fromEntries(ALL_KEYS.map((key) => [key, actual[key]?.events.length ?? -1])),
        scenarios: actual,
      };
      writeFileSync(PIN_URL, `${JSON.stringify(file, null, 2)}\n`);
    }
    pinnedRaw = readFileSync(PIN_URL, 'utf8');
    pinned = JSON.parse(pinnedRaw) as PinFile;
  }, 120_000);

  afterAll(() => {
    setStderrSinkForTesting(null);
    vi.useRealTimers();
  });

  it('空振りでない（場面が在り、固定値と実際の場面の名前の並びが同じ）', () => {
    expect(
      Object.keys(pinned.scenarios).length,
      '固定値が空である。この歯は何も測っていない',
    ).toBeGreaterThan(0);
    expect(Object.keys(actual)).toEqual(ALL_KEYS);
    expect(Object.keys(pinned.scenarios)).toEqual(ALL_KEYS);
    for (const key of ALL_KEYS) {
      // 名簿が無い構成の pushAll は何も呼ばない（返り値だけを縛る）
      if (key === 'permission-rules/push-no-registry') continue;
      expect(actual[key]?.events.length, `${key} が呼びを1つも記録していない`).toBeGreaterThan(0);
    }
  });

  it('場面ごとの呼びの数の一覧が固定値と同じ', () => {
    const counts = Object.fromEntries(
      ALL_KEYS.map((key) => [key, actual[key]?.events.length ?? -1]),
    );
    expect(counts).toEqual(pinned.counts);
  });

  describe.each(SCENARIOS)('場面 $name', (scenario) => {
    const key = scenario.name;

    it(`返り値が固定値と同じ（${scenario.covers}）`, () => {
      expect(pinned.scenarios[key], `${key} が固定値に無い`).toBeDefined();
      expect(actual[key]?.out, `場面 ${key} の返り値が固定値からずれた`).toEqual(
        pinned.scenarios[key]?.out,
      );
    });

    it('呼びの並びと await の世代が固定値と同じ', () => {
      const want = pinned.scenarios[key];
      const got = actual[key];
      expect(want, `${key} が固定値に無い`).toBeDefined();
      expect(got?.events.length, `場面 ${key} の呼びの数が変わった`).toBe(want?.events.length);
      expect(
        got?.events,
        `場面 ${key} の呼びの並び（世代・口・引数・結果）が固定値からずれた`,
      ).toEqual(want?.events);
    });

    it('日誌に書いた行と stderr に出た行が固定値と同じ', () => {
      const want = pinned.scenarios[key];
      const got = actual[key];
      expect(want, `${key} が固定値に無い`).toBeDefined();
      expect(
        got?.journal,
        `場面 ${key} の日誌の行（種類・本文・grounds・id・at）が変わった`,
      ).toEqual(want?.journal);
      expect(got?.stderr, `場面 ${key} の stderr の行が変わった`).toEqual(want?.stderr);
    });
  });

  it('同じ入力で2回回すと、全場面で同じ記録になる（時計・採番・順序・世代が固定されている）', async () => {
    expect(await runAll()).toEqual(actual);
  });

  it('json に本物らしい値と絶対パスが無い。値は作りものだけ', () => {
    expect(pinnedRaw).not.toMatch(/sk-/);
    expect(pinnedRaw).not.toMatch(/ghp_|xox[bp]-|AKIA/);
    expect(pinnedRaw).not.toMatch(/\/tmp\/|\/home\//);
    expect(pinnedRaw).not.toMatch(/[A-Za-z0-9_./@-]{120,}/);
  });
});
