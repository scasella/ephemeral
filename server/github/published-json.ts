/** A strict streaming JSON projection for GitHub's published review reads.
 * Every token is validated, including discarded fields. No response or oversized
 * patch is buffered in full; only bounded strings and projected fields live.
 */
export const PUBLISHED_MAX_METADATA_BYTES = 2 * 1024 * 1024;
export const PUBLISHED_MAX_WIRE_BYTES = 32 * 1024 * 1024;
export const PUBLISHED_MAX_PATCH_BYTES = 65_536;
export const PUBLISHED_MAX_FILES = 200;
export const PUBLISHED_MAX_REMOTE_FILES = 300;
export const OVERSIZED_PUBLISHED_PATCH = Symbol('oversized published patch');
export class PublishedJsonLimit extends Error {
  constructor(public readonly budget: 'metadata' | 'wire' | 'structure') { super('Published JSON limit exceeded'); }
}
export interface PublishedJsonBudget { metadata: number; wire: number }
export type PublishedJsonKind = 'repository' | 'ref' | 'comparison';
type Role = PublishedJsonKind | 'refObject' | 'sha' | 'files' | 'file' | 'patch' | 'value' | 'discard';
type Frame = { role: Role; array: boolean; value: Record<string, unknown> | unknown[] | undefined;
  state: 'keyOrEnd' | 'key' | 'colon' | 'valueOrEnd' | 'value' | 'commaOrEnd';
  key: string; keys: Set<string>; count: number; index: number };
const MAX_DEPTH = 32, MAX_KEYS = 256, MAX_ITEMS = 2_000, MAX_TOKENS = 100_000;
const MAX_STRING_BYTES = 65_536, MAX_KEY_BYTES = 256;

export class PublishedJsonProjection {
  private readonly stack: Frame[] = [];
  private root: unknown;
  private done = false;
  private tokens = 0;
  private token: 'string' | 'number' | 'literal' | null = null;
  private text = '';
  private bytes = 0;
  private isKey = false;
  private role: Role = 'discard';
  private escape: 'none' | 'slash' | 'unicode' = 'none';
  private hex = '';
  private high = 0;
  private oversized = false;
  private selectedSeen = false;
  private retainString = false;

  constructor(private readonly kind: PublishedJsonKind, private readonly budget: PublishedJsonBudget,
    private readonly selectedPath?: string) {}

