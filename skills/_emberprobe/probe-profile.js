"use strict";
const crypto = require("crypto");

// Defaults from the corresponding OpenOCD drivers. FTDI wiring is supplied by its interface script.
/** @type {Readonly<Record<string, {family: string, label: string, serial: boolean, ids?: number[][]}>>} */
const USB_PROFILES = Object.freeze({
    jlink: { family: "jlink", label: "J-Link", serial: true },
    "st-link": { family: "stlink", label: "ST-Link", serial: true },
    "cmsis-dap": { family: "cmsis-dap", label: "CMSIS-DAP", serial: true },
    xds110: {
        family: "xds110",
        label: "XDS110",
        serial: true,
        ids: [
            [0x0451, 0xbef3],
            [0x0451, 0xbef4],
            [0x1cbe, 0x02a5]
        ]
    },
    nulink: {
        family: "nulink",
        label: "Nu-Link",
        serial: true,
        ids: [
            [0x0416, 0x511b],
            [0x0416, 0x511c],
            [0x0416, 0x511d],
            [0x0416, 0x5200],
            [0x0416, 0x5201]
        ]
    },
    "ti-icdi": { family: "ti-icdi", label: "TI-ICDI", serial: true, ids: [[0x1cbe, 0x00fd]] },
    ftdi: { family: "ftdi", label: "FTDI", serial: true },
    ft232r: { family: "ft232r", label: "FT232R", serial: true, ids: [[0x0403, 0x6001]] },
    // KitProg opens the bulk interface without a serial filter, even when adapter serial is configured.
    kitprog: { family: "kitprog", label: "KitProg", serial: false, ids: [[0x04b4, 0xf139]] },
    vsllink: { family: "vsllink", label: "VSLLINK", serial: true, ids: [[0x0483, 0xa038]] }
});
const LOCAL_DRIVERS = new Set([
    "dummy",
    "remote_bitbang",
    "jtag_vpi",
    "jtag_dpi",
    "vdebug",
    "bcm2835gpio",
    "linuxgpiod",
    "sysfsgpio",
    "parport",
    "imx_gpio",
    "ep93xx",
    "at91rm9200",
    "rshim"
]);

function profileError(message, code = "PROBE_CAPABILITY_UNKNOWN") {
    const i18nKey = {
        PROBE_CAPABILITY_UNKNOWN: "probe.capabilityUnknown",
        PROBE_SELECTION_UNSUPPORTED: "probe.selectionUnsupported",
        PROBE_BACKEND_AMBIGUOUS: "probe.backendAmbiguous",
        PROBE_ENDPOINT_INVALID: "probe.endpointInvalid"
    }[code];
    return Object.assign(new Error(message), { code, category: "configuration", retryable: false, i18nKey });
}

function normalizeInventoryQuery(options = {}) {
    const family = options.family || "all";
    if (!["all", ...Object.values(USB_PROFILES).map((profile) => profile.family)].includes(family))
        throw profileError("Unknown probe family", "PROBE_SELECTION_UNSUPPORTED");
    const vidPid = options.vidPid || [];
    if (
        !Array.isArray(vidPid) ||
        vidPid.length > 16 ||
        vidPid.some(
            (pair) =>
                !Array.isArray(pair) ||
                pair.length !== 2 ||
                pair.some((id) => !Number.isInteger(id) || id < 0 || id > 65535)
        )
    )
        throw profileError("USB filters must contain at most 16 VID/PID pairs", "PROBE_SELECTION_UNSUPPORTED");
    return { family, vidPid };
}

function matchesUsbIds(device, ids = []) {
    return (
        !ids.length ||
        ids.some(([vid, pid]) => Number.parseInt(device.vid, 16) === vid && Number.parseInt(device.pid, 16) === pid)
    );
}

