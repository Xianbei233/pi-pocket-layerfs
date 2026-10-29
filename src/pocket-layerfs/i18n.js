/**
 * Plugin-local Chinese labels with an English fallback. No shared dictionary
 * and no locale pack: only this module's own text is translated.
 */
const CHINESE = String(
    (typeof document !== "undefined" && document.documentElement?.lang) ||
        (typeof navigator !== "undefined" && navigator.language) ||
        "",
)
    .toLowerCase()
    .startsWith("zh");

const STRINGS = {
    config: ["配置", "Configuration"],
    back: ["返回", "Back"],
    status: ["状态", "Status"],
    active: ["已生效", "Active"],
    "saved-pending": ["已保存，待应用", "Saved, pending apply"],
    "service-mismatch": ["服务配置不一致", "Service mismatch"],
    "service-down": ["服务未连接", "Service down"],
    unknown: ["结果未知", "Outcome unknown"],
    unconfigured: ["未配置", "Not configured"],
    "env-override": ["环境变量覆盖，只读", "Environment override, read-only"],
    savedHash: ["已保存哈希", "Saved hash"],
    activeHash: ["插件生效哈希", "Plugin active hash"],
    serviceHash: ["服务生效哈希", "Service active hash"],
    service: ["私有服务", "Private service"],
    generation: ["代次", "Generation"],
    projects: ["项目", "Projects"],
    project: ["项目", "Project"],
    label: ["名称", "Label"],
    branches: ["分支", "Branches"],
    tools: ["只读工具", "Read-only tools"],
    write: ["内部写权限", "Internal write"],
    grants: ["会话授权", "Conversation grants"],
    conversation: ["会话", "Conversation"],
    "allow-tools": ["允许工具", "Allow tools"],
    "tool-branches": ["工具分支", "Tool branches"],
    fork: ["恢复分支写入", "Recovery fork"],
    save: ["保存并应用", "Save and apply"],
    discard: ["放弃修改", "Discard"],
    check: ["检查状态", "Check status"],
    validate: ["校验", "Validate"],
    preview: ["预览导入", "Preview import"],
    confirm: ["确认导入", "Confirm import"],
    import: ["导入项目", "Import project"],
    sourcePath: ["源目录（绝对路径）", "Source folder (absolute path)"],
    projectId: ["项目 ID", "Project id"],
    imports: ["导入记录", "Imports"],
    unpublished: ["未发布 Store", "Unpublished Store"],
    published: ["已发布", "Published"],
    demo: ["演示", "Demo"],
    limits: ["导入限制", "Import limits"],
    details: ["详情", "Details"],
    source: ["源目录", "Source folder"],
    files: ["文件", "Files"],
    bytes: ["字节", "Bytes"],
    excluded: ["已排除", "Excluded"],
    included: ["已包含", "Included"],
    expired: ["已过期", "Expired"],
    close: ["关闭", "Close"],
    refresh: ["刷新", "Refresh"],
    "no-sessions": ["没有可用的会话列表", "No session list is available"],
    "save-first": ["先保存并应用，工具开关才会生效", "Apply once to activate tool changes"],
    ok: ["完成", "Done"],
    error: ["错误", "Error"],
    "confirm-hint": [
        "确认后创建未发布 Store；随后点“保存并应用”发布项目。",
        "Confirm creates an unpublished Store; then use Save and apply to publish the project.",
    ],
    "source-hint": [
        "只导入过滤后的快照；源目录之后的变化需要重新导入。",
        "Only a filtered snapshot is imported; later source changes need another import.",
    ],
    "global-ignore-hint": [
        "不读取全局 Git 排除、.git/info/exclude 或工作树指针。",
        "Global Git excludes, .git/info/exclude, and worktree pointers are not read.",
    ],
    "origin-demo": ["演示项目元数据", "Demo project metadata"],
    "hash-mismatch": [
        "插件与服务配置不一致。请点“检查状态”，不要反复重试。",
        "The plugin and service configs differ. Use Check status; do not retry repeatedly.",
    ],
};

/**
 * @param {string} key
 */
export function t(key) {
    const pair = STRINGS[key];
    if (pair === undefined) return key;
    return CHINESE ? pair[0] : pair[1];
}

export function isChinese() {
    return CHINESE;
}
