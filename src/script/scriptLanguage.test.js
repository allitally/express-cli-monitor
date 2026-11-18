import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  executeScriptProgram,
  parseScriptProgram,
  ScriptLanguageError,
  validateScriptProgram,
} from "./scriptLanguage.js";
import { verifyFileSequence } from "./runScript.js";

async function run(source, state = {}, options = {}) {
  const commands = [];
  const result = await executeScriptProgram(parseScriptProgram(source), {
    state,
    ...options,
    executeCommand: async (step) => commands.push(step),
  });
  return { commands, result };
}

test("interpolates declarations, assignments, and arithmetic with precedence", async () => {
  const { commands } = await run(`
var A=1
var label=frame
A=#{A+2*3}
remote-output #{label}-#{A}
Ack: ok
`);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].args, ["frame-7"]);
  assert.equal(commands[0].expectedAck, "ok");
});

test("reads live process and recorder state", async () => {
  const state = {
    process: { frame_number: "42" },
    recorder: { session_id: "session-7" },
  };
  const { commands } = await run(
    "remote-output #{process.frame_number} #{recorder.session_id}",
    state,
  );
  assert.deepEqual(commands[0].args, ["42", "session-7"]);
});

test("reads ImageReceiver members in expressions and interpolations", async () => {
  const state = { Image: { lastFrameNumber: 3000, fps: 29.97 } };
  const { commands } = await run(`
if(Image.lastFrameNumber >= 3000) {
  remote-output #{Image.lastFrameNumber} #{Image.fps}
}`, state);
  assert.deepEqual(commands[0].args, ["3000", "29.97"]);
});

test("executes FILE checks only when their condition is true", async () => {
  const checked = [];
  await run(`
FILE(#{Image.lastFrameNumber}>=3000): /mnt/usb/image/*_*_{0-49}.jpg
FILE(Image.lastFrameNumber<3000): /not/checked/{0-1}.jpg
`, { Image: { lastFrameNumber: 3000 } }, {
    scheduleFileCheck: (pattern) => checked.push(pattern),
  });
  assert.deepEqual(checked, ["/mnt/usb/image/*_*_{0-49}.jpg"]);
});

test("verifies wildcard file sequences and reports gaps", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "script-file-check-"));
  try {
    await Promise.all([0, 1, 2].map((number) =>
      writeFile(path.join(directory, `session_image_${number}.jpg`), "")));
    await verifyFileSequence(path.join(directory, "*_*_{0-2}.jpg"));

    await rm(path.join(directory, "session_image_1.jpg"));
    await assert.rejects(
      () => verifyFileSequence(path.join(directory, "*_*_{0-2}.jpg")),
      /missing: 1/,
    );
    await assert.rejects(
      () => verifyFileSequence(path.join(directory, "*_*_{0-2).jpg")),
      /exactly one sequence range/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validates all expression syntax before execution", () => {
  assert.throws(
    () => validateScriptProgram(parseScriptProgram("if(1 + ) {\nremote-output x\n}")),
    /Expected expression/,
  );
  assert.throws(
    () => validateScriptProgram(parseScriptProgram("remote-output #{value")),
    /Unclosed interpolation/,
  );
});

test("injects load parameters and invokes a subscript with resolved arguments", async () => {
  const loads = [];
  const { commands } = await run(`
remote-output #{param1} #{param2}
load child.scr childParam=#{param1}
`, {}, {
    initialVariables: { param1: "4", param2: "/mnt/usb/aaa.txt" },
    executeLoad: async (scriptPath, parameters) => loads.push({ scriptPath, parameters }),
  });
  assert.deepEqual(commands[0].args, ["4", "/mnt/usb/aaa.txt"]);
  assert.deepEqual(loads, [{ scriptPath: "child.scr", parameters: { childParam: "4" } }]);
});

