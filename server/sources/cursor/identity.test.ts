import { describe, expect, it } from 'vitest';
import { isGenericCursorAgentName, resolveCursorIdentityHint } from './identity';
import type { TeamLookup } from '../../model/team';

const team: TeamLookup = {
  subagent: (t) =>
    t === 'julia-qa' ? { name: 'Julia', role: 'qa - test', agentType: 'julia-qa' } : t === 'renato-techlead' ? { name: 'Renato', role: 'TechLead', agentType: 'renato-techlead' } : undefined,
  cursor: (n) => (n.toLowerCase() === 'lucas' ? { name: 'Lucas', role: 'Dev - Mestre', cursorName: 'Lucas' } : undefined),
  cursorIdeDefault: () => ({ name: 'Renato', role: 'TechLead', agentType: 'renato-techlead', cursorIdeDefault: true }),
  main: () => undefined,
};

describe('cursor identity', () => {
  it('detecta nomes genéricos do IDE', () => {
    expect(isGenericCursorAgentName('Habblaud Cursor Agent')).toBe(true);
    expect(isGenericCursorAgentName('New Agent')).toBe(true);
    expect(isGenericCursorAgentName('Lucas')).toBe(false);
  });

  it('casa --name do wrapper e cai no cursorIdeDefault quando o store é genérico', () => {
    expect(resolveCursorIdentityHint({ storeName: 'Lucas', team })).toMatchObject({ name: 'Lucas', role: 'Dev - Mestre' });
    expect(resolveCursorIdentityHint({ storeName: 'Habblaud Cursor Agent', team })).toMatchObject({ name: 'Renato', role: 'TechLead', agentType: 'renato-techlead' });
    expect(resolveCursorIdentityHint({ agentType: 'julia-qa', team })).toMatchObject({ name: 'Julia', role: 'qa - test' });
    expect(resolveCursorIdentityHint({ storeName: 'Habblaud Cursor Agent', team, env: { HABBLAUD_CURSOR_IDE_NAME: 'Lucas' } })).toMatchObject({
      name: 'Lucas',
    });
  });
});
