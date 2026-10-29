'use strict';

jest.mock('axios');
jest.mock('../services/currencyConverter.service', () => ({ getConversionRate: jest.fn() }));
const axios = require('axios');
const { getConversionRate } = require('../services/currencyConverter.service');
const { BrandOneCardAdapter } = require('../modules/providers/adapters/brandOneCard.adapter');
const { AlkasrVipAdapter } = require('../modules/providers/adapters/alkasr.adapter');
const { getAdapter, getProviderAdapter } = require('../modules/providers/adapters/adapter.factory');

const provider = { slug: 'brand-one-card', baseUrl: 'https://api.brand-one-card.com', apiToken: 'test-token' };
let client;
let adapter;
beforeEach(() => {
    getConversionRate.mockReset();
    getConversionRate.mockImplementation(async (currency) => currency === 'USD' ? 1 : 50);
    client = { get: jest.fn(), interceptors: { response: { use: jest.fn() } } };
    axios.create.mockReturnValue(client);
    adapter = new BrandOneCardAdapter(provider);
});

const response = (status = 'accept', extra = {}) => ({
    data: { status: 'OK', data: { order_id: '482913', status, ...extra } },
});
const order = { externalProductId: '365', quantity: 2, referenceId: 'ORDER-123', playerId: '5123456789' };

test('configures the documented host, token and timeout', () => {
    expect(axios.create).toHaveBeenCalledWith({
        baseURL: provider.baseUrl, timeout: 180000,
        transformResponse: [expect.any(Function)],
        headers: { 'api-token': provider.apiToken, Accept: 'application/json' },
    });
    new BrandOneCardAdapter({ apiKey: 'legacy-token' }, { timeoutMs: 123 });
    expect(axios.create).toHaveBeenLastCalledWith(expect.objectContaining({
        baseURL: provider.baseUrl, timeout: 123, headers: expect.objectContaining({ 'api-token': 'legacy-token' }),
    }));
    expect(() => new BrandOneCardAdapter({})).toThrow('api token');
});

test.each(['brand-one-card', 'brand one card', 'brandonecard'])('factory resolves %s without colliding with brand1-card', (key) => {
    expect(getAdapter({ ...provider, slug: key })).toBeInstanceOf(BrandOneCardAdapter);
    expect(getProviderAdapter({ ...provider, slug: undefined, name: key }, { strict: true })).toBeInstanceOf(BrandOneCardAdapter);
});

test('explicit adapterType resolves the new adapter; all legacy aliases keep Alkasr', () => {
    expect(getAdapter({ ...provider, slug: 'custom', adapterType: 'brand-one-card' })).toBeInstanceOf(BrandOneCardAdapter);
    for (const key of ['brand1-card', 'brand1 card', 'brand1card']) {
        expect(getProviderAdapter({ ...provider, slug: key })).toBeInstanceOf(AlkasrVipAdapter);
    }
});

test('maps availability, quantity limits, prices and preserves product metadata', async () => {
    const product = {
        id: 365, name: 'UC 60', price: 0.104, currency: 'USD', available: true,
        qty_values: { min: 1, max: 15000 }, product_type: 'amount',
        params: ['playerId'], params_info: [{ key: 'playerId', required: true }],
    };
    client.get.mockResolvedValue({ data: [product, { ...product, id: 366, available: false, qty_values: null, product_type: 'package' }] });
    const products = await adapter.fetchProducts();
    expect(products[0]).toEqual({
        externalProductId: '365', rawName: 'UC 60', rawPrice: '0.104',
        minQty: 1, maxQty: 15000, isActive: true, rawPayload: product,
    });
    expect(products[1]).toMatchObject({ minQty: 1, maxQty: 1, isActive: false });
    expect(client.get).toHaveBeenCalledWith('/client/api/products');
});