test("executes nested while, if, continue, break, and block-scoped let", async () => {
  const { commands } = await run(`
var A=0
while(A < 10) {
  A=#{A+1}
  if(A == 2) {
    continue
  }
  if(A >= 4) {
    break
  } else {
    let local=#{A*10}
    remote-output #{local}
  }
}
remote-output done-#{A}
`);
  assert.deepEqual(commands.map((step) => step.args[0]), ["10", "30", "done-4"]);
});

test("labels commands with source lines and active while variable values", async () => {
  const { commands } = await run(`var i=0
while(#{i}<2) {
  remote-output #{i}
  i=#{i+1}
}
remote-output done`);

  assert.deepEqual(
    commands.map((step) => step.displayLabel),
    ["[Line=3(i=0).]", "[Line=3(i=1).]", "[Line=6.]"],
  );
});

test("labels nested loops with each condition variable", async () => {
  const { commands } = await run(`var i=1
var j=2
while(i<2) {
  while(j<3) {
    remote-output nested
    break
  }
  break
}`);
  assert.equal(commands[0].displayLabel, "[Line=5(i=1,j=2).]");
});

test("selects else branch and var remains script scoped", async () => {
  const { commands } = await run(`
if(0) {
  var selected=bad
} else {
  var selected=good
}
remote-output #{selected}
`);
  assert.equal(commands[0].args[0], "good");
});

test("logical operators short-circuit unavailable values", async () => {
  const { commands } = await run(`
if(0 && missing.value) {
  remote-output bad
}
if(1 || missing.value) {
  remote-output good
}
`);
  assert.deepEqual(commands.map((step) => step.args[0]), ["good"]);
});

test("var may be redeclared while a loop repeats", async () => {
  const { commands } = await run(`
var i=0
while(i < 2) {
  var current=#{i}
  i=#{i+1}
}
remote-output #{current}
`);
  assert.equal(commands[0].args[0], "1");
});

test("rejects arithmetic on non-numeric strings", async () => {
  await assert.rejects(
    () => run("var A=text\nA=#{A+1}"),
    (error) => error instanceof ScriptLanguageError && /numeric operands/.test(error.message),
  );
});

test("let does not escape its block", async () => {
  await assert.rejects(
    () => run("if(1) {\nlet local=1\n}\nremote-output #{local}"),
    /Undefined variable: local/,
  );
});

test("standalone blocks nest and let shadows outer bindings", async () => {
  const { commands } = await run(`
let value=outer
{
  let value=inner
  remote-output #{value}
}
remote-output #{value}
`);
  assert.deepEqual(commands.map((step) => step.args[0]), ["inner", "outer"]);
});

test("wait delays asynchronously and observes state updates during the wait", async () => {
  const state = { process: { frame_number: "1" }, recorder: {} };
  setTimeout(() => {
    state.process.frame_number = "2";
  }, 5);

  const startedAt = Date.now();
  const { commands } = await run(`
var delay=15
wait(delay)
remote-output #{process.frame_number}
`, state);

  assert.ok(Date.now() - startedAt >= 10);
  assert.equal(commands[0].args[0], "2");
});

test("wait rejects negative and non-numeric durations", async () => {
  await assert.rejects(() => run("wait(-1)"), /non-negative/);
  await assert.rejects(() => run('wait("later")'), /numeric operands/);
});

test("rejects break outside while and malformed blocks", async () => {
  await assert.rejects(() => run("break"), /only valid inside while/);
  assert.throws(() => parseScriptProgram("while(1) {\nremote-output x"), /Missing closing brace/);
});

test("preserves On and Ack metadata", async () => {
  const { commands } = await run(`
var value=5
On.ready=='^ok': remote-output #{value}
Ack(to=1234): ok
`);
  assert.equal(commands[0].onEvent, "ready");
  assert.equal(commands[0].firstArgPattern.source, "^ok");
  assert.equal(commands[0].timeOut, 1234);
  assert.deepEqual(commands[0].args, ["5"]);
});
