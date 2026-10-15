# Private React/Vite HMR fixture

Copy these files into a disposable sandbox directory, outside its Git repository. Install the pinned packages with `npm install`, then start explicitly in the supplemental shell:

```sh
cd /tmp/ephemeral-preview-vite
npm run dev
```

The fixture listens only on `127.0.0.1:8756` and refuses to silently choose a different port. Enable port 8756 in Ephemeral, check the application, prepare access, and open its private viewer. Set the counter and type text, then change `VITE_HMR_BEFORE` to `VITE_HMR_AFTER` in `App.jsx`. The heading must update without reloading; the input, counter, and Document ID must remain unchanged. Stop/restart Vite explicitly to check refusal/recovery separately from viewer access. Never copy credentials into the fixture.

The config uses Vite's ordinary WebSocket inference through the viewer. Hosted proxies must carry WebSocket upgrades. If a different deployment requires connection configuration, Vite 8 uses `server.ws`; client-side host/port/protocol must point at the isolated viewer, not a public sandbox port. Keep normal host and WebSocket checks enabled. See [official server options](https://v8.vite.dev/config/server-options).
