# Test seams and stable contract

This page is for the independent test agent and for anyone writing a faithful fake. Tests are in `test/`, owned by the test agent; this project does not write or change them.

## Commands

```bash
npm run check          # tsc --noEmit
npm run lint           # ESLint, including HTML/eval/child-process bans
npm run format:check   # Prettier --check
npm test               # node --test test/**/*.test.{ts,mjs,js}
```

`check` uses the fixed `tsc` from the sibling Pi Pocket checkout (or `PI_POCKET_PRODUCTION`). It creates a read-only `node_modules` symlink to that checkout when needed; it never writes to Pi Pocket.

## Server module

`src/pocket-layerfs.ts`

```ts
export const pocketApi = 1;
export default function createLayerfs(host, web): Extension;
```

- On load, reads `PI_POCKET_LAYERFS_CONFIG` or `host.dataDir/pocket-layerfs/config.json`.
- If the config is missing/invalid: registers `GET status` returning `configured: false`, registers `web.client("pocket-layerfs", { access: "owner" })`, and returns a no-tool extension.
- If valid: registers the read routes, the bound routes, the browser module, and (only if `tools.enabled`) tools.
- `web.onDispose` closes the plugin's sockets and clears tickets; it never stops the service.

## Browser module

`src/pocket-layerfs/index.js` (folder entry; `web.client("pocket-layerfs")`).

- `pocketApi = 1`.
- Adds rail/menu/launcher, page id `layerfs`, style `styles.css`.
- The page calls only `pocket.api`; no `fetch`, `innerHTML`, `eval`, or `new Function`.
- Renders file, commit, blame, diff, and history content as text.

## Tools

Exact names (all read-only, `replay: "safe"`, `readOnlyHint: true`):

| Tool                   | Parameters                                                            |
| ---------------------- | --------------------------------------------------------------------- |
| `layerfs_status`       | —                                                                     |
| `layerfs_branches`     | `project`                                                             |
| `layerfs_commits`      | `project`, `branch`, `pageSize?`, `pagePos?`                          |
| `layerfs_commit`       | `project`, `commit`                                                   |
| `layerfs_tree`         | `project`, `ref`, `path?`, `pageSize?`, `pagePos?`                    |
| `layerfs_read`         | `project`, `ref`, `path`, `startLine?`, `endLine?`                    |
| `layerfs_diff`         | `project`, `from`, `to`, `pageSize?`, `pagePos?`, `cursor?`, `hunks?` |
| `layerfs_blame`        | `project`, `ref`, `path`, `fromLine?`                                 |
| `layerfs_file_history` | `project`, `branch`, `path`, `maxCommits?`                            |

Authorization: `toolContext({ config, host, conversationId })` →
`host.requesterOf(conversationId)` in `ownerPersonIds`; exact `sessionGrants` entry with `allowTools`; project must equal the grant's project; branch in `toolBranches`. No tool accepts a conversation or project id as authority.

Results: `toolResult(host, body, meta, maxBytes)` → `<layerfs-data trust="untrusted" ...>` with `host.text.defang`. Never a ticket, token, store path, owner id, or other session id.

## Routes

All ordinary routes are `access: "owner"`; each handler also checks `user.role`/owner id.

| Method | Path                                                           | Purpose                                                                                   |
| ------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `status`                                                       | service/config status; safe subset                                                        |
| GET    | `projects`                                                     | projects/branches for the page                                                            |
| GET    | `projects/:project/branches`                                   | branches with heads                                                                       |
| GET    | `projects/:project/commits?branch&pageSize&pagePos`            | commits                                                                                   |
| GET    | `projects/:project/commit?commit`                              | one commit                                                                                |
| GET    | `projects/:project/tree?ref&path&pageSize&pagePos`             | directory page                                                                            |
| GET    | `projects/:project/stat?ref&path`                              | stat                                                                                      |
| GET    | `projects/:project/read?ref&path&startLine&endLine`            | file window                                                                               |
| GET    | `projects/:project/diff?from&to&pageSize&pagePos&cursor&hunks` | diff                                                                                      |
| GET    | `projects/:project/blame?ref&path&fromLine`                    | blame                                                                                     |
| GET    | `projects/:project/file-history?branch&path&maxCommits`        | bounded history                                                                           |
| GET    | `session/:source/status`                                       | **conversationRoute**, `{conversation:"source"}`; returns that exact session's safe grant |
| POST   | `projects/:project/fork-preview/:source`                       | **conversationRoute**; owner preview + ticket                                             |
| POST   | `projects/:project/fork-execute/:source`                       | **conversationRoute**; owner click + ticket                                               |

