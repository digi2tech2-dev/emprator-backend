"use strict";
// Arbitrary messages, response bodies, URLs and request config can contain secrets.
const safePollError = (error) => {
    const status = Number(error?.response?.status);
    if (status === 401 || status === 403) return 'PROVIDER_AUTHENTICATION_ERROR';
    if (/api token.*required/i.test(String(error?.message || ''))) return 'PROVIDER_TOKEN_MISSING';
    if (/timeout|timed out/i.test(String(error?.message || ''))) return 'PROVIDER_TIMEOUT';
    if (/^UNSUPPORTED_PROVIDER/.test(String(error?.message || ''))) return 'UNSUPPORTED_PROVIDER';
    const code = String(error?.code || '');
    if (['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN'].includes(code)) return code;
    if (status >= 400 && status <= 599) return `PROVIDER_HTTP_${status}`;
    return 'PROVIDER_POLL_ERROR';
};
module.exports = { safePollError };
