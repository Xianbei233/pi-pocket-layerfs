# Config

The plugin reads only its own config: `PI_POCKET_LAYERFS_CONFIG` (absolute) or `host.dataDir/pocket-layerfs/config.json`. It never reads Pi Pocket's `config.json`, sessions, owner tokens, or sign-ins.

The config file must be a regular file, owned by the current user, not group- or world-writable, with no symlink in any ancestor. A symlink, a broader mode, or a non-regular file is refused.

## Defaults

- The module starts off; the owner turns it on in Menu → Extensions.
- `tools.enabled` defaults to `false`.
- `write.enabled` defaults to `false`.
- `sessionGrants` defaults to `[]`. An empty list denies every tool and every internal write in every conversation. There is no “all conversations” fallback.
- No project or branch is readable by a tool until an exact session grant names it.

## Shape

```json
{
    "version": 1,
    "ownerPersonIds": ["owner-person-id"],
    "service": {
        "runtimeDir": "/absolute/private/runtime",
        "socketPath": "/absolute/private/runtime/service.sock",
        "tokenFile": "/absolute/private/runtime/service.token",
        "layerfsHome": "/absolute/private/layerfs-home",
        "sdkPath": "/absolute/private/sdk",
        "requestTimeoutMs": 8000,
        "maxResponseBytes": 524288,
        "maxQueue": 16,
        "concurrency": 1,
        "upstreamVersion": "1.0.0",
        "upstreamCommit": "2aaf2552ce21154928b9f9c83582e41a637f5910"
    },
    "tools": { "enabled": false, "maxBytes": 32768 },
    "write": { "enabled": false, "ticketTtlMs": 120000 },
    "projects": [
        {
            "id": "synthetic",
            "label": "Synthetic",
            "storePath": "/absolute/private/store/synthetic/store.sqlite",
            "branches": ["main", "work"]
        }
    ],
    "sessionGrants": [
        {
            "conversationId": "12",
            "project": "synthetic",
            "allowTools": true,
            "toolBranches": ["main", "work"],
            "fork": {
                "enabled": true,
                "sources": ["work"],
                "namePrefix": "recovery-"
            }
        }
    ]
}
```

## `service`

- `runtimeDir`: private directory, mode 0700, owned by the current user, no symlink in any component.
- `socketPath` and `tokenFile`: both must be directly inside `runtimeDir`. The socket is created 0600; the token is 32 random bytes, base64url, mode 0600.
- `layerfsHome`: existing 0700 directory for LayerFS discovery. `project.init` creates the project entry under it.
- `sdkPath`: the installed pinned SDK folder, with `package.json`, `UPSTREAM.json`, `src/index.js`, and `native/layerfs.node`. It must be a real directory owned by the current user, not group/other writable. Setup and the service verify the real file content against `upstream.lock.json` or the private build receipt in `<runtime>/trust/`; `UPSTREAM.json` alone is not trusted.
- `requestTimeoutMs`: 1000..60000, default 8000.
- `maxResponseBytes`: 64 KiB..4 MiB, default 512 KiB.
- `maxQueue`: 1..128, default 16.
- `concurrency`: 1..4, default 1. The service serialises Store calls by default.
- `upstreamVersion` / `upstreamCommit`: optional pins. If present they must equal `upstream.lock.json` and `.runtime/sdk/UPSTREAM.json`.

## `projects`

Each project is an exact LayerFS project name (`1..63`, lowercase letters, digits, `.`, `_`, `-`, starts/ends alphanumeric) and its Store file.

- `branches`: the branches the **owner page** may read. `main` is not implicit: list it if you want it. A branch not in this list is `NotFound` even if it exists in LayerFS.
- `storePath`: absolute, existing regular file (or missing before init), owned by the current user, not group/other writable, no symlink.
- `label`: display only.

## `sessionGrants`

This is the only way a tool or an internal write gets a project and branches. One conversation has at most one grant.

- `conversationId`: the exact Pi Pocket conversation id, as a string. The plugin compares it with the actual `request.conversation.id` (bound route) or `api.conversationId`/`host.requesterOf` (tool). It never accepts a conversation id from a model argument.
- `project`: one configured project. A grant for `alpha` cannot read or write `beta`.
- `allowTools`: default `false`. With `true`, `toolBranches` must be non-empty.
- `toolBranches`: the exact branches tools may read. `main` must be listed explicitly. The model cannot ask for another project or branch.
- `fork.enabled`: default `false`. With `true`, `sources` must be non-empty.
- `fork.sources`: exact branches a fork may start from. `main` must be listed explicitly.
- `fork.namePrefix`: default `recovery-`, 0..30 characters from `a-z0-9._-`. It is a **prefix**, so it may end with `-`; the complete new branch name must still satisfy the SDK grammar and cannot end with `-`.

A grant does **not** form a Cartesian product with the project list. A session granted `alpha/feature` cannot name `beta` or `private` in a tool argument; the service checks the same grant again.

## `tools`

- `enabled`: global switch. `false` means no LayerFS tools are installed.
- `maxBytes`: tool result budget, 4 KiB..256 KiB, default 32 KiB. Results are clipped on a UTF-8 boundary and labelled.

A tool also needs:

1. a non-empty `ownerPersonIds`;
2. `host.requesterOf(api.conversationId)` equal to one of those ids;
3. an exact `sessionGrants` entry with `allowTools: true`;
4. the requested project equal to that grant's project;
5. the requested branch in `toolBranches`.

