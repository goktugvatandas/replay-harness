import test from 'node:test';
import assert from 'node:assert/strict';
import { Playback } from '../src/playback.js';
import { parseSession } from '../src/session.js';

function stepUntil(playback, condition, limit = 10000) {
  for (let i = 0; i < limit && !condition(); i++) playback.tick(1);
  assert.ok(condition(), 'Playback did not reach the expected state');
}

const session = () => parseSession(JSON.stringify({ version: 1, harness: 'codex', turns: [
  { prompt: 'Hello world', events: [{ type: 'assistant', text: 'First answer', delayMs: 100, durationMs: 1000 }] },
  { prompt: 'Second prompt', events: [{ type: 'tool', name: 'bash', text: 'never executed' }, { type: 'result', text: 'Second answer' }] },
] }));

test('Enter starts typing; another advance during playback never queues a prompt', () => {
  const p = new Playback(session());
  assert.equal(p.phase, 'ready');
  assert.equal(p.visibleTurns().length, 0);
  p.advance();
  stepUntil(p, () => p.promptLength > 0);
  assert.equal(p.phase, 'typing');
  assert.equal(p.prompt, 'H');
  assert.equal(p.advance(), false);
  p.tick(100000);
  assert.equal(p.phase, 'complete');
  assert.equal(p.turnIndex, 0);
  p.tick(100000);
  assert.equal(p.turnIndex, 0);
  assert.equal(p.visibleTurns().length, 1);
  p.advance();
  assert.equal(p.turnIndex, 1);
  p.tick(100000);
  assert.equal(p.phase, 'finished');
  assert.equal(p.advance(), false);
});

test('pause freezes the virtual clock and speed applies to both prompt and output', () => {
  const normal = new Playback(session());
  const fast = new Playback(session(), { speed: 2 });
  normal.advance(); fast.advance();
  normal.tick(400); fast.tick(200);
  assert.ok(normal.promptLength > 0);
  assert.equal(normal.prompt, fast.prompt);
  normal.togglePause();
  const elapsed = normal.elapsed;
  normal.tick(100000);
  assert.equal(normal.elapsed, elapsed);
  normal.togglePause(); normal.tick(100);
  assert.ok(normal.elapsed > elapsed);
});

test('assistant text streams and future events stay hidden', () => {
  const p = new Playback(session(), { typingSpeed: 1000 });
  p.advance();
  stepUntil(p, () => p.phase === 'playing');
  p.tick(600); // 100ms event delay + 500ms of streaming
  assert.equal(p.phase, 'playing');
  const turns = p.visibleTurns();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].events[0].text, 'First ');
  assert.equal(turns[0].events[0].complete, false);
  assert.ok(!JSON.stringify(turns).includes('Second'));
});

test('skip, rewind, restart and seek cancel in-flight playback', () => {
  const p = new Playback(session());
  p.advance(); p.togglePause(); p.skip();
  assert.equal(p.phase, 'complete');
  assert.equal(p.paused, false);
  p.advance(); p.tick(30); p.seek(0);
  assert.equal(p.phase, 'ready');
  assert.equal(p.turnIndex, 0);
  assert.equal(p.prompt, '');
  p.seek(1); p.tick(100000);
  assert.equal(p.phase, 'ready');
  assert.equal(p.visibleTurns().length, 1);
  p.reset();
  assert.equal(p.turnIndex, 0);
  assert.equal(p.visibleTurns().length, 0);
});

test('speed limits and zero-duration events work without loops', () => {
  assert.throws(() => new Playback(session(), { speed: 0 }), /Speed/);
  const p = new Playback(session(), { speed: 20 });
  p.changeSpeed(1); assert.equal(p.speed, 20);
  p.speed = 0.1; p.changeSpeed(-1); assert.equal(p.speed, 0.1);
  const s = session();
  s.turns[0].events = [{ type: 'assistant', text: 'Instant', delayMs: 0, durationMs: 0 }];
  const instant = new Playback(s);
  instant.advance(); instant.tick(10000);
  assert.equal(instant.phase, 'complete');
});

