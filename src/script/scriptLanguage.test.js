import assert from "node:assert/strict";
import test from "node:test";
import {
  executeScriptProgram,
  parseScriptProgram,
  ScriptLanguageError,
} from "./scriptLanguage.js";

async function run(source, state = {}) {
  const commands = [];
  const result = await executeScriptProgram(parseScriptProgram(source), {
    state,
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
