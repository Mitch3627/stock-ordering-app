// Shared test helpers (not a test file itself).

// Tests that mount a single route without the sign-in layer act as a signed-in manager, who may do everything.
function asManager(req, res, next) {
  req.user = { id: 1, name: 'Test Manager', email: 'manager@test', role: 'manager' };
  next();
}

module.exports = { asManager };
