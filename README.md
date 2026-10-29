# pi-pocket-layerfs

An independent Pi Pocket drop-in for browsing [LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs) projects and history, plus one narrowly scoped owner-confirmed internal recovery action.

**Not an official LayerFS or Pi Pocket adapter.** LayerFS's README lists “LayerFS × Pi” as _planned_. This project uses the public LayerFS v1.0.0 SDK and Pi Pocket's public extension API; it does not claim upstream support, an atomic working-directory checkout, or host export.

## What it does

- An owner-only **LayerFS page** on the rail: projects, branches, commits, trees, files, diffs, blame, and bounded per-file history.
- **Read-only Pi tools** (`layerfs_*`) bound to the current task requester and one explicit conversation → project → branch grant.
- **One internal write**: create a real LayerFS Branch with `branch.fork`, after a preview and an owner click. It binds the owner, actual Pocket conversation, project, source branch, source ref, target branch, operation, and expected source head in a short-lived, one-time ticket. A model cannot approve it.
- A **private, owner-started Unix-socket service** that is the only process that loads the native LayerFS SDK.

## What it never does

- No host import, export, output application, merge, delete, publish, or automatic working-directory takeover.
- No model write tool. The only write route is `conversationRoute` + owner click + one-time ticket.
- No download or build at run time, no `npm install`/`npx` from the plugin, no Docker pull, no container start, no FUSE mount of a real workspace.
- No reading Pi Pocket's `config.json`, sessions, tokens, or sign-ins. The plugin reads only its own config and the service token.
- No fallback to a mock when the service is down: the call fails, visibly.
- No LayerFS symlink following; sensitive names (`.git`, `.env`, keys, caches, session stores) are omitted or answered as unavailable.

## Requirements

- Linux with the Store on a local **ext4, xfs, or btrfs** filesystem (btrfs is fine; network/tmpfs is not).
- Node **22.19 or newer** (this project is checked with Node 26.10).
- Rust **1.85 or newer**, Cargo, `cc`, `make`, `tar`, and `curl` for the explicit setup.
- No Docker and no FUSE are needed for the Store calls this plugin uses.
- **LayerFS v1.0.0's `project.init` requires effective uid 0** (the upstream `DAEMON_UID`). This project does not use `sudo`; `init-synthetic --user-namespace` uses an unprivileged Linux user namespace (`unshare -Ur`) for that one install step. If user namespaces are unavailable, initialise as the daemon user. See [docs/INSTALL.md](docs/INSTALL.md).

## Quick start

```bash
# 1. Fetch and verify the pinned official v1.0.0 archive, then build the native addon
#    into this project's .runtime only (project-local cargo home/target/tmp).
npm run setup -- --archive /path/to/verified/layerfs-v1.0.0.tar.gz

# 2. Create one synthetic project and its isolated Store.
#    --user-namespace is for the upstream project.init uid-0 requirement only.
npm run init:synthetic -- --runtime .runtime --user-namespace

# 3. Edit .runtime/config.json: set ownerPersonIds, one sessionGrants entry,
#    and only then tools.enabled / write.enabled.

# 4. Start the private service in its own terminal.
node service/main.mjs --config "$PWD/.runtime/config.json"

# 5. Install the drop-in into an independent target (never ~/.pi-pocket).
npm run install:dropin -- --target /path/to/independent/extensions

# 6. In the independent Pi Pocket copy, turn the module on in Menu → Extensions.
```

The plugin starts **off**. The service is **not** started by the plugin. Tools and internal writes are **off** until both the global switches and an exact session grant say yes.

## Documentation

- [docs/INSTALL.md](docs/INSTALL.md): setup, non-root `project.init`, config, service, install, verification, rollback.
- [docs/CONFIG.md](docs/CONFIG.md): the full config and the fail-closed session grants.
- [docs/SECURITY.md](docs/SECURITY.md): threat model, ticket flow, path/symlink policy, service token, secrets.
- [docs/OPERATIONS.md](docs/OPERATIONS.md): service lifecycle, logs, timeouts, queue, backup, troubleshooting.
- [docs/ROLLBACK.md](docs/ROLLBACK.md): disable, stop, uninstall, keep data.
- [docs/CAPABILITIES.md](docs/CAPABILITIES.md): supported and unsupported operations.
- [docs/UPSTREAM.md](docs/UPSTREAM.md): pinned source evidence, API contract, version differences.
- [docs/TEST-SEAMS.md](docs/TEST-SEAMS.md): stable exports, routes, tools, IPC, config, and test commands.
- [docs/NATIVE-E2E.md](docs/NATIVE-E2E.md): a separate native runtime, init command, fake-service recipe, and install smoke for the test agent.
- [NOTICE](NOTICE): LayerFS MIT attribution. This repository vendors no LayerFS source.

## Status

Version 0.3.0. The owner Configuration view and the filtered import path are new. The read paths and the internal fork path use the real official v1.0.0 native addon and a real btrfs Store in isolated tests. The read paths and the internal `branch.fork` path were exercised against the real official v1.0.0 native addon and a real btrfs Store. Docker/FUSE paths, host import/export, merge/delete, and a real external repository import are deliberately not implemented.

## License

MIT for this project's code. LayerFS is MIT, copyright 2026 Ephemeral-AI. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