`POST` bodies:

```json
{ "sourceBranch": "work", "fromRef": "work", "newBranch": "recovery-1" }
{ "ticket": "<opaque 43-char token>" }
```

`fork-preview` returns `{ ticket, expiresAt, preview }`. The ticket is never rendered. `fork-execute` returns `{ ok, operation, project, branch, head, base }`.

Errors use `web.error(status, safeMessage(code))`; non-owners get `404`; sensitive and missing paths both map to `NotFound`.

## Config

See [CONFIG.md](CONFIG.md). The stable shape is:

```text
version, ownerPersonIds,
service { runtimeDir, socketPath, tokenFile, layerfsHome, sdkPath, requestTimeoutMs,
          maxResponseBytes, maxQueue, concurrency, upstreamVersion?, upstreamCommit? },
tools { enabled, maxBytes },
write { enabled, ticketTtlMs },
projects [{ id, label, storePath, branches }],
sessionGrants [{ conversationId, project, allowTools, toolBranches,
                 fork { enabled, sources, namePrefix } }]
```

Key invariants:

- `sessionGrants: []` denies all tools/writes. There is no `allowedConversationIds` fallback.
- One grant per conversation; one project per grant.
- `main` is never implicit in `refKind`/branch checks.
- `fork.namePrefix` may end in `-`; the complete new branch must be a valid history name and start with the prefix.

## IPC

One request per Unix-socket connection.

Request (one JSON line, max 64 KiB):

```json
{
    "v": 1,
    "id": "hex",
    "token": "<43-char>",
    "op": "tree",
    "args": {
        "project": "synthetic",
        "ref": "work",
        "path": "/",
        "pageSize": 50,
        "pagePos": 0,
        "scope": "ui"
    }
}
```

Response (one JSON line):

```json
{ "id": "hex", "ok": true, "result": {} }
{ "id": "hex", "ok": false, "error": { "code": "NotFound" } }
```

Operations: `ping`, `branches`, `commits`, `commit`, `tree`, `read`, `stat`, `diff`, `blame`, `file-history`, `fork.plan`, `fork.commit`.

- `scope: "ui"` uses the project's `branches`.
- `scope: "tool"` requires `conversationId` and the exact grant's `toolBranches`.
- `fork.*` require `conversationId` and the exact grant's fork source.

Client exports: `ServiceClient`, `readServiceToken`, `MAX_REQUEST_BYTES`, `refusalText`.
Client behavior: one connection per request, no retry, no mock, token never in an error, response-id check, byte cap, timeout/abort, close only its own sockets.

## Pure exports

`src/pocket-layerfs/policy.ts`

`normalisePath`, `normaliseDirectory`, `isSensitiveName`, `isSensitivePath`, `splitPath`, `joinPath`, `isHistoryName`, `isProjectName`, `isBranchName`, `isNodeId`, `refKind`, `clampPageSize`, `clampPagePos`, `clampLine`, `clampHistoryScan`, `clampLineWindow`, `exceedsBytes`, `shortId`, constants `MAX_PAGE_SIZE`, `SDK_MAX_LINES`, etc.

`config.ts`

`validateConfig`, `loadConfigFile`, `defaultConfigPath`, `publicConfig`, `publicSessionGrant`, `isInside`, `ConfigError`, `assertNoSymlinkAncestors`.

`auth.ts`

`toolContext`, `sessionGrant`, `writeContext`, `isOwnerRequest`, `projectGrant`, `assertAllowedBranch`, `assertReadableBranch`, `assertToolBranch`, `assertForkSource`, `assertNewBranchName`, `assertOwnerPerson`.

`tickets.ts`

`TicketStore` (`now`, `random`, `ttlMs`, `max` injectable; `issue`, `consume`, `consumeFor`, `purge`, `clear`, `size`), `hashToken`, `TICKET_BYTES`, `MAX_TICKETS`.

`format.ts`

`fence`, `toolResult`, `defang`, `clipBytes`, `attr`, `oneLine`, `isoTime`, `branchHead`, `commitLine`, `changeLine`, `hunkLines`, `DATA_TAG`.

`errors.ts`

`CODES`, `LayerfsRefusal`, `safeMessage`, `statusFor`, `fromUpstreamError`, `isRefusal`.

`service.ts`

`LayerfsFacade` with `ping`, `branches`, `commits`, `commit`, `tree`, `stat`, `read`, `diff`, `blame`, `fileHistory`, `prepareFork`, `fork`.

`lazy.ts`

