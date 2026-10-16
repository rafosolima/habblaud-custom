import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { readCursorCliProfile } from './cli-config';

describe('readCursorCliProfile', () => {
  it('lê e-mail e time do authInfo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cursor-cli-'));
    writeFileSync(
      join(dir, 'cli-config.json'),
      JSON.stringify({ authInfo: { email: 'a@b.c', teamName: 'ACME' } }),
    );
    expect(readCursorCliProfile(dir)).toEqual({ email: 'a@b.c', organization: 'ACME', plan: 'Team' });
  });

  it('arquivo ausente', () => {
    expect(readCursorCliProfile('/nao/existe')).toBeUndefined();
  });
});
