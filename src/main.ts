/* Modified from Patch Trompe by the Potemkin contributors; see NOTICE and PROVENANCE.md. */
import './agent';
import '@ui-sdk/core/web.css';
import './ui/style.css';
import { configureFal } from './providers/fal';
import { makeApi } from './api';
import { Session } from './session';
import { mountUi } from './ui/app';

const shell = document.getElementById('studio-shell')!;
const stage = document.getElementById('stage')!;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const headless = new URLSearchParams(location.search).has('headless');
const session = new Session(canvas);
configureFal();

const api = makeApi(session);
(window as unknown as { trompe: typeof api }).trompe = api;

if (headless) {
  document.getElementById('topbar')?.remove();
  document.getElementById('viewport-hud')?.remove();
  shell.replaceChildren(stage);
  shell.classList.add('headless');
} else {
  mountUi(
    session,
    {
      topbar: document.getElementById('topbar')!,
      leftDock: document.getElementById('panel-left')!,
      rightDock: document.getElementById('panel-right')!,
      bottomDock: document.getElementById('panel-bottom')!,
      viewportHud: document.getElementById('viewport-hud')!,
    },
    api,
  );
}

function fit() {
  const w = stage.clientWidth || canvas.clientWidth || window.innerWidth;
  const h = stage.clientHeight || canvas.clientHeight || window.innerHeight;
  session.viewer?.resize(w, h);
}
window.addEventListener('resize', fit);
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => fit()).observe(stage);
}

let lastViewer: unknown = null;
let lastTime = performance.now();
function frame(now: number) {
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  if (session.viewer && session.viewer !== lastViewer) {
    lastViewer = session.viewer;
    fit();
  }
  session.viewer?.tick(dt);
  if (!headless && session.viewer?.dirty) session.viewer.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
