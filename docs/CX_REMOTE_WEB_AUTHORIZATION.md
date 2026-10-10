# CX remote Web authorization protocol

`web-v2` adds browser-side consent without widening existing `local-v1` opt-in. This document describes the implementation, not evidence of installed-PC acceptance.

## Trust and scope

- The PC owner first explicitly enables Web authorization in CX RAI 1.8.11 or later. A legacy or missing protocol remains `local-v1`; an unknown protocol is rejected.
- The software-client credential, current account login, device key, and directory binding are independently checked. The helper maintains presence and wakes the UWP owner; it never approves or executes tasks.
- Continuous consent has no fixed duration, but is scoped to **user + Web login SID + device + conversation + rootId**. Access-token renewal within that login is permitted. Logout, login invalidation, explicit revocation, or device re-registration removes the relevant consent. It does not authorize every login, conversation, folder, or PC on the account.
- Directory identity binds the selection, not a command sandbox. Full-trust PowerShell can affect the whole PC; both the PC opt-in and Web continuous-consent confirmation must disclose this.

## Handshake and dispatch

1. Native registration includes `authorizationProtocol: "web-v2"` and a random installation ID. The returned protocol is the server agreement. Re-registration removes all old sessions, jobs and grants, rotates the secret, and may retain the installation's device ID.
2. Web creates a session for a device and owned conversation. Native resolves the original local conversation folder, or the explicitly selected default for a conversation without a prior binding. An unavailable original binding must not silently fall back.
3. Native prepares the session through `/devices/:id/approve`, including `rootId` (lowercase 64-hex SHA-256) and the actual complete `rootLabel`. `rootId` must reflect account/origin and the actual directory identity, not only a lexical path. The label is kept only in live memory.
4. With no matching grant, tool execution waits as `awaiting_web`. `/sessions/:id/authorizations` independently exposes the full immutable tool/arguments to the same Web SID while chat streaming waits. Such jobs never enter native poll or helper pending-task counts.
5. Web posts `{decision:"once"|"persistent"|"reject"}` to `/sessions/:id/authorizations/:jobId`. It cannot change the tool or arguments. A pending job expires after five minutes. Repeat decisions fail, and rejection or stream cancellation removes the job.
6. After approval, native poll delivers the job once with `{protocol:"web-v2",source:"web",mode,rootId,decisionId}`. The final `/start` submits `authorizationProtocol`, `rootId`, `decisionId`; server and native must verify their agreement before side effects. A persistent job also requires the same live grant ID. Start cannot replay.

## Revocation and recovery

- `DELETE /sessions/:id` disconnects and cancels live work, **without deleting continuous consent**.
- `DELETE /sessions/:id/grant` removes consent for that exact scope and cancels waiting, queued, delivered and running jobs. It blocks further start immediately. Native receives absent active-job IDs on its next poll and requests local cancellation; the HTTP response does **not** establish that the PC has stopped or undo previous side effects.
- Removing a device revokes all its sessions/jobs/grants. An old key cannot heartbeat it back online. A fresh local opt-in is required.
- All asynchronous login checks are followed by live object/state validation. Revocation cannot be undone by an earlier pending DB result.
- A running task whose result is lost/cancelled returns `executed:"unknown"`, `retryable:false`. The current chat request cannot dispatch another remote operation automatically. The user must verify the PC state before explicitly starting a new request.
- Server restart discards all jobs and sessions, never replays them, and restores devices **offline**. Native must heartbeat with its key; Web must reconnect and native must re-prepare the same directory identity before a matching grant is reused.
- Presence is a 45-second lease. Preparation has a three-minute deadline. Connections use a 15-minute sliding lease; these are not consent expiration times.

## Durable state and operations

`server.js` puts `.cx-remote-consent.json` beside the configured SQLite database. The file is ignored by Git and preserved by the standard deploy script. Only v2 device metadata/key hashes and scoped grant metadata are stored: never plaintext device keys, local directory labels, tool payloads/results, active jobs or access tokens.

The codec validates schema, allowed fields, owners, identifiers, hashes, sizes and Linux private-file permissions. Commits are synchronous atomic write/fsync/rename operations, so an earlier snapshot cannot overtake a revocation. State corruption, unsafe files or a write failure disable the remote subsystem with HTTP 503 rather than falling back to volatile authorization. The main chat service can still run. Operators should fix storage permissions/capacity and restart; do not delete consent state casually, since doing so invalidates registered native identities.

## Verification

- `npm run test:cx-remote`: legacy transport/lifecycle and v2 real HTTP/durable-state/race suites.
- `npm run test:qr-browser-lifecycle`: actual authentication refresh/logout handlers, including grant removal.
- `npm run test:cx-remote-ui`: browser consent, connection and account/conversation isolation. Run with Chromium and `RAI_BROWSER_ENGINE=webkit`.
- `npm run check` and Linux Formal/security CI remain release gates.

These fixtures cannot prove UWP activation, AppService availability, background helper recovery, real mobile UI, or successful operations on a user's installed PC. Record those separately from source, CI, package signing and deployment evidence.