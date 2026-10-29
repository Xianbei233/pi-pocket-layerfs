/**
 * The visible Configuration view inside LayerFS.
 *
 * It edits a small draft (labels, existing branches, the read-only tools
 * switch, and explicit conversation grants), shows saved/plugin/service
 * hashes, and runs the safe import preview/confirm. It never displays or
 * accepts a token, socket, SDK, Store, or owner id.
 */
import { t } from "./i18n.js";

/** @param {{ pocket: any, onApplied: () => void }} props */
export function ConfigurationPanel({ pocket, onApplied }) {
    const { html, useEffect, useState } = pocket;
    const [overview, setOverview] = useState(null);
    const [sessions, setSessions] = useState([]);
    const [imports, setImports] = useState([]);
    const [draft, setDraft] = useState(null);
    const [errors, setErrors] = useState([]);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);
    const [failure, setFailure] = useState(null);
    const [sourcePath, setSourcePath] = useState("");
    const [importProjectId, setImportProjectId] = useState("");
    const [importLabel, setImportLabel] = useState("");
    const [preview, setPreview] = useState(null);
    const [confirmed, setConfirmed] = useState(null);
    const [detail, setDetail] = useState(null);
    const [effective, setEffective] = useState(null);

    const api = (path, body) =>
        pocket.api(path, body, { method: body === undefined ? "GET" : "POST" });

    const fromOverview = (value) => ({
        projects: (value.projects ?? []).map((project) => ({
            id: project.id,
            label: project.label,
            branches: [...project.branches],
        })),
        toolsEnabled: value.toolsEnabled === true,
        sessionGrants: (value.sessionGrants ?? []).map((grant) => ({
            conversationId: grant.conversationId,
            project: grant.project,
            allowTools: grant.allowTools,
            toolBranches: [...grant.toolBranches],
        })),
    });

    const load = async () => {
        const value = await api("gui/overview");
        setOverview(value);
        setDraft(fromOverview(value));
        try {
            const list = await api("gui/sessions");
            setSessions(list.sessions ?? []);
        } catch {
            setSessions([]);
        }
        try {
            const stores = await api("gui/imports");
            setImports(stores.stores ?? []);
        } catch {
            setImports([]);
        }
    };

    useEffect(() => {
        let stop = false;
        (async () => {
            try {
                const value = await api("gui/overview");
                if (stop) return;
                setOverview(value);
                setDraft(fromOverview(value));
                try {
                    const list = await api("gui/sessions");
                    if (!stop) setSessions(list.sessions ?? []);
                } catch {
                    if (!stop) setSessions([]);
                }
                try {
                    const stores = await api("gui/imports");
                    if (!stop) setImports(stores.stores ?? []);
                } catch {
                    if (!stop) setImports([]);
                }
            } catch (error) {
                if (!stop) setFailure(error.message);
            }
        })();
        const conversationId = pocket.conversationId();
        if (conversationId !== null) {
            api(`session/${encodeURIComponent(String(conversationId))}/status`)
                .then(setEffective)
                .catch(() => setEffective(null));
        }
        return () => {
            stop = true;
        };
    }, []);

    const run = async (action) => {
        setBusy(true);
        setFailure(null);
        setMessage(null);
        setErrors([]);
        try {
            return await action();
        } catch (error) {
            setFailure(error.message);
            return null;
        } finally {
            setBusy(false);
        }
    };

    const validate = () =>
        run(async () => {
            const result = await api("gui/validate", { draft });
            setErrors(result.errors ?? []);
            if ((result.errors ?? []).length === 0) setMessage(t("ok"));
        });

    const apply = () =>
        run(async () => {
            const result = await api("gui/apply", {
                expectedSha256: overview.savedHash,
                draft,
            });
            setMessage(`${t("ok")} · ${short(result.savedHash)}`);
            await load();
            onApplied?.();
            return result;
        });

    const check = () =>
        run(async () => {
            const result = await api("gui/check", {});
            setMessage(`${t("status")}: ${t(result.state === "active" ? "active" : "unknown")}`);
            await load();
            return result;
        });

    const previewImport = () =>
        run(async () => {
            setPreview(null);
            setConfirmed(null);
            const result = await api("gui/import/preview", {
                expectedSha256: overview.savedHash,
                projectId: importProjectId,
                label: importLabel,
                sourcePath,
                branches: ["main"],
            });
            setPreview(result);
            return result;
        });

    const confirmImport = () =>
        run(async () => {
            const result = await api("gui/import/confirm", {
                ticket: preview.ticket,
                expectedSha256: overview.savedHash,
            });
            setConfirmed(result);
            setPreview(null);
            const stores = await api("gui/imports");
            setImports(stores.stores ?? []);
            setDraft((current) =>
                current.projects.some((project) => project.id === result.projectId)
                    ? current
                    : {
                          ...current,
                          projects: [
                              ...current.projects,
                              {
                                  id: result.projectId,
                                  label: importLabel,
                                  branches: result.branches,
                              },
                          ],
                      },
            );
            setMessage(t("confirm-hint"));
            return result;
        });

    const showDetail = (id) =>
        run(async () => {
            setDetail(await api(`gui/projects/${encodeURIComponent(id)}`));
        });

    const updateProject = (id, patch) =>
        setDraft((current) => ({
            ...current,
            projects: current.projects.map((project) =>
                project.id === id ? { ...project, ...patch } : project,
            ),
        }));

    const updateGrant = (index, patch) =>
        setDraft((current) => ({
            ...current,
            sessionGrants: current.sessionGrants.map((grant, at) =>
                at === index ? { ...grant, ...patch } : grant,
            ),
        }));

    const addGrant = () =>
        setDraft((current) => {
            const used = new Set(current.sessionGrants.map((grant) => grant.conversationId));
            const conversationId =
                sessions.find((session) => !used.has(session.id))?.id ?? sessions[0]?.id ?? "";
            const project = current.projects[0];
            return {
                ...current,
                sessionGrants: [
                    ...current.sessionGrants,
                    {
                        conversationId,
                        project: project?.id ?? "",
                        allowTools: false,
                        toolBranches: [],
                    },
                ],
            };
        });

    const removeGrant = (index) =>
        setDraft((current) => ({
            ...current,
            sessionGrants: current.sessionGrants.filter((_grant, at) => at !== index),
        }));

    if (overview === null || draft === null) {
        return html`<div class="layerfs-panel">
            <p class="muted">${failure ?? t("status")}</p>
        </div>`;
    }

    const sessionName = (id) => {
        const found = sessions.find((session) => session.conversationId === id);
        return found
            ? `${found.title || id}${found.archived ? " · " + t("unknown") : ""}`
            : id || "—";
    };
    const projectOf = (id) => draft.projects.find((project) => project.id === id) ?? null;

    const stateLabel = t(overview.state ?? "unconfigured");
    const serviceOk = overview.service?.ok === true;
    const mismatch =
        overview.activeHash !== overview.serviceHash || overview.savedHash !== overview.activeHash;

    return html`<div class="layerfs-panel layerfs-config">
        <div class="layerfs-config-head">
            <div>
                <h3 class="layerfs-subtitle">${t("config")}</h3>
                <p class="muted small">${t("save-first")}</p>
            </div>
            <div class="layerfs-head-actions">
                <button class="button" disabled=${busy} onClick=${() => load()}>
                    ${t("refresh")}
                </button>
                <button class="button" disabled=${busy} onClick=${check}>${t("check")}</button>
            </div>
        </div>

        <div class=${`layerfs-state ${serviceOk && !mismatch ? "ok" : "warn"}`}>
            <b>${stateLabel}</b>
            <span class="mono small">
                ${t("savedHash")}: ${short(overview.savedHash)} · ${t("activeHash")}:
                ${short(overview.activeHash)} · ${t("serviceHash")}: ${short(overview.serviceHash)}
            </span>
            <span class="mono small">
                ${t("service")}: ${serviceOk ? "ok" : (overview.service?.code ?? "down")} ·
                ${t("generation")}: ${overview.service?.generation ?? "?"}
            </span>
        </div>
        ${mismatch ? html`<div class="error-box">${t("hash-mismatch")}</div>` : null}
        ${failure ? html`<div class="error-box">${failure}</div>` : null}
        ${message ? html`<div class="muted small">${message}</div>` : null}
        ${
            errors.length > 0
                ? html`<ul class="layerfs-errors">
                      ${errors.map((error) => html`<li>${error.field}: ${error.message}</li>`)}
                  </ul>`
                : null
        }

        <label class="setting layerfs-inline">
            <input
                type="checkbox"
                checked=${draft.toolsEnabled}
                onChange=${(event) =>
                    setDraft((current) => ({
                        ...current,
                        toolsEnabled: event.currentTarget.checked,
                    }))}
            />
            <span>${t("tools")}</span>
        </label>
        <p class="muted small">
            ${t("write")}: ${overview.writeEnabled ? "on" : "off"} · ${t("fork")}:
            ${(overview.sessionGrants ?? []).filter((grant) => grant.fork?.enabled).length}
            (read-only here)
        </p>

        ${
            effective
                ? html`<div class="layerfs-state">
                      <b>${t("grants")}</b>
                      <span class="mono small">
                          ${effective.conversation?.title ?? effective.conversation?.id ?? ""} ·
                          ${effective.grant?.project ?? "—"} · ${t("allow-tools")}:
                          ${effective.grant?.allowTools ? "on" : "off"}
                      </span>
                      <span class="mono small">
                          ${t("tool-branches")}:
                          ${(effective.grant?.toolBranches ?? []).join(",") || "—"}
                      </span>
                  </div>`
                : null
        }

        <h4 class="layerfs-subtitle">${t("projects")}</h4>
        ${
            draft.projects.length === 0
                ? html`<p class="muted">${t("import")}</p>`
                : html`<div class="layerfs-list">
                      ${draft.projects.map(
                          (project) =>
                              html`<div class="layerfs-config-row">
                                  <div class="layerfs-commit-main">
                                      <div>
                                          <span class="mono small">${project.id}</span>
                                          ${
                                              (overview.projects ?? []).find(
                                                  (entry) => entry.id === project.id,
                                              )?.origin === "demo"
                                                  ? html`<span class="layerfs-badge"
                                                        >${t("demo")}</span
                                                    >`
                                                  : null
                                          }
                                      </div>
                                      <label class="setting">
                                          <span class="small muted">${t("label")}</span>
                                          <input
                                              class="layerfs-input"
                                              value=${project.label}
                                              onInput=${(event) =>
                                                  updateProject(project.id, {
                                                      label: event.currentTarget.value,
                                                  })}
                                          />
                                      </label>
                                      <label class="setting">
                                          <span class="small muted">${t("branches")}</span>
                                          <input
                                              class="layerfs-input mono"
                                              value=${project.branches.join(",")}
                                              onInput=${(event) =>
                                                  updateProject(project.id, {
                                                      branches: event.currentTarget.value
                                                          .split(",")
                                                          .map((name) => name.trim())
                                                          .filter(Boolean),
                                                  })}
                                          />
                                      </label>
                                  </div>
                                  <button
                                      class="button"
                                      disabled=${busy}
                                      onClick=${() => showDetail(project.id)}
                                  >
                                      ${t("details")}
                                  </button>
                              </div>`,
                      )}
                  </div>`
        }

        <h4 class="layerfs-subtitle">${t("grants")}</h4>
        <div class="layerfs-list">
            ${draft.sessionGrants.map((grant, index) => {
                const project = projectOf(grant.project);
                return html`<div class="layerfs-config-row">
                    <div class="layerfs-commit-main">
                        <label class="setting">
                            <span class="small muted">${t("conversation")}</span>
                            <select
                                class="layerfs-select"
                                value=${grant.conversationId}
                                onChange=${(event) =>
                                    updateGrant(index, {
                                        conversationId: event.currentTarget.value,
                                    })}
                            >
                                <option value="">—</option>
                                ${sessions.map(
                                    (session) =>
                                        html`<option
                                            value=${session.id}
                                            selected=${session.id === grant.conversationId}
                                        >
                                            ${session.title || session.id}
                                        </option>`,
                                )}
                            </select>
                        </label>
                        <div class="muted small">${sessionName(grant.conversationId)}</div>
                        <label class="setting">
                            <span class="small muted">${t("project")}</span>
                            <select
                                class="layerfs-select"
                                value=${grant.project}
                                onChange=${(event) =>
                                    updateGrant(index, {
                                        project: event.currentTarget.value,
                                        toolBranches: [],
                                    })}
                            >
                                ${draft.projects.map(
                                    (entry) =>
                                        html`<option
                                            value=${entry.id}
                                            selected=${entry.id === grant.project}
                                        >
                                            ${entry.label}
                                        </option>`,
                                )}
                            </select>
                        </label>
                        <label class="setting layerfs-inline">
                            <input
                                type="checkbox"
                                checked=${grant.allowTools}
                                onChange=${(event) =>
                                    updateGrant(index, {
                                        allowTools: event.currentTarget.checked,
                                    })}
                            />
                            <span>${t("allow-tools")}</span>
                        </label>
                        <div class="muted small">${t("tool-branches")}</div>
                        <div class="layerfs-inline">
                            ${(project?.branches ?? []).map(
                                (branch) =>
                                    html`<label class="setting layerfs-inline">
                                        <input
                                            type="checkbox"
                                            checked=${grant.toolBranches.includes(branch)}
                                            onChange=${(event) => {
                                                const next = event.currentTarget.checked
                                                    ? [...grant.toolBranches, branch]
                                                    : grant.toolBranches.filter(
                                                          (name) => name !== branch,
                                                      );
                                                updateGrant(index, {
                                                    toolBranches: [...new Set(next)],
                                                });
                                            }}
                                        />
                                        <span class="mono small">${branch}</span>
                                    </label>`,
                            )}
                        </div>
                    </div>
                    <button class="button" disabled=${busy} onClick=${() => removeGrant(index)}>
                        ${t("discard")}
                    </button>
                </div>`;
            })}
        </div>
        <div class="layerfs-head-actions">
            <button
                class="button"
                disabled=${busy || draft.projects.length === 0}
                onClick=${addGrant}
            >
                + ${t("grants")}
            </button>
            <button class="button" disabled=${busy} onClick=${validate}>${t("validate")}</button>
            <button class="button primary" disabled=${busy} onClick=${apply}>${t("save")}</button>
            <button
                class="button"
                disabled=${busy}
                onClick=${() => setDraft(fromOverview(overview))}
            >
                ${t("discard")}
            </button>
        </div>

        <h4 class="layerfs-subtitle">${t("import")}</h4>
        <p class="muted small">${t("source-hint")} ${t("global-ignore-hint")}</p>
        <div class="layerfs-controls">
            <label class="setting">
                <span class="small muted">${t("projectId")}</span>
                <input
                    class="layerfs-input mono"
                    value=${importProjectId}
                    onInput=${(event) => setImportProjectId(event.currentTarget.value.trim())}
                    spellcheck="false"
                />
            </label>
            <label class="setting">
                <span class="small muted">${t("label")}</span>
                <input
                    class="layerfs-input"
                    value=${importLabel}
                    onInput=${(event) => setImportLabel(event.currentTarget.value)}
                />
            </label>
            <label class="setting layerfs-wide">
                <span class="small muted">${t("sourcePath")}</span>
                <input
                    class="layerfs-input mono"
                    value=${sourcePath}
                    onInput=${(event) => setSourcePath(event.currentTarget.value)}
                    spellcheck="false"
                />
            </label>
            <button
                class="button primary"
                disabled=${busy || sourcePath === "" || importProjectId === ""}
                onClick=${previewImport}
            >
                ${t("preview")}
            </button>
        </div>
        <p class="muted small">
            ${t("limits")}: 5000 ${t("files")} · 64 MiB · 8 MiB/${t("files")} · depth 32
        </p>
        ${
            preview
                ? html`<div class="layerfs-preview">
                      <div class="mono small">${preview.projectId} · ${preview.label}</div>
                      <div class="muted small">
                          ${t("included")}: ${preview.files} ${t("files")} · ${preview.bytes}
                          ${t("bytes")} · ${t("excluded")}: ${preview.scanned - preview.files}
                      </div>
                      <div class="mono small">${short(preview.stageHash)}</div>
                      <div class="muted small">${(preview.notes ?? []).join(" ")}</div>
                      <details>
                          <summary>${t("excluded")}</summary>
                          <pre class="layerfs-code">
