"use strict";

const assert = require("assert");
const { classifyVariableOrigin, originFromPath } = require("../src/variableOrigin");
const { parseDwarfInternal } = require("../src/dwarf/parser");
const { buildVariableTypes } = require("../src/dwarf/types");
const { ElfService } = require("../src/services/elfService");
const elfSymbols = require("../src/elfSymbols");
const { buildDwarfElf } = require("./helpers/elf-fixture");
const { render } = require("./helpers/render-webview");
const { getModernWebviewContent } = require("../src/modernView");

// Path rules: library/vendor trees and generated vendor files; segments are anchored.
for (const [file, origin] of [
    ["C:/proj/Core/Src/main.c", ""],
    ["C:/proj/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal.c", "vendor"],
    ["../Drivers/CMSIS/Device/ST/STM32F4xx/Source/Templates/system_stm32f4xx.c", "vendor"],
    ["C:\\proj\\Core\\Src\\system_stm32f4xx.c", "vendor"],
    ["C:/proj/Core/Src/stm32f4xx_hal_timebase_tim.c", "vendor"],
    ["C:/proj/Core/Src/syscalls.c", "vendor"],
    ["C:/proj/Middlewares/Third_Party/FreeRTOS/Source/tasks.c", "rtos"],
    ["C:/proj/Middlewares/Third_Party/FreeRTOS/Source/CMSIS_RTOS_V2/cmsis_os2.c", "rtos"],
    ["C:/proj/AZURE_RTOS/App/app_azure_rtos.c", "rtos"],
    ["C:/proj/USB_DEVICE/App/usb_device.c", "middleware"],
    ["C:/proj/Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_core.c", "middleware"],
    ["/build/arm-none-eabi/newlib/libc/reent/impure.c", "runtime"],
    // A project path that merely resembles a library folder stays user code.
    ["C:/Work/Drivers-demo/BSP/led.c", ""],
    // Board support is frequently user-written, even under Drivers/.
    ["C:/proj/Drivers/BSP/LCD/lcd.c", ""],
    ["C:/Work/app/system_init.c", ""],
    ["", ""]
])
    assert.strictEqual(originFromPath(file), origin, file);

const classify = (symbol, options) => classifyVariableOrigin(symbol, options);
assert.strictEqual(classify({ name: "counter", typeName: "int", sourceFile: "C:/proj/Core/Src/main.c" }), "user");
assert.strictEqual(
    classify({ name: "huart1", typeName: "UART_HandleTypeDef", sourceFile: "C:/proj/Core/Src/main.c" }),
    "vendor",
    "CubeMX peripheral handles in main.c are generated"
);
assert.strictEqual(classify({ name: "hdma_usart1_rx" }), "vendor", "handle naming applies before DWARF types");
assert.strictEqual(
    classify({ name: "hsd", typeName: "int", sourceFile: "C:/proj/App/app.c" }),
    "user",
    "a known non-handle type overrides handle-like naming"
);
assert.strictEqual(
    classify({ name: "defaultTaskHandle", typeName: "osThreadId_t", sourceFile: "C:/proj/Core/Src/freertos.c" }),
    "rtos"
);
assert.strictEqual(classify({ name: "defaultTask_attributes", typeName: "const osThreadAttr_t" }), "rtos");
assert.strictEqual(classify({ name: "myTask", typeName: "TaskHandle_t", sourceFile: "C:/p/App/app.c" }), "user");
assert.strictEqual(classify({ name: "pxCurrentTCB" }), "rtos", "kernel names work without DWARF paths");
assert.strictEqual(classify({ name: "Idle_Stack.2" }), "rtos", "numbered statics use their base name");
assert.strictEqual(classify({ name: "_tx_thread_current_ptr" }), "rtos");
assert.strictEqual(classify({ name: "_SEGGER_RTT" }), "middleware");
assert.strictEqual(classify({ name: "SystemCoreClock" }), "vendor");
assert.strictEqual(classify({ name: "_impure_ptr" }), "runtime");
assert.strictEqual(
    classify({ name: "_flag", typeName: "int", sourceFile: "C:/proj/App/app.c" }),
    "user",
    "a user source path outranks the reserved-identifier heuristic"
);
assert.strictEqual(classify({ name: "_ZTV3Foo" }), "runtime", "vtables are compiler generated");
assert.strictEqual(classify({ name: "_ZSt4cout", displayName: "std::cout" }), "runtime");
assert.strictEqual(classify({ name: "_ZN3App5countE", displayName: "App::count" }), "user");
assert.strictEqual(classify({ name: "_ZN3App7__stateE", displayName: "App::__state" }), "runtime");
assert.strictEqual(classify({ name: "impure_data" }), "runtime");
assert.strictEqual(classify({ name: "lib_state" }, { debugComplete: true, hasDebugInfo: false }), "runtime");
assert.strictEqual(classify({ name: "lib_state" }, { debugComplete: false, hasDebugInfo: false }), "user");
assert.strictEqual(
    classify({ name: "x.lto_priv.0" }, { debugComplete: true, hasDebugInfo: false }),
    "user",
    "renamed statics are not treated as prebuilt library objects"
);
assert.strictEqual(
    classify({ name: "_ZN9AppConfig7balanceE" }, { debugComplete: true, hasDebugInfo: false }),
    "user",
    "C++ statics without addressed DWARF records are not library objects"
);
assert.strictEqual(classify({ name: "_ZNSt8ios_base4Init11_S_refcountE" }), "runtime");
assert.strictEqual(classify({ name: "_ZN9__gnu_cxx9__freeresEv" }), "runtime");
assert.strictEqual(classify({ name: "FSMC_Initialized", sourceFile: "C:/proj/Core/Src/fsmc.c" }), "vendor");
assert.strictEqual(classify({ name: "HAL_RCC_ADC12_CLK_ENABLED", sourceFile: "C:/proj/Core/Src/adc.c" }), "vendor");
assert.strictEqual(classify(null), "user");

