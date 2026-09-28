import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanSessions } from '../src/session.js';
import { createState, handleKey, openRecording } from '../src/app.js';
import { render } from '../src/render.js';
import { clean, width, wrap } from '../src/text.js';
import { themes } from '../src/themes.js';

const { sessions } = await scanSessions(fileURLToPath(new URL('../examples', import.meta.url)));

test('all five bundled demos load with multiple turns', () => {
  assert.equal(sessions.length, 5);
  for (const s of sessions) assert.ok(s.turns.length >= 2);
});

test('key-driven workflow opens, plays, pauses, advances and returns to discovery', async () => {
  const s = createState(sessions);
  await handleKey(s, '', { name: 'down' });
  assert.equal(s.selected, 1);
  await handleKey(s, '\r', { name: 'return' });
  assert.equal(s.view, 'player');
  await handleKey(s, ' ', { name: 'space' });
  assert.equal(s.playback.phase, 'typing');
  await handleKey(s, 'p');
  assert.equal(s.playback.paused, true);
  await handleKey(s, 'n');
  assert.equal(s.playback.phase, 'complete');
  await handleKey(s, '\r', { name: 'return' });
  assert.equal(s.playback.turnIndex, 1);
  await handleKey(s, 'f');
  assert.equal(s.present, true);
  await handleKey(s, '', { name: 'escape' });
  assert.equal(s.view, 'discovery');
  assert.equal(await handleKey(s, 'q'), 'quit');
});

test('opening help pauses playback and restores only its own pause', async () => {
  const s = createState(sessions); openRecording(s); s.playback.advance();
  await handleKey(s, '?'); assert.equal(s.playback.paused, true);
  await handleKey(s, '?'); assert.equal(s.playback.paused, false);
  s.playback.togglePause();
  await handleKey(s, '?'); await handleKey(s, '?');
  assert.equal(s.playback.paused, true);
});

test('presentation mode hides replay labels and preserves harness identity', () => {
  for (let i = 0; i < sessions.length; i++) {
    const s = createState(sessions, { present: true }); openRecording(s, i);
    const screen = stripVTControlCharacters(render(s, 100, 32).join('\n'));
    assert.ok(screen.includes(themes[s.theme].name));
    assert.ok(!screen.includes('REPLAY HARNESS'));
    assert.ok(!screen.includes('next prompt is queued'));
  }
});

test('frames fit terminal width and height for narrow, normal and wide windows', () => {
  for (const [columns, rows] of [[48, 16], [60, 22], [80, 24], [120, 40]]) {
    const s = createState(sessions);
    for (const view of ['discovery', 'ready', 'playing', 'help']) {
      if (view === 'ready') openRecording(s);
      if (view === 'playing') { s.playback.advance(); s.playback.skip(); }
      if (view === 'help') s.help = true;
      const lines = render(s, columns, rows);
      assert.ok(lines.length <= rows, `${view} at ${columns}x${rows}: too many rows`);
      for (const line of lines) assert.ok(width(line) <= columns, `${view} at ${columns}x${rows}: ${stripVTControlCharacters(line)} (${width(line)})`);
    }
  }
});

test('terminal controls are removed from recordings and Unicode wraps by cells', () => {
  assert.equal(clean('\x1b[31mred\x1b[0m\x1b]52;c;xxx\x07'), 'red');
  assert.equal(width('界👩‍💻a'), 5);
  assert.deepEqual(wrap('界界a', 4), ['界界', 'a']);
});

test('CLI validates flags and offers non-TTY inspection', () => {
  const cli = (args) => spawnSync(process.execPath, ['bin/replay-harness.js', ...args], { encoding: 'utf8' });
  assert.equal(cli(['--help']).status, 0);
  assert.equal(cli(['--demo', 'pi', '--inspect']).status, 0);
  assert.equal(JSON.parse(cli(['--demo', 'pi', '--inspect']).stdout).harness, 'pi');
  assert.match(cli(['--speed', '0']).stderr, /Speed/);
  assert.match(cli(['--demo', 'missing']).stderr, /Choose a demo/);
  assert.match(cli([]).stderr, /needs a terminal/);
});
