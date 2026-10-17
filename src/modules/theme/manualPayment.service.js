'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { User } = require('../users/user.model');
const { ThemePayment, ThemeSubscription, ThemeActivationCode, ThemeCodeUse } = require('./subscription.model');
const { ThemeSettings } = require('./theme.model');
const themeService = require('./theme.service');
const { AppError, ValidationError } = require('../../shared/errors/AppError');

const amount = '24.99';
const whatsapp = '201019603238';
const destinations = Object.freeze({
    BINANCE_ID: '202657125',
    TRC20: 'TLDFTsLDpk9GkeSiD9oLUJuBJ4FZW8cU5b',
    BEP20: '0x5882e7536635340790eb9c33e6e914e0d3499b52',
});
const payeeName = 'ENG-SHARKAWY';
const CODE_LIFETIME_MS = 48 * 60 * 60 * 1000;
const makeCode = () => String(crypto.randomInt(0, 10_000_000_000)).padStart(10, '0');
const hashCode = (code, salt) => crypto.scryptSync(code, salt, 32).toString('hex');
const fingerprintCode = (code) => {
    const secret = process.env.THEME_CODE_PEPPER || process.env.JWT_SECRET;
    if (!secret) throw new AppError('The activation-code secret is not configured.', 503, 'CODE_SECRET_MISSING');
    return crypto.createHmac('sha256', secret).update(`platform-theme:${code}`).digest('hex');
};
const validReference = (reference) => /^THEME-[0-9A-F-]{36}$/.test(reference || '');
const validReviewer = (reviewer) => /^[A-Za-z0-9 ._-]{3,80}$/.test(reviewer || '');

const instructions = () => ({ amount, currency: 'USDT', amountMinor: 2499,
    durationCalendarMonths: 3, recurring: false, whatsapp, payeeName, destinations,
    activationCodeHours: 48,
    proof: 'Send the transfer screenshot and order reference in WhatsApp. After receipt is verified, an operator sends a one-time 10-digit code valid for 48 hours.' });

async function createOrder(payerUserId, network) {
    if (!Object.hasOwn(destinations, network)) throw new ValidationError('Unsupported USDT transfer network.');
    const status = await themeService.getStatus();
    if (status.eligibility.plan === 'THEME_PRO') throw new AppError('Theme Pro is already active.', 409, 'THEME_PRO_ACTIVE');
    const verified = await ThemePayment.findOne({ scopeKey: 'main', payerUserId, provider: 'MANUAL_USDT',
        status: 'VERIFIED' }).sort({ verifiedAt: -1 }).lean();
    if (verified && !(await ThemeSubscription.exists({ verifiedPaymentId: verified._id }))) {
        throw new AppError('A verified transfer is awaiting code redemption.', 409, 'THEME_CODE_PENDING');
    }
    let payment = await ThemePayment.findOne({ scopeKey: 'main', payerUserId, provider: 'MANUAL_USDT',
        network, status: 'PENDING', $or: [
            { durationCalendarMonths: 3 }, { durationCalendarMonths: { $exists: false } },
        ] }).sort({ createdAt: -1 }).lean();
    if (!payment) {
        payment = await ThemePayment.create({ scopeKey: 'main', payerUserId,
            provider: 'MANUAL_USDT', providerReference: `THEME-${crypto.randomUUID().toUpperCase()}`,
            amountMinor: 2499, currency: 'USDT', settlementCurrency: 'USDT', settlementAmount: amount,
            network, destination: destinations[network], durationCalendarMonths: 3, status: 'PENDING' });
    }
    const message = `طلب اشتراك Theme Customization Pro\n${payment.providerReference}\nالشبكة: ${network}\nالمبلغ: ${amount} USDT صافي\nوجهة التحويل: ${destinations[network]}\nسأرفق صورة إثبات التحويل. أرجو تأكيد وصول المبلغ.`;
    return { paymentId: payment._id, reference: payment.providerReference, status: payment.status,
        network, destination: destinations[network], amount, currency: 'USDT',
        durationCalendarMonths: payment.durationCalendarMonths ?? 3,
        whatsappUrl: `https://wa.me/${whatsapp}?text=${encodeURIComponent(message)}` };
}

