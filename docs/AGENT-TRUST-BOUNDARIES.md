# Agent approval and local trust boundaries

Agent Bridge calls require a trusted VS Code workspace. Sensitive operations require a
decision through the extension UI as well as the existing confirmation fingerprint. Flash
and peripheral writes use one-time approval; variable writes and CubeMX can remember the
user's UI choice for up to 24 hours, bound to the ELF/connection or project/tool identity.
Legacy client-provided `remember` flags cannot create a UI grant. Resetting the corresponding
permission must clear both the plan authorization and the UI grant.
Resetting permission while an approval dialog is open invalidates that pending decision.

Approvals display the actual bounded snapshot/plan. ELF, connection, project, SVD, register
values and debug-stop identity are rechecked after the dialog. Flash verification is included
because it can temporarily halt the target. Custom SVDs remain supported: their actual path,
digest, register addresses and write semantics appear in peripheral approval. Device/vendor
matching is compatibility evidence rather than proof of provenance.

Installed skills are hashed before Bridge calls. Modified/partial/outdated contents require
a decision for the current content; another change invalidates approval. This check concerns
the extension's known installed skills and shared runtime. It does not sandbox arbitrary
scripts already running under the user's OS account.

OpenOCD Tcl has no authentication. Random loopback ports reduce accidental collisions; they
do not authenticate clients. Automatic allocation failures now fail explicitly instead of
using 6666. Explicit user port settings remain supported. File permissions for the Bridge
descriptor reduce cross-account exposure; they do not isolate hostile processes under the
same account. Scripts/tool roots configured in the process environment belong to this local
trust boundary.

After physical disconnect, sampling and writes are disabled immediately. The UI reports
closing until exit is confirmed. Unconfirmed exit retains the process and lease and permits
a stop retry. Software mocks validate this ordering; actual USB removal and board support
require separate hardware validation.
