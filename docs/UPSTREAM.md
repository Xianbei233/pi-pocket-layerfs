# Upstream evidence and contract

This project pins **LayerFS v1.0.0**. The evidence below was collected on 2026-10-22 from the official repository. No LayerFS source is vendored.

## Pinned source

| Field           | Value                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Repository      | `https://github.com/Ephemeral-AI-Lab/layerfs`                                                          |
| Tag             | `v1.0.0`                                                                                               |
| Commit          | `2aaf2552ce21154928b9f9c83582e41a637f5910`                                                             |
| Published       | `2026-10-21T11:21:25Z`                                                                                 |
| License         | MIT, copyright 2026 Ephemeral-AI                                                                       |
| Archive         | `https://codeload.github.com/Ephemeral-AI-Lab/layerfs/tar.gz/2aaf2552ce21154928b9f9c83582e41a637f5910` |
| Archive SHA-256 | `4a825aced0574358857f14abfc9c553e4f0f3cf88914de8956ac4107692535a7`                                     |
| Archive bytes   | `2574626347`                                                                                           |
| SDK version     | `1.0.0`                                                                                                |

Pinned file hashes:

| File                  | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `sdk/js/package.json` | `e27ce8a21587b4fa9fecb643f2f6850e26e59b50ba5d5a9a03ce47cad8ebaafb` |
| `sdk/js/src/index.js` | `e2370efef3f22fa653f250578b6a78a7b7a6ecfd59bd945ee6eb2249eb99d153` |
| `core/Cargo.lock`     | `af9b5c8aec2d2bbfbfb6216cd8c7839d80b95bea1669df03c69e0a3f318a84a6` |

### Commands

```bash
git ls-remote --tags https://github.com/Ephemeral-AI-Lab/layerfs.git refs/tags/v1.0.0
# 2aaf2552ce21154928b9f9c83582e41a637f5910 refs/tags/v1.0.0   exit 0

git clone --depth 1 --branch v1.0.0 https://github.com/Ephemeral-AI-Lab/layerfs.git layerfs-src
git -C layerfs-src rev-parse HEAD
# 2aaf2552ce21154928b9f9c83582e41a637f5910                    exit 0

curl -fL --proto '=https' --tlsv1.2 -o layerfs-v1.0.0.tar.gz \
  https://codeload.github.com/Ephemeral-AI-Lab/layerfs/tar.gz/2aaf2552ce21154928b9f9c83582e41a637f5910
sha256sum layerfs-v1.0.0.tar.gz
# 4a825aced0574358857f14abfc9c553e4f0f3cf88914de8956ac4107692535a7
```

The archive is large because the upstream repository also contains benchmark and documentation assets. Setup supports `--archive` for an already verified copy and rejects `--source`/prebuilt reuse: it verifies the archive, the full extracted tree hash, and the pinned files, then builds. The tree hash excludes only the root `.git` metadata; the archive has none.

## Native build actually run

```bash
CARGO_HOME=$PWD/.runtime/cargo \
CARGO_TARGET_DIR=$PWD/.runtime/target \
TMPDIR=$PWD/.runtime/tmp \
cargo build --manifest-path core/Cargo.toml --locked -p layerfs-node --release
# Finished `release` profile [optimized] target(s) in 1m 49s   exit 0
```

The addon is `liblayerfs_node.so` (about 13 MiB), copied to `.runtime/sdk/native/layerfs.node`. It links only `libgcc_s`, `libm`, `libc` and the loader; no Docker socket is used.

## Public SDK contract used

The grouped methods are already bound to the project client. Positional arguments do **not** include `project.id`:

