# Independent test acceptance

## Current GUI/import preparation — 0.3.0

The frozen contract is `.runtime-gui-contract-20261023/CONTRACT.md`.
The assigned tester is `layerfs-config-test`. Requested model: `hww/gpt-6.1-sol`.
Requested thinking: `high`. Actual model/thinking and usage fields: not obtained.
Historical provenance below applies to earlier work only.

`test/gui-import-fixtures.test.ts` runs fixture-quality checks only. It does not
import Pocket, business modules, or native SDK code. New private synthetic Git
roots use short paths. All source and failed evidence remain retained.
The test-side API adapter needs exact endpoint bindings from the freeze handoff.
The independent byte oracle needs logical files from the actual pinned Store.
Fixture success is not native, UI, authorization, or product acceptance.

Development froze through `.runtime-gui-handoff-20261023T143606Z-f48d26cc/HANDOFF.md`.
Independent execution evidence is in `.runtime-gui-test-exec-vgskYGIp/`.
The initial retained 126 tests plus 5 fixture checks passed. New contract tests
found security and functional failures. See `CONSOLIDATED-DEFECTS.md` in that root.
Do not deploy this release. Preserve all original assertions and failed evidence.
The production slot remains locked by the IoT task.
The native SDK text-read API refuses binary data. Complete binary-byte proof
requires a supported read-only byte seam; do not replace it with a fake SDK.

## Scope and provenance

Test ownership: `test/**`, `tests/**`, fixtures and this file only. Business code,
setup scripts, dependencies and package scripts belong to the developer. A test
failure must not be fixed by weakening assertions or temporarily rewriting source.

The assigned tester is `layerfs-test`, provider/model `openai/gpt-6.1-sol`,
thinking `high`. Main planning verified the actual creation receipt
`Started layerfs-test on openai/gpt-6.1-sol.` against the host's subagent creation
logic (`src/server/extensions/subagents.ts:946–1040`): lowering thinking adds notes
and an actual-thinking suffix, which were absent. Later sends also had no
actual-thinking-change warning. This is the main planner's receipt/implementation
verification, not a claim that the test process independently read session data.

Pocket reference: v0.18.0, commit
`564058ef9768c0ee64a074257563576c257ede84`, read-only source at
`/home/xianbei233/Work/pi-pocket-production` (HEAD independently checked).
LayerFS reference: v1.0.0, commit
`2aaf2552ce21154928b9f9c83582e41a637f5910`. Never mix main fixes into this tag.
Main `5fb68ddc1acc3163e3ac3486133bde014c5fbed3` is known to be newer and to include
unreleased daemon-admission changes; these are not tested fixes in v1.0.0.

Read before testing: Pocket documentation index, extension index, testing,
modules, tools, routes, host, cleanup, security-model and gallery-review guides;
complete public `types/pocket.d.ts`; official `test/helpers.ts` and loader/faux
examples. Runtime production code must use public extension API only. Tests may
use the official host harness and HTTP handler as host tests do.

## Isolation rules

- Never import real Pocket data or credentials. Never enable/install into the
  live server. Official Pocket test helpers must be imported **first**, before
  any host `src/` import, to isolate Pi auth/settings/skills and data.
- All model calls in integration tests use `scriptedModel` / faux provider.
  No paid model or real MCP business request is allowed.
- All source fixtures, link targets, dirty worktrees and Store data are synthetic
  and created in an exclusive temporary root or this project's `.runtime`.
- No shared dependency installation. Native setup must be an explicitly reviewed
  local script pinned to the above LayerFS commit; put `CARGO_HOME`,
  `CARGO_TARGET_DIR`, `TMPDIR` and LayerFS home/Store under exclusive `.runtime`.
  Do not modify Docker permissions, use sudo, pull images or touch a shared daemon.
- Test staging must not capture `.git` (including worktree pointer files), `.env*`,
  keys, ignored caches, session databases, symlinks or hardlinks. Error must not
  trigger fallback to scanning/initializing the original tree directly.
