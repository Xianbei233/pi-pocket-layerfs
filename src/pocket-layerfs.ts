/**
 * LayerFS for Pi Pocket: a read-only history page with a visible owner
 * Configuration view, owner-only routes, nine read-only tools bound to the
 * current requester, and a safe owner-confirmed import of a source tree into a
 * new private Store.
 *
 * This module never downloads or builds LayerFS, never runs Docker, never
 * follows a source link, and never passes a source path to native code. The
 * owner runs the reviewed setup and the private service first.
 *
 * The active implementation lives in the versioned folder `./pocket-layerfs/v3`.
 * Pi Pocket reloads this entry module but not changed helpers; a new version
 * folder gives every changed helper a new module URL. No server restart and no
 * `host.reload` is needed.
 */
export { default, pocketApi } from "./pocket-layerfs/v3/index.ts";
