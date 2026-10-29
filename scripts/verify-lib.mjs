/**
 * Installed-SDK provenance.
 *
 * The UPSTREAM.json marker lives inside the SDK and can be forged together
 * with the SDK. It is therefore not the trust root. Verification uses, in
 * order:
 *
 * 1. the project's reviewed pin (`upstream.lock.json`, outside every runtime):
 *    the full content hash of the official `sdk/js` tree and the hashes of
 *    reviewed native builds;
 * 2. a private build receipt *outside* the SDK (`<runtime>/trust/`), written
 *    by the installer after it verified the official source tree and built the
 *    addon, or explicitly by the owner (`setup --authorize-native`).
 *
 * Every check hashes real file content. Nothing here imports or executes the
 * SDK, and nothing downloads, builds, or starts anything.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hashFile } from "./install-lib.mjs";
import { assertExclusiveRuntime, assertReplaceable, treeHash } from "./runtime-lib.mjs";

/** Path of the SDK-external receipt, relative to the exclusive runtime. */
export const RECEIPT_RELATIVE = "trust/sdk-receipt.json";
const RECEIPT_NAME = "pi-pocket-layerfs-sdk-receipt";
const RECEIPT_METHODS = new Set(["official-build", "owner-authorized"]);
const RECEIPT_MAX = 32 * 1024;
const JSON_MAX = 512 * 1024;
const NO_RECEIPT =
    "The installed SDK is not the reviewed official build and has no trusted build receipt. Re-run setup from the verified source, or record a reviewed build explicitly; see docs/SECURITY.md.";

/**
 * The SDK's JavaScript content excludes the native folder (the binary is
 * hashed on its own) and the marker (checked separately, never trusted).
 */
export const SDK_CONTENT_EXCLUDE = ["native", "UPSTREAM.json"];

/**
 * @param {string} projectRoot
 * @returns {any}
 */
export function loadPin(projectRoot) {
    return JSON.parse(readFileSync(join(projectRoot, "upstream.lock.json"), "utf8"));
}

/**
 * Content hash of everything in the SDK that Node may import, plus its
 * package metadata and the test/operator files copied from the official tree.
 *
 * @param {string} sdkPath
 * @returns {string}
 */
export function sdkContentHash(sdkPath) {
    return treeHash(sdkPath, SDK_CONTENT_EXCLUDE);
}

/**
 * @param {string} path
 * @param {string} label
 * @param {number} [max]
 * @returns {any}
 */
function readRegularJson(path, label, max = JSON_MAX) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
    if (info.size > max) throw new Error(`${label} is too large`);
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new Error(`${label} is not valid JSON`);
    }
}

/**
 * @param {string} sdkPath
 * @returns {string}
 */
function nativeHash(sdkPath) {
    const native = join(sdkPath, "native", "layerfs.node");
    const info = lstatSync(native);
    if (!info.isFile() || info.isSymbolicLink())
        throw new Error("The installed native addon must be a regular file");
    if (info.size === 0) throw new Error("The installed native addon is empty");
    return hashFile(native);
}

/**
 * Verify the installed SDK and native addon against the pin, or against a
 * matching private build receipt when the content is not the reviewed
 * official build (for example a receipt recorded by the owner for a local
 * toolchain). Throws with a fixed diagnostic otherwise. Read-only.
 *
 * @param {string} projectRoot
 * @param {string} sdkPath
 * @param {{ requireOfficialSdk?: boolean }} [options] `requireOfficialSdk` is
 *   for setup: the SDK tree itself must be the pinned official tree, while the
 *   native addon may still be vouched for by a receipt.
 * @returns {{ version: string, commit: string, tag: string, archiveSha256: string, sdkTreeSha256: string, nativeSha256: string, trust: string }}
 */
