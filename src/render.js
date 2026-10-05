import { themes, palette as c, paint } from './themes.js';
import { clean, wrap, wrapWords, truncate, width } from './text.js';
import { filterSessions } from './discovery.js';

const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const text = (s, color = c.text, bold = false) => paint(s, color, { bold });
const rule = (columns) => text('─'.repeat(Math.max(0, columns)), c.line);
const pad = (line, columns) => line + ' '.repeat(Math.max(0, columns - width(line)));

function row(left, right, columns) {
  const gap = columns - width(left) - width(right);
  return gap >= 2 ? left + ' '.repeat(gap) + right : left;
}

function labelValue(label, value, columns, accent = c.text) {
  const labelWidth = Math.max(13, width(label));
  return text(label.padEnd(labelWidth), c.muted) + text(truncate(clean(value || '—'), Math.max(2, columns - labelWidth)), accent);
}

function markdown(value, columns, color = c.text) {
  let code = false;
  const lines = [];
  for (const raw of value.split('\n')) {
    if (raw.startsWith('```')) {
      code = !code;
      lines.push(text(code ? `┌ ${raw.slice(3) || 'code'}` : '└' + '─'.repeat(Math.min(36, columns - 1)), c.faint));
      continue;
    }
    const heading = /^#{1,6}\s/.test(raw);
    const normalized = heading ? raw.replace(/^#{1,6}\s+/, '') : raw;
    for (const line of (code ? wrap : wrapWords)(normalized, columns - (code ? 2 : 0))) {
      if (code) lines.push(text('│ ', c.faint) + text(line, line.startsWith('+') ? c.green : line.startsWith('-') ? c.red : c.text));
      else if (heading) lines.push(text(line, c.text, true));
      else {
        const parts = line.split(/(`[^`]*`|\*\*.*?\*\*)/g);
        lines.push(parts.map((part) => part.startsWith('`') ? text(part.slice(1, -1), c.gold) : part.startsWith('**') ? text(part.slice(2, -2), c.text, true) : text(part, color)).join(''));
      }
    }
  }
  return lines;
}

function welcome(session, theme, columns) {
  if (theme === themes.pi) return [
    text('π ', theme.accent, true) + text('pi', c.text, true) + text(' · ' + truncate(session.model || theme.model, columns - 8), c.muted),
    text(truncate(session.cwd || '~/demo', columns), c.faint), '',
  ];
  if (theme === themes.codex) {
    const size = Math.min(columns, 64);
    return [
      text('╭' + '─'.repeat(size - 2) + '╮', c.line),
      text('│ ', c.line) + pad(text('>_ ', theme.accent, true) + text('OpenAI Codex', c.text, true), size - 4) + text(' │', c.line),
      text('│ ', c.line) + pad(labelValue('model:', session.model || theme.model, size - 4), size - 4) + text(' │', c.line),
      text('│ ', c.line) + pad(labelValue('directory:', session.cwd || '~/demo', size - 4), size - 4) + text(' │', c.line),
      text('╰' + '─'.repeat(size - 2) + '╯', c.line), '',
    ];
  }
  const logoWidth = 13;
  const lines = theme.logo.map((line, i) => pad(text(line, theme.accent), logoWidth) + (
    i === 0 ? text(theme.name, theme.accent, true) : i === 1 ? text(truncate(session.model || theme.model, columns - logoWidth), c.muted) : text(truncate(session.cwd || '~/demo', columns - logoWidth), c.faint)
  ));
  if (theme.logo.length < 3) lines.push(' '.repeat(logoWidth) + text(truncate(session.cwd || '~/demo', columns - logoWidth), c.faint));
  return [...lines, '', text(theme.tagline, c.muted), ''];
}

const SHELL_TOOLS = new Set(['bash', 'shell', 'exec_command', 'local_shell', 'run_shell_command', 'terminal']);
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'update', 'str_replace_based_edit_tool', 'str_replace', 'replace', 'notebookedit']);
const WRITE_TOOLS = new Set(['write', 'write_file', 'create']);
const CLAUDE_NAMES = { edit: 'Update', multiedit: 'Update', grep: 'Search', glob: 'Search', webfetch: 'Fetch' };
const SUMMARY_KEYS = ['file_path', 'path', 'notebook_path', 'pattern', 'command', 'cmd', 'url', 'query', 'description', 'prompt'];

