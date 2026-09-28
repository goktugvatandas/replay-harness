import { emitKeypressEvents } from 'node:readline';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { loadSession, HARNESSES } from './session.js';
import { filterSessions, loadDiscoveredSession } from './discovery.js';
import { Playback, SPEEDS } from './playback.js';
import { DEFAULT_TYPING_SPEED } from './typing.js';
import { render } from './render.js';
import { ansiColor, palette } from './themes.js';
import { clean, graphemes } from './text.js';

export function createState(sessions, options = {}) {
  return {
    sessions, selected: 0, view: 'discovery', speed: options.speed ?? 1,
    present: Boolean(options.present), theme: options.theme, themeOverride: options.theme,
    timing: options.timing ?? 'natural', typingSpeed: options.typingSpeed ?? DEFAULT_TYPING_SPEED,
    playback: null, scroll: 0, help: false, expanded: false,
    importing: false, input: '', error: '', loading: false,
    filter: 'all', query: '', searching: false, discovering: false, discovered: false,
    discoveryCount: 0, discoveryErrors: [], sources: [], imported: [], discover: options.discover,
  };
}

export async function refreshDiscovery(state) {
  if (!state.discover || state.discovering) return;
  const source = filterSessions(state.sessions, state.filter, state.query)[state.selected]?.source;
  state.discovering = true;
  state.error = '';
  state.discoveryCount = 0;
  state.discoveryAbort = new AbortController();
  try {
    const result = await state.discover({ signal: state.discoveryAbort.signal, onProgress: ({ found }) => { state.discoveryCount = found; } });
    state.sessions = [...result.sessions, ...state.imported.filter((s) => !result.sessions.some((entry) => entry.source === s.source))];
    state.sources = result.sources;
    state.discoveryErrors = result.errors;
    state.discovered = true;
    const visible = filterSessions(state.sessions, state.filter, state.query);
    state.selected = Math.max(0, visible.findIndex((s) => s.source === source));
  } catch (error) { if (!state.discoveryAbort.signal.aborted) state.error = clean(error.message); }
  finally { state.discovering = false; }
}

async function openSelected(state) {
  const entry = filterSessions(state.sessions, state.filter, state.query)[state.selected];
  if (!entry) return;
  state.loading = true;
  state.error = '';
  try {
    const loaded = await loadDiscoveredSession(entry);
    const index = state.sessions.indexOf(entry);
    state.sessions[index] = { ...entry, ...loaded, lazy: false, title: entry.title };
    const selected = state.selected;
    openRecording(state, index);
    state.selected = selected;
  } catch (error) { state.error = clean(error.message); }
  finally { state.loading = false; }
}

export function openRecording(state, index = state.selected) {
  state.selected = index;
  state.playback = new Playback(state.sessions[index], { speed: state.speed, timing: state.timing, typingSpeed: state.typingSpeed });
  state.theme = state.themeOverride ?? state.sessions[index].harness;
  state.view = 'player';
  state.scroll = 0;
  state.help = false;
  state.error = '';
}