- Commands have OS timeouts. Save stdout/stderr and a numeric exit-code file in
  `.runtime/verification/`. Do not silently retry unknown side-effect outcomes.

## Test layers: report separately

1. **Fixture self-tests** (`test/fixtures.test.ts`). Prove that adversarial trees
   contain actual symlinks, multiply-linked inodes and a real dirty Git worktree.
   These tests establish test-input quality, NOT product acceptance.
2. **Unit/security tests** against actual exported production functions. A fake
   transport may deterministically exercise timeout/cancellation/error paths;
   explicitly label such results mock-backed, never native-Store success.
3. **Real Pocket integration**. Copy the actual drop-in and same-prefix helper /
   browser files into the official harness's temporary extensions directory.
   Exercise actual loader, faux model tool invocation and authenticated loopback
   HTTP. Never invoke a route handler directly and call that an HTTP test.
4. **Install smoke**. Install only to isolated temporary Pocket data, using actual
   gallery pin/file checks with a local deterministic fetch source, then verify
   starts disabled, enable/use/disable/reload/restart, declared routes and only
   read-only tools. No publish, push, production install or deploy.
5. **Real native Store E2E**. Real SDK + real built native addon + real Store;
   use synthetic source only. Assert content and actual changed-file/hunk output.
   Source inspection, a fake SDK and fabricated diff objects do not pass this.

Native Store calls are direct-process and need neither Docker nor FUSE. First
edition workspace mount/exec is outside supported scope unless independently
verified; do not infer it from successful Store tests. Do not use the internal
operator API as a test seam.

## Required security acceptance matrix

| Boundary | Positive control | Rejections / invariants |
| --- | --- | --- |
| Default configuration | Explicit trusted owner/project/branch + session grant | Missing/invalid config denies all and exposes no file/branch/commit metadata |
| Requester/session | Owner requester in granted conversation | Guest requester even in granted session; viewer; different session; absent requester; body-supplied identities |
| Project isolation | Grant for project A | Project B and forged paths/aliases; response must not disclose existence |
| Branch/history isolation | Authorized branch head and its reachable history | Other branch's unique commit; arbitrary raw commit/layer IDs; nonexistent refs; revoked grant |
| Path decoding | UTF-8/spaces, ordinary nested paths | Absolute host paths, `..`, backslash, NUL, once/double percent-encoding, symlink/hardlink escapes |
| Model surface | Listed read-only tools with real results | No write/fork/snapshot/confirm tool; `confirm=true` in model arguments never authorizes writes |
| Owner HTTP | Actual owner + bound conversation + turn | Unauthenticated, missing X-Pocket, guest/viewer, single-session invite, bogus source, stolen turn |
| Preview ticket | Exact parameters + owner/session/project/expected head | Each field tampered separately; expired; replayed; concurrent duplicate; changed head; different owner/source/project; reload/disable invalidation |
| Staging | Public file captured, real ignored rules respected | Every exclusion fixture absent, no secret bytes stored, links not traversed/copied; capture failure leaves source untouched |
| Lifecycle | One exclusive service cleaned once | Disconnect, cancellation, deadline, concurrency, idle TTL, reload/disable; no shared PID kill, no user-data deletion, no auto-retry of unknown writes |
| Untrusted output | Correct bounded read/diff result | Historical closing tags/instructions defanged and labeled data; browser renders hostile history as text, not executable markup |
| Host preservation | Exact source tree fingerprint + Git status | `.git` worktree file, dirty tracked/untracked files, inode/link topology and bytes unchanged by every operation |

`test/fixtures/security-tree.ts` supplies real adversarial filesystem probes,
`PUBLIC_TEXT` / `CHANGED_TEXT`, a private-history sentinel and hostile historical
text. `fingerprintTree` never follows symlinks and excludes atime, which ordinary
reads may change. The host-preservation assertion compares fingerprints taken
before and after the product operation, not merely a pair of pre-operation reads.

## Native Store protocol checks

Use grouped **positional** v1.0.0 API only:

- `project.init(stagedSource)` once; `project.list_branches` and
  `branch.list_commits` use `items` / `hasMore` with bounded paging.
