# Quality Strategy

Use checks proportional to the changed ownership boundary.

- Documentation-only: `node scripts/check-harness.mjs` and `git diff --check`.
- Root composition: validate the relevant Compose configuration and confirm gitlink commits are
  reachable; do not start services merely to validate YAML.
- API changes: run the pinned API submodule's focused tests and contract fixtures.
- Frontend changes: run the pinned frontend submodule's focused lint, type, and test commands.
- Event processor or connector changes: run that service's targeted tests.
- Cross-repository billing changes: add synthetic request, response, webhook, idempotency, and
  reconciliation fixtures before rollout.

The existing repository workflows remain the authority for their respective build surfaces. The
root harness check protects documentation structure; it does not replace domain tests.
