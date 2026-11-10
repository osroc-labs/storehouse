import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { guideEnd, guideStart } from './agent-guide.ts';
import { guideFileService } from './guide-file.ts';

const place = (existingText: string | undefined, guide: string) =>
  guideFileService.place({ existingText, guide, fileName: 'AGENTS.md' });

describe('guideFileService', () => {
  it('writes only the block into a new or empty file', () => {
    const expected = `${guideStart}\nguide\n${guideEnd}\n`;
    assert.equal(place(undefined, 'guide'), expected);
    assert.equal(place('  \n', 'guide'), expected);
  });

  it('adds the block after what a file already says', () => {
    assert.equal(
      place('# My repo\n', 'guide'),
      `# My repo\n\n${guideStart}\nguide\n${guideEnd}\n`,
    );
    assert.equal(
      place('# My repo', 'guide'),
      `# My repo\n\n${guideStart}\nguide\n${guideEnd}\n`,
    );
  });

  it('replaces only the block, keeping edits around it', () => {
    const before = `# Mine\n\nAbove.\n\n${guideStart}\nold\n${guideEnd}\n\nBelow, added later.\n`;
    assert.equal(
      place(before, 'new'),
      `# Mine\n\nAbove.\n\n${guideStart}\nnew\n${guideEnd}\n\nBelow, added later.\n`,
    );
  });

  it('changes nothing on a second write', () => {
    const once = place('# Mine\n', 'guide');
    assert.equal(place(once, 'guide'), once);
  });

  it('reads back the guide it wrote', () => {
    assert.equal(
      guideFileService.getGuide(place('# Mine\n', 'a\nb'), 'AGENTS.md'),
      'a\nb',
    );
    assert.equal(guideFileService.getGuide('# Mine\n', 'AGENTS.md'), undefined);
  });

  it('refuses markers that are doubled, alone or out of order', () => {
    for (const broken of [
      `${guideStart}\n${guideStart}\n${guideEnd}`,
      `${guideStart}\nno end`,
      `${guideEnd}\n${guideStart}`,
    ]) {
      assert.throws(
        () => place(broken, 'guide'),
        /AGENTS\.md has storehouse's markers out of order or more than once/,
      );
    }
  });

  it('counts a marker only on a line of its own, so prose that quotes one is left alone', () => {
    const prose = `The guide sits between \`${guideStart}\` and \`${guideEnd}\`; don't edit it.\n\n\`\`\`md\n ${guideStart}\n\`\`\`\n`;
    assert.equal(guideFileService.getGuide(prose, 'AGENTS.md'), undefined);
    const placed = place(prose, 'guide');
    assert.ok(placed.startsWith(prose));
    assert.equal(guideFileService.getGuide(placed, 'AGENTS.md'), 'guide');
    assert.equal(place(placed, 'guide'), placed);
  });

  it('keeps a CRLF file in CRLF, and reads its guide as current', () => {
    const before = '# Mine\r\n\r\nAbove.\r\n';
    const placed = place(before, 'a\nb');
    assert.equal(
      placed,
      `# Mine\r\n\r\nAbove.\r\n\r\n${guideStart}\r\na\r\nb\r\n${guideEnd}\r\n`,
    );
    assert.equal(guideFileService.getGuide(placed, 'AGENTS.md'), 'a\nb');
    assert.equal(place(placed, 'a\nb'), placed);
    assert.equal(
      place(placed, 'c'),
      `# Mine\r\n\r\nAbove.\r\n\r\n${guideStart}\r\nc\r\n${guideEnd}\r\n`,
    );
  });

  it("refuses to write a guide that holds storehouse's own markers", () => {
    assert.throws(() => place(undefined, `x\n${guideEnd}\ny`), /markers/);
    assert.throws(() => place(undefined, `x ${guideStart}`), /markers/);
  });

  it('shows a change as the lines it removes and adds', () => {
    assert.equal(
      guideFileService.formatChange({
        before: 'a\nold\nz',
        after: 'a\nnew\nz',
        fileName: 'AGENTS.md',
      }),
      '--- AGENTS.md\n+++ AGENTS.md\n@@ line 2 @@\n-old\n+new',
    );
  });
});
