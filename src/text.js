import { stripVTControlCharacters } from 'node:util';

// Recordings are display data. Never let their escape sequences control a terminal.
export function clean(value) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\t/g, '  ');
}

export function contentText(content) {
  if (typeof content === 'string') return clean(content);
  if (content == null) return '';
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n');
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return clean(content.text);
    if (typeof content.thinking === 'string') return clean(content.thinking);
    if (content.type === 'image' || content.type === 'input_image' || content.inlineData) return '[image]';
    if (content.type === 'document') return '[document]';
    if (content.functionResponse) return contentText(content.functionResponse.response);
    if (content.content !== undefined) return contentText(content.content);
    return clean(JSON.stringify(content, null, 2));
  }
  return clean(content);
}

export function toolInput(value) {
  let input = value;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return clean(input); }
  }
  if (input && typeof input === 'object') {
    const command = input.cmd ?? input.command;
    if (command) return clean(Array.isArray(command) ? command.join(' ') : command);
    if (input.patch) return clean(input.patch);
    const path = input.path ?? input.file_path ?? input.filePath;
    const before = input.oldText ?? input.old_string;
    const after = input.newText ?? input.new_string;
    if (path && typeof before === 'string' && typeof after === 'string') {
      return clean(`${path}\n${before.split('\n').map((line) => '- ' + line).join('\n')}\n${after.split('\n').map((line) => '+ ' + line).join('\n')}`);
    }
    if (path && typeof input.content === 'string') return clean(`${path}\n${input.content}`);
    if (path && Object.keys(input).length === 1) return clean(path);
  }
  return contentText(input);
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function graphemes(text) {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

export function cellWidth(char) {
  if (/^\p{Mark}+$/u.test(char)) return 0;
  if (/\p{Extended_Pictographic}/u.test(char) || /[\u{1f1e6}-\u{1f1ff}]/u.test(char)) return 2;
  const cp = char.codePointAt(0);
  return cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) ? 2 : 1;
}

export function width(text) {
  return graphemes(stripVTControlCharacters(text)).reduce((n, c) => n + cellWidth(c), 0);
}

export function truncate(text, max, suffix = '…') {
  if (width(text) <= max) return text;
  let out = '', used = 0;
  const limit = Math.max(0, max - width(suffix));
  for (const c of graphemes(text)) {
    if (used + cellWidth(c) > limit) break;
    out += c;
    used += cellWidth(c);
  }
  return max > 0 ? out + suffix : '';
}

export function wrap(text, columns) {
  const max = Math.max(2, columns);
  const lines = [];
  for (const line of clean(text).split('\n')) {
    let current = '', used = 0;
    for (const c of graphemes(line)) {
      const size = cellWidth(c);
      if (used + size > max) { lines.push(current); current = ''; used = 0; }
      current += c;
      used += size;
    }
    lines.push(current);
  }
  return lines;
}

export function wrapWords(text, columns) {
  const max = Math.max(2, columns);
  const lines = [];
  for (const line of clean(text).split('\n')) {
    let current = '';
    for (const word of line.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) { if (current) current += word; continue; }
      if (width(current + word) <= max) { current += word; continue; }
      if (current.trim()) lines.push(current.trimEnd());
      const pieces = wrap(word, max);
      lines.push(...pieces.slice(0, -1));
      current = pieces.at(-1);
    }
    lines.push(current.trimEnd());
  }
  return lines;
}
