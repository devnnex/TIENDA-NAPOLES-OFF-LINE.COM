const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "admin.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const start = source.indexOf("  const persistUserCredentialPins =");
const end = source.indexOf("  let usersLoadPromise =", start);
assert.ok(start > 0 && end > start, "No se encontró el flujo de copiar acceso.");
const accessCode = `${source.slice(start, end)}\n;globalThis.access = { persistUserCredentialPins, shareUserCredentials };`;
const saveStart = source.indexOf("  const saveUser =");
const saveEnd = source.indexOf("  const editUser =", saveStart);
assert.ok(saveStart > 0 && saveEnd > saveStart, "No se encontró el guardado de usuarios.");
const saveCode = `${source.slice(saveStart, saveEnd)}\n;globalThis.saveUser = saveUser;`;

const setup = (url, pin = "4321") => {
  const copied = [];
  const edited = [];
  const messages = [];
  const stored = new Map();
  const state = {
    users: [{ id: "user-1", full_name: "Juan Pérez", username: "juan", role: "waiter" }],
    userCredentialPins: pin ? { "user-1": pin } : {}
  };
  const context = vm.createContext({
    URL,
    state,
    USER_CREDENTIALS_CACHE_KEY: "tienda_napoles_user_credentials_v1",
    location: { href: url },
    navigator: { clipboard: { writeText: async (value) => { copied.push(value); } } },
    localStorage: { setItem: (key, value) => stored.set(key, value) },
    isBoss: () => true,
    editUser: (id) => edited.push(id),
    toast: (message, tone) => messages.push({ message, tone })
  });
  vm.runInContext(accessCode, context);
  return { access: context.access, state, copied, edited, messages, stored };
};

(async () => {
  assert.match(html, /class="role-guide"/);
  assert.match(css, /\.users-count-badge[^\n]*color: #11683f/);
  assert.match(css, /\.admin-sidebar nav a\.active::after/);
  assert.match(source, /data-share-user="\$\{user\.id\}"/);

  const publicApp = setup("https://tienda.example/admin.html?from=home#users");
  await publicApp.access.shareUserCredentials("user-1");
  assert.equal(publicApp.copied.length, 1);
  assert.match(publicApp.copied[0], /Enlace: https:\/\/tienda\.example\/admin\.html/);
  assert.match(publicApp.copied[0], /Usuario: juan/);
  assert.match(publicApp.copied[0], /PIN: 4321/);
  assert.doesNotMatch(publicApp.copied[0], /from=home|#users/);
  assert.equal(publicApp.messages[0].tone, "ok");
  publicApp.access.persistUserCredentialPins();
  assert.deepEqual(JSON.parse(publicApp.stored.get("tienda_napoles_user_credentials_v1")), { "user-1": "4321" });

  const unknownPin = setup("https://tienda.example/admin.html", "");
  await unknownPin.access.shareUserCredentials("user-1");
  assert.equal(unknownPin.copied.length, 0);
  assert.deepEqual(unknownPin.edited, ["user-1"]);
  assert.equal(unknownPin.messages[0].tone, "error");

  const localApp = setup("http://localhost:8765/admin.html#users");
  await localApp.access.shareUserCredentials("user-1");
  assert.equal(localApp.copied.length, 1);
  assert.doesNotMatch(localApp.copied[0], /Enlace:/);

  let pinPersisted = 0;
  const form = {
    user_id: { value: "" },
    full_name: { value: "Juan Pérez" },
    username: { value: "juan" },
    pin: { value: "9876", placeholder: "" },
    role: { value: "waiter" },
    is_active: { checked: true },
    querySelector: () => ({ disabled: false }),
    reset: () => undefined
  };
  const saveState = {
    authToken: "test-auth",
    users: [],
    currentUser: { id: "boss-1" },
    userCredentialPins: {}
  };
  saveState.sb = { rpc: async () => ({ data: { id: "user-1", full_name: "Juan Pérez", username: "juan", role: "waiter" }, error: null }) };
  const saveContext = vm.createContext({
    state: saveState,
    isBoss: () => true,
    uid: () => "user-1",
    toast: () => undefined,
    mergeUsers: (...groups) => groups.flat(),
    persistUserCredentialPins: () => { pinPersisted += 1; },
    persistUsersCache: () => undefined,
    resetUserFormPresentation: () => undefined,
    renderUsers: () => undefined,
    ADMIN_SECTION_KEYS: []
  });
  vm.runInContext(saveCode, saveContext);
  await saveContext.saveUser(form);
  assert.equal(saveState.userCredentialPins["user-1"], "9876");
  assert.equal(pinPersisted, 1);

  console.log("5/5 escenarios de apariencia y copiar acceso aprobados");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
