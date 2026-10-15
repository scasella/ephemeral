# Local private Preview E2E

From the repository root, with its existing dependencies installed and Node 24+ plus `openssl` available:

```sh
node scripts/local-preview-e2e.mjs --check
npm run build
node scripts/local-preview-e2e.mjs --browser
```

The check starts a disposable React/Vite application, the production generated preview gateway, the real control plane and DB-backed browser authentication, and the production isolated viewer. It verifies refused-before-start diagnostics, exact credential-free `HEAD /`, assets, a real Vite HMR update through both gateway and viewer, immediate close denial and lifecycle-end denial. The normal test suite runs this bounded check and skips the interactive hold.

Browser mode requires a current `npm run build` result. It serves a temporary snapshot of that production frontend, denies source routes, runs the same check, resets to a fresh session with Vite stopped and preview disabled, then prints a loopback controls URL and synthetic sign-in URL. All listener ports are allocated locally. The workspace uses `127.0.0.1`; each viewer generation uses its own `<uuid>.localhost` hostname and host-only cookie. Chromium resolves `.localhost` locally; no DNS or browser configuration changes are needed. The browser viewer is HTTP; a generated certificate is trusted only by the local upstream transport.

1. Open controls and choose **start**. This explicitly starts the actual Vite server on the displayed port; enabling preview never starts it.
2. Open **synthetic sign-in** and enable the displayed application port in the Preview panel. Check the application, prepare access, and use Ephemeral's native Open action.
3. In the viewer, increment the counter, type text, and record the Document ID. Choose **edit** in controls. The heading must become `VITE_HMR_AFTER`, the connection proof must say an update was applied, and the counter, text and Document ID must remain unchanged. The automated check proves HMR transport; these browser observations establish React state preservation.
4. Close preview in Ephemeral. Reloading the old viewer must be denied. Enable and open again, then stop the machine using Ephemeral's lifecycle control. Reloading that viewer must also be denied.
5. **stop** stops only Vite, **restore** restores its heading, and **reset** stops Vite and creates a fresh disabled synthetic session. Reopen synthetic sign-in after reset. **quit**, Ctrl-C, or the fifteen-minute deadline cleans up the temporary DB, copied fixture, certificate and listeners.

For release isolation verification, retain an already loaded viewer document. Choose **replace-preview**, refresh access in Ephemeral, and prepare/open a new viewer. Its generation hostname must differ. The old document's **Check retained page access** button must report HTTP 401 and must not reach the current application. Repeat with **reset**, explicit server start, a fresh machine sign-in/port selection, and another new opening. The old page can keep executing its already loaded code; it must never inherit the later viewer's cookie or application access.

For unavailable-state UI checks, **metadata-failure** toggles a synthetic 503 for preview metadata, **missing-viewer** toggles the test configuration's viewer availability, and **delay-shells** toggles a ten-second shell-metadata delay. Reload the workspace after choosing one. The **end-session** control persists an ended lifecycle state. Reset clears these cases. Supplemental shell creation and terminal navigation use the existing synthetic provider; commands in that terminal remain simulated. Start the actual Vite server with the fixed local **start** control.

No dependency installation, account sign-in, E2B resources, GitHub mutations, external calls, `.env` reads, or production authentication bypass are involved. The launcher passes a minimal environment to its test process. Only test-local provider/GitHub adapters are synthetic: the existing browser-session cookie reader, preview APIs, readiness implementation, token handoff, authorization fences, gateway and viewer execute their production code. The synthetic provider maps its canonical readiness origin to the exact local TLS ingress; every other external fetch is rejected. `/auth` and `/gateway` are blocked in this harness. Local controls execute only fixed start/stop/edit/reset operations and are never installed in the production server.
