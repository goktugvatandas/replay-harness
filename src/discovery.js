import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { HARNESSES, loadSession, parseSession } from './session.js';
import { clean, contentText, truncate } from './text.js';

const PREVIEW_BYTES = 256 * 1024;
const MAX_FILES = 10000;
const SKIP_DIRS = new Set(['subagents', 'node_modules', '.git', 'tool-results', 'snapshot', 'log']);
const singleLine = (value) => clean(value).replace(/\s+/g, ' ').trim();

export function filterSessions(sessions, harness = 'all', query = '') {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return sessions.filter((s) => (harness === 'all' || s.harness === harness) && words.every((word) =>
    `${s.title} ${s.cwd} ${s.model} ${s.harness} ${s.preview ?? ''}`.toLowerCase().includes(word)));
}

export function discoveryRoots({ home = homedir(), env = process.env, extraDirectories = [] } = {}) {
  const expand = (path) => resolve(path.startsWith('~/') ? join(home, path.slice(2)) : path);
  const codex = expand(env.CODEX_HOME || join(home, '.codex'));
  const claude = expand(env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
  const pi = expand(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'));
  const data = expand(env.XDG_DATA_HOME || join(home, '.local', 'share'));
  return [
    { harness: 'codex', path: join(codex, 'sessions') },
    { harness: 'codex', path: join(codex, 'archived_sessions') },
    { harness: 'claude', path: join(claude, 'projects') },
    { harness: 'pi', path: env.PI_CODING_AGENT_SESSION_DIR ? expand(env.PI_CODING_AGENT_SESSION_DIR) : join(pi, 'sessions') },
    { harness: 'gemini', path: join(home, '.gemini', 'tmp') },
    { harness: 'opencode', path: join(data, 'opencode', 'storage', 'session'), kind: 'opencode-legacy' },
    { harness: 'opencode', path: join(data, 'opencode', 'opencode.db'), kind: 'opencode-db' },
    ...extraDirectories.map((path) => ({ harness: 'generic', path: expand(path), custom: true })),
  ];
}

function candidate(root, path) {
  const name = basename(path);
  if (root.custom) return ['.json', '.jsonl', '.ndjson'].includes(extname(name).toLowerCase());
  if (root.kind === 'opencode-legacy') return name.endsWith('.json');
  if (root.harness === 'gemini') return name.startsWith('session-') && name.endsWith('.json') && basename(dirname(path)) === 'chats';
  return name.endsWith('.jsonl') && !name.startsWith('agent-');
}

async function filePreview(file) {
  const handle = await open(file.path, 'r');
  try {
    const size = file.size;
    const buffer = Buffer.alloc(Math.min(size, PREVIEW_BYTES));
    const head = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, head.bytesRead).toString('utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) return null;
    let data;
    try { data = JSON.parse(text); } catch { /* A JSONL recording or a partial JSON preview. */ }
    let records = Array.isArray(data) ? data : data ? [data] : text.split('\n').flatMap((line) => {
      try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row] : []; } catch { return []; }
    });
    let tailRecords = [];
    if (size > PREVIEW_BYTES && extname(file.path) !== '.json') {
      const tail = Buffer.alloc(Math.min(size, 16384));
      const read = await handle.read(tail, 0, tail.length, size - tail.length);
      tailRecords = tail.subarray(0, read.bytesRead).toString('utf8').split('\n').flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    }
    const first = records.find((r) => r?.type === 'session_meta' || r?.type === 'session');
    let harness = file.harness;
    if (data?.harness) harness = data.harness;
    else if (records.some((r) => ['session_meta', 'response_item', 'event_msg'].includes(r?.type))) harness = 'codex';
    else if (first?.type === 'session') harness = 'pi';
    else if (records.some((r) => r?.message?.role)) harness = 'claude';
    else if (data?.info && data.messages) harness = 'opencode';
    else if (data?.sessionId && data.messages) harness = 'gemini';

    // Header fields in a large pretty-printed JSON can be read without loading
    // the whole conversation. Values are decoded as JSON strings, never code.
    const field = (name) => {
      const match = text.match(new RegExp(`"${name}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`));
      try { return match ? JSON.parse(match[1]) : ''; } catch { return ''; }
    };
    let title = data?.title || data?.info?.title || data?.summary || '';
    let cwd = data?.cwd || data?.info?.directory || first?.payload?.cwd || first?.cwd || field('cwd');
    let model = data?.model || '';
    let prompt = data?.turns?.[0]?.prompt || '';
    if (data?.messages) records = data.messages;
    for (const record of [...records, ...tailRecords]) {
      if (!record || typeof record !== 'object') continue;
      const message = record.message ?? record;
      if (record.type === 'session_info' && record.name) title = record.name;
      if (record.type === 'summary' && record.summary) title = record.summary;
      if (record.type === 'custom-title' && record.customTitle) title = record.customTitle;
      if (record.type === 'model_change' && record.modelId) model = record.modelId;
      if (record.type === 'turn_context' && record.payload?.model) model = record.payload.model;
      if (record.cwd) cwd = record.cwd;
      if (message.role === 'assistant' && message.model) model = message.model;
      if (record.type === 'event_msg' && record.payload?.type === 'user_message' && !prompt) prompt = record.payload.message;
      if (!prompt && !record.isMeta && !record.isSidechain && (message.role === 'user' || message.type === 'user')) {
        const blocks = Array.isArray(message.content) ? message.content.filter((p) => p.type !== 'tool_result') : message.content;
        const value = contentText(blocks);
        if (!/^\s*(# AGENTS\.md|<(environment_context|user_instructions|permissions))/.test(value)) prompt = value;
      }
      if (!prompt && record.info?.role === 'user') prompt = contentText((record.parts ?? []).filter((p) => p.type === 'text' && !p.synthetic));
    }
    if (file.kind === 'opencode-legacy') {
      if (!data?.id || data.parentID) return null;
      title = data.title;
      cwd = data.directory;
    }
    if (!records.length && !field('sessionId') && !field('harness') && !field('type')) return null;
    if (file.custom && harness === 'generic' && !data?.turns && !data?.messages && !records.some((r) => r?.role) && !field('role')) return null;
    // Sidechain-only files are not independent, presenter-driven sessions.
    if (records.length && records.every((r) => r?.isSidechain)) return null;
    if (!HARNESSES.includes(harness)) return null;
    return {
      lazy: true, kind: file.kind ?? 'file', source: file.path,
      id: data?.id, harness, modifiedAt: file.modifiedAt,
      title: truncate(singleLine(title || prompt || field('title') || field('summary') || basename(file.path, extname(file.path))), 120),
      cwd: singleLine(cwd), model: singleLine(model), preview: truncate(singleLine(prompt), 300),
    };
  } finally { await handle.close(); }
}

async function sqliteDatabase(path) {
  let sqlite;
  try { sqlite = await import('node:sqlite'); }
  catch { throw new Error('OpenCode database discovery needs Node.js 22.13+; JSON exports work on Node.js 20.'); }
  const db = new sqlite.DatabaseSync(path, { readOnly: true });
  return db;
}

async function databaseSessions(path) {
  const db = await sqliteDatabase(path);
  try {
    return db.prepare('SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ?').all(MAX_FILES).map((row) => ({
      lazy: true, kind: 'opencode-db', harness: 'opencode', source: `${path}#${row.id}`, database: path,
      id: row.id, title: singleLine(row.title || row.id), cwd: singleLine(row.directory), model: '', preview: '', modifiedAt: row.time_updated,
    }));
  } finally { db.close(); }
}

export async function discoverSessions({ roots = discoveryRoots(), signal, onProgress = () => {} } = {}) {
  const files = [], sessions = [], errors = [], sources = [];
  const seen = new Set();
  let directories = 0;
  const check = () => signal?.throwIfAborted();
  check();
  async function walk(root, directory, depth = 0) {
    check();
    if (depth > 10 || directories++ >= MAX_FILES || files.length >= MAX_FILES) return;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      check();
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        try { await walk(root, path, depth + 1); }
        catch (error) { if (signal?.aborted) throw error; errors.push(`${path}: ${error.message}`); }
      } else if (entry.isFile() && candidate(root, path) && files.length < MAX_FILES) {
        try {
          const canonical = await realpath(path);
          if (seen.has(canonical)) continue;
          seen.add(canonical);
          const info = await stat(path);
          files.push({ ...root, path, size: info.size, modifiedAt: info.mtimeMs });
        } catch (error) { errors.push(`${path}: ${error.message}`); }
      }
    }
  }
  for (const root of roots) {
    check();
    const source = { ...root, status: 'found', count: 0 };
    sources.push(source);
    try {
      if (root.kind === 'opencode-db') {
        await stat(root.path); // Never create a missing database.
        const found = await databaseSessions(root.path);
        sessions.push(...found);
        source.count = found.length;
      } else {
        const before = files.length;
        await walk(root, root.path);
        source.count = files.length - before;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      source.status = error.code === 'ENOENT' ? 'missing' : 'error';
      if (source.status === 'error') errors.push(`${root.path}: ${error.message}`);
    }
    onProgress({ found: files.length + sessions.length });
  }
  files.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
  // Limit concurrent reads and retain previews only; full replay parsing happens
  // when the presenter opens a session.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (cursor < files.length) {
      check();
      const file = files[cursor++];
      try {
        const session = await filePreview(file);
        if (session) sessions.push(session);
        else errors.push(`${file.path}: no recognizable session preview`);
      } catch (error) { if (signal?.aborted) throw error; errors.push(`${file.path}: ${error.message}`); }
    }
  }));
  if (files.length >= MAX_FILES || directories >= MAX_FILES) errors.push('Discovery reached its 10,000-file/directory limit. Use --session-dir to narrow the search.');
  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt || a.source.localeCompare(b.source));
  return { sessions, errors: errors.map(clean), sources };
}