// Splits a recorded tool call into a one-line summary and its remaining body.
export function toolParts(event) {
  const raw = event.text ?? '';
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const input = JSON.parse(trimmed);
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const summary = SUMMARY_KEYS.map((key) => input[key]).find((v) => typeof v === 'string') ?? Object.values(input).find((v) => typeof v === 'string') ?? '';
        const content = typeof input.content === 'string' ? input.content : '';
        return { summary: summary.split('\n')[0], body: content ? content.split('\n') : [], path: input.file_path ?? input.path ?? '' };
      }
    } catch { /* not JSON: fall through to plain text */ }
  }
  const lines = raw.split('\n');
  if (lines.length <= 4 && lines.every((line) => /^[\w.-]+: \S/.test(line))) return { summary: lines.join(', '), body: [], path: '' };
  return { summary: lines[0], body: lines.slice(1), path: lines[0] };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const relative = (path, cwd) => cwd && path.startsWith(cwd.replace(/\/$/, '') + '/') ? path.slice(cwd.replace(/\/$/, '').length + 1) : path;

function inlineResult(event, tool, theme, columns, expanded, cwd) {
  const lines = [];
  const first = text('  ⎿  ', c.faint), rest = '     ';
  const inner = columns - 5;
  const name = (tool?.name ?? event.name ?? '').toLowerCase();
  const parts = tool ? toolParts(tool) : undefined;
  if (parts) { parts.path = relative(parts.path, cwd); parts.summary = relative(parts.summary, cwd); }
  while (parts?.body.length && !parts.body.at(-1).trim()) parts.body.pop();
  const diff = parts?.body.filter((line) => /^[+-]/.test(line)) ?? [];
  if (!event.error && EDIT_TOOLS.has(name) && diff.length) {
    const added = diff.filter((line) => line.startsWith('+')).length, removed = diff.length - added;
    const summary = [added && plural(added, 'addition'), removed && plural(removed, 'removal')].filter(Boolean).join(' and ');
    lines.push(first + text(truncate(`Updated ${parts.path || parts.summary} with ${summary}`, inner), c.muted));
    const shown = expanded ? diff : diff.slice(0, 10);
    for (const line of shown) {
      const sign = line[0], body = line.slice(1).replace(/^ /, '');
      const tint = sign === '+' ? c.added : c.removed;
      const cell = truncate(`${sign} ${body}`, inner - 1);
      lines.push(rest + paint(pad(' ' + cell, inner), sign === '+' ? c.green : c.red, { background: tint }));
    }
    if (shown.length < diff.length) lines.push(rest + text(`… +${diff.length - shown.length} lines (x to expand)`, c.faint));
    return lines;
  }
  if (!event.error && WRITE_TOOLS.has(name) && parts?.body.length) {
    lines.push(first + text(truncate(`Wrote ${plural(parts.body.length, 'line')} to `, inner), c.muted) + text(truncate(parts.path || parts.summary, Math.max(4, inner - 22)), c.text, true));
    const shown = parts.body.slice(0, expanded ? parts.body.length : 4);
    lines.push(...shown.map((line) => rest + text(truncate(line, inner), c.muted)));
    if (shown.length < parts.body.length) lines.push(rest + text(`… +${parts.body.length - shown.length} lines (x to expand)`, c.faint));
    return lines;
  }
  const output = event.text.trim() ? wrap(event.text.replace(/\n+$/, ''), inner) : ['(No content)'];
  const shown = expanded ? output : output.slice(0, 5);
  lines.push(...shown.map((line, i) => (i === 0 ? first : rest) + text(line, event.error ? c.red : c.muted)));
  if (shown.length < output.length) lines.push(rest + text(`… +${output.length - shown.length} lines (x to expand)`, c.faint));
  return lines;
}

