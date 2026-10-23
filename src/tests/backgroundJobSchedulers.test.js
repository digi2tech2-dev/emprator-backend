"use strict";
jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../modules/orders/orderFulfillment.service', () => ({ pollProcessingOrders: jest.fn().mockResolvedValue({ checked: 0 }) }));
const { pollProcessingOrders } = require('../modules/orders/orderFulfillment.service');
const cron = require('node-cron');
const jobs = [
    require('../modules/orders/fulfillmentJob'),
    require('../modules/orders/orderPolling.job'),
    require('../modules/providers/syncProvidersJob'),
];
const originalEnv = { ...process.env };
afterEach(() => { jobs.forEach(job => job.stop()); process.env = { ...originalEnv }; });
test('all schedulers respect explicit production maintenance', () => {
    Object.assign(process.env, { NODE_ENV: 'production', SAFE_LOCAL_PRODUCTION_MODE: 'false',
        BACKGROUND_JOBS_ENABLED: 'false', BACKGROUND_JOBS_MAINTENANCE: 'true',
        BACKGROUND_JOBS_DISABLED_REASON: 'test maintenance' });
    jobs.forEach(job => job.start());
    expect(cron.schedule).not.toHaveBeenCalled();
});
test('fulfillment checks immediately, schedules ten seconds and ignores duplicate starts', async () => {
    Object.assign(process.env, { NODE_ENV: 'production', SAFE_LOCAL_PRODUCTION_MODE: 'false', BACKGROUND_JOBS_ENABLED: 'true' });
    delete process.env.ORDER_POLL_INTERVAL_SECONDS;
    jobs[0].start(); jobs[0].start();
    await new Promise(setImmediate);
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.schedule).toHaveBeenCalledWith('*/10 * * * * *', expect.any(Function));
    expect(pollProcessingOrders).toHaveBeenCalledTimes(1);
});


test('fast ticks do not overlap the immediate in-flight cycle', async () => {
    Object.assign(process.env, { NODE_ENV: 'production', SAFE_LOCAL_PRODUCTION_MODE: 'false', BACKGROUND_JOBS_ENABLED: 'true' });
    let release;
    pollProcessingOrders.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    jobs[0].start();
    try {
        const tick = cron.schedule.mock.calls[0][1];
        await tick();
        expect(pollProcessingOrders).toHaveBeenCalledTimes(1);
    } finally {
        release({ checked: 0 });
        await new Promise(setImmediate);
    }
});
