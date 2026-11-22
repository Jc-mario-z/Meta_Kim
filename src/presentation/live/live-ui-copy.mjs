/**
 * Product-owned Live UI copy. This is not a translator for task text or logs.
 * Each pattern describes a sentence composed by the renderer; its values are
 * inserted verbatim. Unknown text is preserved, never guessed or sent away.
 */
import { JA_COPY, JA_PROJECT_IMPORT_COPY } from "./live-ui-copy.ja.mjs";
import { KO_COPY, KO_PROJECT_IMPORT_COPY } from "./live-ui-copy.ko.mjs";

// Closed product vocabulary only; directory and project names never pass through it.
export const LIVE_PROJECT_IMPORT_COPY = Object.freeze({
  en: Object.freeze({
    entry: "＋ Import project", title: "Import a local project", path: "Absolute directory on this device", placeholder: "Enter an absolute directory path",
    help: "Only registers an existing project in the list. No copying, initialization, installation or task start. Does not change any Agent's bound execution directory.",
    unavailable: "Project import is unavailable on this connection. A local workspace with explicit write capability is required.",
    check: "Check", checking: "Checking…", confirm: "Import and open", open: "Open project", confirming: "Confirming registration…", refreshing: "Refreshing project list…", retryOpen: "Refresh list and open", retryUnknown: "Verify result and retry safely", cancel: "Cancel",
    name: "Project name", canonicalPath: "Canonical path", evidence: "Governance record count", registration: "Registration", ready: "Not registered · ready to import", registered: "Already registered",
    skipped: "This project was previously excluded from the list. Select the checkbox only if you want to register it again.", skippedConsent: "I agree to register this project again",
    importedPending: "Imported, but the project list has not updated. Retry refresh and open without registering again.", unknown: "Registration result is unknown. Check the list first; retry with the same confirmation token only if needed.",
    invalidPath: "Enter an absolute directory path on this device.", pathUnavailable: "The directory cannot be read. Check that it exists and that you have access.", notGoverned: "This directory has no readable Meta_Kim governance records.",
    expired: "The preview has expired. Check the directory again.", stale: "Project records changed after the preview. Check the directory again.", skippedRequired: "Confirm that you want to register the previously excluded project again.", full: "The project catalog has reached its limit.", failed: "Could not import the project. Your input is preserved; check it and retry.", auth: "Local control authorization has expired. Reconnect the workspace.", request: "The request was rejected. Reload this page and check again.", previewNetwork: "Cannot reach the preview service. Your input is preserved; retry the check."
  }),
  zh: Object.freeze({
    entry: "＋ 导入项目", title: "导入本机项目", path: "本机绝对目录", placeholder: "输入本机绝对目录路径",
    help: "仅将已有项目登记到列表。不复制项目、不初始化或安装、不启动任务，也不改变 Agent 已绑定的执行目录。",
    unavailable: "当前连接未开放项目导入。需要已明确授予写入能力的本地工作区。",
    check: "检查", checking: "正在检查…", confirm: "导入并打开", open: "打开项目", confirming: "正在确认登记…", refreshing: "正在刷新项目列表…", retryOpen: "刷新列表并打开", retryUnknown: "核实结果并安全重试", cancel: "取消",
    name: "项目名称", canonicalPath: "规范路径", evidence: "治理记录数量", registration: "登记状态", ready: "尚未登记 · 可以导入", registered: "已登记",
    skipped: "这个项目曾被排除出列表。只有确实要重新登记时才勾选下方确认。", skippedConsent: "我确认重新登记这个曾被排除的项目",
    importedPending: "已导入，列表暂未更新。可重试刷新并打开，不会再次登记。", unknown: "登记结果暂时未知。先核实项目列表，必要时仅用原确认令牌安全重试。",
    invalidPath: "请输入本机绝对目录路径。", pathUnavailable: "目录暂时不可读取，请检查目录是否存在及访问权限。", notGoverned: "该目录没有可读取的 Meta_Kim 治理记录，不能导入。",
    expired: "预览已过期，请重新检查目录。", stale: "预览后项目记录发生变化，请重新检查目录。", skippedRequired: "请先明确勾选是否重新登记这个曾被排除的项目。", full: "项目列表已达容量上限，暂时无法导入。", failed: "项目导入未完成。已保留输入，请核对后重试。", auth: "本地控制权限已失效，请重新连接工作区。", request: "请求未被接受，请刷新页面后重新检查。", previewNetwork: "暂时无法连接检查服务。已保留输入，可重试检查。"
  }),
  ja: JA_PROJECT_IMPORT_COPY, ko: KO_PROJECT_IMPORT_COPY,
});

// Canonical stage identifiers stay in the records; these are display labels.
export const LIVE_UI_COPY = Object.freeze({
  en: Object.freeze({ critical: "Goal", fetch: "Research", thinking: "Design", execution: "Execution",
    review: "Review", "meta-review": "Meta-review", verification: "Checks", evolution: "Learning",
    evidence: "Evidence", verified: "Verified" }),
  ja: JA_COPY, ko: KO_COPY,
});

