import {
  format as formatDate,
  isSameYear,
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  differenceInMonths,
  differenceInYears,
} from 'date-fns';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';

// Everything a person reads goes through here: times, counts, tables and colour.

type Style = 'green' | 'red' | 'yellow' | 'dim' | 'bold';

// storehouse's own colour codes travel as private-use characters around a nonce made once per run.
// Text from a repo, Google or a CLI can't know the nonce, so it can't make one.
const colourNonce = randomUUID().replaceAll('-', '');
const colourMarkerPattern = new RegExp(
  `\uE000${colourNonce}([0-9]+)\uE001`,
  'g',
);
const formatColourMarker = (code: number) =>
  `\uE000${colourNonce}${code}\uE001`;

const ageUnits = [
  { unit: 'y', difference: differenceInYears },
  { unit: 'mo', difference: differenceInMonths },
  { unit: 'd', difference: differenceInDays },
  { unit: 'h', difference: differenceInHours },
  { unit: 'm', difference: differenceInMinutes },
] as const;

// "3d ago", "just now": short enough for a table cell.
const formatAgo = (iso: string, now: Date) => {
  const date = new Date(iso);
  for (const { unit, difference } of ageUnits) {
    const count = difference(now, date);
    if (count >= 1) return `${count}${unit} ago`;
  }
  return 'just now';
};

// "Nov 2 22:38" in the person's own time zone, with the year when it isn't this one
const formatWhen = (iso: string, now: Date) => {
  const date = new Date(iso);
  return formatDate(
    date,
    isSameYear(date, now) ? 'MMM d HH:mm' : 'MMM d yyyy HH:mm',
  );
};

const formatPlural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const formatJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// Visible width, without the colour codes.
const getVisibleWidth = (text: string) =>
  text.replace(colourMarkerPattern, '').length;

const padCell = (cell: string, width: number) =>
  cell + ' '.repeat(Math.max(0, width - getVisibleWidth(cell)));

const formatTable = (rows: readonly string[][], gap = '  ') => {
  const widths = rows.reduce<number[]>(
    (acc, row) =>
      row.map((cell, i) => Math.max(acc[i] ?? 0, getVisibleWidth(cell))),
    [],
  );
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : padCell(cell, widths[i] ?? 0),
        )
        .join(gap)
        .trimEnd(),
    )
    .join('\n');
};

const truncateText = (text: string, room: number) =>
  room >= 1 && text.length > room ? `${text.slice(0, room - 1)}…` : text;

const shouldUseColor = ({
  env,
  isTTY,
}: {
  env: Readonly<Record<string, string | undefined>>;
  isTTY: boolean;
}) => {
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return isTTY && !env.NO_COLOR && env.TERM !== 'dumb';
};

// Paints text only where colour reaches a terminal that wants it (NO_COLOR, FORCE_COLOR). The
// colour goes as markers terminalSafe turns into SGR, so the text inside is never trusted to colour.
const getPainter = (options: Parameters<typeof shouldUseColor>[0]) => {
  const isColored = shouldUseColor(options);
  return (style: Style, text: string) => {
    if (!isColored) return text;
    const [open, close] = inspect.colors[style] ?? [];
    if (open === undefined || close === undefined) return text;
    return `${formatColourMarker(open)}${text}${formatColourMarker(close)}`;
  };
};

// C0 and C1 controls, and the bidi overrides and isolates that reorder what a line seems to say
const isControlCode = (code: number) =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

// A CLI's colours as it relays them: any SGR whose parameters, read as numbers, don't include
// conceal (8), which could hide what it printed
const relayedSgrSequence = /^\[([0-9;]*)m/;

const getRelayedSgr = (rest: string) => {
  const relayed = relayedSgrSequence.exec(rest);
  if (!relayed) return undefined;
  const isConcealing = (relayed[1] ?? '')
    .split(';')
    .some((parameter) => parameter !== '' && Number(parameter) === 8);
  return isConcealing ? undefined : relayed[0];
};

// Every control character but a line break and a tab written as an escape, apart from a push
// target CLI's colours when isRelayed.
const escapeControls = (text: string, isRelayed: boolean) => {
  let safeText = '';
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    const code = text.charCodeAt(i);
    if (char === '\n' || char === '\t' || !isControlCode(code)) {
      safeText += char;
      continue;
    }
    const sgr =
      isRelayed && code === 0x1b ? getRelayedSgr(text.slice(i + 1)) : undefined;
    if (sgr !== undefined) {
      safeText += char + sgr;
      i += sgr.length;
      continue;
    }
    safeText += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return safeText;
};

// Text made safe for a terminal. Only storehouse's own painter colours it (its markers become
// SGR); every escape in the text itself is escaped, except a push target CLI's colours when
// isRelayed.
const formatTerminalSafe = (text: string, { isRelayed = false } = {}) => {
  const parts = text.split(colourMarkerPattern);
  return parts
    .map((part, i) =>
      i % 2 === 1 ? `\u001b[${part}m` : escapeControls(part, isRelayed),
    )
    .join('');
};

// Text from a repo's workflow, shown inside a line: every control character, escapes included, as
// JSON writes it, so it can't colour, conceal or start a line.
const formatInline = (text: string) => JSON.stringify(text).slice(1, -1);

export type Painter = ReturnType<typeof getPainter>;

export const format = {
  ago: formatAgo,
  when: formatWhen,
  json: formatJson,
  plural: formatPlural,
  table: formatTable,
  truncate: truncateText,
  visibleWidth: getVisibleWidth,
  painter: getPainter,
  terminalSafe: formatTerminalSafe,
  inline: formatInline,
};
