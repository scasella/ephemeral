import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSetupOutputRedactor, redactSetupOutput } from '../server/setup-redaction.js';

const synthetic = () => randomBytes(24).toString('hex');
const pemBegin = ['-----BEGIN ', 'PRIVATE KEY', '-----'].join('');
const pemEnd = ['-----END ', 'PRIVATE KEY', '-----'].join('');
const missing = (text: string, values: string[]) => values.every(value => !text.includes(value.slice(0, 8)));

describe('bounded retained setup output redaction', () => {
  it('masks quoted auth JSON, common key formats, URI credentials and PEM blocks', () => {
    const values = Array.from({ length: 12 }, synthetic);
    values[7] = values[7]!.toUpperCase();
    const samples = [
      `{"access_token":\n"${values[0]}"}`,
      `{"OPENAI_API_KEY":\n"${values[3]}"}`, `Authorization:\nBearer ${values[11]}`,
      JSON.stringify({ tokens: { access_token: values[0], id_token: values[1], refresh_token: values[2] }, OPENAI_API_KEY: values[3], authKey: values[4] }),
      `password="${values[5]} with spaces"`,
      ['s', 'k', '-proj-', values[6]].join(''), ['A', 'K', 'I', 'A', values[7]!.toUpperCase()].join(''),
      `postgresql://user:${values[8]}@db.test/data`, `redis://:${values[9]}@cache.test`,
      ['-----BEGIN ', 'PRIVATE KEY-----\n', values[10], '\n-----END PRIVATE KEY-----'].join(''),
      `Authorization: Basic ${values[11]}`,
    ];
    const output = redactSetupOutput(samples.join('\n'));
    expect(missing(output, values)).toBe(true);
    expect(output.includes('[REDACTED]')).toBe(true);
    expect(output.includes('db.test/data')).toBe(true);
  });

  it('withholds unfinished lines across every split including terminal controls', () => {
    const secret = synthetic();
    const payload = `ok\n{"access_token":"${secret.slice(0, 12)}\x1b[31m${secret.slice(12)}"}\n`;
    for (let split = 0; split <= payload.length; split++) {
      let output = '';
      const redactor = createSetupOutputRedactor(text => { output += text; });
      redactor.write(payload.slice(0, split));
      expect(missing(output, [secret])).toBe(true);
      redactor.write(payload.slice(split)); redactor.end();
      expect(missing(output, [secret])).toBe(true);
      expect(output.includes('ok\n')).toBe(true);
    }
    let output = '';
    const redactor = createSetupOutputRedactor(text => { output += text; });
    const prefixed = ['g', 'h', 'p', '_', secret].join('');
    for (const char of `\x1b]8;;ignored\x1b\\${prefixed.slice(0, 6)}\x1b[0m${prefixed.slice(6)}\n`) {
      redactor.write(char); expect(missing(output, [secret])).toBe(true);
    }
    redactor.end(); expect(missing(output, [secret])).toBe(true);
  });

  it('masks exact VM-known values and incomplete known suffixes, including newline termination', () => {
    const secret = synthetic();
    for (const ending of ['', '\n']) {
      let output = '';
      const redactor = createSetupOutputRedactor(text => { output += text; }, { secrets: [secret] });
      redactor.write(`useful\n${secret.slice(0, 17)}${ending}`); redactor.end();
      expect(missing(output, [secret])).toBe(true);
      expect(output.includes('useful')).toBe(true);
      expect(output.includes('[REDACTED]')).toBe(true);
    }
  });

  it('redacts before clipping and drops overlong unfinished lines without retaining secret fragments', () => {
    const secret = synthetic();
    for (const prefix of ['x'.repeat(65520), 'safe\n'.repeat(13104)]) {
      let output = '';
      const redactor = createSetupOutputRedactor(text => { output += text; });
      redactor.write(prefix + `\n{"refresh_token":"${secret.slice(0, 12)}`);
      expect(missing(output, [secret])).toBe(true);
      redactor.write(secret.slice(12) + '"}\n'); redactor.end();
      expect(missing(output, [secret])).toBe(true);
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(65536);
      expect(redactor.truncated).toBe(true);
    }
  });

  it.each([false, true])('tracks every PEM boundary on a line with streaming=%s', streaming => {
    const secret = synthetic();
    for (const initial of ['', pemBegin + '\n']) {
      const line = initial ? `${pemEnd} ${pemBegin}\n` : `${pemBegin}a${pemEnd} ${pemBegin}\n`;
      const payload = initial + line + secret + `\n${pemEnd}\nfinal useful error\n`;
      for (let split = 0; split <= payload.length; split++) {
        let output = '';
        const redactor = createSetupOutputRedactor(text => { output += text; }, { streaming });
        redactor.write(payload.slice(0, split)); redactor.write(payload.slice(split)); redactor.end();
        expect(output).not.toContain(secret.slice(0, 8));
        expect(output).toContain('final useful error');
      }
    }
  });
  it('keeps safe text and masks recognized credential prefixes at EOF', () => {
    expect(redactSetupOutput('compiling\n2 tests passed')).toBe('compiling\n2 tests passed');
    expect(redactSetupOutput(['s', 'k', '-proj-'].join(''))).toBe('[REDACTED]');
  });
});

