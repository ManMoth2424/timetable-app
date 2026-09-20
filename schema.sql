-- 既存の単純な時間割テーブルは使わなくなるため削除
DROP TABLE IF EXISTS timetable_entries CASCADE;

-- クラス(2-1〜2-9)
CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

-- ユーザー(admin / editor / viewer)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at TIMESTAMP DEFAULT now()
);

-- ユーザーとクラスの担当関係(多対多)
CREATE TABLE IF NOT EXISTS user_class_access (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, class_id)
);

-- 基本パターン(A週・B週の雛形)。年に数回しか変わらない想定。
CREATE TABLE IF NOT EXISTS base_timetable_entries (
  id SERIAL PRIMARY KEY,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  week_type CHAR(1) NOT NULL CHECK (week_type IN ('A', 'B')),
  day_of_week INTEGER NOT NULL, -- 1=月 ... 6=土
  period INTEGER NOT NULL,
  subject TEXT,
  UNIQUE (class_id, week_type, day_of_week, period)
);

-- どの週がA週/B週かの設定(週の月曜日の日付をキーにする)
CREATE TABLE IF NOT EXISTS week_types (
  week_start DATE PRIMARY KEY,
  week_type CHAR(1) NOT NULL CHECK (week_type IN ('A', 'B'))
);

-- 日々の授業変更(特定の日付だけの上書き)。ここが毎日編集される部分。
CREATE TABLE IF NOT EXISTS daily_changes (
  id SERIAL PRIMARY KEY,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  change_date DATE NOT NULL,
  period INTEGER NOT NULL,
  subject TEXT,
  UNIQUE (class_id, change_date, period)
);

-- 2-1〜2-9のクラスを初期投入
INSERT INTO classes (name)
SELECT v FROM (VALUES
  ('2-1'), ('2-2'), ('2-3'), ('2-4'), ('2-5'), ('2-6'), ('2-7'), ('2-8'), ('2-9')
) AS t(v)
ON CONFLICT (name) DO NOTHING;
