import { describe, expect, it } from 'vitest';
import { C } from '../../test/cursor-fixtures';
import { applyTodos, createCursorState, describeCursorTool, parseCursorLine, resultError } from './stream';

const ctx = { idPrefix: 'cursor:r1', now: 1_000 };

describe('describeCursorTool: ferramentas do Cursor nos nomes do Habblaud', () => {
  it.each([
    ['readToolCall', { path: '/p/a.txt' }, 'Read', 'Lendo a.txt'],
    ['globToolCall', { targetDirectory: '/p', globPattern: '*.ts' }, 'Glob', 'Procurando *.ts'],
    ['grepToolCall', { pattern: 'TODO' }, 'Grep', 'Buscando “TODO”'],
    ['shellToolCall', { command: 'npm test' }, 'Bash', 'Rodando testes'],
    ['editToolCall', { path: '/p/src/app.ts' }, 'Edit', 'Editando app.ts'],
    ['writeToolCall', { path: '/p/novo.md' }, 'Write', 'Escrevendo novo.md'],
    ['lsToolCall', { path: '/p/src' }, 'LS', 'Listando src'],
    ['webSearchToolCall', { searchTerm: 'vitest' }, 'WebSearch', 'Pesquisando “vitest”'],
    ['updateTodosToolCall', { todos: [] }, 'TodoWrite', 'Atualizando a lista de tarefas'],
    ['piBashToolCall', { command: 'ls' }, 'Bash', undefined],
  ])('%s → %s', (key, args, tool, text) => {
    const r = describeCursorTool(key, args);
    expect(r.tool).toBe(tool);
    if (text) expect(r.desc.text).toBe(text);
  });

  it('MCP vira mcp__<servidor>__<ferramenta>; getMcpTools é leitura de recursos; desconhecida é genérica', () => {
    expect(describeCursorTool('mcpToolCall', { providerIdentifier: 'github', toolName: 'create_issue', args: {} }).tool).toBe('mcp__github__create_issue');
    expect(describeCursorTool('getMcpToolsToolCall', { server: 'cursor', toolName: 'TodoWrite' }).tool).toBe('ListMcpResourcesTool');
    const other = describeCursorTool('reflectToolCall', {});
    expect(other.tool).toBe('reflect');
    expect(other.desc.text).toBe('Usando reflect');
  });

  it('resultado: success ok; erro, recusa e código de saída', () => {
    expect(resultError({ success: { content: 'x' } })).toEqual({ error: false, rejected: false });
    expect(resultError({ success: { exitCode: 2 } }).error).toBe(true);
    expect(resultError({ error: { error: 'arquivo não existe' } })).toMatchObject({ error: true, rejected: false, detail: 'arquivo não existe' });
    expect(resultError({ rejected: {} })).toMatchObject({ error: true, rejected: true });
    expect(resultError(undefined)).toEqual({ error: false, rejected: false });
  });

  it('tarefas: substitui, mescla por id e tira as canceladas', () => {
    const a = applyTodos([], { todos: [{ id: '1', content: 'Ler', status: 'TODO_STATUS_COMPLETED' }, { id: '2', content: 'Editar', status: 'TODO_STATUS_IN_PROGRESS' }] })!;
    expect(a).toEqual([
      { id: '1', title: 'Ler', status: 'completed' },
      { id: '2', title: 'Editar', status: 'in_progress' },
    ]);
    const b = applyTodos(a, { merge: true, todos: [{ id: '2', status: 3 }, { id: '1', status: 'CANCELLED' }] })!;
    expect(b).toEqual([{ id: '2', title: 'Editar', status: 'completed' }]);
  });
});

describe('parseCursorLine: o stream do Cursor vira estado, atividades e sinais', () => {
  it('uma execução inteira', () => {
    const s = createCursorState();
    const lines = [
      C.meta({ at: 100, name: 'Lucas', role: 'Dev - Mestre', parentSessionId: 'sess-claude' }),
      C.init(200),
      C.user('Leia a.txt e conte as linhas', 300),
      C.thinking('Lendo a.txt.', 400),
      C.thinking(' Depois conto.', 410),
      C.thinkingDone(420),
      C.tool('started', 't1', 'readToolCall', { path: '/proj/loja/a.txt' }, 500),
      C.tool('completed', 't1', 'readToolCall', { path: '/proj/loja/a.txt' }, 600, { success: { content: 'oi' } }),
      C.tool('started', 't2', 'editToolCall', { path: '/proj/loja/b.ts' }, 700),
      C.tool('completed', 't2', 'editToolCall', { path: '/proj/loja/b.ts' }, 800, { success: { linesAdded: 3, linesRemoved: 1 } }),
      C.tool('started', 't3', 'shellToolCall', { command: 'npm test' }, 850),
      C.tool('completed', 't3', 'shellToolCall', { command: 'npm test' }, 870, { failure: { exitCode: 1, stderr: 'falhou' } }),
      C.say('a.txt tem 3 linhas.', 900),
      C.say(' Pronto.', 910),
      C.result('a.txt tem 3 linhas. Pronto.', 1_000, { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 5 } }),
      C.end(1_100),
      'linha que não é json',
      JSON.stringify({ type: 'connection', subtype: 'reconnect' }),
    ];
    const out = lines.map((l) => parseCursorLine(s, l, ctx));
    expect(s.meta).toMatchObject({ name: 'Lucas', role: 'Dev - Mestre', parentSessionId: 'sess-claude', pid: 4242 });
    expect(s).toMatchObject({ sessionId: expect.any(String), model: 'Composer 2.5', title: 'Leia a.txt e conte as linhas', started: true, resulted: true, resultError: false });
    expect(s.ended).toMatchObject({ exitCode: 0 });
    expect(s.stats).toMatchObject({ toolCalls: 3, tokensIn: 155, tokensOut: 20, linesAdded: 3, linesRemoved: 1 });
    const acts = out.flatMap((r) => r.activities.map((a) => a.activity));
    expect(acts.map((a) => a.text)).toEqual([
      'Nova tarefa: “Leia a.txt e conte as linhas”',
      'Pensando…',
      'Lendo a.txt',
      'Editando b.ts',
      'Rodando testes',
      'Erro em Bash',
      'Escrevendo a resposta',
      'Concluiu em 12s',
    ]);
    expect(acts.find((a) => a.text === 'Erro em Bash')).toMatchObject({ error: true, tool: 'Bash', detail: 'falhou' });
    expect(acts[2]).toMatchObject({ id: 'cursor:r1#t1', tool: 'Read', at: 500 });
    expect(out.flatMap((r) => r.signals.map((x) => x.type))).toEqual(['meta', 'start', 'result', 'end']);
  });

  it('erro do resultado e saída com código sem resultado', () => {
    const s = createCursorState();
    const r = parseCursorLine(s, C.result('sem cota', 10, { error: true }), ctx);
    expect(r.activities[0].activity).toMatchObject({ kind: 'error', error: true, detail: 'sem cota' });
    const s2 = createCursorState();
    const e = parseCursorLine(s2, C.end(20, 1), ctx);
    expect(e.activities[0].activity).toMatchObject({ kind: 'error', error: true });
  });
});
