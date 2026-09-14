"use strict";
const Styles = require("../webview/liveWatch/seriesStyles");
const KEY = "emberprobe.seriesStyles.v1";
class SeriesStyleStore {
    constructor(state) {
        this.state = state;
        this.styles = Styles.clean(state.get(KEY)?.styles);
        this.migrated = state.get(KEY)?.version === 1;
        this.pending = Promise.resolve();
    }
    async initialize(lists) {
        if (!this.migrated) {
            for (const list of lists)
                for (const [i, item] of list.entries()) {
                    if (Styles.validName(item.name) && !Object.hasOwn(this.styles, item.name))
                        this.styles[item.name] = { color: Styles.legacyColor(i), line: "solid" };
                }
            this.migrated = true;
            await this.save();
        }
        return this.styles;
    }
    async update(name, style) {
        if (!Styles.validName(name) || (style !== undefined && !Styles.valid(style)))
            throw new Error("Invalid series style");
        if (style) this.styles[name] = { color: style.color, line: style.line };
        else Styles.ensure(this.styles, name);
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
