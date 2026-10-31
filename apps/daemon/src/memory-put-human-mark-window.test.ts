import type { CloneHost, Stores } from '@alteroid/core';
import { createCloneTools, createMemoryStores, memoryVersion } from '@alteroid/core';
import { createFsStores } from '@alteroid/storage-fs';
import { createPgStoresFromDb } from '@alteroid/storage-pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { makeTempDir } from '../../../vitest.tmpdir.js';

import { createApp } from './app.js';
import { createMigratedPglite, migratedTemplate } from './pglite-template.test-support.js';

// 人間の PUT が「本文を書く」と「人間が触った印を立てる」の間に窓を開けると、その間に来た蒸留（cause: distill）の
// memory_write / memory_delete が保護（human）に止められず、人間の本文を全置換・削除できる。
// 窓の位置（本文の前か後か）には依らず、「保存の途中で蒸留が割り込んでも人間の本文が残る」ことだけを確かめる。

beforeAll(async () => {
  await migratedTemplate();
}, 60_000);

const SLUG = 'values';
const OLD = '旧い本文\n';
const HUMAN = '人間が書き換えた本文\n';
const DISTILL = '蒸留が書いた本文\n';

function stubClone(): CloneHost {
  return {
    post: () => undefined,
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
    usageBlocked: false,
    managers: { list: () => Promise.resolve([]) },
  } as unknown as CloneHost;
}

// `persona.write` が返った直後 / `markHumanTouched` に入った時のどちらか早いほうで、1度だけ止める門。
function gated(stores: Stores): {
  stores: Stores;
  reached: Promise<void>;
  release: () => void;
} {
  let reach: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  const hold = async (): Promise<void> => {
    if (held) return;
    held = true;
    reach();
    await open;
  };
  const persona = new Proxy(stores.persona, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === 'write') {
        return async (...args: unknown[]) => {
          const result = await fn.apply(target, args);
          await hold();
          return result;
        };
      }
      if (prop === 'markHumanTouched') {
        return async (...args: unknown[]) => {
          await hold();
          return fn.apply(target, args);
        };
      }
      return fn.bind(target);
    },
  });
  return { stores: { ...stores, persona }, reached, release };
}

function distillCaller(stores: Stores) {
  const tools = createCloneTools({
    stores,
    emit: () => undefined,
    conversationId: () => undefined,
    memoryCause: () => 'distill',
  });
  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const found = tools.find((entry) => entry.name === name);
    if (!found) throw new Error(`ツール ${name} が無い`);
    const result = await found.handler(args as never, {});
    return (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
  };
}

describe.each([
  ['memory', async () => createMemoryStores()],
  ['fs', async () => createFsStores(await makeTempDir('alteroid-test-'))],
  ['pg', async () => createPgStoresFromDb((await createMigratedPglite()).db)],
] as const)(
  '人間の PUT の途中で来た蒸留は、人間の本文を壊せない（%s 実装）',
  (_label, makeStores) => {
    async function startPut() {
      const stores = await makeStores();
      await stores.persona.write(SLUG, OLD);
      const gate = gated(stores);
      const app = createApp({
        clone: stubClone(),
        stores: gate.stores,
        token: 'test-token',
        shutdown: () => undefined,
      });
      const response = app.request(`/memory/${SLUG}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: HUMAN, ifMatch: memoryVersion(OLD) }),
      });
      await gate.reached;
      return { stores, gate, response };
    }

    it('memory_write（全置換）は human の保護で断られ、人間の本文が残る', async () => {
      const { stores, gate, response } = await startPut();
      const text = await distillCaller(stores)('memory_write', {
        slug: SLUG,
        content: DISTILL,
        summary: '蒸留の全置換',
        base_version: memoryVersion(HUMAN),
      });
      gate.release();
      expect((await response).status).toBe(200);
      expect(text).toContain('保護状態: human');
      expect((await stores.persona.read(SLUG))?.content).toBe(HUMAN);
      expect(await stores.persona.protectionStatus(SLUG)).toEqual({ kind: 'human' });
    });

    it('memory_delete は human の保護で断られ、人間の本文が残る', async () => {
      const { stores, gate, response } = await startPut();
      const text = await distillCaller(stores)('memory_delete', {
        slug: SLUG,
        summary: '蒸留の削除',
        base_version: memoryVersion(HUMAN),
      });
      gate.release();
      expect((await response).status).toBe(200);
      expect(text).toContain('保護状態: human');
      expect((await stores.persona.read(SLUG))?.content).toBe(HUMAN);
      expect(await stores.persona.protectionStatus(SLUG)).toEqual({ kind: 'human' });
    });
  },
);
