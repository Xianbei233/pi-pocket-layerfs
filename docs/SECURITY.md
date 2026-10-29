# Security model

This page states what the plugin and service guarantee, what they do not, and where the limits are. It is narrower than the upstream LayerFS or Pi Pocket security models.

## Trust boundaries

1. **Pi Pocket process.** The drop-in server module runs with the owner's rights. It reads its own config and the service token. It does not read Pi Pocket's `config.json`, sessions, tokens, or sign-ins.
2. **Private LayerFS service.** A separate process the owner starts. It loads the official native SDK, opens the configured Stores, and exposes a private Unix socket. It does not start Sandboxes, mount Workspaces, or run Docker.
3. **Browser module.** Runs in the owner's tab with the owner's rights. It calls only the module's routes through `pocket.api`; it does not call Pi Pocket's internal API, use `fetch`, or set HTML.
4. **Model.** Receives only read-only tool results, fenced and defanged. It never receives a preview ticket. No tool can create a Branch.

## Installed SDK provenance

`UPSTREAM.json` lives inside the installed SDK, so it can be forged together with the SDK. It is checked for consistency but is **not** a trust root. Setup and the service verify the installation with content hashes:

- **Reviewed pin (`upstream.lock.json`, outside every runtime).** The full content hash of the official `sdk/js` tree (all files except `native/`, which is not imported) and the SHA-256 of reviewed native builds. The pin is a repository file, not something the installer writes.
- **Private receipt (`<runtime>/trust/sdk-receipt.json`, mode 0600, outside the SDK).** Written by setup only after it verified the official source tree against the pin and built the addon, or explicitly by the owner with `setup --runtime DIR --authorize-native <sha256>` after reviewing a build from another toolchain. It binds the SDK content hash and native hash to the pinned repo/tag/commit/version/archive.
- **Every check hashes real file content** (no `lstat`-only trust), refuses links, foreign owners, broader modes, and a receipt or SDK outside `<runtime>/sdk`. Verification never imports or executes the SDK and never downloads, builds, or starts anything. `setup --check` and `service --check` are read-only.
- A synthetic SDK that a test or developer supplies is accepted only when the same private receipt matches its exact content; there is no environment-variable or test-mode bypass. `setup --check` is stricter: the SDK tree itself must equal the official `sdk.treeSha256`; a receipt can vouch for a reviewed native build, never for synthetic or changed SDK content.

If both the content and the native build match the reviewed pin, verification reports `official-pin`. Otherwise a matching receipt is required; without it, setup reuse and the service refuse to start. A previous installation whose native addon was built with a different toolchain can be recorded once with `--authorize-native` after review.

Limit: a receipt is a local trust record. Someone who can already rewrite both the runtime and the receipt is inside the owner's account, like the same-user bearer-token limit below.

## Authentication and authorization

- The browser routes use `access: "owner"`. Non-owner callers get `404`, the same as a missing route. Each handler also checks `user.role === "owner"` and, when `ownerPersonIds` is non-empty, the exact person id.
- The two write routes are `web.conversationRoute`, so the server resolves the **actual** Pocket conversation before the handler. A path or body value is not authority.
- Tools use `host.requesterOf(api.conversationId)`, the person whose message started the current work. A guest who steers a session is not the owner and is refused. A previous owner message does not make a later guest requester the owner.
- A tool also needs an exact `sessionGrants` entry for that conversation, that project, and those branches. There is no global list and no fallback to “all conversations”.
- The service authenticates every request with a 32-byte random token from a 0600 file. A same-UID Unix socket is **not** treated as sufficient authorization. The service re-checks the project, session grant, branch, path, and ref against its own config.
- The service verifies the runtime directory, token, LayerFS home, SDK folder, and Store path. It refuses a symlink in any path component, a wrong owner, or a broader mode. The token is opened with `O_NOFOLLOW`; config and token reads do not use an `lstat`-then-read race.

## Read policy

- **Branches.** A branch must be listed in the project grant (page) or the session grant's `toolBranches` (tools). `main` is not a wildcard; it must be listed.
- **Commit ids.** A `66`-hex Commit id is accepted only if it is reachable from an allowed branch. The service walks that branch's commits newest-first with a bounded scan (20 pages × 128 = 2560). An id outside that reachable history is `NotFound`. This blocks a cross-branch or cross-project commit-id IDOR, at the cost of refusing a very old commit beyond the scan bound.
- **Paths.** Absolute only. No `.`/`..`, backslash, NUL, control characters, oversized segment, or more than 128 segments. The path is normalised before use.
- **Sensitive names.** Any path segment matching `.git` (including a worktree `.git` file), `.env`/`.env.*`, `.ssh`, `.aws`, `.gnupg`, `.npmrc`, `.netrc`, caches, `node_modules`, `secrets`, `credentials`, `id_rsa`/other private-key names, or a `.pem`/`.key`/`.p12`/`.pfx`/SQLite/DB suffix is refused as `NotFound`. Directory listings and diff items omit them silently. The list is not configurable in v1.
- **Symlinks.** A symlink entry is never read, listed, blamed, diffed, or followed. A directory containing a symlink omits it. A symlink as the requested path is `NotFound`. LayerFS stores symlinks as entries; the plugin refuses them at both the plugin and service boundary.
- **Existence.** Sensitive and missing paths share the same `NotFound` code/message. The browser sees a generic message; the service log records only the code, not the path or content.
- **History.** `fileHistory` is a bounded client-side walk: it reads commits and uses the real `fs.diff_files` content comparison, not just inode/size. It reports `scanned`, `truncated`, and an `errors` count. A long history can time out; it does not silently claim a complete result.

