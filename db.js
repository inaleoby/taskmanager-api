require('dotenv').config();
const { Pool } = require('pg');


const dbHost = process.env.DB_HOST;
const dbName = process.env.DB_NAME;
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD;
const dbPort = process.env.DB_PORT;
const dbSsl = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false;


const pool = new Pool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPassword,
  ssl: dbSsl
});

module.exports = pool;
