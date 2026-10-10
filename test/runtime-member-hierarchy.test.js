"use strict";

const assert = require("assert");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");
const { getLiveWatchContent } = require("../src/liveWatchView");

const base = 0x20000000;
const vectorLayout = {
    kind: "struct",
    typeName: "Vector3",
    members: [
        { name: "x", offset: 0, byteSize: 4, watchType: "f32" },
        { name: "y", offset: 4, byteSize: 4, watchType: "f32" }
    ]
};
const item = {
    name: "imu",
    address: base,
    size: 40,
    isComposite: true,
    compositeLayout: {
        kind: "class",
        typeName: "Wt901",
        members: [
            { name: "dev_addr_", offset: 0, byteSize: 1, watchType: "u8" },
            {
                name: "data_",
                offset: 4,
                compositeLayout: {
                    kind: "struct",
                    typeName: "SensorData",
                    members: [
                        { name: "accel", offset: 0, compositeLayout: vectorLayout },
                        { name: "gyro", offset: 8, compositeLayout: vectorLayout },
                        {
                            name: "history",
                            offset: 16,
                            compositeLayout: {
                                kind: "array",
                                totalElements: 1,
                                elementType: { byteSize: 8, compositeLayout: vectorLayout }
                            }
                        },
                        {
                            name: "samples",
                            offset: 24,
                            compositeLayout: {
                                kind: "array",
                                totalElements: 2,
                                elementType: { byteSize: 4, watchType: "f32" }
                            }
                        }
                    ]
                }
            }
        ]
    },
    runtimeLayout: { root: 0, types: [] }
};
const scalar = (name, value, offset, type = "f32") => ({
    kind: "scalar",
    name,
    type,
    typeName: type === "f32" ? "float" : "uint8_t",
    address: base + offset,
    value
});
const vector = (name, x, offset) => ({
    kind: "struct",
    name,
    typeName: "Vector3",
    members: [scalar("x", x, offset), scalar("y", x + 1, offset + 4)]
});
const tree = (x = 1, offset = 4) => ({
    kind: "class",
    typeName: "Wt901",
    members: [
        scalar("dev_addr_", 80, 0, "u8"),
        {
            kind: "struct",
            name: "data_",
            typeName: "SensorData",
            members: [
                vector("accel", x, offset),
                vector("gyro", 10, 12),
                { kind: "array", name: "history", elements: [{ ...vector("value", 20, 20), index: 0 }] },
                {
                    kind: "array",
                    name: "samples",
                    elements: [
                        { ...scalar("value", 30, 28), index: 0 },
                        { ...scalar("value", 31, 32), index: 1 }
                    ]
                }
            ]
        },
        { kind: "union", members: [scalar("flags", 7, 36, "u8")] }
    ]
});

