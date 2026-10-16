/* Runs before styles and React. Keep this external: production CSP allows only same-origin scripts. */
(() => {
  const key = 'ephemeral.appearance';
  const normalize = value => value === 'light' || value === 'dark' ? value : 'system';
  let preference = 'system';
  try { preference = normalize(window.localStorage.getItem(key)); } catch { /* Private browsing may deny storage. */ }
  let media;
  try { media = window.matchMedia('(prefers-color-scheme: dark)'); } catch { /* Light is the fallback. */ }
  const listeners = new Set();
  let snapshot;
  function update() {
    const resolved = preference === 'system' ? (media?.matches ? 'dark' : 'light') : preference;
    const changed = !snapshot || snapshot.preference !== preference || snapshot.resolved !== resolved;
    if (!changed) return;
    snapshot = Object.freeze({ preference, resolved });
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#151719' : '#f8f8f8');
    listeners.forEach(listener => listener());
  }
  const systemChanged = () => update();
  const storageChanged = event => {
    if (event.key !== key && event.key !== null) return;
    // Ignore sessionStorage events, which do not represent this preference.
    try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { /* Storage may be denied. */ }
    preference = normalize(event.key === null ? null : event.newValue);
    update();
  };
  update();
  window.ephemeralAppearance = Object.freeze({
    getSnapshot: () => snapshot,
    setPreference(value) {
      preference = normalize(value);
      try { window.localStorage.setItem(key, preference); } catch { /* Keep this tab usable without persistence. */ }
      update();
    },
    subscribe(listener) {
      if (!listeners.size) {
        media?.addEventListener('change', systemChanged);
        window.addEventListener('storage', storageChanged);
      }
      listeners.add(listener);
      update();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          media?.removeEventListener('change', systemChanged);
          window.removeEventListener('storage', storageChanged);
        }
      };
    },
  });
})();
