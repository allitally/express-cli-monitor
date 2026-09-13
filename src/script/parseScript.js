/**
 * Parse one script line:
 *   <socket-message> [<arg1> [<arg2> ...]]
 * Double-quoted tokens may contain spaces.
 *
 * @param {string} line
 * @returns {{ event: string, args: string[] }}
 */
export function parseScriptLine(line) {
  const tokens = [];
  let i = 0;

  while (i < line.length && /\s/.test(line[i])) {
    i++;
  }

  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let token = "";
      while (i < line.length && line[i] !== '"') {
        token += line[i];
        i++;
      }
      if (i >= line.length || line[i] !== '"') {
        throw new Error(`Unclosed quote in line: ${line}`);
      }
      i++;
      tokens.push(token);
    } else {
      let token = "";
      while (i < line.length && !/\s/.test(line[i])) {
        token += line[i];
        i++;
      }
      if (token.length > 0) {
        tokens.push(token);
      }
    }

    while (i < line.length && /\s/.test(line[i])) {
      i++;
    }
  }

  if (tokens.length === 0) {
    throw new Error(`Empty script line: ${line}`);
  }

  return {
    event: tokens[0],
    args: tokens.slice(1),
  };
}

/**
 * @typedef {{ event: string, args: string[], ackMode: 'ack' | 'pass' | null, expectedAck: string | null }} ScriptStep
 */

/**
 * @param {string} content
 * @returns {ScriptStep[]}
 */
export function parseScriptContent(content) {
  const rawLines = content.split(/\r?\n/);
  /** @type {ScriptStep[]} */
  const steps = [];

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const rawLine = rawLines[lineIndex];
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("Ack:") || line.startsWith("Pass:")) {
      throw new Error(
        `Line ${lineIndex + 1}: Ack:/Pass: must follow a socket message line`,
      );
    }

    const { event, args } = parseScriptLine(line);
    let ackMode = null;
    let expectedAck = null;

    const nextIndex = lineIndex + 1;
    if (nextIndex < rawLines.length) {
      const nextLine = rawLines[nextIndex].trim();
      if (nextLine.startsWith("Ack:")) {
        ackMode = "ack";
        expectedAck = nextLine.slice("Ack:".length).trim();
        lineIndex = nextIndex;
      } else if (nextLine.startsWith("Pass:")) {
        ackMode = "pass";
        lineIndex = nextIndex;
      }
    }

    steps.push({ event, args, ackMode, expectedAck });
  }

  return steps;
}
