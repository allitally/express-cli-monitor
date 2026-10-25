import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCliArgs, resolveDumpOptions } from "../cli/parseArgs.js";
import {
  countDumpLines,
  normalizeDumpText,
  resolveDumpFilePath,
  writeDumpFile,
} from "./dumpOutput.js";
import {
  assignDumpKey,
  formatKeySpec,
  keyEventMatches,
  parseKeySpec,
  resolveDumpKeys,
} from "./keySpec.js";

test("parseKeySpec accepts modifiers and aliases", () => {
  assert.deepEqual(parseKeySpec("Ctrl+Shift+F6"), {
    name: "f6",
    ctrl: true,
    alt: false,
    shift: true,
    super: false,
  });
  assert.equal(parseKeySpec("alt+esc").name, "escape");
  assert.equal(formatKeySpec(parseKeySpec("meta+a"), { upper: true }), "alt+A");
});

test("resolveDumpKeys applies defaults and rejects conflicts", () => {
  const keys = resolveDumpKeys({ a: "ctrl+f2" });
  assert.equal(formatKeySpec(keys.a), "ctrl+f2");
  assert.equal(formatKeySpec(keys.b), "f7");
  assert.throws(() => resolveDumpKeys({ b: "f6" }), /重複/);
  assert.throws(() => resolveDumpKeys({ a: "ctrl+c" }), /終了/);
  assert.throws(() => resolveDumpKeys({ a: "x" }), /F1/);
  const cleared = resolveDumpKeys({ all: "none" });
  assert.equal(cleared.all, null);
});

test("assignDumpKey replaces one binding", () => {
  const keys = resolveDumpKeys({});
  const next = assignDumpKey(keys, "c", "alt+c");
  assert.equal(formatKeySpec(next.c), "alt+c");
  assert.equal(formatKeySpec(next.a), "f6");
  const off = assignDumpKey(next, "a", "none");
  assert.equal(off.a, null);
});

test("keyEventMatches ignores repeats and requires modifiers", () => {
  const binding = parseKeySpec("f6");
  assert.equal(keyEventMatches({ name: "f6", eventType: "press" }, binding), true);
  assert.equal(keyEventMatches({ name: "f6", ctrl: true }, binding), false);
  assert.equal(keyEventMatches({ name: "f6", repeated: true }, binding), false);
  const alt = parseKeySpec("alt+a");
  assert.equal(keyEventMatches({ name: "A", meta: true, shift: true }, alt), false);
  assert.equal(keyEventMatches({ name: "a", option: true }, alt), true);
});

test("normalizeDumpText keeps a trailing newline and drops NUL", () => {
  assert.equal(normalizeDumpText("a\0b"), "ab\n");
  assert.equal(normalizeDumpText("a\n"), "a\n");
  assert.equal(normalizeDumpText(""), "");
  assert.equal(countDumpLines("a\nb\n"), 2);
  assert.equal(countDumpLines(""), 0);
});

test("resolveDumpFilePath writes into a directory or an explicit file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "monitor-dump-"));
  try {
    const now = new Date(2026, 9, 25, 22, 1, 2, 3);
    const auto = await resolveDumpFilePath("a", { dumpDir: root, now });
    assert.equal(path.basename(auto), "panel-a-20261025-220102-003.txt");
    await writeDumpFile(auto, "line\n");
    assert.equal(await readFile(auto, "utf8"), "line\n");

    const dir = path.join(root, "out");
    const inside = await resolveDumpFilePath("b", { explicitPath: dir + path.sep, now });
    const info = await stat(dir);
    assert.equal(info.isDirectory(), true);
    assert.equal(path.basename(inside), "panel-b-20261025-220102-003.txt");

    const file = await resolveDumpFilePath("c", { explicitPath: path.join(root, "nested", "c.txt") });
    assert.equal(file, path.resolve(root, "nested", "c.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseCliArgs and resolveDumpOptions merge env and flags", () => {
  const cli = parseCliArgs([
    "node",
    "src/index.js",
    "--dump-key-a",
    "alt+a",
    "--no-dump-clipboard",
    "--script",
    "examples/scripts/sample.script",
  ]);
  assert.equal(cli.scriptPath, "examples/scripts/sample.script");
  assert.equal(cli.dumpToClipboard, false);
  const resolved = resolveDumpOptions(cli, { DUMP_KEY_B: "ctrl+f3", DUMP_DIR: "logs/out" });
  assert.equal(resolved.dumpKeys.a, "alt+a");
  assert.equal(resolved.dumpKeys.b, "ctrl+f3");
  assert.equal(resolved.dumpDir, "logs/out");
  assert.equal(resolved.dumpToClipboard, false);

  const noFile = parseCliArgs(["node", "app", "--no-dump-file"]);
  assert.equal(resolveDumpOptions(noFile, { DUMP_DIR: "keep" }).dumpDir, null);
});
