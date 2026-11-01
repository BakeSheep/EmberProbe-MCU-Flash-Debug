"use strict";
// The live watch "add variable" box: a typed name with an autocomplete list of ELF symbols. Names the page cannot
// resolve itself (unknown or at several addresses) go to the host as resolveVariable; its reply adds the symbol or
// lists the candidates to choose from. Only the reply to the latest request for the text still typed counts.
(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports;
    const variableEntry = factory(commonJs ? require("../runtime") : root.EmberProbeRuntime);
    if (commonJs) module.exports = variableEntry;
    else root.EmberProbeVariableEntry = variableEntry;
})(typeof globalThis === "object" ? globalThis : this, function (runtime) {
    // page: { $, state, post, add(symbol), displayName(symbol), defType(size), noticeArea(id) }
    function create(page) {
        const { $, state } = page;
        const input = $("addName"),
            drop = $("acDrop");
        let matches = [],
            index = -1,
            // Candidates the host listed for an ambiguous name; null for plain autocomplete.
            choices = null,
            requestId = 0,
            pending = null;
        // Several ELF variables match the typed name; an info notice asks which one to add.
        function choiceHint(show) {
            const area = page.noticeArea("acChoiceHint");
            if (area)
                show
                    ? area.set("choice", { level: "info", compact: true, text: { key: "lw.chooseVariableSource" } })
                    : area.clear("choice");
        }
        function hide() {
            drop.classList.remove("open");
            input.setAttribute("aria-expanded", "false");
            input.removeAttribute("aria-activedescendant");
            matches = [];
            index = -1;
            choices = null;
            pending = null;
            choiceHint(false);
        }
        function select(next) {
            index = next;
            const rows = $("acResults").children;
            for (let i = 0; i < rows.length; i++) {
                rows[i].classList.toggle("active", i === next);
                rows[i].setAttribute("aria-selected", String(i === next));
            }
            const row = rows[next];
            if (row) {
                input.setAttribute("aria-activedescendant", row.id);
                if (row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
            }
        }
        function done() {
            input.value = "";
            hide();
        }
        function accept(symbol) {
            if (choices || symbol.addressAmbiguous) {
                resolve(symbol.name);
                return;
            }
            page.add(symbol);
            done();
        }
        function render(candidates) {
            if (!drop) return;
            const q = (input.value || "").trim().toLowerCase();
            hide();
            const results = $("acResults");
            results.textContent = "";
            if (!q) {
                drop.classList.remove("open");
                return;
            }
            const found = Array.isArray(candidates)
                ? candidates
                : state.allSymbols
                      .filter(function (s) {
                          return (
                              s.name.toLowerCase().indexOf(q) >= 0 || page.displayName(s).toLowerCase().indexOf(q) >= 0
                          );
                      })
                      .slice(0, 12);
            if (!found.length) {
                drop.classList.remove("open");
                return;
            }
            matches = found;
            choices = Array.isArray(candidates) ? found : null;
            choiceHint(!!choices);
            found.forEach(function (s, i) {
                const item = document.createElement("div");
                item.className = "ac-item";
                item.id = "ac-option-" + i;
                item.setAttribute("role", "option");
                item.setAttribute("aria-selected", "false");
                const nm = document.createElement("span");
                nm.className = "ac-name";
                runtime.renderSymbolName(nm, page.displayName(s), s);
                const ty = document.createElement("span");
                ty.className = "ac-type";
                ty.textContent = ty.title = s.typeName || s.watchType || (choices ? s.address : page.defType(s.size));
                item.append(nm, ty);
                item.onmousedown = function (e) {
                    e.preventDefault();
                    accept(s);
                };
                results.appendChild(item);
            });
            drop.classList.add("open");
            input.setAttribute("aria-expanded", "true");
        }
        function resolve(name) {
            hide();
            pending = { id: ++requestId, query: input.value.trim(), name: name };
            page.post({ type: "resolveVariable", name: name, version: state.version, requestId: requestId });
        }
        function current(message) {
            return (
                pending &&
                pending.id === message.requestId &&
                pending.name === message.requestedName &&
                pending.query === input.value.trim() &&
                message.version === state.version
            );
        }
        function addTyped() {
            const name = input.value.trim();
            if (!name) return;
            const symbol = state.allSymbols.find(function (s) {
                return s.name === name;
            });
            if (!symbol || symbol.addressAmbiguous) {
                resolve(name);
                return;
            }
            page.add(symbol);
            done();
        }
        input.oninput = function () {
            if (!state.allSymbols.length) page.post({ type: "importVariables", version: state.version });
            render();
        };
        input.onblur = function () {
            setTimeout(function () {
                if (document.activeElement !== input) hide();
            }, 150);
        };
        input.onkeydown = function (e) {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                if (!drop.classList.contains("open")) render();
                if (!matches.length) return;
                e.preventDefault();
                const length = matches.length;
                select(
                    index < 0
                        ? e.key === "ArrowDown"
                            ? 0
                            : length - 1
                        : (index + (e.key === "ArrowDown" ? 1 : -1) + length) % length
                );
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (index >= 0 && drop.classList.contains("open")) accept(matches[index]);
                else addTyped();
            } else if (e.key === "Escape") {
                e.preventDefault();
                hide();
            }
        };
        return {
            render,
            hide,
            // Shows an open list again, for new symbols or another language.
            refresh() {
                if (drop.classList.contains("open")) render(choices);
            },
            // addResolved: whether the symbol is still wanted; a reply to the latest request also clears the box.
            onResolved(message) {
                if (message.requestId === undefined) return true;
                if (!current(message)) return false;
                done();
                return true;
            },
            // variableChoices: list the candidates while the box still has focus.
            onChoices(message) {
                if (!current(message)) return;
                // A reply must not steal focus back after the user has moved to another control.
                if (document.activeElement !== input) return;
                input.focus();
                render(message.candidates);
            },
            // liveError: whether the error is still relevant; it ends the latest request.
            onError(message) {
                if (message.requestId === undefined) return true;
                if (!current(message)) return false;
                pending = null;
                return true;
            }
        };
    }
    return { create };
});
