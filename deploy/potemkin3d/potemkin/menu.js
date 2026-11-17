// The scene menu of the Potemkin 3D site, the same on every scene's page: a "Menu" button in the corner and a
// dialog that lists the scenes, in the manner of the Sillage site's. Esc opens and closes it; while it is open the
// keys go to it and not to the scene (a walker's W A S D would otherwise keep walking under it).
const SCENES = [
  { path: '/', label: 'New York loft' },
  { path: '/luxor/', label: 'Luxor temple' },
];
const place = (p) => p.replace(/\/index\.html$/, '').replace(/\/+$/, '') || '/';
const here = place(location.pathname);

const trigger = document.createElement('button');
trigger.className = 'potemkin-menu-trigger';
trigger.type = 'button';
trigger.textContent = 'Menu';
trigger.setAttribute('aria-label', 'Open scene menu');
trigger.setAttribute('aria-haspopup', 'dialog');
trigger.setAttribute('aria-controls', 'potemkin-menu');
trigger.setAttribute('aria-expanded', 'false');

const dialog = document.createElement('dialog');
dialog.id = 'potemkin-menu';
dialog.className = 'potemkin-menu';
dialog.setAttribute('aria-labelledby', 'potemkin-menu-title');
dialog.innerHTML = `<div class="potemkin-menu-content">
  <header class="potemkin-menu-header">
    <h2 id="potemkin-menu-title">Potemkin 3D</h2>
    <button type="button" class="potemkin-menu-close" autofocus aria-label="Close scene menu">Close <kbd>Esc</kbd></button>
  </header>
  <nav aria-label="Scenes">${SCENES.map((s) => `<a href="${s.path}"${place(s.path) === here ? ' aria-current="page"' : ''}>
    <span>${s.label}</span>${place(s.path) === here ? '<span class="potemkin-menu-current">Now viewing</span>' : ''}</a>`).join('')}
  </nav>
  <p class="potemkin-menu-footer">Choose a scene to walk through.</p>
</div>`;
document.body.append(trigger, dialog);

const close = dialog.querySelector('.potemkin-menu-close');
const links = [...dialog.querySelectorAll('nav a')];
// keys a scene may be holding down when the menu opens: it is told they were let go
const HELD = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight']);
const down = new Map();   // code -> key, as the scene saw them go down
let before;

function open() {
  if (dialog.open) return;
  for (const [code, key] of down) window.dispatchEvent(new KeyboardEvent('keyup', { code, key, bubbles: true }));
  down.clear();
  document.exitPointerLock?.();
  before = document.activeElement;
  dialog.showModal();
  close.focus({ preventScroll: true });
  trigger.setAttribute('aria-expanded', 'true');
}
function shut() {
  if (dialog.open) dialog.close();
}
trigger.addEventListener('click', open);
close.addEventListener('click', shut);
dialog.addEventListener('close', () => {
  trigger.setAttribute('aria-expanded', 'false');
  if (before?.isConnected) before.focus({ preventScroll: true });
});
dialog.addEventListener('cancel', (e) => { e.preventDefault(); shut(); });
// a click on the backdrop, outside the list, closes it
dialog.addEventListener('click', (e) => {
  if (e.target !== dialog) return;
  const r = dialog.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) shut();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.repeat) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (dialog.open) shut(); else open();
  } else if (dialog.open) {
    e.stopImmediatePropagation();
    if (e.key === 'Tab') {
      e.preventDefault();
      const stops = [close, ...links];
      stops[(stops.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
      return;
    }
    const at = links.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      links[e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1 : e.key === 'ArrowDown' ? (at + 1) % links.length : (at <= 0 ? links.length : at) - 1].focus();
    }
  } else if (HELD.has(e.code)) down.set(e.code, e.key);
}, true);
window.addEventListener('keyup', (e) => {
  down.delete(e.code);
  if (dialog.open) e.stopImmediatePropagation();
}, true);
window.addEventListener('blur', () => down.clear());
