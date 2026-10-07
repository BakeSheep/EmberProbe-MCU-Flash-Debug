# Debug execution and shutdown races

Fix the built-in EmberProbe adapter without changing probe ownership, sampling, or Cortex-Debug.

Execution commands will invalidate stopped references and mark the target running before sending MI.
An execution epoch distinguishes later GDB running/stopped events, so a failed command restores the
previous state only if GDB has not reported a newer state. Stale stopped reads fail without a user popup;
genuine errors in the current stopped context still surface.

For paged stacks, handle only GDB's specific end-of-stack error on a nonzero start frame. Confirm the
bounded stack depth and unchanged stopped generation before returning an empty page and totalFrames.
Keep the current page and traversal budgets; do not turn missing initial stacks into successful reads.

Disconnect and termination cancel outstanding requests immediately and prevent further target commands.
Cleanup commands remain available, including external target-disconnect and local GDB exit. Do not wait
for a possibly wedged request before shutting down. Preserve external server lifetime and exit confirmation.
Local initialize capability queries still receive a successful response during a pipelined shutdown handshake.

Validation: add deterministic MI transport regressions for delayed running records, fast stops, rejected
execution, stack boundaries, current-context errors, and shutdown with pending reads/control. Run normal
checks, quality, bundle, Extension Host tests, and real ARM GDB tests against the memory-only RSP fixture.
Commit the reviewed fix branch and merge it into local master after checking that checkout for user changes.
