import type { RequestHandler, Router } from 'express';
import type { WorkTracker } from './shutdown.js';

/** Use public route registration so Express retains its own rejection handling. */
export function trackedRoutes(router: Pick<Router, 'get' | 'post' | 'put'>, work: WorkTracker) {
  const handler = (operation: RequestHandler): RequestHandler => (req, res, next) => {
    const result = operation(req, res, next);
    return result && typeof (result as Promise<unknown>).then === 'function'
      ? work.track(Promise.resolve(result)) : result;
  };
  return {
    get(path: string, operation: RequestHandler) { router.get(path, handler(operation)); },
    put(path: string, operation: RequestHandler) { router.put(path, handler(operation)); },
    post(path: string, operation: RequestHandler) { router.post(path, handler(operation)); },
  };
}
