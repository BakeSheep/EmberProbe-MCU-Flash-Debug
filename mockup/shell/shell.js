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

    var state = {
        lang: "zh",
        activeView: "emberprobe",
        activeTab: "livewatch",
        openTabs: ["FreeRTOSConfig.h", "main.c", "livewatch", "README.md"],
        livewatchOpen: true,
        panelVisible: false,
        activePanel: "terminal",
        sidebarVisible: true,
        debugActive: false,
        debugPaused: false,
        debugLine: 0,
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
        "FreeRTOSConfig.h": { label: "FreeRTOSConfig.h", type: "file" },
        "README.md": { label: "README.md", type: "markdown" }
    };

    var sidebarHost = null;
    var livewatchHost = null;
    var simulator = window.EmberProbeSidebarData.createSimulator();

    function sendTheme(frame) {
        if (frame.contentWindow)
            frame.contentWindow.postMessage(
                { __emberprobeMockTheme: true, theme: window.EmberProbeMockTheme.current() },
                "*"
            );
    }

    function setTheme(theme, persist) {
        if (!window.EmberProbeMockTheme.apply(theme, persist)) return;
        [$("sidebarFrame"), $("livewatchFrame")].forEach(sendTheme);
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

    [$("sidebarFrame"), $("livewatchFrame")].forEach(function (frame) {
        frame.addEventListener("load", function () {
            sendTheme(frame);
        });
    });
    window.addEventListener("message", function (event) {
        if (!event.data || !event.data.__emberprobeMockTheme || !event.data.request) return;
        [$("sidebarFrame"), $("livewatchFrame")].forEach(function (frame) {
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

    function showToast(text, iconName) {
        var box = document.createElement("div");
        box.className = "toast";
        box.innerHTML =
            '<span class="toast-icon">' + icon(iconName || "check") + "</span><span>" + esc(text) + "</span>";
        $("toasts").appendChild(box);
        setTimeout(function () {
            box.style.opacity = "0";
            box.style.transition = "opacity .25s";
            setTimeout(function () {
                box.remove();
            }, 260);
        }, 4200);
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
                state.debugActive && state.debugPaused && file === "main.c" && lineNumber === state.debugLine;
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
        var crumbs = ["EmberProbeDemo"].concat(D.FILES[file].path.split("/"));
        if (file === "main.c") crumbs.push("ControlTask()");
        $("breadcrumbs").innerHTML = crumbs
            .map(function (crumb) {
                return '<span class="crumb">' + esc(crumb) + "</span>";
            })
            .join("<span>›</span>");
        updateCursorStatus();
        if (state.debugActive && state.debugPaused && file === "main.c") {
            var active = document.querySelector('.code-line[data-line="' + state.debugLine + '"]');
            if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "center" });
        }
    }

    function updateCursorStatus() {
        var text =
            state.debugActive && state.debugPaused && selectedCodeFile() === "main.c"
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
            pane.classList.toggle("active", pane.dataset.pane === paneType);
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
        if (state.openTabs.indexOf(id) < 0) state.openTabs.push(id);
        if (id === "livewatch") state.livewatchOpen = true;
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
        $("toggleSecondarySidebar").setAttribute("aria-expanded", String(!$("auxiliarybar").hidden));
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
        if (id === "livewatch") {
            state.livewatchOpen = false;
            if (livewatchHost) livewatchHost.stop();
        }
        state.openTabs.splice(index, 1);
        if (state.activeTab === id)
            state.activeTab = state.openTabs[Math.min(index, state.openTabs.length - 1)] || null;
        renderTabs();
        activateTab(state.activeTab);
    }

    function openLiveWatch() {
        if (!state.livewatchOpen) {
            state.livewatchOpen = true;
            if (state.openTabs.indexOf("livewatch") < 0) state.openTabs.splice(1, 0, "livewatch");
        }
        activateTab("livewatch");
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
                    (node.stl ? '<span class="stl-badge">STL</span>' : "") +
                    '<span class="var-type">' +
                    esc(node.type) +
                    "</span></div>";
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
        $("debugCallStack").innerHTML = D.DEBUG.callStack
            .map(function (frame, index) {
                return (
                    '<div class="tree-row stack-row' +
                    (frame.active ? " active" : "") +
                    '" data-frame="' +
                    index +
                    '"><span class="chevron"></span><span class="label">' +
                    esc(frame.name) +
                    '()</span><span class="stack-line" style="margin-left:auto">' +
                    esc(frame.detail) +
                    "</span></div>"
                );
            })
            .join("");
        $("debugBreakpoints").innerHTML = state.breakpoints
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
        $("terminalBody").innerHTML = linesHtml(D.TERMINAL_LINES);
        $("outputBody").innerHTML = linesHtml(D.OUTPUT_LINES);
        $("debugConsoleBody").innerHTML = linesHtml(D.DEBUG_CONSOLE_LINES);
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
    }

    function togglePanel() {
        state.panelVisible = !state.panelVisible;
        $("panel").classList.toggle("collapsed", !state.panelVisible);
    }

    function toggleSidebar() {
        state.sidebarVisible = !state.sidebarVisible;
        $("sidebar").classList.toggle("hidden", !state.sidebarVisible);
    }

    /* --------------------------------------------------------------- debug */

    function setEmberProbeStatus(text, cls) {
        var item = $("emberprobeStatus");
        item.textContent = "EmberProbe: " + text;
        item.className = "status-item emberprobe" + (cls ? " " + cls : "");
    }

    function updateDebugToolbar() {
        $("debug-toolbar").classList.toggle("hidden", !state.debugActive || !state.activeTab);
        $("debugToolbarLabel").textContent = state.debugPaused ? "ControlTask · main.c:" + state.debugLine : "运行中…";
        $("dbgContinue").innerHTML = icon(state.debugPaused ? "debug-continue" : "debug-pause");
        $("dbgContinue").title = state.debugPaused ? "继续 (F5)" : "暂停 (F6)";
        $("dbgContinue").setAttribute("aria-label", $("dbgContinue").title);
        document.body.classList.toggle("debugging", state.debugActive);
        ["dbgStepOver", "dbgStepInto", "dbgStepOut"].forEach(function (id) {
            $(id).disabled = !state.debugPaused;
        });
    }

    function startDebug() {
        if (sidebarHost) sidebarHost.startDebug();
    }

    function completeDebugStart() {
        state.debugActive = true;
        state.debugPaused = true;
        state.debugLine = findDebugLine();
        $("debug-toolbar").classList.remove("hidden");
        updateDebugToolbar();
        renderEditor();
        setEmberProbeStatus("已暂停 · main.c:" + state.debugLine, "debugging");
        switchView("debug");
        openFileTab("main.c");
        if (sidebarHost) sidebarHost.setTargetState("halted", { notify: false, line: state.debugLine });
        showToast("调试会话已启动：EmberProbe (J-Link)");
    }

    function stopDebug() {
        if (sidebarHost && sidebarHost.cancelDebugStart() && !state.debugActive) {
            setEmberProbeStatus("已连接", "");
            return;
        }
        state.debugActive = false;
        state.debugPaused = false;
        $("debug-toolbar").classList.add("hidden");
        updateDebugToolbar();
        renderEditor();
        setEmberProbeStatus("已连接 · 目标运行中", "running");
        if (sidebarHost) sidebarHost.setTargetState("running", { notify: false });
        showToast("调试会话已停止，目标继续运行");
    }

    function pauseDebug() {
        if (sidebarHost && sidebarHost.isDebugStarting()) return;
        state.debugActive = true;
        state.debugPaused = true;
        state.debugLine = findDebugLine();
        $("debug-toolbar").classList.remove("hidden");
        updateDebugToolbar();
        renderEditor();
        setEmberProbeStatus("已暂停 · main.c:" + state.debugLine, "debugging");
        if (sidebarHost) sidebarHost.setTargetState("halted", { notify: false, line: state.debugLine });
    }

    function continueDebug() {
        if (sidebarHost && sidebarHost.isDebugStarting()) return;
        if (!state.debugActive) return startDebug();
        state.debugPaused = false;
        updateDebugToolbar();
        renderEditor();
        setEmberProbeStatus("运行中", "running");
        if (sidebarHost) sidebarHost.setTargetState("running", { notify: false });
    }

    function stepDebug() {
        if (sidebarHost && sidebarHost.isDebugStarting()) return;
        if (!state.debugActive) return startDebug();
        if (!state.debugPaused) return;
        var lines = codeLines("main.c");
        var next = state.debugLine;
        for (var i = state.debugLine; i < lines.length; i++) {
            if (lines[i].trim() && !/^(?:[{}]|\/\/|\/\*|\*)/.test(lines[i].trim())) {
                next = i + 1;
                break;
            }
        }
        state.debugPaused = true;
        state.debugLine = next;
        openFileTab("main.c");
        updateDebugToolbar();
        renderEditor();
        setEmberProbeStatus("已暂停 · main.c:" + state.debugLine, "debugging");
        if (sidebarHost) sidebarHost.setTargetState("halted", { notify: false, line: state.debugLine });
        showToast("单步跳过 → main.c:" + state.debugLine, "debug-step-over");
    }

    function simulateDownload() {
        showPanel("terminal");
        var body = $("terminalBody");
        var steps = [
            { cls: "info", text: "Info : accepting 'gdb' connection on tcp/3333" },
            { cls: "info", text: "Info : flash write 0x08000000 917504 bytes" },
            { cls: "ok", text: "Info : verified OK (CRC32 0x8F3C21A7)" },
            { cls: "ok", text: "Info : EmberProbe download complete in 4.8s" }
        ];
        steps.forEach(function (step, index) {
            setTimeout(
                function () {
                    body.innerHTML += '\n<span class="' + step.cls + '">' + esc(step.text) + "</span>";
                    body.parentElement.scrollTop = body.parentElement.scrollHeight;
                    if (index === steps.length - 1) showToast("烧录完成：EmberProbeDemo.elf（917504 字节）");
                },
                500 + index * 550
            );
        });
    }

    /* ------------------------------------------------------------ frame hosts */

    function notify(event) {
        if (!event || !event.action) return;
        switch (event.action) {
            case "toast":
                showToast(event.text);
                break;
            case "debugStart":
                completeDebugStart();
                break;
            case "debugPending":
                $("debugStartButton").disabled = event.busy;
                $("debugStartButton").setAttribute("aria-busy", String(event.busy));
                if (event.busy) setEmberProbeStatus("正在执行…", "");
                break;
            case "openLiveWatch":
                openLiveWatch();
                break;
            case "targetState":
                if (event.state === "running") {
                    state.debugPaused = false;
                    updateDebugToolbar();
                    renderEditor();
                    setEmberProbeStatus("运行中", "running");
                } else {
                    if (!state.debugPaused) state.debugLine = findDebugLine();
                    state.debugActive = true;
                    state.debugPaused = true;
                    $("debug-toolbar").classList.remove("hidden");
                    updateDebugToolbar();
                    renderEditor();
                    setEmberProbeStatus("已暂停 · main.c:" + state.debugLine, "debugging");
                }
                break;
            case "setLang":
                swapLanguage(event.page, event.lang);
                break;
            default:
                break;
        }
    }

    function swapLanguage(page, lang) {
        // The real renderer has already changed its language in place. Keep
        // the frame and host alive so sampling, history and user edits survive.
        state.lang = lang === "en" ? "en" : "zh";
    }

    function mountSidebarHost() {
        if (sidebarHost) sidebarHost.destroy();
        sidebarHost = window.EmberProbeSidebarHost.create($("sidebarFrame"), {
            notify: notify,
            simulator: simulator
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

    function mountLivewatchHost() {
        if (livewatchHost) livewatchHost.destroy();
        livewatchHost = window.EmberProbeLiveWatchHost.create($("livewatchFrame"), {
            notify: notify,
            simulator: simulator,
            getSidebarWatch: function () {
                return sidebarHost ? sidebarHost.getWatchList() : [];
            }
        });
        setTimeout(function () {
            if (livewatchHost && !livewatchHost.isInitialized()) livewatchHost.sendReady();
        }, 600);
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
                simulateDownload();
                break;
            case "livewatch":
                openLiveWatch();
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
                stepDebug();
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
        if (event.key === "F5" && !event.shiftKey) {
            event.preventDefault();
            state.debugPaused ? continueDebug() : startDebug();
        } else if (event.key === "F5" && event.shiftKey) {
            event.preventDefault();
            stopDebug();
        } else if (event.key === "F10") {
            event.preventDefault();
            stepDebug();
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
        if (match) openFileTab(match.dataset.file === "main.c" ? "main.c" : "main.c");
    });

    $("debugVariables").addEventListener("click", function (event) {
        var row = event.target.closest("[data-var-path]");
        if (!row) return;
        var path = row.dataset.varPath;
        state.expandedNodes[path] = !state.expandedNodes[path];
        renderDebugSidebar();
    });

    $("debugCallStack").addEventListener("click", function (event) {
        var row = event.target.closest("[data-frame]");
        if (!row) return;
        openFileTab("main.c");
        if (state.debugActive) {
            state.debugPaused = true;
            renderEditor();
        }
    });

    $("debugBreakpoints").addEventListener("click", function (event) {
        var row = event.target.closest("[data-breakpoint]");
        if (!row) return;
        var item = state.breakpoints[Number(row.dataset.breakpoint)];
        item.enabled = !item.enabled;
        renderDebugSidebar();
        renderEditor();
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
    $("dbgStepOver").addEventListener("click", stepDebug);
    $("dbgStepInto").addEventListener("click", stepDebug);
    $("dbgStepOut").addEventListener("click", function () {
        showToast("单步跳出 → ControlTask()", "debug-step-out");
    });
    $("dbgRestart").addEventListener("click", function () {
        startDebug();
    });
    $("dbgStop").addEventListener("click", stopDebug);

    document.querySelectorAll(".panel-tabs button").forEach(function (button) {
        button.addEventListener("click", function () {
            showPanel(button.dataset.panel);
        });
    });
    $("panelClose").addEventListener("click", togglePanel);

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
            handle.setPointerCapture(event.pointerId);
            var move = function (moveEvent) {
                var width = Math.min(max, Math.max(min, startWidth + moveEvent.clientX - startX));
                document.documentElement.style.setProperty(cssVar, width + "px");
            };
            var end = function (endEvent) {
                handle.releasePointerCapture(endEvent.pointerId);
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", end);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
        });
    }

    function attachRowResizer(handle, target, cssVar, min, max) {
        handle.addEventListener("pointerdown", function (event) {
            event.preventDefault();
            var startY = event.clientY;
            var startHeight = target.getBoundingClientRect().height;
            handle.setPointerCapture(event.pointerId);
            var move = function (moveEvent) {
                var height = Math.min(max, Math.max(min, startHeight - (moveEvent.clientY - startY)));
                document.documentElement.style.setProperty(cssVar, height + "px");
            };
            var end = function (endEvent) {
                handle.releasePointerCapture(endEvent.pointerId);
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", end);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
        });
    }

    attachColumnResizer($("sidebar-resizer"), $("sidebar"), "--sidebar-width", 180, 620);
    attachRowResizer($("panel-resizer"), $("panel"), "--panel-height", 80, 520);

    /* ------------------------------------------------------------------- init */

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
    setEmberProbeStatus("已连接", "");
    mountSidebarHost();
    mountLivewatchHost();
})();
