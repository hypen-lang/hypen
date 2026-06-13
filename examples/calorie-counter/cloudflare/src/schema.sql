-- Calorie Counter — SQLite schema
--
-- Everything the UI renders comes out of this database. Seeds live in
-- `seed.sql`, applied once by `server/db.ts` on first boot.

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT NOT NULL,
    daily_calorie_goal INTEGER NOT NULL DEFAULT 2400,
    carbs_goal_g INTEGER NOT NULL DEFAULT 224,
    protein_goal_g INTEGER NOT NULL DEFAULT 128,
    fat_goal_g INTEGER NOT NULL DEFAULT 128,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS foods (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '🍽️',
    calories INTEGER NOT NULL,
    carbs_g REAL NOT NULL DEFAULT 0,
    protein_g REAL NOT NULL DEFAULT 0,
    fat_g REAL NOT NULL DEFAULT 0,
    serving_label TEXT NOT NULL DEFAULT '1 serving',
    -- 'popular' | 'meal' | 'my-food'
    category TEXT NOT NULL DEFAULT 'popular',
    -- Ranks the "Popular" list client-side (ASC).
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- A logged serving of a food against a meal slot on a specific date.
-- We carry a denormalised snapshot of the day as YYYY-MM-DD so the
-- daily/weekly rollups don't need to do any timezone math.
CREATE TABLE IF NOT EXISTS food_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    food_id TEXT NOT NULL REFERENCES foods(id),
    -- 'breakfast' | 'lunch' | 'dinner' | 'snack'
    meal_type TEXT NOT NULL,
    servings REAL NOT NULL DEFAULT 1,
    logged_date TEXT NOT NULL,
    logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    -- 'walking' | 'activity'
    type TEXT NOT NULL,
    calories INTEGER NOT NULL,
    logged_date TEXT NOT NULL,
    logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Per-user, per-meal calorie target — Breakfast/Lunch/Dinner/Snack
-- cards on Home read against this to compute their progress bars.
CREATE TABLE IF NOT EXISTS meal_goals (
    user_id TEXT NOT NULL REFERENCES users(id),
    meal_type TEXT NOT NULL,
    calorie_goal INTEGER NOT NULL,
    PRIMARY KEY (user_id, meal_type)
);

CREATE INDEX IF NOT EXISTS idx_food_entries_user_date
    ON food_entries(user_id, logged_date);
CREATE INDEX IF NOT EXISTS idx_activities_user_date
    ON activities(user_id, logged_date);
CREATE INDEX IF NOT EXISTS idx_foods_category_sort
    ON foods(category, sort_order);