function promptLines(prompt, theme, columns) {
  if (!theme.promptBand) {
    return wrapWords(prompt, columns - 4).map((line, i) => text(i === 0 ? `${theme.prompt} ` : '  ', theme.accent, true) + text(line, c.text, true));
  }
  return wrapWords(prompt, columns - 4).map((line, i) => paint(pad(`${i === 0 ? theme.prompt : ' '} ${line}`, columns), c.text, { background: c.band }));
}

export function transcriptLines(playback, theme, columns, expanded, now = Date.now()) {
  const lines = [];
  for (const turn of playback.visibleTurns()) {
    lines.push(...promptLines(turn.prompt, theme, columns), '');
    // Match only results already visible: never preview an unseen tool outcome.
    const results = new Map(turn.events.filter((e) => e.type === 'result' && e.id).map((e) => [e.id, e]));
    const tools = new Map(turn.events.filter((e) => e.type === 'tool' && e.id).map((e) => [e.id, e]));
    for (const event of turn.events) {
      if (event.type === 'assistant') {
        const bullet = theme.toolStyle === 'inline' ? c.text : theme.accent;
        lines.push(...markdown(event.text, columns - 4).map((line, i) => (i === 0 ? text(`${theme.bullet} `, bullet) : '  ') + line), '');
      } else if (event.type === 'thinking') {
        const thought = expanded ? event.text : event.text.split('\n')[0];
        const rendered = markdown(thought, columns - 4, c.muted);
        lines.push(...rendered.map((line, i) => (i === 0 ? text('∴ ', c.faint) : '  ') + line), '');
      } else if (event.type === 'tool' && theme.toolStyle === 'inline') {
        const result = event.id ? results.get(event.id) : undefined;
        const color = result ? (result.error ? c.failure : c.success) : Math.floor(now / 500) % 2 ? c.faint : c.muted;
        const key = (event.name || 'Tool').toLowerCase();
        const name = CLAUDE_NAMES[key] ?? event.name ?? 'Tool';
        const summary = relative(toolParts(event).summary, playback.session.cwd);
        const args = summary ? text('(' + truncate(summary, Math.max(4, columns - width(name) - 5)) + ')', c.text) : '';
        lines.push(text('● ', color) + text(name, c.text, true) + args);
        if (!result) lines.push('');
      } else if (event.type === 'tool') {
        const result = event.id ? results.get(event.id) : undefined;
        const marker = result?.error ? '×' : result ? theme.tool : '•';
        const shell = theme.toolStyle === 'codex' && SHELL_TOOLS.has((event.name || '').toLowerCase());
        const command = wrap(event.text, columns - 5);
        const title = shell ? command[0] ?? '' : `${event.name || 'Tool'}`;
        const body = shell ? command.slice(1) : command;
        if (theme.toolStyle === 'codex') {
          const verb = shell ? (result?.error ? 'Failed ' : 'Ran ') : '';
          lines.push(text('• ', result?.error ? c.red : result ? theme.accent : c.muted) + text(verb, c.text, true) + text(truncate(title, columns - 8), c.text, !shell));
        }
        else lines.push(text(`${marker} `, result?.error ? c.red : theme.accent) + text(truncate(title, columns - width(marker) - 1), c.text, true));
        const shown = expanded ? body : body.slice(0, 4);
        lines.push(...shown.map((line) => text('  │ ', c.faint) + text(line, line.startsWith('+') ? c.green : line.startsWith('-') ? c.red : c.muted)));
        if (shown.length < body.length) lines.push(text(`  │ … ${body.length - shown.length} more lines`, c.faint));
        if (!(theme.toolStyle === 'codex' && result)) lines.push('');
      } else if (event.type === 'result' && theme.toolStyle === 'inline') {
        lines.push(...inlineResult(event, event.id ? tools.get(event.id) : undefined, theme, columns, expanded, playback.session.cwd), '');
      } else if (event.type === 'result') {
        const output = wrap(event.text, columns - 5);
        const shown = expanded ? output : output.slice(0, 6);
        lines.push(...shown.map((line, i) => text(i === 0 ? '  └ ' : '    ', c.faint) + text(line, event.error ? c.red : c.muted)));
        if (shown.length < output.length) lines.push(text(`    … ${output.length - shown.length} more lines · x to expand`, c.faint));
        lines.push('');
      }
    }
  }
  return lines;
}