- Init captures a whole tree. Inspect staged contents first and then prove
  omitted synthetic secrets are absent from Store, not only from rendered output.
- Produce real revisions via a human-authorized internal action or direct SDK
  synthetic fixture setup. Assert old/new `fs.read` content, changed paths and
  semantic diff hunks from `branch.diff_commits` / `fs.diff_files`.
- `fs.read` / `fs.blame`: 1-based inclusive; enforce and accurately present 2000-line,
  48-KiB, `nextLine` / `truncated` / `lineTruncated` behavior. Preserve CRLF and UTF-8.
- Pagination over live heads can move; historical-authorization checks must not
  accidentally authorize a commit from a different branch when page limits hit.
- Make a branch-specific private commit and prove it cannot be read or diffed
  from an unrelated branch grant. A reachable common ancestor is a positive control.
- `fs.apply(branch, [])` may return `UpToDate`: never assert a forced new Commit.
  A saved ref/bookmark or an internal fork can be a recovery point, but is not
  host checkout/restore/export. Host overwrite/merge/delete/cwd takeover is absent.
- Disposable is not a crash/power-loss durability guarantee; no such claim is tested.

## Commands and reporting

Fixture-only bootstrap, requiring only Node and Git:

```sh
mkdir -p .runtime/verification
set +e
timeout --kill-after=5s 60s node --test test/fixtures.test.ts \
  > .runtime/verification/fixtures.log 2>&1
code=$?
printf '%s\n' "$code" > .runtime/verification/fixtures.exit
exit "$code"
```

Developer-owned package scripts must eventually expose `npm test`, `npm run check`,
`npm run lint`, `npm run format:check`, Pocket integration/install smoke and native
Store E2E. Their final commands will be recorded after the runtime/adapter contract
arrives. A missing script, unavailable dependency or native build failure is a
reported blocker, not an implicit skip or success.

For each execution record: exact command, source versions, whether fake/native,
exit code, log paths, assertion counts, discovered defects and remaining work.
Overall acceptance requires all requested checks to pass, with native Store
results explicitly separated.

### Bootstrap executions (before business contract delivery)

| Command | Exit | Evidence | Meaning |
| --- | --- | --- | --- |
| `timeout --kill-after=5s 60s node --test test/fixtures.test.ts` | 0 | `.runtime/verification/fixtures.log`, `.exit` | 4/4 fixture quality tests passed |
| `timeout --kill-after=5s 90s node --test test/harness.test.ts` | 0 | `.runtime/verification/harness.log`, `.exit` | 1/1 official Pocket loader/HTTP harness self-test passed |

The harness self-test uses `test/fixtures/harness-probe.ts`, a clearly named
synthetic probe, not the LayerFS extension. It verifies disabled-by-default,
actual enable/disable, signed-in owner HTTP, rejected guest/viewer/single-session
invitee, missing authentication/header, and actual bound conversation resolution.
No claim of **product** Pocket integration or native engine success follows from
these bootstrap results.

### Boundary regression executions during developer implementation

Tests now include production config/auth/policy, preview tickets and formatting;
real Unix-socket client transport against a synthetic peer; queue lifecycle; and
Engine contract/security using the **actual pinned v1.0.0 grouped SDK wrappers**
with only the low-level `call` dispatcher replaced by a strict synthetic fixture.
No native I/O is done by that fixture. Contract diff objects are test inputs, not
proof that the real engine generated a diff.

The developer changed the initial auth API from `ownerForTool` to
`toolContext/sessionGrants` while initial tests were being prepared. Tests were
adapted to the explicit scoped interface, retaining deny-all and non-Cartesian
session/project/branch assertions. Stale negative fixture `beta` (later made an
explicit positive project) was corrected to absent `gamma`; cross-session fork
uses exact `WriteDisabled` for the disabled grant. Neither is a relaxation of an
authorization requirement.

