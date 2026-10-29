'use strict';

jest.mock('../services/currencyConverter.service', () => ({
    getConversionRate: jest.fn(async (currency) => currency === 'USD' ? 1 : 50),
}));

const axios = require('axios');
const { getAdapter } = require('../modules/providers/adapters/adapter.factory');
const { parseProviderJson } = require('../modules/providers/adapters/providerJson.helper');
const { normalizeProviderDecimalPrice } = require('../shared/utils/decimalPrecision');
const cache = require('../modules/providers/providerPriceCache');
const { Provider } = require('../modules/providers/provider.model');
const { ProviderProduct } = require('../modules/providers/providerProduct.model');
const { syncProviderProducts } = require('../modules/providers/providerProductSync.service');
const { connectTestDB, disconnectTestDB, clearCollections } = require('./testHelpers');

const LONG_PRICE = `0.${'1234567890'.repeat(9)}1234567891`;
const PRICES = [LONG_PRICE, '1234567891'.repeat(10), `0.${'0'.repeat(99)}1`, '0.123456789'];
const providerConfig = (slug) => ({
    name: slug, slug, baseUrl: 'https://supplier.example/client/api', apiToken: 'test-token',
});
let body;

beforeAll(connectTestDB);
afterAll(disconnectTestDB);
beforeEach(async () => {
    await clearCollections();
    cache.clearAll();
    const create = axios.create.bind(axios);
    jest.spyOn(axios, 'create').mockImplementation((config) => create({
        ...config,
        // Exercise the real Axios response transforms with raw HTTP JSON.
        adapter: async (requestConfig) => ({
            data: body, status: 200, statusText: 'OK', headers: {}, config: requestConfig,
        }),
    }));
});
afterEach(() => jest.restoreAllMocks());

const productJson = (price, quoted = false, currency = 'USD') =>
    `[{"id":1,"name":"Product","price":${quoted ? JSON.stringify(price) : price},"currency":"${currency}","available":true}]`;

describe.each(['canonical-b2b', 'brand-one-card', 'brand1-card', 'alkasr', 'toros', 'royal-crown', 'ibra-store'])(
    '%s supplier price precision', (slug) => {
        test.each(PRICES.flatMap((price) => [[price, false], [price, true]]))(
            'retains all digits of %s (quoted: %s) through HTTP, DTO and cache', async (price, quoted) => {
                body = productJson(price, quoted);
                const adapter = getAdapter(providerConfig(slug));
                const [product] = await adapter.getProducts();
                expect(product.rawPrice).toBe(price);
                expect(normalizeProviderDecimalPrice(product.rawPrice)).toBe(price);
                expect(await cache.getLivePrice(slug, '1', adapter)).toBe(price);
                expect(await cache.getLivePrice(slug, '1', adapter)).toBe(price);
            }
        );
    }
);

test.each(['canonical-b2b', 'brand-one-card', 'brand1-card'])(
    '%s sync persists a full 100 decimal places in MongoDB', async (slug) => {
        body = productJson(LONG_PRICE);
        const provider = await Provider.create(providerConfig(slug));
        await syncProviderProducts(provider._id);
        const stored = await ProviderProduct.findOne({ provider: provider._id, externalProductId: '1' }).lean();
        expect(stored.rawPrice).toBe(LONG_PRICE);
        expect(stored.rawPayload.price).toBe(LONG_PRICE);
    }
);

test('Brand One currency conversion preserves a terminating price beyond 100 digits', async () => {
    body = productJson(`50.${'0'.repeat(99)}5`, false, 'EGP');
    const [product] = await getAdapter(providerConfig('brand-one-card')).getProducts();
    expect(product.rawPrice).toBe(`1.${'0'.repeat(100)}1`);
    expect(product.rawPayload.price).toBe(`50.${'0'.repeat(99)}5`);
});

test('preserves only price tokens and leaves strings, IDs, quantities and codes intact', () => {
    const input = `{"id":123,"qty":2,"code":200,"name":"price: 1234567890123456789",` +
        `"nested":{"price":${LONG_PRICE},"rate":1e-100,"cost":${LONG_PRICE},` +
        `"product_price":${LONG_PRICE},"cost_per_unit":${LONG_PRICE}},"pric\\u0065":${LONG_PRICE}}`;
    const data = parseProviderJson(input);
    expect(data).toMatchObject({ id: 123, qty: 2, code: 200, name: 'price: 1234567890123456789', price: LONG_PRICE });
    expect(data.nested).toEqual({ price: LONG_PRICE, rate: '1e-100', cost: LONG_PRICE, product_price: LONG_PRICE, cost_per_unit: LONG_PRICE });
    expect(normalizeProviderDecimalPrice(data.nested.rate)).toBe(`0.${'0'.repeat(99)}1`);
    expect(parseProviderJson(data)).toBe(data);
    expect(parseProviderJson('<html>error</html>')).toBe('<html>error</html>');
});

test.each(['Infinity', 'NaN', '-0.0000001', '-1e-1000'])(
    'rejects invalid supplier price %s', async (price) => {
        body = productJson(price, true);
        await expect(getAdapter(providerConfig('canonical-b2b')).getProducts()).rejects.toThrow('non-negative');
    }
);
