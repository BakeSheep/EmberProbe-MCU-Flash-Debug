"use strict";
const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { FakeClock } = require("./helpers/fake-clock");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");
const sidebar = render(
    getModernWebviewContent({ elf: "<script>evil()</script>", debugger: "stlink.cfg", mcu: "stm32f4x.cfg" }, "en")
);
try {
    sidebar.assertHealthy();
    for (const [input, expected] of [
        [[0, 100, 30, 130], { min: 100, max: 200 }],
        [[0, 100, 70, -30], { min: -100, max: 0 }],
        [[0, 100, 30, 60], { min: 0, max: 100 }]
    ])
        assert.deepStrictEqual({ ...sidebar.window.shiftSliderBounds(...input) }, expected);
    assert.ok(sidebar.messages.some((m) => m.type === "initCheck"));
    for (const id of [
        "liveValues",
        "liveToggle",
        "noticeGlobal",
        "noticeFlash",
        "noticeConfig",
        "noticeChip",
        "noticeLive",
        "noticeWrite",
        "skillStatus",
        "availableVars",
        "chipRead",
        "chipBody",
        "writeValues",
        "varResizeHandle",
        "peripheralResizeHandle",
        "githubLink",
        "svdStatus"
    ])
        assert.ok(sidebar.document.getElementById(id), id);
    assert.strictEqual(sidebar.window.evil, undefined);
    sidebar.send({
        type: "availableVariables",
        symbols: [{ name: "counter", watchType: "u32", address: 536870912, size: 4 }]
    });
    assert.equal(sidebar.document.querySelectorAll(".available-head > span").length, 2);
    assert.equal(sidebar.document.querySelectorAll(".available-address").length, 0);
    assert.equal(sidebar.document.querySelector(".available-row").children.length, 2);
    const click = (id) => sidebar.document.getElementById(id).click();
    const diagnostic = {
        code: "PROBE_OPEN_FAILED",
        message: "<script>evil()</script>",
        details: { openocdTail: ["Failed to open device"] }
    };
    // A failed command's diagnostic lives in its notice: folded, text only, copied whole.
    sidebar.send({
        type: "notice",
        area: "flash",
        id: "mcu-vscode.download",
        notice: { level: "error", titleKey: "notice.downloadFailed", error: { message: "Failed", diagnostic } }
    });
    const failure = sidebar.document.querySelector('#noticeFlash [data-notice-id="mcu-vscode.download"]');
    assert(failure.classList.contains("notice--error"));
    assert.strictEqual(failure.getAttribute("role"), "alert");
    failure.querySelector(".notice-toggle").click();
    const panel = failure.querySelector(".notice-diagnostic");
    assert.strictEqual(panel.hidden, false);
    assert(panel.textContent.includes("PROBE_OPEN_FAILED"));
    assert.strictEqual(panel.querySelector("script"), null);
    failure.querySelector(".notice-copy").click();
    assert.deepStrictEqual(JSON.parse(sidebar.messages.at(-1).text), diagnostic);
    failure.querySelector(".notice-close").click();
    assert.deepStrictEqual(sidebar.messages.at(-1), {
        type: "noticeDismiss",
        area: "flash",
        id: "mcu-vscode.download"
    });
    assert.strictEqual(sidebar.document.getElementById("noticeFlash").hidden, true);
    sidebar.send({ type: "openocdStatus", state: "incompatible", message: "unsupported" });
    const openocd = sidebar.document.querySelector('#noticeGlobal [data-notice-id="openocd"]');
    assert(openocd.classList.contains("notice--error"));
    assert.strictEqual(openocd.querySelector(".notice-close"), null, "OpenOCD state cannot be dismissed");
    openocd.querySelector(".notice-action.primary").click();
    assert.deepStrictEqual(sidebar.messages.at(-1), { type: "openocdAction", action: "select" });
    click("chipRead");
    assert.strictEqual(sidebar.messages.at(-1).type, "readChipInfo");
    sidebar.send({ type: "chipInfo", info: { core: "Cortex-M4", uid: "1234", targetState: "halted" } });
    assert.ok(sidebar.document.getElementById("chipBody").textContent.includes("Cortex-M4"));
    sidebar.document.querySelector(".chip-copy").click();
    assert.deepStrictEqual(sidebar.messages.at(-1), { type: "copyText", text: "1234" });
    sidebar.send({ type: "openocdStatus", state: "ready" });
    assert.strictEqual(sidebar.document.querySelector('[data-notice-id="openocd"]'), null);
    const card = sidebar.document.getElementById("liveValues").closest(".live-box");
    for (const status of [
        { source: "dap", snapshotReady: false, mode: "debug-running-waiting", canRead: false },
        { source: "dap", snapshotReady: true, mode: "debug-paused-ready", canRead: true },
        { source: "openocd", mode: "debug-running-sampling", canRead: true },
        { source: "openocd", mode: "stopped", canRead: false }
    ]) {
        sidebar.send({ type: "liveStatus", intentEnabled: true, canWrite: false, ...status });
        assert.strictEqual(card.classList.contains("debug-stale"), !status.canRead);
    }
    sidebar.send({ type: "sidebarWatchList", items: [{ name: "tick", type: "u32", address: 536870912 }] });
    sidebar.send({ type: "liveSample", samples: [{ name: "tick", value: 7, valueText: "7", t: 1000 }] });
    assert.ok(sidebar.document.getElementById("liveValues").textContent.includes("7"));
    sidebar.send({
        type: "sidebarWatchList",
        items: [{ name: "tick", type: "u32", address: 536870916 }],
        resetValues: true
    });
    assert.ok(!sidebar.document.getElementById("liveValues").textContent.includes("7"));
    assert.strictEqual(sidebar.document.getElementById("feedbackPrompt"), null);
    assert.strictEqual(
        sidebar.document.querySelector(".primary-actions [data-command='mcu-vscode.debug']").textContent,
        "Debug With Reset"
    );
    assert.strictEqual(sidebar.document.getElementById("githubLink").textContent, "");
    click("githubLink");
    assert.deepStrictEqual(sidebar.messages.at(-1), { type: "openGitHub" });
    const peripheralTree = sidebar.document.getElementById("peripheralTree");
    const peripheralHandle = sidebar.document.getElementById("peripheralResizeHandle");
    peripheralTree.getBoundingClientRect = () => ({ height: Number.parseInt(peripheralTree.style.height, 10) || 120 });
    peripheralHandle.setPointerCapture = () => {};
    peripheralHandle.releasePointerCapture = () => {};
    peripheralHandle.dispatchEvent(new sidebar.window.MouseEvent("pointerdown", { clientY: 100 }));
    peripheralHandle.dispatchEvent(new sidebar.window.MouseEvent("pointermove", { clientY: 160 }));
    peripheralHandle.dispatchEvent(new sidebar.window.MouseEvent("pointerup", { clientY: 160 }));
    assert.strictEqual(peripheralTree.style.height, "180px");
    click("langToggle");
    assert.strictEqual(sidebar.messages.at(-1).type, "setLang");
    assert.strictEqual(sidebar.document.getElementById("githubLink").getAttribute("aria-label"), "打开 GitHub 仓库");
    sidebar.assertHealthy();
} finally {
    sidebar.close();
}
for (const lang of ["en", "zh"]) {
    const chipSidebar = render(getModernWebviewContent({}, lang));
    try {
        const body = chipSidebar.document.getElementById("chipBody");
        const label = chipSidebar.document.getElementById("chipLabel");
        for (const hasData of [false, true]) {
            if (hasData) chipSidebar.send({ type: "chipInfo", info: { core: "Cortex-M7", targetState: "running" } });
            for (const error of [
                { key: "chip.busyLive" },
                { message: "Arbitrary failure <script>bad()</script>" },
                {}
            ]) {
                const previousDetails = hasData ? body.textContent : "";
                chipSidebar.send({ type: "chipInfoStatus", state: "error", ...error });
                // The header shows the failed state; the reason is the chip notice, once.
                assert(label.textContent, "every chip error remains visible in the header");
                assert.strictEqual(label.title, label.textContent);
                const notices = chipSidebar.document.querySelectorAll("#noticeChip .notice--error");
                assert.strictEqual(notices.length, error.key || error.message ? 1 : 0);
                assert.strictEqual(chipSidebar.document.querySelector("#noticeChip script"), null);
                assert.strictEqual(
                    body.textContent,
                    previousDetails,
                    "errors never add a second message below the header"
                );
                assert(chipSidebar.document.getElementById("chipState").classList.contains("err"));
                assert.strictEqual(chipSidebar.document.getElementById("chipRead").disabled, false);
                if (error.message)
                    assert.strictEqual(notices[0].querySelector(".notice-text").textContent, error.message);
                chipSidebar.send({ type: "setLang", lang: lang === "en" ? "zh" : "en" });
                assert.strictEqual(
                    body.querySelector(".chip-err"),
                    null,
                    "language changes cannot restore the duplicate"
                );
                if (hasData) assert(body.textContent.includes("Cortex-M7"));
                else assert.strictEqual(body.textContent, "");
                chipSidebar.send({ type: "chipInfoStatus", state: "reading" });
                assert.strictEqual(chipSidebar.document.getElementById("chipRead").disabled, true);
            }
        }
        chipSidebar.send({ type: "chipInfoStatus", state: "ready" });
        assert.strictEqual(chipSidebar.document.getElementById("chipState").classList.contains("err"), false);
        chipSidebar.assertHealthy();
    } finally {
        chipSidebar.close();
    }
}
const jlinkSidebar = render(getModernWebviewContent({ debugger: "jlink.cfg" }, "zh"));
try {
    const doc = jlinkSidebar.document;
    const driver = doc.getElementById("jlinkDriverChoice");
    const probes = doc.getElementById("connectedProbeList");
    const section = doc.getElementById("probeConfig");
    const auto = doc.getElementById("connectedProbeAuto");
    const refresh = doc.getElementById("connectedProbeRefresh");
    assert(driver && probes && section && auto && refresh);
    assert.strictEqual(auto.hidden, true, "the automatic-mode entry is hidden before inventory arrives");
    const cards = () => [...probes.children];
    const cardTexts = () =>
        cards().map((card) =>
            [...card.querySelectorAll(".row-copy > *, .tag")].map((el) => el.textContent).join(" | ")
        );
    const pressed = () => cards().filter((card) => card.classList.contains("selected"));
    const cardFor = (device) =>
        cards().find((card) => card.querySelector("button.probe-card-main")?.dataset.deviceId === device.id);
    const pick = (device) => cardFor(device).querySelector("button.probe-card-main");
    assert.strictEqual(driver.hidden, true);
    assert.deepStrictEqual(cardTexts(), ["正在检测…"], "the list shows a card until the first scan arrives");
    assert.strictEqual(
        doc.querySelector(".debugger-config-row #jlinkDriverChoice"),
        null,
        "the driver control is no longer part of Select debugger"
    );
    assert.strictEqual(section.tagName, "DETAILS");
    assert(section.classList.contains("config-more"), "the probe list folds like Other configuration");
    assert.strictEqual(section.nextElementSibling?.id, "otherConfig", "the probe list sits above Other configuration");
    assert.strictEqual(section.open, false);
    const summary = section.querySelector("summary");
    assert.deepStrictEqual(
        [...summary.querySelectorAll(".probe-more-button")],
        [auto, refresh],
        "Auto sits left of rescan in the summary"
    );
    assert.strictEqual(summary.textContent, "已连接调试器自动", "the summary carries no other text");
    // An operation that cannot choose a probe opens the list, and the configuration section holding it.
    const configSection = doc.getElementById("mcuConfigSection");
    configSection.open = false;
    jlinkSidebar.send({ type: "revealConnectedProbes" });
    assert.deepStrictEqual([configSection.open, section.open], [true, true]);
    section.open = false;
    assert.strictEqual(doc.getElementById("probeActiveConnection"), null);
    assert.strictEqual(doc.querySelector('[data-command="mcu-vscode.configureProbeConnection"]'), null);
    assert.strictEqual(doc.querySelector(".cubemx-status")?.textContent.includes("成功记录"), false);
    const segger = {
        id: "USB\\VID_1366&PID_0101\\000000001234",
        family: "jlink",
        name: "J-Link",
        serial: "1234",
        trustedSerial: "1234",
        defaultConfig: "jlink.cfg",
        matchesDebugger: true,
        selected: true,
        selectable: true,
        driver: { kind: "repair", instanceId: "USB\\VID_1366&PID_0101\\000000001234" }
    };
    const winusb = {
        ...segger,
        id: "USB\\VID_1366&PID_0101\\000000005678",
        serial: "5678",
        trustedSerial: "5678",
        selected: false,
        driver: { kind: "ready", instanceId: "USB\\VID_1366&PID_0101\\000000005678" }
    };
    const dap = {
        id: "USB\\VID_C251&PID_F001\\1&A",
        family: "cmsis-dap",
        name: "CMSIS-DAP",
        serial: "",
        trustedSerial: "",
        defaultConfig: "cmsis-dap.cfg",
        matchesDebugger: false,
        selected: false,
        selectable: false,
        reasonKey: "probe.noTrustedSerial"
    };
    const list = (fields) => ({
        type: "connectedProbes",
        debugger: "jlink.cfg",
        override: false,
        family: "jlink",
        state: "selected",
        source: "remembered",
        probeSerial: "1234",
        deviceId: segger.id,
        error: null,
        devices: [segger, winusb, dap],
        ...fields
    });
    jlinkSidebar.send(list({}));
    assert.deepStrictEqual(cardTexts(), [
        "J-Link | 1234",
        "J-Link | 5678",
        "CMSIS-DAP | 无序列号 · 同类探针有多台，但这台没有可靠的 USB 序列号，OpenOCD 无法区分"
    ]);
    assert.deepStrictEqual(pressed(), [cardFor(segger)]);
    const checks = () => cards().filter((card) => card.querySelector(":scope > svg.probe-current"));
    assert.deepStrictEqual(checks(), [cardFor(segger)], "a check, not a text tag, marks the device in use");
    assert.strictEqual(cardFor(segger).querySelector(".tag"), null);
    assert(cardFor(segger).title.includes("使用中 · 已选择的设备"));
    assert.strictEqual(cardFor(segger).contains(driver), true, "the selected J-Link's card holds its driver control");
    assert.strictEqual(pick(winusb).disabled, false);
    assert.strictEqual(pick(dap).disabled, true, "an indistinguishable probe is listed but not selectable");
    assert(cardFor(dap).title.includes("选择后将切换为 cmsis-dap.cfg"), "only the tooltip names the script");
    // Choosing a probe of another family changes Select debugger in place instead of reloading the page.
    const debuggerValue = doc.querySelector(".debugger-config-row .row-copy > small");
    assert.strictEqual(debuggerValue.textContent, "jlink.cfg");
    jlinkSidebar.send({ type: "debuggerConfig", debugger: "cmsis-dap.cfg" });
    assert.deepStrictEqual([debuggerValue.textContent, debuggerValue.title], ["cmsis-dap.cfg", "cmsis-dap.cfg"]);
    assert.strictEqual(doc.getElementById("connectedProbeList"), probes, "the page is not rebuilt");
    jlinkSidebar.send({ type: "debuggerConfig", debugger: "" });
    assert.strictEqual(debuggerValue.getAttribute("data-i18n"), "common.notSelected");
    jlinkSidebar.send(list({}));
    assert.strictEqual(debuggerValue.textContent, "jlink.cfg", "the probe list carries the interface script too");
    assert.strictEqual(debuggerValue.hasAttribute("data-i18n"), false);
    assert.strictEqual(auto.hidden, true, "inventory updates must not reveal the automatic-mode entry");
    assert.strictEqual(auto.getAttribute("aria-pressed"), "false", "a saved device is not automatic");
    assert.strictEqual(auto.title, "恢复自动连接并忘记原设备");
    assert.strictEqual(auto.textContent, "自动");
    assert.strictEqual(driver.hidden, false);
    assert.strictEqual(driver.value, "segger");
    const driverOf = (device) => cardFor(device).querySelector("select.jlink-driver-choice");
    assert(driverOf(winusb) && driverOf(winusb) !== driver, "every switchable J-Link carries its own driver control");
    assert.strictEqual(driverOf(winusb).id, "", "only the page's own control has an id");
    assert.deepStrictEqual([driverOf(winusb).hidden, driverOf(winusb).value], [false, "winusb"]);
    assert.strictEqual(driverOf(dap), null, "a probe without a switchable driver has no control");

    pick(winusb).click();
    assert.deepStrictEqual(jlinkSidebar.messages.at(-1), { type: "selectConnectedProbe", deviceId: winusb.id });
    assert.deepStrictEqual(
        pressed(),
        [cardFor(segger)],
        "show the confirmed probe until the extension posts the change"
    );
    const posted = jlinkSidebar.messages.length;
    pick(segger).click();
    pick(dap).click();
    assert.strictEqual(jlinkSidebar.messages.length, posted, "the selected and unselectable cards post nothing");
    auto.click();
    assert.deepStrictEqual(jlinkSidebar.messages.at(-1), { type: "selectConnectedProbe", deviceId: "" });
    assert.strictEqual(section.open, false, "Auto in the summary does not unfold the list");

    driver.value = "winusb";
    driver.dispatchEvent(new jlinkSidebar.window.Event("change"));
    assert.deepStrictEqual(jlinkSidebar.messages.at(-1), {
        type: "selectProbeDriver",
        driver: "winusb",
        deviceId: segger.id
    });
    assert.strictEqual(driver.disabled, true);
    assert.strictEqual(pick(winusb).disabled, true, "the probe cannot change while its driver is switching");
    assert.strictEqual(auto.disabled, true);
    assert.strictEqual(doc.getElementById("jlinkDriverBusy").hidden, false);
    assert.strictEqual(doc.getElementById("chipRead").disabled, true);
    assert.strictEqual(driver.value, "segger", "show the confirmed driver until switching succeeds");
    jlinkSidebar.send(list({ devices: [{ ...segger, driver: { ...segger.driver, kind: "ready" } }, winusb, dap] }));
    assert.strictEqual(driver.disabled, true);
    assert.strictEqual(pick(winusb).disabled, true, "a rescan while switching keeps the list locked");
    assert.strictEqual(doc.getElementById("jlinkDriverBusy").hidden, false, "the rescan keeps the busy indicator");
    assert.strictEqual(driver.value, "winusb");
    jlinkSidebar.send({ type: "probeDriverSwitch", busy: false });
    assert.strictEqual(driver.disabled, false);
    assert.strictEqual(pick(winusb).disabled, false);
    assert.strictEqual(doc.getElementById("jlinkDriverBusy").hidden, true);
    assert.strictEqual(doc.getElementById("chipRead").disabled, false);

    // Another J-Link's driver is switched from its own card, without picking (and so keeping) that J-Link.
    const other = driverOf(winusb);
    other.value = "segger";
    other.dispatchEvent(new jlinkSidebar.window.Event("change"));
    assert.deepStrictEqual(jlinkSidebar.messages.at(-1), {
        type: "selectProbeDriver",
        driver: "segger",
        deviceId: winusb.id
    });
    assert.deepStrictEqual(pressed(), [cardFor(segger)], "switching a driver does not change the selection");
    assert.strictEqual(other.value, "winusb", "show the confirmed driver until switching succeeds");
    assert.deepStrictEqual([other.disabled, driver.disabled], [true, true], "every driver control waits");
    const busy = doc.getElementById("jlinkDriverBusy");
    assert.strictEqual(cardFor(winusb).contains(busy), true, "the busy indicator follows the switching J-Link");
    jlinkSidebar.send(list({ devices: [{ ...segger, driver: { ...segger.driver, kind: "ready" } }, winusb, dap] }));
    assert.strictEqual(cardFor(winusb).contains(busy), true, "a rescan while switching keeps it there");
    jlinkSidebar.send({ type: "probeDriverSwitch", busy: false });
    assert.strictEqual(driverOf(winusb).disabled, false);
    jlinkSidebar.send(list({}));

    // Automatic mode that could not choose among several J-Links still offers each one's driver.
    jlinkSidebar.send(
        list({
            state: "ambiguous",
            source: "",
            deviceId: "",
            probeSerial: "",
            devices: [
                { ...segger, selected: false },
                { ...winusb, selected: false }
            ]
        })
    );
    assert.deepStrictEqual(pressed(), []);
    assert.deepStrictEqual(
        [driverOf(segger)?.value, driverOf(winusb)?.value, driver.hidden],
        ["segger", "winusb", true],
        "unselected J-Links switch their drivers from their own cards"
    );
    assert.strictEqual(doc.getElementById("probeDriverHome").contains(driver), true);
    jlinkSidebar.send(list({}));

    // The driver control belongs to the selected device: another J-Link's state is shown once it is chosen.
    jlinkSidebar.send(
        list({
            source: "unique-device",
            deviceId: winusb.id,
            devices: [
                { ...segger, selected: false },
                { ...winusb, selected: true }
            ]
        })
    );
    assert.deepStrictEqual(pressed(), [cardFor(winusb)]);
    assert.strictEqual(cardFor(winusb).contains(driver), true);
    assert.strictEqual(auto.getAttribute("aria-pressed"), "true", "an automatic choice keeps Auto pressed");
    assert.strictEqual(auto.disabled, false);
    assert(auto.title.includes("再次点击"));
    auto.click();
    assert.deepStrictEqual(
        jlinkSidebar.messages.at(-1),
        { type: "selectConnectedProbe", deviceId: winusb.id },
        "releasing Auto keeps the automatically chosen device"
    );
    assert.strictEqual(auto.getAttribute("aria-pressed"), "true", "Auto stays pressed until the extension confirms");

    // Automatic mode shows the chip it checks before each operation and the chip found behind each probe.
    const f4 = "STM32F4x · Cortex-M4 · UID …53534C32";
    const h7 = "STM32H7x · Cortex-M7 · UID …32363235";
    const byChip = {
        source: "target-chip",
        deviceId: winusb.id,
        autoTarget: f4,
        devices: [
            { ...segger, selected: false, targetLabel: h7, targetCore: "Cortex-M7" },
            { ...winusb, selected: true, targetLabel: f4, targetCore: "Cortex-M4" }
        ]
    };
    jlinkSidebar.send(list(byChip));
    assert.deepStrictEqual(cardTexts(), [
        "J-Link | 1234 · Cortex-M7",
        "J-Link | 5678 · Cortex-M4",
        `校验目标芯片 | ${f4}`
    ]);
    assert(cardFor(winusb).title.includes("按目标芯片选择"));
    assert(cardFor(segger).title.includes(`目标芯片：${h7}`), "the full chip is in the tooltip");
    assert.deepStrictEqual(checks(), [cardFor(winusb)]);
    assert.strictEqual(auto.getAttribute("aria-pressed"), "true");
    // A check that found another chip stopped the operation; the user can accept the chip found.
    jlinkSidebar.send(list({ ...byChip, targetMismatch: { expected: f4, actual: h7 } }));
    const changed = doc.querySelector("#connectedProbeList .probe-card.warn");
    assert.strictEqual(changed.querySelector("small").textContent, `记录 ${f4} → 当前 ${h7}`);
    assert(!cardTexts().some((text) => text.startsWith("校验目标芯片")), "the changed chip replaces the checked one");
    const accept = changed.querySelector("button.probe-target-accept");
    assert.strictEqual(accept.textContent, "改用当前芯片");
    accept.click();
    assert.deepStrictEqual(jlinkSidebar.messages.at(-1), { type: "acceptTargetChip" });
    jlinkSidebar.send({ type: "probeDriverSwitch", busy: true });
    assert.strictEqual(accept.disabled, true, "no chip is accepted while the probe is busy");
    jlinkSidebar.send({ type: "probeDriverSwitch", busy: false });
    jlinkSidebar.send(list({ ...byChip, source: "remembered", targetMismatch: { expected: f4, actual: h7 } }));
    assert.strictEqual(doc.querySelector("button.probe-target-accept"), null, "a kept probe is not checked");
    jlinkSidebar.send(
        list({
            source: "unique-device",
            deviceId: winusb.id,
            devices: [
                { ...segger, selected: false },
                { ...winusb, selected: true }
            ]
        })
    );
    driver.value = "segger";
    driver.dispatchEvent(new jlinkSidebar.window.Event("change"));
    assert.deepStrictEqual(jlinkSidebar.messages.at(-1), {
        type: "selectProbeDriver",
        driver: "segger",
        deviceId: winusb.id
    });
    jlinkSidebar.send({ type: "probeDriverSwitch", busy: false });

    // A J-Link the helper cannot switch shows why instead of a driver control.
    jlinkSidebar.send(
        list({
            devices: [{ ...segger, driver: { kind: "unsupported", reasonKey: "probe.driverReasonProduct" } }]
        })
    );
    const manual = doc.getElementById("jlinkDriverState");
    assert.strictEqual(cards().length, 1, "the connected saved probe is listed once");
    assert.strictEqual(cardFor(segger).contains(manual), true);
    assert.strictEqual(driver.hidden, true);
    assert.strictEqual(manual.hidden, false);
    assert(manual.title.includes("型号列表"));
    // An unselected J-Link shows the same badge on its own card.
    jlinkSidebar.send(
        list({
            devices: [segger, { ...winusb, driver: { kind: "unsupported", reasonKey: "probe.driverReasonProduct" } }]
        })
    );
    const badge = cardFor(winusb).querySelector(".jlink-driver-state");
    assert(badge && badge !== manual, "every J-Link shows its driver state");
    assert.deepStrictEqual([badge.id, badge.hidden, badge.textContent], ["", false, manual.textContent]);
    assert(badge.title.includes("型号列表"));
    assert.strictEqual(manual.hidden, true, "the selected J-Link can switch, so the page's own badge is hidden");
    assert.strictEqual(driverOf(winusb), null);
    // Refresh reading each probe's chip shows it on the button and keeps it from starting another read.
    jlinkSidebar.send({ type: "probeOperationStatus", operations: { targetScan: true } });
    assert.deepStrictEqual([refresh.disabled, refresh.classList.contains("scanning")], [true, true]);
    jlinkSidebar.send({ type: "probeOperationStatus", operations: { targetScan: false } });
    assert.deepStrictEqual([refresh.disabled, refresh.classList.contains("scanning")], [false, false]);

    // A missing saved probe stays selected as a card, and an override or custom script locks the list.
    jlinkSidebar.send(
        list({
            state: "absent",
            deviceId: "",
            probeSerial: "9999",
            error: { code: "PROBE_SELECTED_NOT_FOUND", i18nKey: "probe.rememberedNotFound", i18nParams: {} },
            devices: [{ ...segger, selected: false }]
        })
    );
    assert.deepStrictEqual(cardTexts(), ["J-Link | 9999 | 未连接", "J-Link | 1234"]);
    assert.strictEqual(driverOf(segger).value, "segger", "a connected J-Link keeps its driver control");
    assert.strictEqual(pressed()[0], cards()[0]);
    assert(cards()[0].title.includes("未连接"), "the reason the saved probe is not used is on its card");
    assert.strictEqual(probes.querySelector(".probe-info-card"), null, "the missing probe needs no separate note");
    assert.strictEqual(doc.getElementById("probeDriverHome").contains(driver), true);
    assert.strictEqual(driver.hidden, true);
    assert.strictEqual(manual.hidden, true);
    jlinkSidebar.send(list({ override: true, source: "setting" }));
    assert.deepStrictEqual(cardTexts(), [
        "由设置 emberprobe.probeSerial 指定；清空该设置后才能在此选择",
        "J-Link | 1234"
    ]);
    assert.strictEqual(pick(segger).disabled, true);
    assert.strictEqual(auto.hidden, true);
    assert.strictEqual(driver.hidden, false, "an overridden J-Link can still switch its driver");
    jlinkSidebar.send(
        list({
            debugger: "board.cfg",
            family: "",
            state: "script",
            source: "",
            deviceId: "",
            devices: [{ ...segger, selected: false }]
        })
    );
    assert.deepStrictEqual(cardTexts(), ["接口脚本自行选择设备，不能在此选择"]);
    jlinkSidebar.send(list({ state: "none", source: "", deviceId: "", devices: [] }));
    assert.deepStrictEqual(cardTexts(), ["未检测到调试器"]);
    assert.strictEqual(driver.hidden, true);
    assert.deepStrictEqual(
        [auto.hidden, auto.getAttribute("aria-pressed"), auto.disabled],
        [true, "true", true],
        "with no device to keep, the automatic-mode entry stays hidden and disabled"
    );
    jlinkSidebar.send(
        list({ source: "unique-device", devices: [{ ...dap, selectable: true, selected: true }], deviceId: dap.id })
    );
    assert.strictEqual(auto.disabled, true, "a device without a serial cannot be saved, so it stays automatic");
    jlinkSidebar.send(list({ state: "none", source: "", deviceId: "", devices: [] }));
    jlinkSidebar.send({ type: "setLang", lang: "en" });
    assert.deepStrictEqual(cardTexts(), ["No probe detected"], "the list follows language changes");
    assert.strictEqual(auto.textContent, "Auto");
    refresh.click();
    assert.deepStrictEqual(jlinkSidebar.messages.at(-1), { type: "refreshConnectedProbes" });
    assert.strictEqual(section.open, false, "rescanning from the summary does not unfold the list");
    jlinkSidebar.assertHealthy();
} finally {
    jlinkSidebar.close();
}
const graph = render(getLiveWatchContent({ frequencyHz: 500, panelId: 2 }, "en"));
try {
    graph.assertHealthy();
    assert.ok(graph.messages.some((m) => m.type === "ready" && m.panelId === 2));
    assert.strictEqual(graph.window.__CFG__.frequencyHz, 200, "requested rates are clamped to the 200 Hz maximum");
    assert.ok(graph.document.body.textContent.includes("Sampling frequency"));
    graph.send({ type: "watchList", items: [{ name: "tick", type: "u32", address: 536870912 }] });
    graph.document.getElementById("importSidebar").click();
    assert.deepStrictEqual(graph.messages.at(-1), {
        type: "importSidebarWatch",
        items: [{ name: "tick", type: "u32", address: 536870912 }],
        panelId: 2
    });
    graph.send({ type: "sidebarImportResult", added: 1, sourceCount: 2 });
    assert.ok(graph.document.getElementById("status").textContent.includes("Imported 1"));
    graph.send({ type: "liveStatus", source: "dap", snapshotReady: false, intentEnabled: true });
    assert.ok(graph.document.body.classList.contains("debug-stale"));
    graph.send({ type: "liveStatus", source: "openocd", canRead: true, intentEnabled: true });
    assert.ok(!graph.document.body.classList.contains("debug-stale"));
    graph.send({
        type: "liveStatus",
        running: true,
        actualHz: 123.4,
        frequencyHz: 200,
        effectiveIntervalMs: 8,
        p95DurationMs: 3.2,
        missedDeadlines: 0
    });
    assert.strictEqual(graph.document.getElementById("rate").textContent, "0.0kb/s | 123.4Hz");
    assert.ok(graph.document.getElementById("rate").title.includes("Target: 200 Hz"));
    assert.ok(graph.document.getElementById("rate").title.includes("Effective: 125.0 Hz (8 ms)"));
    assert.ok(graph.document.getElementById("rate").title.includes("P95: 3.2ms"));
    graph.send({ type: "liveFrequency", frequencyHz: 30, intervalMs: 33 });
    assert.strictEqual(graph.document.getElementById("frequency").value, "30");
    graph.document.getElementById("frequency").value = "45";
    graph.document.getElementById("frequency").onchange();
    assert.deepStrictEqual(graph.messages.at(-1), { type: "setFrequency", frequencyHz: 45, panelId: 2 });
    graph.assertHealthy();
} finally {
    graph.close();
}
console.log("Webview DOM and message behavior tests passed");

