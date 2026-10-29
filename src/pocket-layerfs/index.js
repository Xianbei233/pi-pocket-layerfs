// LayerFS's browser module: a rail button, a menu row, a launcher action, and
// one owner-only page. The page reads the module's owner routes; it never
// uses innerHTML and never renders LayerFS text as Markdown or HTML.
//
// This file is served to the owner's tabs by Pi Pocket. Keep no secret here.

/** The version of `pocket` this module was written for. */
export const pocketApi = 1;

import { LayerfsPage } from "./app.js";

/**
 * @param {import("../_pocket.d.ts").Pocket} pocket
 */
export default function setup(pocket) {
    pocket.style("styles.css");
    const page = pocket.page({ id: "layerfs", title: "LayerFS", component: LayerfsPage });
    const rail = pocket.rail({ id: "layerfs", title: "LayerFS", icon: "folder", page: "layerfs" });
    const menu = pocket.menu({
        id: "layerfs",
        label: "LayerFS",
        hint: "projects and history",
        page: "layerfs",
    });
    const launcher = pocket.launcher({
        id: "layerfs",
        label: "LayerFS",
        detail: "projects, branches, commits, files",
        icon: "folder",
        keywords: ["layerfs", "branches", "history", "diff", "blame"],
        page: "layerfs",
    });

    pocket.onDispose(() => {
        page.remove();
        rail.remove();
        menu.remove();
        launcher.remove();
    });
}
