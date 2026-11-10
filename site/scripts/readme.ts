// The README as blocks the site renders: paragraphs, lists, tables and code, with inline code,
// bold and links. Only the Markdown the README uses; anything else reads as a paragraph.
import { readFileSync } from 'node:fs';

const readmeUrl = new URL('../../README.md', import.meta.url);
const repoUrl = 'https://github.com/osroc-labs/storehouse';

type Part = { text: string; isCode?: true; isStrong?: true; href?: string };
type Block =
  | { kind: 'paragraph'; parts: Part[] }
  | { kind: 'list'; isOrdered: boolean; items: Block[][] }
  | { kind: 'table'; head: Part[][]; rows: Part[][][] }
  | { kind: 'code'; lang: string; text: string };

const inlinePattern = /`([^`]+)`|\*\*|\[((?:[^\]`]|`[^`]*`)+)\]\(([^)\s]+)\)/g;
const listMarkerPattern = /^(?:- |\d+\. )/;
const tableSeparatorPattern = /^\|(?:\s*:?-+:?\s*\|)+$/;

// a README link, made absolute: an anchor or a file in the repo points at GitHub
const getHref = (target: string) => {
  if (/^https?:\/\//.test(target)) return target;
  if (target.startsWith('#')) return `${repoUrl}${target}`;
  return `${repoUrl}/blob/master/${target}`;
};

const parseInline = (text: string, isInStrong = false): Part[] => {
  const parts: Part[] = [];
  let isStrong = isInStrong;
  let last = 0;
  const pushText = (value: string) => {
    if (value === '') return;
    parts.push({ text: value, ...(isStrong && { isStrong: true }) });
  };
  for (const match of text.matchAll(inlinePattern)) {
    pushText(text.slice(last, match.index));
    last = match.index + match[0].length;
    const [token, code, linkText, target] = match;
    if (code !== undefined) {
      parts.push({
        text: code,
        isCode: true,
        ...(isStrong && { isStrong: true }),
      });
      continue;
    }
    if (token === '**') {
      isStrong = !isStrong;
      continue;
    }
    if (linkText !== undefined && target !== undefined) {
      const href = getHref(target);
      parts.push(
        ...parseInline(linkText, isStrong).map((part) => ({ ...part, href })),
      );
    }
  }
  pushText(text.slice(last));
  return parts;
};

const parseTableRow = (line: string) =>
  line
    .slice(1, -1)
    .split(' | ')
    .map((cell) => parseInline(cell.trim()));

const isBlockStart = (line: string) =>
  line.startsWith('```') ||
  line.startsWith('|') ||
  listMarkerPattern.test(line);

// One list's lines, from its first marker to the first line that belongs to neither an item nor
// its indented continuation. A blank line inside the list is kept when more of the list follows.
const takeList = (lines: readonly string[], start: number) => {
  const itemLines: string[][] = [];
  // a continuation line is indented to the item's text, past its marker
  let indent = 0;
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const marker = listMarkerPattern.exec(line)?.[0];
    if (marker !== undefined) {
      indent = marker.length;
      itemLines.push([line.slice(marker.length)]);
    } else if (line.trim() === '') {
      const next = lines.slice(index + 1).find((l) => l.trim() !== '') ?? '';
      if (!/^\s/.test(next) && !listMarkerPattern.test(next)) break;
      itemLines.at(-1)?.push('');
    } else if (/^\s/.test(line)) {
      itemLines.at(-1)?.push(line.replace(new RegExp(`^ {0,${indent}}`), ''));
    } else {
      break;
    }
    index++;
  }
  return { itemLines, end: index };
};

const parseBlocks = (lines: readonly string[]): Block[] => {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index++;
      continue;
    }
    if (line.startsWith('```')) {
      const close = lines.indexOf('```', index + 1);
      if (close === -1)
        throw new Error('README.md has an unclosed code block.');
      blocks.push({
        kind: 'code',
        lang: line.slice(3).trim(),
        text: lines.slice(index + 1, close).join('\n'),
      });
      index = close + 1;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (lines[index]?.startsWith('|')) rows.push(lines[index++] ?? '');
      const [head = '', ...body] = rows.filter(
        (row) => !tableSeparatorPattern.test(row),
      );
      blocks.push({
        kind: 'table',
        head: parseTableRow(head),
        rows: body.map(parseTableRow),
      });
      continue;
    }
    if (listMarkerPattern.test(line)) {
      const { itemLines, end } = takeList(lines, index);
      blocks.push({
        kind: 'list',
        isOrdered: /^\d/.test(line),
        items: itemLines.map(parseBlocks),
      });
      index = end;
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() !== '' &&
      !isBlockStart(lines[index] ?? '')
    ) {
      paragraph.push((lines[index++] ?? '').trim());
    }
    blocks.push({ kind: 'paragraph', parts: parseInline(paragraph.join(' ')) });
  }
  return blocks;
};

const getReadme = () => readFileSync(readmeUrl, 'utf8');

// The text under `## heading`, up to the next `## `.
const getSectionText = (heading: string) => {
  const [, rest = ''] = getReadme().split(`\n## ${heading}\n`);
  const [section = ''] = rest.split('\n## ');
  if (section === '') throw new Error(`README.md has no "## ${heading}".`);
  return section;
};

const getSectionBlocks = (heading: string) =>
  parseBlocks(getSectionText(heading).split('\n'));

// what a reader sees of some parts, for matching a block by its words
const getPlainText = (parts: readonly Part[]) =>
  parts.map((part) => part.text).join('');

const getBlockText = (block: Block | undefined) =>
  block?.kind === 'paragraph' ? getPlainText(block.parts) : '';

// The README's lead: the text between the title and the first `## `.
const getIntroBlocks = () => {
  const [intro = ''] = getReadme().split('\n## ');
  return parseBlocks(intro.split('\n').slice(1));
};

export type { Block, Part };

export const readmeService = {
  parseInline,
  getSectionText,
  getSectionBlocks,
  getIntroBlocks,
  getBlockText,
};
