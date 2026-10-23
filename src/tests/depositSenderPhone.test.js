"use strict";
jest.mock('../modules/notifications/notification.service', () => ({
    notifyNewDeposit: jest.fn(), notifyDepositApproved: jest.fn(), notifyDepositRejected: jest.fn(),
}));
jest.mock('../modules/whatsapp/whatsapp.service', () => ({ sendAdminNotification: jest.fn().mockResolvedValue(null) }));
const jwt = require('jsonwebtoken');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const config = require('../config/config');
const { connectTestDB, disconnectTestDB, clearCollections, createCustomerWithGroup, createAdmin } = require('./testHelpers');
const { Currency } = require('../modules/currency/currency.model');
const { DepositRequest } = require('../modules/deposits/deposit.model');
const { User } = require('../modules/users/user.model');
const { AuditLog } = require('../modules/audit/audit.model');
const { Setting } = require('../modules/admin/setting.model');
const { invalidateSettingsCache } = require('../modules/admin/admin.settings.service');
const service = require('../modules/deposits/deposit.service');
let server, baseUrl, customer, admin, image;
const uploads = new Set();
const token = user => jwt.sign({ id: String(user._id) }, config.jwt.secret, { expiresIn: '1h' });
const request = async (route, { user = customer, method = 'GET', fields, receipt, mime = 'image/png' } = {}) => {
    const headers = user ? { Authorization: `Bearer ${token(user)}` } : {};
    let body;
    if (receipt) {
        body = new FormData();
        for (const [key, value] of Object.entries(fields || {})) body.append(key, typeof value === 'object' ? JSON.stringify(value) : value);
        body.append('receipt', new Blob([receipt], { type: mime }), 'sender-phone-test.png');
    } else if (fields) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(fields); }
    const response = await fetch(`${baseUrl}${route}`, { method, headers, body });
    const json = await response.json();
    if (json.data?.receiptImage) uploads.add(json.data.receiptImage);
    return { status: response.status, body: json };
};
const fields = overrides => ({ requestedAmount: '125.50', currency: 'USD', paymentMethodId: 'vodafone',
    senderPhoneNumber: '  +966 (50) 123-4567  ', ...overrides });
beforeAll(async () => {
    await connectTestDB();
    const pixels = Buffer.alloc(64 * 64 * 3);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 73 + Math.floor(i / 13)) % 256;
    image = await sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
    const app = require('../app');
    await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await disconnectTestDB();
});
beforeEach(async () => {
    await clearCollections();
    invalidateSettingsCache('paymentGroups');
    await Currency.create({ code: 'USD', name: 'US Dollar', symbol: '$', platformRate: 1 });
    await Setting.create({ key: 'paymentGroups', value: [{ id: 'test-group', name: 'Test payments', methods: [
        { id: 'vodafone', name: 'Vodafone Cash', type: 'mobile_wallet', isActive: true },
        { id: 'usdt-test', name: 'USDT', type: 'usdt', isActive: true },
    ] }] });
    ({ customer } = await createCustomerWithGroup({ currency: 'USD', walletBalance: 10, phone: '01012345678' }));
    admin = await createAdmin();
});
afterEach(async () => {
    const root = path.resolve(__dirname, '../..');
    for (const receipt of uploads) {
        const file = path.resolve(root, receipt);
        if (file.startsWith(path.join(root, 'uploads', 'deposits') + path.sep)) await fs.unlink(file).catch(() => {});
    }
    uploads.clear();
});

test.each(['/api/deposits', '/api/me/deposits'])('%s accepts phone+receipt and keeps API, history and admin review compatible', async route => {
    const result = await request(route, { method: 'POST', fields: fields({ amountUsd: '99999', status: 'APPROVED' }), receipt: image });
    expect(result.status).toBe(201);
    const deposit = result.body.data;
    expect(deposit).toMatchObject({ requestedAmount: 125.5, amountUsd: 125.5, status: 'PENDING', transactionId: null,
        senderDetails: { field: 'senderPhoneNumber', value: '+966501234567' } });
    expect(deposit.receiptImage).toMatch(/^uploads\/deposits\//);
    expect((await User.findById(customer._id)).walletBalance).toBe(10);
    const history = await request('/api/me/deposits');
    expect(history.body.data.some(item => item._id === deposit._id && item.senderDetails.value === '+966501234567')).toBe(true);
    const own = await request(`/api/me/deposits/${deposit._id}`);
    expect(own.body.data.senderDetails.field).toBe('senderPhoneNumber');
    const listing = await request('/api/admin/deposits', { user: admin });
    expect(listing.body.data.find(item => item._id === deposit._id).senderDetails.value).toBe('+966501234567');
    const review = await request(`/api/admin/deposits/${deposit._id}`, { user: admin });
    expect(review.body.data.transactionId).toBeNull();
    const approval = await request(`/api/admin/deposits/${deposit._id}/approve`, { user: admin, method: 'PATCH', fields: {} });
    expect(approval.status).toBe(200);
    expect((await User.findById(customer._id)).walletBalance).toBe(135.5);
    expect((await DepositRequest.findById(deposit._id)).senderDetails.value).toBe('+966501234567');
    const again = await request(`/api/admin/deposits/${deposit._id}/approve`, { user: admin, method: 'PATCH', fields: {} });
    expect(again.status).toBe(422);
    expect((await User.findById(customer._id)).walletBalance).toBe(135.5);
});

test.each(['', '   ', '123', '1234567890123456', '+20abc1234567', '++201012345678', 1012345678, null])('rejects invalid or empty explicit phone: %j without logging it', async value => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
        const result = await request('/api/me/deposits', { method: 'POST', fields: fields({ senderPhoneNumber: value }) });
        expect(result.status).toBe(400);
        expect(await DepositRequest.countDocuments()).toBe(0);
        if (typeof value === 'string' && value.trim().length > 3) expect(JSON.stringify(log.mock.calls)).not.toContain(value);
    } finally { log.mockRestore(); }
});

