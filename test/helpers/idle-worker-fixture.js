"use strict";
// A Worker that never posts on its own: tests drive the host side by emitting messages on it.
require("worker_threads").parentPort.on("message", () => {});