// Operator-only function. It is intentionally not mounted on any HTTP route.
// The operator must independently verify the transfer in the developer's receiving account.
async function confirmReceived({ reference, network, chainTransactionId, reviewer, receivedAmount, activationCode }) {
    if (!validReference(reference) || !Object.hasOwn(destinations, network)
        || !/^[A-Za-z0-9:_-]{8,128}$/.test(chainTransactionId || '')
        || !validReviewer(reviewer) || receivedAmount !== amount
        || (activationCode !== undefined && !/^\d{10}$/.test(activationCode))) {
        throw new ValidationError('Valid order, network, transaction ID, reviewer and 24.99 USDT received amount are required.');
    }
    const code = activationCode ?? makeCode();
    const codeFingerprint = fingerprintCode(code);
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            await ThemeSettings.findOneAndUpdate({ scopeKey: 'main' },
                { $inc: { writeLock: 1 }, $setOnInsert: { scopeKey: 'main' } },
                { upsert: true, session });
            const payment = await ThemePayment.findOne({ provider: 'MANUAL_USDT', providerReference: reference,
                scopeKey: 'main', network, destination: destinations[network], status: 'PENDING',
                amountMinor: 2499, currency: 'USDT', settlementCurrency: 'USDT', settlementAmount: amount }).session(session);
            if (!payment) throw new AppError('Pending payment order was not found.', 409, 'PAYMENT_NOT_PENDING');
            const payer = await User.findById(payment.payerUserId).session(session).select('role status').lean();
            if (payer?.role !== 'ADMIN' || payer?.status !== 'ACTIVE') throw new AppError('The payer is not an active platform administrator.', 403, 'INVALID_PAYER');
            const now = new Date();
            const alreadyActive = await themeService.currentSubscription(now, session);
            if (alreadyActive) throw new AppError('Theme Pro is already active.', 409, 'THEME_PRO_ACTIVE');
            payment.status = 'VERIFIED';
            payment.verifiedAt = now;
            payment.chainTransactionId = chainTransactionId;
            payment.verifiedBy = reviewer;
            await payment.save({ session });
            const salt = crypto.randomBytes(16).toString('hex');
            const expiresAt = new Date(now.getTime() + CODE_LIFETIME_MS);
            await ThemeCodeUse.create([{ scopeKey: 'main', paymentId: payment._id,
                codeFingerprint, issuedAt: now }], { session });
            await ThemeActivationCode.create([{ scopeKey: 'main', paymentId: payment._id,
                payerUserId: payer._id, salt, codeHash: hashCode(code, salt), expiresAt, issuedBy: reviewer }], { session });
            result = { reference, code, codeExpiresAt: expiresAt };
        });
        return result;
    } catch (error) {
        if (error.code === 11000 && error.keyPattern?.codeFingerprint) {
            throw new AppError('This activation code has already been assigned.', 409, 'CODE_ALREADY_ASSIGNED');
        }
        throw error;
    } finally { await session.endSession(); }
}

