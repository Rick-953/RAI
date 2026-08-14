# RAI Local Agent v1

RAI Local Agent lets an explicitly connected RAI Web conversation use local files, programs, an explicit shell, and a separate browser tab on macOS, Linux, and Windows. It preserves the existing Windows/UWP `client_file_execution` contract; new clients use the signed `rai-local-agent-*/v1` protocol.

## Installation

macOS or Linux:

```sh
curl --fail --location --proto '=https' --tlsv1.2 https://github.com/Rick-953/RAI/releases/latest/download/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://github.com/Rick-953/RAI/releases/latest/download/install.ps1 | iex
```

The installer downloads the platform binary from `local-agent-channel.json`, verifies SHA-256, atomically switches the current version, keeps the newest two versions for rollback, registers Chrome/Edge Native Messaging, and opens the browser store plus RAI. When GitHub CLI is installed it also verifies the release's GitHub signed provenance; set `RAI_REQUIRE_ATTESTATION=1` to require that verification.

Browsers do not allow a normal installer to silently install an extension. The user must confirm the RAI Connect store installation and then bind the device in **RAI Settings > Security**. A release is blocked unless both official store IDs are configured as repository variables `RAI_CHROME_EXTENSION_ID` and `RAI_EDGE_EXTENSION_ID`.

## Trust and protocol

1. The Agent generates an Ed25519 device key locally. The private seed never leaves the device.
2. Pairing and session challenges prove possession of that key. Sessions are bound to an account, device, and conversation, with a 30-minute idle limit and a four-hour absolute limit.
3. The server signs each versioned tool envelope. The Agent verifies issuer, key fingerprint, signature, expiry, session, sequence, and run identity.
4. The Agent signs each result receipt. The server verifies it and matches the in-memory pending tool before marking the database run complete.
5. Old UWP clients continue to use `/api/agent/tool-result`; signed Agent runs cannot be completed through that legacy endpoint.

The server requires `RAI_LOCAL_AGENT_SIGNING_PRIVATE_KEY_FILE`, or falls back to the configured conversation Ed25519 signing key. `PUBLIC_BASE_URL` is the canonical issuer returned during pairing, so legacy redirect domains cannot create an issuer mismatch.

## Permissions

- The default filesystem grant is the current user's home directory.
- `.ssh`, browser profiles, password stores, cloud credentials, `.env`, and similar sensitive paths always require an explicit approval.
- Access outside a granted root requires approval. “Always allow” adds that directory, with read/write/execute actions, to the local rule set.
- Commands use `program + args`. An arbitrary shell is used only when the model sends the explicit shell tool and the user approves it.
- “Always allow” for a shell is scoped to its working directory, never stored as a global arbitrary-command switch.
- `elevated=true` always requires both the extension approval and the operating system's administrator prompt. A signed, nonce-bound request expires after 60 seconds; the elevated worker exits after one request. No persistent root service is installed.
- Browser tools use a dedicated non-RAI controlled tab. They never navigate the RAI conversation tab. Form submission is approved each time.

## Output and audit

Local encrypted audit logs keep the complete local result for 30 days, capped at 1 GiB. `rai-agent logs --limit 100` decrypts them locally. Cloud conversation cards are collapsed by default, scoped to their conversation, limited to the latest 20 operations, secret-redacted, and truncated to 64 KiB for display. Model-visible output is capped at 128 KiB. The full output is never uploaded merely to render the card.

Useful commands:

```sh
rai-agent doctor
rai-agent status
rai-agent permissions
rai-agent logs --limit 100
rai-agent uninstall
```

## Release process

`.github/workflows/local-agent-release.yml` runs Rust tests and Clippy on Apple Silicon macOS, Intel macOS, x86_64 Linux, and x86_64 Windows. A version tag builds platform archives, generates a CycloneDX SBOM, packages the extension and installers, emits `SHA256SUMS`, creates GitHub signed provenance attestations, and uploads all assets to the matching GitHub Release.

## OpenCode boundary

[OpenCode commit `92d29ba4a368adef7b874219b646351d3c5bec0e`](https://github.com/anomalyco/opencode/tree/92d29ba4a368adef7b874219b646351d3c5bec0e) was reviewed only as an MIT-licensed architectural reference for cross-platform command and permission ergonomics. RAI Local Agent has no OpenCode runtime dependency, does not embed OpenCode, and does not copy its source.
