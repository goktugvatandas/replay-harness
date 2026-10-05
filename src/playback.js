import { graphemes } from './text.js';
import { DEFAULT_TYPING_SPEED, typingTimeline } from './typing.js';
import { cueTurn } from './cues.js';

export const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 20];

export function validSpeed(value) {
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 20) throw new Error('Speed must be a number from 0.1 to 20.');
  return speed;
}

// A deterministic virtual clock. No recorded tool is ever dispatched or evaluated.
// tick() receives wall-clock milliseconds; pausing and speed changes take effect
// immediately without leaving pending timeouts that can advance another turn.
export class Playback {
  constructor(session, { speed = 1, typingSpeed = DEFAULT_TYPING_SPEED, timing = 'natural', cues = [], onCue } = {}) {
    this.session = session;
    // Cues are presenter-supplied callbacks; Playback only decides when they fire.
    this.cues = cues.map((cue) => ({ ...cue, index: cueTurn(cue, session) })).filter((cue) => cue.index >= 0);
    this.onCue = onCue;
    this.fired = new Set();
    this.toolNames = session.turns.map((turn) => {
      const byId = new Map(turn.events.filter((e) => e.type === 'tool' && e.id).map((e) => [e.id, e.name]));
      return turn.events.map((e) => (e.type === 'result' ? e.name ?? byId.get(e.id) : e.name)?.toLowerCase());
    });
    this.speed = validSpeed(speed);
    this.typingSpeed = typingSpeed;
    this.timing = timing;
    this.promptChars = session.turns.map((turn) => graphemes(turn.prompt));
    // An `instant` turn arrives whole, like a prompt passed on the command line.
    this.typingPlans = this.promptChars.map((chars, i) => session.turns[i].instant
      ? { at: chars.map(() => 0), duration: 0, submitDelay: 350 }
      : typingTimeline(chars, typingSpeed));
    this.eventChars = session.turns.map((turn) => turn.events.map((event) => graphemes(event.text)));
    this.reset();
  }

  reset() {
    this.turnIndex = 0;
    this.phase = 'ready';
    this.paused = false;
    this.elapsed = 0;
    this.clock = 0;
    this.eventIndex = 0;
    this.eventStarted = false;
    this.promptLength = 0;
    this.eventLength = 0;
    this.workStart = 0;
    this.fired = new Set();
  }

  get turn() { return this.session.turns[this.turnIndex]; }
  get active() { return ['typing', 'submitting', 'playing'].includes(this.phase); }
  get composing() { return this.phase === 'typing' || this.phase === 'submitting'; }
  get prompt() { return this.composing ? this.promptChars[this.turnIndex].slice(0, this.promptLength).join('') : ''; }
  get caretVisible() {
    if (this.paused) return true;
    const lastKey = this.phase === 'typing' ? this.typingPlans[this.turnIndex].at[this.promptLength - 1] ?? 0 : 0;
    const idle = this.clock - lastKey;
    return idle < 400 || Math.floor((idle - 400) / 450) % 2 === 0;
  }

  get workElapsed() { return this.phase === 'playing' ? this.elapsed - this.workStart : 0; }

  advance() {
    if (this.active || this.phase === 'finished') return false;
    if (this.phase === 'complete') this.turnIndex++;
    this.fired = new Set();
    this.phase = 'typing';
    this.paused = false;
    this.clock = 0;
    this.elapsed = 0;
    this.eventIndex = 0;
    this.eventStarted = false;
    this.promptLength = 0;
    this.eventLength = 0;
    return true;
  }

  togglePause() { if (this.active) this.paused = !this.paused; }

  changeSpeed(direction) {
    this.speed = direction > 0
      ? SPEEDS.find((speed) => speed > this.speed) ?? 20
      : SPEEDS.findLast((speed) => speed < this.speed) ?? 0.1;
  }

  seek(index) {
    if (index < 0 || index >= this.session.turns.length) return;
    this.reset();
    this.turnIndex = index;
  }

  fire(cue) {
    if (this.fired.has(cue)) return;
    this.fired.add(cue);
    this.onCue?.(cue, this.turnIndex);
  }