for (const sidebar of [false, true]) {
    const label = sidebar ? "sidebar" : "chart";
    const listType = sidebar ? "sidebarWatchList" : "watchList";
    const stateKey = sidebar ? "sbExpanded" : "expanded";
    const classes = sidebar
        ? { body: ".sb-body", head: ".sb-comp-head", members: ".sb-members", row: ".sb-mrow", name: ".sb-mname" }
        : {
              body: ".comp-body",
              head: ".comp-head",
              members: ".comp-members",
              row: ".member-row",
              name: ".member-name"
          };
    const html = sidebar ? getModernWebviewContent({}, "en") : getLiveWatchContent({}, "en");
    const view = render(html, { [stateKey]: { imu: true } });
    let now = 10000;
    view.window.Date.now = () => now;
    const sendTree = (sample) => {
        now += 1000;
        view.send({ type: "liveCompositeSample", samples: [{ name: "imu", tree: sample }] });
    };
    const group = (path) => view.document.querySelector(`[data-member-path="${path}"]`);
    const body = (path) => group(path)?.querySelector(`:scope > ${classes.members}`);
    const cell = (path) => view.window.eval(`compCells[${JSON.stringify(path)}]`);
    try {
        view.send({ type: listType, items: [item] });
        sendTree(tree());
        const root = view.document.querySelector(classes.body);
        assert.deepStrictEqual(
            [...root.querySelectorAll(`:scope > ${classes.row} ${classes.name}`)].map((node) => node.textContent),
            ["dev_addr_", "flags"],
            `${label}: named nested members stay below their own group; anonymous members remain promoted`
        );
        assert.ok(group("imu.data_"), `${label}: runtime data_ has its own expandable group`);
        assert.strictEqual(group("imu.data_.accel").parentElement, body("imu.data_"));
        assert.strictEqual(group("imu.data_.gyro").parentElement, body("imu.data_"));
        assert.strictEqual(cell("imu.data_.accel.x").parentElement.parentElement, body("imu.data_.accel"));
        assert.strictEqual(cell("imu.data_.gyro.x").parentElement.parentElement, body("imu.data_.gyro"));
        assert.strictEqual(cell("imu.data_.accel.x").textContent, "1");
        assert.strictEqual(cell("imu.data_.gyro.x").textContent, "10");
        assert.strictEqual(group("imu.data_.history[0]").parentElement, body("imu.data_.history"));
        assert.strictEqual(cell("imu.data_.history[0].x").parentElement.parentElement, body("imu.data_.history[0]"));
        assert.deepStrictEqual(
            [...body("imu.data_.samples").querySelectorAll(classes.name)].map((node) => node.textContent),
            ["[0]", "[1]"],
            `${label}: scalar arrays identify each element by index`
        );
        assert.ok(
            !body("imu.data_").classList.contains("open"),
            "nested groups initially follow static collapse state"
        );
        group("imu.data_").querySelector(classes.head).click();
        group("imu.data_.accel").querySelector(classes.head).click();
        assert.ok(body("imu.data_.accel").classList.contains("open"));
        assert.ok(!body("imu.data_.gyro").classList.contains("open"), "sibling groups fold independently");
        assert.strictEqual(view.getState()[stateKey]["imu.data_.accel"], true);
        const before = cell("imu.data_.accel.x");
        const button = before.parentElement.querySelector(".curve-toggle");
        button?.focus();
        sendTree(tree(2));
        assert.strictEqual(cell("imu.data_.accel.x"), before, "value updates retain the existing leaf DOM");
        assert.strictEqual(before.textContent, "2");
        assert.strictEqual(cell("imu.data_.gyro.x").textContent, "10", "same-named leaves update independently");
        if (button) assert.strictEqual(view.document.activeElement, button, "value refresh retains curve button focus");
        before.click();
        assert.deepStrictEqual(
            view.messages.findLast((message) => message.type === "copyText"),
            {
                type: "copyText",
                text: "2"
            }
        );

        sendTree(tree(3, 0x100));
        assert.notStrictEqual(cell("imu.data_.accel.x"), before, "address changes replace stale curve handlers");
        assert.ok(body("imu.data_").classList.contains("open"));
        assert.ok(body("imu.data_.accel").classList.contains("open"), "shape rebuild restores member fold state");
        if (button) {
            cell("imu.data_.accel.x").parentElement.querySelector(".curve-toggle").click();
            const selected = view.messages.findLast((message) => message.type === "saveWatch").items;
            const member = selected.find((entry) => entry.name === "imu.data_.accel.x");
            assert.strictEqual(member.address, base + 0x100);
            assert.strictEqual(member.type, "f32");
        }

        const unavailable = tree();
        unavailable.members[1].members[1] = {
            kind: "struct",
            name: "gyro",
            typeName: "Vector3",
            members: [],
            unavailable: "Read budget exceeded"
        };
        sendTree(unavailable);
        assert.strictEqual(cell("imu.data_.gyro.x"), undefined, "removed subtrees remove their cached leaves");
        assert.ok(body("imu.data_.gyro").textContent.includes("Read budget exceeded"));
        assert.ok(!body("imu.data_.accel").textContent.includes("Read budget exceeded"));
        sendTree(tree(4));
        assert.strictEqual(cell("imu.data_.gyro.x").textContent, "10", "recovered subtrees retain their hierarchy");
        group("imu.data_.accel").querySelector(classes.head).click();
        sendTree(tree(5));
        assert.ok(!body("imu.data_.accel").classList.contains("open"), "sampling keeps a collapsed subtree closed");

        const restored = render(html, view.getState());
        try {
            restored.send({ type: listType, items: [item] });
            restored.send({ type: "liveCompositeSample", samples: [{ name: "imu", tree: tree() }] });
            const restoredBody = (path) =>
                restored.document.querySelector(`[data-member-path="${path}"] > ${classes.members}`);
            assert.ok(restoredBody("imu.data_").classList.contains("open"), "reload restores expanded parents");
            assert.ok(
                !restoredBody("imu.data_.accel").classList.contains("open"),
                "reload restores collapsed children"
            );
            restored.assertHealthy();
        } finally {
            restored.close();
        }

        // The ELF selector deliberately keeps full member paths in a flat list.
        if (sidebar) {
            view.send({ type: "availableVariables", symbols: [item] });
            view.document.querySelector(".av-arrow").click();
        } else {
            view.send({ type: "variablesListReset", version: "hierarchy" });
            view.send({ type: "variablesListChunk", version: "hierarchy", symbols: [item] });
            view.send({ type: "variableTypesDone", version: "hierarchy" });
            view.document.getElementById("import").click();
            view.send({ type: "variablesListDone", version: "hierarchy" });
            view.document.querySelector(".imp-arrow").click();
        }
        const leaves = [...view.document.querySelectorAll(sidebar ? ".av-leaf-name" : ".imp-leaf-name")];
        const accel = leaves.find((node) => node.textContent === ".data_.accel.x");
        const gyro = leaves.find((node) => node.textContent === ".data_.gyro.x");
        assert.ok(accel && gyro, `${label}: ELF selector retains complete member paths`);
        const leafRow = sidebar ? ".available-row" : ".imp-row";
        assert.strictEqual(
            accel.closest(leafRow).parentElement,
            gyro.closest(leafRow).parentElement,
            "ELF leaves remain flat"
        );
        view.assertHealthy();
    } finally {
        view.close();
    }
}

console.log("Runtime member hierarchy, array labels, fold persistence and flat ELF selectors passed");