const autocomplete = render(getLiveWatchContent({}, "en"));
try {
    const doc = autocomplete.document;
    const input = doc.getElementById("addName");
    const symbols = ["alpha", "beta", "gamma"].map((name, index) => ({
        name: "_raw_" + name,
        displayName: "ns::" + name,
        address: 0x20000000 + index * 4,
        size: 4,
        watchType: "u32"
    }));
    const type = (text) => {
        input.value = text;
        input.dispatchEvent(new autocomplete.window.Event("input"));
    };
    const key = (value, options = {}) =>
        input.dispatchEvent(
            new autocomplete.window.KeyboardEvent("keydown", { key: value, cancelable: true, ...options })
        );
    const selected = () => doc.getElementById(input.getAttribute("aria-activedescendant"))?.textContent;
    autocomplete.send({ type: "variablesList", symbols });
    type("ns::");
    assert.equal(input.getAttribute("aria-expanded"), "true");
    key("ArrowDown");
    assert.ok(selected().includes("alpha"));
    key("ArrowDown");
    assert.ok(selected().includes("beta"));
    key("ArrowUp");
    assert.ok(selected().includes("alpha"));
    key("ArrowUp");
    assert.ok(selected().includes("gamma"), "up wraps from the first result to the last");
    key("ArrowDown");
    assert.ok(selected().includes("alpha"), "down wraps back to the first result");
    key("ArrowDown");
    key("Enter", { isComposing: true });
    assert.equal(doc.querySelectorAll(".var-card").length, 0, "IME confirmation must not add a variable");
    key("Enter");
    assert.equal(autocomplete.messages.at(-1).type, "saveWatch");
    assert.equal(autocomplete.messages.at(-1).items[0].name, "_raw_beta", "use the selected canonical symbol");
    assert.equal(input.value, "");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(input.hasAttribute("aria-activedescendant"), false);
    type("ns::");
    key("ArrowDown");
    type("gamma");
    assert.equal(input.hasAttribute("aria-activedescendant"), false, "a new query clears the prior selection");
    key("ArrowUp");
    assert.ok(selected().includes("gamma"));
    key("Escape");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    key("Enter");
    assert.equal(autocomplete.messages.at(-1).name, "gamma", "Escape discards the selected suggestion");
    assert.equal(autocomplete.messages.at(-1).type, "resolveVariable");
    type("missing");
    key("ArrowDown");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    key("Enter");
    assert.equal(autocomplete.messages.at(-1).name, "missing", "free-text resolution remains available");
    type("ns::");
    key("ArrowDown");
    autocomplete.send({ type: "variablesListReset", version: "replacement-elf" });
    assert.equal(input.getAttribute("aria-expanded"), "false", "ELF changes invalidate selected suggestions");
    assert.equal(input.hasAttribute("aria-activedescendant"), false);
    autocomplete.assertHealthy();
} finally {
    autocomplete.close();
}
console.log("Live-watch keyboard autocomplete tests passed");

