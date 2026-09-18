/**
 * Boundary for a future identity provider. This default intentionally has no
 * transport or persistence: credentials never leave the form in this build.
 */
export const unconfiguredAuthAdapter = Object.freeze({
  configured: false,
  async signIn() {
    throw new Error("AUTH_UNAVAILABLE");
  },
});

export function isConfiguredAdapter(adapter) {
  return Boolean(adapter && adapter.configured === true && typeof adapter.signIn === "function");
}