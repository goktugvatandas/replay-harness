import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSession, loadSession, scanSessions } from '../src/session.js';

const jsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n');
const parse = (data) => parseSession(JSON.stringify(data));

test('Codex rollouts deduplicate UI events and response items, with tools in their turn', () => {
  const session = parseSession(jsonl([
    { type: 'session_meta', payload: { cwd: '/demo' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix it' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Fix it' } },
    { type: 'turn_context', payload: { model: 'test-model' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'On it' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'On it' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: '{"cmd":"echo example"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'example' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Test it' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] } },
  ]));
  assert.equal(session.harness, 'codex');
  assert.equal(session.model, 'test-model');
  assert.equal(session.turns.length, 2);
  assert.deepEqual(session.turns[0].events.map((e) => e.type), ['assistant', 'tool', 'result']);
  assert.equal(session.turns[0].events[1].text, 'echo example');
  assert.equal(session.turns[0].events[2].name, 'exec_command');
});

test('Codex response-only recordings exclude injected context and retain custom tools', () => {
  const msg = (role, text) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: 'input_text', text }] } });
  const s = parse([
    msg('user', '<environment_context>hidden</environment_context>'),
    msg('user', '## My request for Codex:\nDo it'),
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p', input: '+new line' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'p', output: 'Success' } },
    msg('assistant', 'Done'),
  ]);
  assert.equal(s.turns.length, 1);
  assert.equal(s.turns[0].prompt, 'Do it');
  assert.equal(s.turns[0].events[0].text, '+new line');
});

test('Claude tool-result user records do not become user prompts; sidechains are ignored', () => {
  const s = parse([
    { type: 'user', uuid: 'u1', cwd: '/demo', message: { role: 'user', content: 'Fix search' } },
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'thinking', thinking: 'Check case' }, { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'search.ts' } }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'missing file', is_error: true }] } },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'Subagent prompt' } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'The file is missing.' }] } },
    { type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'The file is missing.' }] } },
  ]);
  assert.equal(s.harness, 'claude');
  assert.equal(s.turns.length, 1);
  assert.deepEqual(s.turns[0].events.map((e) => e.type), ['thinking', 'tool', 'result', 'assistant']);
  assert.equal(s.turns[0].events[2].error, true);
});

test('Pi follows latest branch and preserves camelCase tool calls and results', () => {
  const s = parse([
    { type: 'session', version: 3, cwd: '/pi' },
    { type: 'model_change', id: 'm', parentId: null, modelId: 'pi-model' },
    { type: 'message', id: 'u', parentId: 'm', message: { role: 'user', content: 'Do it' } },
    { type: 'message', id: 'abandoned', parentId: 'u', message: { role: 'assistant', content: [{ type: 'text', text: 'Wrong branch' }] } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool', name: 'bash', arguments: { command: 'npm test' } }] } },
    { type: 'message', id: 't', parentId: 'a', message: { role: 'toolResult', toolCallId: 'tool', toolName: 'bash', content: [{ type: 'text', text: 'Passed' }], isError: false } },
    { type: 'session_info', id: 'i', parentId: 't', name: 'Pi replay' },
  ]);
  assert.equal(s.harness, 'pi');
  assert.equal(s.model, 'pi-model');
  assert.equal(s.title, 'Pi replay');
  assert.deepEqual(s.turns[0].events.map((e) => e.type), ['tool', 'result']);
  assert.equal(s.turns[0].events[0].text, 'npm test');
});

test('Pi legacy linear messages work and cyclic branch history fails clearly', () => {
  const records = [{ type: 'session' }, { type: 'message', message: { role: 'user', content: 'Hi' } }, { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } }];
  assert.equal(parse(records).eventCount, 1);
  assert.throws(() => parse([{ type: 'session' }, { type: 'message', id: 'a', parentId: 'a' }]), /cycle/);
});

test('OpenCode imports exported messages and completed/error tool states', () => {
  const s = parse({ info: { title: 'OpenCode session', directory: '/demo' }, messages: [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'Run tests' }, { type: 'text', synthetic: true, text: 'hidden' }] },
    { info: { role: 'assistant', modelID: 'model' }, parts: [{ type: 'tool', tool: 'bash', callID: 'x', state: { input: { command: 'npm test' }, status: 'error', error: 'Failed' } }] },
  ] });
  assert.equal(s.harness, 'opencode');
  assert.equal(s.turns[0].prompt, 'Run tests');
  assert.equal(s.turns[0].events[1].error, true);
});

test('Gemini imports thoughts, content, and tool calls', () => {
  const s = parse({ sessionId: 'gemini-demo', messages: [
    { type: 'user', content: [{ text: 'Inspect this' }] },
    { type: 'gemini', model: 'gemini-test', content: 'Found it', thoughts: [{ subject: 'Inspect', description: 'Check routes' }], toolCalls: [{ id: 'g', name: 'read_file', args: { path: 'main.ts' }, result: [{ functionResponse: { response: { output: 'Contents' } } }] }] },
  ] });
  assert.equal(s.harness, 'gemini');
  assert.deepEqual(s.turns[0].events.map((e) => e.type), ['thinking', 'assistant', 'tool', 'result']);
  assert.match(s.turns[0].events[3].text, /Contents/);
});

test('generic chats preserve OpenAI-style tool calls and multimodal placeholders', () => {
  const s = parse({ messages: [
    { role: 'system', content: 'Hidden instructions' },
    { role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'input_image' }] },
    { role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'read', arguments: '{"path":"test"}' } }] },
    { role: 'tool', tool_call_id: 'x', content: 'Result' },
  ] });
  assert.equal(s.harness, 'generic');
  assert.equal(s.turns[0].prompt, 'Inspect\n[image]');
  assert.equal(s.turns[0].events[1].name, 'read');
});

test('invalid files fail with actionable errors', () => {
  assert.throws(() => parseSession(''), /empty/);
  assert.throws(() => parseSession('{"role":"user"}\ninvalid'), /line 2/);
  assert.throws(() => parse({ title: 'empty' }), /Unrecognized/);
  assert.throws(() => parse({ version: 2, harness: 'codex', turns: [] }), /version/);
  assert.throws(() => parse({ version: 1, harness: 'codex', turns: [{ prompt: 'Hi', events: [{ type: 'tool', text: 'x', delayMs: -1 }] }] }), /nonnegative/);
});

test('loading and directory scanning never modify the source or execute recorded commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-test-'));
  try {
    const path = join(dir, 'test.json');
    const script = JSON.stringify({ version: 1, harness: 'pi', title: '\u001b[2JTitle', turns: [{ prompt: 'Hi\u001b]52;c;clipboard\u0007', events: [{ type: 'tool', name: 'bash', text: `touch ${join(dir, 'MUST-NOT-EXIST')}` }] }] });
    await writeFile(path, script);
    await writeFile(join(dir, 'broken.jsonl'), 'bad');
    const s = await loadSession(path);
    assert.equal(s.title, 'Title');
    assert.equal(s.turns[0].prompt, 'Hi');
    assert.equal(await readFile(path, 'utf8'), script);
    const scan = await scanSessions(dir);
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.errors.length, 1);
    await assert.rejects(readFile(join(dir, 'MUST-NOT-EXIST')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
