import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  fg,
  t,
} from "@opentui/core";

const MAX_LOG_LINES = 5000;

/** @param {string} text */
function splitArgs(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** @param {string[]} strings */
function commonPrefix(strings) {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (const s of strings.slice(1)) {
    while (!s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  return prefix;
}

class PlainLogPanel {
  /**
   * @param {import('@opentui/core').RenderContext} renderer
   * @param {string} title
   */
  constructor(renderer, title) {
    /** @type {string[]} */
    this.lines = [];

    this.scrollbox = new ScrollBoxRenderable(renderer, {
      id: `panel-${title}`,
      flexGrow: 1,
      width: "33%",
      height: "100%",
      stickyScroll: true,
      stickyStart: "bottom",
      border: true,
      borderStyle: "single",
      borderColor: "#565f89",
      title,
      titleColor: "#7aa2f7",
      viewportOptions: { backgroundColor: "#1a1b26" },
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: "#7aa2f7",
          backgroundColor: "#414868",
        },
      },
    });

    this.text = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      fg: "#c0caf5",
      selectable: true,
    });

    this.scrollbox.add(this.text);
  }

  /** @param {string} line */
  append(line) {
    this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) {
      this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
    }
    this.text.content = this.lines.join("\n");
  }

  clear() {
    this.lines = [];
    this.text.content = "";
  }
}

class ColoredLogPanel {
  /**
   * @param {import('@opentui/core').RenderContext} renderer
   * @param {string} title
   */
  constructor(renderer, title) {
    /** @type {{ text: string, color: string }[]} */
    this.entries = [];

    this.scrollbox = new ScrollBoxRenderable(renderer, {
      id: `panel-${title}`,
      flexGrow: 1,
      width: "33%",
      height: "100%",
      stickyScroll: true,
      stickyStart: "bottom",
      border: true,
      borderStyle: "single",
      borderColor: "#565f89",
      title,
      titleColor: "#9ece6a",
      viewportOptions: { backgroundColor: "#1a1b26" },
      scrollbarOptions: {
        trackOptions: {
          foregroundColor: "#9ece6a",
          backgroundColor: "#414868",
        },
      },
    });

    this.text = new TextRenderable(renderer, {
      content: "",
      width: "100%",
      selectable: true,
    });

    this.scrollbox.add(this.text);
  }

  /** @param {string} text @param {string} [color='#FFFFFF'] */
  append(text, color = "#FFFFFF") {
    this.entries.push({ text, color });
    if (this.entries.length > MAX_LOG_LINES) {
      this.entries.splice(0, this.entries.length - MAX_LOG_LINES);
    }
    this.#refresh();
  }

  clear() {
    this.entries = [];
    this.text.content = "";
  }

  #refresh() {
    /** @type {import('@opentui/core/lib/styled-text.js').TextChunk[]} */
    const chunks = [];
    for (let i = 0; i < this.entries.length; i++) {
      const { text, color } = this.entries[i];
      chunks.push(fg(color)(text));
      if (i < this.entries.length - 1) {
        chunks.push({ __isChunk: true, text: "\n" });
      }
    }
    this.text.content = new StyledText(chunks);
  }
}

export class CliMonitor {
  /**
   * @param {object} [options]
   * @param {(commandText: string, args: string[]) => void|Promise<void>} [options.onCommandExecute]
   * @param {(args: string[]) => string|string[]|null|Promise<string|string[]|null>} [options.onTabComplete]
   */
  constructor(options = {}) {
    this.onCommandExecute = options.onCommandExecute ?? (() => {});
    this.onTabComplete = options.onTabComplete ?? (() => null);

    /** @type {import('@opentui/core').CliRenderer | null} */
    this.renderer = null;

    /** @type {string[]} */
    this.commandHistory = [];
    this.historyIndex = -1;
    this.draftBeforeHistory = "";

    /** @type {PlainLogPanel | null} */
    this.panelA = null;
    /** @type {PlainLogPanel | null} */
    this.panelB = null;
    /** @type {ColoredLogPanel | null} */
    this.panelC = null;

    /** @type {TextRenderable | null} */
    this.statusText = null;
    /** @type {TextareaRenderable | null} */
    this.commandInput = null;

    /** @type {typeof console.log | null} */
    this._originalConsoleLog = null;
  }

  /**
   * 3-1 ステータス行へ色付き文字列を表示
   * @param {string} text
   * @param {string} [color='#00FF00']
   */
  setStatus(text, color = "#00FF00") {
    if (!this.statusText) return;
    this.statusText.content = t`${fg(color)(text)}`;
  }

  /**
   * 3-4 パネルCへ色付き文字列を出力
   * @param {string} text
   * @param {string} [color='#FFFFFF']
   */
  writePanelC(text, color = "#FFFFFF") {
    this.panelC?.append(text, color);
  }

  /** パネルBへ文字列を追加（socket.io 受信用） */
  appendPanelB(text) {
    this.panelB?.append(text);
  }

  clearPanelA() {
    this.panelA?.clear();
  }

  clearPanelB() {
    this.panelB?.clear();
  }

  clearPanelC() {
    this.panelC?.clear();
  }

  clearAllPanels() {
    this.clearPanelA();
    this.clearPanelB();
    this.clearPanelC();
  }

  async start() {
    this.renderer = await createCliRenderer({
      exitOnCtrlC: true,
      targetFps: 30,
    });

    this.#buildLayout();
    this.#hookConsoleLog();
    this.commandInput?.focus();
  }