## `write`

- `enabled`: global switch for the internal `branch.fork` route. `false` means no write route.
- `ticketTtlMs`: 30 s..300 s, default 120 s. A ticket is one-time, bound to the owner, actual conversation, project, source branch, source ref, target branch, operation, and expected source head.

A write also needs an exact session grant with `fork.enabled` and the source branch in `fork.sources`, plus `ownerPersonIds`.

## `ownerPersonIds`

The tools compare the current task requester with this list. The write route compares the signed-in owner's `user.id` with it. An empty list keeps tools and writes denied; the page can still be loaded by the owner role, but no tool or write is possible.

Do not put the owner's token or any secret in this file. The person id is not a secret, but it is still local configuration.

## Config routes

The module reads and changes only this file through owner-only routes. Each route needs the app's signed-in owner and the `X-Pocket` header.

- `GET /api/x/pocket-layerfs/config`: a safe summary: `configured`, `writable`, `hash`, `activeHash`, `reloadRequired`, the switches, project ids, and counts. It never returns a path, a token, a socket, a store path, an owner id, a conversation id, or a config value.
- `PUT /api/x/pocket-layerfs/config`: body `{ "expectedSha256": "<hash>" | null, "candidate": { ... } }`. The server validates the whole candidate, compares the current hash, writes one temporary `0600` file, then renames it. A missing or malformed hash is `400`; a stale hash is `409`.
- `POST /api/x/pocket-layerfs/config/delete`: body `{ "expectedSha256": "<hash>" }`. It removes only this config file after the same checks, and keeps the folder and every other file. A `DELETE` request cannot carry this body in Pi Pocket, so the delete step is a POST.
- `GET /api/x/pocket-layerfs/config/whoami/:source`: a bound conversation route. It returns only the authenticated `personId`, `role`, the actual `conversationId`, and the active and current hashes. Use it to fill `ownerPersonIds` and `sessionGrants`.

Rules:

- Writes are denied while `PI_POCKET_LAYERFS_CONFIG` is set.
- The config file must be `0600`, and its folder `0700`, owned by this user, with no link in any component. A broader or foreign folder is refused, never changed.
- The old file's `ownerPersonIds` gate a change when they are set. The signed-in role must be owner in every case. A candidate with a non-empty `ownerPersonIds` must include the acting owner, so a write cannot lock the owner out.
- Every call is synchronous, so two changes cannot both pass the same expected hash.
- A new config takes effect when the module loads again: turn it off and on, or reload it. No Pocket restart is needed.
- The service reads its own copy at start. Restart the service after a service or policy change.

## Changing the config

- The plugin reads the config when the module loads. Edit it, then reload the module in Pi Pocket (save the module file or turn it off/on).
- The service reads its own copy at startup. Restart the service after changing projects, Store paths, session grants, service paths, or write policy.
- A running service and a reloaded plugin must see the same config. If they do not, the service re-checks its copy and can refuse a request the page thought valid; that is intentional.

## Release 0.3.0: owner Configuration and explicit apply

The fixed own config path (`<dataDir>/pocket-layerfs/config.json`) is the one
authority. The plugin still loads the environment override when it is set, but
management and apply are refused (`403`) then.

- `GET gui/overview` (alias `GET gui/status`) returns the state
  (`active`, `saved-pending`, `service-mismatch`, `service-down`, `unknown`,
  `env-override`, `unconfigured`), the saved/plugin/service hashes, the service
  generation, projects with `origin`, grants, and import limits.
- `GET gui/sessions` uses only `WebRequest.sessions()`.
- `POST gui/validate` and `POST gui/apply` take
  `{ expectedSha256, draft }`. The draft may set project labels and existing
  branches, the read-only tools switch, and explicit conversation grants. The
  server keeps `ownerPersonIds`, the service block, Store paths, `write`, and
  every `fork` setting. Unknown or privileged fields are `400`.
- `POST gui/check` is the only reconciliation path. It may adopt a confirmed
  same-hash service generation after an unknown outcome; it never replays a
  mutation.
- The legacy `PUT config` stays save-pending. Use the GUI apply, or load the
  module again, to activate it.

Apply writes the candidate only when the saved hash still matches. It then
calls the service `config.apply` with the base active hash, the target hash, and
the expected generation. The plugin holder changes only after the service
acknowledges the exact target and the next generation. A definite refusal
restores the previous bytes once. A timeout is `504` unknown, keeps the target
file, writes `.apply-pending.json` privately, and never retries.

`project.origin` is optional: `demo`, `import`, or `owner` (default). The GUI
shows the `演示 / Demo` badge from this metadata, never from a project id.

### Import

`POST gui/import/preview` takes
`{ expectedSha256, projectId, label, sourcePath, branches }` and returns a
ticket, expiry, counts, bounded path lists, the source fingerprint, and the
stage hash. It stages a filtered copy; it does not run `project.init`.
`branches` must be `["main"]`: a new Store has only `main`. Add other branches
with the existing fork routes.

`POST gui/import/confirm` takes `{ ticket, expectedSha256 }`. It rechecks the
config hash, the source fingerprint, and the stage hash, then runs one
`unshare -Ur` child on the stage. A new Store stays unpublished in
`registry.json` until a later explicit apply includes the project.

The preview returns counts and up to 100 included and 100 excluded paths. The
page names the unsupported ignore sources: global Git excludes,
`.git/info/exclude`, and worktree `.git` pointers are not read.
