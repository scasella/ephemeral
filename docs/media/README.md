# Documentation media

The original workflow-tour assets were captured on 2026-10-16 from the actual Ephemeral UI at application revision `d5e347236885ddb09b135e9bdda156815dbac2cc`. Only documentation and media changed during that capture. See the [illustrated usage guide](../USAGE.md).

All captures use **local simulation** with an isolated embedded database, a clean browser profile and dotenv loading disabled. No E2B, GitHub or OpenAI account credentials were supplied, no real machine was created, and no commands or model requests were executed. Repositories, task names, branch IDs and note text are synthetic. Cleanup outcomes in these images are simulated; remote Codex revocation remains unverified.

| Asset | Shows |
| --- | --- |
| [launch.png](launch.png) | Repository/base-branch selection and the one-hour lifetime |
| [workspace.png](workspace.png) | Selected machine, timer, detail tabs and two shell tabs |
| [terminal-focus.png](terminal-focus.png) | Focus mode, readable controls and current-buffer Find |
| [handoff-notes.png](handoff-notes.png) | Saved revision retained after the simulated machine ends |
| [session-history.png](session-history.png) | Search and status filters with a different machine selected |
| [cleanup.png](cleanup.png) | Independent resource outcomes and explicitly unverified remote revocation |
| [terminal-workflow.gif](terminal-workflow.gif) | Find in focus mode, then switching between Codex and a supplemental shell |
| [notes-workflow.gif](notes-workflow.gif) | Editing, saving and reloading a handoff note |

## Appearance comparisons

The six appearance screenshots below were captured on 2026-10-16 from the dark-mode implementation committed alongside these assets, based on reviewed `main` at `90c4db0290f5ddbbc77b1f7100c59432426f92c1`. They use a fresh isolated simulation, the production-built interface, and a clean Chrome profile without integration credentials. Each pair shows the same task and interface state with only the appearance changed. The synthetic machine was stopped after capture. Terminal text is the app's actual simulation notice, not a model response or executed command.

| Light | Dark | Shows |
| --- | --- | --- |
| [appearance-workspace-light.png](appearance-workspace-light.png) | [appearance-workspace-dark.png](appearance-workspace-dark.png) | Full workspace, appearance selector, machine details and two shell tabs |
| [appearance-terminal-light.png](appearance-terminal-light.png) | [appearance-terminal-dark.png](appearance-terminal-dark.png) | Focused supplemental terminal and readable controls |
| [appearance-launch-light.png](appearance-launch-light.png) | [appearance-launch-dark.png](appearance-launch-dark.png) | Matching repository/base-branch launch dialogs |

Workspace captures use a 1440-pixel-wide full page, terminal captures use a 1440 × 800 viewport, and launch captures show only the actual dialog. These are unaltered browser PNG screenshots. The README displays each pair side by side and links to full-size originals.

The original six workflow-tour PNGs are browser screenshots. History is a screenshot of its panel; the others show a browser viewport. The two looping GIFs are real browser recordings, reduced to 1200 × 833 at four frames per second with a 32-color palette. Their roughly 10–11 second duration includes reading pauses. They are illustrative walkthroughs, not performance measurements. Written steps and static alternatives accompany both GIFs; animation is collapsed by default in the docs.

## Refreshing the captures

1. Use a disposable clean checkout with Node 24. Run `npm ci`, then `npm run local -- --port 4327`. Do not capture an existing live checkout or reuse its private database/configuration. The launcher selects simulation and clears integration credentials.
2. Use a fresh browser profile at the loopback URL. Keep the app's simulation labels visible where practical. Launch only the synthetic repositories supplied by simulation.
3. Give a task an ordinary synthetic name in Settings, open a named second shell, try Find/focus mode, and save an explicit simulation note. Reload to confirm its saved revision. Stop it through the UI and capture Access. Launch a second simulated task to demonstrate filtering without changing the selected machine; end it afterward.
4. Capture PNGs at a readable desktop size (the full workspace captures use 1440 × 1120; terminal focus uses 1440 × 720). Record short, deliberate browser interactions for the GIFs. Preserve actual app text and state; do not fabricate model output, repository inspection or revocation evidence. Keep raw recordings and capture profiles out of Git.
5. Export GIFs with bounded dimensions, frame rate and palette. Decode and visually inspect the stills and animation frames, check the relative Markdown links, and run the repository secret scan. A text scanner cannot establish whether image pixels contain sensitive material; visual review remains necessary.

Do not include account screens, one-time login codes, private paths, service keys, real repository content, tunnel URLs or operational reports. A future live capture needs its own disclosure review before replacing these simulation assets.
