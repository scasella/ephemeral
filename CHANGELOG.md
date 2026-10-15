# Changelog

## Unreleased — initial pilot publication candidate

Publication and project licensing are pending. No GitHub release, npm package, or hosted deployment is represented by this entry.

- Publication privacy: fresh noreply-attributed history, private evidence retained outside the public tree, synthetic examples, explicit disposable smoke-fixture selection, and no editor snapshot refs.
- Hosting preparation: Sites compatibility assessment, host-specific acceptance procedure and explicit retention/support drafts with contact setup pending.

- Disposable E2B coding sessions with GitHub account allowlisting, branch-scoped Git gateway access, fresh Codex device sign-in, bounded lifetimes, and independently tracked cleanup outcomes.
- Persistent terminal context and a supplemental shell; searchable session history; keyboard navigation, focus mode, readable controls, and expiry reminders.
- Explicit reusable setup recipes, pushed-change review, draft PR handoff, saved-work continuation, and revisioned next-session notes.
- Private application previews with readiness diagnostics, proven local React/Vite HMR, and a four-step startup/access sequence.
- Release hardening: a different browser origin for every preview generation; host-bound handoffs and grants; required reviewed head/base commit IDs before PR creation; fail-closed local database locks; PostgreSQL passwords passed separately from Compose connection URLs.
- Publication scaffolding: tests/build/dependency/secret/container CI jobs, pinned actions and Node image, contributor guidance, issue templates, and a security policy that records pending private reporting.
- Repeatable Docker smoke suite for production assets/authentication, privilege drop, mounted-disk persistence, PostgreSQL locking, restart and shutdown; verified locally on arm64 and emulated amd64.

### Compatibility notes

Private Preview now needs a base DNS origin and wildcard host routing. Existing fixed-host/IP viewer configuration must change before restarting with this candidate. Existing viewer tabs must be reopened. Local stale database locks require explicit operator inspection instead of automatic deletion. See [migration and release procedure](docs/RELEASE.md).
