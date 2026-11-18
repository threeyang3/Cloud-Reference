# Cloud Reference contributor guide

Read README.md and docs/{DESIGN,SECURITY,VALIDATION}.md before changing behavior.

- Personal desktop tool. Stable promotion requires docs/acceptance.json evidence and `npm run release-check`. Mocks are not live-account or GUI evidence.
- Run `npm run check` (syntax, tests, deterministic bundle, synthetic performance); Node 22+, no npm install needed.
- Keep provider/account/file identities as decimal strings. Paths/names are snapshots; never silently bind a missing ID to a same-name path.
- No startup cloud requests, periodic polling, persistent search index, vault scan, VFS or background server.
- No silent downloads, remote writes, Markdown rewrites, work/media inference or Manjian lookups.
- Credentials are opt-in plaintext Vault files. Never call them encrypted or claim cloud sync is a distributed lock.
- Preserve dispatch-aware refresh, cancellation, bounded queues, single-flight metadata, paired token commits and unknown-result recovery markers.
- OAuth must remain sandboxed with random state and fixed origin checks. Never enable Node/preload for a remote page or weaken host checks for convenience.
- MediaCore owns associations. Do not bypass its whitelist or mutate its private schema.
- Tests and benchmarks must use fictional identifiers and loopback fixtures, never real credentials.
