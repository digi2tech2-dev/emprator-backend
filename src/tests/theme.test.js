'use strict';

const jwt = require('jsonwebtoken');
const { connectTestDB, disconnectTestDB, clearCollections, createCustomerWithGroup, createAdmin } = require('./testHelpers');
const { ThemeSettings, ThemeHistory } = require('../modules/theme/theme.model');
const { ThemeSubscription, ThemePayment, ThemeActivationCode, ThemeCodeUse } = require('../modules/theme/subscription.model');
const theme = require('../modules/theme/theme.service');
const manualPayment = require('../modules/theme/manualPayment.service');
const { preset, validateTheme, safeTheme } = require('../modules/theme/theme.validation');
const sharp = require('sharp');
const fs = require('fs/promises');
const path = require('path');

let server;
let baseUrl;
beforeAll(async () => {
    await connectTestDB();
    server = require('../app').listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await disconnectTestDB();
});
beforeEach(clearCollections);

const customer = async () => (await createCustomerWithGroup({
    phone: '01012345678', profileCompletedAt: new Date(),
})).customer;
const request = async (path, user, method = 'GET', body) => {
    const token = jwt.sign({ id: user._id.toString(), role: user.role }, process.env.JWT_SECRET);
    const response = await fetch(`${baseUrl}${path}`, { method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
};

test('admin draft and preview do not consume a free publish; cooldown and restore do', async () => {
    const user = await createAdmin();
    const configuration = preset('midnight');
    expect((await request('/api/admin/theme/preview/validate', user, 'POST', configuration)).status).toBe(200);
    expect((await request('/api/admin/theme/draft', user, 'POST', configuration)).status).toBe(200);
    expect((await theme.getStatus()).eligibility.canPublish).toBe(true);
    expect((await request('/api/admin/theme/publish', user, 'POST', configuration)).status).toBe(200);
    const locked = await request('/api/admin/theme/publish', user, 'POST', configuration);
    expect(locked.body.code).toBe('THEME_COOLDOWN');
    expect(locked.body.errors[0].value).toBeTruthy();
    expect((await request('/api/admin/theme/restore', user, 'POST', { version: 1 })).status).toBe(429);
    expect(await ThemeHistory.countDocuments({ scopeKey: 'main' })).toBe(1);
    expect((await theme.settings()).draft).toBeNull();
});

test('two simultaneous first publishes allow only one', async () => {
    const user = await createAdmin();
    const otherAdmin = await createAdmin({ phone: '01099998888' });
    const results = await Promise.allSettled([theme.publish(user._id, preset('classic')),
        theme.publish(otherAdmin._id, preset('midnight'))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await ThemeHistory.countDocuments({ scopeKey: 'main' })).toBe(1);
    expect((await request('/api/admin/theme/publish', otherAdmin, 'POST', preset('warm'))).status).toBe(429);
});

test('cooldown ends after rolling 30 days and paid publishing updates it', async () => {
    const user = await createAdmin();
    await theme.publish(user._id, preset('classic'));
    const old = new Date(Date.now() - 31 * 86400000);
    await ThemeSettings.updateOne({ scopeKey: 'main' }, { $set: { lastSuccessfulPublishAt: old } });
    expect((await theme.getStatus()).eligibility.canPublish).toBe(true);
    await theme.publish(user._id, preset('warm'));
    const startsAt = new Date(Date.now() - 1000);
    const payment = await ThemePayment.create({ scopeKey: 'main', payerUserId: user._id, provider: 'verified-test-fixture',
        providerReference: 'txn-1', amountMinor: 2499, currency: 'USD', status: 'VERIFIED', verifiedAt: startsAt });
    await ThemeSubscription.create({ scopeKey: 'main', payerUserId: user._id, planId: 'THEME_PRO', amountMinor: 2499,
        currency: 'USD', status: 'ACTIVE', verifiedPaymentId: payment._id,
        startsAt, expiresAt: theme.addCalendarMonthsUTC(startsAt, 3) });
    await theme.publish(user._id, preset('classic'));
    expect((await theme.getStatus()).eligibility.plan).toBe('THEME_PRO');
    await ThemeSubscription.updateOne({ scopeKey: 'main' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const status = (await theme.getStatus()).eligibility;
    expect(status.plan).toBe('FREE');
    expect(status.canPublish).toBe(false);
    expect(status.nextFreeEditAt.getTime()).toBeGreaterThan(Date.now());
});

test('three-month offer clamps month end and existing ten-month subscriptions remain valid', () => {
    expect(theme.plan.durationCalendarMonths).toBe(3);
    expect(theme.addCalendarMonthsUTC('2026-03-31T12:30:00.000Z', 10).toISOString()).toBe('2027-01-31T12:30:00.000Z');
    expect(theme.addCalendarMonthsUTC('2026-11-30T12:30:00.000Z', 3).toISOString()).toBe('2027-02-28T12:30:00.000Z');
    expect(theme.addCalendarMonthsUTC('2027-11-30T12:30:00.000Z', 3).toISOString()).toBe('2028-02-29T12:30:00.000Z');
});

test('an already activated ten-month subscription keeps its original expiry', async () => {
    const admin = await createAdmin();
    const startsAt = new Date(Date.now() - 1000);
    const payment = await ThemePayment.create({ scopeKey: 'main', payerUserId: admin._id,
        provider: 'MANUAL_USDT', providerReference: 'THEME-00000000-0000-4000-8000-000000000002',
        amountMinor: 2499, currency: 'USDT', status: 'VERIFIED', verifiedAt: startsAt,
        durationCalendarMonths: 10 });
    const subscription = await ThemeSubscription.create({ scopeKey: 'main', payerUserId: admin._id,
        planId: 'THEME_PRO', amountMinor: 2499, currency: 'USDT', status: 'ACTIVE',
        durationCalendarMonths: 10, verifiedPaymentId: payment._id,
        startsAt, expiresAt: theme.addCalendarMonthsUTC(startsAt, 10) });
    expect((await theme.getStatus()).eligibility.plan).toBe('THEME_PRO');
    expect((await theme.currentSubscription()).expiresAt.getTime()).toBe(subscription.expiresAt.getTime());
});

test('a pending payment cannot grant Theme Pro even if a subscription row says active', async () => {
    const user = await createAdmin();
    const payment = await ThemePayment.create({ scopeKey: 'main', payerUserId: user._id, provider: 'test-fixture',
        providerReference: 'pending-1', amountMinor: 2499, currency: 'USD', status: 'PENDING' });
    await ThemeSubscription.create({ scopeKey: 'main', payerUserId: user._id, planId: 'THEME_PRO', amountMinor: 2499,
        currency: 'USD', status: 'ACTIVE', verifiedPaymentId: payment._id,
        startsAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86400000) });
    expect((await theme.getStatus()).eligibility.plan).toBe('FREE');
});

test('strict dual-mode validation rejects injection, unknown keys, unsafe fonts and poor contrast', () => {
    expect(() => validateTheme({ ...preset('classic'), isAdmin: true })).toThrow();
    const base = preset('classic');
    expect(() => validateTheme({ ...base, modes: { ...base.modes, dark: { ...base.modes.dark,
        typography: { ...base.modes.dark.typography, englishFont: 'url(javascript:alert(1))' } } } })).toThrow();
    expect(() => validateTheme({ ...base, modes: { ...base.modes, light: { ...base.modes.light,
        colors: { ...base.modes.light.colors, primary: 'red; background:url(x)' } } } })).toThrow();
    expect(() => validateTheme({ ...base, modes: { ...base.modes, light: { ...base.modes.light,
        colors: { ...base.modes.light.colors, text: '#FFFFFF' } } } })).toThrow();
    expect(() => validateTheme({ ...base, brand: { ...base.brand, logoPath: 'javascript:alert(1)' } })).toThrow();
    expect(safeTheme({ bad: true })).toEqual(preset('classic'));
    const customText = preset('classic');
    customText.brand.marqueeTextArabic = 'أهلاً بك في المنصة';
    expect(validateTheme(customText).brand.marqueeTextArabic).toBe('أهلاً بك في المنصة');
    expect(() => validateTheme({ ...customText, brand: { ...customText.brand,
        marqueeTextArabic: '<script>أهلاً</script>' } })).toThrow();
});

test('ordinary users can see only the published platform theme', async () => {
    const admin = await createAdmin();
    const user = await customer();
    await theme.publish(admin._id, preset('midnight'));
    expect((await request('/api/admin/theme/settings', user)).status).toBe(403);
    expect((await request('/api/admin/theme/draft', user, 'POST', preset('classic'))).status).toBe(403);
    expect((await request('/api/admin/theme/publish', user, 'POST', preset('classic'))).status).toBe(403);
    expect((await request('/api/admin/theme/subscription/checkout', user, 'POST', {})).status).toBe(403);
    const response = await fetch(`${baseUrl}/api/theme/published`);
    expect(response.status).toBe(200);
    expect((await response.json()).data.published.modes.light.presetId).toBe('midnight');
    expect((await request('/api/theme/settings', user)).status).toBe(404);
    expect((await request('/api/subscriptions/current', user)).status).toBe(404);
});

test('free publishing permits separate light and dark colors but locks premium fonts and images', async () => {
    const admin = await createAdmin();
    const presetOptions = (await request('/api/admin/theme/presets', admin)).body.data.presets;
    const proIds = presetOptions.filter((item) => item.tier === 'THEME_PRO').map((item) => item.id);
    expect(proIds).toEqual(expect.arrayContaining(['gold', 'silver', 'copper', 'ruby', 'orchid', 'aurora', 'desert', 'frost']));
    expect(proIds).toHaveLength(13);
    for (const id of proIds) expect(validateTheme(preset(id))).toEqual(preset(id));
    const free = preset('classic');
    free.modes.dark = preset('warm').modes.dark;
    expect((await request('/api/admin/theme/publish', admin, 'POST', free)).status).toBe(200);
    const proFont = preset('classic');
    proFont.modes.dark.typography.arabicFont = 'Changa';
    expect((await request('/api/admin/theme/publish', admin, 'POST', proFont)).body.code).toBe('THEME_PRO_REQUIRED');
    const proBrand = preset('classic');
    proBrand.brand.logoPath = '/uploads/themes/1234567890123-0123456789abcdef.png';
    expect((await request('/api/admin/theme/publish', admin, 'POST', proBrand)).body.code).toBe('THEME_PRO_REQUIRED');
    for (const id of ['gold', 'silver']) {
        expect((await request('/api/admin/theme/publish', admin, 'POST', preset(id))).body.code).toBe('THEME_PRO_REQUIRED');
    }
    const neon = preset('classic');
    neon.modes.light.neon.categories.enabled = true;
    neon.modes.light.neon.categories.color = '#FF00FF';
    expect((await request('/api/admin/theme/publish', admin, 'POST', neon)).body.code).toBe('THEME_PRO_REQUIRED');
    neon.modes.light.neon.categories.color = 'url(javascript:alert(1))';
    expect((await request('/api/admin/theme/preview/validate', admin, 'POST', neon)).status).toBe(400);
    const perCategory = preset('classic');
    perCategory.modes.light.neon.categoryCards['507f1f77bcf86cd799439011'] = { enabled: true, color: '#FF00AA', speed: 3 };
    expect((await request('/api/admin/theme/publish', admin, 'POST', perCategory)).body.code).toBe('THEME_PRO_REQUIRED');
    perCategory.modes.light.neon.categoryCards['507f1f77bcf86cd799439011'].speed = 4;
    expect((await request('/api/admin/theme/preview/validate', admin, 'POST', perCategory)).status).toBe(400);
    perCategory.modes.light.neon.categoryCards = JSON.parse('{"__proto__":{"enabled":true,"color":"#FF00AA","speed":3}}');
    expect((await request('/api/admin/theme/preview/validate', admin, 'POST', perCategory)).status).toBe(400);
    expect((await request('/api/admin/theme/media/upload', admin, 'POST', {})).body.code).toBe('THEME_PRO_REQUIRED');
    const customMarquee = preset('classic');
    customMarquee.brand.marqueeTextArabic = 'عروض خاصة للمشتركين';
    expect((await request('/api/admin/theme/publish', admin, 'POST', customMarquee)).body.code).toBe('THEME_PRO_REQUIRED');
    expect(await ThemeHistory.countDocuments({ scopeKey: 'main' })).toBe(1);
});

test('manual USDT order stays pending until independently confirmed and cannot be confirmed twice', async () => {
    const admin = await createAdmin();
    const user = await customer();
    expect((await request('/api/admin/theme/subscription/manual-order', user, 'POST', { network: 'TRC20' })).status).toBe(403);
    const response = await request('/api/admin/theme/subscription/manual-order', admin, 'POST', { network: 'TRC20' });
    expect(response.status).toBe(200);
    expect(response.body.data.amount).toBe('24.99');
    expect(response.body.data.currency).toBe('USDT');
    expect(response.body.data.durationCalendarMonths).toBe(3);
    expect(response.body.data.whatsappUrl).toContain('wa.me/201019603238');
    expect(decodeURIComponent(response.body.data.whatsappUrl)).toContain(response.body.data.reference);
    expect((await theme.getStatus()).eligibility.plan).toBe('FREE');
    await expect(manualPayment.confirmReceived({ reference: response.body.data.reference, network: 'TRC20',
        chainTransactionId: 'abc123456789', reviewer: 'owner', receivedAmount: '24.98' })).rejects.toThrow();
    expect((await theme.getStatus()).eligibility.plan).toBe('FREE');
    const confirmed = await manualPayment.confirmReceived({ reference: response.body.data.reference, network: 'TRC20',
        chainTransactionId: 'abc123456789', reviewer: 'owner', receivedAmount: '24.99' });
    expect(confirmed.code).toMatch(/^\d{10}$/);
    expect(confirmed.codeExpiresAt.getTime()).toBeGreaterThan(Date.now());
    const storedCode = await ThemeActivationCode.findOne({ scopeKey: 'main' }).lean();
    expect(storedCode.codeHash).not.toBe(confirmed.code);
    expect(JSON.stringify(storedCode)).not.toContain(confirmed.code);
    expect((await theme.getStatus()).eligibility.plan).toBe('FREE');
    expect((await request('/api/admin/theme/subscription/redeem', user, 'POST',
        { reference: response.body.data.reference, code: confirmed.code })).status).toBe(403);
    expect((await request('/api/admin/theme/subscription/redeem', admin, 'POST',
        { reference: response.body.data.reference, code: '0000000000' })).body.code).toBe('CODE_INVALID');
    const redeemed = await request('/api/admin/theme/subscription/redeem', admin, 'POST',
        { reference: response.body.data.reference, code: confirmed.code });
    expect(redeemed.status).toBe(200);
    expect((await theme.getStatus()).eligibility.plan).toBe('THEME_PRO');
    const activated = await ThemeSubscription.findOne({ scopeKey: 'main' }).lean();
    expect(activated.durationCalendarMonths).toBe(3);
    expect(new Date(activated.expiresAt).getTime()).toBe(theme.addCalendarMonthsUTC(activated.startsAt, 3).getTime());
    expect((await request('/api/admin/theme/subscription/redeem', admin, 'POST',
        { reference: response.body.data.reference, code: confirmed.code })).status).toBe(409);
    expect((await ThemePayment.findOne({ providerReference: response.body.data.reference })).currency).toBe('USDT');
    expect((await ThemeSubscription.findOne({ scopeKey: 'main' })).currency).toBe('USDT');
    await expect(manualPayment.confirmReceived({ reference: response.body.data.reference, network: 'TRC20',
        chainTransactionId: 'abc123456789', reviewer: 'owner', receivedAmount: '24.99' })).rejects.toThrow();
    expect(await ThemeSubscription.countDocuments({ scopeKey: 'main' })).toBe(1);
    expect((await request('/api/admin/theme/subscription/manual-order', admin, 'POST', { network: 'TRC20' })).status).toBe(409);
});

test('a pending ten-month order keeps its terms while new orders use three months', async () => {
    const admin = await createAdmin();
    const reference = 'THEME-00000000-0000-4000-8000-000000000001';
    await ThemePayment.create({ scopeKey: 'main', payerUserId: admin._id, provider: 'MANUAL_USDT',
        providerReference: reference, amountMinor: 2499, currency: 'USDT', settlementCurrency: 'USDT',
        settlementAmount: '24.99', network: 'TRC20', destination: manualPayment.destinations.TRC20,
        durationCalendarMonths: 10, status: 'PENDING' });
    const reused = await request('/api/admin/theme/subscription/manual-order', admin, 'POST', { network: 'TRC20' });
    expect(reused.status).toBe(200);
    expect(reused.body.data.reference).not.toBe(reference);
    expect(reused.body.data.durationCalendarMonths).toBe(3);
    expect((await ThemePayment.findOne({ providerReference: reference })).durationCalendarMonths).toBe(10);
    expect((await ThemePayment.findOne({ providerReference: reused.body.data.reference })).durationCalendarMonths).toBe(3);
});

test('a chosen code is bound only after verified receipt and cannot be issued twice', async () => {
    const first = await createAdmin();
    const second = await createAdmin({ phone: '01099998888' });
    const chosenCode = '7418529630';
    const firstOrder = await request('/api/admin/theme/subscription/manual-order', first, 'POST', { network: 'TRC20' });
    const secondOrder = await request('/api/admin/theme/subscription/manual-order', second, 'POST', { network: 'BEP20' });
    expect((await request('/api/admin/theme/subscription/redeem', first, 'POST',
        { reference: firstOrder.body.data.reference, code: chosenCode })).body.code).toBe('PAYMENT_NOT_VERIFIED');
    const issued = await manualPayment.confirmReceived({ reference: firstOrder.body.data.reference,
        network: 'TRC20', chainTransactionId: 'chosen-code-tx-1', reviewer: 'owner',
        receivedAmount: '24.99', activationCode: chosenCode });
    expect(issued.code).toBe(chosenCode);
    expect((await ThemeCodeUse.findOne({ scopeKey: 'main' }).lean()).codeFingerprint).not.toContain(chosenCode);
    await expect(manualPayment.reissueCode({ reference: firstOrder.body.data.reference,
        reviewer: 'owner', activationCode: chosenCode })).rejects.toMatchObject({ code: 'CODE_ALREADY_ASSIGNED' });
    await expect(manualPayment.confirmReceived({ reference: secondOrder.body.data.reference,
        network: 'BEP20', chainTransactionId: 'chosen-code-tx-2', reviewer: 'owner',
        receivedAmount: '24.99', activationCode: chosenCode })).rejects.toMatchObject({ code: 'CODE_ALREADY_ASSIGNED' });
    expect((await ThemePayment.findOne({ providerReference: secondOrder.body.data.reference })).status).toBe('PENDING');
    expect((await request('/api/admin/theme/subscription/redeem', first, 'POST',
        { reference: firstOrder.body.data.reference, code: chosenCode })).status).toBe(200);
});

test('a temporary code expires, can be reissued, and cannot be used by another administrator', async () => {
    const first = await createAdmin();
    const second = await createAdmin({ phone: '01099998888' });
    const order = await request('/api/admin/theme/subscription/manual-order', first, 'POST', { network: 'BEP20' });
    const reference = order.body.data.reference;
    const confirmed = await manualPayment.confirmReceived({ reference, network: 'BEP20',
        chainTransactionId: 'differenttx98765', reviewer: 'owner', receivedAmount: '24.99' });
    expect((await request('/api/admin/theme/subscription/redeem', second, 'POST',
        { reference, code: confirmed.code })).status).toBe(404);
    expect((await request('/api/admin/theme/subscription/manual-order', first, 'POST', { network: 'TRC20' })).body.code).toBe('THEME_CODE_PENDING');
    await ThemeActivationCode.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request('/api/admin/theme/subscription/redeem', first, 'POST',
        { reference, code: confirmed.code })).body.code).toBe('CODE_EXPIRED');
    const reissued = await manualPayment.reissueCode({ reference, reviewer: 'owner' });
    expect(reissued.code).toMatch(/^\d{10}$/);
    expect((await request('/api/admin/theme/subscription/redeem', first, 'POST',
        { reference, code: confirmed.code })).body.code).toBe('CODE_INVALID');
    expect((await request('/api/admin/theme/subscription/redeem', first, 'POST',
        { reference, code: reissued.code })).status).toBe(200);
    await expect(manualPayment.reissueCode({ reference, reviewer: 'owner' })).rejects.toThrow();
});

test('payment status shows only the signed-in administrator’s transfer orders', async () => {
    const first = await createAdmin();
    const second = await createAdmin({ phone: '01099998888' });
    const firstOrder = await request('/api/admin/theme/subscription/manual-order', first, 'POST', { network: 'TRC20' });
    const secondOrder = await request('/api/admin/theme/subscription/manual-order', second, 'POST', { network: 'BEP20' });
    expect(firstOrder.status).toBe(200);
    expect(secondOrder.status).toBe(200);
    const status = await request('/api/admin/theme/subscription/payment-status', first);
    expect(status.status).toBe(200);
    expect(status.body.data.items.map((item) => item.providerReference)).toEqual([firstOrder.body.data.reference]);
});

test('verified Pro admin can upload and publish a logo with a premium preset', async () => {
    const admin = await createAdmin();
    const startsAt = new Date();
    const payment = await ThemePayment.create({ scopeKey: 'main', payerUserId: admin._id, provider: 'verified-test-fixture',
        providerReference: 'theme-media-paid', amountMinor: 2499, currency: 'USD', status: 'VERIFIED', verifiedAt: startsAt });
    await ThemeSubscription.create({ scopeKey: 'main', payerUserId: admin._id, planId: 'THEME_PRO', amountMinor: 2499,
        currency: 'USD', status: 'ACTIVE', verifiedPaymentId: payment._id,
        startsAt, expiresAt: theme.addCalendarMonthsUTC(startsAt, 3) });
    const bytes = await sharp({ create: { width: 128, height: 128, channels: 4,
        background: '#2563EB' } }).png().toBuffer();
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: 'image/png' }), 'logo.png');
    const token = jwt.sign({ id: admin._id.toString(), role: admin.role }, process.env.JWT_SECRET);
    const uploaded = await fetch(`${baseUrl}/api/admin/theme/media/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    expect(uploaded.status).toBe(200);
    const logoPath = (await uploaded.json()).data.path;
    try {
        const configuration = preset('gold');
        configuration.modes.dark = preset('silver').modes.dark;
        configuration.brand.logoPath = logoPath;
        configuration.brand.logoWidth = 220;
        configuration.brand.marqueeTextArabic = 'مرحبًا بك في عروض المنصة';
        configuration.modes.light.typography.arabicFont = 'Changa';
        configuration.modes.light.neon.purchase = { enabled: true, color: '#FF00CC', speed: 3 };
        configuration.modes.dark.neon.categories = { enabled: true, color: '#00FFAA', speed: 8 };
        configuration.modes.dark.neon.categoryCards['507f1f77bcf86cd799439011'] = { enabled: true, color: '#F0A500', speed: 12 };
        expect((await request('/api/admin/theme/publish', admin, 'POST', configuration)).status).toBe(200);
        expect((await theme.published()).published.brand.logoPath).toBe(logoPath);
        expect((await theme.published()).published.modes.light.presetId).toBe('gold');
        expect((await theme.published()).published.modes.dark.presetId).toBe('silver');
        expect((await theme.published()).published.brand.marqueeTextArabic).toBe('مرحبًا بك في عروض المنصة');
        expect((await theme.published()).published.modes.dark.neon.categories).toEqual({ enabled: true, color: '#00FFAA', speed: 8 });
        expect((await theme.published()).published.modes.dark.neon.categoryCards['507f1f77bcf86cd799439011'])
            .toEqual({ enabled: true, color: '#F0A500', speed: 12 });
    } finally {
        await fs.unlink(path.join(__dirname, '../..', logoPath.replace(/^\//, ''))).catch(() => undefined);
    }
});

test('a failed history write rolls back the publish and its cooldown', async () => {
    const user = await createAdmin();
    const original = ThemeHistory.create;
    const spy = jest.spyOn(ThemeHistory, 'create').mockRejectedValueOnce(new Error('history write failed'));
    await expect(theme.publish(user._id, preset('classic'))).rejects.toThrow('history write failed');
    spy.mockRestore();
    expect(ThemeHistory.create).toBe(original);
    expect(await ThemeSettings.countDocuments({ scopeKey: 'main' })).toBe(0);
    expect((await theme.getStatus()).eligibility.canPublish).toBe(true);
});

test('all admin theme endpoints are role protected and checkout is fail closed', async () => {
    const user = await customer();
    const admin = await createAdmin();
    for (const path of ['/settings', '/presets', '/history', '/entitlement', '/subscription', '/subscription/payment-status']) {
        expect((await request(`/api/admin/theme${path}`, user)).status).toBe(403);
        expect((await request(`/api/admin/theme${path}`, admin)).status).toBe(200);
    }
    expect((await request('/api/admin/theme/subscription/checkout', admin, 'POST', {})).status).toBe(503);
    expect(await ThemeSubscription.countDocuments({ scopeKey: 'main' })).toBe(0);
});
