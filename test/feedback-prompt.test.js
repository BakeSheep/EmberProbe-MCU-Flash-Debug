"use strict";
const assert = require("assert");
const {
    STATE_KEY,
    REPO_URL,
    ISSUES_URL,
    DEFAULT_STAR_INTERVAL_MS,
    DEFAULT_ISSUE_SNOOZE_MS,
    resolvePrompt,
    FeedbackPromptService
} = require("../src/services/feedbackPromptService");
const i18n = require("../src/i18n");

const DAY_MS = 24 * 60 * 60 * 1000;

// --- URL 固定为 package.json 中的仓库地址,防止被改成交互式/第三方地址 ---
assert.strictEqual(REPO_URL, "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug");
assert.strictEqual(ISSUES_URL, "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/issues");
assert.strictEqual(DEFAULT_STAR_INTERVAL_MS, 7 * DAY_MS, "star prompt cycle should default to 7 days");
assert.strictEqual(DEFAULT_ISSUE_SNOOZE_MS, DAY_MS, "feedback snooze should default to 24 hours");

// --- resolvePrompt 纯函数:首启、周期、互斥、静默与畸形状态 ---
assert.strictEqual(
    resolvePrompt({}, 1000, { random: () => 0 }).kind,
    "issue",
    "first run should show a feedback prompt before any star cycle elapsed"
);
assert.strictEqual(
    resolvePrompt({}, 1000, { random: () => 0.9 }).kind,
    "feature",
    "first run should be able to pick the feature variant"
);

const starDueState = { firstActivatedAt: 0, starNextEligibleAt: 0, issueSnoozedUntil: 0 };
assert.strictEqual(
    resolvePrompt(starDueState, 5000, { random: () => 0 }).kind,
    "star",
    "a due star prompt must win over the feedback slot"
);
assert.strictEqual(
    resolvePrompt({ ...starDueState, starred: true }, 5000, { random: () => 0 }).kind,
    "issue",
    "after starring, the feedback slot takes over and star never returns"
);
assert.strictEqual(
    resolvePrompt({}, 1000, { starIntervalMs: 12345, random: () => 0.9 }).kind,
    "feature",
    "star interval should be injectable"
);

assert.strictEqual(
    resolvePrompt({ issueSnoozedUntil: 5000 }, 4999).kind,
    null,
    "a snoozed feedback slot stays hidden before the timestamp"
);
assert.strictEqual(
    resolvePrompt({ issueSnoozedUntil: 5000 }, 5000, { random: () => 0.9 }).kind,
    "feature",
    "the snooze expires on the timestamp itself"
);
assert.strictEqual(
    resolvePrompt({ starNextEligibleAt: 9000, issueSnoozedUntil: 5000 }, 1000).kind,
    null,
    "no prompt while the star cycle is running and the feedback slot is snoozed"
);

const junkKind = resolvePrompt(
    { starred: "yes", starNextEligibleAt: "soon", issueSnoozedUntil: null, firstActivatedAt: undefined },
    1000
).kind;
assert.ok(
    junkKind === "issue" || junkKind === "feature",
    "malformed stored state must fall back to defaults instead of crashing or showing star"
);

const defaultRandomKind = resolvePrompt({}, 5000).kind;
assert.ok(
    defaultRandomKind === "issue" || defaultRandomKind === "feature",
    "with real Math.random the feedback slot resolves to one of its two variants"
);

// --- 服务:globalState 持久化、openExternal 只允许常量 URL ---
function fakeGlobalState(seed) {
    const map = new Map(Object.entries(seed || {}));
    return {
        map,
        get: (key) => map.get(key),
        async update(key, value) {
            map.set(key, value);
        }
    };
}

function fakeVscode() {
    const opened = [];
    return {
        opened,
        env: {
            openExternal: async (uri) => {
                opened.push(uri.toString());
            }
        },
        Uri: {
            parse: (url) => ({ toString: () => url })
        }
    };
}

