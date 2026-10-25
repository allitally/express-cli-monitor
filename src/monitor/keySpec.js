/** @typedef {"a" | "b" | "c" | "all"} DumpTarget */

/** @typedef {{ name: string, ctrl: boolean, alt: boolean, shift: boolean, super: boolean }} DumpBinding */

export const DUMP_TARGETS = ["a", "b", "c", "all"];

export const DEFAULT_DUMP_KEYS = {
  a: "f6",
  b: "f7",
  c: "f8",
  all: "f9",
};

const MODIFIERS = new Set([
  "ctrl",
  "control",
  "alt",
  "option",
  "meta",
  "shift",
  "super",
  "cmd",
  "command",
]);

const KEY_ALIASES = {
  enter: "return",
  esc: "escape",
  del: "delete",
  pgup: "pageup",
  pgdn: "pagedown",
};

const BARE_FUNCTION_KEYS = new Set([
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]);

/**
 * @param {string} spec
 * @returns {DumpBinding}
 */
export function parseKeySpec(spec) {
  if (typeof spec !== "string") {
    throw new TypeError("キー指定は文字列です");
  }
  const parts = spec
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error("キー指定が空です");
  }

  /** @type {DumpBinding} */
  const binding = { name: "", ctrl: false, alt: false, shift: false, super: false };
  const keyName = parts[parts.length - 1];
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === "ctrl" || part === "control") binding.ctrl = true;
    else if (part === "alt" || part === "option" || part === "meta") binding.alt = true;
    else if (part === "shift") binding.shift = true;
    else if (part === "super" || part === "cmd" || part === "command") binding.super = true;
    else throw new Error(`不明な修飾キーです: ${part}`);
  }
  if (MODIFIERS.has(keyName)) {
    throw new Error(`キー名がありません: ${spec}`);
  }
  binding.name = KEY_ALIASES[keyName] ?? keyName;
  return binding;
}

/**
 * コマンド入力や Ctrl+C 終了と重なる割り当てを拒む。
 * @param {DumpBinding} binding
 */
export function assertDumpBinding(binding) {
  const modified = binding.ctrl || binding.alt || binding.shift || binding.super;
  if (
    binding.ctrl &&
    binding.name === "c" &&
    !binding.alt &&
    !binding.shift &&
    !binding.super
  ) {
    throw new Error("ctrl+c はアプリ終了用です。別のキーを指定してください");
  }
  if (!modified && !BARE_FUNCTION_KEYS.has(binding.name)) {
    throw new Error(
      "単体の文字キーはコマンド入力に使われます。ctrl / alt / shift または F1〜F12 を指定してください",
    );
  }
}

/**
 * @param {DumpBinding} binding
 * @param {{ upper?: boolean }} [options]
 */
export function formatKeySpec(binding, options = {}) {
  const parts = [];
  if (binding.ctrl) parts.push("ctrl");
  if (binding.alt) parts.push("alt");
  if (binding.shift) parts.push("shift");
  if (binding.super) parts.push("super");
  parts.push(options.upper ? binding.name.toUpperCase() : binding.name);
  return parts.join("+");
}

/**
 * @param {import('@opentui/core').KeyEvent | { name?: string, ctrl?: boolean, shift?: boolean, meta?: boolean, option?: boolean, super?: boolean, eventType?: string, repeated?: boolean, baseCode?: number }} event
 * @param {DumpBinding | null | undefined} binding
 */
export function keyEventMatches(event, binding) {
  if (!binding || !event) return false;
  if (event.eventType === "release" || event.eventType === "repeat" || event.repeated) {
    return false;
  }

  const names = new Set([String(event.name ?? "").toLowerCase()]);
  if (typeof event.baseCode === "number" && event.baseCode >= 32 && event.baseCode !== 127) {
    try {
      const ch = String.fromCodePoint(event.baseCode);
      names.add(ch.toLowerCase());
    } catch {
      // ignore unpaired code points
    }
  }
  if (!names.has(binding.name)) return false;
  if (!!event.ctrl !== binding.ctrl) return false;
  if (!!event.shift !== binding.shift) return false;
  if (!!(event.meta || event.option) !== binding.alt) return false;
  if (!!event.super !== binding.super) return false;
  return true;
}

/**
 * @param {Partial<Record<DumpTarget, string | null | undefined>>} [overrides]
 * @param {Record<DumpTarget, string>} [defaults]
 * @returns {Record<DumpTarget, DumpBinding | null>}
 */
export function resolveDumpKeys(overrides = {}, defaults = DEFAULT_DUMP_KEYS) {
  /** @type {Record<DumpTarget, DumpBinding | null>} */
  const resolved = { a: null, b: null, c: null, all: null };
  for (const id of DUMP_TARGETS) {
    const spec = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : defaults[id];
    if (spec == null || spec === "" || spec === "none") {
      resolved[id] = null;
      continue;
    }
    if (typeof spec !== "string") {
      throw new TypeError(`ダンプキー ${id} は文字列で指定してください`);
    }
    try {
      const binding = parseKeySpec(spec);
      assertDumpBinding(binding);
      resolved[id] = binding;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`ダンプキー ${id}: ${message}`);
    }
  }

  /** @type {Map<string, DumpTarget>} */
  const seen = new Map();
  for (const id of DUMP_TARGETS) {
    const binding = resolved[id];
    if (!binding) continue;
    const token = formatKeySpec(binding);
    const other = seen.get(token);
    if (other) {
      throw new Error(`ダンプキーが重複しています: ${other} と ${id} が ${formatKeySpec(binding, { upper: true })}`);
    }
    seen.set(token, id);
  }
  return resolved;
}

/**
 * @param {Record<DumpTarget, DumpBinding | null>} keys
 * @param {DumpTarget} target
 * @param {string | null} spec `none` で解除
 * @returns {Record<DumpTarget, DumpBinding | null>}
 */
export function assignDumpKey(keys, target, spec) {
  if (!DUMP_TARGETS.includes(target)) {
    throw new Error("ペインは a, b, c, all です");
  }
  const overrides = {};
  for (const id of DUMP_TARGETS) {
    const binding = keys[id];
    overrides[id] = binding ? formatKeySpec(binding) : "none";
  }
  overrides[target] = spec == null || spec.trim() === "" ? "none" : spec.trim();
  return resolveDumpKeys(overrides, {
    a: "none",
    b: "none",
    c: "none",
    all: "none",
  });
}
