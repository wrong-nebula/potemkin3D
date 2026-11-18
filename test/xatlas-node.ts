import { createRequire } from 'node:module';
import { apiRunner, type XatlasApi, type XatlasRunner } from '../src/core/unwrap';

/** xatlas under Node (the xatlasjs Node build), for tests. */
export async function nodeXatlas(): Promise<XatlasRunner> {
  const require = createRequire(import.meta.url);
  const createModule = require('xatlasjs/dist/node/xatlas.js');
  const { Api } = await import('xatlasjs/dist/node/api.mjs' as string);
  const XA = Api(createModule);
  const api = await new Promise<XatlasApi>((resolve) => { const a = new XA(() => resolve(a), null, null); });
  return apiRunner(api);
}
