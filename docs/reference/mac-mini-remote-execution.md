# Mac mini remote execution

The `/Volumes/brianfarley/Desktop/Githhub-project` workspace on the MacBook is an SMB view of the
Mac mini. Run Lago tests, inventory generation, TypeScript checks, Worker builds, and Wrangler deploys
on the mini's local SSD through `ssh macmini`. Running those commands from the MacBook against SMB is
dominated by small-file metadata latency and can take orders of magnitude longer.

## Path mapping

```text
MacBook: /Volumes/brianfarley/Desktop/Githhub-project/tmp/lago-cloudflare-native
Mac mini: /Users/brianfarley/Desktop/Githhub-project/tmp/lago-cloudflare-native
```

## Worktree portability

The root `.git` pointer must stay relative:

```text
gitdir: ../../lago/.git/worktrees/lago-cloudflare-native
```

The matching `lago/.git/worktrees/lago-cloudflare-native/gitdir` back-pointer must also stay relative:

```text
../../../../tmp/lago-cloudflare-native/.git
```

These relative paths allow normal Git commands to work from both machines. Do not replace them with
absolute `/Volumes/...` or `/Users/...` paths. The `api` and `front` submodule pointers are already
relative and should remain that way.

## Preflight and check

```sh
ssh -o BatchMode=yes macmini '
  set -e
  export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
  cd /Users/brianfarley/Desktop/Githhub-project/tmp/lago-cloudflare-native
  git branch --show-current
  git status --short
  cd cloudflare
  pnpm check
'
```

## Staging deploy

```sh
ssh -o BatchMode=yes macmini '
  set -e
  export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
  cd /Users/brianfarley/Desktop/Githhub-project/tmp/lago-cloudflare-native/cloudflare
  CI=true \
    CLOUDFLARE_ACCOUNT_ID=cec5f04e1d18bcc65f2be0aefb04f059 \
    pnpm wrangler deploy --keep-vars
'
```

Use the appropriate checked-in Wrangler config for operator or portal deployments. Production
approval and data-safety requirements are unchanged; this runbook only changes the execution host.

If a command is unexpectedly slow, verify that no process is running from `/Volumes/brianfarley` and
that non-interactive SSH includes `/opt/homebrew/bin` in `PATH`.
