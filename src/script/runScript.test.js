import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runScript } from "./runScript.js";

function createSocket(ack = "OK") {
  return {
    connected: true,
    id: "test-socket",
    emitted: [],
    emit(event, ...args) {
      this.emitted.push({ event, args });
      const callback = args.at(-1);
      if (typeof callback === "function") queueMicrotask(() => callback(ack));
    },
    on() {},
    off() {},
    disconnect() {},
    close() {},
  };
}

const monitor = {
  writePanelC() {},
  setStatus() {},
};

test("preflights scripts before emitting commands", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-preflight-"));
  try {
    const scriptPath = path.join(directory, "invalid.scr");
    await writeFile(scriptPath, "if(1 + ) {\nremote-output bad\n}\n");
    const socket = createSocket();
    const result = await runScript({
      scriptPath,
      url: "http://unused",
      monitor,
      parent_socket: socket,
      on_events: new Map(),
      logDirectory: directory,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "parse_error");
    assert.equal(socket.emitted.length, 0);
    assert.match(await readFile(result.logPath, "utf8"), /SYNTAX_ERROR/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shares one result-only log across root and nested scripts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-nested-"));
  try {
    const rootPath = path.join(directory, "root.scr");
    const childPath = path.join(directory, "child.scr");
    await writeFile(rootPath, [
      "array-payload #{param1}",
      "Ack: OK",
      "load child.scr value=#{param1}",
    ].join("\n"));
    await writeFile(childPath, [
      "array-payload #{value}",
      "Ack: OK",
    ].join("\n"));

    const result = await runScript({
      scriptPath: rootPath,
      url: "http://unused",
      monitor,
      parent_socket: createSocket(),
      on_events: new Map(),
      parameters: ["param1=4"],
      logDirectory: directory,
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.stepsExecuted, 2);
    assert.match(path.basename(result.logPath), /^LOG_\d{8}_\d{6}_\d{3}_root\.log$/);
    const log = await readFile(result.logPath, "utf8");
    assert.match(log, /^\[Step=1\]\[Line=1\]\[Elapsed=\d+ms\] OK ACK="OK"$/m);
    assert.match(log, /^<<child\.scr value=4>>$/m);
    assert.match(log, /^\[Step=2\]\[Line=1\]\[Elapsed=\d+ms\] OK ACK="OK"$/m);
    assert.doesNotMatch(log, /array-payload/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("continues commands while FILE errors are collected asynchronously", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-file-async-"));
  try {
    const scriptPath = path.join(directory, "file-check.scr");
    const missingPattern = path.join(directory, "images", "frame_{0-2}.jpg");
    await writeFile(scriptPath, [
      `FILE(1): ${missingPattern}`,
      "array-payload continued",
      "Ack: OK",
    ].join("\n"));
    const socket = createSocket();
    const result = await runScript({
      scriptPath,
      url: "http://unused",
      monitor,
      parent_socket: socket,
      on_events: new Map(),
      logDirectory: directory,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "file_error");
    assert.equal(socket.emitted.some(({ event }) => event === "array-payload"), true);
    const log = await readFile(result.logPath, "utf8");
    assert.match(log, /FILE_ERROR/);
    assert.match(log, /\[Step=2\].* OK ACK="OK"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
