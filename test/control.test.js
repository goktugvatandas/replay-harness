import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlServer, playbackStatus } from '../src/control.js';
import { scanSessions } from '../src/session.js';
import { createState, openRecording, handleKey } from '../src/app.js';

const { sessions } = await scanSessions(fileURLToPath(new URL('../examples', import.meta.url)));

function client(path) {
  const socket = connect(path);
  socket.setEncoding('utf8');
  const lines = [];
  let buffer = '', waiters = [];
  socket.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) { lines.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); }
    waiters = waiters.filter((w) => !w());
  });
  const next = (count) => new Promise((resolve) => {
    const check = () => { if (lines.length >= count) { resolve(lines[count - 1]); return true; } return false; };
    if (!check()) waiters.push(check);
  });
  return { socket, lines, next, send: (text) => socket.write(text + '\n') };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'rh-control-'));
  const path = join(dir, 'control.sock');
  const state = createState(sessions);
  openRecording(state, 0);
  const commands = [];
  const server = createControlServer(path, {
    getStatus: () => playbackStatus(state),
    onCommand: async (command) => {
      commands.push(command);
      const keys = { advance: ['\r', { name: 'return' }], skip: ['n', {}], restart: ['r', {}], present: ['f', {}] };
      if (keys[command]) await handleKey(state, ...keys[command]);
    },
  });
  return { dir, path, state, server, commands };
}

test('control socket sends status on connect and after commands', async () => {
  const { path, state, server, commands } = setup();
  await server.ready;
  const c = client(path);
  const first = await c.next(1);
  assert.deepEqual({ phase: first.phase, turn: first.turn }, { phase: 'ready', turn: 1 });
  assert.equal(first.turns, state.playback.session.turns.length);
  c.send('advance');
  const typing = await c.next(2);
  assert.equal(typing.phase, 'typing');
  c.send('skip');
  const complete = await c.next(3);
  assert.equal(complete.phase, 'complete');
  c.send('status');
  assert.equal((await c.next(4)).phase, 'complete');
  c.send('present');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(state.present, true);
  assert.deepEqual(commands, ['advance', 'skip', 'present']);
  c.socket.destroy();
  server.close();
  assert.equal(existsSync(path), false);
});

test('control socket broadcasts phase changes driven by playback ticks', async () => {
  const { path, state, server } = setup();
  await server.ready;
  const a = client(path), b = client(path);
  await a.next(1); await b.next(1);
  state.playback.advance();
  server.notify();
  assert.equal((await a.next(2)).phase, 'typing');
  assert.equal((await b.next(2)).phase, 'typing');
  server.notify();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(a.lines.length, 2, 'unchanged status is not re-sent');
  a.socket.destroy(); b.socket.destroy();
  server.close();
});

test('control socket rejects unknown commands and replaces a stale socket file', async () => {
  const first = setup();
  await first.server.ready;
  first.server.close();
  const { path, server } = setup();
  await server.ready;
  const c = client(path);
  await c.next(1);
  c.send('explode');
  assert.match((await c.next(2)).error, /unknown command/);
  c.socket.destroy();
  server.close();
});

test('playbackStatus reports discovery before a recording opens', () => {
  assert.deepEqual(playbackStatus(createState(sessions)), { phase: 'discovery', turn: 0, turns: 0, session: '' });
});
