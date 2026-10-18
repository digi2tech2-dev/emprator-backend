'use strict';

const fs = require('fs/promises');
const path = require('path');
const qrcode = require('qrcode');
const config = require('../../config/config');
const { Setting } = require('../admin/setting.model');

let Client = null;
let LocalAuth = null;
let dependencyLoadError = null;

try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
} catch (err) {
    dependencyLoadError = err;
}

const WHATSAPP_STATE = Object.freeze({
    IDLE: 'IDLE',
    INITIALIZING: 'INITIALIZING',
    QR_READY: 'QR_READY',
    AUTHENTICATED: 'AUTHENTICATED',
    CONNECTED: 'CONNECTED',
    DISCONNECTED: 'DISCONNECTED',
    ERROR: 'ERROR',
});

const AUTH_DATA_PATH = process.env.WHATSAPP_AUTH_DATA_PATH
    || path.join(process.cwd(), '.wwebjs_auth');
const CACHE_DATA_PATH = process.env.WHATSAPP_CACHE_DATA_PATH
    || path.join(process.cwd(), '.wwebjs_cache');

let client = null;
let currentQrCode = null;
let currentState = WHATSAPP_STATE.IDLE;
let lastError = null;
let isInitializing = false;
let reconnectTimer = null;
let manualShutdown = false;
let lifecycleOperationId = 0;

const setState = (state) => {
    currentState = state;
};

const setLastError = (err) => {
    lastError = err
        ? {
            message: err.message || String(err),
            at: new Date().toISOString(),
        }
        : null;
};

const normalizeAdminChatId = async () => {
    const record = await Setting.findOne({ key: 'adminNotificationWhatsApp' }).select('value').lean();
    const rawNumber = String(record?.value || '').trim();
    if (!rawNumber) return null;

    const normalized = rawNumber.replace(/[^\d]/g, '');
    return /^[1-9]\d{7,14}$/.test(normalized) ? `${normalized}@c.us` : null;
};

// User profiles in this application commonly store Egyptian mobile numbers in
// local form (for example, 01012345678). WhatsApp requires an international
// chat id, so convert that form without changing the value saved on the user.
const normalizeRecipientChatId = (rawNumber) => {
    let normalized = String(rawNumber || '').replace(/[^\d]/g, '');
    if (normalized.startsWith('00')) normalized = normalized.slice(2);
    if (normalized.startsWith('0') && normalized.length >= 10 && normalized.length <= 11) {
        normalized = `20${normalized.slice(1)}`;
    }
    if (!/^\d{8,15}$/.test(normalized)) return null;
    return `${normalized}@c.us`;
};

const getStatus = async () => ({
    state: currentState,
    qrCode: currentState === WHATSAPP_STATE.QR_READY ? currentQrCode : null,
    hasQrCode: Boolean(currentState === WHATSAPP_STATE.QR_READY && currentQrCode),
    isConnected: currentState === WHATSAPP_STATE.CONNECTED,
    isInitializing,
    adminNumberConfigured: Boolean(await normalizeAdminChatId()),
    dependencyAvailable: Boolean(Client && LocalAuth),
    lastError,
});

const scheduleReconnect = () => {
    if (manualShutdown || reconnectTimer || isInitializing) return;

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        initializeWhatsAppClient().catch((err) => {
            setLastError(err);
            setState(WHATSAPP_STATE.ERROR);
            console.error('[WhatsApp] automatic reconnect failed:', err.message);
        });
    }, Number(process.env.WHATSAPP_RECONNECT_DELAY_MS || 5000));
};

const attachClientEvents = (nextClient) => {
    nextClient.on('qr', async (qr) => {
        try {
            currentQrCode = await qrcode.toDataURL(qr);
            setLastError(null);
            setState(WHATSAPP_STATE.QR_READY);
            console.info('[WhatsApp] QR code ready.');
        } catch (err) {
            currentQrCode = null;
            setLastError(err);
            setState(WHATSAPP_STATE.ERROR);
            console.error('[WhatsApp] failed to generate QR code:', err.message);
        }
    });

    nextClient.on('authenticated', () => {
        currentQrCode = null;
        setLastError(null);
        setState(WHATSAPP_STATE.AUTHENTICATED);
        console.info('[WhatsApp] authenticated.');
    });

    nextClient.on('ready', () => {
        currentQrCode = null;
        setLastError(null);
        setState(WHATSAPP_STATE.CONNECTED);
        console.info('[WhatsApp] client ready.');
    });

    nextClient.on('auth_failure', (message) => {
        currentQrCode = null;
        setLastError(new Error(message || 'WhatsApp authentication failed.'));
        setState(WHATSAPP_STATE.ERROR);
        console.error('[WhatsApp] authentication failed:', message);
    });

    nextClient.on('disconnected', (reason) => {
        // Ignore stale disconnect events from an older client instance.
        if (client !== nextClient) return;

        currentQrCode = null;
        client = null;
        setLastError(reason ? new Error(String(reason)) : null);
        setState(WHATSAPP_STATE.DISCONNECTED);
        console.warn('[WhatsApp] disconnected:', reason || 'unknown reason');

        // Close the old Puppeteer/Chromium instance before starting another
        // client with the same LocalAuth userDataDir.
        Promise.resolve()
            .then(() => nextClient.destroy())
            .catch((err) => {
                console.warn('[WhatsApp] disconnected client cleanup failed:', err.message);
            })
            .finally(() => {
                scheduleReconnect();
            });
    });
};