// DWARF: each variable carries its compilation unit path, joined with DW_AT_comp_dir.
function uleb(value) {
    const bytes = [];
    do {
        const byte = value & 0x7f;
        value >>>= 7;
        bytes.push(byte | (value ? 0x80 : 0));
    } while (value);
    return bytes;
}
const u32 = (value) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
const string = (value) => [...Buffer.from(value), 0];
const abbrev = Buffer.from([
    ...[1, 0x11, 1, 0x03, 0x08, 0x1b, 0x08, 0, 0],
    ...[2, 0x24, 0, 0x03, 0x08, 0x3e, 0x0b, 0x0b, 0x0b, 0, 0],
    ...[3, 0x34, 0, 0x03, 0x08, 0x49, 0x13, 0x02, 0x18, 0, 0],
    0
]);
function unit(name, compDir, variable, address) {
    const bytes = [...u32(0), 4, 0, ...u32(0), 4];
    bytes.push(...uleb(1), ...string(name), ...string(compDir));
    const typeOffset = bytes.length;
    bytes.push(...uleb(2), ...string("unsigned int"), 0x07, 4);
    bytes.push(...uleb(3), ...string(variable), ...u32(typeOffset), 5, 0x03, ...u32(address));
    bytes.push(0);
    const buffer = Buffer.from(bytes);
    buffer.writeUInt32LE(bytes.length - 4, 0);
    return buffer;
}
const info = Buffer.concat([
    unit("../Core/Src/main.c", "C:\\proj\\Debug", "counter", 0x20000000),
    unit("C:/proj/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal.c", "C:\\proj\\Debug", "halState", 0x20000004)
]);
const parsed = parseDwarfInternal(buildDwarfElf(info, abbrev));
const sources = Object.fromEntries(parsed.variables.map((variable) => [variable.name, variable.sourceFile]));
assert.deepStrictEqual(sources, {
    counter: "C:/proj/Core/Src/main.c",
    halState: "C:/proj/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal.c"
});
const types = buildVariableTypes(parsed);
assert.strictEqual(types.get("counter").sourceFile, "C:/proj/Core/Src/main.c");
assert.strictEqual(types.get("halState").typeName, "unsigned int");

