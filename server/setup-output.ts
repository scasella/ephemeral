/** Self-contained: the VM embeds this exact bounded collector. Input must already be sanitized. */
export function createSetupOutputBuffer(limit = 64 * 1024) {
  const marker = '\n[Setup output limit reached; omitted middle output.]\n';
  const capacity = Math.max(0, Math.floor(limit));
  const markerBytes = Buffer.from(marker).subarray(0, capacity);
  const headLimit = Math.floor((capacity - markerBytes.length) / 2);
  const tailLimit = capacity - markerBytes.length - headLimit;
  let head = Buffer.alloc(0), tail = Buffer.alloc(0), truncated = false, high = '';
  const prefix = (bytes: Buffer, count: number) => {
    let end = Math.min(bytes.length, count);
    if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end);
  };
  const suffix = (bytes: Buffer, count: number) => {
    let start = Math.max(0, bytes.length - count);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    return bytes.subarray(start);
  };
  const accept = (bytes: Buffer) => {
    if (!truncated && head.length + bytes.length <= capacity) { head = Buffer.concat([head, bytes]); return; }
    if (!truncated) {
      truncated = true;
      const combined = Buffer.concat([head, bytes]);
      head = Buffer.from(prefix(combined, headLimit));
      tail = Buffer.from(suffix(combined, tailLimit));
      return;
    }
    tail = bytes.length >= tailLimit ? Buffer.from(suffix(bytes, tailLimit)) :
      Buffer.from(suffix(Buffer.concat([tail, bytes]), tailLimit));
  };
  return {
    write(text: string) {
      // Bound temporary allocations and preserve surrogate pairs split by callbacks.
      for (let offset = 0; offset < text.length; offset += 4096) {
        let part = high + text.slice(offset, offset + 4096); high = '';
        const last = part.charCodeAt(part.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) { high = part.slice(-1); part = part.slice(0, -1); }
        if (part) accept(Buffer.from(part));
      }
    },
    snapshot(): { output: string; truncated: boolean } {
      return { output: (truncated ? Buffer.concat([head, markerBytes, tail]) : head).toString('utf8'), truncated };
    },
  };
}
