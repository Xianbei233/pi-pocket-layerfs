# Capabilities

## Supported

| Capability                       | Page              | Read-only tool         | Notes                                           |
| -------------------------------- | ----------------- | ---------------------- | ----------------------------------------------- |
| List configured projects         | yes               | —                      | owner page                                      |
| List branches with heads         | yes               | `layerfs_branches`     | only granted branches                           |
| List commits, newest first       | yes               | `layerfs_commits`      | per Branch; `main` is a Layer line              |
| Show one commit                  | yes               | `layerfs_commit`       | id must be reachable                            |
| Browse a tree at a branch/commit | yes               | `layerfs_tree`         | sensitive/symlink entries omitted               |
| Read a file window               | yes               | `layerfs_read`         | 1-based, SDK 2000 lines/48 KiB                  |
| Stat a path                      | yes               | —                      | symlinks refused                                |
| Diff branches or commits         | yes               | `layerfs_diff`         | hunks, cursor, paging                           |
| Diff two files                   | via service       | —                      | used by file history                            |
| Blame a file                     | yes               | `layerfs_blame`        | line origins                                    |
| Bounded file history             | yes               | `layerfs_file_history` | real `fs.diff_files` content compare            |
| View a historical file           | yes               | yes                    | set ref to a commit                             |
| Create a recovery Branch         | yes               | no                     | owner preview + click + one-time ticket         |
| Fork from an older commit        | yes (write panel) | no                     | commit must be reachable from the source branch |

## Deliberately unsupported

| Capability                               | Why                                                                                                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import a real repository                 | `project.init` captures the whole tree, ignored files included. A general import needs a reviewed staging design; v1 only initialises a fixed synthetic tree. |
| Host export / apply output               | No safe, reviewed path from LayerFS to the host. Not in v1.                                                                                                   |
| Merge, delete, publish, rewrite          | No routes, no tools. A Branch created by fork is real and remains.                                                                                            |
| Automatic working-directory takeover     | No cwd change, no atomic checkout, no FUSE mount of the session folder. Upstream README lists Pi support as planned; this project does not claim it.          |
| Write files through the page/tools       | The only write is `branch.fork`. No `fs.write`, `edit`, `apply`, `rm`, `cp`, `mv`, `mkdir`.                                                                   |
| Model-approved write                     | The model never receives a preview ticket; a `confirm: true` argument is not authority.                                                                       |
| Docker / Sandbox / Workspace / FUSE      | Not needed for Store reads/writes; not implemented or tested here.                                                                                            |
| Layer listing on `main`                  | The public v1.0.0 SDK has no layer-list method. `main` is the project’s line of Layers; commit history is per Branch.                                         |
| Symlink following                        | Refused at plugin and service boundaries.                                                                                                                     |
| Cross-branch/cross-project commit lookup | Refused; a commit must be reachable from a granted branch.                                                                                                    |
| Generic sensitive-name exemptions        | Not configurable in v1.                                                                                                                                       |

## Upstream limitation: `project.init` uid 0

LayerFS v1.0.0's native Store installer requires effective uid 0 (`DAEMON_UID = 0`). This project does not use `sudo`. The synthetic init supports either the daemon user or an unprivileged Linux user namespace (`unshare -Ur`). If neither is available, init stops with the upstream error.

## Durability

The Store is the upstream **Disposable** profile: no crash or power-loss durability. It is for agent history that can be rebuilt, not the only copy of important data.

## Version

Pinned: LayerFS `v1.0.0`, commit `2aaf2552ce21154928b9f9c83582e41a637f5910`. The later `main` head `5fb68ddc1acc3163e3ac3486133bde014c5fbed3` adds DSH/host/daemon changes, not a Pi Pocket integration; this project does not mix it.
