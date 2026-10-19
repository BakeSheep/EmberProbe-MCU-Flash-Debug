# J-Link driver notification

Windows operations rejected with `PROBE_DRIVER_UNSUPPORTED` should retain their existing errors and additionally show a non-modal VS Code warning. The warning offers a WinUSB switch and a workspace-local ignore action. Closing it without choosing an action leaves future reminders enabled.

Use the shared `ProbeConnectionService` preflight error path so downloads, sampling, reads and debug startup receive the same behavior, including operations requested through the extension's Agent Bridge. Keep notification response handling independent of the failed operation so its cleanup and probe lease release can finish.

Reuse the existing sidebar driver-change path. Revalidate the USB interface against the notification's original instance ID before changing a driver. Preserve busy checks, driver verification and administrator authorization. Do not automatically retry the original operation.

Persist ignore in `ExtensionContext.workspaceState`. Apply it to driver warnings from both operation failures and sidebar selection/driver restoration. Coalesce pending notifications; retain page errors and all driver checks even when reminders are ignored.

Validate action handling, dismissal, concurrency, workspace persistence/isolation, changed-device rejection and switch failures using mocked VS Code and probe services. Run the repository checks, quality gates, bundle and Extension Host suite; physical driver switching remains a separate hardware test.
