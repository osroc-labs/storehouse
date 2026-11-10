import { describe, it } from 'node:test';
import { RuleTester } from 'oxlint/plugins-dev';
import { rules } from './rules.ts';

// RuleTester registers its cases through these; node:test's runner awaits what they return
RuleTester.describe = (text, fn) => void describe(text, fn);
RuleTester.it = (text, fn) => void it(text, fn);

new RuleTester().run('format-in-one-place', rules['format-in-one-place'], {
  valid: ['const label = format.ago(created, now);'],
  invalid: [
    {
      code: 'const when = date.toLocaleDateString();',
      errors: ['Format what a person reads with src/utils/format.ts.'],
    },
    {
      code: 'const list = new Intl.ListFormat();',
      errors: ['Format what a person reads with src/utils/format.ts.'],
    },
  ],
});
