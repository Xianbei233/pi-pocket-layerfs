// Independent native oracle. It writes only a new test-owned branch, never the imported branch.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

/** The actual pinned SDK client must supply these ordinary official operations. */
export async function assertBinarySnapshotBytes(options: {
    client: any;
    importRef: string;
    path: string;
    expected: Uint8Array;
}) {
    const { client, importRef, path, expected } = options;
    assert.ok(expected.length > 0, "Use a nonempty binary fixture for the one-bit negative control");
    await assert.rejects(client.fs.read(importRef, path, 1), (error: any) => error.code === "Binary");
    const branches = await client.project.list_branches(100, 0);
    const initial = branches.items.find((item: any) => item.name === importRef);
    assert.ok(initial, "Imported branch must exist");
    const oracleRef = "byte-oracle-" + randomBytes(6).toString("hex");
    await client.branch.fork(oracleRef, importRef);
    await client.fs.write(oracleRef, path, Buffer.from(expected), "Independent expected binary bytes");
    const equal = await client.fs.diff_files(importRef, path, oracleRef, path);
    assert.equal(equal.contentEqual, true, "Actual imported binary differs from expected bytes");
    const changed = Uint8Array.from(expected);
    changed[0] ^= 1;
    assert.equal(changed.length, expected.length);
    await client.fs.write(oracleRef, path, Buffer.from(changed), "Independent one-bit negative control");
    const different = await client.fs.diff_files(importRef, path, oracleRef, path);
    assert.equal(different.contentEqual, false, "Same-length one-bit difference was not detected");
    const after = await client.project.list_branches(100, 0);
    const unchanged = after.items.find((item: any) => item.name === importRef);
    assert.deepEqual(unchanged, initial, "The binary oracle changed the imported branch");
    return { path, importRef, oracleRef, byteLength: expected.length, equal, different, binaryReadRefused: true };
}
