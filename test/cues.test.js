import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Playback } from '../src/playback.js';
import { parseSession } from '../src/session.js';
import { parseCue, validateCues, runCue } from '../src/cues.js';

const dir = mkdtempSync(join(tmpdir(), 'replay-cues-'));
const script = join(dir, 'apply.sh');
writeFileSync(script, 'echo "$REPLAY_TURN:$REPLAY_TOOL" >> "$(dirname "$0")/fired.txt"\n');

const session = () => parseSession(JSON.stringify({ version: 1, harness: 'claude', turns: [
  { prompt: 'First', events: [{ type: 'assistant', text: 'One' }] },
  { prompt: 'Second', events: [
    { type: 'tool', name: 'Edit', id: 'e1', text: 'a.txt\n- old\n+ new' },
    { type: 'result', id: 'e1', text: 'Updated a.txt' },
    { type: 'assistant', text: 'Done', durationMs: 1000 },
  ] },
] }));

function record(cues) {
  const fired = [];
  const p = new Playback(session(), { cues, onCue: (cue, turn) => fired.push({ cue: `${cue.turn}${cue.tool ? '@' + cue.tool : ''}`, turn, event: p.eventIndex, phase: p.phase }) });
  return { p, fired };
}

test('cue specs parse turn, tool and path; bare paths mean the last turn', () => {
  assert.deepEqual(parseCue(script), { turn: 'last', tool: undefined, path: script });
  assert.deepEqual(parseCue(`2:${script}`), { turn: 2, tool: undefined, path: script });
  assert.deepEqual(parseCue(`last@Edit:${script}`), { turn: 'last', tool: 'Edit', path: script });
  assert.throws(() => parseCue(join(dir, 'missing.sh')), /not found/);
  assert.throws(() => parseCue(`0:${script}`), /1 or higher/);
  assert.throws(() => parseCue(dir), /must be a file/);
  assert.throws(() => validateCues([parseCue(`3:${script}`)], session()), /out of range/);
  validateCues([parseCue(`2:${script}`)], session());
});

test('turn cues fire once when their turn finishes, never on other turns', () => {
  const { p, fired } = record([parseCue(`1:${script}`), parseCue(script)]);
  p.advance(); p.tick(100000);
  assert.deepEqual(fired.map((f) => [f.cue, f.turn]), [['1', 0]]);
  p.tick(100000);
  p.advance(); p.tick(100000);
  assert.deepEqual(fired.map((f) => [f.cue, f.turn]), [['1', 0], ['last', 1]]);
});

test('tool cues fire as the matching result appears, before the turn ends', () => {
  const { p, fired } = record([parseCue(`last@edit:${script}`), parseCue(script)]);
  p.advance(); p.tick(100000); p.advance();
  while (!fired.length && p.active) p.tick(5);
  assert.equal(fired[0].cue, 'last@edit');
  assert.equal(fired[0].event, 1);
  assert.equal(p.phase, 'playing');
  p.tick(100000);
  assert.deepEqual(fired.map((f) => f.cue), ['last@edit', 'last']);
});

test('skipping a turn fires pending tool cues first, and restart re-arms them', () => {
  const { p, fired } = record([parseCue(script), parseCue(`2@Bash:${script}`)]);
  p.advance(); p.skip(); p.advance(); p.skip();
  assert.deepEqual(fired.map((f) => f.cue), ['2@Bash', 'last']);
  p.skip();
  assert.equal(fired.length, 2);
  p.reset(); p.advance(); p.skip(); p.advance(); p.skip();
  assert.deepEqual(fired.map((f) => f.cue), ['2@Bash', 'last', '2@Bash', 'last']);
});

test('runCue executes non-executable scripts with sh and passes replay context', async () => {
  const statuses = [];
  const child = runCue(parseCue(`2@Edit:${script}`), { turn: 1, session: { source: 'x.jsonl' }, onStatus: (s) => statuses.push(s) });
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(readFileSync(join(dir, 'fired.txt'), 'utf8').trim(), '2:Edit');
  assert.deepEqual(statuses, [{ error: false, text: '↳ Ran apply.sh' }]);
});

test('CLI validates cues and reports them in --inspect', () => {
  const cli = (args) => spawnSync(process.execPath, ['bin/replay-harness.js', ...args], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(cli(['--demo', 'claude', '--inspect', '--exec', `last@Edit:${script}`]).stdout).cues, [`last@Edit:${script}`]);
  assert.match(cli(['--demo', 'claude', '--inspect', '--exec', `9:${script}`]).stderr, /out of range/);
  assert.match(cli(['--demo', 'claude', '--inspect', '--exec', 'nope.sh']).stderr, /not found/);
  assert.match(cli(['--demo', 'claude', '--inspect', '--bg', 'nope']).stderr, /Background/);
  assert.ok(!existsSync(join(dir, 'nope.sh')));
});