`LazyServiceClient` (reads the token on first use; resets a dead socket; no spawn).

## Service internals

`service/main.mjs`

- `--config`, `--check`, `--help`. Setup accepts only the fixed official archive and `--archive`; there is no `--source` or `--skip-build` reuse. The extracted source is verified by the full `treeSha256` and the pinned file hashes before building.
- Verifies `upstream.lock.json`, `.runtime/sdk/UPSTREAM.json`, package version, private paths/modes, Store paths.
- Sets `LAYERFS_HOME`, `LAYERFS_NATIVE`; deletes Docker/image/volume/daemon/trace env.
- Binds 0700 socket, 0600 token; queue; logs code-only lines.

`service/engine.mjs`

`Engine({ config, LayerFS, upstream, log })` with `listBranches`, `listCommits`, `oneCommit`, `tree`, `read`, `stat`, `diff`, `blame`, `fileHistory`, `forkPlan`, `forkCommit`, `ping`, `close`.

`service/queue.mjs`

`BoundedQueue({ concurrency, maxQueue })`; `run(task, { timeoutMs, label?, signal? })`; `waitForIdle(timeoutMs)` resolves true only when active and queued are both zero. A running native call keeps its slot; a queued call that expires or is aborted is removed and never runs.

`service/main.mjs` binds one `AbortController` per connection to `socket.close`/`error`/timeout and passes its signal to `queue.run`. A disconnect therefore cancels queued work; a call already inside the native SDK is not cancelled and is logged `outcome=unknown`. Stop order is: close listener → reject/cancel queued → wait for active to settle (5 s, then 25 s) → close Store clients only if idle → remove own socket. A still-running call is never reported as cleanly stopped.

`scripts/install-lib.mjs`

`MANIFEST`, `hashFile`, `assertNoSymlinkAncestors`, `liveRoots`, `assertNotLive`, `prepareTarget`, `validateManifest`, `readManifest`, `destinationFor`, `writeManifest`. The manifest is strict: fixed `pocket-layerfs.ts` / `pocket-layerfs/` prefix, no absolute/`..`/hidden component, no duplicate, no unknown top-level field. Install and uninstall preflight every existing file and hash before any removal. `scripts/install.mjs` and `scripts/uninstall.mjs` are CLI entry points.

`scripts/runtime-lib.mjs`

`RUNTIME_MARKER`, `SYNTHETIC_MARKER`, `assertExclusiveRuntime`, `assertReplaceable`, `treeHash`, `markSyntheticSource`, `assertSyntheticSource`, `assertFixedPath`. A non-empty runtime without the marker is never adopted or removed. `treeHash` is the pinned full-source tree hash (`upstream.lock.json.treeSha256`).

`service/secure.mjs`

`assertNoSymlinkPath`, `assertRealPath`, `ensureRuntimeDir`, `assertPrivateDir`, `assertSdkDir`, `assertStorePath`, `ensureToken`, `readToken`, `prepareSocket`, `assertSocket`, `removeOwnSocket`, `sameToken`, `assertRuntimeLayout`.

## Faithful fake SDK for engine tests

Do **not** write a fake that accepts an extra `project.id` argument. The real v1.0.0 client binds the project. Faithful signatures:

```js
const fake = {
    project: {
        init: async (sourcePath) => ({ kind: "Initialized" }),
        list_branches: async (pageSize = 50, pagePos = 0) => ({
            items: [],
            hasMore: false,
            nextPagePos: null,
        }),
    },
    branch: {
        fork: async (name, fromRef = "main") => ({ kind: "Forked", branch: name }),
        list_commits: async (branch, pageSize = 50, pagePos = 0) => ({
            items: [],
            hasMore: false,
            nextPagePos: null,
        }),
        diff_branches: async (from, to, pageSize = 50, pagePos = 0, options = {}) => ({
            items: [],
            hasMore: false,
        }),
        diff_commits: async (from, to, pageSize = 50, pagePos = 0, options = {}) => ({
            items: [],
            hasMore: false,
        }),
    },
    fs: {
        stat: async (ref, path) => ({ type: "file", inode: 1, size: 1 }),
        list: async (ref, path = "/", pageSize = 50, pagePos = 0) => ({
            items: [],
            hasMore: false,
        }),
        read: async (ref, path, startLine = 1, endLine) => ({
            text: "",
            startLine,
            endLine: startLine,
            nextLine: null,
        }),
        blame: async (ref, path, fromLine = 1) => ({ lines: [], nextLine: null }),
        diff_files: async (leftRef, leftPath, rightRef, rightPath) => ({ contentEqual: true }),
    },
    close: async () => {},
};
```

