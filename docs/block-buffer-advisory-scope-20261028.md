# block-buffer advisory scope review

Reviewed: 2026-10-28 (Asia/Shanghai). Re-review by 2026-11-11.

## Decision and limits

GHSA-qwgh-2vcv-g2f7 is reported for both Rust lockfiles because the advisory's
published range is `< 0.12.1`. Both lockfiles actually resolve `block-buffer
0.10.4`, registry checksum
`3078c7629b62d3f0439517fa394996acacc5cbc91c5a20d8c658e77abd503a71`.

Static review of that exact official crate shows a separate `pos: u8` field
alongside `buffer: Block<BlockSize>`. Its `get_pos` reads `self.pos`, and its
compression callback receives an immutable block reference, not the cursor
storage. The crate has no `ReadBuffer` implementation. The inline cursor
representation described in this advisory is present in the later 0.11.0
source, not in the pinned 0.10.4 source.

This is a narrowly documented version-scope false positive, not a claim that
all versions or all uses of the crate are safe. No crash, exploitability,
panic-trigger or proof-of-concept experiment was performed. No runtime code
or cryptographic implementation is modified as part of this decision.

## Evidence

- Advisory: <https://github.com/advisories/GHSA-qwgh-2vcv-g2f7>
- Exact registry archive: <https://static.crates.io/crates/block-buffer/block-buffer-0.10.4.crate>
- Older implementation: <https://github.com/RustCrypto/utils/tree/block-buffer-v0.10.4/block-buffer/src>
- Later inline representation: <https://github.com/RustCrypto/utils/blob/block-buffer-v0.11.0/block-buffer/src/sealed.rs>
- Upstream patched release: <https://github.com/RustCrypto/utils/releases/tag/block-buffer-v0.12.1>

The downloaded 0.10.4 archive SHA-256 equals the checksum in both lockfiles.
Only this advisory ID is suppressed in the configuration adjacent to each
lockfile, with an explicit expiry. Other advisories and ecosystem gates remain
active. `security-exception-expiry-regression.js` rejects a changed version or
checksum until this decision is reviewed, and still enforces the original
Tauri exception/workflow correspondence.

Upgrading to a different semver-incompatible cryptographic dependency graph
solely to silence an overbroad range is not included in this UI/skills release.
If upstream expands the advisory to the separate-cursor implementation or
publishes a compatible affected-version correction, revisit this decision.