function pathFromInput(value) {
  let path = value.trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
  path = path.replace(/\\([ ()\[\]'"&])/g, '$1');
  if (path.startsWith('~/')) path = homedir() + path.slice(1);
  return path;
}

export async function handleKey(state, str, key = {}, rows = 30) {
  if (key.ctrl && key.name === 'c') return 'quit';
  if (!state.importing && !state.searching && str === 'q') return 'quit';
  if (state.loading) return;
  if (state.searching) {
    if (key.name === 'escape' || key.name === 'return') state.searching = false;
    else if (key.name === 'backspace') state.query = graphemes(state.query).slice(0, -1).join('');
    else if (key.ctrl && key.name === 'u') state.query = '';
    else if (str && !key.ctrl && !key.meta && !str.startsWith('\x1b')) state.query += clean(str).replace(/\n/g, '');
    state.selected = 0;
    return;
  }
  if (state.importing) {
    if (key.name === 'escape') { state.importing = false; state.error = ''; return; }
    if (key.name === 'return') {
      if (!state.input.trim()) return;
      state.loading = true;
      try {
        const session = await loadSession(pathFromInput(state.input));
        let index = state.sessions.findIndex((s) => s.source === session.source);
        if (index < 0) { index = state.sessions.length; state.sessions.push(session); }
        else state.sessions[index] = session;
        state.imported = [...state.imported.filter((s) => s.source !== session.source), session];
        state.importing = false;
        openRecording(state, index);
      } catch (error) { state.error = clean(error.message); }
      finally { state.loading = false; }
    } else if (key.name === 'backspace') state.input = graphemes(state.input).slice(0, -1).join('');
    else if (key.ctrl && key.name === 'u') state.input = '';
    else if (str && !key.ctrl && !key.meta && !str.startsWith('\x1b')) state.input += clean(str).replace(/\n/g, '');
    return;
  }
  const direction = str === '+' || str === '=' ? 1 : str === '-' || str === '_' ? -1 : 0;
  if (direction) {
    if (state.playback && state.view === 'player') { state.playback.changeSpeed(direction); state.speed = state.playback.speed; }
    else state.speed = direction > 0 ? SPEEDS.find((s) => s > state.speed) ?? 20 : SPEEDS.findLast((s) => s < state.speed) ?? 0.1;
    return;
  }
  if (state.view === 'discovery') {
    if (state.discovering) return;
    const visible = filterSessions(state.sessions, state.filter, state.query);
    if (key.name === 'up' || str === 'k') state.selected = Math.max(0, state.selected - 1);
    if (key.name === 'down' || str === 'j') state.selected = Math.max(0, Math.min(visible.length - 1, state.selected + 1));
    if (key.name === 'pageup') state.selected = Math.max(0, state.selected - 10);
    if (key.name === 'pagedown') state.selected = Math.max(0, Math.min(visible.length - 1, state.selected + 10));
    if (key.name === 'return' || str === ' ') await openSelected(state);
    if (key.name === 'tab') {
      const filters = ['all', ...HARNESSES.filter((h) => state.sessions.some((s) => s.harness === h))];
      state.filter = filters[(filters.indexOf(state.filter) + (key.shift ? filters.length - 1 : 1)) % filters.length];
      state.selected = 0;
    }
    if (str === '/') state.searching = true;
    if (str === 'r') await refreshDiscovery(state);
    if (key.name === 'escape') { state.query = ''; state.filter = 'all'; state.selected = 0; }
    if (str === 'o') { state.importing = true; state.input = ''; state.error = ''; }
    return;
  }
  const p = state.playback;
  if (str === '?' || str === 'h') {
    state.help = !state.help;
    state.helpScroll = 0;
    if (state.help && p.active && !p.paused) { p.togglePause(); state.helpPaused = true; }
    else if (!state.help && state.helpPaused) { p.togglePause(); state.helpPaused = false; }
    return;
  }
  if (key.name === 'escape') {
    if (state.help) { state.help = false; if (state.helpPaused) p.togglePause(); state.helpPaused = false; }
    else { state.view = 'discovery'; state.present = false; if (!state.discovered) await refreshDiscovery(state); }
    return;
  }
  if (state.help) {
    if (key.name === 'up' || str === 'k') state.helpScroll = Math.max(0, (state.helpScroll ?? 0) - 3);
    if (key.name === 'down' || str === 'j') state.helpScroll = (state.helpScroll ?? 0) + 3;
    if (key.name === 'pageup') state.helpScroll = Math.max(0, (state.helpScroll ?? 0) - rows + 10);
    if (key.name === 'pagedown') state.helpScroll = (state.helpScroll ?? 0) + Math.max(3, rows - 10);
    return;
  }
  if (key.name === 'return' || str === ' ') { p.advance(); state.scroll = 0; }
  if (str === 'p') p.togglePause();
  if (str === 'n') { p.skip(); state.scroll = 0; }
  if (str === 'r') { p.reset(); state.scroll = 0; }
  if (str === '[') { p.seek(p.turnIndex - 1); state.scroll = 0; }
  if (str === ']') { p.seek(p.turnIndex + 1); state.scroll = 0; }
  if (str === 'f') state.present = !state.present;
  if (str === 'x') state.expanded = !state.expanded;
  if (str === 't') state.theme = HARNESSES[(HARNESSES.indexOf(state.theme) + 1) % HARNESSES.length];
  if (key.name === 'up' || str === 'k') state.scroll += 3;
  if (key.name === 'down' || str === 'j') state.scroll = Math.max(0, state.scroll - 3);
  if (key.name === 'pageup') state.scroll += Math.max(3, rows - 10);
  if (key.name === 'pagedown') state.scroll = Math.max(0, state.scroll - Math.max(3, rows - 10));
  if (key.name === 'home') state.scroll = Number.MAX_SAFE_INTEGER;
  if (key.name === 'end') state.scroll = 0;
}

export async function runApp(sessions, options = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive playback needs a terminal. Run this command in a terminal, or use --inspect / --list.');
  const state = createState(sessions, options);
  if (options.direct) openRecording(state, options.directIndex ?? 0);
  const input = process.stdin, output = process.stdout;
  let previous = [], timer, last = performance.now(), closed = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const rawBefore = Boolean(input.isRaw);
  function draw(force = false) {
    const columns = Math.max(1, (output.columns || 80) - 1);
    const rows = output.rows || 24;
    const lines = render(state, columns, rows);
    let frame = force ? '\x1b[2J' : '';
    for (let i = 0; i < rows; i++) {
      const line = lines[i] ?? '';
      if (force || previous[i] !== line) frame += `\x1b[${i + 1};1H${ansiColor(palette.background, true)}\x1b[2K${line}\x1b[0m`;
    }
    previous = lines;
    if (frame) output.write(frame);
  }
  function close() {
    if (closed) return;
    closed = true;
    state.discoveryAbort?.abort();
    clearInterval(timer);
    input.removeListener('keypress', onKey);
    output.removeListener('resize', onResize);
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
    process.removeListener('exit', close);
    if (input.isTTY) input.setRawMode(rawBefore);
    input.pause();
    output.write('\x1b[0m\x1b[?25h\x1b[?7h\x1b[?1049l');
    resolveDone();
  }
  async function onKey(str, key) {
    try {
      const pending = handleKey(state, str, key, output.rows || 24);
      if (!closed) draw();
      if (await pending === 'quit') { close(); return; }
      if (!closed) draw();
    } catch (error) { close(); process.stderr.write(`Replay Harness: ${clean(error.message)}\n`); process.exitCode = 1; }
  }
  function onResize() { if (!closed) draw(true); }
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  input.on('keypress', onKey);
  output.on('resize', onResize);
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  process.on('exit', close);
  output.write('\x1b[?1049h\x1b[?25l\x1b[?7l');
  try {
    draw(true);
    if (!options.direct && state.discover) {
      void refreshDiscovery(state).then(() => { if (!closed) draw(); });
    }
    timer = setInterval(() => {
      try {
        const now = performance.now();
        // Ignore long sleep/wake gaps so resuming a laptop doesn't finish a demo.
        const delta = Math.min(100, now - last);
        last = now;
        if (state.view === 'player' && state.playback.active && !state.playback.paused) {
          state.playback.tick(delta);
          draw();
        }
        if (state.view === 'discovery' && state.discovering) draw();
      } catch (error) { close(); process.stderr.write(`Replay Harness: ${clean(error.message)}\n`); process.exitCode = 1; }
    }, 33);
    await done;
  } finally { close(); }
}
