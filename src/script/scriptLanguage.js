import { parseScriptContent } from "./parseScript.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NUMBER_TEXT = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

export class ScriptLanguageError extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = "ScriptLanguageError";
    this.line = line;
  }
}

class Environment {
  constructor(parent = null, scriptScope = null) {
    this.parent = parent;
    this.scriptScope = scriptScope ?? this;
    this.bindings = new Map();
  }

  child() {
    return new Environment(this, this.scriptScope);
  }

  declare(name, value, kind, line) {
    const target = kind === "var" ? this.scriptScope : this;
    if (target.bindings.has(name)) {
      if (kind === "var" && target.bindings.get(name).kind === "var") {
        target.bindings.get(name).value = value;
        return;
      }
      throw new ScriptLanguageError(`${name} is already defined in this scope`, line);
    }
    target.bindings.set(name, { value, kind });
  }

  resolve(name) {
    if (this.bindings.has(name)) return this;
    return this.parent?.resolve(name) ?? null;
  }

  get(name, line) {
    const owner = this.resolve(name);
    if (!owner) throw new ScriptLanguageError(`Undefined variable: ${name}`, line);
    return owner.bindings.get(name).value;
  }

  assign(name, value, line) {
    const owner = this.resolve(name);
    if (!owner) throw new ScriptLanguageError(`Undefined variable: ${name}`, line);
    owner.bindings.get(name).value = value;
  }
}

function meaningfulLines(content) {
  return content.split(/\r?\n/).map((raw, index) => ({
    raw,
    text: raw.trim(),
    line: index + 1,
  }));
}

function parseCommand(lines, index) {
  const item = lines[index];
  let source = item.text;
  const next = lines[index + 1];
  if (next && (next.text.startsWith("Ack") || next.text.startsWith("Pass:"))) {
    source += `\n${next.text}`;
    index++;
  }
  let step;
  try {
    [step] = parseScriptContent(source);
  } catch (error) {
    throw new ScriptLanguageError(error instanceof Error ? error.message : String(error), item.line);
  }
  return [{ type: "command", step, line: item.line }, index + 1];
}