${(preview.excluded ?? []).map((entry) => `${entry.reason}  ${entry.path}`).join("\n")}</pre>
                      </details>
                      <div class="layerfs-head-actions">
                          <button class="button primary" disabled=${busy} onClick=${confirmImport}>
                              ${t("confirm")}
                          </button>
                          <button class="button" disabled=${busy} onClick=${() => setPreview(null)}>
                              ${t("discard")}
                          </button>
                      </div>
                      <p class="muted small">${t("confirm-hint")}</p>
                  </div>`
                : null
        }
        ${
            confirmed
                ? html`<div class="layerfs-preview">
                      <b>${t("unpublished")}</b>
                      <div class="mono small">
                          ${confirmed.projectId} · ${(confirmed.branches ?? []).join(",")}
                      </div>
                      <p class="muted small">${t("confirm-hint")}</p>
                  </div>`
                : null
        }

        <h4 class="layerfs-subtitle">${t("imports")}</h4>
        <div class="layerfs-list">
            ${imports.map(
                (store) =>
                    html`<div class="layerfs-config-row">
                        <span class="mono small">${store.projectId}</span>
                        <span>${store.label}</span>
                        <span class="muted small"
                            >${t(store.state === "published" ? "published" : "unpublished")}</span
                        >
                    </div>`,
            )}
        </div>

        ${
            detail
                ? html`<div class="layerfs-preview">
                      <div class="mono small">${detail.id} · ${detail.origin}</div>
                      <div class="muted small">${t("source")}: ${detail.sourcePath ?? "—"}</div>
                      <div class="muted small">
                          ${t("branches")}: ${(detail.branches ?? []).join(",")}
                      </div>
                      <button class="button" onClick=${() => setDetail(null)}>${t("close")}</button>
                  </div>`
                : null
        }
    </div>`;
}

/** @param {string | null} value */
function short(value) {
    if (typeof value !== "string") return "—";
    return `${value.slice(0, 12)}…`;
}
