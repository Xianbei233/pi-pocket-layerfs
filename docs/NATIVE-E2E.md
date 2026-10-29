# Native end-to-end recipe for the test agent

Use a **separate runtime** on the same btrfs worktree. Do not use the developer's `.runtime`, `.runtime/store/synthetic`, or `.runtime/service/service.sock`; those may be in use. The pattern `.runtime-*/` is ignored by git, ESLint, and Prettier.

## Fresh runtime, no rebuild

```bash
cd /home/xianbei233/Work/pi-pocket-layerfs
RT="$PWD/.runtime-test-native"
rm -rf "$RT"
mkdir -m 700 "$RT"
printf '{"name":"pi-pocket-layerfs-runtime","version":1}\n' > "$RT/.pi-pocket-layerfs-runtime"
chmod 600 "$RT/.pi-pocket-layerfs-runtime"
cp -a .runtime/sdk "$RT/sdk"          # official pinned SDK + native addon already built
# optional on this x86_64 host: sha256 63d366056b8c370583bddd4dba34fc186fd5a6cc3c2fe4e1c436a7c7221468a7
node scripts/init-synthetic.mjs \
  --runtime "$RT" \
  --project synthetic-native \
  --user-namespace
```

`init-synthetic` writes `$RT/config.json` with tools/write **off** and `sessionGrants: []`, creates `$RT/store/synthetic-native/store.sqlite`, forks `work`, and seeds one real commit with `fs.write`. It uses `unshare -Ur` only for the upstream `project.init` uid-0 install step. The host user remains unprivileged. The Store must stay on btrfs/ext4/xfs; the worktree is btrfs.

The generated config is fail-closed. For a test, write a test config (mode 0600) with a unique socket/token and a session grant:

```json
{
    "version": 1,
    "ownerPersonIds": ["test-owner"],
    "service": {
        "runtimeDir": "<RT>/service",
        "socketPath": "<RT>/service/service.sock",
        "tokenFile": "<RT>/service/service.token",
        "layerfsHome": "<RT>/layerfs-home",
        "sdkPath": "<RT>/sdk"
    },
    "tools": { "enabled": true, "maxBytes": 32768 },
    "write": { "enabled": true, "ticketTtlMs": 120000 },
    "projects": [
        {
            "id": "synthetic-native",
            "label": "Synthetic native",
            "storePath": "<RT>/store/synthetic-native/store.sqlite",
            "branches": ["main", "work"]
        }
    ],
    "sessionGrants": [
        {
            "conversationId": "9001",
            "project": "synthetic-native",
            "allowTools": true,
            "toolBranches": ["main", "work"],
            "fork": { "enabled": true, "sources": ["work"], "namePrefix": "recovery-" }
        }
    ]
}
```

Start and stop a private service in the test's own process group:

```bash
node service/main.mjs --config "$RT/config.json" &
SERVICE_PID=$!
# wait for "$RT/service/service.sock"
# ... test ...
kill -TERM "$SERVICE_PID"
wait "$SERVICE_PID"
```

Do not start it on the developer's socket. Do not reuse the developer's Store.

## Native read/write checks

The service IPC is the product path and is covered by `docs/TEST-SEAMS.md`. A native E2E can call the real SDK directly for read assertions, using the same pinned addon:

```bash
LAYERFS_HOME="$RT/layerfs-home" \
LAYERFS_NATIVE="$RT/sdk/native/layerfs.node" \
node --input-type=module -e '
import { LayerFS } from "'"$RT"'/sdk/src/index.js";
const lfs = new LayerFS("synthetic-native", { storePath: "'"$RT"'/store/synthetic-native/store.sqlite" });
console.log(await lfs.fs.read("work", "/README.md", 1, 20));
await lfs.close();
'
```

Faithful grouped signatures are in `docs/TEST-SEAMS.md`; do not pass `project.id` to `project.list_branches`, `branch.*`, or `fs.*`.

For a same-inode/same-size edit check, stop the service, use the SDK `fs.write` on `work` with a message, restart the service, and assert `file-history` returns `change: "modified"` for that commit. This is the case that inode/size alone misses.

## HTTP/loader tests with a fake service

The module's `LazyServiceClient` reads a 0600 token and connects to a Unix socket. A test can start a synthetic peer (as in `test/ipc.test.ts`), write a 0600 token file, and point `config.service.socketPath`/`tokenFile` at it. This exercises the product loader, owner-only routes, conversation binding, preview ticket, and owner/guest HTTP checks without the native engine.

The fake peer needs the IPC envelope only:

```text
request:  { v: 1, id, token, op, args }
response: { id, ok: true, result }
          { id, ok: false, error: { code } }
```

For `fork.plan`, return `{ project, sourceBranch, sourceHead, expectedHead, fromRef, fromLabel, targetBranch, targetExists }`. For `fork.commit`, return `{ kind: "Forked", branch, base, head }`. The plugin issues/consumes the ticket itself; the fake service does not need to parse it. A model or request body cannot supply `confirm: true` as approval.

## Install smoke

```bash
TARGET="$PWD/.runtime-test-dropin"
rm -rf "$TARGET"
node scripts/install.mjs --target "$TARGET"
test -f "$TARGET/.layerfs-install.json"
test -f "$TARGET/pocket-layerfs.ts"
node scripts/uninstall.mjs --target "$TARGET"
test ! -e "$TARGET/.layerfs-install.json"
```

The installer refuses `~/.pi-pocket` and folders with `pocket.sqlite`, `sessions`, or `themes`. It never enables the module.

## Boundaries

- Test agent owns `test/**` and `TESTING.md`; developer owns `src/**`, `service/**`, `scripts/**`, `docs/**`, root files.
- Do not use the developer's `.runtime` Store/socket.
- Do not run `project.init` on a real repository.
- Do not add Docker/FUSE expectations; this version does not implement them.