function help(columns) {
  const keys = [
    ['Enter / Space', 'Type and send the next recorded prompt'],
    ['p', 'Pause / resume the current turn'],
    ['+ / −', 'Speed up / slow down (0.1×–20×)'],
    ['n', 'Finish the current turn immediately'],
    ['[ / ]', 'Rewind / cue the next turn'],
    ['r', 'Restart the recording'],
    ['↑ / ↓ · PgUp / PgDn', 'Scroll the transcript'],
    ['End', 'Follow the latest output'],
    ['x', 'Expand / collapse tool output and thoughts'],
    ['t', 'Cycle harness visual identity'],
    ['f', 'Toggle presentation mode (hide replay controls)'],
    ['Esc', 'Return to session discovery'],
    ['? / h', 'Close this help'],
    ['q / Ctrl+C', 'Quit'],
  ];
  return ['', text('Playback controls · ↑↓ scroll · ? close', c.text, true), '', ...keys.flatMap(([key, value]) => columns >= 72 ? [labelValue(key.padEnd(23), value, columns)] : [text(key, c.text, true), ...wrap(value, columns - 2).map((line) => '  ' + text(line, c.muted)), '']), '', ...wrap('Recorded content only. Playback runs entirely offline.', columns).map((line) => text(line, c.muted))];
}

