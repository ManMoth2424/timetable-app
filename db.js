const { Pool } = require('pg');

// RenderのPostgreSQLは外部接続時にSSLが必要になることが多いため、
// 環境変数 PGSSL=true のときはSSLを有効にする。
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
});

module.exports = pool;
