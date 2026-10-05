export const themes = {
  codex: {
    name: 'Codex', vendor: 'OpenAI', accent: '#a3e7d3', prompt: '›', bullet: '•',
    thinking: 'Working', tool: 'Ran', model: 'Recorded model', toolStyle: 'codex',
    logo: ['  >_  '], tagline: 'Your terminal. Your agent.',
  },
  claude: {
    name: 'Claude Code', vendor: 'Anthropic', accent: '#d97757', prompt: '>', bullet: '●',
    thinking: 'Working', tool: '●', model: 'Recorded model', toolStyle: 'inline', promptBand: true, promptBox: true,
    spinner: ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'], spinnerMs: 120,
    verbs: ['Cogitating', 'Pondering', 'Crafting', 'Brewing', 'Noodling', 'Percolating', 'Tinkering'],
    logo: [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝'], tagline: 'Let’s build something.',
  },
  opencode: {
    name: 'opencode', vendor: 'OpenCode', accent: '#bfadeb', prompt: '┃', bullet: '▪',
    thinking: 'Thinking', tool: '⬝', model: 'Recorded model',
    logo: [' ┌─┐┌─┐', ' │ ││  ', ' └─┘└─┘'], tagline: 'Build with any model.',
  },
  pi: {
    name: 'pi', vendor: 'Pi coding agent', accent: '#9baef9', prompt: '>', bullet: '•',
    thinking: 'Working', tool: '✓', model: 'Recorded model',
    logo: ['  π  '], tagline: 'The minimal coding agent.',
  },
  gemini: {
    name: 'Gemini CLI', vendor: 'Google', accent: '#92b6fa', prompt: '>', bullet: '✦',
    thinking: 'Thinking', tool: '✓', model: 'Recorded model',
    logo: ['   ✦   ', ' ✧   ✧ '], tagline: 'From idea to execution.',
  },
  generic: {
    name: 'Agent', vendor: 'Session replay', accent: '#a3c8df', prompt: '>', bullet: '◆',
    thinking: 'Working', tool: '→', model: 'Recorded model',
    logo: ['  [·]  '], tagline: 'A session, brought to life.',
  },
};

export const palette = {
  background: '#15171b', panel: '#1e2127', line: '#343941', text: '#e6e7eb',
  muted: '#8e959f', faint: '#616975', green: '#a3e7b5', red: '#ee8b8b', gold: '#e4c78e',
  band: '#2b2f36', added: '#1f3a2a', removed: '#452528', success: '#4eba65', failure: '#ff6b80',
};

// 'theme' paints the replay's own dark ground; 'terminal' keeps the terminal's
// default background so translucent or live-themed terminals show through.
let backgroundMode = 'theme';
export const BACKGROUNDS = ['theme', 'terminal'];
export function setBackground(mode) { backgroundMode = BACKGROUNDS.includes(mode) ? mode : 'theme'; }
export function baseBackground() { return backgroundMode === 'terminal' ? '\x1b[49m' : ansiColor(palette.background, true); }

export function ansiColor(hex, background = false) {
  const rgb = hex.replace('#', '').match(/.{2}/g).map((part) => parseInt(part, 16));
  return `\x1b[${background ? 48 : 38};2;${rgb.join(';')}m`;
}

export function paint(text, color = palette.text, { bold = false, dim = false, background } = {}) {
  return `${ansiColor(color)}${background ? ansiColor(background, true) : ''}${bold ? '\x1b[1m' : ''}${dim ? '\x1b[2m' : ''}${text}\x1b[0m${baseBackground()}`;
}