test('imports EGP products as USD while preserving supplier prices and currency', async () => {
    const item = { id: 1, name: 'Item', price: '50.125', currency: 'EGP', qty_values: null };
    client.get.mockResolvedValue({ data: [item, { ...item, id: 2, price: '0.00000001', currency: ' egp ' }] });
    const products = await adapter.getProducts();
    expect(products[0]).toMatchObject({ rawPrice: '1.0025', rawPayload: item });
    expect(products[1].rawPrice).toBe('0.0000000002');
    expect(getConversionRate).toHaveBeenCalledTimes(1);
    expect(getConversionRate).toHaveBeenCalledWith('EGP');
    // The existing checkout conversion recovers the original EGP cost.
    expect(Number(products[0].rawPrice) * 50).toBe(50.125);
});

test('uses account currency when products omit it', async () => {
    client.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'Item', price: 100 }] })
        .mockResolvedValueOnce({ data: { currency: 'EGP', balance: '500' } });
    expect((await adapter.getProducts())[0].rawPrice).toBe('2');
    expect(client.get).toHaveBeenLastCalledWith('/client/api/profile');
});

test('fails clearly when the account currency is also missing', async () => {
    client.get.mockResolvedValueOnce({ data: [{ id: 1, name: 'Item', price: 100 }] })
        .mockResolvedValueOnce({ data: { balance: '500' } });
    await expect(adapter.getProducts()).rejects.toThrow('Missing product/account currency');
});

test.each([0, -50, Infinity, NaN])('does not import prices with invalid rate %s', async (rate) => {
    getConversionRate.mockResolvedValue(rate);
    client.get.mockResolvedValue({ data: [{ id: 1, name: 'Item', price: 50, currency: 'EGP' }] });
    await expect(adapter.getProducts()).rejects.toThrow('Invalid conversion rate');
});

test('propagates missing or inactive currency configuration errors', async () => {
    getConversionRate.mockRejectedValue(new Error("Currency 'EGP' is currently inactive."));
    client.get.mockResolvedValue({ data: [{ id: 1, name: 'Item', price: 50, currency: 'EGP' }] });
    await expect(adapter.getProducts()).rejects.toThrow("Currency 'EGP' is currently inactive.");
});

test('places GET orders with dynamic query keys and a stable idempotency reference', async () => {
    client.get.mockResolvedValue(response());
    const params = { ...order, serverId: 'EU', providerProductId: '365', price: 9, empty: null };
    expect(await adapter.placeOrder(params)).toMatchObject({ success: true, providerOrderId: '482913', providerStatus: 'Completed' });
    await adapter.placeOrder(params);
    expect(client.get).toHaveBeenNthCalledWith(1, '/client/api/newOrder/365/params', {
        params: { qty: 2, order_uuid: 'ORDER-123', playerId: '5123456789', serverId: 'EU' },
    });
    expect(client.get.mock.calls[1]).toEqual(client.get.mock.calls[0]);
});

test('supports products without playerId and explicit UUID / quantity aliases', async () => {
    client.get.mockResolvedValue(response('wait'));
    expect(await adapter.placeOrder({ productId: 365, amount: 1, order_uuid: 'uuid-v4' })).toMatchObject({
        success: true, providerStatus: 'Pending',
    });
    expect(client.get).toHaveBeenCalledWith('/client/api/newOrder/365/params', {
        params: { qty: 1, order_uuid: 'uuid-v4' },
    });
});

test.each([100, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 120, 121, 122, 123, 500])(
    'treats HTTP 200 API error %s as a definite rejection', async (code) => {
        client.get.mockResolvedValue({ data: { status: 'ERROR', code, msg: 'Provider error' } });
        expect(await adapter.placeOrder(order)).toMatchObject({ success: false, errorCode: code, errorMessage: 'Provider error' });
        expect(client.get).toHaveBeenCalledTimes(1);
    }
);

test('maps a final rejected order to failure and retains its provider ID', async () => {
    client.get.mockResolvedValue(response('reject'));
    expect(await adapter.placeOrder(order)).toMatchObject({ success: false, providerOrderId: '482913', providerStatus: 'Cancelled' });
});

