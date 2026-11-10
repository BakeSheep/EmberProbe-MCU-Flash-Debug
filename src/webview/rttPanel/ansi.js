"use strict";
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.EmberProbeRttAnsi = factory();
})(globalThis, function () {
    // A small terminal screen for RTT output: lines of styled cells, fed with the text the host formats for a terminal.
    // It follows what firmware logs use: SGR colors and attributes, CR (back to the line start, later text overwrites),
    // backspace, tab and erase-in-line. Cursor movement, scrolling regions and OSC strings are dropped. An escape
    // sequence split across writes is kept until its end arrives.
    const PLAIN = Object.freeze({});
    const MAX_PENDING_ESCAPE = 64;

    function sameStyle(a, b) {
        return (
            a.fg === b.fg &&
            a.bg === b.bg &&
            !!a.bold === !!b.bold &&
            !!a.dim === !!b.dim &&
            !!a.italic === !!b.italic &&
            !!a.underline === !!b.underline &&
            !!a.inverse === !!b.inverse
        );
    }

    // Extended colors: "5;n" picks from the 256-color table, "2;r;g;b" is a true color. Returns the color and how many
    // parameters it used after the 38/48 itself.
    function extendedColor(params, at) {
        if (params[at] === 5 && Number.isInteger(params[at + 1])) {
            const n = params[at + 1];
            return { color: n >= 0 && n < 16 ? n : n >= 16 && n < 256 ? xtermRgb(n) : null, used: 2 };
        }
        if (params[at] === 2 && params.slice(at + 1, at + 4).length === 3) {
            const [r, g, b] = params.slice(at + 1, at + 4).map((value) => Math.max(0, Math.min(255, value || 0)));
            return { color: `rgb(${r}, ${g}, ${b})`, used: 4 };
        }
        return { color: null, used: params.length - at };
    }

    function xtermRgb(n) {
        if (n >= 232) {
            const level = 8 + (n - 232) * 10;
            return `rgb(${level}, ${level}, ${level})`;
        }
        const index = n - 16;
        const step = (value) => (value ? 55 + value * 40 : 0);
        return `rgb(${step(Math.floor(index / 36))}, ${step(Math.floor(index / 6) % 6)}, ${step(index % 6)})`;
    }

    function applySgr(style, params) {
        const next = { ...style };
        if (!params.length) params = [0];
        for (let at = 0; at < params.length; at++) {
            const code = params[at];
            if (code === 0 || code === undefined) {
                for (const key of Object.keys(next)) delete next[key];
            } else if (code === 1) next.bold = true;
            else if (code === 2) next.dim = true;
            else if (code === 3) next.italic = true;
            else if (code === 4) next.underline = true;
            else if (code === 7) next.inverse = true;
            else if (code === 22) {
                delete next.bold;
                delete next.dim;
            } else if (code === 23) delete next.italic;
            else if (code === 24) delete next.underline;
            else if (code === 27) delete next.inverse;
            else if (code >= 30 && code <= 37) next.fg = code - 30;
            else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
            else if (code === 39) delete next.fg;
            else if (code >= 40 && code <= 47) next.bg = code - 40;
            else if (code >= 100 && code <= 107) next.bg = code - 100 + 8;
            else if (code === 49) delete next.bg;
            else if (code === 38 || code === 48) {
                const { color, used } = extendedColor(params, at + 1);
                const key = code === 38 ? "fg" : "bg";
                if (color === null) delete next[key];
                else next[key] = color;
                at += used;
            }
        }
        return Object.keys(next).length ? Object.freeze(next) : PLAIN;
    }

    // options: { maxLines }. lines holds arrays of { ch, style } cells, the last one being the line the cursor is on.
    function createScreen({ maxLines = 10000 } = {}) {
        const screen = {
            lines: [[]],
            column: 0,
            style: PLAIN,
            partial: "",
            // Lines dropped from the top since the screen was created, so a view can drop the same rows.
            droppedTotal: 0,
            write,
            clear,
            segments,
            text
        };

        function current() {
            return screen.lines[screen.lines.length - 1];
        }

        function put(ch) {
            const line = current();
            while (line.length < screen.column) line.push({ ch: " ", style: PLAIN });
            line[screen.column] = { ch, style: screen.style };
            screen.column++;
        }

        function newline() {
            screen.lines.push([]);
            screen.column = 0;
        }

        function eraseInLine(mode) {
            const line = current();
            if (mode === 2) line.length = 0;
            else if (mode === 1) {
                for (let at = 0; at <= screen.column && at < line.length; at++) line[at] = { ch: " ", style: PLAIN };
            } else line.length = Math.min(line.length, screen.column);
        }

        function csi(body, final) {
            if (final === "m") {
                if (/^[\d;:]*$/.test(body))
                    screen.style = applySgr(
                        screen.style,
                        body === "" ? [] : body.split(/[;:]/).map((value) => (value === "" ? 0 : Number(value)))
                    );
            } else if (final === "K") eraseInLine(Number(body) || 0);
            else if (final === "G") screen.column = Math.max(0, (Number(body) || 1) - 1);
            // Everything else (cursor movement, screen erase, modes) has no meaning in a log view.
        }

        // Consumes the escape sequence starting at data[at]; returns the index after it, or -1 when it is unfinished.
        function escape(data, at) {
            const kind = data[at + 1];
            if (kind === undefined) return -1;
            if (kind === "[") {
                let end = at + 2;
                while (end < data.length && !/[@-~]/.test(data[end])) end++;
                if (end >= data.length) return -1;
                csi(data.slice(at + 2, end), data[end]);
                return end + 1;
            }
            if (kind === "]") {
                // OSC ends with BEL or ESC \.
                for (let end = at + 2; end < data.length; end++) {
                    if (data[end] === "\x07") return end + 1;
                    if (data[end] === "\x1b" && data[end + 1] === "\\") return end + 2;
                    if (data[end] === "\x1b" && data[end + 1] === undefined) return -1;
                }
                return -1;
            }
            return at + 2; // A two-character escape such as ESC 7: nothing to show.
        }

        // Writes text; returns { dropped, from }: rows dropped from the top and the first row (after the drop) whose
        // content changed. Rows from there to the end must be redrawn.
        function write(input) {
            const data = screen.partial + String(input ?? "");
            screen.partial = "";
            const startRows = screen.lines.length;
            let from = startRows - 1;
            for (let at = 0; at < data.length;) {
                const ch = data[at];
                if (ch === "\x1b") {
                    const next = escape(data, at);
                    if (next < 0) {
                        const rest = data.slice(at);
                        // A runaway sequence is dropped rather than held forever.
                        if (rest.length <= MAX_PENDING_ESCAPE) screen.partial = rest;
                        break;
                    }
                    at = next;
                    continue;
                }
                if (ch === "\n") newline();
                else if (ch === "\r") screen.column = 0;
                else if (ch === "\b") screen.column = Math.max(0, screen.column - 1);
                else if (ch === "\t") {
                    const stop = (Math.floor(screen.column / 8) + 1) * 8;
                    while (screen.column < stop) put(" ");
                } else if (ch >= " " && ch !== "\x7f") {
                    const code = ch.codePointAt(0);
                    const glyph = code > 0xffff ? String.fromCodePoint(code) : ch;
                    put(glyph);
                    at += glyph.length;
                    continue;
                }
                at++;
            }
            let dropped = 0;
            if (screen.lines.length > maxLines) {
                dropped = screen.lines.length - maxLines;
                screen.lines.splice(0, dropped);
                screen.droppedTotal += dropped;
                from = Math.max(0, from - dropped);
            }
            return { dropped, from };
        }

        function clear() {
            screen.lines = [[]];
            screen.column = 0;
            screen.partial = "";
        }

        // A line as runs of text that share a style.
        function segments(index) {
            const runs = [];
            for (const cell of screen.lines[index] || []) {
                const last = runs[runs.length - 1];
                if (last && sameStyle(last.style, cell.style)) last.text += cell.ch;
                else runs.push({ text: cell.ch, style: cell.style });
            }
            return runs;
        }

        // The plain text of the screen, for tests and copying.
        function text() {
            return screen.lines.map((line) => line.map((cell) => cell.ch).join("")).join("\n");
        }

        return screen;
    }

    // The CSS classes and inline colors a style needs. Colors 0-15 use classes that map to the theme's terminal colors;
    // others are set on the element's style object, which the page's CSP allows.
    function styleClasses(style) {
        let fg = style.fg;
        let bg = style.bg;
        if (style.inverse) [fg, bg] = [bg ?? "default-bg", fg ?? "default-fg"];
        const classes = [];
        const inline = {};
        if (typeof fg === "number") classes.push("fg-" + fg);
        else if (fg === "default-bg") classes.push("fg-inverse");
        else if (typeof fg === "string") inline.color = fg;
        if (typeof bg === "number") classes.push("bg-" + bg);
        else if (bg === "default-fg") classes.push("bg-inverse");
        else if (typeof bg === "string") inline.backgroundColor = bg;
        if (style.bold) classes.push("bold");
        if (style.dim) classes.push("dim");
        if (style.italic) classes.push("italic");
        if (style.underline) classes.push("underline");
        return { classes, inline };
    }

    return { createScreen, styleClasses };
});
