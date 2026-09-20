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

const DAYS = ['月', '火', '水', '木', '金', '土'];
const PERIODS = [1, 2, 3, 4, 5, 6];

// その曜日の最大時限数(土曜は4限まで)
function maxPeriodForDay(day) {
  return day === 6 ? 4 : 6;
}

// ---------- 日付まわりのヘルパー ----------

// "YYYY-MM-DD" 文字列 -> Dateオブジェクト(ローカル時間の0時)
function parseDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Dateオブジェクト -> "YYYY-MM-DD" 文字列
function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// 今日の日付文字列(YYYY-MM-DD)
function todayStr() {
  return formatDate(new Date());
}

// 与えられた日付が属する週の月曜日の日付文字列を返す
function mondayOfWeek(date) {
  const d = new Date(date);
  const jsDay = d.getDay(); // 0=日 ... 6=土
  const diff = jsDay === 0 ? -6 : 1 - jsDay;
  d.setDate(d.getDate() + diff);
  return formatDate(d);
}

// 日付から曜日(1=月...6=土)を返す。日曜はnull。
function dayOfWeekOf(date) {
  const jsDay = date.getDay();
  if (jsDay === 0) return null;
  return jsDay;
}

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

// 指定日の「曜日振替」設定を取得(なければnull)
async function getSubstituteDay(dateStr) {
  const row = (await pool.query('SELECT substitute_day FROM day_overrides WHERE change_date=$1', [dateStr])).rows[0];
  return row ? row.substitute_day : null;
}