(async () => {
    const layout = {
        kind: "class",
        members: [
            {
                name: "settings",
                offset: 4,
                compositeLayout: {
                    kind: "struct",
                    members: [{ name: "gain", offset: 8, byteSize: 4, watchType: "f32", isConst: true }]
                }
            },
            {
                name: "samples",
                offset: 16,
                compositeLayout: {
                    kind: "array",
                    totalElements: 3,
                    elementType: { byteSize: 4, watchType: "u32" }
                }
            }
        ]
    };
    const symbol = {
        name: "raw_device",
        displayName: "ns::device",
        address: 0x20000000,
        size: 28,
        isComposite: true,
        compositeLayout: layout
    };
    for (const language of ["zh", "en"]) {
        const view = render(getModernWebviewContent({}, language));
        try {
            const doc = view.document;
            const search = (text) => {
                doc.getElementById("varSearch").value = text;
                doc.getElementById("varSearch").dispatchEvent(new view.window.Event("input"));
            };
            view.send({ type: "availableVariables", symbols: [symbol, { name: "other", watchType: "u32" }] });
            assert.equal(doc.querySelectorAll(".av-children.open").length, 0);
            search("GAIN");
            assert.equal(doc.querySelectorAll(".available-row.comp").length, 1);
            assert.equal(doc.querySelectorAll(".av-children.open").length, 1, "member matches open their parent");
            assert.equal(doc.querySelector(".av-leaf-name").textContent, ".settings.gain");
            assert.equal(doc.querySelector(".av-leaf-name").title, "ns::device.settings.gain");
            assert.ok(doc.querySelector(".available-row.leaf .av-write").disabled, "const remains read-only");
            doc.querySelector(".available-row.leaf .av-watch").click();
            const saved = view.messages.findLast((m) => m.type === "saveSidebarWatch").items[0];
            assert.equal(saved.name, "raw_device.settings.gain", "keep canonical member identity");
            assert.equal(saved.address, 0x2000000c);
            assert.equal(saved.isConst, true);
            search("ns::device.samples[2]");
            assert.equal(doc.querySelector(".av-leaf-name").textContent, ".samples[2]");
            search("missing");
            assert.equal(doc.querySelector(".available-row"), null);
            search("");
            assert.equal(doc.querySelectorAll(".av-children.open").length, 0, "search expansion is temporary");
            doc.querySelector(".av-arrow").click();
            search("gain");
            doc.getElementById("varSearchClear").click();
            assert.equal(doc.querySelectorAll(".av-children.open").length, 1, "preserve manual expansion");
            view.send({
                type: "availableVariables",
                symbols: [
                    {
                        ...symbol,
                        compositeLayout: null,
                        runtimeLayout: {
                            root: 2,
                            types: [
                                { kind: "scalar", watchType: "f32", byteSize: 4 },
                                { kind: "class", stl: "vector", args: [0], byteSize: 12 },
                                { kind: "class", fields: [{ name: "telemetry", type: 1, offset: 0 }] }
                            ]
                        }
                    }
                ]
            });
            search("telemetry[2]");
            assert.equal(doc.querySelector(".av-leaf-name"), null);
            view.send({
                type: "liveCompositeSample",
                samples: [
                    {
                        name: symbol.name,
                        tree: {
                            kind: "class",
                            members: [
                                {
                                    name: "telemetry",
                                    kind: "array",
                                    elements: [{ index: 2, kind: "scalar", type: "f32", value: 7 }]
                                }
                            ]
                        }
                    }
                ]
            });
            assert.equal(doc.querySelector(".av-leaf-name").textContent, ".telemetry[2]");
            assert.ok(doc.querySelector(".av-children.open"), "new sampled members update active search results");
            view.assertHealthy();
        } finally {
            view.close();
        }
    }
    const clock = new FakeClock();
    const lazy = render(getModernWebviewContent({}, "en"), {}, { clock });
    try {
        const doc = lazy.document;
        const search = (text) => {
            doc.getElementById("varSearch").value = text;
            doc.getElementById("varSearch").dispatchEvent(new lazy.window.Event("input"));
        };
        const requests = () => lazy.messages.filter((m) => m.type === "resolveCompositeLayout");
        lazy.send({ type: "availableVariablesReset", version: "elf-1" });
        lazy.send({
            type: "availableVariablesChunk",
            version: "elf-1",
            symbols: Array.from({ length: 6 }, (_, i) => ({ ...symbol, name: "device" + i, compositeLayout: null }))
        });
        search("gain");
        await clock.advance(220);
        assert.equal(requests().length, 0, "wait for ELF types to finish loading");
        lazy.send({ type: "availableTypesDone", version: "elf-1" });
        await clock.advance(220);
        assert.equal(requests().length, 4, "bound concurrent metadata requests");
        lazy.send({ type: "compositeLayoutResult", name: "device0", version: "stale-elf", layout });
        assert.equal(doc.querySelector(".av-leaf-name"), null, "ignore stale ELF results");
        lazy.send({ type: "compositeLayoutResult", name: "device0", version: "elf-1", layout });
        assert.equal(doc.querySelector(".av-leaf-name").textContent, ".settings.gain");
        await clock.advance(220);
        assert.equal(requests().length, 5, "continue searching remaining composites as slots become free");
        search("");
        lazy.send({ type: "compositeLayoutResult", name: "device1", version: "elf-1", error: "Unavailable type" });
        await clock.advance(220);
        assert.equal(requests().length, 5, "clearing the query stops further requests");
        search("gain");
        lazy.send({ type: "availableVariablesReset", version: "elf-2" });
        await clock.advance(220);
        assert.equal(requests().length, 5, "ELF replacement cancels queued search work");
        lazy.assertHealthy();
    } finally {
        lazy.close();
    }
    console.log("Sidebar recursive member search and lazy layout tests passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
