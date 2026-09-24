// const fs = require("fs");
import { open } from 'node:fs/promises';
// import { fsPromises };
import iconv_pkg from 'iconv-lite';
const {iconv} = iconv_pkg;

// // Shift-JISファイルをBufferとして読み込む
// const buffer = fs.readFileSync("sample.txt");

// // Shift-JIS → JavaScript文字列(Unicode)へ変換
// const text = iconv.decode(buffer, "Shift_JIS");


import { parseCliArgs, printUsage } from "./cli/parseArgs.js";
import { CliMonitor } from "./monitor/CliMonitor.js";
import { onCommandExecute } from "./handlers/commandHandler.js";
import { onTabComplete } from "./handlers/tabCompleteHandler.js";
import { registerSocketEventHandlers } from "./handlers/socketEventHandler.js";
import { createSocketServer } from "./server.js";
import { logScriptResult, runScript } from "./script/runScript.js";
import {registerPayloadEncoder} from "./script/payloadEncoders.js";

const PORT = Number(process.env.PORT ?? 3000);
const SCRIPT_URL = process.env.MONITOR_URL ?? `http://localhost:${PORT}`;

let cliOptions;
try {
  cliOptions = parseCliArgs(process.argv);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  printUsage();
  process.exit(1);
}

if (cliOptions.help) {
  printUsage();
  process.exit(0);
}
function generate_query_process_result(response)
{
    const keys = ["stage"         
    ,   "fps"           
    ,   "camera_type"   
    ,   "frame_number"  
    ,   "firmware"      
    ,   "rt_error"      
    ,   "compile_id"    
    ,   "exec_result"   
    ,   "compile_result"];

    let combined = ""
    let break_by_no_key = false;
    let kcount = 0;
    for (const key of keys) {
        kcount += 1;
        let mapv = "--";
        try {
            mapv=response[key];
            if (mapv === undefined) {
                combined += JSON.stringify(response, null, 2);
                break_by_no_key = true;
            }
        } catch (ek) {
            combined += JSON.stringify(response, null, 2);
            break_by_no_key = true;
        }
        if (key=="stage") {
            combined += `Stage: ${mapv}`;
        } else if (key=="camera_type"   ) {
            combined += `,Camera: ${mapv}`;
        } else if (key=="frame_number"  ) {
            combined += `,Fnum: ${mapv}`;
        } else if (key=="fps"           ) {
            combined += `,FPS: ${mapv}`;
        } else if (key=="firmware"      ) {
            combined += `,Firm: ${mapv}`;
        } else if (key=="rt_error"      ) {
            combined += `,RTE: ${mapv}`;
        } else if (key=="compile_id"    ) {
            combined += `,CompID: ${mapv}`;
        } else if (key=="exec_result"   ) {
            combined += `,Exec: ${mapv}`;
        } else if (key=="compile_result") {
            combined += `,CEr: ${mapv}`;
        }
        if (break_by_no_key) {
            break;
        }
    }
    monitor.addStageStatus( `${kcount}/${combined}`, "#7aa2f7");
    // monitor.setStatus(`,Stage: ${stagev}` , "#7aa2f7");
    
}
///////////////////////////////////////
async function read_to_lines(path)
{
    const fd = await open(path);
    const strm = fd.createReadStream({encoding:'cp932'});
    lines = strm.readLines()

    return lines;
}
///////////////////////////////////////
registerPayloadEncoder("exec_ips0", (args) => {
    if (args.length < 4) {
      throw new Error("exec_ips0 encoder requires at least 4 arguments");
    }
    let enc_arg=[args[1],args[2],args[3]];
    if (args.length > 4) {
        let lineres = [];
        lineres = read_to_lines(args[4]);
        // try {
        //     lineres = read_to_lines(args[4]);
        // } catch (err) {
        //     console.error(err instanceof Error ? err.message : err);
        // }
        enc_arg.push(lineres);
        if (args.length > 5) {
            enc_arg.push(args[5]);
        }
    }
    return enc_arg;
  }
);
///////////////////////////////////////
registerPayloadEncoder("exec_ips", (args) => {
    if (args.length < 4) {
      throw new Error("exec_ips encoder requires at least 4 arguments");
    }
    let enc_arg=[];
    // title
    enc_arg.push(args[1]);
    // root
    enc_arg.push(args[2]);
    // 1 line    
    enc_arg.push(args[3]);
    
    if (args.length > 4) {
        try {
            // load & multi lines
            let lines = read_to_lines(args[4]);
            enc_arg.push(lines);
        } catch (err) {
              console.error(err instanceof Error ? err.message : err);
        }
    }    
    return enc_arg;
  } 
);
///////////////////////////////////////
registerPayloadEncoder("query_recorder", (args) => {
    if (args.length < 2) {
      throw new Error("query_recorder encoder requires at least 2 arguments");
    }
    return args.slice(1);
  } 
);
///////////////////////////////////////
registerPayloadEncoder("record_pick", (args) => {
    if (args.length < 4) {
      throw new Error("record_pick encoder requires at least 4 arguments");
    }
    return args.slice(1);
  } 
);
///////////////////////////////////////
registerPayloadEncoder("record_reserve", (args) => {
    if (args.length < 4) {
      throw new Error("record_reserve encoder requires at least 4 arguments");
    }
    return args.slice(1);
  } 
);
///////////////////////////////////////
registerPayloadEncoder("record_range", (args) => {
    if (args.length < 4) {
      throw new Error("record_range encoder requires at least 4 arguments");
    }
    return args.slice(1);
  } 
);
///////////////////////////////////////
registerPayloadEncoder("history_pick", (args) => {
    if (args.length < 3) {
      throw new Error("history_pick encoder requires at least 3 arguments");
    }
    return args.slice(1);
  } 
);
///////////////////////////////////////
registerPayloadEncoder("exit", (args) => {
    if (args.length < 1) {
      throw new Error("exit encoder requires at least 1 argument");
    }
    return args.slice(1);
  } 
);
///////////////////////////////////////
registerPayloadEncoder("REPL_cmd", (args) => {
    if (args.length < 2) {
      throw new Error("REPL_cmd encoder requires at least 2 arguments");
    }
    return args.slice(1);
  } 
);
///////////////////////////////////////
registerPayloadEncoder("set_datarec_path", (args) => {
    if (args.length < 5) {
      throw new Error("set_datarec_path encoder requires at least 5 arguments");
    }
    return args.slice(1);
  } 
);
const monitor = new CliMonitor({
  onCommandExecute: undefined,
  onTabComplete,
});

