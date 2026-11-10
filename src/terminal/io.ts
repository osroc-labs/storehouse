import { on } from 'node:events';
import { createInterface } from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as sleep } from 'node:timers/promises';
import { CliError, ExitCode } from '../errors.ts';
import { createCredentials } from '../secret-manager/credentials.ts';
import type { Credentials } from '../secret-manager/credentials.ts';
import { secretManagerUrl } from '../secret-manager/secret-manager-api.ts';
import { createHiddenReader, pasteOff, pasteOn } from './hidden-input.ts';
import type { HiddenResult } from './hidden-input.ts';

// Everything a command touches outside storehouse, so a test can stand in for each part.
export type Io = {
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: { isTTY: boolean; readAll: () => Promise<Buffer> };
  stdout: {
    isTTY: boolean;
    columns: number | undefined;
    write: (data: string | Uint8Array) => void;
  };
  stderr: {
    isTTY: boolean;
    write: (data: string) => void;
    // a push target CLI's own output, which may keep its colours
    writeRelayed?: (data: string) => void;
  };
  // asks on the terminal (stderr); a hidden answer may be a multi-line paste
  prompt: (question: string, options: { isHidden: boolean }) => Promise<string>;
  now: () => Date;
  google: {
    baseUrl: string;
    credentials: Credentials;
    retryBaseMs?: number;
    timeoutMs?: number;
  };
};

const getStoppedError = (cause?: unknown) =>
  new CliError(ExitCode.refused, 'Stopped. Nothing was done.', { cause });

const getAnswer = async (question: string) => {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  const controller = new AbortController();
  rl.on('SIGINT', () => {
    controller.abort();
  });
  try {
    return await rl.question(question, { signal: controller.signal });
  } catch (error) {
    throw getStoppedError(error);
  } finally {
    rl.close();
  }
};

const getHiddenAnswer = async (question: string) => {
  const { stdin, stderr } = process;
  const controller = new AbortController();
  const events = on(stdin, 'data', { signal: controller.signal });
  // whether more input arrives within ms; a closed or aborted stream counts as none
  const hasMoreInput = (ms: number) =>
    Promise.race([
      events.next().then(
        (next) => next.done !== true,
        () => false,
      ),
      sleep(ms).then(() => false),
    ]);
  const reader = createHiddenReader();
  const decoder = new StringDecoder('utf8');
  // raw mode first, so a key pressed as soon as the question shows is read, not taken as a signal
  stdin.setRawMode(true);
  stdin.resume();
  stderr.write(`${question}${stderr.isTTY ? pasteOn : ''}`);
  try {
    let input: HiddenResult = { kind: 'more' };
    while (input.kind === 'more') {
      const next = await events.next();
      const chunk: unknown = next.done === true ? undefined : next.value[0];
      input = Buffer.isBuffer(chunk)
        ? reader.feed(decoder.write(chunk))
        : reader.feed('\u0004');
    }
    // input still arriving after Enter is the rest of a paste the terminal didn't mark
    if (input.kind === 'done' && (await hasMoreInput(50))) {
      input = { kind: 'unmarked' };
    }
    if (input.kind === 'unmarked') {
      while (await hasMoreInput(100));
      throw new CliError(
        ExitCode.failed,
        "That was more than one line, and the terminal didn't mark it as a paste, so nothing was stored. Pipe the value in instead, or paste it in a terminal with bracketed paste (most have it).",
      );
    }
    if (input.kind === 'stopped') throw getStoppedError();
    return input.value;
  } finally {
    controller.abort();
    stdin.setRawMode(false);
    stdin.pause();
    stderr.write(`${stderr.isTTY ? pasteOff : ''}\n`);
  }
};

const readStdin = async () => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
};

export const getProcessIo = () =>
  ({
    cwd: process.cwd(),
    env: process.env,
    stdin: { isTTY: process.stdin.isTTY, readAll: readStdin },
    stdout: {
      isTTY: process.stdout.isTTY,
      columns: process.stdout.columns,
      write: (data) => {
        process.stdout.write(data);
      },
    },
    stderr: {
      isTTY: process.stderr.isTTY,
      write: (data) => {
        process.stderr.write(data);
      },
    },
    prompt: (question, { isHidden }) =>
      isHidden ? getHiddenAnswer(question) : getAnswer(question),
    now: () => new Date(),
    google: {
      baseUrl: secretManagerUrl,
      credentials: createCredentials({ env: process.env }),
    },
  }) satisfies Io;