test('recorded gaps are capped and explicit timings override them', () => {
  const s = session();
  s.turns[1].events[0].at = 0;
  s.turns[1].events[1].at = 600000;
  const p = new Playback(s, { timing: 'recorded' });
  p.seek(1);
  assert.equal(p.eventDelay(1), 5000);
  s.turns[1].events[1].delayMs = 8000;
  assert.equal(p.eventDelay(1), 8000);
});

test('unicode typing never splits a grapheme', () => {
  const s = session(); s.turns[0].prompt = '👩‍💻é界';
  const p = new Playback(s, { typingSpeed: 10 });
  p.advance(); stepUntil(p, () => p.promptLength === 1);
  assert.equal(p.prompt, '👩‍💻');
});

test('typing varies between keystrokes and pauses at word and sentence boundaries', () => {
  const s = session();
  const prompt = 'Make this feel natural. Then send it, with a pause.\nOne more line.';
  s.turns[0].prompt = prompt;
  const p = new Playback(s);
  p.advance();
  const times = [];
  for (let time = 1; p.phase === 'typing' && time < 20000; time++) {
    const before = p.promptLength;
    p.tick(1);
    if (p.promptLength > before) times.push(time);
  }
  assert.equal(times.length, Array.from(prompt).length);
  const delays = times.map((at, i) => at - (times[i - 1] ?? 0));
  const letterDelays = delays.filter((_, i) => i > 0 && /[a-z]/i.test(prompt[i]) && /[a-z]/i.test(prompt[i - 1]));
  const wordDelays = delays.filter((_, i) => prompt[i - 1] === ' ');
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(new Set(letterDelays).size > 8, 'Within-word typing should vary');
  assert.ok(mean(wordDelays) > mean(letterDelays), 'Word boundaries should slow typing');
  assert.ok(delays[prompt.indexOf('.') + 1] > 3 * mean(letterDelays), 'Sentence boundary should pause');
  assert.ok(delays[prompt.indexOf('\n') + 1] > 3 * mean(letterDelays), 'New paragraph should pause');
  assert.ok(delays[0] > mean(letterDelays), 'Allow a moment before the first keystroke');
});

test('completed prompt stays in the composer before sending and pausing holds it there', () => {
  const p = new Playback(session());
  p.advance();
  stepUntil(p, () => p.phase === 'submitting');
  assert.equal(p.prompt, 'Hello world');
  assert.equal(p.visibleTurns().length, 0);
  assert.equal(p.advance(), false);
  p.togglePause(); p.tick(10000);
  assert.equal(p.phase, 'submitting');
  assert.equal(p.prompt, 'Hello world');
  p.togglePause();
  stepUntil(p, () => p.phase === 'playing');
  assert.equal(p.prompt, '');
  assert.equal(p.visibleTurns()[0].prompt, 'Hello world');
});

test('rhythm repeats across restart and is independent of rendering frame size', () => {
  const a = new Playback(session());
  const b = new Playback(session());
  a.advance(); b.advance();
  const lengths = [];
  for (let i = 0; i < 12; i++) {
    a.tick(50);
    for (let frame = 0; frame < 5; frame++) b.tick(10);
    assert.equal(a.promptLength, b.promptLength);
    assert.equal(a.phase, b.phase);
    lengths.push(a.promptLength);
  }
  a.reset(); a.advance();
  for (const length of lengths) { a.tick(50); assert.equal(a.promptLength, length); }
});

test('changing typing pace and playback speed scales pauses along with keystrokes', () => {
  const slow = new Playback(session(), { typingSpeed: 12 });
  const quick = new Playback(session(), { typingSpeed: 24 });
  slow.advance(); quick.advance();
  for (let i = 0; i < 10; i++) {
    slow.tick(100); quick.tick(50);
    assert.equal(slow.prompt, quick.prompt);
    assert.equal(slow.phase, quick.phase);
  }
  const reference = new Playback(session());
  const adjusted = new Playback(session());
  reference.advance(); adjusted.advance();
  reference.tick(100); adjusted.tick(100);
  adjusted.speed = 2;
  reference.tick(400); adjusted.tick(200);
  assert.equal(reference.prompt, adjusted.prompt);
  assert.equal(reference.phase, adjusted.phase);
});
