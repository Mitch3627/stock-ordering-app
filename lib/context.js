// Who is making the current request, available anywhere during it (e.g. to the stock ledger) without passing
// the user through every function. Set once per request by requireAuth.
const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

function runAs(user, fn) {
  return store.run({ user }, fn);
}

function currentUserId() {
  const ctx = store.getStore();
  return ctx && ctx.user ? ctx.user.id : null;
}

module.exports = { runAs, currentUserId };
