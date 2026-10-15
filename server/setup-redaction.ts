/** Self-contained so the same sanitizer can run inside the VM before transport.
 * It handles retained setup output only; recipes and interactive terminals are separate. */
export function createSetupOutputRedactor(onOutput: (text: string) => void,
  options: { secrets?: string[]; limit?: number; streaming?: boolean } = {}) {
  const limit = options.limit ?? 64 * 1024;
  const secrets = [...new Set(options.secrets ?? [])].filter(value => value.length >= 4 && value.length <= 16 * 1024).map(value => {
    const failure = new Uint32Array(value.length);
    for (let i = 1, matched = 0; i < value.length; i++) {
      while (matched && value[i] !== value[matched]) matched = failure[matched - 1]!;
      if (value[i] === value[matched]) matched++;
      failure[i] = matched;
    }
    return { value, failure };
  });
  const marker = '[REDACTED]';
  let pending = '', pendingBytes = 0, retainedBytes = 0, truncated = false, ended = false, pem = false, awaitingCredential = false;
  let dropping = false, scanPem = false, scanSuffix = '', scanNonempty = false;
  let header: 'begin' | 'end' | null = null, headerLabel = '', headerDashes = 0, scanTail = '';
  let surrogate = '';
  let control: 'text' | 'escape' | 'csi' | 'osc' | 'oscEscape' = 'text';
  const redact = (line: string) => {
    let text = line;
    // Apply every boundary in order: an END followed by another BEGIN on the
    // same line must keep the next line inside the new block. Inspect raw text
    // before exact-secret replacement can alter a boundary or its offsets.
    const enteredPem = pem;
    let firstBegin = -1;
    for (const boundary of line.matchAll(/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)(?:-----)?|-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----/g)) {
      const begin = boundary[0].startsWith('-----BEGIN ');
      if (begin && firstBegin === -1) firstBegin = boundary.index;
      pem = begin;
    }
    // Suppress the whole line when entering inside a block, including any new
    // block after its END. Otherwise retain only the safe prefix before BEGIN.
    if (enteredPem) return line.endsWith('\n') ? '\n' : '';
    if (firstBegin !== -1) text = line.slice(0, firstBegin) + marker + (line.endsWith('\n') ? '\n' : '');
    // Exact VM-known credentials can be printed without a recognizable key/prefix.
    for (const { value: secret, failure } of secrets) {
      text = text.split(secret).join(marker);
      // Mask an incomplete known credential at the end of a line too. Use
      // prefix-function matching to stay linear for long Codex JWT values.
      const ending = text.endsWith('\n') ? '\n' : '';
      const content = ending ? text.slice(0, -1) : text;
      let matched = 0;
      for (let i = 0; i < content.length; i++) {
        const char = content[i];
        while (matched && char !== secret[matched]) matched = failure[matched - 1]!;
        if (char === secret[matched]) matched++;
        if (matched === secret.length) matched = failure[matched - 1]!;
      }
      if (matched >= 4) text = content.slice(0, -matched) + marker + ending;
    }
    if (awaitingCredential && text.trim()) {
      awaitingCredential = false;
      // A folded Authorization value may contain a scheme plus credentials;
      // omit the whole value line rather than guessing its token boundary.
      text = marker + (text.endsWith('\n') ? '\n' : '');
    }
    // JSON permits whitespace/newlines between the key's colon and its value.
    if (/(?:["']?\b[\w.-]*(?:token|password|secret|api[_-]?key|private[_-]?key|auth[_-]?key|authorization|access[_-]?key(?:[_-]?id)?)["']?)\s*[:=]\s*$/i.test(text)) awaitingCredential = true;
    text = text
      .replace(/(?:gh[pousr]_|github_pat_|sk-(?:proj-|svcacct-)?|(?:AKIA|ASIA)[A-Z0-9]{0,16}|(?:xox[baprs]-)|(?:glpat-)|(?:e2b_))[A-Za-z0-9_\-]*/g, marker)
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/=-]*/gi, '$1' + marker)
      .replace(/((?:["']?authorization["']?)\s*[:=]\s*)(?:["']?(?:Bearer|Basic)\s+)?[^\s,"';}\]]+/gi, '$1' + marker)
      // Both quoted JSON keys and shell-style assignments. Quoted values can contain spaces.
      .replace(/((?:["']?\b[\w.-]*(?:token|password|secret|api[_-]?key|private[_-]?key|auth[_-]?key|authorization|access[_-]?key(?:[_-]?id)?)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\\n])*"?|\x27(?:\\.|[^\x27\\\n])*\x27?|[^\s,;}\]]*)/gi,
        (_match, key: string) => key + marker)
      // URI userinfo applies to PostgreSQL, Redis, FTP and other schemes too.
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1' + marker + '@');
    return text;
  };
  const emit = (line: string) => {
    const safe = Buffer.from(redact(line));
    if (options.streaming) { if (safe.length) onOutput(safe.toString('utf8')); return; }
    const room = Math.max(0, limit - retainedBytes);
    const selected = safe.subarray(0, room).toString('utf8').replace(/\ufffd$/, '');
    retainedBytes += Buffer.byteLength(selected);
    if (selected) onOutput(selected);
    if (safe.length > room) truncated = true;
  };
  const resetScan = () => {
    scanPem = pem; scanSuffix = ''; scanNonempty = false;
    header = null; headerLabel = ''; headerDashes = 0; scanTail = '';
  };
  const scan = (text: string) => {
    for (const char of text) {
      if (char !== '\n') {
        if (char.trim()) scanNonempty = true;
        // Collapse whitespace so arbitrarily long spacing before/after a colon
        // cannot evict a credential key from the bounded suffix scanner.
        if (!/\s/.test(char) || !scanSuffix.endsWith(' ')) scanSuffix = (scanSuffix + (/\s/.test(char) ? ' ' : char)).slice(-512);
      }
      if (header) {
        if (/[A-Z0-9 ]/.test(char) && !headerDashes) {
          headerLabel = (headerLabel + char).slice(-32);
          // BEGIN is deliberately accepted without closing dashes, matching
          // normal-line redaction even if further label text follows.
          if (header === 'begin' && /(?:PRIVATE KEY|CERTIFICATE)$/.test(headerLabel)) scanPem = true;
        }
        else if (char === '-') {
          if (++headerDashes === 5) {
            if (/(?:PRIVATE KEY|CERTIFICATE)$/.test(headerLabel)) scanPem = header === 'begin';
            header = null;
          }
        } else {
          if (header === 'begin' && /(?:PRIVATE KEY|CERTIFICATE)$/.test(headerLabel)) scanPem = true;
          header = null;
        }
      }
      scanTail = (scanTail + char).slice(-11);
      if (scanTail.endsWith('-----BEGIN ')) { header = 'begin'; headerLabel = ''; headerDashes = 0; }
      if (scanTail.endsWith('-----END ')) { header = 'end'; headerLabel = ''; headerDashes = 0; }
    }
  };
  const finishLine = (newline: boolean) => {
    if (dropping) {
      pem = scanPem;
      if (header === 'begin' && /(?:PRIVATE KEY|CERTIFICATE)$/.test(headerLabel)) pem = true;
      if (scanNonempty) awaitingCredential = false;
      if (/(?:["']?\b[\w.-]*(?:token|password|secret|api[_-]?key|private[_-]?key|auth[_-]?key|authorization|access[_-]?key(?:[_-]?id)?)["']?)\s*[:=]\s*$/i.test(scanSuffix)) awaitingCredential = true;
      onOutput('[Setup output limit reached; overlong line omitted.]' + (newline ? '\n' : ''));
    } else if (pending) emit(pending);
    pending = ''; pendingBytes = 0; dropping = false; resetScan();
  };
  const accept = (text: string) => {
    for (const part of text.split(/(?<=\n)/)) {
      if ((!options.streaming && truncated) || !part) return;
      if (options.streaming) scan(part);
      if (!dropping) {
        pendingBytes += Buffer.byteLength(part);
        // Never clip raw credentials. Drop an overlong unfinished line as a unit.
        if (pendingBytes > limit) {
          pending = ''; pendingBytes = 0; truncated = true;
          if (!options.streaming) return;
          dropping = true;
        } else pending += part;
      }
      if (part.endsWith('\n')) finishLine(true);
    }
  };
  return {
    get truncated() { return truncated; },
    write(chunk: string) {
      if (ended || (!options.streaming && truncated)) return;
      // Small normalization batches keep temporary allocations bounded even if a
      // provider supplies one enormous chunk. State spans chunk/ANSI boundaries.
      for (let offset = 0; offset < chunk.length && (options.streaming || !truncated); offset += 4096) {
        let clean = '';
        let part = surrogate + chunk.slice(offset, offset + 4096); surrogate = '';
        const last = part.charCodeAt(part.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) { surrogate = part.slice(-1); part = part.slice(0, -1); }
        for (const char of part) {
          if (control === 'osc') { if (char === '\x07' || char === '\x9c') control = 'text'; else if (char === '\x1b') control = 'oscEscape'; continue; }
          if (control === 'oscEscape') { control = char === '\\' ? 'text' : 'osc'; continue; }
          if (control === 'csi') { if (char >= '@' && char <= '~') control = 'text'; continue; }
          if (control === 'escape') { control = char === '[' ? 'csi' : [']', 'P', 'X', '^', '_'].includes(char) ? 'osc' : 'text'; continue; }
          if (char === '\x1b') { control = 'escape'; continue; }
          if (char === '\x9b') { control = 'csi'; continue; }
          if (['\x90', '\x98', '\x9d', '\x9e', '\x9f'].includes(char)) { control = 'osc'; continue; }
          const code = char.charCodeAt(0);
          if (char === '\n' || char === '\t' || (code >= 32 && !(code >= 127 && code <= 159))) clean += char;
        }
        accept(clean);
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (options.streaming) finishLine(false);
      else if (!truncated && pending) emit(pending);
      pending = ''; pendingBytes = 0;
    },
  };
}

export function redactSetupOutput(value: string): string {
  let output = '';
  const redactor = createSetupOutputRedactor(text => { output += text; });
  redactor.write(value); redactor.end();
  return output;
}