function createProbeProfile(driver, events = [], probe = "") {
    const values = new Map();
    let configuredIds;
    for (const [command, ...args] of events) {
        // Getter calls must not erase an earlier setter. An empty VID/PID list is a selector reset.
        if (args.length || command.endsWith(" vid_pid")) values.set(command, args);
        if (command === "adapter usb vid_pid" || command === `${driver} vid_pid`) configuredIds = args;
    }
    const layout =
        values.get("hla layout")?.[0] ||
        (driver === "hla" && !events.length
            ? /(?:^|\/)stlink/i.test(probe)
                ? "stlink"
                : /(?:^|\/)nulink/.test(probe)
                  ? "nulink"
                  : ""
            : "");
    const key = driver === "hla" ? (layout === "stlink" ? "st-link" : layout) : driver;
    const specification = USB_PROFILES[key];
    const stlinkBackend =
        key === "st-link" ? values.get(driver === "hla" ? "hla stlink_backend" : "st-link backend") : null;
    const backend =
        driver === "cmsis-dap" ? values.get("cmsis-dap backend")?.[0] || "auto" : stlinkBackend?.[0] || "usb";
    const host = driver === "cmsis-dap" ? values.get("cmsis-dap tcp host")?.[0] || "" : "127.0.0.1";
    if (driver === "cmsis-dap" && backend === "auto" && host)
        throw profileError(
            "Select USB or TCP explicitly when a CMSIS-DAP TCP host is configured",
            "PROBE_BACKEND_AMBIGUOUS"
        );
    const kind =
        (driver === "cmsis-dap" || key === "st-link") && backend === "tcp"
            ? "tcp"
            : specification
              ? "usb"
              : LOCAL_DRIVERS.has(driver)
                ? "local"
                : "unknown";
    const port = Number(
        driver === "cmsis-dap" ? values.get("cmsis-dap tcp port")?.[0] || 4441 : stlinkBackend?.[1] || 7184
    );
    if (
        kind === "tcp" &&
        (!/^[A-Za-z0-9_.:\[\]%-]{1,253}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    )
        throw profileError(
            "Configure the CMSIS-DAP TCP host and port in the interface script",
            "PROBE_ENDPOINT_INVALID"
        );
    let vidPid = specification?.ids || [];
    if (configuredIds !== undefined) {
        const ids = configuredIds.map(Number);
        if (!ids.length || ids.length % 2) throw profileError("Incomplete interface USB filter");
        vidPid = Array.from({ length: ids.length / 2 }, (_, index) => ids.slice(index * 2, index * 2 + 2));
    }
    if (driver === "vsllink")
        vidPid = [
            [
                Number(values.get("vsllink usb_vid")?.[0] ?? vidPid[0][0]),
                Number(values.get("vsllink usb_pid")?.[0] ?? vidPid[0][1])
            ]
        ];
    if (driver === "ftdi" && !vidPid.length) throw profileError("The FTDI interface must configure its USB VID/PID");
    const profile = {
        driver,
        layout,
        kind,
        backend: driver === "cmsis-dap" || key === "st-link" ? backend : "",
        family: specification?.family || "",
        label: specification?.label || driver,
        supportsSerial: specification?.serial || false,
        vidPid,
        scriptSerial: values.get("adapter serial")?.[0] || "",
        // HLA's descriptive label is ignored by its USB drivers; it is not a product filter.
        product: values.get("adapter usb product_name")?.[0] || values.get("ftdi device_desc")?.[0] || "",
        channel: values.get("ftdi channel")?.[0] || "",
        endpoint: kind === "tcp" ? `${host.toLowerCase()}:${port}` : ""
    };
    normalizeInventoryQuery({ family: profile.family || "all", vidPid });
    return {
        ...profile,
        fingerprint: crypto
            .createHash("sha256")
            .update(JSON.stringify([profile, events]))
            .digest("hex")
    };
}

const GROUPS = [
    ...new Set(["adapter", "hla", "cmsis-dap", "ftdi", "ft232r", "st-link", "vsllink", "kitprog", ...LOCAL_DRIVERS])
];
const ALIASES = {
    hla_layout: "hla layout",
    hla_vid_pid: "hla vid_pid",
    hla_serial: "adapter serial",
    hla_device_desc: "hla device_desc",
    hla_stlink_backend: "hla stlink_backend",
    cmsis_dap_backend: "cmsis-dap backend",
    cmsis_dap_vid_pid: "cmsis-dap vid_pid",
    cmsis_dap_serial: "adapter serial",
    ftdi_vid_pid: "ftdi vid_pid",
    ftdi_serial: "adapter serial",
    jlink_serial: "adapter serial"
};
// Jim's C command groups must keep their original name: rename breaks OpenOCD dispatch.
// local/upcall preserves dispatch, configuration errors, and the scope of sourced user scripts.
function captureProfileScript() {
    const wrappers = [...GROUPS.map((name) => [name, name]), ...Object.entries(ALIASES)].map(
        ([name, command]) =>
            `if {[llength [info commands ${name}]] && [lsearch -exact $::ep_wrapped ${name}] < 0} { ` +
            `lappend ::ep_wrapped ${name}; local proc ${name} {args} { ` +
            `set r [upcall ${name} {*}$args]; ep_record {${command}} $args; ` +
            (name === "adapter"
                ? `if {[lindex $args 0] eq {driver}} {set ::ep_wrapped {adapter}; uplevel 1 $::ep_install}; `
                : "") +
            `return $r } }`
    );
    return (
        `set ep_events {}; set ep_wrapped {}; ` +
        `proc ep_record {name args} { if {[llength $::ep_events] >= 512} {error {Probe profile budget exceeded}}; ` +
        `lappend ::ep_events [concat [split $name { }] [lindex $args 0]] }; ` +
        `proc ep_hex {value} {set out {}; foreach c [split $value {}] {scan $c %c n; append out [format %06x $n]}; return $out}; ` +
        `set ep_install {${wrappers.join("; ")}}; ${wrappers[0]}`
    );
}

const PRINT_PROFILE =
    "puts EP_PROFILE_BEGIN; foreach event $ep_events {set words {}; foreach word $event {lappend words [ep_hex $word]}; puts EP_PROFILE_WORD=[join $words : ]}; puts EP_PROFILE_END";

function parseProfileEvents(output) {
    const match = String(output).match(/^EP_PROFILE_BEGIN\s*\n([\s\S]*?)^EP_PROFILE_END\s*$/m);
    if (!match || Buffer.byteLength(match[1]) > 256 * 1024) throw profileError("Incomplete OpenOCD interface profile");
    const events = [];
    for (const line of match[1].split(/\r?\n/).filter(Boolean)) {
        if (!line.startsWith("EP_PROFILE_WORD=")) throw profileError("Invalid interface profile record");
        const words = line
            .slice(16)
            .split(":")
            .map((hex) => {
                if (!/^(?:[0-9a-f]{6})*$/.test(hex) || hex.length > 49152)
                    throw profileError("Invalid interface profile word");
                const codes = hex.match(/.{6}/g) || [];
                return codes.map((code) => String.fromCodePoint(Number.parseInt(code, 16))).join("");
            });
        const depth =
            (words[0] === "adapter" && words[1] === "usb") ||
            (words[0] === "cmsis-dap" && ["tcp", "usb"].includes(words[1]))
                ? 3
                : 2;
        events.push([words.slice(0, depth).join(" "), ...words.slice(depth)]);
        if (events.length > 512) throw profileError("Interface profile exceeds its event budget");
    }
    return events;
}

module.exports = {
    USB_PROFILES,
    normalizeInventoryQuery,
    matchesUsbIds,
    createProbeProfile,
    captureProfileScript,
    PRINT_PROFILE,
    parseProfileEvents
};