  destroy() {
    this.#unhookConsoleLog();
    this.renderer?.destroy();
    this.renderer = null;
  }

  #buildLayout() {
    if (!this.renderer) return;

    const container = new BoxRenderable(this.renderer, {
      id: "root-container",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: "#16161e",
    });

    const statusBar = new BoxRenderable(this.renderer, {
      id: "status-bar",
      width: "100%",
      height: 1,
      backgroundColor: "#24283b",
      paddingLeft: 1,
    });

    this.statusText = new TextRenderable(this.renderer, {
      id: "status-text",
      content: t`${fg("#9ece6a")("Ready")}`,
    });
    statusBar.add(this.statusText);

    const mainRow = new BoxRenderable(this.renderer, {
      id: "main-row",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 0,
    });

    this.panelA = new PlainLogPanel(this.renderer, "A: console.log");
    this.panelB = new PlainLogPanel(this.renderer, "B: socket.io");
    this.panelC = new ColoredLogPanel(this.renderer, "C: info");

    mainRow.add(this.panelA.scrollbox);
    mainRow.add(this.panelB.scrollbox);
    mainRow.add(this.panelC.scrollbox);

    this.commandInput = new TextareaRenderable(this.renderer, {
      id: "command-input",
      width: "100%",
      height: 3,
      placeholder: "コマンドを入力... [Enter: 実行] [Shift+Enter: 改行] [Tab: 補完] [↑↓: 履歴]",
      placeholderColor: "#565f89",
      backgroundColor: "#1a1b26",
      focusedBackgroundColor: "#24283b",
      textColor: "#c0caf5",
      focusedTextColor: "#ffffff",
      cursorColor: "#7aa2f7",
      wrapMode: "char",
      keyBindings: [
        { name: "return", action: "submit" },
        { name: "linefeed", action: "submit" },
        { name: "kpenter", action: "submit" },
        { name: "return", shift: true, action: "newline" },
        { name: "linefeed", shift: true, action: "newline" },
        { name: "kpenter", shift: true, action: "newline" },
      ],
      onSubmit: () => {
        void this.#handleCommandSubmit();
      },
    });

    this.commandInput.onKeyDown = (key) => {
      if (key.name === "tab") {
        key.preventDefault();
        void this.#handleTab();
        return;
      }
      if (key.name === "up") {
        key.preventDefault();
        this.#handleHistoryUp();
        return;
      }
      if (key.name === "down") {
        key.preventDefault();
        this.#handleHistoryDown();
      }
    };

    container.add(statusBar);
    container.add(mainRow);
    container.add(this.commandInput);
    this.renderer.root.add(container);
  }

  async #handleCommandSubmit() {
    if (!this.commandInput) return;

    const commandText = this.commandInput.plainText;
    const trimmed = commandText.trim();

    if (trimmed) {
      this.commandHistory.push(trimmed);
      this.historyIndex = -1;
      this.draftBeforeHistory = "";
    }

    const args = splitArgs(trimmed);
    await this.onCommandExecute(commandText, args);
    this.commandInput.setText("");
  }

  async #handleTab() {
    if (!this.commandInput) return;

    const text = this.commandInput.plainText;
    const args = splitArgs(text);
    const result = await this.onTabComplete(args);

    if (result == null) return;

    if (Array.isArray(result)) {
      if (result.length === 0) return;
      if (result.length === 1) {
        this.#applyCompletion(result[0], text);
        return;
      }

      const prefix = commonPrefix(result);
      const lastArg = args.at(-1) ?? "";
      if (prefix.length > lastArg.length) {
        this.#applyCompletion(prefix, text);
      } else {
        this.writePanelC(`補完候補: ${result.join("  ")}`, "#e0af68");
      }
      return;
    }

    this.#applyCompletion(result, text);
  }

  /** @param {string} completion @param {string} currentText */
  #applyCompletion(completion, currentText) {
    if (!this.commandInput) return;

    const trimmed = currentText.trimEnd();
    if (!trimmed) {
      this.commandInput.setText(`${completion} `);
      return;
    }

    const lastSpace = trimmed.lastIndexOf(" ");
    if (lastSpace === -1) {
      this.commandInput.setText(`${completion} `);
      return;
    }

    this.commandInput.setText(`${trimmed.slice(0, lastSpace + 1)}${completion} `);
  }

  #handleHistoryUp() {
    if (!this.commandInput || this.commandHistory.length === 0) return;

    if (this.historyIndex === -1) {
      this.draftBeforeHistory = this.commandInput.plainText;
      this.historyIndex = this.commandHistory.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    }

    this.commandInput.setText(this.commandHistory[this.historyIndex] ?? "");
  }

  #handleHistoryDown() {
    if (!this.commandInput || this.historyIndex === -1) return;

    if (this.historyIndex < this.commandHistory.length - 1) {
      this.historyIndex++;
      this.commandInput.setText(this.commandHistory[this.historyIndex] ?? "");
    } else {
      this.historyIndex = -1;
      this.commandInput.setText(this.draftBeforeHistory);
    }
  }

  #hookConsoleLog() {
    this._originalConsoleLog = console.log.bind(console);
    console.log = (...args) => {
      const line = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ");
      this.panelA?.append(line);
    };
  }

  #unhookConsoleLog() {
    if (this._originalConsoleLog) {
      console.log = this._originalConsoleLog;
      this._originalConsoleLog = null;
    }
  }
}
