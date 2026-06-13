-- Seed data — run once on first boot (when the users table is empty).
-- Bulk food library lives in data/foods.tsv; server/db.ts loads it separately.

INSERT INTO users (
    id, username, display_name, avatar_url,
    daily_calorie_goal, carbs_goal_g, protein_goal_g, fat_goal_g
) VALUES (
    'u1', 'alex', 'Alex Rivers',
    'https://i.pravatar.cc/96?img=3',
    2400, 224, 128, 128
);

-- Per-meal calorie targets. Home / Diary progress bars read from this;
-- missing rows fall back to the defaults in queries.ts.
INSERT INTO meal_goals (user_id, meal_type, calorie_goal) VALUES
    ('u1', 'breakfast', 500),
    ('u1', 'lunch',     768),
    ('u1', 'dinner',    800),
    ('u1', 'snack',     332);

-- A small today-only starter log so the Home screen has numbers to
-- show before the user has logged anything themselves. Safe to delete
-- if you want a fresh-install look.
INSERT INTO food_entries (id, user_id, food_id, meal_type, servings, logged_date)
    VALUES ('fe_seed_1', 'u1', 'f060', 'breakfast', 1,   date('now'));
INSERT INTO food_entries (id, user_id, food_id, meal_type, servings, logged_date)
    VALUES ('fe_seed_2', 'u1', 'f001', 'breakfast', 1,   date('now'));
INSERT INTO food_entries (id, user_id, food_id, meal_type, servings, logged_date)
    VALUES ('fe_seed_3', 'u1', 'f040', 'lunch',     1.5, date('now'));
INSERT INTO food_entries (id, user_id, food_id, meal_type, servings, logged_date)
    VALUES ('fe_seed_4', 'u1', 'f069', 'lunch',     1,   date('now'));

INSERT INTO activities (id, user_id, type, calories, logged_date)
    VALUES ('act_seed_1', 'u1', 'walking', 100, date('now'));
INSERT INTO activities (id, user_id, type, calories, logged_date)
    VALUES ('act_seed_2', 'u1', 'activity', 165, date('now'));
