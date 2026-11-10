import { getProcessIo } from '../terminal/io.ts';

// Asks once at the real hidden prompt and reports what it read, for hidden.test.ts under a pty.
try {
  const value = await getProcessIo().prompt('Value: ', { isHidden: true });
  process.stderr.write(`\nRESULT ${JSON.stringify(value)}\n`);
} catch (error) {
  process.stderr.write(
    `\nERROR ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