const buildClient = () => {
    if (!Client || !LocalAuth) {
        throw new Error(
            `whatsapp-web.js is not installed or could not be loaded. ${dependencyLoadError?.message || ''}`.trim()
        );
    }

    return new Client({
        authStrategy: new LocalAuth({
            clientId: process.env.WHATSAPP_CLIENT_ID || 'admin-notifications',
            dataPath: AUTH_DATA_PATH,
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ],
        },
        webVersionCache: {
            type: 'none',
        },
    });
};

const destroyWhatsAppClient = async () => {
    manualShutdown = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    const existingClient = client;
    client = null;
    currentQrCode = null;

    if (existingClient) {
        try {
            await existingClient.destroy();
        } catch (err) {
            console.warn('[WhatsApp] destroy failed:', err.message);
        }
    }

    setState(WHATSAPP_STATE.DISCONNECTED);
    manualShutdown = false;
};

const initializeWhatsAppClient = async ({ force = false } = {}) => {
    if (config.safeLocalProductionMode) return getStatus();
    if (isInitializing && !force) return getStatus();
    if (client && !force) return getStatus();

    const operationId = ++lifecycleOperationId;
    let shouldReconnect = false;
    isInitializing = true;
    currentQrCode = null;
    setLastError(null);
    setState(WHATSAPP_STATE.INITIALIZING);

    try {
        if (force && client) {
            await destroyWhatsAppClient();
            setState(WHATSAPP_STATE.INITIALIZING);
        }

        manualShutdown = false;
        client = buildClient();
        attachClientEvents(client);
        await client.initialize();
        return getStatus();
    } catch (err) {
        const failedClient = client;

        if (operationId === lifecycleOperationId) {
            client = null;
            currentQrCode = null;
            setLastError(err);
            setState(WHATSAPP_STATE.ERROR);
            shouldReconnect = true;
        }

        // initialize() may fail after Chromium has already started.
        // Destroy that instance before retrying so LocalAuth is not locked.
        if (failedClient) {
            try {
                await failedClient.destroy();
            } catch (cleanupErr) {
                console.warn('[WhatsApp] failed initialization cleanup failed:', cleanupErr.message);
            }
        }

        console.error('[WhatsApp] initialization failed:', err.message);
        return getStatus();
    } finally {
        if (operationId === lifecycleOperationId) {
            isInitializing = false;

            if (shouldReconnect) {
                scheduleReconnect();
            }
        }
    }
};

const reconnectWhatsAppClient = async () => {
    await destroyWhatsAppClient();
    return initializeWhatsAppClient({ force: true });
};

const deleteSessionDirectories = async () => {
    await Promise.all([
        fs.rm(AUTH_DATA_PATH, { recursive: true, force: true }),
        fs.rm(CACHE_DATA_PATH, { recursive: true, force: true }),
    ]);
};

const resetWhatsAppClient = async () => {
    lifecycleOperationId += 1;
    await destroyWhatsAppClient();
    await deleteSessionDirectories();
    return initializeWhatsAppClient({ force: true });
};

const sendAdminNotification = async (message) => {
    if (config.safeLocalProductionMode) return null;
    const chatId = await normalizeAdminChatId();

    if (!chatId) {
        throw new Error('The notification WhatsApp number is not configured in admin settings.');
    }

    if (!client || currentState !== WHATSAPP_STATE.CONNECTED) {
        throw new Error('WhatsApp client is not connected.');
    }

    const safeMessage = String(message || '').trim();
    if (!safeMessage) {
        throw new Error('WhatsApp notification message cannot be empty.');
    }

    return client.sendMessage(chatId, safeMessage);
};

// Sends only from the already connected server-side WhatsApp session. This is
// deliberately separate from adminNotificationWhatsApp: payment codes belong
// to the paying administrator's verified profile number, never an HTTP value.
const sendWhatsAppMessage = async (phone, message) => {
    if (config.safeLocalProductionMode) return { deliveryStatus: 'SKIPPED' };
    const chatId = normalizeRecipientChatId(phone);
    if (!chatId) throw new Error('The paying administrator does not have a valid WhatsApp phone number.');
    if (!client || currentState !== WHATSAPP_STATE.CONNECTED) {
        throw new Error('WhatsApp client is not connected.');
    }
    const safeMessage = String(message || '').trim();
    if (!safeMessage) throw new Error('WhatsApp notification message cannot be empty.');
    await client.sendMessage(chatId, safeMessage);
    return { deliveryStatus: 'SENT' };
};

module.exports = {
    WHATSAPP_STATE,
    initializeWhatsAppClient,
    reconnectWhatsAppClient,
    resetWhatsAppClient,
    destroyWhatsAppClient,
    getStatus,
    sendAdminNotification,
    sendWhatsAppMessage,
};
