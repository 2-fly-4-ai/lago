# Sources of Truth

When sources conflict, stop and reconcile them in the owning repository. Do not choose a stale
document or convenient branch.

| Question | Primary authority |
| --- | --- |
| Which child revisions compose the root? | root gitlinks and `.gitmodules` |
| How does billing-domain behavior work? | the pinned `api/` implementation and tests |
| How does the operator UI behave? | the pinned `front/` implementation and tests |
| How are root services composed? | current Docker/deploy files and root service code |
| What external API/webhook shape is promised? | versioned contract fixtures and owning service tests |
| What is deployed or enabled? | current provider/release evidence obtained with approved access |
| Which secrets or provider accounts apply? | approved secret manager and provider control plane |
| What work is active or complete? | `docs/plans/active/` and `docs/plans/completed/` |

Feature branches, old plans, environment examples, and compose profiles are supporting evidence.
They do not independently authorize billing behavior or prove deployment state.
