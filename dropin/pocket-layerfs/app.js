/**
 * The LayerFS page. It reads only the module's owner routes, renders every
 * LayerFS value as text (never HTML or Markdown), and keeps a preview ticket
 * only in component state.
 */

/**
 * @param {{ pocket: any }} props
 */
export function LayerfsPage({ pocket }) {
    const { html, useEffect, useRef, useState, Loader } = pocket;
    const [status, setStatus] = useState(null);
    const [session, setSession] = useState(null);
    const [projectId, setProjectId] = useState("");
    const [branch, setBranch] = useState("main");
    const [ref, setRef] = useState("main");
    const [path, setPath] = useState("/");
    const [dir, setDir] = useState("/");
    const [view, setView] = useState("tree");
    const [tree, setTree] = useState(null);
    const [commits, setCommits] = useState(null);
    const [file, setFile] = useState(null);
    const [blame, setBlame] = useState(null);
    const [fileHistory, setFileHistory] = useState(null);
    const [diff, setDiff] = useState(null);
    const [diffFrom, setDiffFrom] = useState("main");
    const [diffTo, setDiffTo] = useState("");
    const [selectedCommit, setSelectedCommit] = useState(null);
    const [preview, setPreview] = useState(null);
    const [forkSource, setForkSource] = useState("");
    const [forkFrom, setForkFrom] = useState("");
    const [forkName, setForkName] = useState("");
    const [forkCommits, setForkCommits] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [reload, setReload] = useState(0);
    const controllers = useRef(new Set());

    const project = status?.config?.projects?.find((entry) => entry.id === projectId) ?? null;
    const grant = session?.grant ?? null;
    const conversationId = pocket.conversationId();
    const me = pocket.me();

    const call = async (route, options = {}) => {
        const controller = new AbortController();
        controllers.current.add(controller);
        if (options.signal !== undefined) {
            if (options.signal.aborted) controller.abort();
            else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        try {
            return await pocket.api(route, options.body, {
                method: options.body === undefined ? "GET" : "POST",
                signal: controller.signal,
            });
        } finally {
            controllers.current.delete(controller);
        }
    };

    useEffect(() => {
        const stop = new AbortController();
        (async () => {
            try {
                const value = await call("status", { signal: stop.signal });
                setStatus(value);
                const first = value?.config?.projects?.[0];
                if (first && projectId === "") {
                    setProjectId(first.id);
                    const initial = first.branches.includes("main")
                        ? "main"
                        : (first.branches[0] ?? "main");
                    setBranch(initial);
                    setRef(initial);
                    setDiffFrom(initial);
                    setDiffTo(first.branches.find((name) => name !== initial) ?? initial);
                }
            } catch (failure) {
                if (!stop.signal.aborted) setError(failure.message);
            }
        })();
        return () => stop.abort();
        // The page loads once for this version; Refresh is explicit.
    }, []);

    useEffect(() => {
        if (conversationId === null) {
            setSession(null);
            return;
        }
        const stop = new AbortController();
        call(`session/${encodeURIComponent(String(conversationId))}/status`, {
            signal: stop.signal,
        })
            .then(setSession)
            .catch(() => {
                if (!stop.signal.aborted) setSession(null);
            });
        return () => stop.abort();
    }, [conversationId, status]);

    useEffect(() => {
        if (projectId === "") return;
        const stop = new AbortController();
        setCommits(null);
        call(
            `projects/${encodeURIComponent(projectId)}/commits?branch=${encodeURIComponent(branch)}&pageSize=50`,
            { signal: stop.signal },
        )
            .then(setCommits)
            .catch((failure) => {
                if (!stop.signal.aborted) setError(failure.message);
            });
        return () => stop.abort();
    }, [projectId, branch, reload]);

    useEffect(() => {
        if (projectId === "" || view !== "tree") return;
        const stop = new AbortController();
        setTree(null);
        call(
            `projects/${encodeURIComponent(projectId)}/tree?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(dir)}&pageSize=100`,
            { signal: stop.signal },
        )
            .then(setTree)
            .catch((failure) => {
                if (!stop.signal.aborted) setError(failure.message);
            });
        return () => stop.abort();
    }, [projectId, ref, dir, view, reload]);

    useEffect(() => {
        if (projectId === "" || view !== "file") return;
        const stop = new AbortController();
        setFile(null);
        call(
            `projects/${encodeURIComponent(projectId)}/read?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&startLine=1`,
            { signal: stop.signal },
        )
            .then(setFile)
            .catch((failure) => {
                if (!stop.signal.aborted) setError(failure.message);
            });
        return () => stop.abort();
    }, [projectId, ref, path, view, reload]);

    useEffect(() => {
        if (projectId === "" || view !== "blame") return;
        const stop = new AbortController();
        setBlame(null);
        call(
            `projects/${encodeURIComponent(projectId)}/blame?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
            { signal: stop.signal },
        )
            .then(setBlame)
            .catch((failure) => {
                if (!stop.signal.aborted) setError(failure.message);
            });
        return () => stop.abort();
    }, [projectId, ref, path, view, reload]);

    useEffect(() => {
        if (projectId === "" || view !== "history-file") return;
        const stop = new AbortController();
        setFileHistory(null);
        call(
            `projects/${encodeURIComponent(projectId)}/file-history?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&maxCommits=50`,
            { signal: stop.signal },
        )
            .then(setFileHistory)
            .catch((failure) => {
                if (!stop.signal.aborted) setError(failure.message);
            });
        return () => stop.abort();
    }, [projectId, branch, path, view, reload]);

    useEffect(() => {
        if (projectId === "" || view !== "diff" || diffTo === "" || diffFrom === "") return;
        const stop = new AbortController();
        setDiff(null);
        call(
            `projects/${encodeURIComponent(projectId)}/diff?from=${encodeURIComponent(diffFrom)}&to=${encodeURIComponent(diffTo)}&pageSize=50&hunks=1`,
            { signal: stop.signal },
        )
            .then(setDiff)
            .catch((failure) => {
                if (!stop.signal.aborted) setError(failure.message);
            });
        return () => stop.abort();
    }, [projectId, diffFrom, diffTo, view, reload]);

    useEffect(() => {
        if (grant === null || grant?.fork?.enabled !== true) {
            setForkSource("");
            setForkCommits(null);
            return;
        }
        const source = grant.fork.sources.includes(forkSource)
            ? forkSource
            : (grant.fork.sources[0] ?? "");
        setForkSource(source);
        setForkName((current) =>
            current === "" ? `${grant.fork.namePrefix}${Date.now().toString(36)}` : current,
        );
        if (projectId === "" || source === "") return;
        const stop = new AbortController();
        setForkCommits(null);
        call(
            `projects/${encodeURIComponent(projectId)}/commits?branch=${encodeURIComponent(source)}&pageSize=20`,
            { signal: stop.signal },
        )
            .then(setForkCommits)
            .catch(() => {
                if (!stop.signal.aborted) setForkCommits(null);
            });
        return () => stop.abort();
    }, [grant, projectId, forkSource]);

    useEffect(
        () => () => {
            for (const controller of controllers.current) controller.abort();
            controllers.current.clear();
        },
        [],
    );

    /** The last directory for this file; the tree must never request a file path. */
    const directoryOf = (filePath) => {
        const parts = String(filePath).split("/").filter(Boolean);
        parts.pop();
        return parts.length === 0 ? "/" : `/${parts.join("/")}`;
    };

    const setProject = (id) => {
        const next = status?.config?.projects?.find((entry) => entry.id === id);
        const initial = next?.branches?.includes("main") ? "main" : (next?.branches?.[0] ?? "main");
        setProjectId(id);
        setBranch(initial);
        setRef(initial);
        setDiffFrom(initial);
        setDiffTo(next?.branches?.find((name) => name !== initial) ?? initial);
        setPath("/");
        setDir("/");
        setView("tree");
        setTree(null);
        setFile(null);
        setBlame(null);
        setFileHistory(null);
        setDiff(null);
        setSelectedCommit(null);
        setPreview(null);
        setError(null);
    };

    const setBranchAndRef = (name) => {
        setBranch(name);
        setRef(name);
        setDiffFrom(name);
        setDiffTo(project?.branches?.find((entry) => entry !== name) ?? name);
        setPath("/");
        setDir("/");
        setView("tree");
        setSelectedCommit(null);
        setPreview(null);
    };

    const openDir = (nextPath) => {
        setDir(nextPath);
        setPath("/");
        setView("tree");
        setError(null);
    };

    const openFile = (nextPath) => {
        setDir(directoryOf(nextPath));
        setPath(nextPath);
        setView("file");
        setError(null);
    };

    const openCommit = (commit) => {
        setSelectedCommit(commit);
        setRef(commit.id);
        setPath("/");
        setDir("/");
        setView("tree");
        setError(null);
    };

    const openDiffToParent = (commit) => {
        if (typeof commit.parent !== "string") {
            setError("This is the first Commit on the Branch; there is no parent to compare.");
            return;
        }
        setSelectedCommit(commit);
        setDiffFrom(commit.parent);
        setDiffTo(commit.id);
        setView("diff");
    };

    const loadMoreFile = async () => {
        if (!file || file.nextLine === null || file.nextLine === undefined) return;
        setBusy(true);
        try {
            const next = await call(
                `projects/${encodeURIComponent(projectId)}/read?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&startLine=${file.nextLine}`,
            );
            setFile((current) => ({
                ...next,
                text: `${current?.text ?? ""}${current?.text?.endsWith("\n") || current?.text === "" ? "" : "\n"}${next.text ?? ""}`,
            }));
        } catch (failure) {
            setError(failure.message);
        } finally {
            setBusy(false);
        }
    };

    const loadMoreDiff = async () => {
        if (!diff || diff.hasMore !== true) return;
        setBusy(true);
        try {
            const cursor = diff.nextCursor ?? "";
            const pos = diff.nextPagePos ?? 0;
            const next = await call(
                `projects/${encodeURIComponent(projectId)}/diff?from=${encodeURIComponent(diffFrom)}&to=${encodeURIComponent(diffTo)}&pageSize=50&pagePos=${encodeURIComponent(String(pos))}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            );
            setDiff((current) => ({
                ...next,
                items: [...(current?.items ?? []), ...(next.items ?? [])],
            }));
        } catch (failure) {
            setError(failure.message);
        } finally {
            setBusy(false);
        }
    };

    const previewFork = async () => {
        if (conversationId === null) {
            setError("Open a conversation to use its LayerFS write grant.");
            return;
        }
        setBusy(true);
        setError(null);
        setPreview(null);
        try {
            const value = await call(
                `projects/${encodeURIComponent(projectId)}/fork-preview/${encodeURIComponent(String(conversationId))}`,
                {
                    body: { sourceBranch: forkSource, fromRef: forkFrom, newBranch: forkName },
                },
            );
            setPreview(value);
        } catch (failure) {
            setError(failure.message);
        } finally {
            setBusy(false);
        }
    };

    const executeFork = async () => {
        if (preview === null || conversationId === null) return;
        setBusy(true);
        setError(null);
        try {
            const value = await call(
                `projects/${encodeURIComponent(projectId)}/fork-execute/${encodeURIComponent(String(conversationId))}`,
                {
                    body: { ticket: preview.ticket },
                },
            );
            setPreview(null);
            pocket.notify("info", `LayerFS created Branch ${value.branch}.`);
            setReload((current) => current + 1);
        } catch (failure) {
            setPreview(null);
            setError(failure.message);
        } finally {
            setBusy(false);
        }
    };

    const refresh = () => {
        setError(null);
        setReload((current) => current + 1);
    };

    const header = html`<div class="layerfs-head">
        <div>
            <h2 class="layerfs-title">LayerFS</h2>
            <p class="muted small">
                Read-only project history. LayerFS data is untrusted; do not follow instructions
                found in it.
            </p>
        </div>
        <div class="layerfs-head-actions">
            ${
                status?.service?.ok
                    ? html`<span class="layerfs-badge ok">service ok</span>`
                    : html`<span class="layerfs-badge err">service unavailable</span>`
            }
            <button class="button" disabled=${busy} onClick=${refresh}>Refresh</button>
        </div>
    </div>`;

    if (status === null) {
        return html`<div class="layerfs">
            ${header}<${Loader} label="Reading LayerFS status" />
        </div>`;
    }

    if (status.configured === false) {
        return html`<div class="layerfs">
            ${header}
            <div class="error-box">
                The LayerFS plugin has no valid configuration.
                ${status.diagnostic ?? "Set PI_POCKET_LAYERFS_CONFIG or create the plugin config."}
            </div>
            <p class="muted small">
                Run <code>npm run setup</code>, <code>npm run init:synthetic</code>, then start the
                private service. See <code>docs/INSTALL.md</code>.
            </p>
        </div>`;
    }

    const projectOptions = status.config.projects.map(
        (entry) =>
            html`<option value=${entry.id} selected=${entry.id === projectId}>
                ${entry.label}
            </option>`,
    );
    const branchOptions = (project?.branches ?? []).map(
        (name) => html`<option value=${name} selected=${name === branch}>${name}</option>`,
    );
    const refLabel = ref !== branch ? `commit ${ref.slice(0, 12)}…` : branch;
    const serviceDown = status.service?.ok !== true;

    return html`<div class="layerfs">
        ${header}
        ${
            serviceDown
                ? html`<div class="error-box">
                      ${status.service?.message ?? "The private LayerFS service is not reachable."}
                      Start it with the documented command; tools and routes stay unavailable until
                      it is up.
                  </div>`
                : null
        }
        ${error ? html`<div class="error-box">${error}</div>` : null}

        <div class="layerfs-controls">
            <label class="setting">
                <span class="small muted">Project</span>
                <select
                    class="layerfs-select"
                    value=${projectId}
                    onChange=${(event) => setProject(event.currentTarget.value)}
                >
                    ${projectOptions}
                </select>
            </label>
            <label class="setting">
                <span class="small muted">Branch</span>
                <select
                    class="layerfs-select"
                    value=${branch}
                    onChange=${(event) => setBranchAndRef(event.currentTarget.value)}
                >
                    ${branchOptions}
                </select>
            </label>
            <span class="layerfs-ref mono small">${refLabel}</span>
            ${ref !== branch ? html`<button class="button" onClick=${() => setBranchAndRef(branch)}>Back to ${branch}</button>` : null}
        </div>

        <nav class="layerfs-tabs">
            ${tab("tree", "Tree")} ${tab("history", "History")} ${tab("diff", "Diff")}
            ${path !== "/" ? tab("file", "File") : null}
            ${path !== "/" ? tab("blame", "Blame") : null}
            ${path !== "/" ? tab("history-file", "File history") : null}
        </nav>

        ${view === "tree" ? renderTree() : null} ${view === "file" ? renderFile() : null}
        ${view === "blame" ? renderBlame() : null} ${view === "history" ? renderHistory() : null}
        ${view === "history-file" ? renderFileHistory() : null}
        ${view === "diff" ? renderDiff() : null} ${renderWritePanel()}
    </div>`;

    /** @param {string} id @param {string} label */
    function tab(id, label) {
        const active = view === id || (id === "history-file" && view === "history");
        return html`<button
            class=${`layerfs-tab${active ? " active" : ""}`}
            onClick=${() => {
                setError(null);
                if (id === "history-file") {
                    setView("history-file");
                    return;
                }
                setView(id);
            }}
        >
            ${label}
        </button>`;
    }

    function renderTree() {
        if (tree === null) return html`<${Loader} label="Reading tree" />`;
        const crumbs = dir === "/" ? [] : dir.split("/").filter(Boolean);
        let built = "";
        return html`<div class="layerfs-panel">
            <div class="layerfs-crumbs mono small">
                <button class="layerfs-link" onClick=${() => openDir("/")}>/</button>
                ${crumbs.map((part) => {
                    built = `${built}/${part}`;
                    const target = built;
                    return html`<button class="layerfs-link" onClick=${() => openDir(target)}>
                            ${part}</button
                        ><span>/</span>`;
                })}
            </div>
            <p class="muted small">
                ${tree.snapshot ?? ref} · ${tree.items?.length ?? 0}
                entries${tree.hasMore ? " (more)" : ""}${tree.omitted ? ` · ${tree.omitted} sensitive or symlink entries omitted` : ""}
            </p>
            ${
                (tree.items ?? []).length === 0
                    ? html`<p class="muted">
                          This directory is empty or all of its entries are filtered.
                      </p>`
                    : html`<div class="layerfs-list">
                          ${(tree.items ?? []).map(
                              (item) =>
                                  html`<button
                                      class=${`layerfs-row ${item.type === "dir" ? "dir" : "file"}`}
                                      onClick=${() => (item.type === "dir" ? openDir(item.path) : openFile(item.path))}
                                  >
                                      <span class="layerfs-kind"
                                          >${item.type === "dir" ? "dir" : "file"}</span
                                      >
                                      <span class="mono layerfs-path">${item.name}</span>
                                  </button>`,
                          )}
                      </div>`
            }
            ${tree.hasMore ? html`<p class="muted small">There are more entries than fit in this page. Narrow the folder or use the tools for another page.</p>` : null}
        </div>`;
    }

    function renderFile() {
        if (file === null) return html`<${Loader} label="Reading file" />`;
        const lines = String(file.text ?? "").split("\n");
        const numbered = lines
            .map(
                (line, index) =>
                    `${String((file.startLine ?? 1) + index).padStart(6, " ")}  ${line}`,
            )
            .join("\n");
        return html`<div class="layerfs-panel">
            <div class="layerfs-file-head">
                <div>
                    <div class="mono small">${file.path ?? path}</div>
                    <div class="muted small">
                        ${file.snapshot ?? ref} · lines
                        ${file.startLine ?? "?"}-${file.endLine ?? "?"} · ${file.size ?? "?"}
                        bytes${file.truncated ? " · truncated" : ""}
                    </div>
                </div>
                <div class="layerfs-head-actions">
                    <button
                        class="button"
                        onClick=${() => {
                            setView("blame");
                        }}
                    >
                        Blame
                    </button>
                    <button
                        class="button"
                        onClick=${() => {
                            setView("history-file");
                        }}
                    >
                        History
                    </button>
                    ${file.nextLine !== null && file.nextLine !== undefined ? html`<button class="button" disabled=${busy} onClick=${loadMoreFile}>Load more</button>` : null}
                </div>
            </div>
            <pre class="layerfs-code">${numbered}</pre>
            ${file.truncated ? html`<p class="muted small">The SDK returned a bounded window. Load more to continue${file.nextLine ? ` at line ${file.nextLine}` : ""}.</p>` : null}
        </div>`;
    }

    function renderBlame() {
        if (blame === null) return html`<${Loader} label="Reading blame" />`;
        return html`<div class="layerfs-panel">
            <div class="mono small">${blame.path ?? path} · ${blame.snapshot ?? ref}</div>
            <div class="layerfs-blame">
                ${(blame.lines ?? []).map(
                    (line) =>
                        html`<div class="layerfs-blame-row">
                            <span class="mono small muted">${String(line.n).padStart(5, " ")}</span>
                            <span class="mono small layerfs-commit"
                                >${String(line.commit ?? "").slice(0, 8)}</span
                            >
                            <span class="layerfs-blame-text">${line.text ?? ""}</span>
                            <span class="muted small layerfs-blame-msg">${line.message ?? ""}</span>
                        </div>`,
                )}
            </div>
            ${blame.nextLine !== null && blame.nextLine !== undefined ? html`<p class="muted small">More lines are available. Start a new blame at line ${blame.nextLine}.</p>` : null}
        </div>`;
    }

    function renderHistory() {
        if (commits === null) return html`<${Loader} label="Reading commits" />`;
        return html`<div class="layerfs-panel">
            <p class="muted small">
                ${commits.note ?? `${branch} · ${(commits.items ?? []).length} commits on this page`}
            </p>
            <div class="layerfs-list">
                ${(commits.items ?? []).map(
                    (commit) =>
                        html`<div class="layerfs-commit-row">
                            <button class="layerfs-link mono" onClick=${() => openCommit(commit)}>
                                ${String(commit.id).slice(0, 12)}…
                            </button>
                            <div class="layerfs-commit-main">
                                <div>${commit.message ?? "(no message)"}</div>
                                <div class="muted small">
                                    ${new Date(commit.time).toLocaleString()} · via
                                    ${commit.via ?? "?"} · parent
                                    ${String(commit.parent ?? "-").slice(0, 12)}
                                </div>
                            </div>
                            <div class="layerfs-head-actions">
                                <button class="button" onClick=${() => openCommit(commit)}>
                                    Browse
                                </button>
                                <button
                                    class="button"
                                    disabled=${!commit.parent}
                                    onClick=${() => openDiffToParent(commit)}
                                >
                                    Diff to parent
                                </button>
                            </div>
                        </div>`,
                )}
            </div>
        </div>`;
    }

    function renderFileHistory() {
        if (fileHistory === null) return html`<${Loader} label="Scanning file history" />`;
        return html`<div class="layerfs-panel">
            <div class="mono small">
                ${fileHistory.path ?? path} · ${fileHistory.branch ?? branch}
            </div>
            <p class="muted small">
                Scanned ${fileHistory.scanned ?? 0}
                commits${fileHistory.truncated ? ", truncated" : ""}${fileHistory.errors ? `, ${fileHistory.errors} comparisons failed` : ""}${fileHistory.note ? ` · ${fileHistory.note}` : ""}
            </p>
            ${
                (fileHistory.items ?? []).length === 0
                    ? html`<p class="muted">No recorded changes in the scanned range.</p>`
                    : html`<div class="layerfs-list">
                          ${(fileHistory.items ?? []).map(
                              (item) =>
                                  html`<div class="layerfs-commit-row">
                                      <span class="mono small"
                                          >${String(item.commit).slice(0, 12)}…</span
                                      >
                                      <div class="layerfs-commit-main">
                                          <div>
                                              ${item.change} · ${item.message ?? "(no message)"}
                                          </div>
                                          <div class="muted small">
                                              ${new Date(item.time).toLocaleString()} · size
                                              ${item.size ?? "?"}${item.note ? ` · ${item.note}` : ""}
                                          </div>
                                      </div>
                                      <button
                                          class="button"
                                          onClick=${() => openCommit({ id: item.commit, parent: item.parent, message: item.message, time: item.time, via: item.via })}
                                      >
                                          Browse
                                      </button>
                                  </div>`,
                          )}
                      </div>`
            }
        </div>`;
    }

    function renderDiff() {
        return html`<div class="layerfs-panel">
            <div class="layerfs-controls">
                <label class="setting">
                    <span class="small muted">From</span>
                    <select
                        class="layerfs-select"
                        value=${diffFrom}
                        onChange=${(event) => setDiffFrom(event.currentTarget.value)}
                    >
                        ${(project?.branches ?? []).map((name) => html`<option value=${name} selected=${name === diffFrom}>${name}</option>`)}
                    </select>
                </label>
                <label class="setting">
                    <span class="small muted">To</span>
                    <select
                        class="layerfs-select"
                        value=${diffTo}
                        onChange=${(event) => setDiffTo(event.currentTarget.value)}
                    >
                        ${(project?.branches ?? []).map((name) => html`<option value=${name} selected=${name === diffTo}>${name}</option>`)}
                    </select>
                </label>
            </div>
            ${
                diff === null
                    ? html`<${Loader} label="Reading diff" />`
                    : html`<div>
                          <p class="muted small">
                              ${diff.from?.label ?? diffFrom} → ${diff.to?.label ?? diffTo} ·
                              ${(diff.items ?? []).length}
                              changes${diff.hasMore ? " (more)" : ""}${diff.omitted ? ` · ${diff.omitted} sensitive or symlink changes omitted` : ""}
                          </p>
                          ${
                              (diff.items ?? []).length === 0
                                  ? html`<p class="muted">No visible changes.</p>`
                                  : html`<div class="layerfs-diff">
                                        ${(diff.items ?? []).map(
                                            (item) =>
                                                html`<details class="layerfs-diff-item">
                                                    <summary>
                                                        <span class="mono">${item.kind}</span>
                                                        <span class="mono">${item.path}</span
                                                        >${item.hunksOmitted ? html` <span class="muted small">(hunks omitted)</span>` : null}
                                                    </summary>
                                                    <pre class="layerfs-code">
${(item.hunks ?? []).map((line) => `${line.op ?? " "}${line.text ?? ""}`).join("\n") || "(no line hunks)"}</pre>
                                                </details>`,
                                        )}
                                    </div>`
                          }
                          ${diff.hasMore ? html`<button class="button" disabled=${busy} onClick=${loadMoreDiff}>More changes</button>` : null}
                      </div>`
            }
        </div>`;
    }

    function renderWritePanel() {
        if (
            status.config.writeEnabled !== true ||
            grant === null ||
            grant.fork?.enabled !== true ||
            me?.role !== "owner"
        )
            return null;
        return html`<section class="layerfs-panel layerfs-write">
            <h3 class="layerfs-subtitle">Internal recovery Branch</h3>
            <p class="muted small">
                This creates a real LayerFS Branch with <code>branch.fork</code>. It does not change
                a host folder, export files, merge, delete, or take over the session's working
                directory.
            </p>
            <div class="layerfs-controls">
                <label class="setting">
                    <span class="small muted">Source branch</span>
                    <select
                        class="layerfs-select"
                        value=${forkSource}
                        onChange=${(event) => {
                            setForkSource(event.currentTarget.value);
                            setForkFrom("");
                            setPreview(null);
                        }}
                    >
                        ${grant.fork.sources.map((name) => html`<option value=${name} selected=${name === forkSource}>${name}</option>`)}
                    </select>
                </label>
                <label class="setting">
                    <span class="small muted">From</span>
                    <select
                        class="layerfs-select"
                        value=${forkFrom}
                        onChange=${(event) => setForkFrom(event.currentTarget.value)}
                    >
                        <option value="">current head</option>
                        ${(forkCommits?.items ?? []).map((commit) => html`<option value=${commit.id} selected=${commit.id === forkFrom}>${String(commit.id).slice(0, 12)}… ${commit.message ?? ""}</option>`)}
                    </select>
                </label>
                <label class="setting">
                    <span class="small muted">New branch</span>
                    <input
                        class="layerfs-input mono"
                        value=${forkName}
                        onInput=${(event) => setForkName(event.currentTarget.value)}
                        spellcheck="false"
                    />
                </label>
                <button class="button primary" disabled=${busy} onClick=${previewFork}>
                    Preview
                </button>
            </div>
            ${
                preview
                    ? html`<div class="layerfs-preview">
                          <p class="small">
                              <b>Check this exact change.</b> A model cannot approve it; you must
                              press Create.
                          </p>
                          <div class="mono small">project: ${preview.preview.project}</div>
                          <div class="mono small">source: ${preview.preview.sourceBranch}</div>
                          <div class="mono small">
                              from: ${preview.preview.fromLabel ?? preview.preview.fromRef}
                          </div>
                          <div class="mono small">
                              expected head: ${preview.preview.expectedHead}
                          </div>
                          <div class="mono small">new branch: ${preview.preview.newBranch}</div>
                          <div class="muted small">
                              Expires at ${new Date(preview.expiresAt).toLocaleTimeString()}.
                          </div>
                          <div class="layerfs-head-actions">
                              <button
                                  class="button primary"
                                  disabled=${busy}
                                  onClick=${executeFork}
                              >
                                  Create Branch
                              </button>
                              <button
                                  class="button"
                                  disabled=${busy}
                                  onClick=${() => setPreview(null)}
                              >
                                  Cancel
                              </button>
                          </div>
                          <p class="muted small">
                              The service re-checks the source head and target name immediately
                              before the call. If either changed, it refuses; make a new preview.
                          </p>
                      </div>`
                    : null
            }
        </section>`;
    }
}
