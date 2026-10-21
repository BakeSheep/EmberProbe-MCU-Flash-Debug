# Agent approval and local trust boundaries

Agent Bridge calls require a trusted VS Code workspace. Sensitive operations are confirmed
in the Agent conversation: the Agent shows the returned plan, waits for the human's answer,
then resubmits its one-time confirmation ID. There is no second VS Code operation approval
dialog. The Bridge checks plan identity and ID expiry/reuse; it does not independently
attest that the Agent obtained a human answer. A returned ID alone never authorizes an
Agent to execute.

Flash verification and peripheral writes use one-time confirmation. Flash programming,
variable writes and CubeMX can remember an explicitly requested chat choice for up to
24 hours. Variable writes bind it to the ELF digest and connection, CubeMX to the
project/tool identity. Flash programming binds it to the ELF path, target, probe identity,
transport, adapter speed and OpenOCD executable but not to the image digest, so rebuilding
the same path keeps the permission; every programming result still reports the SHA-256 that
was written. Probes without a reliable serial and Flash verification never remember.
`remember` requires a valid confirmation ID and must not be inferred from a request to
perform the operation. Resetting permission clears the pending confirmations and remembered
authorization. Old independent modal grant records are no longer consulted.

The MCP server maps the same confirmation responses to MCP elicitation when the client
supports it: the form offers only the Bridge's `choices` plus `deny`, defaults to `deny`, and
the confirmation ID stays inside the server. A form rendered by the client is closer to
evidence of a human action than chat text, but the Bridge still does not authenticate it (a
client can be configured to answer automatically), so plan binding and one-time use of IDs
are unchanged. Clients without elicitation receive the plan and ID and must confirm in chat as
skills do. The MCP server never chooses `remember` from the initial request and never accepts
a confirmation on its own. The Bridge records each call's channel, client, method and result
code (not parameter values) in the "EmberProbe Agent Bridge" output channel.

EmberProbe records the digest of the last image it programmed in each workspace. Agent
reads, samples and writes report `firmwareConsistency` (`match`, `mismatch` or `unknown`)
against the configured ELF and add an `ELF_TARGET_MISMATCH` warning on mismatch; a
remembered variable-write permission does not apply while the ELF differs. Programming by
other tools is not observed, so `unknown` or a stale record is evidence, not proof.

Confirmation responses describe the actual bounded snapshot/plan. ELF, connection, project,
SVD, register values and debug-stop identity are recomputed when the confirmed request
arrives. Flash verification is included because it can temporarily halt the target, and its
operation-bound ID cannot program Flash. Custom SVDs remain supported: their actual path,
digest, register addresses and write semantics appear in peripheral approval. Device/vendor
matching is compatibility evidence rather than proof of provenance.

Installed skills are hashed before Bridge calls. Modified/partial/outdated contents require
a decision for the current content; another change invalidates approval. Skill scripts send
`X-EmberProbe-Channel: skill` and `X-EmberProbe-Skill-Root` with each request, and the check
applies to the copy that issued the call: the workspace copy, the legacy global copy, or a
copy outside both roots, which always needs approval and shows its real path. Approval is
cached per root and that root's fingerprint, so approving one copy never approves another.
Requests without these headers (older scripts) keep the previous merged-view check. MCP
requests (`X-EmberProbe-Channel: mcp`) skip the skill hash because the MCP server ships inside
the extension. These headers locate and audit callers only; they are not authentication, and
a process under the same OS account can forge them. This check does not sandbox arbitrary
scripts already running under the user's OS account.

The Bridge starts only in a trusted workspace whose Agent access is on: either the
workspace-scoped `emberprobe.agentAccess` switch is `enabled`, or it is unset and workspace
skills are installed (the previous behaviour). An explicit `disabled` wins over installed
skills until the skills are reinstalled. The switch lives in VS Code workspace state, not in
a workspace file. A legacy global copy under `~/.agents/skills` never starts the Bridge; the
sidebar offers to remove it.

OpenOCD Tcl has no authentication. Random loopback ports reduce accidental collisions; they
do not authenticate clients. Automatic allocation failures now fail explicitly instead of
using 6666. Explicit user port settings remain supported. File permissions for the Bridge
descriptor reduce cross-account exposure; they do not isolate hostile processes under the
same account. Scripts/tool roots configured in the process environment belong to this local
trust boundary.

Each extension window registers itself in `<globalStorage>/agent-bridges/<instanceId>.json`
(mode `0o600`). A running Bridge entry holds its loopback port and token; a stopped window
keeps only a token-free marker so clients can report that Agent access is off. Clients find
a Bridge by the longest workspace folder that contains their directory, refuse to choose
when two windows tie (`BRIDGE_AMBIGUOUS`; select one with `EMBERPROBE_BRIDGE_INSTANCE`), and
fall back to the token-free workspace pointer for older extensions. The registry lives in the
same per-user storage as the earlier descriptor, so token exposure is unchanged.

After physical disconnect, sampling and writes are disabled immediately. The UI reports
closing until exit is confirmed. Unconfirmed exit retains the process and lease and permits
a stop retry. Software mocks validate this ordering; actual USB removal and board support
require separate hardware validation.
