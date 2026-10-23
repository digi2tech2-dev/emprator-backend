"use strict";
const DEFAULT_ORDER_POLL_INTERVAL_SECONDS = 10;
const getOrderPollSchedule = (env = process.env) => {
    const raw = String(env.ORDER_POLL_INTERVAL_SECONDS ?? '').trim();
    const seconds = raw ? Number(raw) : DEFAULT_ORDER_POLL_INTERVAL_SECONDS;
    if (![5, 10, 15, 20, 30, 60].includes(seconds)) {
        throw new Error('ORDER_POLL_INTERVAL_SECONDS must be one of 5, 10, 15, 20, 30, 60.');
    }
    return seconds === 60 ? '0 * * * * *' : `*/${seconds} * * * * *`;
};
// Count retry-budget windows independently of how often status is checked.
const POLL_RETRY_WINDOW_MS = 5 * 60 * 1000;
const nextPollingRetry = (order, now) => {
    const previous = order.lastRetryAt ? new Date(order.lastRetryAt).getTime() : NaN;
    const due = !Number.isFinite(previous) || now.getTime() - previous >= POLL_RETRY_WINDOW_MS;
    return {
        retryCount: Number(order.retryCount || 0) + (due ? 1 : 0),
        lastRetryAt: due ? now : order.lastRetryAt,
    };
};
module.exports = { getOrderPollSchedule, nextPollingRetry };