| Command | Exit | Evidence | Result |
| --- | --- | --- | --- |
| `timeout --kill-after=5s 90s node --test test/*.test.ts` | 0 | `.runtime/verification/boundaries-round3.log`, `.exit` | 48 passed, 0 failed/skipped |
| `timeout --kill-after=5s 90s npm run test` | 0 | `.runtime/verification/npm-test-round1.log`, `.exit` | Current independent suite runs through package script |
| `timeout --kill-after=5s 90s npm run check` | 0 | `.runtime/verification/npm-check-round1.log`, `.exit` | Actual TypeScript compiler |
| `timeout --kill-after=5s 90s npm run lint` | 1 | `.runtime/verification/npm-lint-round1.log`, `.exit` | ESLint accidentally includes `.runtime-init-test/sdk/test/verify/exec_output_real.mjs`: upstream `new Function` |
| `timeout --kill-after=5s 90s npm run format:check` | 1 | `.runtime/verification/npm-format-check-round1.log`, `.exit` | 7 developer-owned files require formatting |

The round-3 original safety assertions pass after source changes: explicit main
and session grants, default prefix grammar, runtime dot-dot containment, config /
token ancestor-symlink rejection, world-writable config rejection, safe-integer
line window, UTF-8 byte budget and surrogate preservation. Queue tests pass
queued TTL/cancel, expiry during drain without leaked slot, running timeout/cancel
retaining concurrency until actual completion, and no retries. Engine contract
tests pass all used wrapper argument shapes, same-inode/same-size edits via
`fs.diff_files`, reachable common ancestor vs unrelated private commit, scoped
project/branch denial, explicit history truncation/errors and immutable-head fork.

Earlier red logs are retained (`pure-boundaries`, `boundaries-round2`,
`engine-contract-queue`) rather than overwritten. These are intermediate results
on actively changing source, not final release acceptance. Product loader/faux
invocation, product HTTP owner writes, install smoke and real native Store E2E
still require integration execution. The reviewed setup script must not be run
concurrently against another builder's runtime; use a separately owned runtime
or explicitly transferred verified artifacts, without shared dependency installs.


## Clean resume verification — 2026-10-22

Independent test-only continuation; no business, service, script, package, or
production changes. Model/thinking request: openai/gpt-6.1-sol / high. A formal
host receipt was not exposed here; this report does not certify actual high.

Evidence root: .runtime-resume-test-8e3YcQTu/verification/ (all paths below are
relative to this root). Commands ran from /home/xianbei233/Work/pi-pocket-layerfs,
with LAYERFS_TEST_LOG_DIR set to that evidence root. Each suite command used
OS timeout, --kill-after=5s, a 100-second bound, and saved stdout/stderr and exit.

| Command | Exit | Current result | Evidence |
| --- | --- | --- | --- |
| npm test | 1 | 95 tests: 87 pass, 8 fail, 0 skipped/cancelled | npm-test.log/.exit |
| npm run check | 0 | TypeScript passes | npm-check.log/.exit |
| npm run lint | 0 | ESLint passes, including new tests | npm-lint.log/.exit |
| npm run format:check | 0 | Production formatting passes; test/ is excluded by project config | npm-format-check.log/.exit |

New/maintained test files: test/resume-security.test.mjs,
test/service-lifecycle.test.mjs, test/fixtures/resume-runtime.mjs;
test/cli-security.test.ts and test/install-pocket.test.ts now use independently
created log directories rather than overwriting fixed historical filenames.
Test-only Prettier and ESLint runs are recorded in test-format.* and
test-lint-fix-r2.*. No assertions were weakened and no tests were skipped.

### Single consolidated business-defect list (four causes; eight red regressions)

1. **D1 — protected live tree changes before rejection.**
   scripts/install-lib.mjs prepareTarget(create) creates the final directory
   before assertNotLive. An isolated synthetic HOME/.pi-pocket fingerprint
   changes after rejected install: new-extensions was created. All existing
   manifest traversal, duplicate/schema, target/helper ancestor links, leaf
   manifest/helper links, late-file mismatch/full preflight tests pass. No real
   live data was targeted. The remaining required fix is rejection before mkdir.