async function serviceScenario() {
    const state = fakeGlobalState();
    const vscodeFake = fakeVscode();
    const service = new FeedbackPromptService({ vscode: vscodeFake, context: { globalState: state } });

    const first = service.resolve();
    assert.ok(first.kind === "issue" || first.kind === "feature", "first resolve should pick a feedback variant");
    const initialized = state.map.get(STATE_KEY);
    assert.ok(
        initialized && Number.isFinite(initialized.firstActivatedAt),
        "first resolve should persist the activation timestamp"
    );
    assert.strictEqual(
        initialized.starNextEligibleAt - initialized.firstActivatedAt,
        DEFAULT_STAR_INTERVAL_MS,
        "the first star prompt should be one full cycle after first activation"
    );
    assert.strictEqual(initialized.starred, false, "starred should default to false");
    assert.strictEqual(initialized.v, 1, "state should be versioned");

    await service.markShown("star");
    const afterShown = state.map.get(STATE_KEY);
    assert.ok(
        afterShown.starNextEligibleAt >= Date.now() + DEFAULT_STAR_INTERVAL_MS - 50,
        "markShown should push the next star slot a full cycle ahead"
    );
    assert.strictEqual(await service.markShown("issue"), false, "markShown only applies to the star prompt");

    await service.open("star");
    assert.deepStrictEqual(vscodeFake.opened, [REPO_URL], "starring should open the repository page");
    assert.strictEqual(state.map.get(STATE_KEY).starred, true, "starring must be persisted as permanent dismissal");
    assert.notStrictEqual(service.resolve().kind, "star", "no star prompt after starring");

    await service.open("feature");
    assert.deepStrictEqual(vscodeFake.opened, [REPO_URL, ISSUES_URL], "feedback prompts open the issues page only");
    assert.strictEqual(state.map.get(STATE_KEY).starred, true, "opening an issue link must not change starred");

    await service.snooze("feature");
    const snoozedUntil = state.map.get(STATE_KEY).issueSnoozedUntil;
    assert.ok(
        snoozedUntil >= Date.now() + DEFAULT_ISSUE_SNOOZE_MS - 50,
        "snooze should push the feedback slot past the default window"
    );
    await service.snooze("issue");
    assert.strictEqual(
        state.map.get(STATE_KEY).issueSnoozedUntil,
        snoozedUntil,
        "issue and feature variants must share one snooze timestamp"
    );
    assert.strictEqual(service.resolve().kind, null, "a snoozed feedback slot must not resolve");
    assert.strictEqual(await service.snooze("bogus"), false, "snooze rejects unknown kinds");

    const beforeStarDismiss = { ...state.map.get(STATE_KEY) };
    await service.snooze("star");
    assert.deepStrictEqual(
        state.map.get(STATE_KEY),
        beforeStarDismiss,
        "dismissing the star prompt must not touch feedback state"
    );

    assert.strictEqual(await service.open("bogus"), false, "open rejects unknown kinds");
    assert.strictEqual(vscodeFake.opened.length, 2, "rejected kinds must not open anything");

    // 直接改写存储(模拟静默到期)→ 反馈位恢复显示
    state.map.set(STATE_KEY, { ...state.map.get(STATE_KEY), issueSnoozedUntil: Date.now() - 1 });
    const revived = service.resolve();
    assert.ok(
        revived.kind === "issue" || revived.kind === "feature",
        "an expired snooze must revive the feedback slot"
    );

    // 预置畸形状态 → 服务仍能工作
    const junkState = fakeGlobalState({
        [STATE_KEY]: { starred: "no", starNextEligibleAt: null, issueSnoozedUntil: "x" }
    });
    const junkService = new FeedbackPromptService({ vscode: fakeVscode(), context: { globalState: junkState } });
    const junkResolved = junkService.resolve();
    assert.ok(
        junkResolved.kind === "issue" || junkResolved.kind === "feature",
        "service must tolerate a corrupted stored state"
    );
    await junkService.snooze("issue");
    assert.ok(junkState.map.get(STATE_KEY).starred === false, "repaired state should keep the boolean default");
}

(async () => {
    await serviceScenario();

    // --- i18n:zh/en 键一一对应 ---
    const FB_KEYS = ["fb.starText", "fb.issueText", "fb.featureText", "fb.openTitle", "fb.dismissTitle"];
    for (const key of FB_KEYS) {
        assert.strictEqual(typeof i18n.STRINGS.zh[key], "string", `zh must define ${key}`);
        assert.strictEqual(typeof i18n.STRINGS.en[key], "string", `en must define ${key}`);
    }
    assert.ok(i18n.t("zh", "fb.starText").includes("Star"), "star copy should mention Star");
    assert.ok(i18n.t("en", "fb.featureText").includes("issue"), "feature copy should point at issues");

    console.log("feedback-prompt tests passed");
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