## Write policy (the only write)

The only internal write is **create a Branch with `branch.fork`**. There is no forced Commit, no fake commit, no `fs.apply`, no merge, no delete, no publish, no host export, and no working-directory takeover.

1. The owner's page calls `POST .../fork-preview/:source` on a `conversationRoute`. The server binds the actual session.
2. The handler checks the owner role/id, the exact session grant, the project, the source branch, and the new branch prefix.
3. The service validates the source branch is a fork source, reads the exact current source head, and checks the target name.
4. The plugin issues a random 32-byte token. Only its SHA-256 is kept. The record binds owner id, conversation id, project, source branch, source ref, target branch, operation (`branch.fork`), and expected source head. TTL is 30–300 s.
5. The owner presses **Create Branch**. The browser sends only the ticket. The server checks the ticket against the owner id, actual conversation, project, and operation, and consumes it once.
6. The service re-reads the source head. If it differs, `HeadMoved`; nothing is written. If the target exists, `NameTaken`.
7. The service forks the **exact expected node**, not a branch name that another writer could move after the check. The result is a real SDK Branch (`kind: "Forked"`).

A model cannot supply `confirm: true` as approval. No tool returns a ticket. A ticket for another person or conversation does not match and is left in place, so a stolen/guessed token cannot destroy another preview. A used or expired ticket is refused.

## Secrets and outputs

- The service token is never in a tool result, route response, error, notice, event, or log line.
- Tool results are fenced in `<layerfs-data trust="untrusted" ...>` after `host.text.defang`, with a label. They never contain a token, store path, socket path, owner id, or another session id.
- Route errors use `web.error` with a generic message. Unexpected errors are `502` to the browser and a code-only log line server-side.
- The browser renders LayerFS text as text. It never uses `innerHTML`, `dangerouslySetInnerHTML`, `eval`, or `new Function`; ESLint enforces these bans. It does not render file content as Markdown.
- Config errors shown in the page are shortened and do not include a token or a full path.

## Deliberate limits

- The service is not an OS sandbox. It runs with the owner's rights and the native SDK runs in its process. The isolation is process, socket, token, config, and code structure, not a kernel sandbox.
- The service token is a bearer token. If another process with the same user can read the 0600 file, it can call the service. The service refuses broader modes and symlinks, but it cannot protect against a compromised same-user process.
- The Store is the upstream **Disposable** profile: no crash or power-loss durability. Do not use it as the only copy of data you cannot rebuild.
- `project.init` captures the whole source tree, ignored files included. This project only initialises a fixed synthetic tree; it has no general real-repository importer. A future importer needs a reviewed staging step (no symlinks, no sensitive/ignored names, no hardlinks/special files, size/count budgets, TOCTOU checks).
- No Docker, container, Sandbox, Workspace mount, or FUSE path is implemented or tested. Do not infer those capabilities from the upstream SDK.
- No host export, output application, merge, delete, automatic cwd change, or “official Pi” integration.
- The service log is the only audit trail. It records operation, project id, outcome code, and duration, not arguments, content, or tokens.
- The queue is bounded, but there is no per-person rate limiter beyond that; the owner routes are owner-only.
- The `fileHistory` walk is O(commits in the bound) and can be slow. It is bounded rather than indexed.

## Reporting

This is an independent project; report a problem in this project's own issue tracker. Do not report it as a LayerFS or Pi Pocket vulnerability unless the problem is in those upstream projects. Do not open a public issue for a secret leak; tell the owner privately first.

## Release 0.3.0: import boundary

- The source must be an absolute, non-link directory owned by this user, with
  no link in any ancestor. The root, the home folder, the Pocket data folder,
  the plugin folder, the SDK, the LayerFS home, the Store root, the import
  root, `~/.pi/agent`, `~/.pi-pocket`, and credential folders are refused.
- Traversal is descriptor-anchored: each directory is opened with
  `O_DIRECTORY|O_NOFOLLOW`, its `fstat` identity is compared with the observed
  entry, and children are opened through the held descriptor path. Files are
  opened `O_NOFOLLOW`; device, inode, size, mtime, ctime, content hash, and
  owner are checked before and after the read.
- Symlinks are excluded. `.git` (file or folder), ignored files, cache and
  dependency roots, and sensitive names are excluded. Sensitive rules override
  any ignore negation. Hard links, special files, and foreign-owner entries
  are refused.
- Ignore rules use the pinned `ignore` package with selected-tree and nested
  `.gitignore` support. Global Git excludes, `.git/info/exclude`, and worktree
  pointers are not read. No Git process, filter, fsmonitor, or hook runs.
- The filtered stage is the only `project.init` input. The source path is
  never a native argument. One private `unshare -Ur` child receives a bounded
  request file; the SDK path, stage, Store target, and LayerFS home are
  validated against the fixed private layout. The child environment is
  sanitized. Native output is capped at 8 KiB; the hard deadline is 120 s.
- A failed or unknown native outcome leaves the partial Store private and
  unpublished. It is never retried automatically. A publish needs a later
  explicit Save and apply.
- The import ticket binds owner, config revision, source fingerprint, stage
  hash, import id, project, label, branches, and operation. It expires after
  300 s and is single use.
