"use strict";
const assert = require("assert");
const { moveBlock } = require("../src/webview/cardReorder");

const list = ["a", "b", "c", "d"].map((name) => ({ name }));
const names = (items) => items.map((item) => item.name);

assert.deepStrictEqual(names(moveBlock(list, "a", "c", false)), ["b", "a", "c", "d"]);
assert.deepStrictEqual(names(moveBlock(list, "a", "c", true)), ["b", "c", "a", "d"]);
assert.deepStrictEqual(names(moveBlock(list, "d", "a", false)), ["d", "a", "b", "c"], "move to the front");
assert.deepStrictEqual(names(moveBlock(list, "a", "d", true)), ["b", "c", "d", "a"], "move to the end");
assert.deepStrictEqual(names(moveBlock(list, "c", "b", false)), ["a", "c", "b", "d"]);
assert.deepStrictEqual(names(list), ["a", "b", "c", "d"], "the input list is never mutated");
const moved = moveBlock(list, "b", "d", false);
assert.strictEqual(moved[0], list[0], "entries keep their identity");

// Unchanged order, unknown names and self targets return the original array so callers skip saving.
assert.strictEqual(moveBlock(list, "a", "b", false), list);
assert.strictEqual(moveBlock(list, "b", "a", true), list);
assert.strictEqual(moveBlock(list, "a", "a", true), list);
assert.strictEqual(moveBlock(list, "missing", "a", false), list);
assert.strictEqual(moveBlock(list, "a", "missing", false), list);
assert.strictEqual(moveBlock(null, "a", "b", false), null);

// Members and pointees attached to a card move with it and keep their relative order.
const tree = [
    { name: "plant" },
    { name: "plant.gain" },
    { name: "speed" },
    { name: "plant.offset" },
    { name: "ptr" },
    { name: "ptr.value" }
];
const attached = (entry, name) => entry.name.startsWith(name + ".");
assert.deepStrictEqual(names(moveBlock(tree, "plant", "ptr", true, attached)), [
    "speed",
    "ptr",
    "ptr.value",
    "plant",
    "plant.gain",
    "plant.offset"
]);
assert.deepStrictEqual(names(moveBlock(tree, "ptr", "plant", false, attached)), [
    "ptr",
    "ptr.value",
    "plant",
    "plant.gain",
    "speed",
    "plant.offset"
]);
assert.strictEqual(moveBlock(tree, "plant", "plant.gain", false, attached), tree, "a card cannot drop inside itself");

console.log("Card reorder list moves passed");
