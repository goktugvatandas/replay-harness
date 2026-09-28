#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { scanSessions, loadSession, HARNESSES } from '../src/session.js';
import { validSpeed } from '../src/playback.js';
import { runApp } from '../src/app.js';
import { clean } from '../src/text.js';
import { discoverSessions, discoveryRoots } from '../src/discovery.js';
import { DEFAULT_TYPING_SPEED } from '../src/typing.js';

const help = `
  REPLAY HARNESS
  Offline, keyboard-driven demos of your coding agent sessions.

  Usage
    replay-harness [session.jsonl] [options]
    node bin/replay-harness.js [session.jsonl] [options]

  Options
    --demo <name>         Open a bundled demo (codex, claude, pi, opencode, gemini)
    --speed <number>      Playback multiplier, 0.1–20 (default: 1)
    --typing-speed <cps>  Typing pace before pauses at 1× (default: ${DEFAULT_TYPING_SPEED})
    --theme <name>        Override the harness visual identity
    --present            Start with replay controls hidden; f toggles them
    --timing <mode>      natural (default) or recorded (gaps capped at 5 seconds)
    --session-dir <path> Also discover sessions recursively in this directory
    --inspect            Print session metadata without opening the TUI
    --list               Discover and list local sessions without opening the TUI
    -h, --help           Show this help
    -v, --version        Show version

  Playback
    Enter / Space  Type and send the next prompt (waits after each turn)
    p              Pause / resume      + / −     Adjust speed
    n              Finish this turn    [ / ]     Previous / next turn
    r              Restart             f         Presentation mode
    ↑ / ↓          Scroll              x         Expand tool output
    ?              All controls        q         Quit

  Supported inputs: Codex, Claude Code, Pi, OpenCode, Gemini CLI,
  generic role/content chat JSON, and editable replay scripts.
  Recordings are only displayed. No agent, tool, or network request runs.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      demo: { type: 'string' }, speed: { type: 'string', default: '1' },
      'typing-speed': { type: 'string', default: String(DEFAULT_TYPING_SPEED) }, theme: { type: 'string' },
      present: { type: 'boolean' }, timing: { type: 'string', default: 'natural' },
      'session-dir': { type: 'string' }, inspect: { type: 'boolean' }, list: { type: 'boolean' },
    },
  });
  if (values.help) { process.stdout.write(help); return; }
  if (values.version) { process.stdout.write('0.1.0\n'); return; }
  if (positionals.length > 1) throw new Error('Pass one session file, or use --session-dir for discovery.');
  if (positionals.length && values.demo) throw new Error('Choose either a session file or --demo.');
  const speed = validSpeed(values.speed);
  const typingSpeed = Number(values['typing-speed']);
  if (!Number.isFinite(typingSpeed) || typingSpeed < 1 || typingSpeed > 1000) throw new Error('Typing speed must be between 1 and 1000 characters per second.');
  if (values.theme && !HARNESSES.includes(values.theme)) throw new Error(`Unknown theme. Choose ${HARNESSES.join(', ')}.`);
  if (!['natural', 'recorded'].includes(values.timing)) throw new Error('Timing must be natural or recorded.');
  if (values.demo && !HARNESSES.filter((h) => h !== 'generic').includes(values.demo)) throw new Error('Choose a demo: codex, claude, pi, opencode, gemini.');
  const sessions = [];
  let directIndex = 0;
  if (values.demo) {
    const examples = fileURLToPath(new URL('../examples/', import.meta.url));
    const demos = await scanSessions(examples);
    sessions.push(...demos.sessions.filter((s) => s.harness === values.demo));
    if (!sessions.length) throw new Error('This bundled demo is missing.');
  }
  if (positionals[0]) { directIndex = sessions.length; sessions.push(await loadSession(positionals[0])); }
  if (values.inspect) {
    if (!positionals[0] && !values.demo) throw new Error('Use --inspect with a session file or --demo <name>.');
    const s = sessions[directIndex];
    process.stdout.write(JSON.stringify({ title: s.title, harness: s.harness, model: s.model, cwd: s.cwd, turns: s.turns.length, events: s.eventCount, warnings: s.warnings }, null, 2) + '\n');
    return;
  }
  const roots = discoveryRoots({ extraDirectories: values['session-dir'] ? [values['session-dir']] : [] });
  const discover = (options) => discoverSessions({ ...options, roots });
  if (values.list) {
    const result = sessions.length ? { sessions, errors: [] } : await discover();
    for (const s of result.sessions) process.stdout.write(`${s.harness.padEnd(10)} ${s.title}\n  ${clean(s.source)}\n`);
    if (!result.sessions.length) process.stdout.write('No saved sessions found. Use --session-dir <path> or open a file directly.\n');
    for (const error of result.errors) process.stderr.write(`Discovery: ${clean(error)}\n`);
    return;
  }
  await runApp(sessions, { speed, typingSpeed, theme: values.theme, present: values.present, timing: values.timing, direct: Boolean(positionals[0] || values.demo), directIndex, discover });
}

main().catch((error) => { process.stderr.write(`Replay Harness: ${clean(error.message)}\n`); process.exitCode = 1; });
