import {
  BoxRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  createHostClipboard,
  fg,
  t,
} from "@opentui/core";
import { copyTextWithClip, countDumpLines, normalizeDumpText, resolveDumpFilePath, writeDumpFile } from "./dumpOutput.js";
import {
  DUMP_TARGETS,
  assignDumpKey,
  formatKeySpec,
  keyEventMatches,
  resolveDumpKeys,
} from "./keySpec.js";


const MAX_LOG_LINES = 5000;

/** @param {string} text */
function splitArgs(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** @param {string} text */
function unquote(text) {
  const trimmed = text.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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

  getPlainText() {
    return this.lines.join("\n");
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

  getPlainText() {
    return this.entries.map((entry) => entry.text).join("\n");
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
  /** @type {import('@opentui/core').HostClipboardService | null} */
  #hostClipboard = null;
  #hostClipboardFailed = false;
  /** @type {((key: import('@opentui/core').KeyEvent) => void) | null} */
  #onDumpKey = null;

  /**
   * @param {object} [options]
   * @param {(commandText: string, args: string[]) => void|Promise<void>} [options.onCommandExecute]
   * @param {(args: string[]) => string|string[]|null|Promise<string|string[]|null>} [options.onTabComplete]
   * @param {Partial<Record<"a"|"b"|"c"|"all", string|null>>} [options.dumpKeys]
   * @param {string|null} [options.dumpDir] 省略時は dumps。null ならショートカットではファイルを書かない
   * @param {boolean} [options.dumpToClipboard]
   */
  constructor(options = {}) {
    this.onCommandExecute = options.onCommandExecute ?? (() => {});
    this.onTabComplete = options.onTabComplete ?? (() => null);
    this.dumpDir = options.dumpDir === undefined ? "dumps" : options.dumpDir;
    this.dumpToClipboard = options.dumpToClipboard !== false;
    this.dumpKeys = resolveDumpKeys(options.dumpKeys ?? {});

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
    this.baseStatus = "";
  }

  /**
   * 3-1 ステータス行へ色付き文字列を表示
   * @param {string} text
   * @param {string} [color='#00FF00']
   */
  clearStatus(text, color = "#00FF00") {
    if (!this.statusText) return;
    this.statusText.content = "";
  }
  /**
   * 3-1 ステータス(Stage)行へ色付き文字列を表示
   * @param {string} text
   * @param {string} [color='#00FF00']
   */
  addStageStatus(text, color = "#00FF00") {
    if (!this.stageText) return;

    this.stageText.content =t`${fg(color)(text)}`;
  }
  /**
   * 3-1 ステータス(Record Status)行へ色付き文字列を表示
   * @param {string} text
   * @param {string} [color='#00FF00']
   */
  addStatus(text, color = "#00FF00") {
      if (!this.statusText) return;
      this.statusText.content =t`${fg(color)(text)}`;;
  }
    setStatus(text, color = "#00FF00") {
        this.baseStatus = text
        this.addStatus(text,color);
    }
  /**
   * 3-1 ステータス(Frame Status)行へ色付き文字列を表示
   * @param {string} text
   * @param {string} [color='#00FF00']
   */
  setFrameStatus(text, color = "#FFFF00") {
      if (!this.frameText) return;
      this.frameText.content =t`${fg(color)(text)}`;;
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
    this.#installDumpKeys();
    this.commandInput?.focus();
    this.writePanelC(
      `${this.describeDumpKeys()}  |  bind <a|b|c|all> <key>  dump <a|b|c|all> [file]`,
      "#bb9af7",
    );
  }

  destroy() {
    if (this.renderer && this.#onDumpKey) {
      this.renderer.keyInput.off("keypress", this.#onDumpKey);
    }
    this.#onDumpKey = null;
    const host = this.#hostClipboard;
    this.#hostClipboard = null;
    if (host) {
      void host.dispose().catch(() => {});
    }
    this.#unhookConsoleLog();
    this.renderer?.destroy();
    this.renderer = null;
  }
  setConsoleCommands(socket,cmd_interpreters){
        this.m_socket = socket;
    this.onCommandExecute = cmd_interpreters;
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
    const frameBar = new BoxRenderable(this.renderer, {
      id: "frame-bar",
      width: "100%",
      height: 1,
      backgroundColor: "#24283b",
      paddingLeft: 1,
    });

    this.frameText = new TextRenderable(this.renderer, {
      id: "frame-text",
      width: "100%",
      content: t`${fg("#d0ce00")("-")}`,
    });
    frameBar.add(this.frameText);
    this.statusText = new TextRenderable(this.renderer, {
      id: "status-text",
      width: "100%",
      content: t`${fg("#9ece6a")("-")}`,
    });
    statusBar.add(this.statusText);
    this.stageText = new TextRenderable(this.renderer, {
      id: "stage-text",
      width: "100%",
      content: t`${fg("#9ece6a")("Ready")}`,
    });
    const stageRow = new BoxRenderable(this.renderer, {
      id: "stage-row",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 0,
    });
    stageRow.add(this.stageText);
    //   mainRow.add(this.statusBar);
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

    container.add(frameBar);
    container.add(statusBar);
    container.add(stageRow);
    container.add(mainRow);
    container.add(this.commandInput);
    this.renderer.root.add(container);
    this.#refreshDumpChrome();
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
    const cmd = args[0]?.toLowerCase();
    if (cmd === "dump") {
      await this.#commandDump(trimmed);
      this.commandInput.setText("");
      return;
    }
    if (cmd === "bind") {
      this.#commandBind(trimmed);
      this.commandInput.setText("");
      return;
    }
    try {
//      await this.onCommandExecute(commandText, args,this.m_socket,"","",this);
      await this.onCommandExecute(commandText, args);
    } catch (err) {
      const message = `Error executing command: ${err instanceof Error ? err.message : String(err)}, ${commandText}`;
      console.error(message);
      this.writePanelC(message, "#f7768e");
    }
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

  describeDumpKeys() {
    const part = (id, label) => {
      const binding = this.dumpKeys[id];
      return `${label}:${binding ? formatKeySpec(binding, { upper: true }) : "なし"}`;
    };
    const destinations = [];
    if (this.dumpToClipboard) destinations.push("クリップボード");
    if (this.dumpDir) destinations.push(this.dumpDir);
    const dest = destinations.length > 0 ? destinations.join(" + ") : "dump <pane> <file>";
    return `ダンプ ${part("a", "A")} ${part("b", "B")} ${part("c", "C")} ${part("all", "ALL")} → ${dest}`;
  }

  /**
   * @param {"a"|"b"|"c"|"all"} target
   * @param {string|null} spec
   */
  setDumpKey(target, spec) {
    this.dumpKeys = assignDumpKey(this.dumpKeys, target, spec);
    this.#refreshDumpChrome();
  }

  /**
   * @param {"a"|"b"|"c"|"all"} target
   * @param {string} [explicitPath]
   */
  async dumpPane(target, explicitPath) {
    try {
      await this.#dumpPane(target, explicitPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.writePanelC(`ダンプに失敗しました: ${message}`, "#f7768e");
    }
  }

  #refreshDumpChrome() {
    const titleFor = (id, base) => {
      const binding = this.dumpKeys[id];
      return binding ? `${base} [${formatKeySpec(binding, { upper: true })}]` : base;
    };
    if (this.panelA) this.panelA.scrollbox.title = titleFor("a", "A: console.log");
    if (this.panelB) this.panelB.scrollbox.title = titleFor("b", "B: socket.io");
    if (this.panelC) this.panelC.scrollbox.title = titleFor("c", "C: info");
    if (this.commandInput) {
      const hint = ["a", "b", "c"]
        .map((id) => {
          const binding = this.dumpKeys[id];
          return `${id.toUpperCase()}:${binding ? formatKeySpec(binding, { upper: true }) : "-"}`;
        })
        .join(" ");
      this.commandInput.placeholder =
        `コマンドを入力... [Enter: 実行] [Tab: 補完] [↑↓: 履歴] [ダンプ ${hint}]`;
    }
  }

  #installDumpKeys() {
    if (!this.renderer || this.#onDumpKey) return;
    this.#onDumpKey = (key) => {
      const target = DUMP_TARGETS.find((id) => keyEventMatches(key, this.dumpKeys[id]));
      if (!target) return;
      key.preventDefault();
      void this.dumpPane(target);
    };
    this.renderer.keyInput.on("keypress", this.#onDumpKey);
  }

  /** @param {string} raw */
  async #commandDump(raw) {
    const body = raw.replace(/^dump\s+/i, "").trim();
    const match = body.match(/^(a|b|c|all)(?:\s+([\s\S]+))?$/i);
    if (!match) {
      this.writePanelC("usage: dump <a|b|c|all> [file]", "#e0af68");
      return;
    }
    const explicit = match[2] ? unquote(match[2]) : undefined;
    await this.dumpPane(match[1].toLowerCase(), explicit);
  }

  /** @param {string} raw */
  #commandBind(raw) {
    const body = raw.replace(/^bind\s*/i, "").trim();
    if (!body) {
      this.writePanelC(this.describeDumpKeys(), "#7aa2f7");
      this.writePanelC("usage: bind <a|b|c|all> <key>|none", "#bb9af7");
      return;
    }
    const match = body.match(/^(a|b|c|all)(?:\s+(.+))?$/i);
    if (!match) {
      this.writePanelC("usage: bind <a|b|c|all> <key>|none", "#e0af68");
      return;
    }
    const target = match[1].toLowerCase();
    if (!match[2]) {
      const binding = this.dumpKeys[target];
      const label = binding ? formatKeySpec(binding, { upper: true }) : "なし";
      this.writePanelC(`${target.toUpperCase()}: ${label}`, "#7aa2f7");
      return;
    }
    try {
      this.setDumpKey(target, match[2].trim());
      const binding = this.dumpKeys[target];
      this.writePanelC(
        binding
          ? `ダンプキー ${target.toUpperCase()} = ${formatKeySpec(binding, { upper: true })}`
          : `ダンプキー ${target.toUpperCase()} を解除しました`,
        "#9ece6a",
      );
    } catch (err) {
      this.writePanelC(err instanceof Error ? err.message : String(err), "#f7768e");
    }
  }

  /** @param {"a"|"b"|"c"|"all"} target @param {string} [explicitPath] */
  async #dumpPane(target, explicitPath) {
    if (!DUMP_TARGETS.includes(target)) {
      this.writePanelC("usage: dump <a|b|c|all> [file]", "#e0af68");
      return;
    }
    const text = normalizeDumpText(this.#collectDumpText(target));
    const lines = countDumpLines(text);
    const label = target === "all" ? "ALL" : target.toUpperCase();

    let filePath = null;
    let fileError = "";
    const wantsFile = Boolean(explicitPath) || Boolean(this.dumpDir);
    if (wantsFile) {
      try {
        filePath = await resolveDumpFilePath(target, {
          dumpDir: explicitPath ? null : this.dumpDir,
          explicitPath: explicitPath ?? null,
        });
        if (filePath) await writeDumpFile(filePath, text);
      } catch (err) {
        fileError = err instanceof Error ? err.message : String(err);
        filePath = null;
      }
    }

    let clipboard = { ok: false, empty: false, detail: "" };
    if (this.dumpToClipboard) {
      clipboard = text
        ? await this.#copyToClipboard(text)
        : { ok: false, empty: true, detail: "" };
    }

    const pieces = [`${lines}行`];
    if (filePath) pieces.push(filePath);
    if (fileError) pieces.push(`ファイル失敗: ${fileError}`);
    if (clipboard.ok) pieces.push("クリップボード");
    else if (clipboard.empty) pieces.push("空のためクリップボードは更新していません");
    else if (this.dumpToClipboard) pieces.push(`クリップボード失敗: ${clipboard.detail || "unavailable"}`);
    if (!filePath && !fileError && !this.dumpToClipboard) {
      pieces.push("出力先がありません。dump <pane> <file> または --dump-dir を指定してください");
    }

    const ok = Boolean(filePath) || clipboard.ok;
    this.writePanelC(`ダンプ ${label}: ${pieces.join(" / ")}`, ok ? "#9ece6a" : "#f7768e");
  }

  /** @param {"a"|"b"|"c"|"all"} target */
  #collectDumpText(target) {
    if (target === "all") {
      const blocks = [
        ["A: console.log", this.panelA],
        ["B: socket.io", this.panelB],
        ["C: info", this.panelC],
      ];
      return blocks
        .map(([title, panel]) => `===== ${title} =====\n${panel?.getPlainText() ?? ""}`)
        .join("\n\n");
    }
    const panel = target === "a" ? this.panelA : target === "b" ? this.panelB : this.panelC;
    return panel?.getPlainText() ?? "";
  }

  /** @param {string} text */
  async #copyToClipboard(text) {
    const errors = [];
    let ok = false;
    const host = this.#ensureHostClipboard();
    if (host) {
      try {
        const result = await host.writeText(text);
        if (result.status === "written") {
          ok = true;
        } else {
          this.#hostClipboardFailed = true;
          errors.push(result.status === "failed" ? result.error.message : result.status);
        }
      } catch (err) {
        this.#hostClipboardFailed = true;
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (!ok) {
      const clip = await copyTextWithClip(text);
      if (clip.ok) ok = true;
      else if (clip.detail && clip.detail !== "clip-unavailable") errors.push(clip.detail);
    }
    try {
      if (this.renderer?.copyToClipboardOSC52(text)) ok = true;
      else errors.push("osc52");
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    return { ok, empty: false, detail: ok ? "" : errors.filter(Boolean).join(", ") };
  }

  #ensureHostClipboard() {
    if (this.#hostClipboardFailed) return null;
    if (this.#hostClipboard) return this.#hostClipboard;
    try {
      this.#hostClipboard = createHostClipboard();
      return this.#hostClipboard;
    } catch {
      this.#hostClipboardFailed = true;
      return null;
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
