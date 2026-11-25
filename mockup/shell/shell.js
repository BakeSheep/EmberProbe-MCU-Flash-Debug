/*
 * VS Code shell behaviour for the EmberProbe UI mock: view switching, tabs,
 * editor rendering, debug session state, command palette and the two embedded
 * webview hosts.
 */
(function () {
    "use strict";

    var D = window.EmberProbeShellData;
    var $ = function (id) {
        return document.getElementById(id);
    };
    var esc = function (value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
        });
    };

    function icon(name) {
        return '<span class="codicon codicon-' + name + '" aria-hidden="true"></span>';
    }

    function fileIcon(name) {
        var extension = name.split(".").pop().toLowerCase();
        if (["c", "h", "md", "json"].indexOf(extension) >= 0)
            return '<span class="seti-icon seti-' + extension + '" aria-hidden="true"></span>';
        return icon("file");
    }

    const query = new URLSearchParams(window.location.search);
    const dualCore = query.get("debugCores") === "2";
    const projectName = "EmberProbeDemo";
    const workspace = window.EmberProbeMockConfiguration.workspace;

    var state = {
        lang: query.get("lang") === "en" ? "en" : "zh",
        activeView: "emberprobe",
        activeTab: "livewatch",
        openTabs: ["FreeRTOSConfig.h", "main.c", "livewatch", "README.md"],
        panelVisible: true,
        activePanel: "terminal",
        sidebarVisible: true,
        debugActive: false,
        debugPaused: false,
        debugStopping: false,
        debugCore: 0,
        debugCores: [],
        debugLine: 0,
        debugFile: "main.c",
        debugStack: [],
        debugKind: "reset",
        lastStop: null,
        expandedNodes: { g_imu: true, g_history: true },
        breakpoints: D.DEBUG.breakpoints.map(function (item) {
            return Object.assign({}, item);
        })
    };
    var tabHistory = [state.activeTab];
    var historyIndex = 0;

    var TAB_META = {
        livewatch: { label: "波形图 #1", type: "livewatch" },
        "main.c": { label: "main.c", type: "file", modified: true, gitModified: true },
        "pid.c": { label: "pid.c", type: "file" },
        "tasks.c": { label: "tasks.c", type: "file" },
        "FreeRTOSConfig.h": { label: "FreeRTOSConfig.h", type: "file" },
        "README.md": { label: "README.md", type: "markdown" }
    };
    var breakpointTimer = null;
    let initialStopTimer = null;
    let stepTimer = null;
    let pauseTimer = null;
    let stopTimer = null;
    let terminalSession = "shell";
    const flashLines = [];
    var sidebarHost = null;
    var charts = new Map();
    var savedChartWatches = new Map();
    var samplingSettings = window.EmberProbeMockSampling.createSettings();
    var archive = window.EmberProbeMockArchive.create();
    var chartHistory = new window.EmberProbeMockHistory.ChartHistoryStore();
    var samplingPhase = "stopped";
    var debugScope;
    var rttSettings = window.EmberProbeMockRttSettings.defaults;
    var rttHost = null;
    var rttShown = false; // The RTT tab appears with the first start and stays (src/services/rttPanelHost.js).
    var dataBreakpoints = []; // VS Code's native data breakpoints.
    var simulator = window.EmberProbeSidebarData.createSimulator();
    var tr = window.EmberProbeMockText.create(function () {
        return state.lang === "en";
    });

    function webviewFrames() {
        return [$("sidebarFrame"), $("rttFrame"), ...Array.from(charts.values(), (chart) => chart.frame)];
    }

    function sendTheme(frame) {
        if (frame.contentWindow)
            frame.contentWindow.postMessage(
                { __emberprobeMockTheme: true, theme: window.EmberProbeMockTheme.current() },
                "*"
            );
    }

    function setTheme(theme, persist) {
        if (!window.EmberProbeMockTheme.apply(theme, persist)) return;
        webviewFrames().forEach(sendTheme);
        document.querySelectorAll("[data-theme]").forEach(function (button) {
            button.setAttribute("aria-checked", String(button.dataset.theme === theme));
        });
    }

    function closeThemeMenu() {
        $("theme-menu").hidden = true;
        $("manageButton").setAttribute("aria-expanded", "false");
    }

    function openThemeMenu() {
        setTheme(window.EmberProbeMockTheme.current());
        $("theme-menu").hidden = false;
        $("manageButton").setAttribute("aria-expanded", "true");
        document.querySelector('[data-theme="' + window.EmberProbeMockTheme.current() + '"]').focus();
    }

    webviewFrames().forEach(function (frame) {
        frame.addEventListener("load", function () {
            sendTheme(frame);
        });
    });
    window.addEventListener("message", function (event) {
        if (!event.data || !event.data.__emberprobeMockTheme || !event.data.request) return;
        webviewFrames().forEach(function (frame) {
            if (event.source === frame.contentWindow) sendTheme(frame);
        });
    });

    /* ------------------------------------------------------------ utilities */

    var C_KEYWORDS =
        /\b(if|else|for|while|do|switch|case|break|continue|return|goto|sizeof|typedef|struct|union|enum|static|const|volatile|extern|inline|register|default)\b/;
    var C_TYPES =
        /\b(void|char|short|int|long|float|double|unsigned|signed|bool|uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|size_t|TickType_t|QueueHandle_t|osThreadId_t|PID_HandleTypeDef|imu_sample_t|telemetry_frame_t|HAL_StatusTypeDef)\b/;
    var C_TOKEN =
        /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(^[ \t]*#[ \t]*\w+)|(\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?[fFuUlL]*)\b)|(\b[A-Za-z_]\w*(?=\s*\())|(\b(?:NULL|true|false|MOTOR_STATE_[A-Z_]+|ADC_CH_[A-Z_]+|TIM_CHANNEL_\d|SystemCoreClock|DWT|HAL_[A-Za-z_]+|pdMS_TO_TICKS)\b)/g;

    function highlightLine(raw, inBlockComment) {
        var html = "";
        var text = raw;
        if (inBlockComment) {
            var end = text.indexOf("*/");
            if (end < 0) return { html: '<span class="tok-comment">' + esc(text) + "</span>", inBlock: true };
            html += '<span class="tok-comment">' + esc(text.slice(0, end + 2)) + "</span>";
            text = text.slice(end + 2);
            inBlockComment = false;
        }
        var start = text.indexOf("/*");
        if (start >= 0 && text.indexOf("*/", start + 2) < 0 && text.indexOf('"', start) < 0) {
            html += tokenize(text.slice(0, start));
            html += '<span class="tok-comment">' + esc(text.slice(start)) + "</span>";
            return { html: html, inBlock: true };
        }
        return { html: html + tokenize(text), inBlock: inBlockComment };
    }

    function tokenize(text) {
        var out = "";
        var last = 0;
        var match;
        C_TOKEN.lastIndex = 0;
        while ((match = C_TOKEN.exec(text))) {
            out += esc(text.slice(last, match.index));
            var cls = "tok-keyword";
            if (match[1]) cls = "tok-comment";
            else if (match[2]) cls = "tok-string";
            else if (match[3]) cls = "tok-pre";
            else if (match[4]) cls = "tok-number";
            else if (match[5]) cls = "tok-function";
            else if (match[6]) cls = "tok-constant";
            else if (C_KEYWORDS.test(match[0])) cls = "tok-control";
            else if (C_TYPES.test(match[0])) cls = "tok-type";
            out += '<span class="' + cls + '">' + esc(match[0]) + "</span>";
            last = match.index + match[0].length;
        }
        return out + esc(text.slice(last));
    }

    function selectedCodeFile() {
        return D.FILES[state.activeTab] && TAB_META[state.activeTab].type === "file" ? state.activeTab : "main.c";
    }

    function codeLines(file) {
        return D.FILES[file || selectedCodeFile()].content.split("\n");
    }

    function findDebugLine() {
        var lines = codeLines("main.c");
        for (var i = 0; i < lines.length; i++) if (lines[i].indexOf("pid_update(&pid") >= 0) return i + 1;
        return 87;
    }

    // The debug command resets and runs to main (runToEntryPoint).
    function findMainLine() {
        var lines = codeLines("main.c");
        var entry = lines.indexOf("int main(void)");
        for (var i = entry + 1; i < lines.length; i++) if (/^\s+\S.*;$/.test(lines[i])) return i + 1;
        return entry + 1;
    }

    function findIdleCallLine() {
        var lines = codeLines("tasks.c");
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].indexOf("prvCheckTasksWaitingTermination();") >= 0) return i + 1;
        }
        return 1;
    }

    var STEP_CALLEES = {
        pid_update: "pid.c",
        pid_init: "pid.c",
        prvCheckTasksWaitingTermination: "tasks.c",
        Motor_Init: "main.c",
        Sensor_Update: "main.c"
    };

    function isExecutableLine(raw) {
        var trimmed = raw.trim();
        return !!trimmed && !/^(?:[{}]|\/\/|\/\*|\*|#|else\b)/.test(trimmed);
    }

    function findEnclosingFunction(file, line) {
        var lines = codeLines(file);
        var currentFn = null;
        var loopStart = 0;
        var found = null;
        for (var i = 0; i < lines.length; i++) {
            var header = lines[i].match(/^(?:static\s+)?(?:void|int|float|uint\d+_t|BaseType_t)\s+([A-Za-z_]\w*)\s*\(/);
            if (!currentFn && header && lines[i][0] !== " ") {
                currentFn = { name: header[1], start: i + 1, end: lines.length, loopStart: 0 };
                loopStart = 0;
                continue;
            }
            if (currentFn && /for\s*\(\s*;\s*;\s*\)/.test(lines[i])) loopStart = i + 1;
            if (currentFn && lines[i] === "}") {
                currentFn.end = i + 1;
                currentFn.loopStart = loopStart;
                if (line >= currentFn.start && line <= currentFn.end) found = currentFn;
                currentFn = null;
            }
        }
        return found || { name: debugFrame(), start: 1, end: lines.length, loopStart: 0 };
    }

    function nextExecutableInFunction(file, line) {
        var lines = codeLines(file);
        var fn = findEnclosingFunction(file, line);
        for (var i = line; i < fn.end - 1; i++) {
            if (isExecutableLine(lines[i])) return i + 1;
        }
        if (fn.loopStart) {
            for (var j = fn.loopStart; j < fn.end - 1; j++) {
                if (isExecutableLine(lines[j])) return j + 1;
            }
        }
        return line;
    }

    function findCalleeEntry(name) {
        var file = STEP_CALLEES[name];
        if (!file || !D.FILES[file]) return null;
        var lines = codeLines(file);
        var pattern = new RegExp("\\b" + name + "\\s*\\(");
        for (var i = 0; i < lines.length; i++) {
            if (lines[i][0] !== " " && pattern.test(lines[i])) {
                for (var j = i + 1; j < lines.length; j++) {
                    if (isExecutableLine(lines[j])) return { name: name, file: file, line: j + 1 };
                }
            }
        }
        return null;
    }

    function enabledSourceBreakpoint() {
        return state.breakpoints.find((item) => item.enabled && D.FILES[item.file]);
    }

    function showToast(text, iconName, duration = 4200) {
        var box = document.createElement("div");
        box.className = "toast" + (iconName === "error" ? " error" : "");
        box.innerHTML =
            '<span class="toast-icon">' + icon(iconName || "check") + "</span><span>" + esc(text) + "</span>";
        $("toasts").appendChild(box);
        setTimeout(function () {
            box.style.opacity = "0";
            box.style.transition = "opacity .25s";
            setTimeout(function () {
                box.remove();
            }, 260);
        }, duration);
    }

    /* --------------------------------------------------------------- editor */

    function renderEditor() {
        var file = selectedCodeFile();
        var lines = codeLines();
        var code = "";
        var gutter = "";
        var minimap = "";
        var inBlock = false;
        var activeBreakpoints = {};
        state.breakpoints.forEach(function (item) {
            if (item.file === file) activeBreakpoints[item.line] = item;
        });
        for (var i = 0; i < lines.length; i++) {
            var lineNumber = i + 1;
            var result = highlightLine(lines[i], inBlock);
            inBlock = result.inBlock;
            var isActive =
                state.debugActive && state.debugPaused && file === state.debugFile && lineNumber === state.debugLine;
            code +=
                '<span class="code-line' +
                (isActive ? " active-line" : "") +
                '" data-line="' +
                lineNumber +
                '">' +
                (result.html || "") +
                "</span>";
            gutter +=
                '<div class="gutter-line' +
                (isActive ? " active" : "") +
                '" data-line="' +
                lineNumber +
                '">' +
                '<span class="glyph-margin" aria-hidden="true">' +
                (activeBreakpoints[lineNumber]
                    ? '<span class="breakpoint codicon codicon-' +
                      (isActive ? "debug-stackframe-dot" : "debug-breakpoint") +
                      (activeBreakpoints[lineNumber].enabled ? "" : " disabled") +
                      '"></span>'
                    : '<span class="breakpoint-hint codicon codicon-debug-hint"></span>') +
                (isActive ? '<span class="current-arrow codicon codicon-debug-stackframe"></span>' : "") +
                '</span><span class="line-number">' +
                lineNumber +
                "</span></div>";
            var trimmed = lines[i].replace(/\s+$/, "");
            var indent = trimmed.length - trimmed.replace(/^\s+/, "").length;
            var mmClass = "mm-code";
            if (/^\s*(\/\/|\/\*|\*)/.test(trimmed)) mmClass = "mm-comment";
            else if (/^\s*#/.test(trimmed)) mmClass = "mm-kw";
            else if (/"/.test(trimmed)) mmClass = "mm-string";
            else if (C_KEYWORDS.test(trimmed) || C_TYPES.test(trimmed)) mmClass = "mm-kw";
            var width = Math.max(3, Math.min(78, Math.round(trimmed.trim().length * 1.35)));
            minimap +=
                '<span class="minimap-line"><i class="' +
                (isActive ? "mm-cur" : mmClass) +
                '" style="left:' +
                Math.round(indent * 1.1) +
                "px;width:" +
                width +
                'px"></i></span>';
        }
        $("code").innerHTML = code;
        $("gutter").innerHTML = gutter;
        $("minimap").innerHTML = minimap;
        var crumbs = [projectName].concat(D.FILES[file].path.split("/"));
        if (state.debugActive && state.debugPaused && file === state.debugFile) crumbs.push(debugFrame() + "()");
        else if (file === "main.c") crumbs.push("ControlTask()");
        $("breadcrumbs").innerHTML = crumbs
            .map(function (crumb) {
                return '<span class="crumb">' + esc(crumb) + "</span>";
            })
            .join("<span>›</span>");
        updateCursorStatus();
        if (file === state.debugFile && state.debugLine && state.debugActive && state.debugPaused) {
            var active = $("code").querySelector('.code-line[data-line="' + state.debugLine + '"]');
            if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "center" });
        }
    }

    function updateCursorStatus() {
        var text =
            state.debugLine && state.debugActive && state.debugPaused && selectedCodeFile() === state.debugFile
                ? "Ln " + state.debugLine + ", Col 12"
                : "Ln 1, Col 1";
        $("cursorStatus").textContent = text;
    }

    function renderTabs() {
        var html = "";
        state.openTabs.forEach(function (id) {
            var meta = TAB_META[id];
            var active = id === state.activeTab;
            html +=
                '<div class="tab' +
                (active ? " active" : "") +
                (meta.gitModified ? " git-modified" : "") +
                '" data-tab="' +
                esc(id) +
                '" title="' +
                esc(meta.label) +
                '"><span class="tab-icon">' +
                (meta.type === "livewatch" ? icon("list-flat") : fileIcon(id)) +
                '</span><span class="tab-label">' +
                esc(meta.label) +
                "</span>" +
                (meta.gitModified ? '<span class="git-decoration">M</span>' : "") +
                (meta.modified && meta.type === "file" ? '<span class="modified-dot"></span>' : "") +
                '<span class="tab-close" data-close="' +
                esc(id) +
                '">' +
                icon("close") +
                "</span></div>";
        });
        $("tabList").innerHTML = html;
    }

    function activateTab(id, navigating) {
        if (id !== null && !TAB_META[id]) return;
        if (id && !navigating && tabHistory[historyIndex] !== id) {
            tabHistory = tabHistory.slice(0, historyIndex + 1);
            tabHistory.push(id);
            historyIndex = tabHistory.length - 1;
        }
        $("navigateBack").disabled = historyIndex === 0;
        $("navigateForward").disabled = historyIndex === tabHistory.length - 1;
        state.activeTab = id;
        document.body.classList.toggle("file-editor", id !== null && TAB_META[id].type === "file");
        renderTabs();
        var paneType = id === null ? null : TAB_META[id].type;
        document.querySelectorAll(".editor-pane").forEach(function (pane) {
            pane.classList.toggle("active", pane.dataset.pane === (paneType === "livewatch" ? id : paneType));
        });
        if (paneType === "markdown") renderMarkdown();
        if (paneType === "file") renderEditor();
        updateDebugToolbar();
    }

    function navigateTabs(direction) {
        var next = historyIndex + direction;
        if (next < 0 || next >= tabHistory.length) return;
        historyIndex = next;
        var id = tabHistory[next];
        if (!TAB_META[id]) return navigateTabs(direction);
        if (state.openTabs.indexOf(id) < 0) state.openTabs.push(id);
        activateTab(id, true);
    }

    $("navigateBack").addEventListener("click", function () {
        navigateTabs(-1);
    });
    $("navigateForward").addEventListener("click", function () {
        navigateTabs(1);
    });
    $("toggleSecondarySidebar").addEventListener("click", function () {
        $("auxiliarybar").hidden = !$("auxiliarybar").hidden;
        syncLayoutChrome();
    });
    function updateLayoutMenu() {
        document.querySelectorAll("[data-layout]").forEach(function (button) {
            var visible =
                button.dataset.layout === "sidebar"
                    ? state.sidebarVisible
                    : button.dataset.layout === "panel"
                      ? state.panelVisible
                      : !$("auxiliarybar").hidden;
            button.setAttribute("aria-checked", String(visible));
        });
    }
    function closeLayoutMenu() {
        $("layout-menu").hidden = true;
        $("customizeLayout").setAttribute("aria-expanded", "false");
    }
    $("customizeLayout").addEventListener("click", function () {
        var open = $("layout-menu").hidden;
        $("layout-menu").hidden = !open;
        $("customizeLayout").setAttribute("aria-expanded", String(open));
        updateLayoutMenu();
        if (open) $("layout-menu").querySelector("button").focus();
    });
    document.querySelectorAll("[data-layout]").forEach(function (button) {
        button.addEventListener("click", function () {
            if (button.dataset.layout === "sidebar") toggleSidebar();
            else if (button.dataset.layout === "panel") togglePanel();
            else $("toggleSecondarySidebar").click();
            updateLayoutMenu();
        });
    });
    $("layout-menu").addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
            closeLayoutMenu();
            $("customizeLayout").focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            var buttons = Array.from($("layout-menu").querySelectorAll("button"));
            var index = buttons.indexOf(document.activeElement);
            buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
        } else return;
        event.preventDefault();
        event.stopPropagation();
    });

    function openFileTab(id) {
        if (!TAB_META[id]) {
            showToast("该文件未包含在复刻演示中：" + id, "info");
            return;
        }
        if (state.openTabs.indexOf(id) < 0) state.openTabs.push(id);
        activateTab(id);
    }

    function closeTab(id) {
        var index = state.openTabs.indexOf(id);
        if (index < 0) return;
        if (charts.has(id)) {
            const { host, frame, number } = charts.get(id);
            savedChartWatches.set(number, host.watchItems());
            host.destroy();
            charts.delete(id);
            if (number !== 1) frame.parentElement.remove();
            delete TAB_META[id];
        }
        state.openTabs.splice(index, 1);
        if (state.activeTab === id)
            state.activeTab = state.openTabs[Math.min(index, state.openTabs.length - 1)] || null;
        renderTabs();
        activateTab(state.activeTab);
    }

    function openLiveWatch() {
        let number = 1;
        while (charts.has(chartId(number))) number++;
        const id = chartId(number);
        TAB_META[id] = { label: tr("lw.panelTitle", { n: number }), type: "livewatch" };
        let frame = $("livewatchFrame");
        if (number !== 1 || !frame) {
            const pane = document.createElement("div");
            pane.className = "editor-pane";
            pane.dataset.pane = id;
            frame = document.createElement("iframe");
            frame.id = number === 1 ? "livewatchFrame" : "livewatchFrame-" + number;
            frame.title = TAB_META[id].label;
            pane.appendChild(frame);
            document.querySelector('[data-pane="file"]').after(pane);
        }
        mountLivewatchHost(frame, number);
        frame.src = frameSource("livewatch");
        state.openTabs.push(id);
        activateTab(id);
        switchView("emberprobe");
    }

    /* -------------------------------------------------------------- markdown */

    function renderMarkdown() {
        var source = D.FILES["README.md"].content;
        var html = "";
        var inCode = false;
        var inList = false;
        source.split("\n").forEach(function (line) {
            if (/^```/.test(line)) {
                if (inList) {
                    html += "</ul>";
                    inList = false;
                }
                html += inCode ? "</pre>" : "<pre>";
                inCode = !inCode;
                return;
            }
            if (inCode) {
                html += esc(line) + "\n";
                return;
            }
            var heading = line.match(/^(#{1,3})\s+(.*)$/);
            if (heading) {
                if (inList) {
                    html += "</ul>";
                    inList = false;
                }
                var level = heading[1].length;
                html += "<h" + level + ">" + inlineMd(heading[2]) + "</h" + level + ">";
                return;
            }
            if (/^>\s?/.test(line)) {
                if (inList) {
                    html += "</ul>";
                    inList = false;
                }
                html += "<blockquote>" + inlineMd(line.replace(/^>\s?/, "")) + "</blockquote>";
                return;
            }
            if (/^\d+\.\s+/.test(line)) {
                if (!inList) {
                    html += "<ul>";
                    inList = true;
                }
                html += "<li>" + inlineMd(line.replace(/^\d+\.\s+/, "")) + "</li>";
                return;
            }
            if (inList) {
                html += "</ul>";
                inList = false;
            }
            html += line.trim() ? "<p>" + inlineMd(line) + "</p>" : "";
        });
        if (inList) html += "</ul>";
        if (inCode) html += "</pre>";
        $("markdown-body").innerHTML = html;
    }

    function inlineMd(text) {
        return esc(text)
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    }

    /* -------------------------------------------------------- sidebar views */

    function renderExplorer() {
        function walk(nodes, depth) {
            return nodes
                .map(function (node) {
                    if (node.type === "folder") {
                        var open = node.open;
                        return (
                            '<div class="tree-row indent-' +
                            depth +
                            '" data-folder="' +
                            esc(node.label) +
                            '"><span class="chevron">' +
                            icon(open ? "chevron-down" : "chevron-right") +
                            '</span><span class="label">' +
                            esc(node.label) +
                            "</span></div>" +
                            (open ? walk(node.children || [], Math.min(3, depth + 1)) : "")
                        );
                    }
                    return (
                        '<div class="tree-row indent-' +
                        depth +
                        (node.modified ? " modified" : "") +
                        '" data-file="' +
                        esc(node.label) +
                        '"><span class="file-icon">' +
                        fileIcon(node.label) +
                        '</span><span class="label">' +
                        esc(node.label) +
                        "</span></div>"
                    );
                })
                .join("");
        }
        $("explorerTree").innerHTML = walk(D.EXPLORER, 0);
        $("outlineTree").innerHTML = [
            ["main", "function", 165],
            ["Motor_Init", "function", 48],
            ["Sensor_Update", "function", 61],
            ["ControlTask", "function", 81],
            ["SensorTask", "function", 121],
            ["CommsTask", "function", 139]
        ]
            .map(function (item) {
                return (
                    '<div class="tree-row"><span class="file-icon" style="color:var(--vscode-symbolIcon-methodForeground)">' +
                    icon("symbol-method") +
                    '</span><span class="label">' +
                    esc(item[0]) +
                    '</span><span style="margin-left:auto;color:var(--vscode-descriptionForeground)">' +
                    item[2] +
                    "</span></div>"
                );
            })
            .join("");
        $("timelineList").innerHTML =
            "<div>今天 14:32 · <b>EmberProbe</b> 烧录 EmberProbeDemo.elf（917504 字节）</div>" +
            "<div>今天 14:31 · <b>EmberProbe</b> 启动调试会话（J-Link · SWD）</div>" +
            "<div>今天 09:15 · 保存 main.c（1 个修改）</div>" +
            "<div>昨天 18:40 · 初始化仓库</div>";
    }

    function renderSearch() {
        $("searchResults").innerHTML = D.SEARCH_RESULTS.map(function (file) {
            return (
                '<div class="search-file"><span class="file-icon">' +
                fileIcon(file.file) +
                "</span>" +
                esc(file.file) +
                '<span style="margin-left:auto;color:var(--vscode-descriptionForeground)">' +
                file.matches.length +
                "</span></div>" +
                file.matches
                    .map(function (match) {
                        var text = esc(match.text).replace(/g_motor/g, "<mark>g_motor</mark>");
                        return (
                            '<div class="search-match" data-file="' +
                            esc(file.file.split("/").pop()) +
                            '" data-line="' +
                            match.line +
                            '"><span class="line-no">' +
                            match.line +
                            "</span><span>" +
                            text +
                            "</span></div>"
                        );
                    })
                    .join("")
            );
        }).join("");
    }

    function renderScm() {
        $("scmChanges").innerHTML = D.SCM_CHANGES.map(function (change) {
            return (
                '<div class="tree-row ' +
                (change.status === "U" ? "untracked" : "modified") +
                '"><span class="file-icon">' +
                fileIcon(change.label) +
                '</span><span class="label">' +
                esc(change.label) +
                '</span><span style="margin-left:auto">' +
                change.status +
                "</span></div>"
            );
        }).join("");
        $("scmGraph").innerHTML =
            "<div>● 8f3c21a &nbsp;EmberProbe: 更新实时变量面板</div>" +
            "<div>● 4d90b7e &nbsp;修正 PID 积分限幅</div>" +
            "<div>● 1a2c9f4 &nbsp;添加 FreeRTOS 任务统计</div>";
    }

    function renderVariableTree(nodes, depth, prefix) {
        return nodes
            .map(function (node) {
                var path = prefix ? prefix + "." + node.name : node.name;
                var hasChildren = !!(node.children && node.children.length);
                var expanded = !!state.expandedNodes[path];
                var html =
                    '<div class="tree-row' +
                    (hasChildren ? " expandable" : "") +
                    '" data-var-path="' +
                    esc(path) +
                    '" style="padding-left:' +
                    (12 + depth * 14) +
                    'px">' +
                    '<span class="chevron">' +
                    (hasChildren ? icon(expanded ? "chevron-down" : "chevron-right") : "") +
                    '</span><span class="var-name">' +
                    esc(node.name) +
                    '</span><span class="var-value">= ' +
                    esc(node.value) +
                    "</span>" +
                    (node.type ? '<span class="var-type">' + esc(node.type) + "</span>" : "") +
                    "</div>";
                if (hasChildren && expanded) html += renderVariableTree(node.children, depth + 1, path);
                return html;
            })
            .join("");
    }

    function renderDebugSidebar() {
        $("debugVariables").innerHTML = renderVariableTree(D.DEBUG.variables, 0, "");
        $("debugWatch").innerHTML = D.DEBUG.watch
            .map(function (item) {
                return (
                    '<div class="tree-row"><span class="chevron"></span><span class="var-name">' +
                    esc(item.name) +
                    '</span><span class="var-value">= ' +
                    esc(item.value) +
                    '</span><span class="var-type">' +
                    esc(item.type) +
                    "</span></div>"
                );
            })
            .join("");
        var callStack = [];
        if (state.debugActive && state.debugPaused) {
            var stack = state.debugStack.length
                ? state.debugStack
                : [{ name: debugFrame(), file: state.debugFile, line: state.debugLine }];
            callStack = stack.map(function (frame, index) {
                return {
                    name: frame.name,
                    file: frame.file,
                    line: frame.line,
                    detail: frame.file + ":" + frame.line,
                    active: index === 0
                };
            });
        }
        const coreRows =
            state.debugCores.length > 1
                ? state.debugCores
                      .map(
                          (_core, index) =>
                              '<button type="button" class="tree-row stack-row' +
                              (index === state.debugCore ? " active" : "") +
                              '" data-debug-core="' +
                              index +
                              '">EmberProbe · Cortex-M' +
                              (index === 0 ? 7 : 4) +
                              "</button>"
                      )
                      .join("")
                : "";
        $("debugCallStack").innerHTML =
            coreRows +
            callStack
                .map(function (frame, index) {
                    return (
                        '<div class="tree-row stack-row' +
                        (frame.active ? " active" : "") +
                        '" data-frame="' +
                        index +
                        '" data-file="' +
                        esc(frame.file || "") +
                        '"><span class="chevron"></span><span class="label">' +
                        esc(frame.name) +
                        '()</span><span class="stack-line" style="margin-left:auto">' +
                        esc(frame.detail) +
                        "</span></div>"
                    );
                })
                .join("");
        $("debugBreakpoints").innerHTML =
            state.breakpoints
                .map(function (item, index) {
                    return (
                        '<div class="tree-row breakpoint-row' +
                        (item.enabled ? "" : " disabled") +
                        '" data-breakpoint="' +
                        index +
                        '"><input type="checkbox" aria-label="切换断点 ' +
                        esc(item.file) +
                        ":" +
                        item.line +
                        '"' +
                        (item.enabled ? " checked" : "") +
                        '><span class="dot codicon codicon-debug-breakpoint"></span><span class="label">' +
                        esc(item.file) +
                        '</span><span class="file">:' +
                        item.line +
                        "</span></div>"
                    );
                })
                .join("") +
            dataBreakpoints
                .map(function (entry) {
                    var access = tr(
                        { write: "sb.dataWrite", read: "sb.dataRead", readWrite: "sb.dataAccess" }[entry.accessType]
                    );
                    var failed = entry.enabled && !entry.verified;
                    return (
                        '<div class="tree-row breakpoint-row data-breakpoint-row' +
                        (entry.enabled ? "" : " disabled") +
                        (failed ? " unverified" : "") +
                        '" data-data-breakpoint="' +
                        esc(entry.id) +
                        '" data-breakpoint-group="' +
                        (entry.native ? "native" : "sidebar") +
                        '" title="' +
                        esc([entry.description, entry.condition, entry.message].filter(Boolean).join("\n")) +
                        '"><input type="checkbox" aria-label="' +
                        esc(entry.name + " · " + access) +
                        '"' +
                        (entry.enabled ? " checked" : "") +
                        '><span class="dot codicon codicon-debug-breakpoint-data' +
                        (failed ? "-unverified" : "") +
                        '"></span><span class="label">' +
                        esc(entry.name) +
                        '</span><span class="file">' +
                        esc(access + (entry.condition ? " · " + entry.condition : "")) +
                        "</span></div>"
                    );
                })
                .join("");
    }

    function renderProblems() {
        $("problemsList").innerHTML = D.PROBLEMS.map(function (item) {
            return (
                '<div class="problem-row" data-file="' +
                esc(item.file) +
                '" data-line="' +
                item.line +
                '"><span class="severity ' +
                item.severity +
                '">' +
                icon(item.severity === "error" ? "error" : "warning") +
                "</span><span>" +
                esc(item.message) +
                '</span><span class="location">' +
                esc(item.file) +
                ":" +
                item.line +
                '</span><span class="source">' +
                esc(item.source) +
                "</span></div>"
            );
        }).join("");
        $("problemCount").textContent = String(D.PROBLEMS.length);
        $("problemStatus").innerHTML = icon("error") + " 0 " + icon("warning") + " " + D.PROBLEMS.length;
    }

    function renderPanelBody() {
        function linesHtml(lines) {
            return lines
                .map(function (line) {
                    return '<span class="' + (line.cls || "dim-line") + '">' + esc(line.text) + "</span>";
                })
                .join("\n");
        }
        renderTerminal();
        $("terminalPrompt").querySelector(".cmd").textContent = workspace.slice(0, -1) + ">";
        $("outputBody").innerHTML = linesHtml(D.OUTPUT_LINES);
        $("debugConsoleBody").textContent = "";
    }

    /* ---------------------------------------------------------- view switch */

    function switchView(view) {
        state.activeView = view;
        document.querySelectorAll(".activity-item").forEach(function (item) {
            item.classList.toggle("active", item.dataset.view === view);
        });
        document.querySelectorAll("#sidebar-views .view").forEach(function (section) {
            section.classList.toggle("active", section.dataset.view === view);
        });
    }

    function setActionIcon(id, base, visible) {
        const glyph = $(id)?.querySelector(".codicon");
        if (!glyph) return;
        glyph.classList.toggle("codicon-" + base, visible);
        glyph.classList.toggle("codicon-" + base + "-off", !visible);
    }

    function syncLayoutChrome() {
        const auxiliaryVisible = !$("auxiliarybar").hidden;
        $("workbench").classList.toggle("nosidebar", !state.sidebarVisible);
        $("workbench").classList.toggle("nopanel", !state.panelVisible);
        $("toggleSidebar").setAttribute("aria-expanded", String(state.sidebarVisible));
        $("togglePanel").setAttribute("aria-expanded", String(state.panelVisible));
        $("toggleSecondarySidebar").setAttribute("aria-expanded", String(auxiliaryVisible));
        setActionIcon("toggleSidebar", "layout-sidebar-left", state.sidebarVisible);
        setActionIcon("togglePanel", "layout-panel", state.panelVisible);
        setActionIcon("toggleSecondarySidebar", "layout-sidebar-right", auxiliaryVisible);
    }

    function showPanel(name) {
        state.activePanel = name;
        state.panelVisible = true;
        $("panel").classList.remove("collapsed");
        document.querySelectorAll(".panel-tabs button").forEach(function (button) {
            button.classList.toggle("active", button.dataset.panel === name);
        });
        document.querySelectorAll(".panel-pane").forEach(function (pane) {
            pane.classList.toggle("active", pane.dataset.panelPane === name);
        });
        $("rttClear").hidden = name !== "rtt";
        syncLayoutChrome();
    }

    function togglePanel() {
        state.panelVisible = !state.panelVisible;
        $("panel").classList.toggle("collapsed", !state.panelVisible);
        syncLayoutChrome();
    }

    function toggleSidebar() {
        state.sidebarVisible = !state.sidebarVisible;
        $("sidebar").classList.toggle("hidden", !state.sidebarVisible);
        syncLayoutChrome();
    }

    /* --------------------------------------------------------------- debug */

    // VS Code's status bar item for the debug session; the extension itself contributes none.
    function updateDebugStatus() {
        $("debugSessionStatus").classList.toggle("hidden", !state.debugActive);
        $("debugSessionName").textContent =
            state.debugCores.length > 1
                ? "EmberProbe · Cortex-M" + (state.debugCore === 0 ? 7 : 4)
                : "EmberProbe: " + projectName;
    }

    function updateDebugToolbar() {
        $("debug-toolbar").classList.toggle("hidden", !state.debugActive);
        $("dbgContinue").innerHTML = icon(state.debugPaused ? "debug-continue" : "debug-pause");
        $("dbgContinue").title = state.debugPaused ? "继续 (F5)" : "暂停 (F6)";
        $("dbgContinue").setAttribute("aria-label", $("dbgContinue").title);
        $("dbgContinue").disabled = state.debugStopping || !!pauseTimer;
        const detach = state.debugKind === "attach";
        $("dbgStop").innerHTML = icon(detach ? "debug-disconnect" : "debug-stop");
        $("dbgStop").title = detach ? tr("mock.detach") : tr("mock.stopDebug");
        $("dbgStop").setAttribute("aria-label", $("dbgStop").title);
        $("dbgRestart").disabled = state.debugStopping;
        $("dbgStop").disabled = state.debugStopping;
        document.body.classList.toggle("debugging", state.debugActive);
        ["dbgStepOver", "dbgStepInto", "dbgStepOut"].forEach(function (id) {
            $(id).disabled = !state.debugPaused || state.debugStopping || !!stepTimer;
        });
    }

    function startDebug(kind) {
        if (state.debugActive) return;
        if (sidebarHost) sidebarHost.startDebug(kind);
    }

    function buildStackForFrame(name, file, line) {
        if (file === "main.c" && name === "main") return [{ name: "main", file, line }];
        if (file === "tasks.c")
            return [
                { name, file, line },
                { name: "prvPortStartFirstTask", file: "port.c", line: 412 }
            ];
        return [
            { name, file, line },
            { name: "vTaskDelayUntil", file: "tasks.c", line: 1682 },
            { name: "prvPortStartFirstTask", file: "port.c", line: 412 }
        ];
    }

    function completeDebugStart(kind, cores) {
        const resetMain = kind !== "attach";
        const idleLine = findIdleCallLine();
        const mainLine = findMainLine();
        const location = resetMain
            ? {
                  file: "main.c",
                  line: mainLine,
                  inMain: true,
                  stack: [{ name: "main", file: "main.c", line: mainLine }]
              }
            : {
                  file: "tasks.c",
                  line: idleLine,
                  inMain: false,
                  stack: buildStackForFrame("prvIdleTask", "tasks.c", idleLine)
              };
        state.debugActive = true;
        state.debugKind = kind;
        state.debugPaused = false;
        state.debugInMain = location.inMain;
        state.debugFile = location.file;
        state.debugLine = location.line;
        state.debugStack = location.stack;
        state.debugCore = 0;
        state.debugCores = Array.from({ length: cores }, () => ({
            debugPaused: true,
            debugInMain: location.inMain,
            debugLine: location.line,
            debugFile: location.file,
            debugStack: location.stack.map((frame) => Object.assign({}, frame))
        }));
        updateDebugToolbar();
        updateDebugStatus();
        renderDebugSidebar();
        showPanel("debug-console");
        appendDebugOutput(
            resetMain
                ? [
                      "[stm32f4x.cpu] halted due to debug-request, current mode: Thread",
                      "xPSR: 0x01000000 pc: 0x08000284 msp: 0x20020000",
                      "Note: automatically using hardware breakpoints for read-only addresses."
                  ]
                : [
                      "[stm32f4x.cpu] halted due to debug-request, current mode: Thread",
                      "xPSR: 0x61000000 pc: 0x08004a1c msp: 0x2001fe40"
                  ],
            true
        );
        sidebarHost?.setTargetState("running", { notify: false, starting: true });
        initialStopTimer = setTimeout(
            () => stopAt(location.line, { ...location, reason: resetMain ? "entry" : "attach" }),
            resetMain ? 320 : 120
        );
    }

    function clearDebugTimers(includeStop = true) {
        clearTimeout(breakpointTimer);
        clearTimeout(initialStopTimer);
        clearTimeout(stepTimer);
        clearTimeout(pauseTimer);
        breakpointTimer = initialStopTimer = stepTimer = pauseTimer = null;
        if (includeStop) {
            clearTimeout(stopTimer);
            stopTimer = null;
        }
    }

    function debugFrame() {
        if (state.debugStack.length) return state.debugStack[0].name;
        return state.debugInMain ? "main" : "ControlTask";
    }

    function appendDebugOutput(lines, replace = false) {
        const output = $("debugConsoleBody");
        if (replace) output.replaceChildren();
        for (const line of lines) {
            if (output.childNodes.length) output.append("\n");
            const span = document.createElement("span");
            span.textContent = line;
            output.append(span);
        }
        output.parentElement.scrollTop = output.parentElement.scrollHeight;
    }

    function logDebugStop(reason) {
        const { debugFile: file, debugLine: line } = state;
        const frame = debugFrame() + " () at " + D.FILES[file].path + ":" + line;
        const source = line + "\t" + (codeLines(file)[line - 1]?.trim() || "");
        const before = {
            entry: ["Temporary breakpoint 1, " + frame],
            pause: ["Program received signal SIGINT, Interrupt.", frame],
            pauseFrame: [frame],
            breakpoint: ["Breakpoint, " + frame],
            attach: [frame],
            stepFrame: [frame],
            step: []
        };
        appendDebugOutput(["", ...before[reason], source]);
    }

    function selectDebugCore(core) {
        if (!state.debugCores[core] || state.debugCore === core || state.debugStopping || pauseTimer || stepTimer)
            return;
        clearTimeout(breakpointTimer);
        const { debugPaused, debugInMain, debugLine, debugFile, debugStack } = state;
        state.debugCores[state.debugCore] = { debugPaused, debugInMain, debugLine, debugFile, debugStack };
        state.debugCore = core;
        Object.assign(state, state.debugCores[core]);
        sidebarHost.setTargetState(state.debugPaused ? "halted" : "running", {
            notify: false,
            file: state.debugFile,
            line: state.debugLine
        });
        updateDebugToolbar();
        updateDebugStatus();
        renderEditor();
        renderDebugSidebar();
    }

    function finishStopDebug() {
        stopTimer = null;
        state.debugActive = false;
        state.debugPaused = false;
        state.debugStopping = false;
        state.debugInMain = false;
        state.debugStack = [];
        state.debugCores = [];
        $("debug-toolbar").classList.add("hidden");
        updateDebugToolbar();
        updateDebugStatus();
        renderEditor();
        renderDebugSidebar();
        if (sidebarHost) sidebarHost.setTargetState("running", { notify: false, ended: true });
    }

    function stopDebug() {
        if (!state.debugActive) {
            clearDebugTimers();
            if (sidebarHost) sidebarHost.cancelDebugStart();
            return;
        }
        if (state.debugStopping) return;
        clearDebugTimers(false);
        state.debugStopping = true;
        updateDebugToolbar();
        stopTimer = setTimeout(finishStopDebug, 380);
    }

    function pauseDebug() {
        if (!state.debugActive || state.debugPaused || state.debugStopping || pauseTimer) return;
        const idleLine = findIdleCallLine();
        pauseTimer = setTimeout(() => {
            if (!state.debugActive || state.debugStopping) {
                pauseTimer = null;
                return;
            }
            appendDebugOutput(["", "Program received signal SIGINT, Interrupt."]);
            pauseTimer = setTimeout(() => {
                pauseTimer = null;
                if (!state.debugActive || state.debugStopping) return;
                stopAt(idleLine, {
                    file: "tasks.c",
                    inMain: false,
                    stack: buildStackForFrame("prvIdleTask", "tasks.c", idleLine),
                    reason: "pauseFrame"
                });
            }, 160);
        }, 100);
        updateDebugToolbar();
    }

    function stopAt(line, { file = "main.c", inMain = false, stack, reason } = {}) {
        clearDebugTimers();
        state.debugPaused = true;
        state.debugInMain = inMain;
        state.debugLine = line;
        state.debugFile = file;
        if (Array.isArray(stack) && stack.length) state.debugStack = stack;
        else {
            const fn = findEnclosingFunction(file, line);
            state.debugStack = buildStackForFrame(fn.name, file, line);
        }
        state.lastStop = { file, line, inMain };
        if (reason) logDebugStop(reason);
        openFileTab(file);
        updateDebugToolbar();
        renderEditor();
        renderDebugSidebar();
        sidebarHost?.setTargetState("halted", {
            notify: false,
            file,
            line,
            step: reason === "step" || reason === "stepFrame"
        });
    }

    function markDebugRunning() {
        state.debugPaused = false;
        updateDebugToolbar();
        renderEditor();
        renderDebugSidebar();
        sidebarHost?.setTargetState("running", { notify: false });
    }

    function continueDebug() {
        if (sidebarHost?.isDebugStarting() || state.debugStopping || pauseTimer || stepTimer) return;
        if (!state.debugActive) return startDebug();
        if (!state.debugPaused) return;
        resumeDebug();
    }

    function resumeDebug() {
        markDebugRunning();
        if (enabledSourceBreakpoint()) {
            breakpointTimer = setTimeout(() => {
                const hit = enabledSourceBreakpoint();
                if (!state.debugActive || state.debugPaused || !hit) return;
                const fn = findEnclosingFunction(hit.file, hit.line);
                const inMain = hit.file === "main.c" && fn.name === "main";
                stopAt(hit.line, {
                    file: hit.file,
                    inMain,
                    stack: buildStackForFrame(fn.name, hit.file, hit.line),
                    reason: "breakpoint"
                });
            }, 400);
        }
    }

    function restartDebug() {
        if (!state.debugActive || state.debugStopping || state.debugCores.length > 1) return;
        clearDebugTimers();
        simulator.reset();
        markDebugRunning();
        appendDebugOutput([
            "[stm32f4x.cpu] halted due to debug-request, current mode: Thread",
            "xPSR: 0x01000000 pc: 0x08000284 msp: 0x20020000",
            "Note: automatically using hardware breakpoints for read-only addresses."
        ]);
        const line = findMainLine();
        initialStopTimer = setTimeout(() => {
            if (!state.debugActive || state.debugStopping) return;
            stopAt(line, {
                file: "main.c",
                inMain: true,
                stack: [{ name: "main", file: "main.c", line }],
                reason: "entry"
            });
        }, 320);
    }

    function readyToStep() {
        if (sidebarHost?.isDebugStarting() || state.debugStopping || stepTimer || pauseTimer) return false;
        if (!state.debugActive) {
            startDebug();
            return false;
        }
        return state.debugPaused;
    }

    function runStep(nextStop) {
        if (!nextStop || stepTimer || state.debugStopping) return;
        markDebugRunning();
        stepTimer = setTimeout(() => {
            stepTimer = null;
            if (!state.debugActive || state.debugStopping) return;
            stopAt(nextStop.line, nextStop);
        }, 240);
        updateDebugToolbar();
    }

    function stepOverDebug() {
        if (!readyToStep()) return;
        const file = state.debugFile;
        const next = nextExecutableInFunction(file, state.debugLine);
        const stack = state.debugStack.length
            ? state.debugStack.map((frame, index) => (index === 0 ? { ...frame, line: next } : frame))
            : undefined;
        runStep({ line: next, file, reason: "step", inMain: state.debugInMain, stack });
    }

    function stepIntoDebug() {
        if (!readyToStep()) return;
        const sourceLine = codeLines(state.debugFile)[state.debugLine - 1] || "";
        for (const name of Object.keys(STEP_CALLEES)) {
            if (!new RegExp("\\b" + name + "\\s*\\(").test(sourceLine)) continue;
            const callee = findCalleeEntry(name);
            if (!callee) continue;
            const caller = state.debugStack.length
                ? state.debugStack.map((frame, index) =>
                      index === 0 ? { ...frame, file: state.debugFile, line: state.debugLine } : frame
                  )
                : buildStackForFrame(
                      findEnclosingFunction(state.debugFile, state.debugLine).name,
                      state.debugFile,
                      state.debugLine
                  );
            runStep({
                line: callee.line,
                file: callee.file,
                inMain: false,
                stack: [callee, ...caller],
                reason: "stepFrame"
            });
            return;
        }
        stepOverDebug();
    }

    function stepOutDebug() {
        if (!readyToStep()) return;
        if (state.debugStack.length > 1 && D.FILES[state.debugStack[1].file]) {
            const rest = state.debugStack.slice(1);
            const caller = rest[0];
            const next = nextExecutableInFunction(caller.file, caller.line);
            const stack = rest.map((frame, index) => (index === 0 ? { ...frame, line: next } : frame));
            runStep({
                line: next,
                file: caller.file,
                inMain: caller.file === "main.c" && caller.name === "main",
                stack,
                reason: "stepFrame"
            });
            return;
        }
        stepOverDebug();
    }

    function renderTerminal() {
        const lines = terminalSession === "flash" ? flashLines : [];
        $("terminalBody").innerHTML = lines
            .map(({ cls, text }) => '<span class="' + (cls || "") + '">' + esc(text) + "</span>")
            .join("\n");
        $("terminalPrompt").hidden = terminalSession === "flash";
        $("terminalSessions").hidden = flashLines.length === 0;
        for (const button of $("terminalSessions").querySelectorAll("[data-terminal-session]"))
            button.setAttribute("aria-pressed", String(button.dataset.terminalSession === terminalSession));
        const output = $("terminalSessionOutput");
        output.scrollTop = terminalSession === "flash" ? output.scrollHeight : 0;
    }

    function appendFlashLog(event) {
        if (event.start) {
            flashLines.length = 0;
            terminalSession = "flash";
            showPanel("terminal");
        }
        flashLines.push(...event.lines);
        if (terminalSession === "flash") renderTerminal();
    }

    /* ------------------------------------------------------------ frame hosts */

    function notify(event) {
        if (!event || !event.action) return;
        switch (event.action) {
            case "toast":
                showToast(event.text);
                break;
            case "debugStart":
                completeDebugStart(event.kind, event.cores);
                break;
            case "debugCoreSelected":
                selectDebugCore(event.core);
                break;
            case "debugPending":
                $("debugStartButton").disabled = event.busy;
                $("debugStartButton").setAttribute("aria-busy", String(event.busy));
                break;
            case "debugSessionChanged":
                debugScope = event.id;
                charts.forEach(({ host }) => host.debugSessionChanged(debugScope));
                break;
            case "sampling":
                samplingPhase = event.phase;
                charts.forEach(({ host }) => host.setSampling(samplingPhase));
                break;
            case "csvReveal":
                revealCsv(event.fileName, event.csv);
                break;
            case "flashLog":
                appendFlashLog(event);
                break;
            case "openLiveWatch":
                openLiveWatch();
                break;
            case "targetState":
                if (event.state === "running") {
                    state.debugPaused = false;
                    updateDebugToolbar();
                    renderEditor();
                } else {
                    if (!state.debugPaused) state.debugLine = findDebugLine();
                    state.debugActive = true;
                    state.debugPaused = true;
                    $("debug-toolbar").classList.remove("hidden");
                    updateDebugToolbar();
                    renderEditor();
                }
                break;
            case "setLang":
                swapLanguage(event.page, event.lang);
                break;
            case "rtt":
                if (event.state !== "stopped") showRttTab();
                if (rttHost) rttHost.sync(event);
                break;
            case "rttReveal":
                showRttTab();
                showPanel("rtt");
                if (event.focus && $("rttFrame").contentWindow) $("rttFrame").focus();
                break;
            case "pauseDebug":
                pauseDebug();
                break;
            case "dataBreakpoints":
                dataBreakpoints = (event.entries || []).filter((entry) => entry.native);
                renderDebugSidebar();
                break;
            case "dataBreakpointHit":
                if (!state.debugActive || state.debugPaused) break;
                clearTimeout(breakpointTimer);
                $("debugConsoleBody").innerHTML +=
                    "\n" +
                    esc(
                        tr("mock.dataHit") +
                            ": " +
                            event.name +
                            " · " +
                            tr(
                                { write: "sb.dataWrite", read: "sb.dataRead", readWrite: "sb.dataAccess" }[
                                    event.accessType
                                ]
                            ) +
                            " — ControlTask()"
                    ) +
                    (event.oldValue === undefined || event.newValue === undefined
                        ? ""
                        : "\n" + esc(tr("debug.dataBreakpointValues", { old: event.oldValue, new: event.newValue })));
                stopAt(findDebugLine());
                break;
            default:
                break;
        }
    }

    function swapLanguage(page, lang) {
        // The real renderer has already changed its language in place. Keep
        // the frame and host alive so sampling, history and user edits survive.
        var next = lang === "en" ? "en" : "zh";
        var changed = next !== state.lang;
        state.lang = next;
        charts.forEach(({ number }) => {
            TAB_META[chartId(number)].label = tr("lw.panelTitle", { n: number });
        });
        renderTabs();
        if (changed) {
            if (page !== "sidebar") sidebarHost?.send({ type: "setLang", lang: next });
            charts.forEach(({ host }) => host.send({ type: "setLang", lang: next }));
        }
        // The RTT view is rebuilt in the new language and asks for its snapshot again (RttPanelHost.languageChanged).
        if (changed && rttHost) {
            rttHost.reload();
            $("rttFrame").src = "rtt-panel." + next + ".html";
        }
    }

    function showRttTab() {
        if (rttShown) return;
        rttShown = true;
        $("rttPanelTab").hidden = false;
    }

    function mountRttHost() {
        if (rttHost) rttHost.destroy();
        rttHost = window.EmberProbeRttPanelHost.create($("rttFrame"), {
            simulator: simulator,
            translate: tr,
            saveLog: (fileName, chunks) => {
                if (typeof URL.createObjectURL !== "function") return;
                const url = URL.createObjectURL(new Blob(chunks, { type: "application/octet-stream" }));
                const link = document.createElement("a");
                link.href = url;
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
        });
        // The page may have loaded, and posted its ready, before this host listened.
        var catchUp = function () {
            setTimeout(function () {
                if (rttHost && !rttHost.isReady()) rttHost.sendSnapshot();
            }, 60);
        };
        $("rttFrame").addEventListener("load", catchUp);
        setTimeout(function () {
            if (rttHost && !rttHost.isReady()) rttHost.sendSnapshot();
        }, 600);
    }

    function mountSidebarHost() {
        if (sidebarHost) sidebarHost.destroy();
        sidebarHost = window.EmberProbeSidebarHost.create($("sidebarFrame"), {
            notify: notify,
            simulator: simulator,
            quickPick: showQuickPick,
            inputBox: showInputBox,
            sidebarInterval: (phase) => readPlan(phase).sidebarMs,
            selectLogFile: (value, done) => selectOutputFile("mock.saveRttLog", value, done),
            mcpOutcome: new URLSearchParams(window.location.search).get("mcp"),
            debugCores: dualCore ? 2 : 1,
            isEnglish: function () {
                return state.lang === "en";
            }
        });
        var frame = $("sidebarFrame");
        frame.onload = function () {
            if (sidebarHost && !sidebarHost.isInitialized())
                setTimeout(function () {
                    if (sidebarHost && !sidebarHost.isInitialized()) sidebarHost.sendInitialState();
                }, 60);
        };
        setTimeout(function () {
            if (sidebarHost && !sidebarHost.isInitialized()) sidebarHost.sendInitialState();
        }, 600);
    }

    function chartId(number) {
        return number === 1 ? "livewatch" : "livewatch-" + number;
    }

    function readPlan(phase) {
        const sampling = window.EmberProbeMockSampling;
        const graph = sampling.workload(Array.from(charts.values()).flatMap(({ host }) => host.readItems()));
        const sidebar = sampling.workload(sidebarHost?.readItems() || []);
        return sampling.plan(samplingSettings, graph, sidebar, phase === "sampling");
    }

    function revealCsv(fileName, csv) {
        let folder = D.EXPLORER.find((entry) => entry.label === "exports");
        if (!folder) {
            folder = { type: "folder", label: "exports", open: true, children: [] };
            D.EXPLORER.push(folder);
        }
        folder.open = true;
        if (!folder.children.some((entry) => entry.label === fileName))
            folder.children.push({ type: "file", label: fileName });
        D.FILES[fileName] = { label: fileName, language: "CSV", path: "exports/" + fileName, content: csv };
        renderExplorer();
        switchView("explorer");
        Array.from($("explorerTree").querySelectorAll("[data-file]"))
            .find((entry) => entry.dataset.file === fileName)
            ?.scrollIntoView?.({ block: "nearest" });
    }

    function mountLivewatchHost(frame = $("livewatchFrame"), number = 1) {
        const host = window.EmberProbeLiveWatchHost.create(frame, {
            notify: notify,
            simulator: simulator,
            scope: chartId(number),
            archive,
            history: chartHistory,
            settings: samplingSettings,
            watchItems: savedChartWatches.get(number) || (number === 1 ? undefined : []),
            readPlan,
            settingsChanged: () => charts.forEach(({ host }) => host.settingsChanged()),
            archiveFullMessage: () => tr("mock.archiveFull"),
            selectCsvFile: (value, done) => selectOutputFile("lw.exportCsv", value, done),
            requestSampling: function (running) {
                if (!sidebarHost) return;
                if (running) sidebarHost.startSampling();
                else sidebarHost.stopSampling();
            },
            getSidebarWatch: function () {
                return sidebarHost ? sidebarHost.getWatchList() : [];
            }
        });
        const id = chartId(number);
        charts.set(id, { frame, host, number });
        frame.onload = () => sendTheme(frame);
        host.debugSessionChanged(debugScope);
        host.setSampling(samplingPhase);
        setTimeout(() => {
            if (charts.get(id)?.host === host && !host.isInitialized()) host.sendReady();
        }, 600);
    }

    function selectOutputFile(key, value, done) {
        showInputBox(
            {
                title: tr(key),
                value,
                validate: (name) => (name.trim() && !/[\\/:*?"<>|]/.test(name) ? "" : tr("mock.csvFileName"))
            },
            (name) => done(name?.trim())
        );
    }

    function editRttSettings() {
        const { json, parse } = window.EmberProbeMockRttSettings;
        showInputBox(
            {
                title: tr("mock.rttSettings"),
                value: json(rttSettings),
                validate: (input) => (parse(input) ? "" : tr("mock.rttSettingsInvalid"))
            },
            (input) => {
                if (input === undefined) return;
                rttSettings = parse(input);
                sidebarHost?.applyRttSettings(rttSettings);
                rttHost?.setInputMode(rttSettings);
            }
        );
    }

    /* ------------------------------------------------------------ quick input */

    // vscode.window.showQuickPick / showInputBox for the mock host: done(undefined) when dismissed.
    var quick = null;

    function showQuickMessage(text) {
        $("quickInputMessage").textContent = text || "";
        $("quickInputMessage").hidden = !text;
    }

    function closeQuickInput(result) {
        if (!quick) return;
        var done = quick.done;
        quick = null;
        $("quick-input").classList.add("hidden");
        done(result);
    }

    function renderQuickList() {
        var list = $("quickInputList");
        if (!quick || quick.mode !== "pick") {
            list.innerHTML = "";
            list.hidden = true;
            return;
        }
        list.hidden = false;
        var needle = $("quickInputText").value.trim().toLowerCase();
        quick.visible = quick.items.filter(function (item) {
            var text = (item.label + " " + (item.description || "")).toLowerCase();
            return !needle || item.other || text.indexOf(needle) >= 0;
        });
        quick.index = Math.min(quick.index, Math.max(0, quick.visible.length - 1));
        list.setAttribute("aria-multiselectable", String(!!quick.settings.canPickMany));
        list.innerHTML = quick.visible
            .map(function (item, index) {
                return (
                    '<div class="palette-item quick-item' +
                    (index === quick.index ? " selected" : "") +
                    '" role="option" aria-selected="' +
                    String(!!item.picked) +
                    '" data-index="' +
                    index +
                    '">' +
                    (quick.settings.canPickMany
                        ? '<input type="checkbox" tabindex="-1" aria-hidden="true"' +
                          (item.picked ? " checked" : "") +
                          ">"
                        : "") +
                    '<span class="quick-label">' +
                    esc(item.label) +
                    "</span>" +
                    (item.description ? '<span class="p-category">' + esc(item.description) + "</span>" : "") +
                    (item.detail ? '<span class="p-key">' + esc(item.detail) + "</span>" : "") +
                    "</div>"
                );
            })
            .join("");
    }

    function openQuickInput(next, title, placeholder, value) {
        if (quick) closeQuickInput(undefined);
        closePalette();
        quick = next;
        $("quickInputTitle").textContent = title || "";
        $("quickInputTitle").hidden = !title;
        $("quickInputText").value = value || "";
        $("quickInputText").placeholder = placeholder || "";
        $("quickInputOk").hidden = quick.mode === "pick" && !quick.settings.canPickMany;
        $("quickInputOk").textContent = state.lang === "en" ? "OK" : "确定";
        showQuickMessage("");
        $("quick-input").classList.remove("hidden");
        renderQuickList();
        $("quickInputText").focus();
    }

    function showQuickPick(items, settings, done) {
        settings = settings || {};
        openQuickInput(
            {
                mode: "pick",
                settings: settings,
                done: done,
                index: 0,
                visible: [],
                items: items.map(function (item) {
                    return Object.assign({}, item);
                })
            },
            settings.title,
            settings.placeHolder,
            ""
        );
    }

    function showInputBox(settings, done) {
        settings = settings || {};
        openQuickInput(
            { mode: "input", settings: settings, done: done },
            settings.title,
            settings.prompt,
            settings.value
        );
    }

    function acceptQuickInput() {
        if (!quick) return;
        if (quick.mode === "input") {
            var value = $("quickInputText").value;
            var problem = quick.settings.validate ? quick.settings.validate(value) : "";
            if (problem) return showQuickMessage(problem);
            return closeQuickInput(value);
        }
        if (quick.settings.canPickMany)
            return closeQuickInput(
                quick.items.filter(function (item) {
                    return item.picked;
                })
            );
        var item = quick.visible[quick.index];
        if (item) closeQuickInput(item);
    }

    function toggleQuickItem(index) {
        if (!quick || !quick.visible[index]) return;
        quick.index = index;
        if (!quick.settings.canPickMany) return acceptQuickInput();
        quick.visible[index].picked = !quick.visible[index].picked;
        renderQuickList();
    }

    /* ---------------------------------------------------------- command palette */

    var paletteIndex = 0;
    var paletteItems = [];

    function openPalette() {
        $("command-palette").classList.remove("hidden");
        $("paletteInput").value = "";
        paletteIndex = 0;
        renderPalette("");
        $("paletteInput").focus();
    }

    function closePalette() {
        $("command-palette").classList.add("hidden");
    }

    function renderPalette(query) {
        var needle = query.trim().toLowerCase();
        paletteItems = D.COMMANDS.filter(function (command) {
            var text = (command.category + ": " + command.title).toLowerCase();
            return !needle || text.indexOf(needle) >= 0;
        }).slice(0, 40);
        paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1));
        if (!paletteItems.length) {
            $("paletteList").innerHTML = '<div class="palette-empty">未找到匹配的命令</div>';
            return;
        }
        $("paletteList").innerHTML = paletteItems
            .map(function (command, index) {
                return (
                    '<div class="palette-item' +
                    (index === paletteIndex ? " selected" : "") +
                    '" data-index="' +
                    index +
                    '"><span class="p-category">' +
                    esc(command.category) +
                    ":</span><span>" +
                    esc(command.title) +
                    "</span>" +
                    (command.key ? '<span class="p-key">' + esc(command.key) + "</span>" : "") +
                    "</div>"
                );
            })
            .join("");
    }

    function runCommand(action) {
        if (action.indexOf("toast:") === 0) return showToast(action.slice(6), "info");
        if (action.indexOf("view:") === 0) return switchView(action.slice(5));
        if (action.indexOf("panel:") === 0) return showPanel(action.slice(6));
        switch (action) {
            case "theme":
                openThemeMenu();
                break;
            case "theme:light":
            case "theme:dark":
                setTheme(action.slice(6), true);
                break;
            case "debug":
                startDebug();
                break;
            case "download":
                if (sidebarHost) sidebarHost.download();
                break;
            case "livewatch":
                openLiveWatch();
                break;
            case "rttSettings":
                editRttSettings();
                break;
            case "toggleSidebar":
                toggleSidebar();
                break;
            case "togglePanel":
                togglePanel();
                break;
            case "resume":
                continueDebug();
                break;
            case "pause":
                pauseDebug();
                break;
            case "step":
                stepOverDebug();
                break;
            case "stopDebug":
                stopDebug();
                break;
            case "reload":
                window.location.reload();
                break;
            default:
                break;
        }
    }

    /* -------------------------------------------------------------- shortcuts */

    document.addEventListener("keydown", function (event) {
        var paletteOpen = !$("command-palette").classList.contains("hidden");
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
            event.preventDefault();
            paletteOpen ? closePalette() : openPalette();
            return;
        }
        if (paletteOpen) {
            if (event.key === "Escape") closePalette();
            else if (event.key === "ArrowDown") {
                event.preventDefault();
                paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1);
                renderPalette($("paletteInput").value);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                paletteIndex = Math.max(0, paletteIndex - 1);
                renderPalette($("paletteInput").value);
            } else if (event.key === "Enter" && paletteItems[paletteIndex]) {
                var command = paletteItems[paletteIndex];
                closePalette();
                runCommand(command.action);
            }
            return;
        }
        if (event.key === "F5" && event.ctrlKey && event.shiftKey) {
            event.preventDefault();
            restartDebug();
        } else if (event.key === "F5" && !event.shiftKey) {
            event.preventDefault();
            state.debugPaused ? continueDebug() : startDebug();
        } else if (event.key === "F5" && event.shiftKey) {
            event.preventDefault();
            stopDebug();
        } else if (event.key === "F10") {
            event.preventDefault();
            stepOverDebug();
        } else if (event.key === "F11" && event.shiftKey) {
            event.preventDefault();
            stepOutDebug();
        } else if (event.key === "F11") {
            event.preventDefault();
            stepIntoDebug();
        } else if (event.key === "F6") {
            event.preventDefault();
            pauseDebug();
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
            event.preventDefault();
            toggleSidebar();
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") {
            event.preventDefault();
            togglePanel();
        } else if ((event.ctrlKey || event.metaKey) && event.key === "`") {
            event.preventDefault();
            showPanel("terminal");
        }
    });

    /* ----------------------------------------------------------------- wiring */

    document.querySelectorAll(".activity-item[data-view]").forEach(function (item) {
        item.addEventListener("click", function () {
            if (item.dataset.view === "accounts") {
                showToast("账户同步为演示占位", "info");
                return;
            }
            switchView(item.dataset.view);
        });
    });

    $("tabList").addEventListener("click", function (event) {
        var close = event.target.closest("[data-close]");
        if (close) {
            closeTab(close.dataset.close);
            return;
        }
        var tab = event.target.closest("[data-tab]");
        if (tab) activateTab(tab.dataset.tab);
    });

    $("explorerTree").addEventListener("click", function (event) {
        var folder = event.target.closest("[data-folder]");
        if (folder) {
            toggleFolder(D.EXPLORER, folder.dataset.folder);
            renderExplorer();
            return;
        }
        var file = event.target.closest("[data-file]");
        if (file) openFileTab(file.dataset.file);
    });

    function toggleFolder(nodes, label) {
        nodes.forEach(function (node) {
            if (node.type === "folder") {
                if (node.label === label) node.open = !node.open;
                if (node.open) toggleFolder(node.children || [], label);
            }
        });
    }

    $("searchResults").addEventListener("click", function (event) {
        var match = event.target.closest(".search-match");
        if (match) openFileTab(TAB_META[match.dataset.file] ? match.dataset.file : "main.c");
    });

    $("debugVariables").addEventListener("click", function (event) {
        var row = event.target.closest("[data-var-path]");
        if (!row) return;
        var path = row.dataset.varPath;
        state.expandedNodes[path] = !state.expandedNodes[path];
        renderDebugSidebar();
    });

    $("debugVariables").addEventListener("contextmenu", (event) => {
        const row = event.target.closest("[data-var-path]");
        const name = row?.dataset.varPath.replace(/\.\[/g, "[");
        if (!name || !state.debugPaused) return;
        event.preventDefault();
        const info = sidebarHost?.nativeBreakpointInfo(name);
        if (!info?.dataId) return showToast(info?.description || tr("sb.dataUnsupported"));
        const labels = { write: "sb.dataWrite", read: "sb.dataRead", readWrite: "sb.dataAccess" };
        showQuickPick(
            info.accessTypes.map((value) => ({ value, label: tr(labels[value]) })),
            {
                title: name + " · " + info.description
            },
            (choice) => {
                if (choice) sidebarHost.nativeBreakpoint(name, "add", choice.value, info.epoch);
            }
        );
    });

    $("debugCallStack").addEventListener("click", function (event) {
        const core = event.target.closest("[data-debug-core]");
        if (core) return sidebarHost?.selectCore(Number(core.dataset.debugCore));
        var row = event.target.closest("[data-frame]");
        if (!row) return;
        openFileTab(TAB_META[row.dataset.file] ? row.dataset.file : state.debugFile || "main.c");
        if (state.debugActive) renderEditor();
    });

    $("debugBreakpoints").addEventListener("click", function (event) {
        var dataRow = event.target.closest("[data-data-breakpoint]");
        if (dataRow) {
            var entry = dataBreakpoints.find(function (item) {
                return item.id === dataRow.dataset.dataBreakpoint;
            });
            if (entry && sidebarHost) sidebarHost.setDataBreakpointEnabled(entry.id, !entry.enabled);
            return;
        }
        var row = event.target.closest("[data-breakpoint]");
        if (!row) return;
        var item = state.breakpoints[Number(row.dataset.breakpoint)];
        item.enabled = !item.enabled;
        renderDebugSidebar();
        renderEditor();
    });

    $("debugBreakpoints").addEventListener("contextmenu", (event) => {
        const row = event.target.closest('[data-breakpoint-group="native"]');
        const entry = row && dataBreakpoints.find((item) => item.id === row.dataset.dataBreakpoint);
        if (!entry || !state.debugPaused || !sidebarHost) return;
        event.preventDefault();
        const epoch = sidebarHost.breakpointEpoch();
        showQuickPick(
            [
                { value: "condition", label: tr("mock.editBreakpoint") },
                { value: "remove", label: tr("mock.removeBreakpoint") }
            ],
            { title: entry.name },
            (choice) => {
                if (choice?.value === "remove") sidebarHost.nativeBreakpoint(entry.id, "remove", undefined, epoch);
                if (choice?.value === "condition")
                    showInputBox({ prompt: tr("sb.dataConditionPrompt"), value: entry.condition }, (condition) => {
                        if (condition !== undefined)
                            sidebarHost.nativeBreakpoint(entry.id, "condition", condition, epoch);
                    });
            }
        );
    });

    $("problemsList").addEventListener("click", function (event) {
        var row = event.target.closest(".problem-row");
        if (row) openFileTab(row.dataset.file);
    });

    $("debugStartButton").addEventListener("click", function () {
        state.debugActive ? stopDebug() : startDebug();
    });

    $("dbgContinue").addEventListener("click", function () {
        state.debugPaused ? continueDebug() : pauseDebug();
    });
    $("dbgStepOver").addEventListener("click", stepOverDebug);
    $("dbgStepInto").addEventListener("click", stepIntoDebug);
    $("dbgStepOut").addEventListener("click", stepOutDebug);
    $("dbgRestart").addEventListener("click", restartDebug);
    $("dbgStop").addEventListener("click", stopDebug);

    document.querySelectorAll(".panel-tabs button").forEach(function (button) {
        button.addEventListener("click", function () {
            showPanel(button.dataset.panel);
        });
    });
    $("panelClose").addEventListener("click", togglePanel);
    $("terminalSessions").addEventListener("click", (event) => {
        const button = event.target.closest("[data-terminal-session]");
        if (!button) return;
        terminalSession = button.dataset.terminalSession;
        renderTerminal();
    });
    $("rttClear").addEventListener("click", function () {
        if (rttHost) rttHost.clear();
    });

    $("commandCenter").addEventListener("click", openPalette);
    $("paletteInput").addEventListener("input", function () {
        paletteIndex = 0;
        renderPalette($("paletteInput").value);
    });
    $("paletteList").addEventListener("click", function (event) {
        var item = event.target.closest("[data-index]");
        if (!item) return;
        var command = paletteItems[Number(item.dataset.index)];
        closePalette();
        runCommand(command.action);
    });
    $("command-palette").addEventListener("click", function (event) {
        if (event.target === $("command-palette")) closePalette();
    });

    $("quick-input").addEventListener("click", function (event) {
        if (event.target === $("quick-input")) closeQuickInput(undefined);
    });
    $("quickInputList").addEventListener("click", function (event) {
        var item = event.target.closest("[data-index]");
        if (item) toggleQuickItem(Number(item.dataset.index));
        $("quickInputText").focus();
    });
    $("quickInputOk").addEventListener("click", acceptQuickInput);
    $("quickInputText").addEventListener("input", function () {
        if (!quick) return;
        if (quick.mode === "pick") {
            quick.index = 0;
            renderQuickList();
        } else showQuickMessage(quick.settings.validate ? quick.settings.validate($("quickInputText").value) : "");
    });
    $("quickInputText").addEventListener("keydown", function (event) {
        if (!quick) return;
        if (event.key === "Escape") closeQuickInput(undefined);
        else if (event.key === "Enter") acceptQuickInput();
        else if (quick.mode === "pick" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            var count = quick.visible.length;
            if (!count) return;
            quick.index = (quick.index + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
            renderQuickList();
        } else return;
        event.preventDefault();
        event.stopPropagation();
    });

    $("toggleSidebar").addEventListener("click", toggleSidebar);
    $("togglePanel").addEventListener("click", togglePanel);

    $("code").addEventListener("click", function (event) {
        var line = event.target.closest(".code-line");
        if (!line) return;
        var number = Number(line.dataset.line);
        $("cursorStatus").textContent = "Ln " + number + ", Col 1";
    });

    $("gutter").addEventListener("click", function (event) {
        var line = event.target.closest(".gutter-line");
        if (!line) return;
        var file = selectedCodeFile();
        var number = Number(line.dataset.line);
        var index = state.breakpoints.findIndex(function (item) {
            return item.file === file && item.line === number;
        });
        if (index < 0) state.breakpoints.push({ file: file, line: number, enabled: true });
        else if (state.breakpoints[index].enabled) state.breakpoints.splice(index, 1);
        else state.breakpoints[index].enabled = true;
        renderDebugSidebar();
        renderEditor();
    });

    document.querySelectorAll(".menubar button").forEach(function (button) {
        button.addEventListener("click", function () {
            showToast("菜单「" + button.textContent + "」为演示占位，请使用 Ctrl+Shift+P 命令面板", "info");
        });
    });

    document.querySelectorAll(".window-controls .wc").forEach(function (button) {
        button.addEventListener("click", function () {
            showToast("窗口控制为演示占位", "info");
        });
    });

    $("scmCommit").addEventListener("click", function () {
        var message = $("scmMessage").value.trim();
        showToast(message ? "已提交：" + message : "请输入提交消息", message ? "check" : "info");
    });

    $("manageButton").addEventListener("click", function () {
        if ($("theme-menu").hidden) openThemeMenu();
        else closeThemeMenu();
    });
    $("manageButton").setAttribute("aria-haspopup", "menu");
    $("manageButton").setAttribute("aria-expanded", "false");
    document.querySelectorAll("[data-theme]").forEach(function (button) {
        button.addEventListener("click", function () {
            setTheme(button.dataset.theme, true);
            closeThemeMenu();
            $("manageButton").focus();
        });
    });
    document.addEventListener("pointerdown", function (event) {
        if (!event.target.closest("#theme-menu, #manageButton")) closeThemeMenu();
        if (!event.target.closest("#layout-menu, #customizeLayout")) closeLayoutMenu();
    });
    $("theme-menu").addEventListener("keydown", function (event) {
        var buttons = Array.from(document.querySelectorAll("[data-theme]"));
        if (event.key === "Escape") {
            closeThemeMenu();
            $("manageButton").focus();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            var index = buttons.indexOf(document.activeElement);
            buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length].focus();
        } else return;
        event.preventDefault();
        event.stopPropagation();
    });

    // Icon-only controls keep descriptive accessible names rather than font glyphs.
    document.querySelectorAll("button[title]").forEach(function (button) {
        if (!button.textContent.trim() || button.classList.contains("activity-item"))
            button.setAttribute("aria-label", button.title);
    });

    var debugDrag = document.querySelector(".debug-drag");
    debugDrag.addEventListener("pointerdown", function (event) {
        if (event.button !== 0) return;
        event.preventDefault();
        var toolbar = $("debug-toolbar");
        var rect = toolbar.getBoundingClientRect();
        var startX = event.clientX;
        var startY = event.clientY;
        debugDrag.setPointerCapture(event.pointerId);
        var move = function (next) {
            var left = Math.max(0, Math.min(window.innerWidth - rect.width - 138, rect.left + next.clientX - startX));
            var top = Math.max(0, Math.min(35, rect.top + next.clientY - startY));
            toolbar.style.left = left + "px";
            toolbar.style.top = top + "px";
            toolbar.style.transform = "none";
        };
        var end = function (next) {
            debugDrag.releasePointerCapture(next.pointerId);
            debugDrag.removeEventListener("pointermove", move);
            debugDrag.removeEventListener("pointerup", end);
            debugDrag.removeEventListener("pointercancel", end);
        };
        debugDrag.addEventListener("pointermove", move);
        debugDrag.addEventListener("pointerup", end);
        debugDrag.addEventListener("pointercancel", end);
    });
    debugDrag.addEventListener("dblclick", function () {
        $("debug-toolbar").style.removeProperty("left");
        $("debug-toolbar").style.removeProperty("top");
        $("debug-toolbar").style.removeProperty("transform");
    });

    /* ------------------------------------------------------------- resizing */

    function attachColumnResizer(handle, target, cssVar, min, max) {
        handle.addEventListener("pointerdown", function (event) {
            event.preventDefault();
            var startX = event.clientX;
            var startWidth = target.getBoundingClientRect().width;
            handle.classList.add("active");
            handle.setPointerCapture(event.pointerId);
            var move = function (moveEvent) {
                var width = Math.min(max, Math.max(min, startWidth + moveEvent.clientX - startX));
                document.documentElement.style.setProperty(cssVar, width + "px");
            };
            var end = function (endEvent) {
                handle.classList.remove("active");
                handle.releasePointerCapture(endEvent.pointerId);
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", end);
                handle.removeEventListener("pointercancel", end);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
            handle.addEventListener("pointercancel", end);
        });
    }

    function attachRowResizer(handle, target, cssVar, min, max) {
        handle.addEventListener("pointerdown", function (event) {
            event.preventDefault();
            var startY = event.clientY;
            var startHeight = target.getBoundingClientRect().height;
            handle.classList.add("active");
            handle.setPointerCapture(event.pointerId);
            var move = function (moveEvent) {
                var height = Math.min(max, Math.max(min, startHeight - (moveEvent.clientY - startY)));
                document.documentElement.style.setProperty(cssVar, height + "px");
            };
            var end = function (endEvent) {
                handle.classList.remove("active");
                handle.releasePointerCapture(endEvent.pointerId);
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", end);
                handle.removeEventListener("pointercancel", end);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
            handle.addEventListener("pointercancel", end);
        });
    }

    attachColumnResizer($("sidebar-resizer"), $("sidebar"), "--sidebar-width", 180, 620);
    attachRowResizer($("panel-resizer"), $("panel"), "--panel-height", 80, 520);

    /* ------------------------------------------------------------------- init */

    function frameSource(page) {
        return page + "." + state.lang + ".html";
    }

    if (state.lang === "en") {
        $("sidebarFrame").src = frameSource("sidebar");
        $("livewatchFrame").src = frameSource("livewatch");
        document.documentElement.lang = "en";
        $("rttFrame").src = "rtt-panel.en.html";
        TAB_META.livewatch.label = "Waveform #1";
        D.useEnglish();
    }
    state.debugLine = findDebugLine();
    setTheme(window.EmberProbeMockTheme.current());
    renderTabs();
    renderEditor();
    renderExplorer();
    renderSearch();
    renderScm();
    renderDebugSidebar();
    renderProblems();
    renderPanelBody();
    renderMarkdown();
    activateTab(state.activeTab);
    updateDebugToolbar();
    syncLayoutChrome();
    if (state.lang === "en") D.translateDocument(document.body);
    mountRttHost();
    mountSidebarHost();
    mountLivewatchHost();
})();
