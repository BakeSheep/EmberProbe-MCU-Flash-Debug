"use strict";

// Heuristic origin of an ELF variable, used only to filter the variable browser.
// Inputs are DWARF compilation-unit paths, DWARF type names and symbol names. The
// result never affects reads, writes or authorization; "user" is the safe default.
const ORIGINS = Object.freeze(["user", "vendor", "rtos", "middleware", "runtime"]);

// Segment-anchored so a project folder such as C:/Work/Drivers-demo is not matched.
const RUNTIME_PATH =
    /(?:^|\/)(?:newlib(?:-cygwin|-nano)?|libgcc|libstdc\+\+(?:-v3)?|libsupc\+\+|picolibc|libc|libm|microlib|arm-none-eabi|gcc-arm[^/]*|arm-gnu-toolchain[^/]*|armclang|armcc)(?:\/|$)/;
const RTOS_PATH =
    /(?:^|\/)(?:freertos(?:-kernel)?|cmsis_rtos(?:_v2)?|cmsis-rtos2?|threadx|azure_rtos|rt-thread|rtthread|ucos[^/]*|micrium|zephyr|rtx[45]?)(?:\/|$)|(?:^|\/)cmsis_os2?\.c$/;
const MIDDLEWARE_PATH =
    /(?:^|\/)(?:middlewares|third_party|usb_device|usb_host|usbx|fatfs|filex|lwip|netxduo|mbedtls|segger|touchgfx|lvgl|tinyusb|x-cube-[^/]+)(?:\/|$)/;
const VENDOR_PATH =
    /(?:^|\/)(?:cmsis|nrfx|mcux-sdk|[^/]*_hal_driver|[^/]*_stdperiph_driver|[^/]*_standard_peripheral|[^/]*_ll_driver|std_periph[^/]*)(?:\/|$)/;
// Vendor/CubeMX files that hold only generated objects. main.c and freertos.c are
// excluded: they mix generated objects with USER CODE sections.
const VENDOR_FILE =
    /(?:^|\/)(?:stm32\w*_(?:hal|ll)(?:_\w+)?|stm32\w*_it|\w+_hal_msp|\w+_hal_timebase\w*|system_(?:stm32|gd32|at32|ch32|mm32|n32|hk32|apm32|py32|air32|cw32|hc32|mk|nrf|lpc|sam|efm32|efr32|armcm|mimxrt|tm4c|msp432|xmc)\w*|syscalls|sysmem|startup_\w+|fsl_\w+|nrfx_\w+|gd32\w+_\w+|clock_config|pin_mux)\.[cs]$/;

const HAL_HANDLE_TYPE = /\b\w+_HandleTypeDef\b/;
const CMSIS_RTOS_TYPE = /^(?:(?:const|volatile|struct)\s+)*os[A-Z]\w*\b/;
const HAL_HANDLE_NAME =
    /^h(?:dma|uart|usart|lpuart|tim|lptim|hrtim|i2c|i3c|smbus|spi|qspi|ospi|xspi|hspi|i2s|sai|adc|dac|comp|opamp|dfsdm|mdf|adf|can|fdcan|cec|rtc|tamp|iwdg|wwdg|crc|rng|aes|cryp|hash|pka|sd|mmc|nand|nor|sram|sdram|pcd|hcd|eth|dcmi|dcmipp|pssi|ltdc|dsi|dma2d|gpu2d|gfxmmu|jpeg|mdma|bdma|tsc|lcd|swpmi|mdios|fmac|cordic|ucpd|ipcc|hsem|irda|smartcard|exti|icache|dcache|ramcfg|gtzc|otfdec|mce)\d*(?:_\w+)?$/;
const VENDOR_NAMES = new Set([
    "SystemCoreClock",
    "AHBPrescTable",
    "APBPrescTable",
    "MSIRangeTable",
    "PLLMulTable",
    "uwTick",
    "uwTickPrio",
    "uwTickFreq",
    "pFlash",
    "g_pfnVectors",
    "hUsbDeviceFS",
    "hUsbDeviceHS",
    "hUsbHostFS",
    "hUsbHostHS"
]);
// FreeRTOS kernel, heap and CMSIS-RTOS wrapper objects for ELFs without DWARF paths.
const RTOS_NAMES = new Set([
    "pxCurrentTCB",
    "pxCurrentTCBs",
    "xTickCount",
    "uxTopReadyPriority",
    "pxReadyTasksLists",
    "xDelayedTaskList1",
    "xDelayedTaskList2",
    "pxDelayedTaskList",
    "pxOverflowDelayedTaskList",
    "xPendingReadyList",
    "xTasksWaitingTermination",
    "uxDeletedTasksWaitingCleanUp",
    "xSuspendedTaskList",
    "uxCurrentNumberOfTasks",
    "xSchedulerRunning",
    "uxPendedTicks",
    "xPendedTicks",
    "xYieldPending",
    "xYieldPendings",
    "xNumOfOverflows",
    "uxTaskNumber",
    "xNextTaskUnblockTime",
    "xIdleTaskHandle",
    "xIdleTaskHandles",
    "uxSchedulerSuspended",
    "ulTaskSwitchedInTime",
    "ulTotalRunTime",
    "ucHeap",
    "xStart",
    "pxEnd",
    "xFreeBytesRemaining",
    "xMinimumEverFreeBytesRemaining",
    "xBlockAllocatedBit",
    "xNumberOfSuccessfulAllocations",
    "xNumberOfSuccessfulFrees",
    "xHeapStructSize",
    "xActiveTimerList1",
    "xActiveTimerList2",
    "pxCurrentTimerList",
    "pxOverflowTimerList",
    "xTimerQueue",
    "xTimerTaskHandle",
    "xQueueRegistry",
    "uxCriticalNesting",
    "ulCriticalNesting",
    "ucMaxSysCallPriority",
    "ulMaxPRIGROUPValue",
    "KernelState",
    "Idle_TCB",
    "Idle_Stack",
    "Timer_TCB",
    "Timer_Stack",
    "rt_current_thread",
    "rt_thread_priority_table",
    "rt_thread_ready_priority_group",
    "rt_interrupt_nest"
]);
const RUNTIME_NAMES = new Set(["errno", "environ", "impure_data"]);
// CubeMX init-state statics in generated peripheral files (fmc.c, adc.c, ...).
const CUBEMX_STATIC_NAME = /^(?:F[S]?MC_(?:De)?Initialized|HAL_RCC_\w+_CLK_ENABLED)$/;
// Mangled libstdc++/ABI objects (std::, __gnu_cxx::, __cxxabiv1::).
const CPP_RUNTIME_MANGLED = /^_Z(?:N?St|N\d+__)/;
const isMangled = (name) => /^_Z/.test(name);

