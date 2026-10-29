'use strict';

// Quote price number tokens BEFORE JSON.parse can round them to JS Numbers.
// Other fields (IDs, quantities, status codes) retain their existing types.
const PRICE_KEYS = new Set([
    'price', 'rate', 'cost', 'product_price', 'cost_per_unit',
    'rawPrice', 'providerPrice', 'costPrice', 'basePrice', 'finalPrice',
]);
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

const parseProviderJson = (data) => {
    if (typeof data !== 'string' || !data.trim()) return data;
    let previousToken;
    let previousEnd = 0;
    try {
        const protectedJson = data.replace(JSON_TOKEN, (token, offset) => {
            const isPrice = token[0] !== '"'
                && previousToken?.[0] === '"'
                && /^\s*:\s*$/.test(data.slice(previousEnd, offset))
                && PRICE_KEYS.has(JSON.parse(previousToken));
            previousToken = token;
            previousEnd = offset + token.length;
            return isPrice ? JSON.stringify(token) : token;
        });
        return JSON.parse(protectedJson);
    } catch {
        // Match Axios's default handling of non-JSON responses.
        return data;
    }
};

module.exports = { parseProviderJson };
