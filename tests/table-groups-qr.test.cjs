const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "admin.html"), "utf8");

function section(from, to) {
  const start = app.indexOf(from);
  const end = app.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `No se encontró ${from}`);
  return app.slice(start, end);
}

function harness() {
  const state = {
    tables: [
      { id: "m1", table_number: 1, table_name: "Mesa 1" },
      { id: "m2", table_number: 2, table_name: "MESA 2" },
      { id: "t3", table_number: 3, table_name: "terraza 3" },
      { id: "t4", table_number: 4, table_name: "TERRAZAS 4" }
    ],
    tableManagerGroupFilter: "all",
    selectedTableQrIds: new Set()
  };
  let search = "";
  let downloaded = [];
  const storage = new Map();
  const code = [
    'const QR_REGENERATION_STORAGE_KEY = "tienda_napoles_qr_regeneration_enabled_v1";',
    section("  const servicePointKind =", "  const isServicePoint ="),
    section("  const tableGroupKey =", "  const sessionLabel ="),
    section("  const visibleManagerTables =", "  const renderTableManager ="),
    section("  const setAllQrSelections =", "  const normalizeTableLookup ="),
    section("  const downloadSelectedQrs =", "  const regenerateQr =")
  ].join("\n");
  const create = new Function("state", "normalizeText", "tableLabel", "normalTables", "escapeHTML", "localStorage", "$", "$$", "renderQrBatchControls", "downloadQrPdf", `${code}\nreturn { tableGroupKey, isTerraceTable, tableMatchesSearch, syncTableGroupOptions, visibleManagerTables, setAllQrSelections, downloadSelectedQrs, qrRegenerationEnabled };`);
  const functions = create(
    state,
    (value = "") => String(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").trim(),
    (table) => table.table_name || `Mesa ${table.table_number}`,
    () => state.tables,
    (value) => value,
    { getItem: (key) => storage.get(key) || null },
    () => ({ value: search }),
    () => [],
    () => {},
    async (tables) => { downloaded = tables.map((table) => table.id); }
  );
  return { state, storage, ...functions, setSearch(value) { search = value; }, downloaded() { return downloaded; } };
}

test("los nombres de mesa y terraza se agrupan sin depender de mayúsculas ni plural", () => {
  const page = harness();
  const select = { dataset: {}, innerHTML: "", value: "" };
  assert.equal(page.syncTableGroupOptions(select, "all"), "all");
  assert.equal((select.innerHTML.match(/value="mesa"/g) || []).length, 1);
  assert.equal((select.innerHTML.match(/value="terraza"/g) || []).length, 1);
  assert.equal(page.tableGroupKey(page.state.tables[0]), "mesa");
  assert.equal(page.tableGroupKey(page.state.tables[3]), "terraza");
  assert.equal(page.tableGroupKey({ table_name: "TERRAZA4" }), "terraza");
  assert.equal(page.isTerraceTable(page.state.tables[3]), true);
  assert.match(app, /qrCode\.startsWith\("interno-bar-"\)/);
  assert.equal(page.tableMatchesSearch(page.state.tables[0], "M 1"), true);
  assert.equal(page.tableMatchesSearch(page.state.tables[0], "M1"), true);
  assert.equal(page.tableMatchesSearch({ table_number: 10, table_name: "MESA 10" }, "M1"), false);
});

test("seleccionar todas y descargar solo incluye las mesas visibles del filtro", async () => {
  const page = harness();
  page.state.tableManagerGroupFilter = "terraza";
  page.setAllQrSelections(true);
  assert.deepEqual([...page.state.selectedTableQrIds].sort(), ["t3", "t4"]);
  await page.downloadSelectedQrs();
  assert.deepEqual(page.downloaded(), ["t3", "t4"]);
  page.setSearch("M 3");
  page.setAllQrSelections(true);
  assert.deepEqual([...page.state.selectedTableQrIds], ["t3"]);
  await page.downloadSelectedQrs();
  assert.deepEqual(page.downloaded(), ["t3"]);
});

test("la regeneración queda cerrada por defecto y la edición conserva el QR", () => {
  const page = harness();
  assert.equal(page.qrRegenerationEnabled(), false);
  page.storage.set("tienda_napoles_qr_regeneration_enabled_v1", "1");
  assert.equal(page.qrRegenerationEnabled(), true);
  assert.match(app, /const regenerateQr = async \(id\) => \{\s*if \(!qrRegenerationEnabled\(\)\) return;/);
  assert.match(app, /qr_code: currentTable\?\.qr_code \|\| `mesa-\$\{number\}`/);
  assert.match(app, /if \(!await askForConfirmation\(\{\s*eyebrow: "Cambiar código QR"/);
  assert.match(html, /name="qr_regeneration_enabled"/);
  assert.match(html, /id="tableManagerGroupFilter"/);
  assert.match(html, /id="dashboardTableGroupFilter"/);
});