function parseBlock(lines, start, inBlock = false) {
  const statements = [];
  let index = start;
  while (index < lines.length) {
    const item = lines[index];
    if (!item.text || item.text.startsWith("#")) {
      index++;
      continue;
    }
    const isElseTerminator = /^}\s*else\s*\{$/.test(item.text);
    if (item.text === "}" || isElseTerminator) {
      if (!inBlock) throw new ScriptLanguageError("Unexpected closing brace", item.line);
      return { statements, index, terminator: isElseTerminator ? "} else {" : "}" };
    }
    if (item.text === "{") {
      const block = parseBlock(lines, index + 1, true);
      if (block.terminator !== "}") {
        throw new ScriptLanguageError("Missing closing brace", item.line);
      }
      statements.push({ type: "block", body: block.statements, line: item.line });
      index = block.index + 1;
      continue;
    }

    const wait = item.text.match(/^wait\s*\((.*)\)\s*$/);
    if (wait) {
      if (!wait[1].trim()) throw new ScriptLanguageError("wait duration is empty", item.line);
      statements.push({ type: "wait", expression: wait[1], line: item.line });
      index++;
      continue;
    }

    const fileCheck = item.text.match(/^FILE\s*\((.*)\)\s*:\s*(.+)$/);
    if (fileCheck) {
      if (!fileCheck[1].trim()) throw new ScriptLanguageError("FILE condition is empty", item.line);
      if (!fileCheck[2].trim()) throw new ScriptLanguageError("FILE pattern is empty", item.line);
      statements.push({
        type: "file",
        condition: fileCheck[1],
        pattern: fileCheck[2].trim(),
        line: item.line,
      });
      index++;
      continue;
    }

    if (/^load(?:\s|$)/.test(item.text)) {
      let parsed;
      try {
        parsed = parseScriptContent(item.text)[0];
      } catch (error) {
        throw new ScriptLanguageError(error instanceof Error ? error.message : String(error), item.line);
      }
      if (parsed.event !== "load" || parsed.args.length === 0) {
        throw new ScriptLanguageError("load requires a script file", item.line);
      }
      const parameters = [];
      for (const argument of parsed.args.slice(1)) {
        const match = String(argument).match(/^([A-Za-z_$][A-Za-z0-9_$]*)=(.*)$/);
        if (!match) {
          throw new ScriptLanguageError(`Invalid load parameter: ${argument}`, item.line);
        }
        parameters.push({ name: match[1], value: match[2] });
      }
      statements.push({
        type: "load",
        scriptPath: String(parsed.args[0]),
        parameters,
        line: item.line,
      });
      index++;
      continue;
    }

    const control = item.text.match(/^(while|if)\s*\((.*)\)\s*\{$/);
    if (control) {
      if (!control[2].trim()) throw new ScriptLanguageError("Condition is empty", item.line);
      const body = parseBlock(lines, index + 1, true);
      if (!body.terminator) throw new ScriptLanguageError("Missing closing brace", item.line);
      const node = {
        type: control[1],
        condition: control[2],
        body: body.statements,
        line: item.line,
      };
      index = body.index + 1;
      if (control[1] === "if" && body.terminator === "} else {") {
        const alternate = parseBlock(lines, index, true);
        if (alternate.terminator !== "}") {
          throw new ScriptLanguageError("Missing closing brace for else", item.line);
        }
        node.alternate = alternate.statements;
        index = alternate.index + 1;
      } else if (body.terminator === "} else {") {
        throw new ScriptLanguageError("else can only follow if", lines[body.index].line);
      }
      statements.push(node);
      continue;
    }

    const declaration = item.text.match(/^(var|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.*)$/);
    if (declaration) {
      if (!declaration[3].trim()) throw new ScriptLanguageError("Initializer is empty", item.line);
      statements.push({
        type: "declaration", kind: declaration[1], name: declaration[2],
        expression: declaration[3], line: item.line,
      });
      index++;
      continue;
    }

    const assignment = item.text.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(.*)$/);
    if (assignment) {
      if (!assignment[2].trim()) throw new ScriptLanguageError("Assignment value is empty", item.line);
      statements.push({ type: "assignment", name: assignment[1], expression: assignment[2], line: item.line });
      index++;
      continue;
    }

    if (item.text === "break" || item.text === "continue") {
      statements.push({ type: item.text, line: item.line });
      index++;
      continue;
    }

    const parsed = parseCommand(lines, index);
    statements.push(parsed[0]);
    index = parsed[1];
  }
  if (inBlock) return { statements, index, terminator: null };
  return { statements, index, terminator: null };
}

export function parseScriptProgram(content) {
  return parseBlock(meaningfulLines(content), 0).statements;
}

function tokenizeExpression(source, line) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    const rest = source.slice(i);
    const operator = rest.match(/^(?:&&|\|\||==|!=|<=|>=|[()+\-*/%<>])/);
    if (operator) {
      tokens.push({ type: "op", value: operator[0] });
      i += operator[0].length;
      continue;
    }
    if (source[i] === '"' || source[i] === "'") {
      const quote = source[i++];
      let value = "";
      let closed = false;
      while (i < source.length) {
        if (source[i] === quote) { i++; closed = true; break; }
        if (source[i] === "\\" && i + 1 < source.length) {
          const escaped = source[++i];
          value += escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped;
          i++;
        } else value += source[i++];
      }
      if (!closed) throw new ScriptLanguageError("Unclosed string literal", line);
      tokens.push({ type: "value", value });
      continue;
    }
    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (number) {
      tokens.push({ type: "value", value: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const name = rest.match(/^[A-Za-z_$][A-Za-z0-9_$.]*/);
    if (name) {
      tokens.push({ type: "name", value: name[0] });
      i += name[0].length;
      continue;
    }
    throw new ScriptLanguageError(`Unexpected character in expression: ${source[i]}`, line);
  }
  return tokens;
}

function numeric(value, operator, line) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && NUMBER_TEXT.test(value)) return Number(value);
  throw new ScriptLanguageError(`Operator ${operator} requires numeric operands`, line);
}

