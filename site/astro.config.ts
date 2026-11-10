import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://storehouse.osroc.io',
  // Astro's compressor drops the space between a line's text and a <code> on the next line.
  compressHTML: false,
  // Every style and script in its own file, so the CSP (public/_headers) needs no inline hashes.
  build: { inlineStylesheets: 'never' },
  vite: { build: { assetsInlineLimit: 0 } },
});
