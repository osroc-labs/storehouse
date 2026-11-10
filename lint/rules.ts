import type { RuleTester } from 'oxlint/plugins-dev';

type Rule = Parameters<RuleTester['run']>[1];

// Everything a person reads (times, counts) is formatted in src/utils/format.ts.
const formatInOnePlace = {
  create: (context) => ({
    MemberExpression: (node) => {
      const isLocale =
        node.property.type === 'Identifier' &&
        node.property.name.startsWith('toLocale');
      const isIntl =
        node.object.type === 'Identifier' && node.object.name === 'Intl';
      if (isLocale || isIntl) {
        context.report({
          node,
          message: 'Format what a person reads with src/utils/format.ts.',
        });
      }
    },
  }),
} satisfies Rule;

export const rules = { 'format-in-one-place': formatInOnePlace };

export default { meta: { name: 'local' }, rules };
