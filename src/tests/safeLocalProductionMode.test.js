'use strict';

const config = require('../config/config');
const { startDefaultSettingsSeed } = require('../shared/startup/defaultSettingsSeed');
const { startServer } = require('../server');
const { sendEmail } = require('../services/email.service');
const whatsappService = require('../modules/whatsapp/whatsapp.service');

describe('SAFE_LOCAL_PRODUCTION_MODE', () => {
    const originalSafeMode = config.safeLocalProductionMode;
    const originalJobs = process.env.BACKGROUND_JOBS_ENABLED;
    const originalWhatsApp = process.env.WHATSAPP_AUTO_INIT;

    afterEach(() => {
        config.safeLocalProductionMode = originalSafeMode;
        if (originalJobs === undefined) delete process.env.BACKGROUND_JOBS_ENABLED;
        else process.env.BACKGROUND_JOBS_ENABLED = originalJobs;
        if (originalWhatsApp === undefined) delete process.env.WHATSAPP_AUTO_INIT;
        else process.env.WHATSAPP_AUTO_INIT = originalWhatsApp;
    });

    test('skips implicit settings seed in safe mode', () => {
        const seed = jest.fn();
        expect(startDefaultSettingsSeed({ safeLocalProductionMode: true, seed })).toBe(false);
        expect(seed).not.toHaveBeenCalled();
    });

    test('overrides jobs and WhatsApp initialization without opening a listener', async () => {
        config.safeLocalProductionMode = true;
        const appInstance = { listen: jest.fn((_port, handler) => { handler(); return { close: jest.fn() }; }) };
        const fulfillment = { start: jest.fn(), stop: jest.fn() };
        const providerSync = { start: jest.fn(), stop: jest.fn() };
        const whatsapp = { initializeWhatsAppClient: jest.fn(), destroyWhatsAppClient: jest.fn().mockResolvedValue() };

        await startServer({ appInstance, connectDatabase: jest.fn(), fulfillment, providerSync, whatsapp, registerProcessHandlers: false, exitOnFailure: false });
        expect(fulfillment.start).not.toHaveBeenCalled();
        expect(providerSync.start).not.toHaveBeenCalled();
        expect(whatsapp.initializeWhatsAppClient).not.toHaveBeenCalled();
    });

    test('keeps existing disabled startup flags effective outside safe mode', async () => {
        config.safeLocalProductionMode = false;
        process.env.BACKGROUND_JOBS_ENABLED = 'false';
        process.env.WHATSAPP_AUTO_INIT = 'false';
        const appInstance = { listen: jest.fn((_port, handler) => { handler(); return { close: jest.fn() }; }) };
        const fulfillment = { start: jest.fn(), stop: jest.fn() };
        const providerSync = { start: jest.fn(), stop: jest.fn() };
        const whatsapp = { initializeWhatsAppClient: jest.fn(), destroyWhatsAppClient: jest.fn().mockResolvedValue() };

        await startServer({ appInstance, connectDatabase: jest.fn(), fulfillment, providerSync, whatsapp, registerProcessHandlers: false, exitOnFailure: false });
        expect(fulfillment.start).not.toHaveBeenCalled();
        expect(providerSync.start).not.toHaveBeenCalled();
        expect(whatsapp.initializeWhatsAppClient).not.toHaveBeenCalled();
    });

    test('makes outbound email and WhatsApp notifications no-ops', async () => {
        config.safeLocalProductionMode = true;
        await expect(sendEmail({ to: 'nobody@example.invalid', subject: 'test', text: 'test' })).resolves.toBeUndefined();
        // getStatus reads the configured admin number even in safe mode.
        // Keep this unit test independent of a database connection.
        const { Setting } = require('../modules/admin/setting.model');
        const statusSettings = jest.spyOn(Setting, 'findOne').mockReturnValue({
            select: () => ({ lean: async () => null }),
        });
        try {
            await expect(whatsappService.initializeWhatsAppClient()).resolves.toEqual(expect.any(Object));
        } finally { statusSettings.mockRestore(); }
        await expect(whatsappService.sendAdminNotification('must not send')).resolves.toBeNull();
    });
});


describe('production background job startup policy', () => {
    const originalEnv = { ...process.env };
    afterEach(() => { process.env = { ...originalEnv }; });
    const inputs = () => ({
        appInstance: { listen: jest.fn(() => ({ close: jest.fn() })) }, connectDatabase: jest.fn(),
        fulfillment: { start: jest.fn(), stop: jest.fn() }, providerSync: { start: jest.fn(), stop: jest.fn() },
        whatsapp: { initializeWhatsAppClient: jest.fn() }, registerProcessHandlers: false, exitOnFailure: false,
    });
    test('rejects accidental disable before database or listener initialization', async () => {
        Object.assign(process.env, { NODE_ENV: 'production', BACKGROUND_JOBS_ENABLED: 'false',
            BACKGROUND_JOBS_MAINTENANCE: 'false', BACKGROUND_JOBS_DISABLED_REASON: '' });
        const deps = inputs();
        await expect(startServer(deps)).rejects.toThrow('BACKGROUND_JOBS_MAINTENANCE');
        expect(deps.connectDatabase).not.toHaveBeenCalled();
        expect(deps.appInstance.listen).not.toHaveBeenCalled();
        expect(deps.fulfillment.start).not.toHaveBeenCalled();
    });
    test('acknowledged maintenance starts API with no background jobs', async () => {
        const oldSafeMode = config.safeLocalProductionMode;
        config.safeLocalProductionMode = false;
        Object.assign(process.env, { NODE_ENV: 'production', BACKGROUND_JOBS_ENABLED: 'false',
            BACKGROUND_JOBS_MAINTENANCE: 'true', BACKGROUND_JOBS_DISABLED_REASON: 'test maintenance', WHATSAPP_AUTO_INIT: 'false' });
        const deps = inputs();
        try {
            await startServer(deps);
            expect(deps.appInstance.listen).toHaveBeenCalledTimes(1);
            expect(deps.fulfillment.start).not.toHaveBeenCalled();
            expect(deps.providerSync.start).not.toHaveBeenCalled();
        } finally { config.safeLocalProductionMode = oldSafeMode; }
    });
});
