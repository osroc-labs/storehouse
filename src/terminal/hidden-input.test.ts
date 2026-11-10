import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHiddenReader } from './hidden-input.ts';

const pem = '-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----';
const paste = (text: string) =>
  `\u001b[200~${text.replaceAll('\n', '\r')}\u001b[201~`;

const read = (...chunks: string[]) => {
  const reader = createHiddenReader();
  let result = reader.feed('');
  for (const chunk of chunks) result = reader.feed(chunk);
  return result;
};

describe('the hidden prompt reader', () => {
  it('ends a typed value at Enter', () => {
    assert.deepEqual(read('s3cr', 'et\r'), { kind: 'done', value: 's3cret' });
    assert.deepEqual(read('abc\n'), { kind: 'done', value: 'abc' });
    assert.deepEqual(read('abc\r\n'), { kind: 'done', value: 'abc' });
  });

  it('keeps a multi-line paste whole, line breaks and all', () => {
    assert.deepEqual(read(`${paste(`${pem}\n`)}\r`), {
      kind: 'done',
      value: `${pem}\n`,
    });
    assert.deepEqual(read('\u001b[200~a\r\nb\u001b[201~', '\r'), {
      kind: 'done',
      value: 'a\nb',
    });
  });

  it('reads paste markers and keys split across chunks', () => {
    const whole = `${paste(pem)}\r`;
    for (let cut = 1; cut < whole.length; cut++) {
      assert.deepEqual(
        read(whole.slice(0, cut), whole.slice(cut)),
        { kind: 'done', value: pem },
        `cut at ${cut}`,
      );
    }
    assert.deepEqual(read('a\u001b', '[Db\r'), { kind: 'done', value: 'ab' });
  });

  it('refuses lines followed by more input, a paste the terminal did not mark', () => {
    assert.deepEqual(read('-----BEGIN KEY-----\rabc\r'), { kind: 'unmarked' });
    assert.deepEqual(read('one\ntwo'), { kind: 'unmarked' });
  });

  it('edits and stops like a terminal', () => {
    assert.deepEqual(read('ab\u007fc\r'), { kind: 'done', value: 'ac' });
    assert.deepEqual(read('a👍\u007f\r'), { kind: 'done', value: 'a' });
    assert.deepEqual(read('abc\u0015x\r'), { kind: 'done', value: 'x' });
    assert.deepEqual(read('a\u0001\tb\r'), { kind: 'done', value: 'a\tb' });
    assert.deepEqual(read('ab\u0004'), { kind: 'done', value: 'ab' });
    assert.deepEqual(read('ab\u0003'), { kind: 'stopped' });
    assert.deepEqual(read('ab'), { kind: 'more' });
  });
});

// The real prompt in a pseudo-terminal, through script(1): BSD's on macOS, util-linux's on Linux.
// Its stdin comes through `cat |`, a real pipe: BSD script refuses the socket Node would give it.
const fixture = fileURLToPath(
  new URL('../testing/hidden-prompt-for-test.ts', import.meta.url),
);
const inPty = (command: string) =>
  process.platform === 'darwin'
    ? `script -q /dev/null ${command}`
    : `script -qec '${command}' /dev/null`;
const prompt = inPty(`"${process.execPath}" "${fixture}"`);
const hasScript =
  process.platform !== 'win32' &&
  spawnSync('sh', ['-c', `true | ${inPty('true')}`]).status === 0;

const underPty = (chunks: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('sh', ['-c', `cat | ${prompt}`]);
    let out = '';
    child.stdout.on('data', (data: Buffer) => {
      out += data.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => {
      resolve(out);
    });
    // The chunks go once the question shows, which is after raw mode is on, a little apart.
    let sent = false;
    child.stdout.on('data', () => {
      if (sent || !out.includes('Value: ')) return;
      sent = true;
      chunks.forEach((chunk, i) => {
        setTimeout(() => child.stdin.write(chunk), 100 + i * 150);
      });
      setTimeout(() => child.stdin.end(), 100 + chunks.length * 150 + 700);
    });
    // A prompt that never shows fails the test rather than hanging it.
    setTimeout(() => {
      if (!sent) child.stdin.end();
    }, 20_000).unref();
  });

describe(
  'the hidden prompt in a terminal',
  { skip: !hasScript, concurrency: true },
  () => {
    it('stores a pasted PEM whole, without echoing it', async () => {
      const out = await underPty([`${paste(`${pem}\n`)}\r`]);
      assert.match(
        out,
        /RESULT "-----BEGIN KEY-----\\nabc\\ndef\\n-----END KEY-----\\n"/,
      );
      assert.doesNotMatch(out.replace(/RESULT .*/, ''), /abc/);
    });

    it('takes a typed value with a backspace', async () => {
      const out = await underPty(['se', '\u007fecret', '\r']);
      assert.match(out, /RESULT "secret"/);
    });

    it('refuses a multi-line paste the terminal did not mark', async () => {
      const out = await underPty([
        '-----BEGIN KEY-----\rabc\r-----END KEY-----\r',
      ]);
      assert.match(out, /ERROR That was more than one line/);
    });

    it('stops at Ctrl-C', async () => {
      const out = await underPty(['ab\u0003']);
      assert.match(out, /ERROR Stopped\. Nothing was done\./);
    });
  },
);
