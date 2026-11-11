// The plain-language message shown when a locked-out login is attempted.
// Minutes are rounded up so the dealer never sees "0 minutes".
function lockoutMessage(lockedUntil) {
  const mins = Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000));
  return `Too many wrong tries — this login is locked for ${mins} more minute${mins === 1 ? '' : 's'}. Try again then.`;
}

module.exports = { lockoutMessage };