// Operator-only recovery when a verified payer's code expired or was lost.
async function reissueCode({ reference, reviewer, activationCode }) {
    if (!validReference(reference) || !validReviewer(reviewer)
        || (activationCode !== undefined && !/^\d{10}$/.test(activationCode))) {
        throw new ValidationError('A valid reference, reviewer, and optional 10-digit code are required.');
    }
    const code = activationCode ?? makeCode();
    const codeFingerprint = fingerprintCode(code);
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            await ThemeSettings.findOneAndUpdate({ scopeKey: 'main' },
                { $inc: { writeLock: 1 }, $setOnInsert: { scopeKey: 'main' } }, { upsert: true, session });
            const payment = await ThemePayment.findOne({ scopeKey: 'main', provider: 'MANUAL_USDT',
                providerReference: reference, status: 'VERIFIED', amountMinor: 2499, currency: 'USDT' }).session(session);
            if (!payment) throw new AppError('Verified payment was not found.', 404, 'PAYMENT_NOT_VERIFIED');
            if (await ThemeSubscription.exists({ verifiedPaymentId: payment._id }).session(session)) {
                throw new AppError('This payment has already been redeemed.', 409, 'PAYMENT_REDEEMED');
            }
            const salt = crypto.randomBytes(16).toString('hex');
            const expiresAt = new Date(Date.now() + CODE_LIFETIME_MS);
            await ThemeCodeUse.create([{ scopeKey: 'main', paymentId: payment._id,
                codeFingerprint, issuedAt: new Date() }], { session });
            const record = await ThemeActivationCode.findOneAndUpdate({ paymentId: payment._id, redeemedAt: null },
                { $set: { salt, codeHash: hashCode(code, salt), expiresAt, issuedBy: reviewer },
                    $inc: { issueCount: 1 } }, { new: true, session });
            if (!record) throw new AppError('Unredeemed activation code was not found.', 409, 'CODE_NOT_REISSUABLE');
            result = { reference, code, codeExpiresAt: expiresAt };
        });
        return result;
    } catch (error) {
        if (error.code === 11000 && error.keyPattern?.codeFingerprint) {
            throw new AppError('This activation code has already been assigned.', 409, 'CODE_ALREADY_ASSIGNED');
        }
        throw error;
    } finally { await session.endSession(); }
}

async function redeemCode(payerUserId, reference, code) {
    if (!validReference(reference) || !/^\d{10}$/.test(code || '')) {
        throw new ValidationError('Order reference and 10-digit activation code are required.');
    }
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            await ThemeSettings.findOneAndUpdate({ scopeKey: 'main' },
                { $inc: { writeLock: 1 }, $setOnInsert: { scopeKey: 'main' } }, { upsert: true, session });
            const payer = await User.findById(payerUserId).session(session).select('role status').lean();
            if (payer?.role !== 'ADMIN' || payer?.status !== 'ACTIVE') throw new AppError('Only an active administrator can redeem a code.', 403, 'INVALID_PAYER');
            const payment = await ThemePayment.findOne({ scopeKey: 'main', payerUserId,
                provider: 'MANUAL_USDT', providerReference: reference, status: 'VERIFIED',
                amountMinor: 2499, currency: 'USDT', settlementAmount: amount }).session(session);
            if (!payment) throw new AppError('Verified payment was not found.', 404, 'PAYMENT_NOT_VERIFIED');
            const activation = await ThemeActivationCode.findOne({ paymentId: payment._id, payerUserId }).session(session);
            if (!activation || activation.redeemedAt) throw new AppError('Activation code is unavailable.', 409, 'CODE_UNAVAILABLE');
            const now = new Date();
            if (activation.expiresAt <= now) throw new AppError('Activation code expired. Request a new code.', 410, 'CODE_EXPIRED');
            const submitted = Buffer.from(hashCode(code, activation.salt), 'hex');
            if (!crypto.timingSafeEqual(submitted, Buffer.from(activation.codeHash, 'hex'))) {
                throw new AppError('Activation code is incorrect.', 400, 'CODE_INVALID');
            }
            if (await themeService.currentSubscription(now, session)) {
                throw new AppError('Theme Pro is already active.', 409, 'THEME_PRO_ACTIVE');
            }
            const subscription = await ThemeSubscription.create([{ scopeKey: 'main', payerUserId,
                planId: 'THEME_PRO', amountMinor: 2499, currency: 'USDT', status: 'ACTIVE',
                durationCalendarMonths: payment.durationCalendarMonths ?? 3,
                verifiedPaymentId: payment._id, startsAt: now,
                expiresAt: themeService.addCalendarMonthsUTC(now, payment.durationCalendarMonths ?? 3) }], { session });
            activation.redeemedAt = now;
            await activation.save({ session });
            result = { plan: 'THEME_PRO', subscriptionId: subscription[0]._id, expiresAt: subscription[0].expiresAt };
        });
        return result;
    } finally { await session.endSession(); }
}

module.exports = { instructions, createOrder, confirmReceived, reissueCode, redeemCode, destinations };
