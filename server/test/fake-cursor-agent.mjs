#!/usr/bin/env node
// cursor-agent falso para os testes do wrapper (mod/habblaud-cursor/run.mjs): imprime um stream-json como o do Cursor
// 2026 (com os pedaços de texto, a linha repetida com o texto inteiro e um `env` que nunca pode ir para o arquivo) e
// sai com FAKE_CURSOR_EXIT. FAKE_CURSOR_SLEEP_MS segura o processo (para o teste do sinal).
const sid = '80b4c8ca-1111-4222-8333-944455556666';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const args = process.argv.slice(2);
out({ type: 'system', subtype: 'init', apiKeySource: 'login', cwd: process.cwd(), session_id: sid, model: 'Composer 2.5', permissionMode: 'default' });
out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: args[args.length - 1] ?? '' }] }, session_id: sid });
out({ type: 'thinking', subtype: 'delta', text: 'Lendo ', session_id: sid, timestamp_ms: 1 });
out({ type: 'thinking', subtype: 'delta', text: 'o pedido.', session_id: sid, timestamp_ms: 2 });
out({ type: 'thinking', subtype: 'completed', session_id: sid, timestamp_ms: 3 });
out({ type: 'tool_call', subtype: 'started', call_id: 't1', tool_call: { shellToolCall: { args: { command: 'npm test' } } }, session_id: sid, timestamp_ms: 4 });
out({ type: 'tool_call', subtype: 'completed', call_id: 't1', tool_call: { shellToolCall: { args: { command: 'npm test' }, result: { success: { exitCode: 0, stdout: 'ok' } } } }, session_id: sid, timestamp_ms: 5, env: 'SEGREDO=nao-pode-aparecer' });
out({ type: 'tool_call', subtype: 'started', call_id: 't2', tool_call: { readToolCall: { args: { path: 'a.txt' } } }, session_id: sid, timestamp_ms: 6 });
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'args=' }] }, session_id: sid, timestamp_ms: 7 });
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: args.join(' ') }] }, session_id: sid, timestamp_ms: 8 });
out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `args=${args.join(' ')}` }] }, session_id: sid });
const finish = () => {
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 3_000, result: `Feito em ${process.cwd()}`, session_id: sid, usage: { inputTokens: 10, outputTokens: 2 } });
  process.exit(Number(process.env.FAKE_CURSOR_EXIT ?? 0));
};
const wait = Number(process.env.FAKE_CURSOR_SLEEP_MS ?? 0);
if (wait) {
  process.on('SIGTERM', () => process.exit(143));
  setTimeout(finish, wait);
} else finish();