describe('streaming setup sanitization before head/tail retention', () => {
  it('continues after overlong lines and keeps PEM and folded credentials safe across dropped content', () => {
    const secret = synthetic();
    for (const payload of [
      'x'.repeat(100_000) + '\nfinal useful error\n',
      'x'.repeat(100_000) + pemBegin.slice(0, -5) + 'EXTRA\n' + secret + `\n${pemEnd}\nfinal useful error\n`,
      'x'.repeat(100_000) + pemBegin + '\n' + secret + `\n${pemEnd}\nfinal useful error\n`,
      'x'.repeat(100_000) + '"access_token":' + ' '.repeat(3000) + '\n' + secret + '\nfinal useful error\n',
      pemBegin + '\n' + 'x'.repeat(100_000) + pemEnd + '\nfinal useful error\n',
    ]) {
      let output = '';
      const redactor = createSetupOutputRedactor(text => { output += text; }, { streaming: true });
      for (let offset = 0; offset < payload.length; offset += 997) redactor.write(payload.slice(offset, offset + 997));
      redactor.end();
      expect(redactor.truncated).toBe(true);
      expect(output).not.toContain(secret.slice(0, 8));
      expect(output).toContain('final useful error');
    }
  });
  it('tracks repeated PEM boundaries across normal and dropped-line transitions', () => {
    const secret = synthetic();
    for (const initial of ['', pemBegin + '\n']) {
      for (const suffix of ['', 'x'.repeat(200)]) {
        const line = initial ? `${pemEnd} ${pemBegin}` : `${pemBegin}a${pemEnd} ${pemBegin}`;
        const payload = initial + 'x'.repeat(200) + line + suffix + '\n' + secret + `\n${pemEnd}\nfinal useful error\n`;
        for (let split = 195; split < 295; split++) {
          let output = '';
          const redactor = createSetupOutputRedactor(text => { output += text; }, { streaming: true, limit: 100 });
          redactor.write(payload.slice(0, split)); redactor.write(payload.slice(split)); redactor.end();
          expect(redactor.truncated).toBe(true);
          expect(output).not.toContain(secret.slice(0, 8));
          expect(output).toContain('final useful error');
        }
      }
    }
  });
  it('preserves dropped-line security state across every header/control split', () => {
    const secret = synthetic();
    const payload = 'x'.repeat(100) + `\x9b31m${pemBegin}\x1b]ignored\x07\n` + secret + `\n${pemEnd}\nAuthorization:` + ' '.repeat(1000) + '\n' + secret + '\nfinal useful error\n';
    for (let split = 95; split < 175; split++) {
      let output = '';
      const redactor = createSetupOutputRedactor(text => { output += text; }, { streaming: true, limit: 80 });
      redactor.write(payload.slice(0, split)); redactor.write(payload.slice(split)); redactor.end();
      expect(output).not.toContain(secret.slice(0, 8));
      expect(output).toContain('final useful error');
    }
  });
  it('sanitizes every later line and preserves exact credentials and unicode across chunk boundaries', () => {
    const secret = synthetic();
    let output = '';
    const redactor = createSetupOutputRedactor(text => { output += text; }, { secrets: [secret], streaming: true });
    redactor.write('safe\n'.repeat(15_000));
    redactor.write('😀'.repeat(1023) + '\ud83d');
    redactor.write('\ude00 ' + secret.slice(0, 11));
    redactor.write(secret.slice(11) + '\npassword=' + secret + '\nfinal useful error\n');
    redactor.end(); redactor.write('late callback\n'); redactor.end();
    expect(output).not.toContain(secret.slice(0, 8));
    expect(output).not.toContain('\ufffd');
    expect(output).not.toContain('late callback');
    expect(output).toContain('final useful error');
  });
});
