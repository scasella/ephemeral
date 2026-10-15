import { createApplication } from '../../server/app.js';

/** Synthetic live fixtures serve static files without changing preview fixtures' environment. */
export async function createLiveApplication(...args: Parameters<typeof createApplication>) {
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { return await createApplication(...args); }
  finally {
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
  }
}
