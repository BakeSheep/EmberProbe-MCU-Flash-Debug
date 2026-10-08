"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { loadProvider } = require("./helpers/load-provider");

const symbols = Array.from({ length: 80 }, (_, index) => ({
    name: `app::group${index}::counter`,
    address: 0x20000000 + index * 4,
    size: 4,
    watchType: "u32",
    hasDwarfWriteType: true
}));
const composite = {
    name: "plant",
    address: 0x20001000,
    size: 4,
    isComposite: true,
    compositeLayout: {
        kind: "struct",
        members: [{ name: "value", offset: 0, byteSize: 4, watchType: "u32" }]
    }
};
const view = render(getModernWebviewContent({}, "en"));
try {
    view.send({ type: "availableVariables", symbols: [...symbols, composite] });
    view.send({ type: "liveStatus", running: true, canRead: true, canWrite: true });
    const box = view.document.getElementById("availableVars");
    const rows = Array.from(box.querySelectorAll(".available-row"));
    const row = rows[60];
    const watch = row.querySelector(".av-watch");
    const write = row.querySelector(".av-write");
    box.scrollTop = 900;
    box.scrollLeft = 3;
    watch.focus();
    watch.click();
    assert.strictEqual(box.querySelectorAll(".available-row")[60], row, "adding a watch keeps the ELF row");
    assert.strictEqual(view.document.activeElement, watch);
    assert.strictEqual(box.scrollTop, 900);
    assert.strictEqual(watch.textContent, "\u2713");
    watch.click();
    assert.strictEqual(watch.textContent, "+");
    write.click();
    assert(write.classList.contains("on"));
    assert.strictEqual(view.document.querySelector(".write-name-wrap .value-name").textContent, ".counter");
    const input = view.document.querySelector(".write-input");
    input.focus();
    input.value = "7";
    input.dispatchEvent(new view.window.KeyboardEvent("keydown", { key: "Enter" }));
    const request = view.messages.findLast((message) => message.type === "writeVariable");
    assert.strictEqual(request.name, symbols[60].name, "the shortened label never changes the write identity");
    assert.strictEqual(request.value, 7);
    assert(input.classList.contains("pending"));
    for (const canWrite of [false, true]) {
        view.send({
            type: "liveStatus",
            running: true,
            canRead: true,
            canWrite,
            source: "dap",
            snapshotReady: canWrite
        });
        assert.strictEqual(view.document.querySelector(".write-input"), input, "write gating keeps the active card");
        assert.strictEqual(input.disabled, !canWrite);
        assert(input.classList.contains("pending"));
    }
    view.send({ ...request, type: "writeResult", ok: true, value: 7 });
    assert(!input.classList.contains("pending"));
    view.send({ type: "liveSample", samples: [{ name: symbols[60].name, value: 7 }] });
    assert.deepStrictEqual(Array.from(box.querySelectorAll(".available-row")), rows);
    assert.strictEqual(box.scrollTop, 900);
    view.document.querySelector(".write-row .watch-remove").click();
    assert(!write.classList.contains("on"));
    assert.strictEqual(box.querySelectorAll(".available-row")[60], row);

    // Whole composites and leaf selections also update their buttons in place.
    box.querySelector(".av-arrow").click();
    const leaf = box.querySelector(".available-row.leaf");
    const leafWatch = leaf.querySelector(".av-watch");
    leafWatch.click();
    assert.strictEqual(box.querySelector(".available-row.leaf"), leaf);
    assert(leafWatch.classList.contains("on"));
    box.querySelector(".available-row.comp .av-watch").click();
    view.document.querySelector(".value-row.composite .watch-remove").click();
    assert(!leafWatch.classList.contains("on"), "removing a composite also clears its leaf selections");
    leaf.querySelector(".av-write").click();
    assert.strictEqual(view.document.querySelector(".write-name-wrap .value-name").textContent, ".value");

    // Model a browser clamping scroll offsets when its old children are replaced.
    const replaceChildren = box.replaceChildren.bind(box);
    box.replaceChildren = (...nodes) => {
        replaceChildren(...nodes);
        box.scrollTop = 0;
        box.scrollLeft = 0;
    };
    box.scrollTop = 600;
    box.scrollLeft = 5;
    view.send({ type: "compositeLayoutResult", name: composite.name, version: "", layout: composite.compositeLayout });
    assert.strictEqual(box.scrollTop, 600, "real layout updates restore scroll offsets");
    assert.strictEqual(box.scrollLeft, 5);
    const search = view.document.getElementById("varSearch");
    search.value = "group79";
    search.dispatchEvent(new view.window.Event("input"));
    assert.strictEqual(box.scrollTop, 0, "a new filter starts at its first result");
    assert.strictEqual(box.querySelectorAll(".available-row").length, 1);
    view.assertHealthy();
} finally {
    view.close();
}

(async () => {
    const provider = Object.create(loadProvider().prototype);
    for (const destination of ["write", "sidebarWrite", "invalid"])
        await assert.rejects(provider._addAgentWatch({ variables: ["counter"], destination }), {
            code: "INVALID_DESTINATION"
        });
    console.log("Write list identity, ELF scroll stability, gating and Agent destination audit passed");
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
