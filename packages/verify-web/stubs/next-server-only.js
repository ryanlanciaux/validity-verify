/**
 * next/headers + next/cookies stub — these are server-only APIs that throw
 * when called from a client component. In the sandbox (CSR-only), we throw
 * the same error so a component that legitimately uses them surfaces a
 * clear "this is server-only" message instead of crashing with a generic
 * import error.
 */
function serverOnlyError(name) {
  return function serverOnly() {
    throw new Error(
      `next/${name} is server-only and can't be called from a client component in ` +
        `Validity's sandbox. Either move the call to a Server Component (not ` +
        `supported by Validity) or fetch the data another way for the verify.`,
    );
  };
}

export const headers = serverOnlyError('headers');
export const cookies = serverOnlyError('cookies');
export default { headers, cookies };
