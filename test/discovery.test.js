import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, utimes, symlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { discoveryRoots, discoverSessions, loadDiscoveredSession, filterSessions } from '../src/discovery.js';
import { createState, handleKey, refreshDiscovery } from '../src/app.js';
import { render } from '../src/render.js';
import { stripVTControlCharacters } from 'node:util';
import { width } from '../src/text.js';

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
const codex = (prompt = 'Build a dashboard') => jsonl([
  { type: 'session_meta', payload: { cwd: '/projects/atlas' } },
  { type: 'turn_context', payload: { model: 'test-codex-model' } },
  { type: 'event_msg', payload: { type: 'user_message', message: prompt } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
]);
const claude = jsonl([
  { type: 'user', cwd: '/projects/notes', message: { role: 'user', content: 'Fix search' } },
  { type: 'assistant', message: { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'Fixed.' }] } },
]);
const pi = jsonl([
  { type: 'session', version: 3, cwd: '/projects/cli' },
  { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Add a JSON flag' } },
  { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  { type: 'session_info', id: 'i', parentId: 'a', name: 'CLI improvement' },
]);
async function fixture(fn) {
  const home = await mkdtemp(join(tmpdir(), 'replay-discovery-'));
  const save = async (path, data) => { const file = join(home, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, data); return file; };
  try { await fn(home, save); }
  finally { await rm(home, { recursive: true, force: true }); }
}

test('discovers local harness sessions recursively, most recent first, without demos or sidechains', async () => fixture(async (home, save) => {
  const older = await save('.codex/sessions/2026/01/01/rollout.jsonl', codex());
  await utimes(older, new Date('2020-01-01'), new Date('2020-01-01'));
  await save('.claude/projects/project/main.jsonl', claude);
  await save('.claude/projects/project/subagents/agent-hidden.jsonl', claude);
  await save('.claude/projects/project/agent-hidden.jsonl', claude);
  await save('.pi/agent/sessions/project/recording.jsonl', pi);
  await save('.gemini/tmp/project/chats/session-1.json', JSON.stringify({ sessionId: 'g', summary: 'Date formatting', messages: [{ type: 'user', content: 'Fix dates' }, { type: 'gemini', content: 'Done' }] }));
  await save('.gemini/tmp/project/logs.json', '{}');
  await save('.codex/auth.json', '{"secret":"never read"}');
  const result = await discoverSessions({ roots: discoveryRoots({ home, env: {} }) });
  assert.equal(result.sessions.length, 4);
  assert.equal(result.sessions.at(-1).harness, 'codex');
  assert.deepEqual(new Set(result.sessions.map((s) => s.harness)), new Set(['codex', 'claude', 'pi', 'gemini']));
  assert.equal(result.sessions.find((s) => s.harness === 'pi').title, 'CLI improvement');
  assert.equal(result.sessions.find((s) => s.harness === 'claude').cwd, '/projects/notes');
  assert.equal(result.sessions.find((s) => s.harness === 'codex').model, 'test-codex-model');
  assert.ok(result.sessions.every((s) => s.lazy && !s.turns));
  assert.equal(result.errors.length, 0);
  const loaded = await loadDiscoveredSession(result.sessions.at(-1));
  assert.equal(loaded.turns[0].prompt, 'Build a dashboard');
  assert.equal(await readFile(older, 'utf8'), codex());
}));

test('missing locations are a valid empty state and are never created', async () => fixture(async (home) => {
  const result = await discoverSessions({ roots: discoveryRoots({ home, env: {} }) });
  assert.equal(result.sessions.length, 0);
  assert.equal(result.errors.length, 0);
  assert.ok(result.sources.every((s) => s.status === 'missing'));
  assert.deepEqual(await readdir(home), []);
}));

test('honors configured homes, extra folders, and avoids duplicate files and symlink recursion', async () => fixture(async (home, save) => {
  const file = await save('custom/sessions/recording.jsonl', codex());
  await symlink(dirname(file), join(dirname(file), 'loop'));
  const roots = discoveryRoots({ home, env: { CODEX_HOME: join(home, 'custom'), CLAUDE_CONFIG_DIR: '~/claude-config', PI_CODING_AGENT_DIR: '~/pi-config', XDG_DATA_HOME: '~/data' }, extraDirectories: [dirname(file)] });
  assert.equal(roots.find((r) => r.harness === 'claude').path, join(home, 'claude-config/projects'));
  assert.equal(roots.find((r) => r.harness === 'pi').path, join(home, 'pi-config/sessions'));
  const result = await discoverSessions({ roots });
  assert.equal(result.sessions.length, 1);
}));

test('one broken recording does not block other discoveries; previews are bounded and imports validate fully', async () => fixture(async (home, save) => {
  await save('.codex/sessions/broken.jsonl', 'invalid json');
  await save('.codex/sessions/good.jsonl', codex());
  await save('.codex/sessions/partial.jsonl', codex('Partial recording') + '\n' + ' '.repeat(300000) + '{bad');
  const result = await discoverSessions({ roots: discoveryRoots({ home, env: {} }) });
  assert.equal(result.sessions.length, 2);
  assert.equal(result.errors.length, 1);
  await assert.rejects(loadDiscoveredSession(result.sessions.find((s) => s.title === 'Partial recording')), /Invalid JSON/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverSessions({ roots: [], signal: controller.signal }), /aborted/i);
}));

test('legacy OpenCode storage is assembled into a replay without invoking OpenCode', async () => fixture(async (home, save) => {
  const prefix = '.local/share/opencode/storage';
  await save(`${prefix}/session/project/ses_demo.json`, JSON.stringify({ id: 'ses_demo', title: 'OpenCode work', directory: '/demo' }));
  await save(`${prefix}/message/ses_demo/msg_user.json`, JSON.stringify({ id: 'msg_user', role: 'user', time: { created: 1 } }));
  await save(`${prefix}/part/msg_user/part1.json`, JSON.stringify({ type: 'text', text: 'Add a health check' }));
  await save(`${prefix}/message/ses_demo/msg_agent.json`, JSON.stringify({ id: 'msg_agent', role: 'assistant', time: { created: 2 }, modelID: 'test-model' }));
  await save(`${prefix}/part/msg_agent/part2.json`, JSON.stringify({ type: 'text', text: 'Done' }));
  const result = await discoverSessions({ roots: discoveryRoots({ home, env: {} }) });
  assert.equal(result.sessions.length, 1);
  const loaded = await loadDiscoveredSession(result.sessions[0]);
  assert.equal(loaded.harness, 'opencode');
  assert.equal(loaded.turns[0].prompt, 'Add a health check');
  assert.equal(loaded.turns[0].events[0].text, 'Done');
}));

test('OpenCode SQLite discovery and opening use read-only queries', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { t.skip('node:sqlite unavailable'); return; }
  await fixture(async (home) => {
    const path = join(home, 'opencode.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE session (id TEXT, title TEXT, directory TEXT, parent_id TEXT, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);`);
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('s', 'Database demo', '/demo', null, 100);
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run('child', 'Subagent', '/demo', 's', 200);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 's', 1, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m2', 's', 2, JSON.stringify({ role: 'assistant' }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p1', 's', 'm1', 1, JSON.stringify({ type: 'text', text: 'Hello' }));
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p2', 's', 'm2', 2, JSON.stringify({ type: 'text', text: 'Hi' }));
    db.close();
    const before = await readFile(path);
    const result = await discoverSessions({ roots: [{ harness: 'opencode', kind: 'opencode-db', path }] });
    assert.equal(result.errors.length, 0);
    assert.equal(result.sessions.length, 1);
    const loaded = await loadDiscoveredSession(result.sessions[0]);
    assert.equal(loaded.turns[0].prompt, 'Hello');
    assert.equal(loaded.turns[0].events[0].text, 'Hi');
    assert.deepEqual(await readFile(path), before);
  });
});

test('discovery refresh, search, filtering and lazy selection work together', async () => fixture(async (home, save) => {
  await save('.codex/sessions/one.jsonl', codex());
  await save('.claude/projects/demo/two.jsonl', claude);
  const state = createState([], { discover: (options) => discoverSessions({ ...options, roots: discoveryRoots({ home, env: {} }) }) });
  await refreshDiscovery(state);
  assert.equal(state.view, 'discovery');
  await handleKey(state, '/');
  for (const char of 'notes') await handleKey(state, char);
  await handleKey(state, '\r', { name: 'return' });
  assert.equal(filterSessions(state.sessions, state.filter, state.query).length, 1);
  await handleKey(state, '\r', { name: 'return' });
  assert.equal(state.view, 'player');
  assert.equal(state.playback.session.harness, 'claude');
  await handleKey(state, '', { name: 'escape' });
  await handleKey(state, '', { name: 'escape' });
  assert.equal(state.query, '');
  await handleKey(state, '\t', { name: 'tab' });
  assert.equal(state.filter, 'codex');
  await handleKey(state, 'r');
  assert.equal(state.filter, 'codex');
  assert.equal(state.discovering, false);
  const selected = filterSessions(state.sessions, state.filter)[0];
  await rm(selected.source);
  await handleKey(state, '\r', { name: 'return' });
  assert.equal(state.view, 'discovery');
  assert.match(state.error, /ENOENT/);
}));

test('discovery empty, loading, filtered and import states fit small terminals', () => {
  for (const [columns, rows] of [[48, 16], [60, 22], [80, 24], [120, 40]]) {
    const state = createState([]);
    for (const mode of ['empty', 'loading', 'search', 'import']) {
      state.discovering = mode === 'loading'; state.searching = mode === 'search'; state.importing = mode === 'import';
      const lines = render(state, columns, rows);
      assert.ok(stripVTControlCharacters(lines.join('\n')).includes('Session discovery'));
      for (const line of lines) assert.ok(width(line) <= columns, `${mode} ${columns}: ${stripVTControlCharacters(line)}`);
      assert.ok(lines.length <= rows);
    }
  }
});
