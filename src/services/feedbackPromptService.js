"use strict";

/**
 * 侧边栏反馈提示(GitHub star / issue)决策服务。
 *
 * 两条提示互斥,同一时刻最多显示一条,由 host 统一决策并通过 webview 消息推送:
 * - star 提示:每 7 天最多一次(首次出现在首次激活一个周期后),点击 Github 跳转后永久不再出现;
 * - 反馈位提示("遇到问题了"/"需要新功能"两版文案随机出现):常驻,点 × 后 24 小时内不再出现。
 *
 * star 到期优先于反馈位:star 是低频且机会有限的事件,反馈位常驻,错过下次仍会显示。
 * 状态持久化在 globalState,键名带版本后缀;读取时对畸形数据做类型防御。
 */

/** @type {string} globalState 存储键(带版本后缀,结构变更时递增) */
const STATE_KEY = "emberprobe.feedbackPrompt.v1";
/** @type {string} 仓库主页(star 提示跳转目标) */
const REPO_URL = "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug";
/** @type {string} issues 列表页(反馈提示跳转目标) */
const ISSUES_URL = "https://github.com/BakeSheep/EmberProbe-MCU-Flash-Debug/issues";
/** @type {number} star 提示出现周期(毫秒):每 7 天最多一次 */
const DEFAULT_STAR_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** @type {number} 反馈位点 × 后的静默时长(毫秒):24 小时 */
const DEFAULT_ISSUE_SNOOZE_MS = 24 * 60 * 60 * 1000;

const PROMPT_KINDS = ["star", "issue", "feature"];

/**
 * 将存储的状态修补为可信形状:非法/缺失字段回退默认值,不信任 globalState 里的旧数据。
 * @param {unknown} stored globalState 中读到的原始值
 * @param {number} now 当前时间戳,作为首次激活时间的默认值
 * @param {number} starIntervalMs star 提示周期,用于推导首个展示时间
 * @returns {{v: number, firstActivatedAt: number, starred: boolean, starNextEligibleAt: number, issueSnoozedUntil: number}}
 */
function normalizeState(stored, now, starIntervalMs) {
    const src = stored && typeof stored === "object" ? /** @type {Record<string, unknown>} */ (stored) : {};
    const asFinite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    const firstActivatedAt = asFinite(src.firstActivatedAt) ?? now;
    const starred = typeof src.starred === "boolean" ? src.starred : false;
    const starNextEligibleAt = asFinite(src.starNextEligibleAt) ?? firstActivatedAt + starIntervalMs;
    const issueSnoozedUntil = asFinite(src.issueSnoozedUntil) ?? 0;
    return { v: 1, firstActivatedAt, starred, starNextEligibleAt, issueSnoozedUntil };
}

/**
 * 纯决策函数:根据状态与当前时间判断应显示哪条提示。
 * @param {unknown} state globalState 状态(内部做防御性规范化)
 * @param {number} now 当前时间戳
 * @param {{starIntervalMs?: number, random?: () => number}} [opts] 可注入周期与随机源(便于测试)
 * @returns {{kind: "star"|"issue"|"feature"|null}} kind 为 null 表示当前不显示任何提示
 */
function resolvePrompt(state, now, opts) {
    const starIntervalMs =
        opts && typeof opts.starIntervalMs === "number" ? opts.starIntervalMs : DEFAULT_STAR_INTERVAL_MS;
    const random = opts && typeof opts.random === "function" ? opts.random : Math.random;
    const s = normalizeState(state, now, starIntervalMs);
    if (!s.starred && now >= s.starNextEligibleAt) return { kind: "star" };
    if (now >= s.issueSnoozedUntil) return { kind: random() < 0.5 ? "issue" : "feature" };
    return { kind: null };
}

class FeedbackPromptService {
    /**
     * @param {{vscode: {env: {openExternal: Function}, Uri: {parse: Function}}, context: {globalState: {get: Function, update: Function}}, starIntervalMs?: number, issueSnoozeMs?: number, random?: () => number, now?: () => number}} options
     */
    constructor(options) {
        this.vscode = options.vscode;
        this.context = options.context;
        this.starIntervalMs =
            typeof options.starIntervalMs === "number" ? options.starIntervalMs : DEFAULT_STAR_INTERVAL_MS;
        this.issueSnoozeMs =
            typeof options.issueSnoozeMs === "number" ? options.issueSnoozeMs : DEFAULT_ISSUE_SNOOZE_MS;
        this.random = typeof options.random === "function" ? options.random : Math.random;
        this.now = options.now || Date.now;
    }

    /**
     * 计算当前应显示的提示;首次使用时立即持久化激活时间,保证 star 周期从此刻起算。
     * @returns {{kind: "star"|"issue"|"feature"|null}}
     */
    resolve() {
        const now = this.now();
        const stored = this.context.globalState.get(STATE_KEY);
        if (!stored || typeof stored !== "object") {
            this.context.globalState.update(STATE_KEY, normalizeState(stored, now, this.starIntervalMs));
        }
        return resolvePrompt(stored, now, { starIntervalMs: this.starIntervalMs, random: this.random });
    }

    /**
     * 记录提示已展示;仅 star 需要记录(推进下一周期),反馈位常驻无需记录。
     * @param {string} kind
     * @returns {Promise<boolean>} 是否发生了状态写入
     */
    async markShown(kind) {
        if (kind !== "star") return false;
        const now = this.now();
        const state = normalizeState(this.context.globalState.get(STATE_KEY), now, this.starIntervalMs);
        state.starNextEligibleAt = now + this.starIntervalMs;
        await this.context.globalState.update(STATE_KEY, state);
        return true;
    }

    /**
     * 点 × 后静默;issue 与 feature 两种文案共用同一静默时间戳,star 的 × 不产生额外状态。
     * @param {string} kind
     * @returns {Promise<boolean>} 是否发生了状态写入
     */
    async snooze(kind) {
        if (kind !== "issue" && kind !== "feature") return false;
        const now = this.now();
        const state = normalizeState(this.context.globalState.get(STATE_KEY), now, this.starIntervalMs);
        state.issueSnoozedUntil = now + this.issueSnoozeMs;
        await this.context.globalState.update(STATE_KEY, state);
        return true;
    }

    /**
     * 点击 Github 链接:star 提示在跳转前永久标记已点过;URL 仅取自本模块常量。
     * @param {string} kind
     * @returns {Promise<boolean>} 是否执行了跳转
     */
    async open(kind) {
        if (!PROMPT_KINDS.includes(kind)) return false;
        const url = kind === "star" ? REPO_URL : ISSUES_URL;
        if (kind === "star") {
            const now = this.now();
            const state = normalizeState(this.context.globalState.get(STATE_KEY), now, this.starIntervalMs);
            state.starred = true;
            await this.context.globalState.update(STATE_KEY, state);
        }
        await this.vscode.env.openExternal(this.vscode.Uri.parse(url));
        return true;
    }
}

module.exports = {
    FeedbackPromptService,
    resolvePrompt,
    STATE_KEY,
    REPO_URL,
    ISSUES_URL,
    DEFAULT_STAR_INTERVAL_MS,
    DEFAULT_ISSUE_SNOOZE_MS
};