test.each(['010 1234 5678', '+44 7700 900123', '\u0660\u0661\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668'])('normalizes local and international phones without assuming a country: %s', async phone => {
    const result = await request('/api/deposits', { method: 'POST', fields: fields({ senderPhoneNumber: phone }), receipt: image });
    expect(result.status).toBe(201);
    expect(result.body.data.senderDetails.value).toMatch(/^\+?[0-9]{7,15}$/);
});

test.each(['/api/deposits', '/api/me/deposits'])('%s requires receipt for the phone flow even on an electronic wallet', async route => {
    const result = await request(route, { method: 'POST', fields: fields() });
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('RECEIPT_REQUIRED');
    expect(await DepositRequest.countDocuments()).toBe(0);
});

test('retains receipt image analysis and rejects a blank image', async () => {
    const blank = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const result = await request('/api/deposits', { method: 'POST', fields: fields(), receipt: blank });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_RECEIPT_IMAGE');
    expect(await DepositRequest.countDocuments()).toBe(0);
});

test('legacy transaction clients still submit without a wallet receipt and keep duplicate-reference protection', async () => {
    const legacy = fields({ transactionId: ' 022494991382 ' }); delete legacy.senderPhoneNumber;
    const result = await request('/api/me/deposits', { method: 'POST', fields: legacy });
    expect(result.status).toBe(201);
    expect(result.body.data.transactionId).toBe('022494991382');
    expect(result.body.data.senderDetails?.field).not.toBe('senderPhoneNumber');
    const duplicate = await request('/api/deposits', { method: 'POST', fields: legacy });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.code).toBe('TRANSACTION_ID_ALREADY_USED');
});

test('reads and approves a legacy deposit without reinterpreting its stored transaction number', async () => {
    const old = await DepositRequest.create({ userId: customer._id, paymentMethodId: 'vodafone',
        requestedAmount: 20, currency: 'USD', exchangeRate: 1, amountUsd: 20, transactionId: '01012345678',
        paymentTransactionId: 'older-reference', senderDetails: { value: 'old wallet reference', field: 'senderWalletNumber' } });
    const detail = await request(`/api/admin/deposits/${old._id}`, { user: admin });
    expect(detail.body.data.transactionId).toBe('01012345678');
    expect(detail.body.data.senderDetails.field).toBe('senderWalletNumber');
    await request(`/api/admin/deposits/${old._id}/approve`, { user: admin, method: 'PATCH', fields: {} });
    const fresh = await DepositRequest.findById(old._id);
    expect(fresh.transactionId).toBe('01012345678');
    expect(fresh.paymentTransactionId).toBe('older-reference');
    expect(fresh.senderDetails.value).toBe('old wallet reference');
});

test('keeps sender wallet addresses unchanged for non-phone methods', async () => {
    const payload = fields({ paymentMethodId: 'usdt-test', senderWalletAddress: '0x-test-wallet-address' });
    delete payload.senderPhoneNumber;
    const result = await request('/api/deposits', { method: 'POST', fields: payload, receipt: image });
    expect(result.status).toBe(201);
    expect(result.body.data.senderDetails).toMatchObject({ field: 'senderWalletAddress', value: '0x-test-wallet-address' });
});

test('direct service callers validate phone and reject conflicting details, while phone is never unique', async () => {
    const base = { userId: customer._id, paymentMethodId: 'vodafone', isElectronicWallet: true,
        requestedAmount: 20, amountUsd: 20, exchangeRate: 1, currency: 'USD', receiptImage: 'uploads/deposits/test-only-not-a-file.png' };
    await expect(service.createDepositRequest({ ...base, senderPhoneNumber: '' })).rejects.toMatchObject({ code: 'PHONE_REQUIRED' });
    await expect(service.createDepositRequest({ ...base, senderPhoneNumber: '01012345678',
        senderDetails: { field: 'senderPhoneNumber', value: '01112345678' } })).rejects.toMatchObject({ code: 'SENDER_DETAILS_CONFLICT' });
    const one = await service.createDepositRequest({ ...base, senderPhoneNumber: '01012345678' });
    const two = await service.createDepositRequest({ ...base, senderPhoneNumber: '01012345678' });
    expect(String(one._id)).not.toBe(String(two._id));
    expect(two.status).toBe('PENDING');
    await new Promise(resolve => setTimeout(resolve, 60));
    const audit = await AuditLog.findOne({ entityId: one._id });
    expect(audit.metadata.senderDetails.value).toBe('[REDACTED]');
});

test('ownership and admin approval permissions remain enforced', async () => {
    const created = await request('/api/deposits', { method: 'POST', fields: fields(), receipt: image });
    const { customer: other } = await createCustomerWithGroup({ phone: '01112345678' });
    expect((await request(`/api/me/deposits/${created.body.data._id}`, { user: other })).status).toBe(403);
    expect((await request(`/api/admin/deposits/${created.body.data._id}/approve`, { method: 'PATCH', fields: {} })).status).toBe(403);
    expect((await request('/api/deposits', { user: null, method: 'POST', fields: fields() })).status).toBe(401);
});
