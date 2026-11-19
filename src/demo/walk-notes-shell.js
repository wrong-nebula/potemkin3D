// SPDX-License-Identifier: Apache-2.0
// Lightweight <1 KB bootstrapper for the walkthrough Notes & Provenance overlay;
// loads @pierre/words, @pierre/highlights, and Pele Mermaid only when opened (I or ? or click).

const SHELL_CSS = `
.potemkin-notes-ui {
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  color: #f2f2f2;
}
.potemkin-notes-btn {
  position: fixed;
  right: max(18px, env(safe-area-inset-right));
  bottom: max(18px, env(safe-area-inset-bottom));
  z-index: 25;
  min-height: 44px;
  min-width: 76px;
  padding: 8px 14px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(20, 20, 22, 0.9);
  color: #f2f2f2;
  font: 500 13px/1.2 ui-sans-serif, system-ui, sans-serif;
  cursor: pointer;
}
body:has(.potemkin-menu-trigger) .potemkin-notes-btn {
  right: calc(max(18px, env(safe-area-inset-right)) + 86px);
}
.potemkin-notes-btn:hover {
  background: #242424;
  border-color: rgba(255, 255, 255, 0.38);
}
.potemkin-notes-btn:focus-visible {
  outline: 2px solid #e5e5e5;
  outline-offset: 2px;
}
`;

export function mountWalkNotesShell(opts) {
  const styleEl = document.createElement('style');
  styleEl.textContent = SHELL_CSS;
  document.head.append(styleEl);

  const root = document.createElement('div');
  root.className = 'potemkin-notes-ui';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'potemkin-notes-btn';
  btn.setAttribute('aria-expanded', 'false');
  btn.textContent = 'Notes · I';
  root.append(btn);
  document.body.append(root);

  let loaded = null;
  let loading = null;

  const ensureLoadedAndToggle = async () => {
    if (loaded) {
      loaded.toggle();
      return;
    }
    if (!loading) {
      btn.textContent = 'Loading…';
      loading = import('./walk-notes.js')
        .then((mod) => {
          btn.textContent = 'Notes · I';
          loaded = mod.attachWalkNotesDrawer({ ...opts, root, btn });
          loaded.setOpen(true);
          return loaded;
        })
        .catch(() => {
          btn.textContent = 'Notes · I';
          loading = null;
        });
    }
    await loading;
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    void ensureLoadedAndToggle();
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    if (k === 'i' || e.key === '?') {
      void ensureLoadedAndToggle();
    } else if (k === 'escape' && loaded && !document.pointerLockElement) {
      loaded.setOpen(false);
    }
  });

  return {
    tick() {
      loaded?.tick();
    },
  };
}
