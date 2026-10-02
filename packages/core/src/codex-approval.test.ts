import { describe, expect, it } from 'vitest';

import { mapCodexApproval, type CodexApprovalJudgement } from './codex-approval.js';
import { CODEX_SERVER_REQUESTS } from './codex-protocol.js';

const JUDGEMENTS: readonly CodexApprovalJudgement[] = [
  { behavior: 'allow' },
  { behavior: 'allow', updatedInput: { a: 1 } },
  { behavior: 'deny', message: 'no' },
  { behavior: 'interrupt' },
];
const METHODS = [...Object.keys(CODEX_SERVER_REQUESTS), 'item/tool/call', 'nope', ''];

describe('mapCodexApproval', () => {
  it.each(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'])(
    '%s: allow/deny/interrupt は accept/decline/cancel',
    (m) => {
      expect(mapCodexApproval(m, { behavior: 'allow' })).toEqual({
        ok: true,
        response: { decision: 'accept' },
      });
      expect(mapCodexApproval(m, { behavior: 'deny', message: 'x' })).toEqual({
        ok: true,
        response: { decision: 'decline' },
      });
      expect(mapCodexApproval(m, { behavior: 'interrupt' })).toEqual({
        ok: true,
        response: { decision: 'cancel' },
      });
    },
  );

  it('elicitation: deny/interrupt は decline/cancel、allow は写せない', () => {
    const m = 'mcpServer/elicitation/request';
    expect(mapCodexApproval(m, { behavior: 'deny', message: 'x' })).toEqual({
      ok: true,
      response: { action: 'decline' },
    });
    expect(mapCodexApproval(m, { behavior: 'interrupt' })).toEqual({
      ok: true,
      response: { action: 'cancel' },
    });
    expect(mapCodexApproval(m, { behavior: 'allow' })).toEqual({
      ok: false,
      reason: 'allow-not-expressible',
    });
  });

  it('permissions: deny/interrupt は何も付与しない、allow は写せない', () => {
    const m = 'item/permissions/requestApproval';
    expect(mapCodexApproval(m, { behavior: 'deny', message: 'x' })).toEqual({
      ok: true,
      response: { permissions: {} },
    });
    expect(mapCodexApproval(m, { behavior: 'interrupt' })).toEqual({
      ok: true,
      response: { permissions: {} },
    });
    expect(mapCodexApproval(m, { behavior: 'allow' })).toEqual({
      ok: false,
      reason: 'allow-not-expressible',
    });
  });

  it('requestUserInput: どの判断も写せない', () => {
    for (const j of JUDGEMENTS) {
      expect(mapCodexApproval('item/tool/requestUserInput', j)).toEqual({
        ok: false,
        reason: 'no-decline-value',
      });
    }
  });

  it('知らない request 種別は、どの判断でも写せない（許可にならない）', () => {
    for (const m of ['item/tool/call', 'nope', '', 'toString', '__proto__']) {
      for (const j of JUDGEMENTS) {
        expect(mapCodexApproval(m, j)).toEqual({ ok: false, reason: 'unknown-request' });
      }
    }
  });

  it('知らない判断は、どの request でも写せない', () => {
    for (const m of Object.keys(CODEX_SERVER_REQUESTS)) {
      for (const j of [{ behavior: 'ask' }, {}, null, undefined, { behavior: 'ALLOW' }]) {
        expect(mapCodexApproval(m, j as unknown as CodexApprovalJudgement)).toEqual({
          ok: false,
          reason: 'unknown-judgement',
        });
      }
    }
  });

  it('allow 以外の判断は、どの request でも許可（accept）にならない', () => {
    for (const m of METHODS) {
      for (const j of JUDGEMENTS.filter((x) => x.behavior !== 'allow')) {
        const text = JSON.stringify(mapCodexApproval(m, j));
        expect(text).not.toContain('"accept"');
      }
    }
  });

  it('どの入力の組み合わせでも、セッション単位・恒久的な許可が出ない', () => {
    for (const m of METHODS) {
      for (const j of JUDGEMENTS) {
        const r = mapCodexApproval(m, j);
        const text = JSON.stringify(r);
        expect(text).not.toContain('acceptForSession');
        expect(text).not.toContain('"session"');
        expect(text).not.toContain('mendment');
        if (r.ok && 'decision' in r.response)
          expect(r.response.decision).not.toBe('acceptForSession');
      }
    }
  });

  it('許可（accept）が出るのは、allow × commandExecution / fileChange の2つだけ', () => {
    const accepting: string[] = [];
    for (const m of METHODS) {
      for (const j of JUDGEMENTS) {
        if (JSON.stringify(mapCodexApproval(m, j)).includes('"accept"'))
          accepting.push(`${m}:${j.behavior}`);
      }
    }
    expect(new Set(accepting)).toEqual(
      new Set([
        'item/commandExecution/requestApproval:allow',
        'item/fileChange/requestApproval:allow',
      ]),
    );
  });
});