test.each([
    { referenceId: undefined }, { externalProductId: '../bad' }, { quantity: 0 }, { quantity: 1.5 },
])('validates placement before making requests: %j', async (overrides) => {
    expect(await adapter.placeOrder({ ...order, ...overrides })).toMatchObject({ success: false });
    expect(client.get).not.toHaveBeenCalled();
});

test('recovers a timed-out placement by UUID, without sending another purchase', async () => {
    client.get.mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))
        .mockResolvedValueOnce({ data: { status: 'OK', data: [{ order_id: '482913', order_uuid: order.referenceId, status: 'wait' }] } });
    expect(await adapter.placeOrder(order)).toMatchObject({ success: true, providerOrderId: '482913', providerStatus: 'Pending' });
    expect(client.get).toHaveBeenLastCalledWith('/client/api/check', {
        params: { uuid: 1, orders: '["ORDER-123"]' },
    });
    expect(client.get).toHaveBeenCalledTimes(2);
});

test.each(['missing', 'lookup-error', 'server-error', 'malformed'])('keeps ambiguous placement processing: %s', async (scenario) => {
    if (scenario === 'server-error') client.get.mockRejectedValueOnce(Object.assign(new Error('Server failure'), { response: { status: 500 } }));
    else if (scenario === 'malformed') client.get.mockResolvedValueOnce({ data: { status: 'OK' } });
    else client.get.mockRejectedValueOnce(new Error('connection reset'));
    if (scenario === 'lookup-error') client.get.mockRejectedValueOnce(new Error('lookup failed'));
    else client.get.mockResolvedValueOnce({ data: { status: 'OK', data: [] } });
    expect(await adapter.placeOrder(order)).toMatchObject({
        success: true, providerOrderId: null, providerStatus: 'PLACEMENT_UNCERTAIN',
    });
});

test('batch checks use bracketed IDs and map only requested rows', async () => {
    client.get.mockResolvedValue({ data: { status: 'OK', data: [
        { order_id: '1', status: 'accept', replay_api: ['Done'] },
        { order_id: '2', status: 'reject' }, { order_id: '3', status: 'wait' }, { order_id: '99', status: 'accept' },
    ] } });
    const results = await adapter.checkOrdersBatch([1, 2, 3]);
    expect(results.map((row) => row.unifiedStatus)).toEqual(['COMPLETED', 'FAILED', 'PENDING']);
    expect(results[0].rawResponse.replay_api).toEqual(['Done']);
    expect(client.get).toHaveBeenCalledWith('/client/api/check', { params: { orders: '[1,2,3]' } });
});

test('missing checks never cancel orders; empty batches do not call the API', async () => {
    expect(await adapter.checkOrders([])).toEqual([]);
    expect(client.get).not.toHaveBeenCalled();
    client.get.mockResolvedValue({ data: { status: 'OK', data: [] } });
    expect(await adapter.checkOrder('1')).toBeNull();
    expect(await adapter.checkOrderByReference('ORDER-123')).toEqual({ found: false });
});

test.each(['getProducts', 'getBalance', 'getContent', 'checkOrder', 'checkOrderByReference'])(
    '%s rejects HTTP 200 API errors', async (method) => {
        client.get.mockResolvedValue({ data: { status: 'ERROR', code: 123, msg: 'IP not allowed' } });
        await expect(adapter[method]('1')).rejects.toThrow('IP not allowed');
    }
);

test('fetches profile and category content using the documented routes', async () => {
    const profile = { balance: '8788.68', currency: 'USD', email: 'user@example.com' };
    client.get.mockResolvedValueOnce({ data: profile }).mockResolvedValueOnce({ data: { status: 'OK', categories: [], products: [] } });
    expect(await adapter.getMyInfo()).toEqual(profile);
    await adapter.getContent();
    expect(client.get).toHaveBeenNthCalledWith(1, '/client/api/profile');
    expect(client.get).toHaveBeenNthCalledWith(2, '/client/api/content/0');
});
