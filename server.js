require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const pool = require('./db');

const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(
  session({
    store: new pgSession({ pool, tableName: 'session', createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7日間
  })
);

const DAYS = ['月', '火', '水', '木', '金'];
const PERIODS = [1, 2, 3, 4, 5, 6];

// ---------- 認証まわりのミドルウェア ----------
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('この操作には管理者権限が必要です');
  }
  next();
}

async function checkAccess(user, classId) {
  if (user.role === 'admin') return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM user_class_access WHERE user_id=$1 AND class_id=$2',
    [user.id, classId]
  );
  return rows.length > 0;
}

// ---------- ログイン / ログアウト ----------
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.render('login', { error: 'ユーザー名またはパスワードが違います' });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- クラス一覧(ダッシュボード) ----------
app.get('/', requireLogin, async (req, res) => {
  const user = req.session.user;
  let classes;
  if (user.role === 'admin') {
    classes = (await pool.query('SELECT * FROM classes ORDER BY name')).rows;
  } else {
    classes = (
      await pool.query(
        `SELECT c.* FROM classes c
         JOIN user_class_access uca ON uca.class_id = c.id
         WHERE uca.user_id = $1
         ORDER BY c.name`,
        [user.id]
      )
    ).rows;
  }
  res.render('dashboard', { user, classes });
});

// ---------- 時間割の表示 ----------
app.get('/timetable/:classId', requireLogin, async (req, res) => {
  const user = req.session.user;
  const classId = req.params.classId;

  const allowed = await checkAccess(user, classId);
  if (!allowed) return res.status(403).send('このクラスの時間割にアクセスする権限がありません');

  const cls = (await pool.query('SELECT * FROM classes WHERE id=$1', [classId])).rows[0];
  if (!cls) return res.status(404).send('クラスが見つかりません');

  const entries = (await pool.query('SELECT * FROM timetable_entries WHERE class_id=$1', [classId])).rows;
  const grid = {};
  entries.forEach((e) => {
    grid[`${e.day_of_week}_${e.period}`] = e.subject;
  });

  const canEdit = user.role === 'admin' || user.role === 'editor';

  res.render('timetable', { user, cls, grid, DAYS, PERIODS, canEdit });
});

// ---------- 時間割の保存 ----------
app.post('/timetable/:classId', requireLogin, async (req, res) => {
  const user = req.session.user;
  const classId = req.params.classId;

  const allowed = await checkAccess(user, classId);
  const canEdit = allowed && (user.role === 'admin' || user.role === 'editor');
  if (!canEdit) return res.status(403).send('編集する権限がありません');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const day of [1, 2, 3, 4, 5]) {
      for (const period of PERIODS) {
        const key = `subject_${day}_${period}`;
        const subject = (req.body[key] || '').trim();
        await client.query(
          `INSERT INTO timetable_entries (class_id, day_of_week, period, subject)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (class_id, day_of_week, period)
           DO UPDATE SET subject = EXCLUDED.subject`,
          [classId, day, period, subject]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.redirect(`/timetable/${classId}`);
});

// ---------- 管理者: ユーザー管理 ----------
app.get('/admin/users', requireAdmin, async (req, res) => {
  const users = (await pool.query('SELECT * FROM users ORDER BY id')).rows;
  const classes = (await pool.query('SELECT * FROM classes ORDER BY name')).rows;
  const accessRows = (await pool.query('SELECT * FROM user_class_access')).rows;
  const accessMap = {};
  accessRows.forEach((r) => {
    accessMap[r.user_id] = accessMap[r.user_id] || [];
    accessMap[r.user_id].push(r.class_id);
  });
  res.render('admin_users', { users, classes, accessMap });
});

app.post('/admin/users', requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  let classIds = req.body.classIds || [];
  if (!Array.isArray(classIds)) classIds = [classIds];

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
    [username, hash, role]
  );
  const userId = rows[0].id;

  for (const cid of classIds) {
    await pool.query(
      'INSERT INTO user_class_access (user_id, class_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, cid]
    );
  }

  res.redirect('/admin/users');
});

app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/password', requireAdmin, async (req, res) => {
  const hash = await bcrypt.hash(req.body.password, 10);
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
  res.redirect('/admin/users');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`サーバー起動: http://localhost:${PORT}`));
