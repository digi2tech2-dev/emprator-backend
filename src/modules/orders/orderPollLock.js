"use strict";
const mongoose = require('mongoose');
const { randomUUID } = require('crypto');
const { hostname } = require('os');

// A timed lease could expire while a slow provider request is still in flight.
// Only recover automatically when this host confirms that the owning process died.
const isDeadLocalOwner = (lock) => {
    if (lock?.host !== hostname() || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) return false;
    try { process.kill(lock.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
};
const withOrderPollLock = async (work, skipped) => {
    const locks = mongoose.connection.collection('background_job_locks');
    const owner = randomUUID();
    const lock = { _id: 'order-status-poll', owner, pid: process.pid, host: hostname(), startedAt: new Date() };
    const writeConcern = { w: 'majority' };
    const insert = () => locks.insertOne(lock, { writeConcern });
    try {
        await insert();
    } catch (error) {
        if (error.code !== 11000) throw error;
        const previous = await locks.findOne({ _id: lock._id });
        if (previous && isDeadLocalOwner(previous)) {
            await locks.deleteOne({ _id: lock._id, owner: previous.owner }, { writeConcern });
            try { await insert(); }
            catch (retryError) {
                if (retryError.code !== 11000) throw retryError;
                console.warn('[OrderPolling] Skipping cycle: another poller owns the shared lock.');
                return skipped;
            }
            console.warn('[OrderPolling] Recovered lock from a confirmed dead local process.');
        } else {
            console.warn('[OrderPolling] Skipping cycle: another poller owns the shared lock.');
            return skipped;
        }
    }
    try { return await work(); }
    finally { await locks.deleteOne({ _id: lock._id, owner }, { writeConcern }); }
};
module.exports = { withOrderPollLock };