2. **D2 — installed SDK/artifact provenance remains marker-self-attested.**
   scripts/setup.mjs verifyInstalled accepts forged UPSTREAM.json/version plus
   arbitrary index.js/native bytes. Both --check and normal reuse return 0;
   the latter returns before verifySource. A copied official index.js with an
   added unreviewed change also passes --check. service/main.mjs --check accepts
   the forged SDK/native and reports the pinned version/commit. Four regressions
   fail. Full extracted-source treeHash rejection before planted artifact use
   does pass, as do source/skip-build option refusal and same-size/extra-file/
   symlink-target hash sensitivity. An immutable pin must not be asserted solely
   from installation-controlled metadata and file existence; source and complete
   SDK/native build-integrity evidence must be independently verified.
3. **D4 — asynchronous Store close timeout is reported clean.**
   Actual service subprocess with unresolved SDK close exits 0 after the 3-second
   race and emits no close-timeout/unknown diagnostic. Actual pinned JS close is
   async, awaits storeClose; native store_close returns napi AsyncTask<Job>
   (sdk/js/native/src/lib.rs), so this is not dismissed as a synchronous-only
   seam. One regression fails. SIGTERM while a native-like call is active DOES
   wait past the 5-second grace, logs outcome unknown, waits for real settlement,
   then closes in begin/done/close order. Another independently running service
   still answers ping. No shared process was signalled.
4. **D6 — fixed-source marker does not validate the tree beneath it.**
   scripts/runtime-lib.mjs assertSyntheticSource checks the source directory and
   marker but not nested entries. With a valid copied marker, a nested symlink
   to a separate synthetic unapproved host tree is accepted by hidden --child;
   the synthetic SDK is imported and project.init is invoked (exit 0). Direct
   source validation also does not throw. Two regressions fail. The outside tree
   fingerprint remains unchanged; this does NOT claim real native followed the
   link or captured its target. Existing hidden external-source flags and
   unmarked runtime refusal pass. Seed exceptions propagate, close runs and no
   readiness is printed; the seed test uses a clearly synthetic unshare shim,
   not a native/namespace pass.

### D3/D5 and integration status

- **D3 passes actual service/main.mjs subprocess + Unix socket tests**, not just
  queue mocks: disconnect cancels queued reads AND queued fork.commit before
  SDK dispatch; active caller timeout does not release the native slot; after
  release the active fork actually completes, while the cancelled fork never
  mutates. Caller timeout remains unknown, with no retry. SDK is synthetic.
- **D5 passes** a real service request split inside the Chinese character bytes,
  preserving the exact /中😀.txt path, and ServiceClient reconstructs a response
  sent one byte per write including Chinese, emoji and accented UTF-8.
- Product loader/faux-provider tests: **4/4 pass now** in both product-current.log
  (exit 0) and full npm-test.log. These cover nine readonly tools, hostile data
  framing, Owner success, guest/viewer/single-session guest rejection, exact
  conversation/project binding, preview/execute/replay, disable/re-enable and
  clearing old tickets. This is actual Pocket loader/HTTP with synthetic IPC,
  not a real model request or native Store.
- Actual isolated install/browser-module/enable-disable/restart/uninstall smoke
  passes in the full suite. pocket-smoke-yBOzqR/pocket-smoke-install.* and
  pocket-smoke-uninstall.* both have exit 0; unrelated file and temporary Pocket
  database are preserved. Earlier product-cli-round1 exit 1 and old smoke exits
  0 were read only as historical evidence, not current acceptance.
- **Native Linux Store E2E not run**: the required all-green safety gate is not
  met, and SDK/artifact trust verification is still open (D2). No SDK download,
  rebuild, Docker, privilege escalation, real-directory import, old Store/socket
  reuse, or native fake-as-pass occurred. Real content-change/diff/history/fork
  and final host-invariance native acceptance remain unverified.

### Evidence retention and execution notes

