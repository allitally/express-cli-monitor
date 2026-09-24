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

  // 対応形式:
  //   Ack:
  //   Ack(to=1000):
  const ackPattern = /^Ack(?:\(to=(\d+)\))?:(.*)$/;

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const rawLine = rawLines[lineIndex];
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    // Ack系またはPass:が単独で現れた場合
    if (line.startsWith("Ack") || line.startsWith("Pass:")) {
      throw new Error(
        `Line ${lineIndex + 1}: Ack:/Pass: must follow a socket message line`,
      );
    }

    const { event, args } = parseScriptLine(line);

    let ackMode = null;
    let expectedAck = null;
    let timeOut;

    const nextIndex = lineIndex + 1;

    if (nextIndex < rawLines.length) {
      const nextLine = rawLines[nextIndex].trim();
      const ackMatch = nextLine.match(ackPattern);

      if (ackMatch) {
        ackMode = "ack";

        // (\d+)に一致したタイムアウト値
        if (ackMatch[1] !== undefined) {
          timeOut = Number(ackMatch[1]);

          if (!Number.isSafeInteger(timeOut) || timeOut <= 0) {
            throw new Error(
              `Line ${nextIndex + 1}: ACK timeout must be a positive integer`,
            );
          }
        }

        // コロンより後ろがACKの期待値
        expectedAck = ackMatch[2].trim();
        lineIndex = nextIndex;
      } else if (nextLine.startsWith("Ack")) {
        // Ackのように見えるが書式が正しくない
        throw new Error(
          `Line ${nextIndex + 1}: invalid Ack syntax`,
        );
      } else if (nextLine.startsWith("Pass:")) {
        ackMode = "pass";
        lineIndex = nextIndex;
      }
    }

    steps.push({
      event,
      args,
      ackMode,
      expectedAck,
      ...(timeOut !== undefined && { timeOut }),
    });
  }

  return steps;
}
/**
 * @typedef {Object} ScriptStep
 * @property {string} event 実行するスクリプトのイベント名
 * @property {unknown[]} args 実行するスクリプトの引数
 * @property {"ack" | "pass" | null} ackMode
 * @property {string | null} expectedAck
 * @property {number} [timeOut] ACKタイムアウト時間（ミリ秒）
 *
 * @property {string} [onEvent]
 *   このイベントを受信したときに実行する
 *
 * @property {RegExp} [firstArgPattern]
 *   受信イベントの第1引数に適用する正規表現
 */

/**
 * On行を解析する。
 *
 * 対応書式:
 *   On.send_message: <スクリプト表現>
 *   On.send_message=='^start_text:(.*)': <スクリプト表現>
 *
 * @param {string} line
 * @param {number} lineNumber
 * @returns {{
 *   scriptExpression: string,
 *   onEvent: string,
 *   firstArgPattern?: RegExp
 * }}
 */
function parseOnLine(line, lineNumber) {
  /*
   * グループ1: 受信イベント名
   * グループ2: 正規表現文字列（指定されている場合）
   * グループ3: 実行するスクリプト表現
   *
   * 正規表現内に「:」があっても、引用符内なので問題ありません。
   */
  const onPattern =
    /^On\.([A-Za-z_$][A-Za-z0-9_$.-]*)(?:\s*==\s*'((?:\\.|[^'])*)')?\s*:\s*(.+)$/;

  const match = line.match(onPattern);

  if (!match) {
    throw new Error(
      `Line ${lineNumber}: invalid On syntax`,
    );
  }

  const onEvent = match[1];
  const patternText = match[2];
  const scriptExpression = match[3].trim();

  if (scriptExpression.length === 0) {
    throw new Error(
      `Line ${lineNumber}: script expression after On condition is empty`,
    );
  }

  /** @type {RegExp | undefined} */
  let firstArgPattern;

  if (patternText !== undefined) {
    try {
      firstArgPattern = new RegExp(patternText);
    } catch (error) {
      throw new Error(
        `Line ${lineNumber}: invalid regular expression: ${error.message}`,
      );
    }
  }

  return {
    onEvent,
    scriptExpression,
    ...(firstArgPattern !== undefined && { firstArgPattern }),
  };
}

/**
 * @param {string} content
 * @returns {ScriptStep[]}
 */
export function parseScriptContent(content) {
  const rawLines = content.split(/\r?\n/);

  /** @type {ScriptStep[]} */
  const steps = [];

  // 対応形式:
  //   Ack:
  //   Ack(to=1000):
  const ackPattern = /^Ack(?:\(to=(\d+)\))?:(.*)$/;

  for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex++) {
    const line = rawLines[lineIndex].trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    /*
     * Ack:/Ack(to=...):/Pass: は、必ず通常行またはOn行の
     * 次の行でなければならない。
     */
    if (
      line.startsWith("Ack") ||
      line.startsWith("Pass:")
    ) {
      throw new Error(
        `Line ${lineIndex + 1}: Ack:/Pass: must follow a script line`,
      );
    }

    let scriptExpression = line;

    /** @type {string | undefined} */
    let onEvent;

    /** @type {RegExp | undefined} */
    let firstArgPattern;

    /*
     * On行なら、条件部分と実行スクリプト部分に分解する。
     */
    if (line.startsWith("On.")) {
      const onInfo = parseOnLine(line, lineIndex + 1);

      scriptExpression = onInfo.scriptExpression;
      onEvent = onInfo.onEvent;
      firstArgPattern = onInfo.firstArgPattern;
    }


      /*
     * 通常行の場合はline全体、
     * On行の場合は「:」の右側を解析する。
     */
    const { event, args } = parseScriptLine(scriptExpression);

    /** @type {"ack" | "pass" | null} */
    let ackMode = null;

    /** @type {string | null} */
    let expectedAck = null;

    /** @type {number | undefined} */
    let timeOut;

    const nextIndex = lineIndex + 1;

    if (nextIndex < rawLines.length) {
      const nextLine = rawLines[nextIndex].trim();
      const ackMatch = nextLine.match(ackPattern);

      if (ackMatch) {
        ackMode = "ack";

        if (ackMatch[1] !== undefined) {
          timeOut = Number(ackMatch[1]);

          if (!Number.isSafeInteger(timeOut) || timeOut <= 0) {
            throw new Error(
              `Line ${nextIndex + 1}: ACK timeout must be a positive integer`,
            );
          }
        }

        expectedAck = ackMatch[2].trim();
        lineIndex = nextIndex;
      } else if (nextLine.startsWith("Ack")) {
        throw new Error(
          `Line ${nextIndex + 1}: invalid Ack syntax`,
        );
      } else if (nextLine.startsWith("Pass:")) {
        ackMode = "pass";
        lineIndex = nextIndex;
      }
    }

    steps.push({
      event,
      args,
      ackMode,
      expectedAck,
      ...(timeOut !== undefined && { timeOut }),
      ...(onEvent !== undefined && { onEvent }),
      ...(firstArgPattern !== undefined && { firstArgPattern }),
    });
  }

  return steps;
}
