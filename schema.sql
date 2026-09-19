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

-- 時間割の中身(曜日×時限×教科)
CREATE TABLE IF NOT EXISTS timetable_entries (
  id SERIAL PRIMARY KEY,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL, -- 1=月 ... 5=金
  period INTEGER NOT NULL,      -- 1〜6限
  subject TEXT,
  UNIQUE (class_id, day_of_week, period)
);

-- 2-1〜2-9のクラスを初期投入
INSERT INTO classes (name)
SELECT v FROM (VALUES
  ('2-1'), ('2-2'), ('2-3'), ('2-4'), ('2-5'), ('2-6'), ('2-7'), ('2-8'), ('2-9')
) AS t(v)
ON CONFLICT (name) DO NOTHING;
