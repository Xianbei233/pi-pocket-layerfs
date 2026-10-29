# Operations

## Start and stop

Start in the foreground, in its own terminal:

```bash
node service/main.mjs --config "$PWD/.runtime/config.json"
```

Stop with `Ctrl-C` or `SIGTERM`. The service closes the listening socket, refuses new calls and cancels queued calls, then waits up to 5 s for a running Store call to settle before closing Store clients. If a native call is still running, it logs `outcome unknown`, does not close the Store while that call is in flight, and waits a further 25 s. If it is still running after that, it logs a hard-deadline message and exits with status 2 when it can; it never claims the native call was cancelled. Store close is asynchronous upstream: a resolved close exits 0, while a close that rejects or does not settle within 3 s is logged as an unknown outcome and exits with status 4. An unknown close is never reported as a clean stop. Only its own socket is removed, and only if the inode is unchanged. It does not remove the token, Store, config, or LayerFS home.

Do not use `kill -9` while an internal `branch.fork` is running. The SDK cannot cancel a running native call; a hard kill can leave the commit/branch outcome unknown. The route never retries a write automatically. A socket disconnect aborts queued work; a call that already entered the native SDK is not cancelled and is logged as `outcome unknown`.

## Check without binding

```bash
node service/main.mjs --config "$PWD/.runtime/config.json" --check
```

This verifies the config shape, private paths/modes, the installed SDK against the reviewed content pin or a private receipt, the native addon content hash, and project Store paths. It prints JSON and exits non-zero on a refusal. It is read-only: it does not create a token or runtime directory, bind a socket, import the SDK, or call a Store.

## Health and logs

`GET /api/x/pocket-layerfs/status` (owner only) reports:

- `service.ok`;
- the pinned upstream version/commit;
- project ids;
- config switches.

The page shows `service unavailable` when the socket/token is absent or the service is down. It never falls back to a mock.

Service logs go to stderr, one line per call:

```text
[layerfs-service] 2026-... op=tree project=synthetic ok durationMs=12
[layerfs-service] 2026-... op=fork.commit project=synthetic code=HeadMoved durationMs=8
```

They do not contain arguments, file content, tokens, or full paths.

## Config status and changes

- `GET /api/x/pocket-layerfs/config` returns a safe summary. `hash` is the file now and `activeHash` is the file that this module version loaded. `reloadRequired` is true when they differ.
- `PUT` and `POST config/delete` need `expectedSha256`. A stale value is `409`, and the file does not change. A malformed body is `400`.
- Writes are denied while `PI_POCKET_LAYERFS_CONFIG` is set.
- The file is `0600` in a `0700` folder. The routes never chmod or adopt a broader folder.
- The routes are synchronous, so two changes cannot both pass the same hash.
- Turn the module off and on, or reload it, to use a new config. No Pocket restart is needed.

## Restart and config changes

- The plugin reads the config at module load. Reload the module after editing it.
- The service reads its config at start. Restart the service after changing projects, Store paths, session grants, service paths, or write policy.
- A service restart invalidates in-flight requests; open previews are also invalid because their tickets live in the plugin version that issued them. Make a new preview.
- An owner may stop the service at any time. Reads and writes then fail visibly; Pi's own tools and sessions continue.

## One service per socket

The service refuses to start if another process answers on the configured socket. If an old socket remains after a crash, it removes it only after a connection attempt is refused (`ECONNREFUSED`). It does not remove a live socket.

The socket and token live directly in `service.runtimeDir`, which must be 0700. The socket is 0600 and the token is 0600. Do not expose the runtime directory over a network share, a synced folder, or a world-readable path.

## Resources and bounds

| Item                     | Bound                                            |
| ------------------------ | ------------------------------------------------ |
| Store call concurrency   | 1 by default (config 1..4)                       |
| Queue                    | 16 by default (config 1..128)                    |
| Request frame            | 64 KiB                                           |
| Response                 | 512 KiB by default (config 64 KiB..4 MiB)        |
| Tool result              | 32 KiB by default (config 4..256 KiB)            |
| Read window              | SDK 2000 lines / 48 KiB per call                 |
| Page size                | 200                                              |
| Commit reachability scan | 20 pages × 128 = 2560 commits per allowed branch |
| File history scan        | 50 commits by default, max 200                   |
| Preview ticket TTL       | 30–300 s (default 120 s)                         |

