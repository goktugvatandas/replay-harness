export const DEFAULT_TYPING_SPEED = 24;

// Seed the rhythm from the prompt: a rehearsal and its replay have the same
// pauses, regardless of frame rate, playback speed, or how often we restart.
function randomFor(chars) {
  let seed = 2166136261;
  for (const char of chars) {
    for (const point of char) seed = Math.imul(seed ^ point.codePointAt(0), 16777619) >>> 0;
  }
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let n = Math.imul(seed ^ (seed >>> 15), seed | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

const whitespace = (char) => /\s/u.test(char ?? '');
const sentenceEnd = (char) => /[.!?。！？]/u.test(char ?? '');
const clauseEnd = (char) => /[,;:，；：、]/u.test(char ?? '');

export function typingTimeline(chars, charactersPerSecond = DEFAULT_TYPING_SPEED) {
  if (!Number.isFinite(charactersPerSecond) || charactersPerSecond < 1 || charactersPerSecond > 1000) {
    throw new Error('Typing speed must be between 1 and 1000 characters per second.');
  }
  const random = randomFor(chars);
  const beat = 1000 / charactersPerSecond;
  const at = [];
  let time = 0, burstLeft = 0, burstPace = 1;
  for (let i = 0; i < chars.length; i++) {
    if (burstLeft-- <= 0) {
      burstLeft = 3 + Math.floor(random() * 6);
      burstPace = 0.65 + random() * 0.65;
    }
    let delay = beat * burstPace * (0.7 + random() * 0.6);
    const previous = chars[i - 1];
    if (i === 0) delay += beat * (3 + random() * 3);
    else if (previous?.includes('\n')) delay += beat * (6 + random() * 5);
    else if (sentenceEnd(previous) && (whitespace(chars[i]) || /[。！？]/u.test(previous))) {
      delay += beat * (5 + random() * 5);
    } else if (clauseEnd(previous)) delay += beat * (2 + random() * 3);
    else if (whitespace(previous) && !whitespace(chars[i])) {
      delay += beat * (0.4 + random() * 1.3);
      // Occasionally hesitate at a new word, then settle into another burst.
      if (random() < 0.16) delay += beat * (2 + random() * 3);
      burstLeft = 0;
    }
    time += delay;
    at.push(time);
  }
  return { at, duration: time, submitDelay: beat * (5 + random() * 5) };
}