createSocketServer({
  port: PORT,
  onConnection: (socket) => {
    console.log(`[socket.io] 接続: ${socket.id}`);
    monitor.setStatus(`Client connected: ${socket.id}`, "#7aa2f7");
    monitor.writePanelC(`接続: ${socket.id}`, "#73daca");

    registerSocketEventHandlers(socket, {
      appendPanelB: (line) => monitor.appendPanelB(line),
    });
    let checking = { qp: false, qpf: false, qr: false };
    let stagev = "unknown";
    let state_rec="unknown";
    let fps_state="unknown";

    monitor.setConsoleCommands(socket,async (commandText, args) => {
//      await onCommandExecute(commandText, args);

      const cmd = args[0];
      if (cmd === "status") {
        monitor.setStatus(`接続ポート: ${PORT}`, "#7dcfff");
      } else if (cmd === "clear") {
        monitor.clearAllPanels();
        monitor.setStatus("ログをクリアしました", "#9ece6a");
      } else if (cmd === "help") {
        monitor.writePanelC("help | status | clear | load | quit", "#bb9af7");
      } else if (cmd === "list_encoder") {
      } else if (cmd === "send") {
        await onCommandExecute(commandText,args.slice(1),socket,"","",monitor);
 
      } else if (cmd === "load") {
        if (args.length < 2) {
          monitor.writePanelC("usage: load <script-file>", "#f7768e");
          return;
        }
        const result = await runScript({
            scriptPath: args[1],
            url: SCRIPT_URL,
            monitor: monitor,
            parent_socket: socket
        });
        logScriptResult(result, { writePanelC: (text, color) => monitor.writePanelC(text, color) });
      } else if (cmd === "quit" || cmd === "exit") {
        monitor.setStatus("終了中...", "#f7768e");
        monitor.destroy();
        process.exit(0);
      }
    });
    const timerId = setInterval(() => {

        // try {

        // } catch (e) {
        //   let responseStr = JSON.stringify(response, null, 2);
        //   console.log(
        //     `response の値:`,
        //     responseStr
        //   );
        // }

/*                 console.log(
            `クライアント ${socket.id} の状態:`,
            JSON.stringify(response, null, 2)
        );
*/       // 前回の確認がまだ終わっている場合は重複送信しない
        if (checking.qp || checking.qpf || checking.qr) {
            return;
        }

        checking.qp = true;
        checking.qpf = true;
        checking.qr = true;
        monitor.clearStatus
        socket.timeout(3000).emit(
            "query_recorder", "state",
            {
                serverTime: Date.now()
            },
            (err, response) => {
                checking.qr = false;

                if (err) {
                    erlog = 
                        `クライアント ${socket.id} から応答がありません`;
                    monitor.writePanelC(erlog, "#f7768e");
                    return;
                  } else {
                    monitor.addStatus(`Recorder: ${response["state"]}` , "#7aa2f7");
                  }
            }
        );
        socket.timeout(3000).emit(
            "query_process",["stage","fps"],
            {
                serverTime: Date.now()
            },
            (err, response) => {
                checking.qp = false;
                checking.qpf=false;
                
                if (err) {
                  erlog = 
                        `クライアント ${socket.id} から応答がありません`;
                    monitor.writePanelC(erlog, "#f7768e");
                    return;
                 } else {
                     generate_query_process_result(response);                     
                 }
            }
        );
        
    }, 5000); // 5秒間隔
    socket.on("send_ips_message", () => {
        onCommandExecute("exec_ips title ...",["exec_ips","title",".","","file"],socket,"","",monitor);
        
    });
    socket.on("disconnect", () => {
      console.log(`[socket.io] 切断: ${socket.id}`);
      monitor.setStatus("Client disconnected", "#e0af68");
      monitor.writePanelC(`切断: ${socket.id}`, "#f7768e");
    });
  },
});

await monitor.start();
monitor.setStatus(`Listening on port ${PORT}`, "#9ece6a");
console.log(`Express + Socket.IO server started on http://localhost:${PORT}`);

if (cliOptions.scriptPath) {
  const result = await runScript({
    scriptPath: cliOptions.scriptPath,
    url: SCRIPT_URL,
    monitor,
    parent_socket: undefined
  });
  logScriptResult(result, { writePanelC: (text, color) => monitor.writePanelC(text, color) });
  monitor.destroy();
  process.exit(result.ok ? 0 : 1);
}

process.on("SIGINT", () => {
  monitor.destroy();
  process.exit(0);
});