function normalizePath(value) {
    return typeof value === "string" ? value.replace(/\\/g, "/").toLowerCase() : "";
}

function originFromPath(sourceFile) {
    const file = normalizePath(sourceFile);
    if (!file) return "";
    if (RUNTIME_PATH.test(file)) return "runtime";
    if (RTOS_PATH.test(file)) return "rtos";
    if (MIDDLEWARE_PATH.test(file)) return "middleware";
    if (VENDOR_PATH.test(file) || VENDOR_FILE.test(file)) return "vendor";
    return "";
}

// Static locals and LTO privates are renamed `name.N` / `name.lto_priv.N`.
function baseName(name) {
    const text = String(name || "");
    const dot = text.indexOf(".");
    return dot > 0 ? text.slice(0, dot) : text;
}

function originFromName(symbol) {
    const raw = String(symbol.name || "");
    // vtable, typeinfo, typeinfo name, VTT and guard variables.
    if (/^_Z(?:TV|TI|TS|TT|GV|TH|TW)/.test(raw) || CPP_RUNTIME_MANGLED.test(raw)) return "runtime";
    const display = String(symbol.displayName || raw);
    const qualified = !isMangled(display) && display.includes("::");
    if (qualified) {
        if (/^(?:std|__gnu_cxx|__cxxabiv1|__gnu_debug)::/.test(display)) return "runtime";
        return /(?:^|::)__/.test(display) ? "runtime" : "";
    }
    // An undemangled C++ name says nothing more about its origin.
    if (isMangled(raw) && isMangled(display)) return "";
    const name = baseName(isMangled(raw) ? display : raw);
    if (/^_(?:tx|ux|nx|fx|gx|lx)_/.test(name) || RTOS_NAMES.has(name)) return "rtos";
    if (name === "_SEGGER_RTT") return "middleware";
    if (VENDOR_NAMES.has(name) || CUBEMX_STATIC_NAME.test(name)) return "vendor";
    if (RUNTIME_NAMES.has(name)) return "runtime";
    // File-scope identifiers beginning with "_" are reserved for the implementation. A known
    // DWARF source path is stronger evidence, so user files may still use such names.
    return !symbol.sourceFile && /^_/.test(name) ? "runtime" : "";
}

function originFromType(symbol) {
    const typeName = String(symbol.typeName || "");
    if (typeName) {
        if (HAL_HANDLE_TYPE.test(typeName)) return "vendor";
        // CubeMX emits CMSIS-RTOS objects (osThreadId_t, osThreadAttr_t, ...).
        if (CMSIS_RTOS_TYPE.test(typeName)) return "rtos";
        return "";
    }
    // Without DWARF types, fall back to CubeMX handle naming.
    return HAL_HANDLE_NAME.test(baseName(symbol.name)) ? "vendor" : "";
}

/**
 * @param {{name?: string, displayName?: string, typeName?: string, sourceFile?: string}} symbol
 * @param {{debugComplete?: boolean, hasDebugInfo?: boolean}} [options]
 *   debugComplete: DWARF finished and the ELF has debug info for some variables.
 *   hasDebugInfo: this symbol has a DWARF variable record.
 * @returns {"user"|"vendor"|"rtos"|"middleware"|"runtime"}
 */
function classifyVariableOrigin(symbol, options = {}) {
    if (!symbol || typeof symbol !== "object") return "user";
    const origin = originFromPath(symbol.sourceFile) || originFromName(symbol) || originFromType(symbol);
    if (origin) return origin;
    // User sources are built with debug info; an object symbol without any DWARF record in an
    // otherwise debuggable ELF comes from a prebuilt library (newlib, vendor .a files).
    // Renamed statics and C++ names are excluded because their DWARF binding is best-effort
    // (constexpr/inline static members can have no addressed DWARF variable).
    const name = String(symbol.name || "");
    if (options.debugComplete && !options.hasDebugInfo && !name.includes(".") && !isMangled(name)) return "runtime";
    return "user";
}

module.exports = { ORIGINS, classifyVariableOrigin, originFromPath };