Initial baseline-strict.log/.exit: 35/35 pass, exit 0. That initial invocation
used the old CLI test logger and overwrote existing same-named individual logs
under .runtime/verification/cli-cases; this was unintended and cannot be claimed
as full old-log preservation. Historical top-level product/smoke logs were not
rewritten. All later CLI logs are unique within this resume evidence root.
Initial new-test syntax/fixture errors are retained in resume-regressions.log,
r2/r3; final authoritative results are npm-test.log, not those intermediate runs.
Only test-owned subprocesses/clients were closed. Own temporary synthetic trees,
config/Store placeholders and service logs are retained; runtime-*.path records
locate them. Final own-service process inspection found no remaining matching
service process. No repository initialization/reset/clean/commit/push occurred.

Usage for this increment, role independent testing, requested exact channel
openai/gpt-6.1-sol: actual generation count, input, cacheRead, cacheWrite, total
input, output including reasoning, average/max context and aggregate tool-return
bytes **未取得** (not exposed). No paid probe or extra usage generation was sent;
tool counts or conversational rounds are not substituted for generation usage.

Disposition: stop with this single consolidated list; await main planner's one
bounded business-fix batch, then rerun the original assertions unchanged. Do not
start native acceptance or repeatedly rerun passing checks before that handoff.


## Independent original-acceptance recheck — 2026-10-22

Disposition: **STOP — remaining D2 blockers after the single business-fix batch.**
No business repair, assertion weakening, re-sign-after-tamper, further repair
loop, native E2E, model/MCP request, or subagent was performed.

Evidence directory: .runtime-reverify-xGzcqK8M/verification/.
Commands ran from /home/xianbei233/Work/pi-pocket-layerfs with
LAYERFS_TEST_LOG_DIR set to that new directory. npm commands ran in dependency
order in one script, each under timeout --kill-after=5s 100s, with separate logs
and exit files. Earlier resume and fixed historical CLI logs were not overwritten.

### Test changes and trust boundary

- test/service-lifecycle.test.mjs: added writeTrustReceipt(PROJECT,
  fixture.root, 'owner-authorized') only inside the positive service() helper,
  after synthetic SDK/native creation and before spawn. General runtime() and
  all original forged/tamper negative fixtures remain unsigned. D3/D4/D5 timing,
  cancellation, mutation, close, order and sibling-survival assertions unchanged.
- Added test/receipt-provenance.test.mjs: 11 regressions covering external receipt
  placement, permissions, links, tamper, readonly checks, synthetic-vs-official
  distinction and an actual official SDK/native positive. Each authorized fixture
  is signed once before its adversarial change; no tampered fixture is re-signed.
- No business/src/service/scripts/docs/package files modified. Test style-only
  ESLint/Prettier logs are test-style.* and test-format.*.

### Commands and results

| Command | Exit | Result | Evidence |
| --- | --- | --- | --- |
| npm test | 1 | 106 tests: 103 pass, 3 fail, 0 skipped/cancelled | npm-test.log/.exit |
| npm run check | 0 | TypeScript passes | npm-check.log/.exit |
| npm run lint | 0 | ESLint passes | npm-lint.log/.exit |
| npm run format:check | 0 | Project Prettier passes | npm-format-check.log/.exit |

All original **95/95** assertions pass now. The three reds are from the eleven
new receipt-contract checks; the contract is therefore not fully accepted.

### Single remaining D2 blocker list (two causes / three failures)

1. **setup --check still accepts an explicitly signed synthetic/nonofficial SDK.**
   An owner-authorized fixture has arbitrary index.js and a non-addon native
   placeholder; actual service --check correctly accepts the explicit owner trust
   and stays read-only. But setup --check also exits 0. This contradicts the new
   docs/TEST-SEAMS.md stable contract and Owner requirement that setup --check
   still requires the official SDK tree. scripts/setup.mjs verifyInstalled only
   calls verifySdkProvenance, whose receipt acceptance does not enforce the SDK
   tree pin for this setup entry point. Failing test at
   test/receipt-provenance.test.mjs:29 (assertion at line 44).
