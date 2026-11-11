// Idle auto-logout: a signed-in session ends after 10 minutes with no
// activity. One place owns the number — the browser timer in
// views/partials/footer.ejs reads the same value from res.locals.
// "Activity" is any authenticated request (a page load, a form post, or a
// background poll such as the live auction room refreshing) or, in the
// browser, mouse/keyboard/touch/scroll input.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// The plain-language reason shown on the login page after an idle
// sign-out. Derived from the constant so the number can never go stale.
function idleNotice() {
  return 'You were signed out after ' + (IDLE_TIMEOUT_MS / 60000) + ' minutes with no activity.';
}

function isAuthenticatedSession(req) {
  return !!(req.session && (req.session.dealerId || req.session.admin));
}

// Mount after the session middleware. Refreshes the clock on every
// authenticated request; destroys the session instead when the last
// activity is older than the limit.
function idleTimeout(req, res, next) {
  if (!isAuthenticatedSession(req)) return next();
  const now = Date.now();
  const last = req.session.lastActivity;
  if (last && now - last > IDLE_TIMEOUT_MS) {
    // Capture the session type before destroy() clears it.
    const adminOnly = !!req.session.admin && !req.session.dealerId;
    return req.session.destroy(() => {
      // Background fetches (auction poll, VIN decode) get a 401 so the
      // page can react; ordinary page loads go back to the login screen.
      // A fetch sends Sec-Fetch-Mode cors/same-origin; a navigation
      // sends 'navigate' (or no header at all, e.g. curl).
      const fetchMode = String(req.headers['sec-fetch-mode'] || '');
      const isFetch = req.xhr || (fetchMode && fetchMode !== 'navigate') ||
        String(req.headers.accept || '').includes('application/json');
      if (isFetch) return res.status(401).json({ error: 'session_expired' });
      if (adminOnly) return res.redirect('/admin/login');
      return res.redirect('/login?notice=' + encodeURIComponent(idleNotice()));
    });
  }
  req.session.lastActivity = now;
  next();
}

module.exports = { IDLE_TIMEOUT_MS, idleNotice, isAuthenticatedSession, idleTimeout };
