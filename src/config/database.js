'use strict';

const mongoose = require('mongoose');
const dns = require('node:dns');
const { isIP } = require('node:net');

const configureMongoDns = () => {
  const configured = String(process.env.MONGO_DNS_SERVERS || '').trim();
  if (!configured || !String(process.env.MONGO_URI || '').startsWith('mongodb+srv://')) return;
  const servers = configured.split(',').map((server) => server.trim());
  if (servers.some((server) => !isIP(server))) {
    throw new Error('MONGO_DNS_SERVERS must be a comma-separated list of IP addresses.');
  }
  dns.setServers(servers);
};

const connectDB = async () => {
  try {
    configureMongoDns();
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Modern Mongoose doesn't need deprecated options
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('✅ MongoDB reconnected');
});

module.exports = connectDB;