function externalValue(name, state, line) {
  const parts = name.split(".");
  if (parts.length !== 2 || !["process", "recorder", "Image"].includes(parts[0])) {
    throw new ScriptLanguageError(`Undefined variable: ${name}`, line);
  }
  const group = state?.[parts[0]];
  if (!group || !Object.prototype.hasOwnProperty.call(group, parts[1])) {
    throw new ScriptLanguageError(`State value is not available: ${name}`, line);
  }
  return group[parts[1]];
}

function normalizeExpression(source) {
  return source.replace(/#\{([^{}]+)\}/g, "$1");
}

function evaluateExpressionInternal(source, environment, state, line, syntaxOnly) {
  const tokens = tokenizeExpression(normalizeExpression(source), line);
  let position = 0;
  const peek = (value) => tokens[position]?.value === value;
  const take = () => tokens[position++];

  const primary = (active = true) => {
    if (peek("(")) {
      take();
      const value = logicalOr(active);
      if (!peek(")")) throw new ScriptLanguageError("Missing closing parenthesis", line);
      take();
      return value;
    }
    const token = take();
    if (!token) throw new ScriptLanguageError("Expected expression", line);
    if (token.type === "value") return active ? token.value : 0;
    if (token.type === "name") {
      if (!active) return 0;
      if (token.value.includes(".")) return externalValue(token.value, state, line);
      return environment.get(token.value, line);
    }
    throw new ScriptLanguageError(`Unexpected token: ${token.value}`, line);
  };
  const unary = (active = true) => {
    if (peek("-")) {
      take();
      const value = unary(active);
      return active ? -numeric(value, "-", line) : 0;
    }
    return primary(active);
  };
  const multiplicative = (active = true) => {
    let left = unary(active);
    while (peek("*") || peek("/") || peek("%")) {
      const op = take().value;
      const right = unary(active);
      if (!active) { left = 0; continue; }
      const a = numeric(left, op, line);
      const b = numeric(right, op, line);
      if ((op === "/" || op === "%") && b === 0) throw new ScriptLanguageError("Division by zero", line);
      left = op === "*" ? a * b : op === "/" ? a / b : a % b;
    }
    return left;
  };
  const additive = (active = true) => {
    let left = multiplicative(active);
    while (peek("+") || peek("-")) {
      const op = take().value;
      const right = multiplicative(active);
      if (!active) { left = 0; continue; }
      const a = numeric(left, op, line);
      const b = numeric(right, op, line);
      left = op === "+" ? a + b : a - b;
    }
    return left;
  };
  const relational = (active = true) => {
    let left = additive(active);
    while (peek("<") || peek("<=") || peek(">") || peek(">=")) {
      const op = take().value;
      const right = additive(active);
      if (!active) { left = false; continue; }
      const numericComparison =
        (typeof left === "number" || (typeof left === "string" && NUMBER_TEXT.test(left))) &&
        (typeof right === "number" || (typeof right === "string" && NUMBER_TEXT.test(right)));
      const a = numericComparison ? Number(left) : String(left);
      const b = numericComparison ? Number(right) : String(right);
      left = op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b;
    }
    return left;
  };
  const equality = (active = true) => {
    let left = relational(active);
    while (peek("==") || peek("!=")) {
      const op = take().value;
      const right = relational(active);
      if (!active) { left = false; continue; }
      left = op === "==" ? String(left) === String(right) : String(left) !== String(right);
    }
    return left;
  };
  const logicalAnd = (active = true) => {
    let left = equality(active);
    while (peek("&&")) {
      take();
      const evaluateRight = active && truthy(left);
      const right = equality(evaluateRight);
      left = active ? truthy(left) && truthy(right) : false;
    }
    return left;
  };
  const logicalOr = (active = true) => {
    let left = logicalAnd(active);
    while (peek("||")) {
      take();
      const evaluateRight = active && !truthy(left);
      const right = logicalAnd(evaluateRight);
      left = active ? truthy(left) || truthy(right) : false;
    }
    return left;
  };

  const value = logicalOr(!syntaxOnly);
  if (position !== tokens.length) throw new ScriptLanguageError(`Unexpected token: ${tokens[position].value}`, line);
  return value;
}

export function evaluateExpression(source, environment, state = {}, line) {
  return evaluateExpressionInternal(source, environment, state, line, false);
}

function truthy(value) {
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string" && NUMBER_TEXT.test(value)) return Number(value) !== 0;
  return Boolean(value);
}

export function interpolate(text, environment, state, line) {
  return text.replace(/#\{([^{}]+)\}/g, (_match, expression) =>
    String(evaluateExpression(expression, environment, state, line)));
}

function validateInterpolations(text, line) {
  let position = 0;
  while ((position = text.indexOf("#{", position)) >= 0) {
    const end = text.indexOf("}", position + 2);
    if (end < 0) throw new ScriptLanguageError("Unclosed interpolation", line);
    const expression = text.slice(position + 2, end);
    if (!expression || /[{}]/.test(expression)) {
      throw new ScriptLanguageError("Invalid interpolation", line);
    }
    evaluateExpressionInternal(expression, null, {}, line, true);
    position = end + 1;
  }
}

function validateAssignedExpression(source, line) {
  const exactInterpolation = source.match(/^#\{([^{}]+)\}$/);
  if (exactInterpolation) {
    evaluateExpressionInternal(exactInterpolation[1], null, {}, line, true);
  } else if (source.includes("#{")) {
    validateInterpolations(source, line);
  } else if (!IDENTIFIER.test(source)) {
    evaluateExpressionInternal(source, null, {}, line, true);
  }
}

export function validateScriptProgram(program) {
  const validateBlock = (statements, loopDepth = 0) => {
    for (const statement of statements) {
      if (statement.type === "declaration" || statement.type === "assignment") {
        validateAssignedExpression(statement.expression, statement.line);
      } else if (statement.type === "command") {
        validateInterpolations(statement.step.event, statement.line);
        statement.step.args.forEach((arg) => validateInterpolations(String(arg), statement.line));
        if (statement.step.expectedAck !== null) {
          validateInterpolations(statement.step.expectedAck, statement.line);
        }
      } else if (statement.type === "if" || statement.type === "while") {
        evaluateExpressionInternal(statement.condition, null, {}, statement.line, true);
        validateBlock(statement.body, loopDepth + (statement.type === "while" ? 1 : 0));
        if (statement.alternate) validateBlock(statement.alternate, loopDepth);
      } else if (statement.type === "wait") {
        evaluateExpressionInternal(statement.expression, null, {}, statement.line, true);
      } else if (statement.type === "file") {
        evaluateExpressionInternal(statement.condition, null, {}, statement.line, true);
        validateInterpolations(statement.pattern, statement.line);
      } else if (statement.type === "load") {
        if (statement.scriptPath.includes("#{")) {
          throw new ScriptLanguageError("load script path must be a literal path", statement.line);
        }
        statement.parameters.forEach(({ value }) => validateInterpolations(value, statement.line));
      } else if (statement.type === "block") {
        validateBlock(statement.body, loopDepth);
      } else if ((statement.type === "break" || statement.type === "continue") && loopDepth === 0) {
        throw new ScriptLanguageError(`${statement.type} is only valid inside while`, statement.line);
      }
    }
  };
  validateBlock(program);
}

function evaluateAssignedValue(source, environment, state, line) {
  const exactInterpolation = source.match(/^#\{([^{}]+)\}$/);
  if (exactInterpolation) {
    return evaluateExpression(exactInterpolation[1], environment, state, line);
  }
  if (source.includes("#{")) {
    return interpolate(source, environment, state, line);
  }
  if (IDENTIFIER.test(source) && !environment.resolve(source)) {
    return source;
  }
  return evaluateExpression(source, environment, state, line);
}

function conditionValues(loopContexts, environment, state) {
  const values = new Map();
  for (const context of loopContexts) {
    const tokens = tokenizeExpression(normalizeExpression(context.condition), context.line);
    for (const token of tokens) {
      if (token.type !== "name" || values.has(token.value)) continue;
      const value = token.value.includes(".")
        ? externalValue(token.value, state, context.line)
        : environment.get(token.value, context.line);
      values.set(token.value, value);
    }
  }
  return [...values].map(([name, value]) => ({
    name,
    value: typeof value === "object" ? JSON.stringify(value) : String(value),
  }));
}

function commandDisplayLabel(line, loopValues) {
  const variables = loopValues
    .map(({ name, value }) => `${name}=${value}`)
    .join(",");
  return `[Line=${line}${variables ? `(${variables})` : ""}.]`;
}

export async function executeScriptProgram(program, {
  state = {},
  executeCommand,
  scheduleFileCheck,
  executeLoad,
  initialVariables = {},
  maxLoopIterations = 100000,
} = {}) {
  const root = new Environment();
  for (const [name, value] of Object.entries(initialVariables)) {
    root.declare(name, value, "let");
  }
  let stepsExecuted = 0;

  const executeBlock = async (statements, environment, loopDepth, loopContexts = []) => {
    for (const statement of statements) {
      if (statement.type === "declaration") {
        environment.declare(
          statement.name,
          evaluateAssignedValue(statement.expression, environment, state, statement.line),
          statement.kind,
          statement.line,
        );
      } else if (statement.type === "assignment") {
        environment.assign(
          statement.name,
          evaluateAssignedValue(statement.expression, environment, state, statement.line),
          statement.line,
        );
      } else if (statement.type === "command") {
        const step = {
          ...statement.step,
          event: interpolate(statement.step.event, environment, state, statement.line),
          args: statement.step.args.map((arg) => interpolate(String(arg), environment, state, statement.line)),
          expectedAck: statement.step.expectedAck === null
            ? null
            : interpolate(statement.step.expectedAck, environment, state, statement.line),
        };
        step.displayLabel = commandDisplayLabel(
          statement.line,
          conditionValues(loopContexts, environment, state),
        );
        stepsExecuted++;
        await executeCommand(step, stepsExecuted, statement.line);
      } else if (statement.type === "if") {
        const selected = truthy(evaluateExpression(statement.condition, environment, state, statement.line))
          ? statement.body : (statement.alternate ?? []);
        const signal = await executeBlock(selected, environment.child(), loopDepth, loopContexts);
        if (signal) return signal;
      } else if (statement.type === "while") {
        let iterations = 0;
        while (truthy(evaluateExpression(statement.condition, environment, state, statement.line))) {
          if (++iterations > maxLoopIterations) {
            throw new ScriptLanguageError(`while exceeded ${maxLoopIterations} iterations`, statement.line);
          }
          const signal = await executeBlock(
            statement.body,
            environment.child(),
            loopDepth + 1,
            [...loopContexts, { condition: statement.condition, line: statement.line }],
          );
          if (signal === "break") break;
          if (signal === "continue") continue;
        }
      } else if (statement.type === "wait") {
        const duration = numeric(
          evaluateExpression(statement.expression, environment, state, statement.line),
          "wait",
          statement.line,
        );
        if (!Number.isFinite(duration) || duration < 0) {
          throw new ScriptLanguageError("wait duration must be a non-negative number", statement.line);
        }
        await new Promise((resolve) => setTimeout(resolve, duration));
      } else if (statement.type === "file") {
        if (truthy(evaluateExpression(statement.condition, environment, state, statement.line))) {
          if (typeof scheduleFileCheck !== "function") {
            throw new ScriptLanguageError("FILE checks are not configured", statement.line);
          }
          const pattern = interpolate(statement.pattern, environment, state, statement.line);
          scheduleFileCheck(pattern, statement.line);
        }
      } else if (statement.type === "load") {
        if (typeof executeLoad !== "function") {
          throw new ScriptLanguageError("load is not configured", statement.line);
        }
        const parameters = Object.fromEntries(statement.parameters.map(({ name, value }) => [
          name,
          interpolate(value, environment, state, statement.line),
        ]));
        await executeLoad(statement.scriptPath, parameters, statement.line);
      } else if (statement.type === "block") {
        const signal = await executeBlock(statement.body, environment.child(), loopDepth, loopContexts);
        if (signal) return signal;
      } else if (statement.type === "break" || statement.type === "continue") {
        if (loopDepth === 0) {
          throw new ScriptLanguageError(`${statement.type} is only valid inside while`, statement.line);
        }
        return statement.type;
      }
    }
    return null;
  };

  await executeBlock(program, root, 0);
  return { stepsExecuted };
}

export function isIdentifier(name) {
  return IDENTIFIER.test(name);
}
