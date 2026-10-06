const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const section = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `No se encontro ${start}`);
  return source.slice(from, to);
};

(async () => {
  const draft = { itemName: "Producto", quantity: 1 };
  const form = {
    dataset: {}, session_item_id: { value: "" }, menu_item_id: { value: "" },
    item_name: { value: "" }, quantity: { value: "" }, quick_checkout: { value: "0" }
  };
  const listeners = {};
  const outside = {};
  const document = {
    body: {},
    addEventListener(name, listener) { listeners[name] = listener; }
  };
  const dialog = {
    open: true,
    close() { this.open = false; listeners.close?.(); },
    showModal() { this.open = true; },
    contains(target) { return target !== outside; },
    addEventListener(name, listener) { listeners[name] = listener; }
  };
  const search = { value: "", closest: () => ({}) };
  let clicks = 0;
  const submit = { disabled: false, click() { clicks += 1; } };
  const state = { consumptionDrafts: [draft] };
  let batchResult;
  let now = 1000;
  const context = vm.createContext({
    state, document, Date: { now: () => now },
    $: (selector) => ({
      "#consumptionDialog": dialog, "#consumptionForm": form,
      "#consumptionSubmitButton": submit, "#consumptionProductSearch": search
    })[selector],
    currentConsumptionDraft: () => null,
    addConsumptionBatch: () => new Promise((resolve) => { batchResult = resolve; }),
    renderConsumptionSelection: () => undefined,
    clearConsumptionEntry: () => undefined,
    openPaymentDialog: () => undefined,
    toast: () => undefined
  });
  vm.runInContext(`${section("  const confirmConsumptionSelection =", "  const openConsumptionDialog =")}
globalThis.confirmConsumptionSelection = confirmConsumptionSelection;
globalThis.bindConsumptionConfirmShortcut = bindConsumptionConfirmShortcut;`, context);

  const saved = context.confirmConsumptionSelection(form);
  assert.equal(dialog.open, false, "El modal se cierra al confirmar, sin esperar la red.");
  assert.equal(form.dataset.localSubmitInProgress, "1");
  batchResult({ sessionId: "mesa-1" });
  assert.equal(await saved, "mesa-1");
  assert.equal(dialog.open, false, "El modal permanece cerrado tras guardar.");
  assert.equal(state.consumptionDrafts.length, 0);
  assert.equal(form.dataset.localSubmitInProgress, undefined);

  state.consumptionDrafts = [draft];
  dialog.open = true;
  const failed = context.confirmConsumptionSelection(form);
  assert.equal(dialog.open, false);
  batchResult(null);
  assert.equal(await failed, null);
  assert.equal(dialog.open, true, "Un fallo restaura la seleccion y reabre el modal.");
  assert.equal(state.consumptionDrafts.length, 1);

  context.bindConsumptionConfirmShortcut();
  const space = (target, options = {}) => {
    let prevented = false;
    listeners.keydown({
      key: " ", target, preventDefault: () => { prevented = true; }, ...options
    });
    return prevented;
  };
  assert.equal(space(search), true);
  assert.equal(clicks, 0);
  now += 250;
  assert.equal(space(search), true);
  assert.equal(clicks, 1, "Dos espacios rapidos equivalen al clic.");
  search.value = "Nombre con espacios";
  assert.equal(space(search), false, "No interfiere al escribir nombres.");
  search.value = "";
  assert.equal(space({ value: "", closest: () => ({}) }), false, "No interfiere en otros campos.");
  const neutral = { closest: () => null };
  assert.equal(space(neutral), true);
  now += 250;
  assert.equal(space(neutral), true);
  assert.equal(clicks, 2, "Tambien funciona sin foco en los dos campos.");
  assert.equal(space(document.body), true);
  now += 250;
  assert.equal(space(document.body), true);
  assert.equal(clicks, 3, "Tambien funciona si el foco queda en el fondo.");
  assert.equal(space(outside), false, "No confirma desde otro dialogo.");
  assert.equal(space(form.quantity), true);
  now += 250;
  assert.equal(space(form.quantity), true);
  assert.equal(clicks, 4);
  console.log("Cierre del modal y doble espacio de consumo offline OK");
})().catch((error) => { console.error(error); process.exitCode = 1; });
