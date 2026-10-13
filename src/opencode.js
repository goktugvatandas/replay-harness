// OpenCode's own look (modelled on OpenCode 1.19): the home screen with the pixel logo and the
// prompt box, then the session view: messages behind a left bar, tool calls in shaded panels,
// written files with line numbers and syntax colours, and "▣ Build · model · time" per turn.
import { palette as c, paint } from './themes.js';
import { clean, wrap, wrapWords, truncate, width } from './text.js';

const PANEL = '#262a33';
const COLORS = {
  text: '#e6e7eb', muted: '#8e959f', faint: '#616975', thought: '#f5a742', code: '#d7c06b',
  tag: '#e06c75', string: '#98c379', keyword: '#c678dd', number: '#d19a66', attr: '#e5c07b', comment: '#7f848e',
};

// A colored run of text, optionally on the panel background, optionally italic.
function seg(value, color = COLORS.text, { bold = false, italic = false, panel = false } = {}) {
  const s = paint(value, color, { bold, background: panel ? PANEL : undefined });
  return italic ? s.replace(/(\x1b\[38;2;[\d;]+m)/, '$1\x1b[3m') : s;
}
const fill = (line, columns, panel) => line + (panel ? paint(' '.repeat(Math.max(0, columns - width(line))), COLORS.text, { background: PANEL }) : '');

// A shaded panel: a blank row, the content (each row a string of segments), a blank row.
// With a bar, the left edge is OpenCode's accent bar (user messages, the prompt box).
function panel(rows, columns, { bar } = {}) {
  const edge = bar ? paint('┃', bar) : paint(' ', COLORS.text, { background: PANEL });
  const body = (line) => edge + fill(paint('  ', COLORS.text, { background: PANEL }) + line, columns - 1, true);
  return [body(''), ...rows.map(body), body('')];
}

const center = (line, columns) => ' '.repeat(Math.max(0, Math.floor((columns - width(line)) / 2))) + line;
const right = (left, rightText, columns) => left + ' '.repeat(Math.max(1, columns - width(left) - width(rightText))) + rightText;

// The pixel wordmark: "open" in grey, "code" in white.
const GLYPHS = {
  o: ['    ', '█▀▀█', '█  █', '▀▀▀▀', '    '], p: ['    ', '█▀▀█', '█  █', '█▀▀▀', '▀   '],
  e: ['    ', '█▀▀█', '█▀▀▀', '▀▀▀▀', '    '], n: ['    ', '█▀▀▄', '█  █', '▀  ▀', '    '],
  c: ['    ', '█▀▀▀', '█   ', '▀▀▀▀', '    '], d: ['   ▄', '█▀▀█', '█  █', '▀▀▀▀', '    '],
};
function logo() {
  return [0, 1, 2, 3, 4].map((r) => [...'opencode'].map((ch, i) => seg(GLYPHS[ch][r], i < 4 ? COLORS.muted : COLORS.text, { bold: true })).join(seg(' ')));
}

// Light syntax colours for HTML, JavaScript and TOML (enough for code being written on stage).
const TOKENS = /(<!--.*|\/\/.*|^\s*#.*)|(<\/?[\w-]+|\/?>)|("[^"]*"?|'[^']*'?|`[^`]*`?)|\b(const|let|var|for|if|else|new|return|of|function|true|false)\b|\b(\d+(?:\.\d+)?)\b|([\w-]+)(?==)/g;
function highlight(line) {
  let out = '', last = 0;
  for (const m of line.matchAll(TOKENS)) {
    out += seg(line.slice(last, m.index), COLORS.text, { panel: true });
    const [whole, comment, tag, string, keyword, number, attr] = m;
    const color = comment ? COLORS.comment : tag ? COLORS.tag : string ? COLORS.string : keyword ? COLORS.keyword : number ? COLORS.number : attr ? COLORS.attr : COLORS.text;
    out += seg(whole, color, { panel: true, italic: Boolean(comment) });
    last = m.index + whole.length;
  }
  return out + seg(line.slice(last), COLORS.text, { panel: true });
}

function markdown(value, columns) {
  return wrapWords(value, columns).map((line) => line.split(/(`[^`]*`|\*\*.*?\*\*)/g).map((part) =>
    part.startsWith('`') ? seg(part.slice(1, -1), COLORS.code) : part.startsWith('**') ? seg(part.slice(2, -2), COLORS.text, { bold: true }) : seg(part, COLORS.text)).join(''));
}

const duration = (ms) => ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
const base = (path) => clean(path).split('/').filter(Boolean).at(-1) ?? path;
const INLINE = { read: '→ Read', list: '→ List', glob: '✱ Glob', grep: '✱ Grep', webfetch: '% WebFetch', skill: '→ Skill', todowrite: '⚙ Todo', task: '◉ Task' };

function toolBlock(event, result, columns, expanded) {
  const name = (event.name || 'tool').toLowerCase();
  const [first = '', ...rest] = event.text.split('\n');
  if (name === 'write' || name === 'edit') {
    const lines = rest;
    const numbers = String(Math.max(1, lines.length)).length + 1;
    const rows = [seg(`# ${result || event.complete ? (name === 'write' ? 'Wrote' : 'Edited') : (name === 'write' ? 'Writing' : 'Editing')} ${base(first)}`, COLORS.muted, { panel: true }), ''];
    lines.forEach((line, i) => {
      const parts = wrap(line, columns - numbers - 6);
      parts.forEach((part, j) => rows.push(seg((j ? '' : String(i + 1)).padStart(numbers), COLORS.faint, { panel: true }) + seg(' ', COLORS.text, { panel: true }) +
        (name === 'edit' && /^[+-]/.test(line) ? seg(part, line[0] === '+' ? COLORS.string : COLORS.tag, { panel: true }) : highlight(part))));
    });
    return panel(rows, columns);
  }
  if (name === 'bash' || name === 'shell') {
    const rows = wrap(event.text, columns - 5).map((line, i) => seg(i ? '  ' + line : '$ ' + line, COLORS.text, { panel: true }));
    if (result?.text.trim()) {
      const output = wrap(result.text.replace(/\n+$/, ''), columns - 5);
      const shown = expanded ? output : output.slice(0, 12);
      rows.push('', ...shown.map((line) => seg(line, result.error ? COLORS.tag : COLORS.muted, { panel: true })));
      if (shown.length < output.length) rows.push(seg(`… ${output.length - shown.length} more lines`, COLORS.faint, { panel: true }));
    }
    return panel(rows, columns);
  }
  const label = INLINE[name] ?? `⚙ ${event.name}`;
  const summary = name === 'skill' ? `"${first}"` : first;
  return [seg('  ' + truncate(`${label} ${summary}`, columns - 2), COLORS.muted)];
}

function transcript(p, theme, columns, expanded) {
  const lines = [];
  for (const turn of p.visibleTurns()) {
    lines.push(...panel(wrapWords(turn.prompt, columns - 5).map((line) => seg(line, COLORS.text, { panel: true })), columns, { bar: theme.accent }), '');
    const results = new Map(turn.events.filter((e) => e.type === 'result' && e.id).map((e) => [e.id, e]));
    let spent = 0;
    for (const event of turn.events) {
      spent += (event.delayMs ?? 300) + (event.durationMs ?? 400);
      if (event.type === 'thinking') {
        lines.push(seg('  + Thought: ' + duration(Math.max(300, (event.durationMs ?? event.text.length * 12))), COLORS.thought), '');
        if (expanded) lines.push(...wrapWords(event.text, columns - 4).map((line) => '  ' + seg(line, COLORS.muted)), '');
      } else if (event.type === 'assistant') {
        lines.push(...markdown(event.text, columns - 4).map((line) => '  ' + line), '');
      } else if (event.type === 'tool') {
        lines.push(...toolBlock(event, event.id ? results.get(event.id) : undefined, columns, expanded), '');
      }
    }
    if (turn.complete) lines.push('  ' + seg('▣ ', theme.accent) + seg(theme.agent) + seg(` · ${p.session.model || theme.model} · ${duration(spent)}`, COLORS.muted), '');
  }
  return lines;
}

function promptBox(p, theme, columns, home, now) {
  const typed = p.prompt;
  const caret = p.caretVisible ? paint('█', COLORS.text, { background: PANEL }) : seg(' ', COLORS.text, { panel: true });
  let rows;
  if (p.composing) rows = wrapWords(typed, columns - 6).map((line, i, all) => seg(line, COLORS.text, { panel: true }) + (i === all.length - 1 ? caret : ''));
  else if (home && !p.active) rows = [seg('Ask anything… "Fix broken tests"', COLORS.muted, { panel: true })];
  else rows = [p.active ? '' : caret];
  if (!rows.length) rows = [caret];
  rows.push('', seg(theme.agent, theme.accent, { panel: true }) + seg(' · ' + (p.session.model || theme.model), COLORS.text, { panel: true }));
  return panel(rows, columns, { bar: theme.accent });
}

// OpenCode's working indicator: a block sweeping along a short track.
function working(now) {
  const n = 8, at = Math.floor(now / 110) % (n * 2 - 2), pos = at < n ? at : n * 2 - 2 - at;
  return Array.from({ length: n }, (_, i) => seg(Math.abs(i - pos) <= 1 ? '■' : '⬝', Math.abs(i - pos) <= 1 ? COLORS.text : COLORS.faint)).join('') + seg('  esc ', COLORS.text) + seg('interrupt', COLORS.muted);
}

export function renderOpenCode(state, columns, rows, now, theme) {
  const p = state.playback;
  const inner = columns - 4;
  const cwd = p.session.cwd || '~';
  const home = p.turnIndex === 0 && (p.phase === 'ready' || p.composing);
  if (home) {
    // The home screen: logo and the prompt box, centred, the tip below, cwd and version at the foot.
    const boxWidth = Math.min(inner, 76);
    const indent = ' '.repeat(Math.max(0, Math.floor((inner - boxWidth) / 2)));
    const body = [...logo().map((line) => center(line, inner)), '', '',
      ...promptBox(p, theme, boxWidth, true, now).map((line) => indent + line),
      indent + right('', seg('tab ', COLORS.text) + seg('agents  ', COLORS.muted) + seg('ctrl+p ', COLORS.text) + seg('commands', COLORS.muted), boxWidth), '', '',
      center(seg('● ', COLORS.thought) + seg('Tip ', COLORS.thought) + seg('Type @ to add files to your prompt', COLORS.muted), inner)];
    const top = Math.max(1, Math.floor((rows - body.length - 3) / 2));
    const lines = [...Array(top).fill(''), ...body];
    while (lines.length < rows - 2) lines.push('');
    lines.push(right(seg(cwd, COLORS.muted), seg(theme.version, COLORS.muted), inner), '');
    return lines.slice(0, rows).map((line) => '  ' + line);
  }
  const bottom = [...promptBox(p, theme, inner, false, now),
    right(p.phase === 'playing' && !p.paused ? working(now) : seg(cwd, COLORS.muted), seg('ctrl+p ', COLORS.text) + seg('commands', COLORS.muted), inner)];
  const viewport = Math.max(1, rows - bottom.length - 2);
  const all = transcript(p, theme, inner, state.expanded);
  const maxScroll = Math.max(0, all.length - viewport);
  state.scroll = Math.min(state.scroll, maxScroll);
  const start = Math.max(0, all.length - viewport - state.scroll);
  const body = all.slice(start, start + viewport);
  while (body.length < viewport) body.push('');
  return ['', ...body, ...bottom, ''].slice(0, rows).map((line) => '  ' + line);
}
