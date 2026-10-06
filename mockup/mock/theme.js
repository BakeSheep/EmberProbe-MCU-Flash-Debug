/* Switch themes in place, including independently loaded mock webviews. */
(function (root) {
    "use strict";

    var key = "emberprobe.mock.theme";
    var theme = "dark";
    try {
        if (root.localStorage.getItem(key) === "light") theme = "light";
    } catch (error) {
        // file:// and privacy settings can disable persistent storage.
    }

    function apply(next, persist) {
        if (next !== "light" && next !== "dark") return false;
        theme = next;
        document.documentElement.setAttribute("data-mock-theme", theme);
        if (document.body) {
            document.body.classList.toggle("vscode-light", theme === "light");
            document.body.classList.toggle("vscode-dark", theme === "dark");
            document.body.setAttribute("data-vscode-theme-kind", theme === "light" ? "vscode-light" : "vscode-dark");
        }
        if (persist) {
            try {
                root.localStorage.setItem(key, theme);
            } catch (error) {
                // A theme still works when storage is unavailable.
            }
        }
        return true;
    }

    root.EmberProbeMockTheme = {
        apply: apply,
        current: function () {
            return theme;
        }
    };
    apply(theme);
    document.addEventListener("DOMContentLoaded", function () {
        apply(theme);
        if (root.parent !== root) root.parent.postMessage({ __emberprobeMockTheme: true, request: true }, "*");
    });
    root.addEventListener("message", function (event) {
        var message = event.data;
        if (root.parent !== root && event.source === root.parent && message && message.__emberprobeMockTheme)
            apply(message.theme);
    });
})(window);
