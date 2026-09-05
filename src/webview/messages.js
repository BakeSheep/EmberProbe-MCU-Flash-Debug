"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeMessages = factory();
})(globalThis, function () {
    function connect(target, handlers) {
        const listener = (event) => {
            const message = event.data;
            if (!message || typeof message !== "object" || typeof message.type !== "string") return;
            if (Object.prototype.hasOwnProperty.call(handlers, message.type)) handlers[message.type](message);
        };
        target.addEventListener("message", listener);
        return () => target.removeEventListener("message", listener);
    }
    return { connect };
});