export async function loadDiscoveredSession(entry) {
  if (!entry.lazy) return entry;
  if (entry.kind === 'file') return loadSession(entry.source);
  if (entry.kind === 'opencode-db') {
    const db = await sqliteDatabase(entry.database);
    try {
      const info = db.prepare('SELECT id, title, directory FROM session WHERE id = ?').get(entry.id);
      if (!info) throw new Error('This session no longer exists. Refresh discovery with r.');
      const messages = db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(entry.id);
      const parts = db.prepare('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id').all(entry.id);
      const byMessage = new Map();
      for (const part of parts) {
        if (!byMessage.has(part.message_id)) byMessage.set(part.message_id, []);
        byMessage.get(part.message_id).push(JSON.parse(part.data));
      }
      return parseSession(JSON.stringify({ info, messages: messages.map((m) => ({ info: JSON.parse(m.data), parts: byMessage.get(m.id) ?? [] })) }), entry.source);
    } finally { db.close(); }
  }
  if (entry.kind === 'opencode-legacy') {
    const info = JSON.parse(await readFile(entry.source, 'utf8'));
    if (!/^[\w-]+$/.test(info.id)) throw new Error('Invalid OpenCode session ID.');
    const storage = dirname(dirname(dirname(entry.source)));
    const jsonFiles = async (path) => {
      try { return (await readdir(path, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => join(path, e.name)).sort(); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    };
    const messages = [];
    for (const path of await jsonFiles(join(storage, 'message', info.id))) {
      const message = JSON.parse(await readFile(path, 'utf8'));
      if (!/^[\w-]+$/.test(message.id)) continue;
      const parts = [];
      for (const part of await jsonFiles(join(storage, 'part', message.id))) parts.push(JSON.parse(await readFile(part, 'utf8')));
      messages.push({ info: message, parts });
    }
    messages.sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0));
    return parseSession(JSON.stringify({ info, messages }), entry.source);
  }
  throw new Error('Unsupported discovery source. Open a JSON/JSONL export instead.');
}
