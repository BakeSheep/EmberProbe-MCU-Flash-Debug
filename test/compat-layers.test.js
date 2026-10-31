"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { COMPAT_LAYERS, reachedRemoval } = require("../scripts/compat-layers");
const { scenario } = require("./helpers/scenario");

const root = path.resolve(__dirname, "..");

scenario("every registered layer is still where the registry says", () => {
    // A layer removed from the code must leave the registry in the same change, and vice versa.
    const ids = new Set();
    for (const layer of COMPAT_LAYERS) {
        assert.ok(!ids.has(layer.id), `duplicate compatibility layer ${layer.id}`);
        ids.add(layer.id);
        assert.ok(layer.purpose, `${layer.id} needs a purpose`);
        assert.ok(
            layer.removeIn ? reachedRemoval(layer.removeIn, layer.removeIn) : layer.permanent,
            `${layer.id} needs a removeIn release or a permanent reason`
        );
        assert.ok(layer.sites.length > 0, `${layer.id} lists no sites`);
        for (const { file, marker } of layer.sites) {
            const text = fs.readFileSync(path.join(root, file), "utf8");
            assert.ok(text.includes(marker), `${layer.id}: ${file} no longer contains ${marker}`);
        }
    }
});

scenario("the removal release and its prereleases count as reached", () => {
    assert.strictEqual(reachedRemoval("0.9.0", "1.0.0"), false);
    assert.strictEqual(reachedRemoval("0.10.3", "1.0.0"), false);
    assert.strictEqual(reachedRemoval("1.0.0-rc.1", "1.0.0"), true);
    assert.strictEqual(reachedRemoval("1.0.0", "1.0.0"), true);
    assert.strictEqual(reachedRemoval("1.2.0", "1.0.0"), true);
    assert.strictEqual(reachedRemoval("2.0.0", null), false);
    assert.throws(() => reachedRemoval("next", "1.0.0"), /Not a release version/);
});

console.log("Compatibility layer registry tests passed");
