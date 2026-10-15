/** Each access generation gets its own browser origin and host-only cookie. */
export const PREVIEW_GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function previewBaseOrigin(value: string): URL {
  const base = new URL(value);
  if (base.origin !== value || base.username || base.password || !['https:', 'http:'].includes(base.protocol) ||
    base.hostname.length > 216 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(base.hostname) ||
    base.hostname.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')) ||
    /^\d+(?:\.\d+)*$/.test(base.hostname) ||
    (base.protocol === 'http:' && base.hostname !== 'localhost')) throw new Error('Invalid preview base origin.');
  return base;
}
export function generationViewerOrigin(baseOrigin: string, generation: string): string {
  if (!PREVIEW_GENERATION.test(generation)) throw new Error('Invalid preview generation.');
  const base = previewBaseOrigin(baseOrigin);
  base.hostname = `${generation}.${base.hostname}`;
  return base.origin;
}
export function previewGenerationForHost(baseOrigin: string, host: string | undefined): string {
  const base = previewBaseOrigin(baseOrigin);
  const suffix = `.${base.host}`;
  const generation = host?.endsWith(suffix) ? host.slice(0, -suffix.length) : '';
  if (!PREVIEW_GENERATION.test(generation) || new URL(generationViewerOrigin(baseOrigin, generation)).host !== host) throw new Error('Invalid preview host.');
  return generation;
}
export function previewFormSource(baseOrigin: string): string {
  const base = previewBaseOrigin(baseOrigin);
  return `${base.protocol}//*.${base.host}`;
}
