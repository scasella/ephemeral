import type { SetupCommandResult } from '../contracts.js';

export const SETUP_OUTPUT_LIMIT = 64 * 1024;
export const SETUP_CLEANUP_MS = 2_000;

/** This source is executed only inside the VM. Local tests use an isolated fixture. */
export function setupRunnerSource(input: { command: string; cwd: string; deadlineAt: number; controlDirectory: string }): string {
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
const secrets = [...new Set(['EPHEMERAL_GATEWAY_TOKEN', 'E2B_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY']
  .map(key => process.env[key]).filter(value => value && value.length >= 4))];
const keep = Math.max(0, ...secrets.map(value => value.length - 1));
let remaining = ${SETUP_OUTPUT_LIMIT}, truncated = false, child, ending = false;
const redact = text => secrets.reduce((out, value) => out.split(value).join('[redacted]'), text);
const output = text => {
  const bytes = Buffer.from(text);
  const allowance = remaining;
  let dropped = bytes.length > allowance;
  if (remaining > 0) {
    const selected = bytes.subarray(0, remaining);
    remaining -= selected.length;
    if (selected.length && !emit({type:'output', data:selected.toString('base64')})) { remaining = 0; dropped = true; }
  }
  if (dropped && !truncated) {
    truncated = true; emit({type:'output', data:Buffer.from('\\n[Setup output limit reached; further output omitted.]\\n').toString('base64')}, true);
  }
};
// Retain a suffix separately for each stream so a split credential is never emitted.
const streams = [];
const attach = stream => {
  let tail = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    const text = tail + chunk;
    let boundary = Math.max(0, text.length - keep);
    // Do not cut a matched secret across the emission boundary.
    for (const secret of secrets) {
      let start = text.indexOf(secret);
      while (start !== -1) {
        if (start < boundary && start + secret.length > boundary) boundary = start;
        start = text.indexOf(secret, start + 1);
      }
    }
    output(redact(text.slice(0, boundary))); tail = text.slice(boundary);
  });
  streams.push(() => { stream.pause(); output(redact(tail)); tail = ''; });
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
if (cancelled()) finish('cancelled', null);
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
