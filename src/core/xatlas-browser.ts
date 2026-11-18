import { proxy, wrap } from 'comlink';
// xatlasjs's web build is a worker script exposing its `Api` class through comlink
import workerUrl from 'xatlasjs/dist/xatlas.js?url';
import wasmUrl from 'xatlasjs/dist/xatlas.wasm?url';
import { apiRunner, type XatlasApi, type XatlasRunner } from './unwrap';

let runner: XatlasRunner | undefined;

/** xatlas in a worker of its own, started the first time a level is unwrapped (core/unwrap.ts). */
export function browserXatlas(): XatlasRunner {
  runner ??= apiRunner((async () => {
    const Api = wrap<new (onLoad: () => void, locate: () => string, progress: () => void) => XatlasApi & { loaded: boolean }>(new Worker(workerUrl));
    const wasm = new URL(wasmUrl, location.href).href;
    const api = await new Api(proxy(() => {}), proxy(() => wasm), proxy(() => {}));
    for (let i = 0; !(await api.loaded); i++) {
      if (i > 600) throw new Error('xatlas did not load');
      await new Promise((r) => setTimeout(r, 50));
    }
    return api;
  })());
  return runner;
}