  eventStart(index) {
    const event = this.turn.events[index];
    if (event.type !== 'result') return;
    const name = this.toolNames[this.turnIndex][index];
    for (const cue of this.cues) if (cue.index === this.turnIndex && cue.tool && cue.tool.toLowerCase() === name) this.fire(cue);
  }

  finishTurn() {
    // Tool cues that never matched (or were skipped past) fire before turn-end cues.
    const due = this.cues.filter((cue) => cue.index === this.turnIndex);
    for (const cue of [...due.filter((c) => c.tool), ...due.filter((c) => !c.tool)]) this.fire(cue);
    this.eventIndex = this.turn.events.length;
    this.eventStarted = false;
    this.eventLength = 0;
    this.paused = false;
    this.phase = this.turnIndex === this.session.turns.length - 1 ? 'finished' : 'complete';
  }

  skip() { if (this.active) this.finishTurn(); }

  eventDelay(index) {
    const event = this.turn.events[index];
    if (event.delayMs !== undefined) return event.delayMs;
    if (this.timing === 'recorded' && index > 0) {
      const before = this.turn.events[index - 1].at;
      if (event.at !== undefined && before !== undefined) return Math.max(0, Math.min(5000, event.at - before));
    }
    return event.type === 'result' ? 500 : event.type === 'tool' ? 300 : 220;
  }

  eventDuration(index) {
    const event = this.turn.events[index];
    if (event.durationMs !== undefined) return event.durationMs;
    if (event.type === 'tool') return 420;
    const length = this.eventChars[this.turnIndex][index].length;
    return Math.max(120, length * (event.type === 'result' ? 2 : 8));
  }

  tick(ms) {
    if (!this.active || this.paused || ms <= 0) return;
    const delta = ms * this.speed;
    this.clock += delta;
    this.elapsed += delta;
    // At most one pass per stage/event, even for zero-duration scripted events.
    while (this.active) {
      if (this.phase === 'typing') {
        const plan = this.typingPlans[this.turnIndex];
        while (this.promptLength < plan.at.length && this.clock >= plan.at[this.promptLength]) this.promptLength++;
        if (this.clock < plan.duration) return;
        this.clock -= plan.duration;
        this.phase = 'submitting';
      } else if (this.phase === 'submitting') {
        const delay = this.typingPlans[this.turnIndex].submitDelay;
        if (this.clock < delay) return;
        this.clock -= delay;
        this.phase = 'playing';
        this.workStart = this.elapsed - this.clock;
      } else if (this.phase === 'playing') {
        if (this.eventIndex >= this.turn.events.length) { this.finishTurn(); return; }
        const delay = this.eventDelay(this.eventIndex);
        const duration = this.eventDuration(this.eventIndex);
        const started = this.clock >= delay;
        if (started && !this.eventStarted) this.eventStart(this.eventIndex);
        this.eventStarted = started;
        const fraction = duration === 0 ? 1 : Math.max(0, Math.min(1, (this.clock - delay) / duration));
        this.eventLength = Math.floor(this.eventChars[this.turnIndex][this.eventIndex].length * fraction);
        if (this.clock < delay + duration) return;
        this.clock -= delay + duration;
        this.eventIndex++;
        this.eventStarted = false;
        this.eventLength = 0;
      }
    }
  }

  visibleTurns() {
    const turns = this.session.turns.slice(0, this.turnIndex).map((turn) => ({ ...turn, complete: true }));
    if (this.phase === 'ready' || this.composing) return turns;
    const events = this.turn.events.slice(0, this.eventIndex).map((event) => ({ ...event, complete: true }));
    if (this.phase === 'playing' && this.eventStarted) {
      const event = this.turn.events[this.eventIndex];
      events.push({ ...event, complete: false, text: event.type === 'tool' ? event.text : this.eventChars[this.turnIndex][this.eventIndex].slice(0, this.eventLength).join('') });
    }
    turns.push({ prompt: this.turn.prompt, events, complete: !this.active });
    return turns;
  }
}
