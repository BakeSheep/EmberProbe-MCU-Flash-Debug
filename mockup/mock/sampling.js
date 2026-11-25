(function (root) {
    "use strict";

    // A bounded model of SWD transfer costs for the demo data. Measured rates come from
    // the batches actually produced by the browser timer.
    function createSettings() {
        return { frequencyHz: 30, unlimited: false, adaptive: true, manualKhz: 2000 };
    }

    function workload(items) {
        return new Map(items.map((item) => [item.name, Math.max(1, Number(item.size) || 4)]));
    }

    function plan(settings, graph, sidebar, standalone) {
        const graphBytes = Array.from(graph.values()).reduce((total, size) => total + size, 0);
        const sidebarBytes = Array.from(sidebar, ([name, size]) => (graph.has(name) ? 0 : size)).reduce(
            (total, size) => total + size,
            0
        );
        const cost = (bytes, khz) => (bytes ? 0.55 + (bytes * 25) / khz : 0);
        const targetMs = 1000 / settings.frequencyHz;
        const unlimited = standalone && settings.unlimited && graphBytes > 0;
        const clocks = [1000, 2000, 4000, 8000, 12000, 16000, 20000];
        const khz = settings.adaptive
            ? unlimited
                ? clocks.at(-1)
                : (clocks.find((speed) =>
                      graphBytes ? cost(graphBytes, speed) <= targetMs * 0.8 : cost(sidebarBytes, speed) <= 40
                  ) ?? clocks.at(-1))
            : settings.manualKhz;
        const graphCost = cost(graphBytes, khz);
        const graphMs = Math.max(unlimited ? 2 : targetMs, graphCost);
        const spare = Math.max(0.05, 1 - graphCost / graphMs);
        return { graphMs, sidebarMs: Math.max(50, cost(sidebarBytes, khz) / spare), khz, unlimited, graphCost };
    }

    function meter() {
        const points = [];
        return {
            reset() {
                points.length = 0;
            },
            record(time, bytes) {
                if (bytes > 0) points.push({ time, bytes });
                while (points.length > 1 && points[1].time <= time - 1000) points.shift();
                const elapsed = points.length > 1 ? time - points[0].time : 0;
                const bytesRead = points.slice(1).reduce((total, point) => total + point.bytes, 0);
                return {
                    actualHz: elapsed > 0 ? ((points.length - 1) * 1000) / elapsed : 0,
                    bytesPerSecond: elapsed > 0 ? Math.round((bytesRead * 1000) / elapsed) : 0
                };
            }
        };
    }

    function frequency(value, previous) {
        return Number.isFinite(value) && value >= 0.1 && value <= 200 ? Math.round(value * 10) / 10 : previous;
    }

    function compositeSample(simulator, item, time, paths) {
        const sample = simulator.compositeSample(item.name, time);
        if (!sample || !item.runtimeLayout || !Array.isArray(paths)) return sample;
        const open = new Set(paths);
        function trim(node, path) {
            if (!open.has(path)) return { ...node, members: undefined, elements: undefined };
            return {
                ...node,
                members: node.members?.map((child) => trim(child, path + "." + child.name)),
                elements: node.elements?.map((child) => trim(child, path + "[" + child.index + "]"))
            };
        }
        return { ...sample, tree: trim(sample.tree, "") };
    }

    root.EmberProbeMockSampling = { createSettings, workload, plan, meter, frequency, compositeSample };
})(typeof window === "undefined" ? globalThis : window);