export function verifySdkProvenance(projectRoot, sdkPath, options = {}) {
    const pin = loadPin(projectRoot);
    const sdk = resolve(sdkPath);
    const runtime = assertExclusiveRuntime(dirname(sdk), { create: false });
    if (sdk !== join(runtime, "sdk"))
        throw new Error("The installed SDK must be <runtime>/sdk inside the exclusive runtime");
    if (lstatSync(sdk).isSymbolicLink()) throw new Error("The installed SDK must not be a link");

    const marker = readRegularJson(join(sdk, "UPSTREAM.json"), "The installed SDK marker");
    const pkg = readRegularJson(join(sdk, "package.json"), "The installed SDK package.json");
    if (
        marker?.commit !== pin.commit ||
        marker?.tag !== pin.tag ||
        marker?.version !== pin.version
    ) {
        throw new Error(
            "The installed SDK marker does not match the pinned tag, commit, and version",
        );
    }
    if (marker?.archiveSha256 !== pin.archive?.sha256)
        throw new Error("The installed SDK marker archive hash does not match the pin");
    if (pkg?.version !== pin.version)
        throw new Error("The installed SDK version does not match the pin");

    const sdkTreeSha256 = sdkContentHash(sdk);
    const nativeSha256 = nativeHash(sdk);
    const pinnedNative = Array.isArray(pin.nativeBuilds)
        ? pin.nativeBuilds.some((entry) => entry && entry.sha256 === nativeSha256)
        : false;
    const base = {
        version: pin.version,
        commit: pin.commit,
        tag: pin.tag,
        archiveSha256: pin.archive?.sha256 ?? "",
        sdkTreeSha256,
        nativeSha256,
    };

    if (pin.sdk?.treeSha256 === sdkTreeSha256 && pinnedNative) {
        return { ...base, trust: "official-pin" };
    }
    if (options.requireOfficialSdk === true && pin.sdk?.treeSha256 !== sdkTreeSha256) {
        // A receipt can vouch for a reviewed local native build; it never makes
        // synthetic or otherwise changed SDK JavaScript official.
        throw new Error(
            "Setup requires the pinned official SDK tree; a receipt cannot authorize synthetic or changed SDK content",
        );
    }

    const trustDir = join(runtime, "trust");
    let trustInfo;
    try {
        trustInfo = lstatSync(trustDir);
    } catch {
        throw new Error(NO_RECEIPT);
    }
    // Reader-side checks: the writer's guarantees are not inherited from the
    // filesystem, and the receipt is not read before its folder is trusted.
    if (trustInfo.isSymbolicLink() || !trustInfo.isDirectory())
        throw new Error("The SDK trust folder must be a real directory, not a link");
    if (typeof process.getuid === "function" && trustInfo.uid !== process.getuid())
        throw new Error("The SDK trust folder must be owned by the current user");
    if ((trustInfo.mode & 0o777) !== 0o700)
        throw new Error("The SDK trust folder must be mode 0700");

    const receiptPath = join(runtime, "trust", "sdk-receipt.json");
    assertReplaceable(runtime, receiptPath);
    let receiptInfo;
    try {
        receiptInfo = lstatSync(receiptPath);
    } catch {
        throw new Error(NO_RECEIPT);
    }
    if (receiptInfo.isSymbolicLink() || !receiptInfo.isFile())
        throw new Error("The SDK build receipt must be a regular file");
    if ((receiptInfo.mode & 0o077) !== 0)
        throw new Error("The SDK build receipt must be mode 0600");
    if (typeof process.getuid === "function" && receiptInfo.uid !== process.getuid())
        throw new Error("The SDK build receipt must be owned by the current user");
    if (receiptInfo.size > RECEIPT_MAX) throw new Error("The SDK build receipt is too large");
    let receipt;
    try {
        receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    } catch {
        throw new Error("The SDK build receipt is not valid JSON");
    }
    if (receipt?.name !== RECEIPT_NAME || receipt?.receiptVersion !== 1)
        throw new Error("The SDK build receipt is not recognized");
    if (!RECEIPT_METHODS.has(receipt?.method))
        throw new Error("The SDK build receipt has an unknown method");
    if (
        receipt.repo !== pin.repo ||
        receipt.tag !== pin.tag ||
        receipt.commit !== pin.commit ||
        receipt.pinVersion !== pin.version ||
        receipt.archiveSha256 !== pin.archive?.sha256
    ) {
        throw new Error("The SDK build receipt does not match the pin");
    }
    if (receipt.sdkTreeSha256 !== sdkTreeSha256)
        throw new Error("The installed SDK content does not match its build receipt");
    if (receipt.nativeSha256 !== nativeSha256)
        throw new Error("The installed native addon does not match its build receipt");
    return { ...base, trust: `receipt:${receipt.method}` };
}

/**
 * Record a private receipt outside the SDK for the content currently at
 * `<runtime>/sdk`. The installer calls this only after verifying the official
 * source tree and building the addon; the owner calls it explicitly via
 * `setup --authorize-native`. Tests that run their own synthetic SDK record
 * the same receipt (see docs/TEST-SEAMS.md); this is a trust record, not a
 * verification bypass.
 *
 * @param {string} projectRoot
 * @param {string} runtime
 * @param {string} method
 * @returns {any}
 */
export function writeTrustReceipt(projectRoot, runtime, method) {
    if (!RECEIPT_METHODS.has(method))
        throw new Error("The receipt method must be official-build or owner-authorized");
    const runtimeReal = assertExclusiveRuntime(runtime, { create: false });
    const sdk = join(runtimeReal, "sdk");
    const sdkTreeSha256 = sdkContentHash(sdk);
    const nativeSha256 = nativeHash(sdk);
    const pin = loadPin(projectRoot);
    const trustDir = join(runtimeReal, "trust");
    assertReplaceable(runtimeReal, trustDir);
    let dirInfo;
    try {
        dirInfo = lstatSync(trustDir);
    } catch {
        mkdirSync(trustDir, { recursive: false, mode: 0o700 });
        dirInfo = lstatSync(trustDir);
    }
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory())
        throw new Error("The trust folder must be a real directory");
    if (typeof process.getuid === "function" && dirInfo.uid !== process.getuid())
        throw new Error("The trust folder must be owned by the current user");
    if ((dirInfo.mode & 0o777) !== 0o700) throw new Error("The trust folder must be mode 0700");
    const receipt = {
        name: RECEIPT_NAME,
        receiptVersion: 1,
        method,
        repo: pin.repo,
        tag: pin.tag,
        commit: pin.commit,
        pinVersion: pin.version,
        archiveSha256: pin.archive?.sha256 ?? "",
        sdkTreeSha256,
        nativeSha256,
        recordedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
    };
    const path = join(trustDir, "sdk-receipt.json");
    const temporary = join(trustDir, `.sdk-receipt.${process.pid}.${Date.now()}.new`);
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 4)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    return receipt;
}