// 指定クラス・指定日の「実際の時間割」(基本パターン+その日の変更)を計算する
async function getEffectiveSchedule(classId, dateStr) {
  const date = parseDateStr(dateStr);
  const actualDow = dayOfWeekOf(date); // カレンダー上の実際の曜日(日曜はnull)
  const substituteDay = await getSubstituteDay(dateStr);
  const effectiveDay = substituteDay || actualDow; // 基本パターンを引く際に使う曜日

  if (!effectiveDay) {
    return { actualDow, effectiveDay: null, substituteDay: null, weekType: null, maxPeriod: 0, entries: {} };
  }

  const monday = mondayOfWeek(date);
  const weekRow = (await pool.query('SELECT week_type FROM week_types WHERE week_start=$1', [monday])).rows[0];
  const weekType = weekRow ? weekRow.week_type : null;

  const entries = {};

  if (weekType) {
    const base = await pool.query(
      'SELECT period, subject FROM base_timetable_entries WHERE class_id=$1 AND week_type=$2 AND day_of_week=$3',
      [classId, weekType, effectiveDay]
    );
    base.rows.forEach((r) => {
      entries[r.period] = { subject: r.subject || '', changed: false };
    });
  }

  const changes = await pool.query(
    'SELECT period, subject FROM daily_changes WHERE class_id=$1 AND change_date=$2',
    [classId, dateStr]
  );
  changes.rows.forEach((r) => {
    entries[r.period] = { subject: r.subject || '', changed: true };
  });

  return {
    actualDow,
    effectiveDay,
    substituteDay,
    weekType,
    maxPeriod: maxPeriodForDay(effectiveDay),
    entries,
  };
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

// ---------- クラス別:指定日の実際の時間割の表示・編集 ----------
app.get('/timetable/:classId', requireLogin, async (req, res) => {
  const user = req.session.user;
  const classId = req.params.classId;

  const allowed = await checkAccess(user, classId);
  if (!allowed) return res.status(403).send('このクラスの時間割にアクセスする権限がありません');

  const cls = (await pool.query('SELECT * FROM classes WHERE id=$1', [classId])).rows[0];
  if (!cls) return res.status(404).send('クラスが見つかりません');

  const date = req.query.date || todayStr();
  const schedule = await getEffectiveSchedule(classId, date);
  const canEdit = user.role === 'admin' || user.role === 'editor';
  const actualLabel = schedule.actualDow ? `${DAYS[schedule.actualDow - 1]}曜日` : '休日';
  const effectiveLabel = schedule.effectiveDay ? `${DAYS[schedule.effectiveDay - 1]}曜日` : null;

  res.render('timetable', { user, cls, date, schedule, DAYS, PERIODS, canEdit, actualLabel, effectiveLabel });
});

app.post('/timetable/:classId', requireLogin, async (req, res) => {
  const user = req.session.user;
  const classId = req.params.classId;
  const date = req.body.date || todayStr();

  const allowed = await checkAccess(user, classId);
  const canEdit = allowed && (user.role === 'admin' || user.role === 'editor');
  if (!canEdit) return res.status(403).send('編集する権限がありません');

  const dow = dayOfWeekOf(parseDateStr(date));
  const substituteDay = await getSubstituteDay(date);
  const effectiveDay = substituteDay || dow;
  if (!effectiveDay) return res.redirect(`/timetable/${classId}?date=${date}`);

  const maxP = maxPeriodForDay(effectiveDay);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const period of PERIODS) {
      if (period > maxP) continue;
      const key = `subject_${period}`;
      const subject = (req.body[key] || '').trim();
      await client.query(
        `INSERT INTO daily_changes (class_id, change_date, period, subject)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (class_id, change_date, period)
         DO UPDATE SET subject = EXCLUDED.subject`,
        [classId, date, period, subject]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.redirect(`/timetable/${classId}?date=${date}`);
});

// ---------- 全クラス:指定日の実際の時間割の表示・編集(adminのみ編集可) ----------
app.get('/today', requireLogin, async (req, res) => {
  const user = req.session.user;
  const date = req.query.date || todayStr();
  const actualDow = dayOfWeekOf(parseDateStr(date));
  const substituteDay = await getSubstituteDay(date);
  const effectiveDay = substituteDay || actualDow;

  const classes = (await pool.query('SELECT * FROM classes ORDER BY name')).rows;

  const scheduleByClass = {};
  for (const cls of classes) {
    scheduleByClass[cls.id] = await getEffectiveSchedule(cls.id, date);
  }

  const canEdit = user.role === 'admin';
  const actualLabel = actualDow ? `${DAYS[actualDow - 1]}曜日` : '休日';
  const effectiveLabel = effectiveDay ? `${DAYS[effectiveDay - 1]}曜日` : null;
  const periods = effectiveDay ? PERIODS.filter((p) => p <= maxPeriodForDay(effectiveDay)) : [];

  res.render('today', {
    user,
    classes,
    date,
    effectiveDay,
    actualLabel,
    effectiveLabel,
    periods,
    scheduleByClass,
    canEdit,
  });
});

app.post('/today', requireAdmin, async (req, res) => {
  const date = req.body.date || todayStr();
  const dow = dayOfWeekOf(parseDateStr(date));
  const substituteDay = await getSubstituteDay(date);
  const effectiveDay = substituteDay || dow;
  if (!effectiveDay) return res.redirect(`/today?date=${date}`);

  const maxP = maxPeriodForDay(effectiveDay);
  const classes = (await pool.query('SELECT * FROM classes')).rows;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const cls of classes) {
      for (const period of PERIODS) {
        if (period > maxP) continue;
        const key = `subject_${cls.id}_${period}`;
        if (!(key in req.body)) continue; // このクラス・この時限は今回のフォームに含まれていない
        const subject = (req.body[key] || '').trim();
        await client.query(
          `INSERT INTO daily_changes (class_id, change_date, period, subject)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (class_id, change_date, period)
           DO UPDATE SET subject = EXCLUDED.subject`,
          [cls.id, date, period, subject]
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

  res.redirect(`/today?date=${date}`);
});

// ---------- 管理者: 基本パターン(A週/B週)の設定 ----------
app.get('/admin/base', requireAdmin, async (req, res) => {
  const classes = (await pool.query('SELECT * FROM classes ORDER BY name')).rows;
  const classId = req.query.classId || (classes[0] && classes[0].id);
  const weekType = req.query.weekType === 'B' ? 'B' : 'A';

  const cls = classes.find((c) => String(c.id) === String(classId));

  let grid = {};
  if (cls) {
    const rows = (
      await pool.query(
        'SELECT day_of_week, period, subject FROM base_timetable_entries WHERE class_id=$1 AND week_type=$2',
        [cls.id, weekType]
      )
    ).rows;
    rows.forEach((r) => {
      grid[`${r.day_of_week}_${r.period}`] = r.subject || '';
    });
  }

  res.render('admin_base', { user: req.session.user, classes, cls, weekType, grid, DAYS, PERIODS });
});

app.post('/admin/base', requireAdmin, async (req, res) => {
  const { classId, weekType } = req.body;
  if (!classId || (weekType !== 'A' && weekType !== 'B')) {
    return res.status(400).send('不正なパラメータです');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const day of [1, 2, 3, 4, 5, 6]) {
      const maxP = maxPeriodForDay(day);
      for (const period of PERIODS) {
        if (period > maxP) continue;
        const key = `subject_${day}_${period}`;
        const subject = (req.body[key] || '').trim();
        await client.query(
          `INSERT INTO base_timetable_entries (class_id, week_type, day_of_week, period, subject)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (class_id, week_type, day_of_week, period)
           DO UPDATE SET subject = EXCLUDED.subject`,
          [classId, weekType, day, period, subject]
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

  res.redirect(`/admin/base?classId=${classId}&weekType=${weekType}`);
});

// ---------- 管理者: 週タイプ(A週/B週)カレンダーの設定 ----------
app.get('/admin/weeks', requireAdmin, async (req, res) => {
  const weeks = (await pool.query('SELECT * FROM week_types ORDER BY week_start DESC')).rows;
  res.render('admin_weeks', { user: req.session.user, weeks });
});

app.post('/admin/weeks', requireAdmin, async (req, res) => {
  const { date, weekType } = req.body;
  if (!date || (weekType !== 'A' && weekType !== 'B')) {
    return res.status(400).send('不正なパラメータです');
  }
  const monday = mondayOfWeek(parseDateStr(date));
  await pool.query(
    `INSERT INTO week_types (week_start, week_type) VALUES ($1, $2)
     ON CONFLICT (week_start) DO UPDATE SET week_type = EXCLUDED.week_type`,
    [monday, weekType]
  );
  res.redirect('/admin/weeks');
});

app.post('/admin/weeks/:weekStart/delete', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM week_types WHERE week_start=$1', [req.params.weekStart]);
  res.redirect('/admin/weeks');
});

// ---------- 管理者: 曜日振替の設定 ----------
app.get('/admin/day-overrides', requireAdmin, async (req, res) => {
  const overrides = (await pool.query('SELECT * FROM day_overrides ORDER BY change_date DESC')).rows;
  res.render('admin_day_overrides', { user: req.session.user, overrides, DAYS });
});

app.post('/admin/day-overrides', requireAdmin, async (req, res) => {
  const { date, substituteDay } = req.body;
  if (!date || !substituteDay) return res.status(400).send('不正なパラメータです');
  await pool.query(
    `INSERT INTO day_overrides (change_date, substitute_day) VALUES ($1, $2)
     ON CONFLICT (change_date) DO UPDATE SET substitute_day = EXCLUDED.substitute_day`,
    [date, substituteDay]
  );
  res.redirect('/admin/day-overrides');
});

app.post('/admin/day-overrides/:date/delete', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM day_overrides WHERE change_date=$1', [req.params.date]);
  res.redirect('/admin/day-overrides');
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
  res.render('admin_users', { user: req.session.user, users, classes, accessMap });
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
