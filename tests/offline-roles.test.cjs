const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const start = source.indexOf("  const ADMIN_SECTION_KEYS =");
const end = source.indexOf("  const icon =", start);
assert.ok(start > 0 && end > start, "No se encontraron las reglas de acceso de la aplicación.");
const rules = source.slice(start, end);
const evaluate = (currentUser) => vm.runInNewContext(`
  (() => {
    const state = { page: "admin", currentUser: ${JSON.stringify(currentUser)} };
    ${rules}
    return {
      label: roleLabel(state.currentUser?.role),
      users: canAccessAdminSection("users"),
      income: canAccessAdminSection("income"),
      brand: canAccessAdminSection("brand"),
      domains: requiredSyncDomains()
    };
  })()
`);

const boss = evaluate({ role: "boss" });
assert.equal(boss.label, "Jefe");
assert.equal(boss.users, true);
assert.equal(boss.income, true);
assert.ok(boss.domains.includes("sales"));
assert.ok(boss.domains.includes("users"));

const admin = evaluate({ role: "admin", permissions: ["brand"] });
assert.equal(admin.brand, true);
assert.equal(admin.users, false);
assert.equal(admin.income, false);
assert.equal(admin.domains.includes("sales"), false);

const waiter = evaluate({ role: "waiter" });
assert.equal(waiter.label, "Mesero");
assert.equal(waiter.income, false);
assert.equal(waiter.users, false);

const renderStart = source.indexOf("  const renderUsers =");
const renderEnd = source.indexOf("  const resetUserFormPresentation =", renderStart);
assert.ok(renderStart > 0 && renderEnd > renderStart, "No se encontró la vista de usuarios.");
const list = { innerHTML: "" };
const badge = { innerHTML: "" };
const renderState = {
  users: [{ id: "boss-1", full_name: "Jefe Principal", username: "jefe", role: "boss", is_active: true }],
  currentUser: { id: "boss-1", role: "boss" },
  usersRenderSignature: ""
};
const renderContext = vm.createContext({
  state: renderState,
  $: (selector) => selector === "#usersList" ? list : selector === "#usersCountBadge" ? badge : null,
  icon: () => "",
  roleLabel: (role) => ({ boss: "Jefe", admin: "Administrador", waiter: "Mesero" }[role] || "Usuario"),
  escapeHTML: (value) => String(value || ""),
  emptyState: () => "",
  refreshIcons: () => undefined
});
vm.runInContext(`${source.slice(renderStart, renderEnd)}\n;globalThis.renderUsers = renderUsers;`, renderContext);
renderContext.renderUsers();
assert.match(list.innerHTML, /Jefe Principal/);
assert.match(list.innerHTML, /<em>Jefe<\/em>/);
assert.doesNotMatch(list.innerHTML, /<em>Mesero<\/em>/);

console.log("4/4 escenarios de roles y usuarios aprobados");