2. **receipt reader does not enforce 0700 on the external trust directory.**
   A correctly signed fixture is changed only by chmod trust/ to 0755 or 0777;
   verifySdkProvenance still accepts it (two missing-exception failures, test
   line 55/assertion line 58). writeTrustReceipt checks this mode when writing,
   but the verifier only checks receipt-file mode/owner and path containment.
   Post-write directory permission weakening must not remain trusted. Receipt
   file modes 0644/0666, trust/receipt symlinks and SDK/native tamper do reject.

No negative was relaxed to match the implementation. These are testable contract
failures, not a request for an automatic second business-fix round.

### D1–D6 original acceptance and integration

- D1 passes: rejection-before-mkdir preserves synthetic protected live tree;
  manifest traversal/schema/duplicate/leaf and ancestor symlinks and late-file
  full preflight preserve target/outside fingerprints.
- D2 original negatives pass: forged marker/arbitrary native rejected by setup
  check/reuse and service check; changed installed SDK rejected; incomplete
  extracted tree rejected before planted native reuse; full-tree hash sensitivity
  remains covered. New official positive passes: a private copy of .runtime/sdk
  has actual SDK tree af80d71aa2421c9e63b1bde49788cd968d5bc677f8702c1ba57991e238d6d11e
  and native 63d366056b8c370583bddd4dba34fc186fd5a6cc3c2fe4e1c436a7c7221468a7,
  reports official-pin with no receipt, and both setup/service checks are readonly.
  Thus the safety successes are not deny-all. Two remaining receipt causes above
  prevent overall D2 acceptance.
- D3 passes actual service subprocess/socket: queued read/fork disconnect never
  dispatches cancelled mutation; active timeout retains slot until genuine
  settlement and completed active fork remains outcome-unknown to timed-out
  caller; no retry. SDK is explicitly synthetic, not a native claim.
- D4 passes: active work outlasts 5-second stop grace, diagnostic says unknown,
  order remains begin/done/close and sibling service survives. Unresolved close
  now logs timeout/unknown and exits **4** (service-1283142.log/.exit); other own
  lifecycle service exits are 0.
- D5 passes real split-multibyte request and byte-at-a-time UTF-8 response.
- D6 passes original nested-link/fixed-source rejection before SDK import;
  external-source/unmarked-runtime negative tests and seed-error propagation
  remain passing. Native source-import behavior is not inferred from fake tests.
- Product actual Pocket loader/faux-provider **4/4 pass** within npm-test.log:
  nine readonly tools, Owner success, guest/viewer/session boundaries, HTTP
  preview/execute/replay, disable/re-enable and invalidation of old tickets.
  No real model call. No needless duplicate product run was performed.
- Actual isolated install/browser/enable-disable/restart/uninstall smoke passes
  within npm-test.log. pocket-smoke-GPEs4v/pocket-smoke-install.exit and
  pocket-smoke-uninstall.exit are both **0**; unrelated host fixture data remains.

### Native and process boundaries

Real Linux Store E2E **not started**, since the all-green gate remains unmet.
The official positive independently hashes real SDK/native bytes, not just
UPSTREAM.json. Preliminary readonly review found the existing cargo-build.log
ends in release build success/exit=0 from .work/layerfs-src. The full source-tree
and build-artifact chain was not completed this phase, so this is not native
provenance or native behavior acceptance. No download, compile, shared dependency
installation, sudo, Docker change, production mount, old Store/socket reuse or
real-directory import occurred. Native content changes, same-length diff/history,
recovery fork and final native host-invariance remain unverified.

Final own-process inspection found **0** matching service/main.mjs processes
with this test fixture's /tmp/lfs-resume- config pattern. Own clients/processes
were closed by fixture cleanup; synthetic runtime copies, Store placeholders,
config and logs were retained. No shared processes were signalled.

### Role / usage

Independent testing; requested openai/gpt-6.1-sol / high, no switch or spawn.
Actual model/thinking host receipt remains unexposed; no claim of certified high.
For this recheck, actual generation count, input, cacheRead, cacheWrite, total
input, output including reasoning, average/max context and aggregate tool-return
bytes **未取得**. No probe was made and no tool/round counts substitute for usage.

Stop now with this consolidated blocker report, per the bounded original
acceptance instruction; do not continue native or loop on further repairs.
