import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { clean } from './text.js';

// Presenter-supplied scripts only. Nothing in a recording can add or change a cue.
export function parseCue(value) {
  const match = /^(\d+|last)(@[\w.-]+)?:(.+)$/.exec(value);
  const [turn, tool, path] = match ? [match[1], match[2]?.slice(1), match[3]] : ['last', undefined, value];
  if (turn !== 'last' && Number(turn) < 1) throw new Error(`Cue turn must be 1 or higher: ${value}`);
  const absolute = resolve(path);
  let stat;
  try { stat = statSync(absolute); } catch { throw new Error(`Cue script not found: ${path}`); }
  if (!stat.isFile()) throw new Error(`Cue script must be a file: ${path}`);
  return { turn: turn === 'last' ? 'last' : Number(turn), tool, path: absolute };
}

// Zero-based turn index for a session, or -1 when the cue does not fit it.
export function cueTurn(cue, session) {
  const index = cue.turn === 'last' ? session.turns.length - 1 : cue.turn - 1;
  return index < session.turns.length ? index : -1;
}

export function validateCues(cues, session) {
  for (const cue of cues) {
    if (cueTurn(cue, session) < 0) throw new Error(`Cue turn ${cue.turn} is out of range. This recording has ${session.turns.length} turns.`);
  }
}

export function describeCue(cue) {
  return `${cue.turn}${cue.tool ? '@' + cue.tool : ''}:${cue.path}`;
}

// Runs one cue detached so a slow script never blocks playback or outlives a quit badly.
export function runCue(cue, { turn, session, log, onStatus = () => {} } = {}) {
  let command = cue.path, args = [];
  try { accessSync(cue.path, constants.X_OK); } catch { command = '/bin/sh'; args = [cue.path]; }
  const name = basename(cue.path);
  let output = 'ignore';
  try {
    if (log) output = openSync(log, 'a');
    const child = spawn(command, args, {
      cwd: process.cwd(), detached: true, stdio: ['ignore', output, output],
      env: { ...process.env, REPLAY_TURN: String(turn + 1), REPLAY_SESSION: session?.source ?? '', REPLAY_TOOL: cue.tool ?? '' },
    });
    child.on('error', (error) => onStatus({ error: true, text: `Cue ${name} failed: ${clean(error.message)}` }));
    child.on('exit', (code, signal) => {
      if (code) onStatus({ error: true, text: `Cue ${name} exited with code ${code}` });
      else if (signal) onStatus({ error: true, text: `Cue ${name} stopped by ${signal}` });
    });
    child.unref();
    onStatus({ error: false, text: `↳ Ran ${name}` });
    return child;
  } catch (error) {
    onStatus({ error: true, text: `Cue ${name} failed: ${clean(error.message)}` });
  } finally {
    if (typeof output === 'number') closeSync(output);
  }
}