  private charge(bytes: number) {
    // Unknown metadata consumes the same shared budget as retained metadata.
    this.budget.metadata -= bytes;
    if (this.budget.metadata < 0) throw new PublishedJsonLimit('metadata');
  }
  private tick() {
    if (++this.tokens > MAX_TOKENS) throw new PublishedJsonLimit('structure');
    this.charge(16);
  }
  private valueRole(): Role {
    const parent = this.stack.at(-1);
    if (!parent) return this.kind;
    if (parent.array) return parent.role === 'files' ? 'file' : 'discard';
    const key = parent.key;
    switch (parent.role) {
      case 'repository': return ['id', 'full_name'].includes(key) ? 'value' : 'discard';
      case 'ref': return key === 'ref' ? 'value' : key === 'object' ? 'refObject' : 'discard';
      case 'refObject': return ['type', 'sha'].includes(key) ? 'value' : 'discard';
      case 'sha': return key === 'sha' ? 'value' : 'discard';
      case 'comparison':
        if (['status', 'ahead_by', 'behind_by'].includes(key)) return 'value';
        if (['base_commit', 'merge_base_commit'].includes(key)) return 'sha';
        return key === 'files' ? 'files' : 'discard';
      case 'file':
        if (key === 'patch') return 'patch';
        return ['filename', 'previous_filename', 'status', 'additions', 'deletions', 'changes'].includes(key) ? 'value' : 'discard';
      default: return 'discard';
    }
  }
  private complete(value: unknown, role: Role) {
    const parent = this.stack.at(-1);
    if (!parent) { this.root = value; this.done = true; return; }
    if (parent.array) {
      if (role !== 'discard') (parent.value as unknown[]).push(value);
      parent.index++;
    } else if (role !== 'discard') (parent.value as Record<string, unknown>)[parent.key] = value;
    parent.state = 'commaOrEnd';
  }
  private close() {
    const frame = this.stack.pop()!;
    if (frame.role === 'file' && frame.value && !frame.array) {
      const file = frame.value as Record<string, unknown>;
      // Patch can precede filename, so retain at most one bounded candidate
      // until its file closes, then discard it unless it was requested.
      if (this.selectedPath !== undefined && file.filename === this.selectedPath) {
        if (this.selectedSeen) throw new Error('Duplicate selected file');
        this.selectedSeen = true;
      }
      if (this.selectedPath === undefined || file.filename !== this.selectedPath || (this.stack.at(-1)?.index ?? 0) >= PUBLISHED_MAX_FILES) delete file.patch;
    }
    this.complete(frame.value, frame.role);
  }
  private stringUnit(unit: number) {
    if (this.high) {
      if (unit < 0xdc00 || unit > 0xdfff) throw new Error('Invalid JSON surrogate');
      const pair = String.fromCharCode(this.high, unit);
      this.high = 0; this.stringScalar(pair, 4); return;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) { this.high = unit; return; }
    if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error('Invalid JSON surrogate');
    this.stringScalar(String.fromCharCode(unit), unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3);
  }
  private stringScalar(value: string, bytes: number) {
    this.bytes += bytes;
    const patch = !this.isKey && this.role === 'patch';
    if (!patch) this.charge(bytes);
    const limit = this.isKey ? MAX_KEY_BYTES : patch ? PUBLISHED_MAX_PATCH_BYTES : MAX_STRING_BYTES;
    if (this.bytes > limit) {
      if (!patch) throw new PublishedJsonLimit('structure');
      this.oversized = true; this.text = ''; return;
    }
    // Discard unknown values from the beginning. Keys must still be decoded to
    // detect ambiguity, including differently escaped spellings of one key.
    if (this.retainString) this.text += value;
  }
  private finishString() {
    if (this.high) throw new Error('Invalid JSON surrogate');
    this.token = null;
    if (this.isKey) {
      const frame = this.stack.at(-1)!;
      if (frame.keys.has(this.text)) throw new Error('Duplicate JSON key');
      if (frame.keys.size >= MAX_KEYS) throw new PublishedJsonLimit('structure');
      frame.keys.add(this.text); frame.key = this.text; frame.state = 'colon';
    } else this.complete(this.oversized ? OVERSIZED_PUBLISHED_PATCH : this.text, this.role);
    this.text = '';
  }
  private finishAtom() {
    let value: unknown;
    if (this.token === 'number') {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(this.text)) throw new Error('Invalid JSON number');
      value = Number(this.text);
    } else {
      if (!['true', 'false', 'null'].includes(this.text)) throw new Error('Invalid JSON literal');
      value = this.text === 'null' ? null : this.text === 'true';
    }
    this.charge(this.text.length); this.token = null; this.text = ''; this.complete(value, this.role);
  }
  write(input: string) {
    for (let i = 0; i < input.length; i++) {
      const char = input[i], unit = input.charCodeAt(i);
      if (this.token === 'string') {
        if (this.escape === 'unicode') {
          if (!/[\da-fA-F]/.test(char)) throw new Error('Invalid JSON escape');
          this.hex += char;
          if (this.hex.length === 4) { this.stringUnit(parseInt(this.hex, 16)); this.hex = ''; this.escape = 'none'; }
        } else if (this.escape === 'slash') {
          if (char === 'u') { this.escape = 'unicode'; continue; }
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (!Object.hasOwn(escapes, char)) throw new Error('Invalid JSON escape');
          this.stringUnit(escapes[char].charCodeAt(0)); this.escape = 'none';
        } else if (char === '"') this.finishString();
        else if (char === '\\') this.escape = 'slash';
        else { if (unit < 0x20) throw new Error('Invalid JSON control'); this.stringUnit(unit); }
        continue;
      }
      if (this.token) {
        if (/[\s,}\]]/.test(char)) { this.finishAtom(); i--; continue; }
        if (this.text.length >= 64) throw new PublishedJsonLimit('structure');
        this.text += char; continue;
      }
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') continue;
      if (this.done) throw new Error('Trailing JSON content');
      const frame = this.stack.at(-1);
      if (frame?.state === 'colon') {
        if (char !== ':') throw new Error('Invalid JSON colon'); frame.state = 'value'; continue;
      }
      if (frame?.state === 'commaOrEnd') {
        if (char === (frame.array ? ']' : '}')) { this.close(); continue; }
        if (char !== ',') throw new Error('Invalid JSON separator');
        frame.state = frame.array ? 'value' : 'key'; continue;
      }
      if (frame && (frame.state === 'keyOrEnd' || frame.state === 'key')) {
        if (char === '}' && frame.state === 'keyOrEnd') { this.close(); continue; }
        if (char !== '"') throw new Error('Invalid JSON key');
        this.tick(); this.startString(true, 'value'); continue;
      }
      if (frame?.state === 'valueOrEnd' && char === ']') { this.close(); continue; }
      if (frame?.array) {
        const limit = frame.role === 'files' ? PUBLISHED_MAX_REMOTE_FILES : MAX_ITEMS;
        if (++frame.count > limit) throw new PublishedJsonLimit('structure');
      }
      this.tick(); const role = this.valueRole();
      if (char === '{' || char === '[') {
        if (this.stack.length >= MAX_DEPTH) throw new PublishedJsonLimit('structure');
        this.charge(32);
        const array = char === '[';
        this.stack.push({ role, array, value: role === 'discard' ? undefined : array ? [] : Object.create(null),
          state: array ? 'valueOrEnd' : 'keyOrEnd', key: '', keys: new Set(), count: 0, index: 0 });
      } else if (char === '"') this.startString(false, role);
      else if (char === '-' || /\d/.test(char)) { this.token = 'number'; this.role = role; this.text = char; }
      else if (char === 't' || char === 'f' || char === 'n') { this.token = 'literal'; this.role = role; this.text = char; }
      else throw new Error('Invalid JSON value');
    }
  }
  private startString(key: boolean, role: Role) {
    this.token = 'string'; this.text = ''; this.bytes = 0; this.isKey = key;
    this.role = role; this.escape = 'none'; this.hex = ''; this.high = 0; this.oversized = false;
    const file = this.stack.at(-1)?.value as Record<string, unknown> | undefined;
    this.retainString = key || (role !== 'discard' && (role !== 'patch' ||
      (this.selectedPath !== undefined && (file?.filename === undefined || file.filename === this.selectedPath))));
  }
  finish(): unknown {
    if (this.token && this.token !== 'string') this.finishAtom();
    if (this.token || this.stack.length || !this.done) throw new Error('Incomplete JSON');
    return this.root;
  }
}