A queue entry that expires before it starts is removed and never runs. A running call that times out rejects the caller but keeps its worker slot until the native promise settles. A timed-out `fork.commit` has an **unknown outcome**: check the branch list; do not retry blindly.

## Store backup

The Store is one SQLite file per project plus the LayerFS home metadata. The upstream profile is Disposable, so there is no crash/power-loss guarantee.

For a consistent copy:

1. Stop the service (and any other writer using the same Store).
2. Copy the project `storePath` and the matching `layerfsHome/<project>/` entries with normal filesystem tools.
3. Restart the service.

Do not copy a live Store as your only backup and assume consistency. Do not use this project to delete or rewrite a Store.

## Troubleshooting

| Symptom                      | Likely cause                                                                | Action                                                                    |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `service unavailable`        | wrong socket/token path; service not started; token mode not 0600           | start service, check `--check`, fix config                                |
| `Invalid` / `Not configured` | missing/old config; module not reloaded                                     | reload module, restart service                                            |
| `NoSuchPath` for a real path | name is sensitive, path is a symlink, or the branch/ref is not granted      | use a granted branch; do not re-include secrets                           |
| `NoSuchCommit` for a real id | commit is outside the allowed branches or older than the reachability bound | use a commit reached from a granted branch; narrow the project            |
| `HeadMoved` on Create Branch | source branch moved since preview                                           | make a new preview                                                        |
| `NameTaken`                  | target branch exists                                                        | choose another name                                                       |
| `Timeout`                    | large history, long diff, or busy queue                                     | reduce page/history bound, retry after reads settle; do not retry a write |
| `Unsupported`                | Store filesystem is not ext4/xfs/btrfs, or init ran non-root                | put the Store on a supported local filesystem; see INSTALL                |
| `Exists` during init         | project home entry from a failed init remains                               | use a new project id; do not delete a real project without owner review   |
| native addon error           | SDK marker/addon missing or wrong version                                   | re-run setup, verify `UPSTREAM.json`                                      |

## Do not

- Do not run the service as a shared system daemon or expose its socket.
- Do not point it at a real workspace with FUSE/Docker expectations; this version does not mount anything.
- Do not run `project.init` on a real repository through this project; there is no reviewed staging/import path.
- Do not edit a live Store or LayerFS home by hand.

## Release 0.3.0: config apply and service control

Start the service with the fixed plugin own config path:

```text
node service/main.mjs --config "<dataDir>/pocket-layerfs/config.json"
```

A later targeted replacement of an existing service that was started from a
runtime copy must point it at this fixed path. Do not delete or edit the old
Store, LayerFS home, runtime, or token during that replacement.

The service has two control operations on the same socket and token:

- `config.status` -> `{ activeHash, generation, appliedAt, projectCount, upstream, startedAt, pid }`.
- `config.apply { baseActiveHash, targetHash, expectedGeneration }` -> applies
  the exact saved bytes at the startup path. It refuses a changed base, a
  stale generation, or a changed service layout (`runtimeDir`, `socketPath`,
  `tokenFile`, `layerfsHome`, `sdkPath`). A definite refusal is `NotApplied`.
  A generation mismatch is `StaleGeneration`.

Before the swap, the service pauses the queue, refuses calls that have not
started with `Busy`, and drains only running native calls (5 s bound). A
paused queue has an empty wait list, so the drain cannot deadlock. A timeout
returns `Busy` and the old config stays active. Clients are shared only when
project, Store path, and LayerFS home all match. Clients of removed projects
close once after the drain; a failed close is logged as an unknown outcome.

Startup logs `listening ...`; stop logs `stopping ...`. A config apply logs
`op=config.apply ok|code=... durationMs=...`. A Store close failure during
stop still exits non-zero, as before.
