import { describe, expect, it } from 'vitest';
// @ts-expect-error -- o hook é JS puro (mod/), sem declaração de tipos
import { cursorOutput, permissionBody, readConfig, run, toolFromEvent } from '../../mod/habblaud-cursor-permissoes/hook.mjs';

describe('cursor permission hook', () => {
  it('beforeShellExecution vira Shell no corpo do pedido', () => {
    const input = {
      conversation_id: '4318492d-f6be-4aa1-9ab5-e78611afc74f',
      hook_event_name: 'beforeShellExecution',
      command: 'npm test',
      cwd: '/home/x/p',
      workspace_roots: ['/home/x/p'],
    };
    expect(toolFromEvent(input)?.tool).toBe('Shell');
    const body = permissionBody(input, 60_000);
    expect(body).toMatchObject({
      provider: 'cursor',
      session_id: input.conversation_id,
      tool_name: 'Shell',
      cwd: '/home/x/p',
    });
  });

  it('cursorOutput traduz allow e deny', () => {
    expect(cursorOutput({ status: 'decided', behavior: 'allow' })).toEqual({ permission: 'allow' });
    expect(cursorOutput({ status: 'decided', behavior: 'deny', message: 'não' })?.permission).toBe('deny');
    expect(cursorOutput({ status: 'pending' })).toBeUndefined();
  });

  it('autoAllow: aprova sem chamar o Habblaud', async () => {
    expect(readConfig({ HABBLAUD_CURSOR_AUTO_ALLOW: '1' }).autoAllow).toBe(true);
    const stdin = JSON.stringify({
      conversation_id: '4318492d-f6be-4aa1-9ab5-e78611afc74f',
      hook_event_name: 'beforeShellExecution',
      command: 'npm test',
    });
    const out = await run({ HABBLAUD_CURSOR_AUTO_ALLOW: '1' }, stdin);
    expect(out).toEqual({ permission: 'allow' });
  });
});
