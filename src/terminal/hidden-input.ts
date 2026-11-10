// A hidden prompt's input, read in raw mode. Enter ends it; a pasted value keeps its line breaks
// because the terminal marks the paste (bracketed paste), and an unmarked one is refused.

export const pasteOn = '\u001b[?2004h';
export const pasteOff = '\u001b[?2004l';

const pasteStart = '\u001b[200~';
const pasteEnd = '\u001b[201~';

// The length of the CSI sequence (an arrow key, a paste marker) that text starts with: 0 for
// none, and -1 for the start of one that a chunk cut off.
const getCsiLength = (text: string) => {
  if (text.length === 1) return -1;
  if (text[1] !== '[') return 0;
  for (let i = 2; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
    if (!/[0-9;?]/.test(text.charAt(i))) return 0;
  }
  return -1;
};

export type HiddenResult =
  | { kind: 'more' }
  | { kind: 'done'; value: string }
  | { kind: 'stopped' }
  | { kind: 'unmarked' };

// oxlint-disable-next-line local/format-in-one-place -- splits input into characters; nothing here is shown
const graphemeSegmenter = new Intl.Segmenter();
const removeLastCharacter = (text: string) =>
  Array.from(graphemeSegmenter.segment(text), (s) => s.segment)
    .slice(0, -1)
    .join('');

export const createHiddenReader = () => {
  let value = '';
  let pending = '';
  let pasting = false;

  const feed = (chunk: string): HiddenResult => {
    const text = pending + chunk;
    pending = '';
    for (let i = 0; i < text.length;) {
      const rest = text.slice(i);
      const ch = rest[0] ?? '';
      if (ch === '\u001b') {
        const length = getCsiLength(rest);
        if (length === -1) {
          pending = rest;
          return { kind: 'more' };
        }
        const seq = rest.slice(0, length);
        if (seq === pasteStart) pasting = true;
        if (seq === pasteEnd) pasting = false;
        i += length || 1;
        continue;
      }
      i += 1;
      if (pasting) {
        // Terminals send a pasted line break as CR.
        if (ch === '\r') {
          value += '\n';
          if (text[i] === '\n') i += 1;
        } else {
          value += ch;
        }
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        const after = text.slice(ch === '\r' && text[i] === '\n' ? i + 1 : i);
        return after ? { kind: 'unmarked' } : { kind: 'done', value };
      }
      if (ch === '\u0004') return { kind: 'done', value };
      if (ch === '\u0003') return { kind: 'stopped' };
      if (ch === '\u007f' || ch === '\b') value = removeLastCharacter(value);
      else if (ch === '\u0015') value = '';
      else if (ch >= ' ' || ch === '\t') value += ch;
    }
    return { kind: 'more' };
  };

  return { feed };
};
