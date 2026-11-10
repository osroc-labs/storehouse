import { z } from 'zod';
import { manifestSchema } from './schema.ts';

// where editors fetch the schema once the package is on npm; jsDelivr serves the latest published one
const schemaUrl =
  'https://cdn.jsdelivr.net/npm/@osroc-labs/storehouse/schema.json';

// storehouse.json's JSON Schema, for editors, generated from the Zod schema the CLI checks with.
export const generateJsonSchema = () =>
  `${JSON.stringify(
    {
      $id: schemaUrl,
      ...z.toJSONSchema(manifestSchema, { io: 'input', target: 'draft-7' }),
      title: 'storehouse.json',
    },
    null,
    2,
  )}\n`;
