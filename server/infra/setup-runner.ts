import { createSetupOutputBuffer } from '../setup-output.js';
import { createSetupOutputRedactor } from '../setup-redaction.js';
import type { SetupCommandResult } from '../contracts.js';

export const SETUP_OUTPUT_LIMIT = 64 * 1024;
export const SETUP_CLEANUP_MS = 2_000;

/** This source is executed only inside the VM. Local tests use an isolated fixture. */
export function setupRunnerSource(input: { command: string; cwd: string; deadlineAt: number; controlDirectory: string; credentialPath?: string }): string {
  return `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const config = ${JSON.stringify(input)};
let wireBytes = 0;
const emit = (value, reserved = false) => {
  const line = JSON.stringify(value) + '\\n';
  if (!reserved && value.type === 'output' && wireBytes + Buffer.byteLength(line) > 128 * 1024 - 1024) return false;
  wireBytes += Buffer.byteLength(line); process.stdout.write(line); return true;
};
const secrets = ['EPHEMERAL_GATEWAY_TOKEN', 'E2B_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']
  .map(key => process.env[key]).filter(value => value && value.length >= 4);
// Fixed VM path, never the control-plane HOME. No symlink/device reads, bounded
// bytes/depth, and the file must belong to the user running setup.
let credentialsAvailable = true;
try {
  const descriptor = fs.openSync(config.credentialPath || '/home/user/.codex/auth.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 65536) throw new Error('Invalid credential file');
    const bytes = Buffer.alloc(65537);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count > 65536) throw new Error('Invalid credential file');
    const auth = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('Invalid credential file');
    const collect = (value, depth = 0) => {
      if (depth > 8) throw new Error('Invalid credential file');
      if (!value || typeof value !== 'object') return;
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string' && /token|api[_-]?key|auth[_-]?key|secret|password/i.test(key) && entry.length >= 4) {
          if (entry.length > 16384 || secrets.length >= 128) throw new Error('Invalid credential file');
          secrets.push(entry);
        } else if (entry && typeof entry === 'object') collect(entry, depth + 1);
      }
    };
    collect(auth);
  } finally { fs.closeSync(descriptor); }
} catch (error) { if (error.code !== 'ENOENT') credentialsAvailable = false; }
let child, ending = false, completed = false;
const __name = target => target; // esbuild/tsx may annotate serialized function names.
const createSanitizer = (${createSetupOutputRedactor.toString()});
const createOutputBuffer = (${createSetupOutputBuffer.toString()});
const retained = createOutputBuffer(${SETUP_OUTPUT_LIMIT});
const markerBytes = Buffer.byteLength('\\n[Setup output limit reached; omitted middle output.]\\n');
const prefixLimit = Math.floor((${SETUP_OUTPUT_LIMIT} - markerBytes) / 2);
let sent = '';
const send = text => { if (text) { emit({type:'output', data:Buffer.from(text).toString('base64')}, true); sent += text; } };
const sanitizedOutput = text => {
  if (completed) return;
  retained.write(text);
  if (Buffer.byteLength(sent) >= prefixLimit - 4096) return;
  // The fixed prefix stays stable when the bounded collector starts keeping a
  // tail. Batch frames so verbose tiny lines cannot exhaust the wire budget.
  const bytes = Buffer.from(retained.snapshot().output);
  let end = Math.min(bytes.length, prefixLimit);
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const available = bytes.subarray(Buffer.byteLength(sent), end).toString('utf8');
  if ((!sent && available) || Buffer.byteLength(available) >= 4096) send(available);
};
const output = text => { const sanitizer = createSanitizer(sanitizedOutput, {secrets, streaming:true}); sanitizer.write(text); sanitizer.end(); };
// Keep separate pending lines/control state: stderr must never break up a
// credential that stdout is still writing (or vice versa).
const streams = [];
const attach = stream => {
  const sanitizer = createSanitizer(sanitizedOutput, {secrets, streaming:true});
  stream.setEncoding('utf8');
  stream.on('data', chunk => { if (!completed) sanitizer.write(chunk); });
  streams.push(() => {
    // Read buffered data before EOF/cancellation flush, then reject late events.
    let chunk; while ((chunk = stream.read()) !== null) sanitizer.write(chunk);
    stream.pause(); sanitizer.end();
  });
};
const groupAlive = pid => {
  if (process.platform === 'linux') {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\\d+$/.test(entry)) continue;
      try {
        const stat = fs.readFileSync('/proc/' + entry + '/stat', 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) === pid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    }
    return false;
  }
  try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const finish = async (status, exitCode) => {
  if (ending) return; ending = true;
  clearTimeout(timer); clearInterval(cancellation);
  let confirmed = !child || !child.pid;
  if (child && child.pid) {
    try {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      const deadline = Date.now() + 1500;
      do {
        await new Promise(resolve => setTimeout(resolve, 25));
        confirmed = !groupAlive(child.pid);
      } while (!confirmed && Date.now() < deadline);
    } catch { confirmed = false; }
  }
  for (const flush of streams) flush();
  const finalOutput = retained.snapshot().output;
  send(finalOutput.slice(sent.length));
  completed = true;
  emit(confirmed ? {type:'result', status, exitCode} : {type:'uncertain'});
  try { fs.rmSync(config.controlDirectory, {recursive:true, force:true}); } catch {}
  // Explicit exit also bounds streams retained by an escaped descendant.
  process.stdout.write('', () => process.exit(0));
};
fs.mkdirSync(config.controlDirectory, {recursive:true, mode:0o700});
const cancelled = () => fs.existsSync(config.controlDirectory + '/cancel');
const timer = setTimeout(() => finish('timed_out', null), Math.max(0, config.deadlineAt - Date.now()));
const cancellation = setInterval(() => { if (cancelled()) finish('cancelled', null); }, 100);
process.on('SIGTERM', () => finish('cancelled', null));
process.on('SIGINT', () => finish('cancelled', null));
process.stdout.on('error', () => {});
if (!credentialsAvailable) { output('Setup could not safely inspect local credentials.\\n'); finish('failed', null); }
else if (cancelled()) finish('cancelled', null);
else if (config.deadlineAt <= Date.now()) finish('timed_out', null);
else {
  const env = {...process.env, GIT_TERMINAL_PROMPT:'0'};
  delete env.E2B_API_KEY; delete env.OPENAI_API_KEY; delete env.CODEX_API_KEY;
  child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', config.command],
    {cwd:config.cwd, env, detached:true, stdio:['ignore','pipe','pipe']});
  attach(child.stdout); attach(child.stderr);
  child.on('error', () => { output('Unable to start setup command.\\n'); finish('failed', null); });
  child.on('exit', (code, signal) => finish(code === 0 && !signal ? 'succeeded' : 'failed', Number.isInteger(code) ? code : null));
}
`;
}

