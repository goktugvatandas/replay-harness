import { open, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { clean, contentText, toolInput } from './text.js';

export const HARNESSES = ['codex', 'claude', 'pi', 'opencode', 'gemini', 'generic'];
const MAX_BYTES = 64 * 1024 * 1024;
const EVENT_TYPES = new Set(['assistant', 'thinking', 'tool', 'result']);

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : undefined;
}

function builder(harness, source) {
  const session = { version: 1, harness, title: basename(source).replace(/\.(jsonl?|ndjson)$/i, ''), model: '', cwd: '', turns: [], warnings: [] };
  let turn;
  return {
    session,
    user(text) {
      text = clean(text).trim();
      if (!text) return;
      turn = { prompt: text, events: [] };
      session.turns.push(turn);
    },
    event(type, text, extra = {}) {
      if (!turn || (!text && type !== 'tool')) return;
      turn.events.push({ type, text: clean(text), ...extra });
    },
    finish() {
      if (!session.turns.length) throw new Error('No user prompts found. Choose a conversation JSON/JSONL file or a replay script.');
      return session;
    },
  };
}

function codex(records, source) {
  const b = builder('codex', source);
  // Rollouts persist both response items and UI events. Pick one representation
  // per message kind, otherwise every prompt/answer can appear twice.
  const hasUserEvents = records.some((r) => r.type === 'event_msg' && r.payload?.type === 'user_message');
  const hasAssistantItems = records.some((r) => r.type === 'response_item' && r.payload?.role === 'assistant');
  const hasReasoningItems = records.some((r) => r.type === 'response_item' && r.payload?.type === 'reasoning');
  const calls = new Map();
  for (const r of records) {
    const p = r.payload ?? {};
    const at = timestamp(r.timestamp);
    if (r.type === 'session_meta') { b.session.cwd = clean(p.cwd); b.session.model = clean(p.model); }
    if (r.type === 'turn_context' && p.model) b.session.model = clean(p.model);
    if (r.type === 'event_msg') {
      if (p.type === 'user_message') b.user(p.message);
      if (p.type === 'agent_message' && !hasAssistantItems) b.event('assistant', p.message, { at });
      if (p.type === 'agent_reasoning' && !hasReasoningItems) b.event('thinking', p.text, { at });
    }
    if (r.type !== 'response_item') continue;
    if (p.type === 'message') {
      if (p.role === 'user' && !hasUserEvents) {
        const text = contentText(p.content);
        if (/^\s*(# AGENTS\.md|<(environment_context|permissions instructions|user_instructions|turn_aborted|developer_instructions)>)/.test(text)) continue;
        b.user(text.includes('## My request for Codex:') ? text.split('## My request for Codex:').slice(1).join('## My request for Codex:') : text);
      }
      if (p.role === 'assistant') b.event('assistant', contentText(p.content), { at });
    } else if (p.type === 'reasoning') {
      b.event('thinking', contentText(p.summary ?? []), { at });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      calls.set(p.call_id, p.name);
      b.event('tool', toolInput(p.arguments ?? p.input), { name: clean(p.name), id: clean(p.call_id), at });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      b.event('result', contentText(p.output), { name: clean(calls.get(p.call_id) ?? 'Tool'), id: clean(p.call_id), at });
    }
  }
  return b.finish();
}

function claude(records, source) {
  const b = builder('claude', source);
  const calls = new Map();
  const seen = new Set();
  for (const r of records) {
    if (r.isSidechain) continue;
    if (r.uuid && seen.has(r.uuid)) continue;
    if (r.uuid) seen.add(r.uuid);
    if (r.cwd) b.session.cwd = clean(r.cwd);
    const m = r.message ?? r;
    if (m.model) b.session.model = clean(m.model);
    const role = m.role ?? r.type;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    const at = timestamp(r.timestamp);
    if (role === 'user') {
      const prompt = blocks.filter((p) => p.type !== 'tool_result').map(contentText).filter(Boolean).join('\n');
      if (!r.isMeta) b.user(prompt);
    }
    if (role !== 'assistant' && role !== 'user') continue;
    for (const p of blocks) {
      if (role === 'assistant' && p.type === 'text') b.event('assistant', p.text, { at });
      if (role === 'assistant' && p.type === 'thinking') b.event('thinking', p.thinking, { at });
      if (p.type === 'tool_use') {
        calls.set(p.id, p.name);
        b.event('tool', toolInput(p.input), { name: clean(p.name), id: clean(p.id), at });
      }
      if (p.type === 'tool_result') b.event('result', contentText(p.content), { name: clean(calls.get(p.tool_use_id) ?? 'Tool'), id: clean(p.tool_use_id), error: Boolean(p.is_error), at });
    }
  }
  return b.finish();
}

function opencode(data, source) {
  const b = builder('opencode', source);
  b.session.title = clean(data.info?.title || b.session.title);
  b.session.cwd = clean(data.info?.directory);
  for (const m of data.messages) {
    const info = m.info ?? m;
    const parts = m.parts ?? [];
    if (info.modelID) b.session.model = clean(info.modelID);
    if (info.role === 'user') {
      b.user(parts.filter((p) => !p.synthetic && (p.type === 'text' || p.type === 'file')).map((p) => p.type === 'file' ? `[file: ${clean(p.filename ?? p.mime ?? 'attachment')}]` : p.text).join('\n'));
      continue;
    }
    if (info.role !== 'assistant') continue;
    for (const p of parts) {
      const at = timestamp(p.time?.start ?? info.time?.created);
      if (p.type === 'text') b.event('assistant', p.text, { at });
      if (p.type === 'reasoning') b.event('thinking', p.text, { at });
      if (p.type === 'tool') {
        const state = p.state ?? {};
        const extra = { name: clean(p.tool), id: clean(p.callID), at };
        b.event('tool', toolInput(state.input), extra);
        if (state.status === 'completed' || state.status === 'error') b.event('result', contentText(state.output ?? state.error), { ...extra, at: timestamp(state.time?.end), error: state.status === 'error' });
      }
    }
  }
  return b.finish();
}

function pi(records, source) {
  const b = builder('pi', source);
  const header = records.find((r) => r.type === 'session');
  b.session.cwd = clean(header?.cwd);
  // Pi stores a tree in one JSONL file. Follow the final entry's ancestry so
  // abandoned branches don't replay as additional prompts in the live demo.
  let path = records.filter((r) => r.type !== 'session');
  if (path.some((r) => r.id && Object.hasOwn(r, 'parentId'))) {
    const byId = new Map(path.map((r) => [r.id, r]));
    const seen = new Set();
    let entry = path.at(-1);
    path = [];
    while (entry) {
      if (seen.has(entry.id)) throw new Error('Pi session contains a cycle in its branch history.');
      seen.add(entry.id);
      path.unshift(entry);
      if (entry.parentId && !byId.has(entry.parentId)) b.session.warnings.push('Pi branch has a missing ancestor; only available messages are replayed.');
      entry = entry.parentId ? byId.get(entry.parentId) : undefined;
    }
  }
  for (const r of path) {
    if (r.type === 'model_change') b.session.model = clean(r.modelId);
    if (r.type === 'session_info' && r.name) b.session.title = clean(r.name);
    if (r.type !== 'message') continue;
    const m = r.message ?? {};
    const at = timestamp(r.timestamp ?? m.timestamp);
    if (m.role === 'user') b.user(contentText(m.content));
    if (m.role === 'assistant') {
      if (m.model) b.session.model = clean(m.model);
      const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      for (const p of parts) {
        if (p.type === 'text') b.event('assistant', p.text, { at });
        if (p.type === 'thinking') b.event('thinking', p.thinking, { at });
        if (p.type === 'toolCall') b.event('tool', toolInput(p.arguments), { name: clean(p.name), id: clean(p.id), at });
      }
    }
    if (m.role === 'toolResult') b.event('result', contentText(m.content), { name: clean(m.toolName), id: clean(m.toolCallId), error: Boolean(m.isError), at });
    if (m.role === 'bashExecution') {
      b.event('tool', clean(m.command), { name: 'bash', at });
      b.event('result', clean(m.output), { name: 'bash', error: Boolean(m.exitCode), at });
    }
  }
  return b.finish();
}

function gemini(data, source) {
  const b = builder('gemini', source);
  b.session.title = clean(data.summary || b.session.title);
  for (const m of data.messages) {
    const at = timestamp(m.timestamp);
    if (m.type === 'user') b.user(contentText(m.content));
    if (m.type !== 'gemini') continue;
    if (m.model) b.session.model = clean(m.model);
    for (const thought of m.thoughts ?? []) b.event('thinking', [thought.subject, thought.description].filter(Boolean).join('\n'), { at });
    b.event('assistant', contentText(m.content), { at });
    for (const call of m.toolCalls ?? []) {
      const extra = { id: clean(call.id), name: clean(call.name ?? call.displayName), at: timestamp(call.timestamp) ?? at };
      b.event('tool', toolInput(call.args), extra);
      if (call.result !== undefined || call.status === 'error') b.event('result', contentText(call.result ?? 'Tool failed'), { ...extra, error: call.status === 'error' });
    }
  }
  return b.finish();
}

function generic(data, source) {
  const b = builder('generic', source);
  b.session.title = clean(data.title || b.session.title);
  const calls = new Map();
  for (const m of Array.isArray(data) ? data : data.messages) {
    const at = timestamp(m.timestamp);
    if (m.role === 'user') b.user(contentText(m.content));
    if (m.role === 'assistant') {
      b.event('assistant', contentText(m.content), { at });
      for (const tool of m.tool_calls ?? []) {
        calls.set(tool.id, tool.function?.name);
        b.event('tool', toolInput(tool.function?.arguments), { id: clean(tool.id), name: clean(tool.function?.name), at });
      }
    }
    if (m.role === 'tool') b.event('result', contentText(m.content), { id: clean(m.tool_call_id), name: clean(m.name ?? calls.get(m.tool_call_id) ?? 'Tool'), at });
  }
  return b.finish();
}

function native(data, source) {
  if (data.version !== 1) throw new Error(`Unsupported replay version: ${data.version}. Expected version 1.`);
  if (!HARNESSES.includes(data.harness)) throw new Error(`Unknown harness: ${data.harness}.`);
  const b = builder(data.harness, source);
  for (const key of ['title', 'model', 'cwd', 'description']) if (data[key]) b.session[key] = clean(data[key]);
  for (const [i, turn] of data.turns.entries()) {
    if (typeof turn.prompt !== 'string' || !turn.prompt.trim()) throw new Error(`Turn ${i + 1} needs a nonempty prompt.`);
    if (!Array.isArray(turn.events)) throw new Error(`Turn ${i + 1} needs an events array.`);
    b.user(turn.prompt);
    for (const event of turn.events) {
      if (!EVENT_TYPES.has(event.type)) throw new Error(`Unknown event type in turn ${i + 1}: ${event.type}.`);
      if (typeof event.text !== 'string') throw new Error(`Event text in turn ${i + 1} must be a string.`);
      const extra = {};
      for (const key of ['name', 'id']) if (event[key]) extra[key] = clean(event[key]);
      for (const key of ['delayMs', 'durationMs']) {
        if (event[key] !== undefined) {
          if (!Number.isFinite(event[key]) || event[key] < 0) throw new Error(`${key} in turn ${i + 1} must be a nonnegative number.`);
          extra[key] = event[key];
        }
      }
      if (timestamp(event.at) !== undefined) extra.at = timestamp(event.at);
      if (event.error) extra.error = true;
      b.event(event.type, event.text, extra);
    }
  }
  return b.finish();
}

export function parseSession(raw, source = 'session.json') {
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) throw new Error('This session file is empty.');
  let data;
  try { data = JSON.parse(text); }
  catch {
    data = [];
    for (const [i, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      try { data.push(JSON.parse(line)); }
      catch { throw new Error(`Invalid JSON on line ${i + 1}. Use a JSON or JSONL session export.`); }
    }
  }
  if (!data || typeof data !== 'object') throw new Error('A session must be a JSON object or a list of messages.');
  let session;
  const records = Array.isArray(data) ? data : [data];
  if (Array.isArray(data.turns)) session = native(data, source);
  else if (records.some((r) => ['session_meta', 'response_item', 'event_msg', 'turn_context'].includes(r?.type))) session = codex(records.filter(Boolean), source);
  else if (records.some((r) => r?.type === 'session') || records.some((r) => r?.type === 'message' && r.message?.role)) session = pi(records.filter(Boolean), source);
  else if (records.some((r) => r?.message?.role || ((r?.type === 'user' || r?.type === 'assistant') && r?.message))) session = claude(records.filter(Boolean), source);
  else if (Array.isArray(data.messages) && data.messages.some((m) => m?.info?.role && m.parts)) session = opencode(data, source);
  else if (Array.isArray(data.messages) && data.messages.some((m) => m?.type === 'gemini') && data.sessionId) session = gemini(data, source);
  else if ((Array.isArray(data) ? data : data.messages)?.some((m) => m?.role)) session = generic(data, source);
  else throw new Error('Unrecognized session format. Supported: Codex, Claude Code, Pi, OpenCode, Gemini CLI, chat messages, and replay scripts.');
  session.source = source;
  session.eventCount = session.turns.reduce((n, t) => n + t.events.length, 0);
  if (!session.eventCount) session.warnings.push('This recording contains prompts but no assistant events.');
  return session;
}

export async function loadSession(path) {
  const absolute = resolve(path);
  const file = await open(absolute, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Choose a session file, not a directory or device.');
    if (stat.size > MAX_BYTES) throw new Error('Session exceeds the 64 MiB import limit. Split it into smaller recordings.');
    return parseSession(await file.readFile('utf8'), absolute);
  } finally { await file.close(); }
}

export async function scanSessions(directory) {
  const sessions = [], errors = [];
  const entries = await readdir(resolve(directory), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !['.json', '.jsonl', '.ndjson'].includes(extname(entry.name))) continue;
    try { sessions.push(await loadSession(join(directory, entry.name))); }
    catch (error) { errors.push(`${entry.name}: ${error.message}`); }
  }
  return { sessions, errors };
}