export function renderPlayer(state, columns, rows, now = Date.now()) {
  const p = state.playback;
  const theme = themes[state.theme ?? p.session.harness];
  const inner = columns - 4;
  const mode = p.paused ? 'PAUSED' : p.active ? 'PLAYING' : p.phase === 'finished' ? 'COMPLETE' : 'READY';
  const current = p.phase === 'complete' ? p.turnIndex + 2 : p.turnIndex + 1;
  const top = state.present ? [] : [row(text('◉ REPLAY HARNESS', theme.accent, true), text(`${mode}  ·  ${p.speed}×  ·  ${current}/${p.session.turns.length}`, c.muted), inner), rule(inner)];
  const bottom = [];
  let status = '', statusColor = p.paused ? c.gold : theme.accent;
  if (p.paused) status = 'Ⅱ Paused';
  else if (p.phase === 'playing' && theme.spinner) {
    const glyph = theme.spinner[Math.floor(now / theme.spinnerMs) % theme.spinner.length];
    const verb = theme.verbs[p.turnIndex % theme.verbs.length];
    status = `${glyph} ${verb}… (${Math.floor(p.workElapsed / 1000)}s · esc to interrupt)`;
  }
  else if (p.phase === 'playing') status = `${spinner[Math.floor(now / 90) % spinner.length]} ${theme.thinking}…`;
  else if (state.cueStatus && (state.cueStatus.error || !state.present)) { status = state.cueStatus.text; statusColor = state.cueStatus.error ? c.red : c.muted; }
  else if (p.phase === 'finished') status = state.present ? '' : '✓ Session complete · r to replay';
  else if (p.phase === 'complete') status = state.present ? '' : inner < 52 ? '✓ Turn complete · Enter / Space to continue' : '✓ Turn complete · Enter or Space for next prompt';
  else if (p.phase === 'ready') status = state.present ? '' : 'Press Enter or Space to begin';
  if (state.scroll > 0) { status = `↑ Reviewing history · ${state.scroll} lines up · End to follow`; statusColor = theme.accent; }
  bottom.push(text(truncate(status || ' ', inner), statusColor));
  const prompt = p.prompt;
  const caret = text(p.caretVisible ? '▌' : ' ', theme.accent);
  const idle = p.active ? '' : state.present ? ' ' : p.phase === 'finished' ? 'End of recording' : 'Your next prompt is queued';
  if (theme.promptBox) {
    const content = inner - 4;
    const promptLines = wrapWords(prompt, content - 3);
    const visible = promptLines.slice(-Math.min(3, Math.max(1, rows - 12)));
    const edge = (line) => text('│ ', c.line) + pad(line, content) + text(' │', c.line);
    bottom.push(text('╭' + '─'.repeat(inner - 2) + '╮', c.line));
    if (p.composing) bottom.push(...visible.map((line, i) => edge(text(i === 0 ? `${theme.prompt} ` : '  ', c.text) + text(line) + (i === visible.length - 1 ? caret : ''))));
    else bottom.push(edge(text(`${theme.prompt} `, c.text) + (p.active ? '' : text('▌', c.faint) + text(idle.trim() ? ' ' + idle : '', c.faint))));
    bottom.push(text('╰' + '─'.repeat(inner - 2) + '╯', c.line));
  } else {
    const editorRule = theme === themes.pi || theme === themes.opencode ? text('─'.repeat(inner), theme.accent) : rule(inner);
    bottom.push(editorRule);
    const promptLines = wrapWords(prompt, inner - 4);
    const visible = promptLines.slice(-Math.min(3, Math.max(1, rows - 12)));
    if (p.composing) bottom.push(...visible.map((line, i) => text(i === 0 ? `${theme.prompt} ` : '  ', theme.accent) + text(line) + (i === visible.length - 1 ? caret : '')));
    else bottom.push(text(`${theme.prompt} `, theme.accent) + text(idle, c.faint) + (p.active ? '' : text(' ▏', theme.accent)));
    bottom.push(editorRule);
  }
  const presentLeft = theme.promptBox ? text('? for shortcuts', c.muted) : text(truncate(p.session.cwd || '~/demo', Math.floor(inner / 2)), c.faint);
  bottom.push(state.present
    ? row(presentLeft, text(truncate(p.session.model || theme.name, Math.floor(inner / 2) - 2), c.muted), inner)
    : row(text('enter next  p pause  +/− speed  ? help', c.muted), text('f present  esc discovery', c.faint), inner));
  const viewport = Math.max(1, rows - top.length - bottom.length - 2);
  const all = state.help ? help(inner) : [...welcome(p.session, theme, inner), ...transcriptLines(p, theme, inner, state.expanded, now)];
  const maxScroll = Math.max(0, all.length - viewport);
  state.scroll = Math.min(state.scroll, maxScroll);
  if (state.help) state.helpScroll = Math.min(state.helpScroll ?? 0, maxScroll);
  const start = state.help ? state.helpScroll : Math.max(0, all.length - viewport - state.scroll);
  const body = all.slice(start, start + viewport);
  while (body.length < viewport) body.push('');
  return ['', ...top, ...body, ...bottom, ''].slice(0, rows).map((line) => '  ' + line);
}

