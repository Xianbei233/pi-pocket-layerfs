# Install

This project is independent and starts off. It does not install itself into the live Pi Pocket data folder, does not enable the module, and does not install a shared dependency.

## 1. Requirements

- Linux. The LayerFS Store must be on a local **ext4, xfs, or btrfs** filesystem. A tmpfs or network filesystem is refused by LayerFS with `Unsupported`.
- Node 22.19 or newer.
- Rust 1.85 or newer, Cargo, `cc`, `make`, `tar`, `curl`.
- No Docker and no FUSE for the Store calls used here.
- Optional for `init-synthetic`: an unprivileged Linux user namespace (`unshare -Ur`).

Check the host without changing it:

```bash
node --version
cargo --version
rustc --version
df -T .
unshare -Ur true && echo user-namespace-ok
```

## 2. Fetch the pinned SDK

The archive is the official v1.0.0 commit archive. Its SHA-256 is pinned in `upstream.lock.json`.

```bash
npm run setup -- --archive /path/to/layerfs-v1.0.0.tar.gz
```

Without `--archive`, setup downloads:

`https://codeload.github.com/Ephemeral-AI-Lab/layerfs/tar.gz/2aaf2552ce21154928b9f9c83582e41a637f5910`

If the network needs the local Clash proxy, pass it explicitly:

```bash
npm run setup -- --proxy http://127.0.0.1:7897
```

Setup verifies the archive SHA-256, the full extracted source tree hash, and these pinned file hashes before building:

- `sdk/js/package.json`
- `sdk/js/src/index.js`
- `core/Cargo.lock`

It extracts under `.runtime/src/layerfs-v1.0.0`, builds with:

```bash
cargo build --manifest-path core/Cargo.toml --locked -p layerfs-node --release
```

and keeps Cargo state in the project only:

```text
.runtime/cargo
.runtime/target
.runtime/tmp
```

It copies the SDK to `.runtime/sdk` and writes `.runtime/sdk/UPSTREAM.json` (mode 0600). The marker is not the trust root: setup also verifies the copied JavaScript against the reviewed `upstream.lock.json` content pin, and records a private build receipt at `.runtime/trust/sdk-receipt.json` (mode 0600) that binds the native addon hash to the pin. It never uses `sudo`, Docker, a shared Cargo home, or a systemd unit.

Verify (read-only; hashes real files, never imports the SDK):

```bash
node scripts/setup.mjs --check --runtime .runtime
```

The JSON reports `trust` as `official-pin` when the content and native addon match the reviewed pin. A build from a different toolchain produces a different native hash; after reviewing that build, record it explicitly:

```bash
node scripts/setup.mjs --runtime .runtime --authorize-native <sha256>
```

This is an owner action, not automatic trust. It refuses unless the SDK JavaScript is still the pinned official tree. Without a matching pin or receipt, `--check` and the service refuse the installation.

## 3. Initialise a synthetic project

**Upstream limit:** LayerFS v1.0.0 `project.init` installs the Store as `DAEMON_UID = 0`. A non-root process is refused with:

```text
the Store install runs as user <uid>; it must run as user 0, the daemons' user
```

This project does **not** use `sudo`. Two supported choices:

1. Run the init step as the daemon user (the host's LayerFS daemon user, if one exists).
2. Use an unprivileged Linux user namespace for that one step:

```bash
npm run init:synthetic -- --runtime .runtime --user-namespace
```

`--user-namespace` runs only `project.init` through `unshare -Ur`; the process has effective uid 0 inside the namespace, while the host user is unchanged. The resulting Store is owned by the host user and the normal service opens it. If user namespaces are unavailable, init stops with the exact upstream error.

The script writes a fixed synthetic source tree, captures only that tree, forks `work`, and seeds one real commit with `fs.write`. It refuses to overwrite an existing Store or home entry. It does not import a real repository.

Without `--user-namespace` and without effective uid 0, init refuses before writing a Store and prints the upstream reason.

## 4. Configure

`init:synthetic` writes a disabled config at `.runtime/config.json`. Before the module is on, you can edit that private copy. After the module is on, change the live config only through its owner-only `PUT config` route; do not edit the live file by hand. `GET config/whoami/:source`, with the conversation id as `:source`, returns the authenticated owner id and the actual conversation id for `ownerPersonIds` and `sessionGrants`. See [CONFIG.md](CONFIG.md#config-routes). The file fields are:

- `ownerPersonIds`: the owner's actual Pi Pocket person id.
- `sessionGrants[0].conversationId`: the exact session id.
- `allowTools`, `toolBranches`.
- `fork.enabled`, `fork.sources`, `fork.namePrefix`.
- Optionally `tools.enabled` and `write.enabled`.

See [CONFIG.md](CONFIG.md). The config file must be a regular file, owned by the current user, not group- or world-writable, with no symlink in any path component.

## 5. Start the private service

In its own terminal:

```bash
node service/main.mjs --config "$PWD/.runtime/config.json"
```

The service prints its socket and the pinned upstream version. It creates `service.sock` (0600) and `service.token` (0600) inside `service.runtimeDir` (0700). It does not daemonise, does not install a unit, and does not start Docker.

Check without binding:

```bash
node service/main.mjs --config "$PWD/.runtime/config.json" --check
```

## 6. Install the drop-in to an independent target

```bash
npm run install:dropin -- --target /path/to/independent/dropin
```

The target must be empty or contain this project's previous manifest. The script refuses `~/.pi-pocket` and folders that look like live Pi Pocket data (`pocket.sqlite`, `sessions`, `themes`). It copies:

```text
pocket-layerfs.ts
pocket-layerfs/
```

and writes `.layerfs-install.json` with SHA-256 hashes. It does not copy a config, a token, a Store, or the service, and it does not enable the module.

In the independent Pi Pocket copy, open **Menu → Extensions**, read the whole module, and turn it on. The page appears on the rail. The browser module is owner-only.

## 7. Verify

```bash
npm run check
npm run lint
npm run format:check
npm test
```

Current independent tests are in `test/` and are owned by the test agent. `npm test` runs every `test/**/*.test.{ts,mjs,js}` file.

A real Store check used for this project:

```bash
node service/main.mjs --config "$PWD/.runtime/config.json" --check
# then call a route through Pi Pocket, or use the page
```

The read-only IPC operations were exercised against the real native addon: `ping`, `branches`, `tree`, `read`, `commits`, `diff`, `blame`, `file-history`, `fork.plan`, `fork.commit`.

## 8. Uninstall

```bash
npm run uninstall:dropin -- --target /path/to/independent/dropin
```

It removes only files whose hashes match the manifest. It does not remove the Store, config, token, service, or Pi Pocket data. See [ROLLBACK.md](ROLLBACK.md).
