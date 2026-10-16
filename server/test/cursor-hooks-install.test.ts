import { describe, expect, it } from 'vitest';
import { EVENTS, handlerFor, hookCommand, isOurHandler, planInstall, planUninstall } from '../../scripts/cursor-hooks-install';

const CMD = hookCommand('/repo/habblaud/mod/habblaud-cursor-permissoes/hook.mjs');

describe('cursor-hooks-install.ts', () => {
  it('instala os três eventos no fim e é idempotente', () => {
    const p = planInstall({ version: 1, hooks: { preToolUse: [{ command: 'other-hook' }] } }, CMD, 300);
    expect(p.action).toBe('install');
    if (p.action !== 'install') return;
    for (const event of EVENTS) {
      const list = p.file.hooks![event]!;
      expect(list.some((h) => isOurHandler(h))).toBe(true);
    }
    expect(planInstall(p.file, CMD, 300).action).toBe('none');
  });

  it('remove só os handlers do Habblaud', () => {
    const installed = planInstall({ version: 1 }, CMD, 300);
    if (installed.action !== 'install') throw new Error('install failed');
    const u = planUninstall(installed.file);
    expect(u.action).toBe('uninstall');
    if (u.action !== 'uninstall') return;
    for (const event of EVENTS) expect(u.file.hooks?.[event]).toBeUndefined();
  });

  it('handler usa timeout com folga sobre a espera', () => {
    expect(handlerFor(CMD, 300)).toEqual({ command: CMD, timeout: 310 });
  });
});
