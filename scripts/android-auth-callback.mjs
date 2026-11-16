export function isExpectedAndroidAuthCallback(rawUrl, expectedRedirectUrl) {
  try {
    const expected = new URL(String(expectedRedirectUrl));
    const callback = new URL(String(rawUrl));

    if (
      !expected.protocol ||
      !expected.hostname ||
      expected.username ||
      expected.password ||
      expected.port ||
      expected.search ||
      expected.hash
    ) {
      return false;
    }

    return callback.protocol === expected.protocol &&
      callback.hostname === expected.hostname &&
      callback.port === expected.port &&
      callback.pathname === expected.pathname &&
      !callback.username &&
      !callback.password;
  } catch {
    return false;
  }
}