/** Framing prevents ordinary command output from becoming execution metadata. */
export class SetupOutputDecoder {
  private pending = '';
  private bytes = 0;
  private outputBytes = 0;
  result: SetupCommandResult | null = null;
  constructor(private readonly onOutput: (text: string) => void) {}
  write(chunk: string): void {
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > SETUP_OUTPUT_LIMIT * 3) throw new Error('Invalid setup output.');
    this.pending += chunk;
    while (this.pending.includes('\n')) {
      const boundary = this.pending.indexOf('\n');
      const line = this.pending.slice(0, boundary); this.pending = this.pending.slice(boundary + 1);
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (this.result) throw new Error('Invalid setup completion.');
      if (frame.type === 'output' && typeof frame.data === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) {
        const data = Buffer.from(frame.data, 'base64'); this.outputBytes += data.length;
        if (this.outputBytes > SETUP_OUTPUT_LIMIT + 256) throw new Error('Invalid setup output.');
        this.onOutput(data.toString('utf8'));
      } else if (frame.type === 'result' && ['succeeded', 'failed', 'timed_out', 'cancelled'].includes(String(frame.status)) &&
          (frame.exitCode === null || Number.isInteger(frame.exitCode))) {
        this.result = { status: frame.status as SetupCommandResult['status'], exitCode: frame.exitCode as number | null };
      } else throw new Error('Setup termination could not be confirmed.');
    }
  }
  complete(): SetupCommandResult {
    if (!this.result || this.pending) throw new Error('Setup termination could not be confirmed.');
    return this.result;
  }
}