// ElfService: origins follow DWARF metadata, and a final pass reclassifies symbols without records.
const service = new ElfService({ elfSymbols, t: (key) => key });
const symbols = [
    { name: "counter", address: 0x20000000, size: 4 },
    { name: "halState", address: 0x20000004, size: 4 },
    { name: "lib_state", address: 0x20000008, size: 4 }
];
assert.deepStrictEqual(service._enrich({ symbols }, new Map()), []);
assert.deepStrictEqual(
    symbols.map((symbol) => symbol.origin),
    ["user", "user", "user"]
);
const changed = service._enrich({ symbols }, types, undefined, undefined, { debugComplete: true });
assert.deepStrictEqual(
    symbols.map((symbol) => symbol.origin),
    ["user", "vendor", "runtime"]
);
assert.deepStrictEqual(
    changed.map((symbol) => symbol.name),
    ["halState", "lib_state"]
);
assert.strictEqual(symbols[0].sourceFile, "C:/proj/Core/Src/main.c");

// Sidebar: the "User only" toggle hides generated variables, persists, and explains empty results.
const sidebar = render(getModernWebviewContent({}, "en"));
try {
    const rows = () =>
        Array.from(sidebar.document.querySelectorAll("#availableVars .available-name")).map(
            (node) => node.dataset.rawName
        );
    sidebar.send({ type: "availableVariablesReset", version: "v1" });
    sidebar.send({
        type: "availableVariablesChunk",
        version: "v1",
        symbols: [
            { name: "counter", address: 0x20000000, size: 4, watchType: "u32", origin: "user" },
            { name: "huart1", address: 0x20000010, size: 4, watchType: "u32", origin: "vendor" },
            { name: "pxCurrentTCB", address: 0x20000020, size: 4, watchType: "u32", origin: "rtos" },
            { name: "legacy", address: 0x20000030, size: 4, watchType: "u32" }
        ]
    });
    sidebar.send({ type: "availableVariablesDone", version: "v1" });
    sidebar.send({
        type: "availableVariableTypes",
        version: "v1",
        symbols: [{ name: "huart1", sourceFile: "C:/proj/Core/Src/main.c", origin: "vendor" }]
    });
    sidebar.send({ type: "availableTypesDone", version: "v1" });
    assert.deepStrictEqual(rows(), ["counter", "huart1", "pxCurrentTCB", "legacy"]);
    const huart = sidebar.document.querySelector('#availableVars .available-name[data-raw-name="huart1"]');
    assert.match(huart.title, /Vendor driver \/ CubeMX generated/);
    assert.match(huart.title, /Source: C:\/proj\/Core\/Src\/main\.c/);
    const toggle = sidebar.document.getElementById("varUserOnly");
    assert.strictEqual(toggle.getAttribute("aria-pressed"), "false");
    toggle.click();
    assert.strictEqual(toggle.getAttribute("aria-pressed"), "true");
    assert.deepStrictEqual(rows(), ["counter", "legacy"], "symbols without an origin stay visible");
    assert.strictEqual(sidebar.document.getElementById("allCount").textContent, "2/4");
    assert.strictEqual(sidebar.getState().sbUserVarsOnly, true);
    const search = sidebar.document.getElementById("varSearch");
    search.value = "huart";
    search.dispatchEvent(new sidebar.window.Event("input"));
    assert.deepStrictEqual(rows(), [], "search respects the origin filter");
    search.value = "";
    search.dispatchEvent(new sidebar.window.Event("input"));
    sidebar.send({ type: "availableVariablesReset", version: "v2" });
    sidebar.send({
        type: "availableVariablesChunk",
        version: "v2",
        symbols: [{ name: "uwTick", address: 0x20000040, size: 4, watchType: "u32", origin: "vendor" }]
    });
    sidebar.send({ type: "availableVariablesDone", version: "v2" });
    assert.strictEqual(
        sidebar.document.querySelector("#availableVars .empty").textContent,
        "No user variables; 1 generated variables are hidden"
    );
    toggle.click();
    assert.deepStrictEqual(rows(), ["uwTick"]);
    assert.strictEqual(sidebar.document.getElementById("allCount").textContent, "1");
    sidebar.assertHealthy();
} finally {
    sidebar.close();
}

const restored = render(getModernWebviewContent({}, "en"), { sbUserVarsOnly: true });
try {
    assert.strictEqual(restored.document.getElementById("varUserOnly").getAttribute("aria-pressed"), "true");
    restored.assertHealthy();
} finally {
    restored.close();
}

console.log("variable origin tests passed");