| Group                                                                      | Signature used                             |
| -------------------------------------------------------------------------- | ------------------------------------------ |
| `project.init(sourcePath)`                                                 | captures a source tree, installs the Store |
| `project.list_branches(pageSize?, pagePos?)`                               | includes `main` as a Layer line            |
| `branch.fork(name, fromRef?)`                                              | metadata-only Branch creation              |
| `branch.list_commits(branch, pageSize?, pagePos?)`                         | newest first; no `main` commits            |
| `branch.diff_commits(from, to, pageSize?, pagePos?, { cursor?, hunks? })`  | two saved Commits                          |
| `branch.diff_branches(from, to, pageSize?, pagePos?, { cursor?, hunks? })` | Branches or `main`                         |
| `fs.read(ref, path, startLine?, endLine?)`                                 | 1-based inclusive, max 2000 lines / 48 KiB |
| `fs.list(ref, path?, pageSize?, pagePos?)`                                 | one directory page                         |
| `fs.stat(ref, path)`                                                       | type, inode, size                          |
| `fs.diff_files(leftRef, leftPath, rightRef, rightPath)`                    | real content comparison                    |
| `fs.blame(ref, path, fromLine?)`                                           | 1-based, bounded                           |
| `fs.apply(branch, changes, message?)`                                      | not exposed by this project                |

`fs.apply([])` may answer `UpToDate` and create no Commit. This project never claims a forced snapshot; the only internal write is `branch.fork` at an exact node.

`read`/`blame` return `nextLine`, `truncated`, `lineTruncated`; paged calls return `items`, `hasMore`, `nextPagePos`; diffs also return `nextCursor`. Numeric paging can shift with live heads; a diff cursor is the stable continuation.

## Real Store exercise (not a mock)

On a btrfs workspace, with the official native addon:

1. `project.init` of a synthetic two-file tree. This must run with effective uid 0 because upstream `DAEMON_UID = 0`; it ran in an unprivileged `unshare -Ur` namespace. The host user remained 1000; the Store is owned by host uid 1000, mode 0600.
2. `project.list_branches` returned `main` with a base Layer and no head.
3. `branch.fork("work", "main")` returned `kind: "Forked"`.
4. `fs.write("work", "/README.md", ..., "Seed work branch")` returned a real `Committed` with a new head.
5. `fs.list`, `fs.read`, `branch.list_commits`, `branch.diff_branches`, `fs.blame`, `fs.stat`, `fs.diff_files` returned the expected values.
6. A second `fs.write` changed one byte while keeping the same inode and length (54 bytes). `fs.diff_files` reported `contentEqual: false`; the plugin's `file-history` reported `change: "modified"`. This is why the implementation does not use inode/size as proof of no change.
7. The private service started on a 0700 Unix socket with a 0600 token and served `ping`, `branches`, `tree`, `read`, `commits`, `diff`, `blame`, `file-history`, `fork.plan`, `fork.commit`.
8. A stale `expectedHead` was refused `HeadMoved`; an unauthorized tool conversation was refused `Forbidden`; an unauthorized branch and a sensitive path were refused `NotFound`; traversal was refused `InvalidPath`.

## Upstream limitations that shape this project

- **`project.init` requires effective uid 0.** Source: `core/crates/layerfs-store-service/src/install.rs`, `DAEMON_UID: u32 = 0`. A non-root install fails before any Store is written. This project does not use `sudo`; the synthetic init optionally uses `unshare -Ur`. This is a real upstream limitation, not a plugin choice.
- **Store is Disposable.** No crash or power-loss durability.
- **`project.init` captures the whole tree, ignored files included.** No general importer is exposed.
- **No public layer list.** `main` is the project’s line of Layers. Commit history is per Branch. `branch.list_commits("main")` is not a commit history.
- **No official Pi support.** Upstream README says “LayerFS × Pi: planned”. There is a DSH plugin, not a Pocket adapter. This project is independent and claims no atomic cwd checkout.
- **Store calls are Linux-only** and need a local ext4/xfs/btrfs filesystem that carries SQLite locks.
- **No Docker/FUSE needed for Store calls**; the native binding opens the Store in-process.

## Later `main` is not mixed in

`main` at `5fb68ddc1acc3163e3ac3486133bde014c5fbed3` (2026-10-21T14:02:56Z) is 17 commits ahead of v1.0.0. Its changes are DSH host volume/write access, shared `stateDir` bindings, daemon first-connection handshake, benchmark, and README work. It does not add a Pi Pocket integration. This project stays on the v1.0.0 tag; the later head is recorded only as a known difference, not built.

## License

LayerFS is MIT, copyright 2026 Ephemeral-AI. See `NOTICE`. Setup downloads the source; this repository does not redistribute it.