const LIVE_UI_PATTERNS = Object.freeze([
  ["^Run ([A-Z0-9-]+)$", "Run {id}", ["id"]],
  ["^(.*) · (\\d+) of (\\d+) runs$", "{project} · {open} of {total} runs", ["project", "open", "total"]],
  ["^\\+ (\\d+) runs without an openable record$", "+ {count} runs without an openable record", ["count"]],
  ["^(.*) · (\\d+) runs$", "{project} · {count} runs", ["project", "count"]],
  ["^(.*) · no runs$", "{project} · no runs", ["project"]],
  ["^(.*) · (\\d+) observed run records$", "{project} · {count} observed run records", ["project", "count"]],
  ["^(\\d+) of (\\d+) steps complete$", "{done} of {total} steps complete", ["done", "total"]],
  ["^(\\d+) active workers?$", "{count} active workers", ["count"]],
  ["^(\\d+) workers?$", "{count} workers", ["count"]],
  ["^(\\d+) events?$", "{count} events", ["count"]],
  ["^Event (\\d+) of (\\d+)$", "Event {index} of {total}", ["index", "total"]],
  ["^Event (\\d+) of (\\d+): (.*)$", "Event {index} of {total}: {label}", ["index", "total", "label"]],
  ["^(\\d+) tools?$", "{count} tools", ["count"]],
  ["^(\\d+) tokens?$", "{count} tokens", ["count"]],
  ["^(.*) · waiting for its first governed run$", "{project} · waiting for its first governed run", ["project"]],
  ["^(\\d+) linked evidence items?$", "{count} linked evidence items", ["count"]],
  ["^(\\d+) evidence$", "{count} evidence", ["count"]],
  ["^(planned|observed) · (\\d+) evidence$", "{status} · {count} evidence", ["status", "count"]],
  ["^Tasks completed (\\d+)/(\\d+)$", "Tasks completed {done}/{total}", ["done", "total"]],
  ["^(\\d+) nodes$", "{count} nodes", ["count"]],
  ["^(\\d+) organization nodes collapsed$", "{count} organization nodes collapsed", ["count"]],
  ["^(\\d+) ownership hidden$", "{count} ownership hidden", ["count"]],
  ["^(\\d+) other relations hidden$", "{count} other relations hidden", ["count"]],
  ["^(\\d+) work nodes$", "{count} work nodes", ["count"]],
  ["^(\\d+) work items$", "{count} work items", ["count"]],
  ["^(\\d+) items$", "{count} items", ["count"]],
  ...["Live", "Selected", "Run ID", "Status", "Owner", "Runtime", "Model", "Duration", "Tools", "Tokens", "Loadout", "Prompt era", "Source"]
    .map((label) => ["^" + label + " · (.*)$", label + " · {value}", ["value"]]),
  ["^Run snapshot updated: (.*)$", "Run snapshot updated: {value}", ["value"]],
  ["^Last observed (.*)$", "Last observed {value}", ["value"]],
  ["^Selected node: (.*)$", "Selected node: {value}", ["value"]],
  ["^Replay (.*)$", "Replay {value}", ["value"]],
  ["^↳ from (.*)$", "↳ from {value}", ["value"]],
]);

/** Values such as project names, identifiers and recorded messages stay intact. */
export function translateLiveUiCopy(value, language) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const copy = LIVE_UI_COPY[language];
  if (!copy || !text) return text;
  if (Object.prototype.hasOwnProperty.call(copy, text)) return copy[text];
  const trimmed = text.trim();
  if (Object.prototype.hasOwnProperty.call(copy, trimmed)) return copy[trimmed];
  if (language === "en") return text;
  for (const [pattern, key, fields] of LIVE_UI_PATTERNS) {
    const match = text.match(new RegExp(pattern, "u"));
    if (!match || !Object.prototype.hasOwnProperty.call(copy, key)) continue;
    const values = Object.fromEntries(fields.map((field, index) => [field, match[index + 1]]));
    // Only the renderer's closed status vocabulary is translated inside values.
    if (fields.includes("status")) values.status = copy[values.status] || values.status;
    if (key === "Status · {value}") values.value = copy[values.value] || values.value;
    return copy[key].replace(/\{([A-Za-z]+)\}/gu, (placeholder, field) => Object.prototype.hasOwnProperty.call(values, field) ? values[field] : placeholder);
  }
  // These prefixes are emitted by controls, never applied to record fields.
  for (const prefix of ["All relations ", "Dependencies ", "Input · ", "Out ", "Output measured ", "output tokens ", "Role · ", "AI worker · ", "Latest timed record · ", "Open result · ", "Current run · ", "Wave ", "Run ID ", "Node: ", "Project: ", "Run: ", "Next: ", "Deliverable: ", "Evidence: ", "Feedback ID: ", "Finding ID: ", "Version read this time: ", "Visible source reference: "]) {
    if (text.startsWith(prefix) && Object.prototype.hasOwnProperty.call(copy, prefix)) return copy[prefix] + text.slice(prefix.length);
  }
  const remaining = text.match(/^Show remaining (\d+) items$/u);
  if (remaining) return copy["Show remaining"] + " · " + remaining[1] + " " + copy.items;
  const roleCaption = text.match(/^(Investigation|Code implementation|Code review|Page design|Quality review|Subtask)( \d+)?$/u);
  if (roleCaption) return copy[roleCaption[1]] + (roleCaption[2] || "");
  if (text.includes(" · ")) return text.split(" · ").map((part) => translateLiveUiCopy(part, language)).join(" · ");
  return text;
}

export function liveUiLocale(language) {
  return ({ zh: "zh-CN", en: "en", ja: "ja-JP", ko: "ko-KR" })[language] || "en";
}

/** The browser runs the same renderer as the focused unit tests, offline. */
export function serializeLiveUiCopy() {
  const json = (value) => JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  return `const LIVE_UI_COPY = ${json(LIVE_UI_COPY)};\nconst LIVE_UI_PATTERNS = ${json(LIVE_UI_PATTERNS)};\n${translateLiveUiCopy.toString()}\n${liveUiLocale.toString()}`;
}