A fake should also reject unexpected extra arguments in the tests that check the engine adapter; otherwise a contract mismatch is hidden. The real native exercise is the final check.

## Installed SDK trust receipt (required for a fake service SDK)

The service verifies the installed SDK before it imports it: the reviewed content pin in `upstream.lock.json` or a private receipt outside the SDK (`<runtime>/trust/sdk-receipt.json`). A fixture that runs its own synthetic SDK must record the matching receipt after it writes the SDK and before it starts the service:

```js
import { writeTrustReceipt } from "../../scripts/verify-lib.mjs";
import { PROJECT } from "./resume-runtime.mjs";

writeTrustReceipt(PROJECT, fixture.root, "owner-authorized");
```

Stable contract:

- Call it with the exclusive runtime root passed to `runtime()` and method `"owner-authorized"`; `sdk` must be `<root>/sdk` with `native/layerfs.node` present.
- It writes `<root>/trust/` (0700) and `sdk-receipt.json` (0600), binding the exact current SDK content hash and native hash to the pin. Re-record it if the fixture replaces the SDK content; otherwise verification fails closed.
- `service --check` needs the same receipt. It is read-only: it does not create `service/`, a socket, or a token.
- `setup --check` on the same fixture stays refused, because the fixture SDK is not the official tree: a receipt does not make it an official build. Do not assert `ok: true` for `setup --check` there.
- This is the production trust record, not a test-mode flag. The installer writes it with method `official-build` only after verifying the official source tree; there is no environment switch that skips verification.

## Current independent tests

`test/` currently contains:

- `fixtures.test.ts`: synthetic security tree self-tests (symlinks, hardlinks, `.git` file, dirty tracked file).
- `harness.test.ts`: isolated official Pi Pocket harness (owner/guest/viewer/route lifecycle).
- `ipc.test.ts`: real Unix socket token/framing/timeout/close tests.
- `policy-auth-config.test.ts`: session grants, `main`, prefix, path, paging, config file checks.
- `queue.test.ts`: queued expiry, signal cancellation, slot retention.
- `tickets-format.test.ts`: binding, expiry, replay, concurrent consume, defang, UTF-8 clipping.
- `format-surrogates.test.ts`: emoji/surrogate clipping budgets.
- `engine-contract.test.ts`: faithful grouped v1.0.0 wrappers, file history via `fs.diff_files`, fork exact head, session/branch denial. This uses a synthetic dispatcher, not the native Store.
- `cli-security.test.ts`: install/uninstall manifest attacks, symlink ancestors, changed-file preflight, setup source rejection, hidden child rejection, unowned runtime protection.

These are the test agent's files; this project does not modify them.

## Release 0.3.0 seams

Server module: `src/pocket-layerfs.ts` re-exports
`src/pocket-layerfs/v3/index.ts` (default factory, `pocketApi = 1`). Legacy
paths re-export `v3` for compatibility. New pure/server exports:

- `src/pocket-layerfs/v3/runtime.ts`: `createRuntime`, `swapRuntime`,
  `dynamicObject`, `dynamicService`.
- `src/pocket-layerfs/v3/gui.ts`: `parseDraft`, `buildCandidate`,
  `draftFromConfig`.
- `src/pocket-layerfs/v3/apply.ts`: `sessionIds`, `draftErrors`, `applyDraft`,
  `checkStatus`.
- `src/pocket-layerfs/v3/import.ts`: `LIMITS`, `validateSource`, `walkSource`,
  `hashStage`, `previewImport`, `confirmImport`, `listImports`,
  `projectDetail`.
- `src/pocket-layerfs/v3/registry.ts`: `readRegistry`, `writeRegistry`,
  `updateRegistry`, `registryPath`, `importRoot`, `projectRoot`.
- `src/pocket-layerfs/v3/config-store.ts`: `withConfigMutation`,
  `readOwnBytes`, `writeOwnBytes`.
- `src/pocket-layerfs/v3/tickets.ts`: `TicketStore.take`.
- `service/control.mjs`: `configStatus`, `applyConfig`,
  `createServiceControl(runtime, { verifyUpstream })`.
- `service/engine.mjs`: `clientKey(project, home)`.

Routes: `gui/overview`, `gui/status` (alias), `gui/projects/:project`,
`gui/sessions`, `gui/validate`, `gui/apply`, `gui/check`,
`gui/import/preview`, `gui/import/confirm`, `gui/imports`, `gui/service`.
All are `access: "owner"` and check the configured owner id.