function relativeTime(value, now) {
  if (!value) return '';
  const minutes = Math.max(0, Math.floor((now - value) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function renderDiscovery(state, columns, rows, now = Date.now()) {
  const inner = columns - 6;
  const sessions = filterSessions(state.sessions, state.filter, state.query);
  const selected = sessions[state.selected];
  const counts = Object.keys(themes).map((harness) => ({ harness, count: state.sessions.filter((s) => s.harness === harness).length }));
  const filters = ['all', ...counts.filter((s) => s.count || s.harness === state.filter).map((s) => s.harness)];
  const filterText = filters.map((h) => `${h === state.filter ? '[' : ''}${h === 'all' ? 'All' : themes[h].name} ${h === 'all' ? state.sessions.length : counts.find((s) => s.harness === h).count}${h === state.filter ? ']' : ''}`).join('  ');
  const status = state.discovering ? `${spinner[Math.floor(now / 90) % spinner.length]} Discovering saved sessions… ${state.discoveryCount} found` : `${state.sessions.length} saved sessions · most recent first`;
  const lines = ['', row(text('◉  REPLAY HARNESS', c.green, true), text('LOCAL · OFFLINE', c.faint), inner), rule(inner), '',
    text('Session discovery', c.text, true), text(truncate(status, inner), c.muted), '',
    text(truncate(filterText, inner), c.green),
    text('/ ', c.faint) + text(truncate(state.query || (state.searching ? '' : 'Search title, project, or model'), inner - 4), state.query ? c.text : c.faint) + (state.searching ? text('▌', c.green) : ''), ''];
  const detailsHeight = rows >= 26 ? 7 : 0;
  const listHeight = Math.max(1, rows - lines.length - detailsHeight - 5);
  const start = Math.max(0, Math.min(state.selected - Math.floor(listHeight / 2), sessions.length - listHeight));
  for (let slot = 0; slot < listHeight; slot++) {
    const i = start + slot;
    const session = sessions[i];
    if (!session) {
      const empty = state.discovering ? 'Looking in local harness folders…' : state.sessions.length ? 'No matches. Esc clears search and filters.' : 'No saved sessions found. Press o to open a file.';
      lines.push(slot === 0 ? text(truncate(empty, inner), c.muted) : '');
      continue;
    }
    const theme = themes[session.harness];
    const active = i === state.selected;
    const meta = `${theme.name}${session.modifiedAt ? ' · ' + relativeTime(session.modifiedAt, now) : ''}`;
    const left = text(active ? ' ▸ ' : '   ', theme.accent) + text(truncate(session.title, Math.max(6, inner - width(meta) - 6)), active ? c.text : c.muted, active);
    lines.push(row(left, text(meta, active ? theme.accent : c.faint), inner));
  }
  if (detailsHeight) {
    const details = selected ? ['', rule(inner), labelValue('PROJECT', selected.cwd || 'Not recorded', inner),
      labelValue('MODEL', selected.model || 'Read when opened', inner), labelValue('SOURCE', selected.source, inner),
      ...wrapWords(selected.preview || selected.turns?.[0]?.prompt || 'Enter to load this session for replay.', inner).slice(0, 2).map((line) => text(line, c.muted))]
      : ['', rule(inner), text('DISCOVERY LOCATIONS', c.faint), ...state.sources.filter((s) => s.status !== 'missing').slice(0, 4).map((s) => text(truncate(s.path, inner), c.muted))];
    while (details.length < detailsHeight) details.push('');
    lines.push(...details.slice(0, detailsHeight));
  }
  while (lines.length < rows - 5) lines.push('');
  if (state.importing) {
    lines.push(text('OPEN SESSION · JSON / JSONL', c.green), text('› ') + text(truncate(state.input, inner - 4), c.text) + text('▌', c.green), text(truncate(state.error || 'Local path · Enter open · Esc cancel', inner), state.error ? c.red : c.muted));
  } else {
    const note = state.error || (state.loading ? 'Loading session…' : state.discoveryErrors.length ? `${state.discoveryErrors.length} discovery issues · ${state.discoveryErrors[0]}` : `${sessions.length} shown · ${state.speed}× replay speed`);
    lines.push(text(truncate(note, inner), state.error ? c.red : state.discoveryErrors.length ? c.gold : c.faint), rule(inner), text(inner < 70 ? '↵ open  / search  tab filter  r scan  o file' : '↑↓ select  enter open  / search  tab filter  r refresh  o file  q quit', c.muted));
  }
  lines.push('');
  return lines.slice(0, rows).map((line) => '   ' + line);
}

export function render(state, columns, rows, now) {
  if (columns < 48 || rows < 16) return ['', text('  Replay Harness', c.green, true), '', text('  Enlarge your terminal to at least 48 × 16.', c.muted), text('  q to quit', c.faint)];
  return state.view === 'discovery' ? renderDiscovery(state, columns, rows, now) : renderPlayer(state, columns, rows, now);
}
