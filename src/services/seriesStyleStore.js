"use strict";
const Styles = require("../webview/liveWatch/seriesStyles");
const KEY = "emberprobe.seriesStyles.v1";
class SeriesStyleStore {
    constructor(state) {
        this.state = state;
        this.styles = Styles.clean(state.get(KEY)?.styles);
        this.pending = Promise.resolve();
    }
    async update(name, style) {
        if (!Styles.validName(name) || !Styles.valid(style)) throw new Error("Invalid series style");
        if (!Object.hasOwn(this.styles, name) && Object.keys(this.styles).length >= 4096)
            throw new Error("Series style limit reached");
        this.styles[name] = { color: style.color, line: style.line };
        await this.save();
        return this.styles;
    }
    save() {
        const value = { version: 1, styles: { ...this.styles } };
        const write = this.pending.catch(() => {}).then(() => this.state.update(KEY, value));
        this.pending = write;
        return write;
    }
}
module.exports = { SeriesStyleStore };
