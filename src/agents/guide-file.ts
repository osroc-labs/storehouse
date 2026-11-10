import { getUsageError } from '../errors.ts';
import { guideEnd, guideStart } from './agent-guide.ts';

// The guide's place in a file like AGENTS.md: between its markers, so the rest of the file is the
// person's and survives every write.

// a marker counts only as a line of its own, so a sentence or a code span that quotes one is prose
const getMarkerPattern = (marker: string) =>
  new RegExp(`^${marker}\\r?$`, 'gm');

const findMarkers = (text: string, marker: string) =>
  [...text.matchAll(getMarkerPattern(marker))].map((match) => ({
    index: match.index,
    length: match[0].length,
  }));

const formatBlock = (guide: string) => {
  if (guide.includes(guideStart) || guide.includes(guideEnd)) {
    throw new Error("The guide can't hold storehouse's own markers.");
  }
  return `${guideStart}\n${guide}\n${guideEnd}`;
};

// the block's bounds in text, undefined when there's none, or an error naming a broken one
const findBlock = (text: string, fileName: string) => {
  const starts = findMarkers(text, guideStart);
  const ends = findMarkers(text, guideEnd);
  if (starts.length === 0 && ends.length === 0) return undefined;
  const [start] = starts;
  const [end] = ends;
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    start === undefined ||
    end === undefined ||
    end.index < start.index
  ) {
    throw getUsageError(
      `${fileName} has storehouse's markers out of order or more than once. Leave one ${guideStart} line and one ${guideEnd} line after it, then run this again.`,
    );
  }
  return {
    start: start.index,
    end: end.index + guideEnd.length,
    inside: text.slice(start.index + start.length + 1, end.index),
  };
};

// The file's text with the guide in it: its block replaced in place, or added at the end, in the
// file's own line endings.
const placeGuide = ({
  existingText,
  guide,
  fileName,
}: {
  existingText: string | undefined;
  guide: string;
  fileName: string;
}) => {
  const lineEnd = existingText?.includes('\r\n') ? '\r\n' : '\n';
  const block = formatBlock(guide).replaceAll('\n', lineEnd);
  if (existingText === undefined || existingText.trim() === '') {
    return `${block}${lineEnd}`;
  }
  const bounds = findBlock(existingText, fileName);
  if (bounds === undefined) {
    const separator = existingText.endsWith('\n') ? lineEnd : lineEnd + lineEnd;
    return `${existingText}${separator}${block}${lineEnd}`;
  }
  return `${existingText.slice(0, bounds.start)}${block}${existingText.slice(bounds.end)}`;
};

// the guide in a file's block, with \n line endings, or undefined when the file has none
const getGuideInFile = (text: string, fileName: string) => {
  const bounds = findBlock(text, fileName);
  if (bounds === undefined) return undefined;
  return bounds.inside.replaceAll('\r\n', '\n').replace(/\r?\n$/, '');
};

// Lines removed and added, as a unified-style diff of the changed region, for --dry-run.
const formatChange = ({
  before,
  after,
  fileName,
}: {
  before: string;
  after: string;
  fileName: string;
}) => {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  let first = 0;
  while (
    first < beforeLines.length &&
    first < afterLines.length &&
    beforeLines[first] === afterLines[first]
  ) {
    first++;
  }
  let fromEnd = 0;
  while (
    fromEnd < beforeLines.length - first &&
    fromEnd < afterLines.length - first &&
    beforeLines.at(-1 - fromEnd) === afterLines.at(-1 - fromEnd)
  ) {
    fromEnd++;
  }
  return [
    `--- ${fileName}`,
    `+++ ${fileName}`,
    `@@ line ${first + 1} @@`,
    ...beforeLines
      .slice(first, beforeLines.length - fromEnd)
      .map((l) => `-${l}`),
    ...afterLines.slice(first, afterLines.length - fromEnd).map((l) => `+${l}`),
  ].join('\n');
};

export const guideFileService = {
  place: placeGuide,
  getGuide: getGuideInFile,
  formatChange,
};
