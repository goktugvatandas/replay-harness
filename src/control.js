import { createServer } from 'node:net';
import { rmSync, statSync } from 'node:fs';

export const CONTROL_COMMANDS = ['advance', 'skip', 'restart', 'present', 'quit', 'status'];

// A local remote for show-runners: newline commands in, JSON status lines out.
// `onCommand(name)` performs the command; `getStatus()` returns the current
// status object, broadcast on connect, on `status`, and whenever `notify()` is
// called with a changed status.
export function createControlServer(path, { onCommand, getStatus }) {
  const clients = new Set();
  let last = '';
  try { if (statSync(path).isSocket()) rmSync(path); } catch { /* nothing stale */ }

  const line = () => JSON.stringify(getStatus()) + '\n';
  const send = (socket, text) => { if (!socket.destroyed) socket.write(text); };

  const server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding('utf8');
    send(socket, line());
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const command = buffer.slice(0, index).trim().toLowerCase();
        buffer = buffer.slice(index + 1);
        if (!command) continue;
        if (!CONTROL_COMMANDS.includes(command)) { send(socket, JSON.stringify({ error: `unknown command: ${command}` }) + '\n'); continue; }
        if (command === 'status') { send(socket, line()); continue; }
        Promise.resolve(onCommand(command)).then(() => notify(), () => notify());
      }
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });

  function notify(force = false) {
    const text = line();
    if (!force && text === last) return;
    last = text;
    for (const socket of clients) send(socket, text);
  }

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); last = line(); resolve(); });
  });

  function close() {
    for (const socket of clients) socket.destroy();
    clients.clear();
    server.close();
    try { rmSync(path); } catch { /* already gone */ }
  }

  return { ready, notify, close, clients };
}

export function playbackStatus(state) {
  const p = state.playback;
  if (!p) return { phase: 'discovery', turn: 0, turns: 0, session: '' };
  const turns = p.session.turns.length;
  return { phase: p.phase, turn: Math.min(p.turnIndex + 1, turns), turns, session: p.session.source ?? '' };
}
