require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../db');

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '../schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('スキーマを適用しました(classesテーブルに2-1〜2-9を投入済み)');

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'changeme123';

  const { rows } = await pool.query('SELECT id FROM users WHERE username=$1', [adminUsername]);
  if (rows.length === 0) {
    const hash = await bcrypt.hash(adminPassword, 10);
    await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
      [adminUsername, hash, 'admin']
    );
    console.log(`管理者アカウントを作成しました → ユーザー名: ${adminUsername} / パスワード: ${adminPassword}`);
    console.log('※ ログイン後、パスワードを変更することを推奨します');
  } else {
    console.log('管理者アカウントは既に存在するため、作成をスキップしました');
  }

  await pool.end();
}

main().catch((e) => {
  console.error('初期化中にエラーが発生しました:', e);
  process.exit(1);
});
