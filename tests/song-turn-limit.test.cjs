const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const roots = [path.resolve(__dirname, "..")];

(async () => {
  for (const root of roots) {
    const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
    const block = (start, end) => {
      const from = source.indexOf(`  const ${start} =`);
      const to = source.indexOf(`  const ${end} =`, from + 1);
      assert.ok(from >= 0 && to > from, `${root}: ${start}`);
      return source.slice(from, to);
    };
    const notice = { hidden: true, scrollIntoView() {} };
    const sent = [];
    const messages = [];
    const state = {
      currentTable: { id: "table-a" },
      clientRequests: Array.from({ length: 5 }, (_, n) => ({
        id: `song-${n}`, table_id: "table-a", request_type: "other",
        message: "Mesa solicita la canción: prueba", status: "pending"
      })),
      clientQueuePositions: []
    };
    const context = vm.createContext({
      state, Set, String, Promise,
      readRequestOutbox: () => [],
      isSongRequest: (row) => row.request_type === "other" && row.message.includes("solicita la canción:"),
      $: () => notice,
      assistantSay: (role, text) => messages.push({ role, text }),
      createServiceNotification: async (...args) => { sent.push(args); return { id: "new-song" }; },
      refreshClientPosData: () => {},
      tableLabel: () => "Mesa 1"
    });
    vm.runInContext(block("songTurnCount", "addItemToSession")
      + ";globalThis.api = { songTurnCount, handleAssistantMessage, handleSongRequest };", context);
    assert.equal(context.api.songTurnCount(), 5);
    await context.api.handleSongRequest("Sexta canción");
    await context.api.handleAssistantMessage("Otra canción por chat");
    assert.equal(sent.length, 0, `${root}: no se envía la sexta solicitud`);
    assert.equal(messages.length, 0, `${root}: no se muestra el texto rechazado como enviado`);
    assert.equal(notice.hidden, false, `${root}: se muestra el aviso`);
    state.clientRequests.pop();
    state.clientQueuePositions = [{ id: "song-0", kind: "song" }];
    assert.equal(context.api.songTurnCount(), 4, `${root}: la cola remota no duplica solicitudes conocidas`);
    await context.api.handleSongRequest("Cuarta canción");
    assert.equal(sent.length, 1, `${root}: las solicitudes dentro del límite se envían`);
  }
  console.log("PASS canciones: límite de cinco, bloqueo del chat y aviso");
})().catch((error) => { console.error(error); process.exitCode = 1; });
