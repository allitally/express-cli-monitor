/**
 * Parse one script line:
 *   <socket-message> [<arg1> [<arg2> ...]]
 * Double-quoted tokens may contain spaces.
 *
 * @param {string} line
 * @returns {{ event: string, args: string[] }}
 */
/**
 * スクリプト1行を解析する。
 *
 * 書式:
 *   <event> [<arg1> [<arg2> ...]]
 *
 * ダブルクォート内では次のエスケープを解釈する。
 *
 *   \"  → "
 *   \\  → \
 *   \n  → 改行
 *   \r  → CR
 *   \t  → タブ
 *
 * それ以外のエスケープはバックスラッシュを維持する。
 * 例:
 *   \x01 → \x01
 *
 * @param {string} line
 * @returns {{ event: string, args: string[] }}
 */
export function parseScriptLine(line) {
  /** @type {string[]} */
  const tokens = [];

  let i = 0;

  const skipSpaces = () => {
    while (
      i < line.length &&
      /\s/.test(line[i])
    ) {
      i++;
    }
  };

  skipSpaces();

  while (i < line.length) {
    let token = "";

    if (line[i] === '"') {
      // 開始ダブルクォートを読み飛ばす
      i++;

      let closed = false;

      while (i < line.length) {
        const ch = line[i];

        if (ch === '"') {
          // エスケープされていないダブルクォートで終了
          i++;
          closed = true;
          break;
        }

        if (ch === "\\") {
          if (i + 1 >= line.length) {
            throw new Error(
              `Trailing backslash in quoted argument: ${line}`,
            );
          }

          const escaped = line[i + 1];

          switch (escaped) {
            case '"':
              token += '"';
              break;

            case "\\":
              token += "\\";
              break;

            case "n":
              token += "\n";
              break;

            case "r":
              token += "\r";
              break;

            case "t":
              token += "\t";
              break;

            default:
              /*
               * \x01など、このパーサー自身が解釈しない
               * エスケープはバックスラッシュごと保持する。
               */
              token += `\\${escaped}`;
              break;
          }

          i += 2;
          continue;
        }

        token += ch;
        i++;
      }

      if (!closed) {
        throw new Error(
          `Unclosed quote in line: ${line}`,
        );
      }

      /*
       * 終端クォートの直後は、空白または行末でなければ
       * 書式エラーとする。
       */
      if (
        i < line.length &&
        !/\s/.test(line[i])
      ) {
        throw new Error(
          `Unexpected character after closing quote ` +
          `at position ${i + 1}: ${line}`,
        );
      }
    } else {
      /*
       * クォートされていない引数。
       */
      while (
        i < line.length &&
        !/\s/.test(line[i])
      ) {
        if (line[i] === '"') {
          throw new Error(
            `Unexpected quote in unquoted argument ` +
            `at position ${i + 1}: ${line}`,
          );
        }

        token += line[i];
        i++;
      }
    }

    /*
     * ""も空文字列引数として格納する必要があるため、
     * token.lengthによる除外は行わない。
     */
    tokens.push(token);

    skipSpaces();
  }

  if (tokens.length === 0) {
    throw new Error(
      `Empty script line: ${line}`,
    );
  }

  return {
    event: tokens[0],
    args: tokens.slice(1),
  };
}
// export function parseScriptLine(line) {
//   const tokens = [];
//   let i = 0;

//   while (i < line.length && /\s/.test(line[i])) {
//     i++;
//   }

//   while (i < line.length) {
//     if (line[i] === '"') {
//       i++;
//       let token = "";
//       while (i < line.length && line[i] !== '"') {
//         token += line[i];
//         i++;
//       }
//       if (i >= line.length || line[i] !== '"') {
//         throw new Error(`Unclosed quote in line: ${line}`);
//       }
//       i++;
//       tokens.push(token);
//     } else {
//       let token = "";
//       while (i < line.length && !/\s/.test(line[i])) {
//         token += line[i];
//         i++;
//       }
//       if (token.length > 0) {
//         tokens.push(token);
//       }
//     }

//     while (i < line.length && /\s/.test(line[i])) {
//       i++;
//     }
//   }

//   if (tokens.length === 0) {
//     throw new Error(`Empty script line: ${line}`);
//   }

//   return {
//     event: tokens[0],
//     args: tokens.slice(1),
//   };
// }

/**
 * @typedef {Object} ScriptStep
 * @property {string} event 送信するイベント名
 * @property {unknown[]} args 送信する引数
 * @property {"ack" | "pass" | null} ackMode
 * @property {string | null} expectedAck
 * @property {number} [timeOut]
 *
 * @property {string} [onEvent] 待ち受けるイベント名
 * @property {RegExp} [firstArgPattern]
 *
 * @property {Promise<unknown>} [completionPromise]
 *   このstepのACK完了を待つPromise
 *
 * @property {(value: unknown) => void} [resolveCompletion]
 *   ACK受信時に呼ぶ関数
 *
 * @property {(reason?: unknown) => void} [rejectCompletion]
 *   タイムアウトなどの失敗時に呼ぶ関数
 *
 * @property {boolean} [running]
 *   同じ条件が連続して成立したときの多重実行防止
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
 * on(メッセージイベント)による送信コマンドの
 * Ackを待って次のスクリプト行を実行する仕組み
 * 
 * 外部からresolve/rejectできるPromiseを生成する。
 *
 * @template T
 * @returns {{
 *   promise: Promise<T>,
 *   resolve: (value: T) => void,
 *   reject: (reason?: unknown) => void
 * }}
 */
export function createDeferred() {
  let resolve;
  let reject;

  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    resolve,
    reject,
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
            // いきなりAck/Passはエラー
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
      /** @type {ScriptStep} **/
      const step = {
          event,
          args,
          ackMode,
          expectedAck,
          ...(timeOut !== undefined && { timeOut }),
          ...(onEvent !== undefined && { onEvent }),
          ...(firstArgPattern !== undefined && { firstArgPattern }),
      };
      if (step.onEvent !== undefined && step.ackMode === "ack") {
          const deferred = createDeferred();

          step.completionPromise = deferred.promise;
          step.resolveCompletion = deferred.resolve;
          step.rejectCompletion = deferred.reject;
          step.pre_registered = false;
          step.running = false;
      }

      steps.push(step);
    }

    return steps;
}
