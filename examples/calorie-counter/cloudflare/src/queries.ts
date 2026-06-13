import { db } from "./db";

// ---------------------------------------------------------------------------
// Types — shared by modules and queries. Keep these aligned with the SQL
// column names so query rows can flow straight into state after a single
// `formatX` hop.
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  dailyCalorieGoal: number;
  carbsGoalG: number;
  proteinGoalG: number;
  fatGoalG: number;
}

export interface Food {
  id: string;
  name: string;
  icon: string;
  calories: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
  servingLabel: string;
  category: string;
}

export interface MealBucket {
  meal: "breakfast" | "lunch" | "dinner" | "snack";
  label: string;
  icon: string;
  calorieGoal: number;
  caloriesEaten: number;
  hasLogged: boolean;
}

export interface DaySummary {
  date: string;                 // "YYYY-MM-DD"
  label: string;                // "Today, Dec 22"
  caloriesEaten: number;
  caloriesBurned: number;
  calorieGoal: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
}

export interface Activity {
  id: string;
  type: "walking" | "activity";
  calories: number;
}

// ---------------------------------------------------------------------------
// Date helpers. Everything is keyed by a plain YYYY-MM-DD string so the DB
// never has to reason about the server's timezone.
// ---------------------------------------------------------------------------

export function todayStr(): string {
  const d = new Date();
  return toDateStr(d);
}

export function toDateStr(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function prettyDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);

  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mm = months[d.getMonth()];
  const dd = d.getDate();

  if (diff === 0) return `Today, ${mm} ${dd}`;
  if (diff === -1) return `Yesterday, ${mm} ${dd}`;
  if (diff === 1) return `Tomorrow, ${mm} ${dd}`;
  return `${mm} ${dd}`;
}

export function shortDay(dateStr: string): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(dateStr + "T00:00:00");
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

export function startOfWeek(dateStr: string): string {
  // Monday-start week, matches the Mon-Sun chart in the UI.
  const d = new Date(dateStr + "T00:00:00");
  const day = (d.getDay() + 6) % 7; // Mon=0, Sun=6
  d.setDate(d.getDate() - day);
  return toDateStr(d);
}

// ---------------------------------------------------------------------------
// Row → object formatters
// ---------------------------------------------------------------------------

export function formatUser(row: any): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    dailyCalorieGoal: row.daily_calorie_goal,
    carbsGoalG: row.carbs_goal_g,
    proteinGoalG: row.protein_goal_g,
    fatGoalG: row.fat_goal_g,
  };
}

export function formatFood(row: any): Food {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    calories: row.calories,
    carbsG: row.carbs_g,
    proteinG: row.protein_g,
    fatG: row.fat_g,
    servingLabel: row.serving_label,
    category: row.category,
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function getUser(id: string): User | null {
  const row = db.query("SELECT * FROM users WHERE id = ?").get(id) as any;
  return row ? formatUser(row) : null;
}

export function getPrimaryUser(): User | null {
  const row = db.query("SELECT * FROM users ORDER BY created_at ASC LIMIT 1").get() as any;
  return row ? formatUser(row) : null;
}

// ---------------------------------------------------------------------------
// Foods (Add Food screen)
// ---------------------------------------------------------------------------

export function getFoods(category: string | null, search: string): Food[] {
  const needle = `%${search.trim().toLowerCase()}%`;
  let rows: any[];

  if (category && category !== "all") {
    rows = db.query(
      "SELECT * FROM foods WHERE category = ? AND lower(name) LIKE ? ORDER BY sort_order ASC, name ASC"
    ).all(category, needle) as any[];
  } else {
    rows = db.query(
      "SELECT * FROM foods WHERE lower(name) LIKE ? ORDER BY sort_order ASC, name ASC"
    ).all(needle) as any[];
  }

  return rows.map(formatFood);
}

export function getFood(id: string): Food | null {
  const row = db.query("SELECT * FROM foods WHERE id = ?").get(id) as any;
  return row ? formatFood(row) : null;
}

// Recently logged foods — distinct by food_id, newest first.
export function getRecentFoods(userId: string, limit = 20): Food[] {
  const rows = db.query(
    `SELECT f.*, MAX(fe.logged_at) AS last_logged
       FROM food_entries fe
       JOIN foods f ON f.id = fe.food_id
      WHERE fe.user_id = ?
      GROUP BY f.id
      ORDER BY last_logged DESC
      LIMIT ?`
  ).all(userId, limit) as any[];
  return rows.map(formatFood);
}

// ---------------------------------------------------------------------------
// Day summary (Home hero, Diary rows, Stats daily view)
// ---------------------------------------------------------------------------

interface DayTotalsRow {
  calories: number;
  carbs: number;
  protein: number;
  fat: number;
}

export function getDayTotals(userId: string, date: string): DayTotalsRow {
  const row = db.query(
    `SELECT
        COALESCE(SUM(f.calories  * fe.servings), 0) AS calories,
        COALESCE(SUM(f.carbs_g   * fe.servings), 0) AS carbs,
        COALESCE(SUM(f.protein_g * fe.servings), 0) AS protein,
        COALESCE(SUM(f.fat_g     * fe.servings), 0) AS fat
       FROM food_entries fe
       JOIN foods f ON f.id = fe.food_id
      WHERE fe.user_id = ? AND fe.logged_date = ?`
  ).get(userId, date) as any;
  return {
    calories: Math.round(row?.calories ?? 0),
    carbs: Math.round(row?.carbs ?? 0),
    protein: Math.round(row?.protein ?? 0),
    fat: Math.round(row?.fat ?? 0),
  };
}

export function getDayBurned(userId: string, date: string): number {
  const row = db.query(
    "SELECT COALESCE(SUM(calories), 0) AS burned FROM activities WHERE user_id = ? AND logged_date = ?"
  ).get(userId, date) as any;
  return Math.round(row?.burned ?? 0);
}

export function getActivities(userId: string, date: string): Activity[] {
  const rows = db.query(
    "SELECT id, type, calories FROM activities WHERE user_id = ? AND logged_date = ? ORDER BY logged_at ASC"
  ).all(userId, date) as any[];
  return rows.map((r) => ({ id: r.id, type: r.type, calories: r.calories }));
}

export function getDaySummary(user: User, date: string): DaySummary {
  const totals = getDayTotals(user.id, date);
  const burned = getDayBurned(user.id, date);
  return {
    date,
    label: prettyDay(date),
    caloriesEaten: totals.calories,
    caloriesBurned: burned,
    calorieGoal: user.dailyCalorieGoal,
    carbsG: totals.carbs,
    proteinG: totals.protein,
    fatG: totals.fat,
  };
}

// ---------------------------------------------------------------------------
// Meals (per-slot cards on Home + Diary sections)
// ---------------------------------------------------------------------------

const MEAL_ORDER: Array<MealBucket["meal"]> = ["breakfast", "lunch", "dinner", "snack"];
const MEAL_LABELS: Record<string, { label: string; icon: string; defaultGoal: number }> = {
  breakfast: { label: "Breakfast", icon: "🥪", defaultGoal: 500 },
  lunch:     { label: "Lunch",     icon: "🍙", defaultGoal: 768 },
  dinner:    { label: "Dinner",    icon: "🍝", defaultGoal: 800 },
  snack:     { label: "Snack",     icon: "🍎", defaultGoal: 332 },
};

export function getMealBuckets(userId: string, date: string): MealBucket[] {
  const entriesByMeal = db.query(
    `SELECT fe.meal_type,
            COALESCE(SUM(f.calories * fe.servings), 0) AS cal,
            COUNT(*) AS n
       FROM food_entries fe
       JOIN foods f ON f.id = fe.food_id
      WHERE fe.user_id = ? AND fe.logged_date = ?
      GROUP BY fe.meal_type`
  ).all(userId, date) as any[];

  const goalsRows = db.query(
    "SELECT meal_type, calorie_goal FROM meal_goals WHERE user_id = ?"
  ).all(userId) as any[];

  const goals = new Map<string, number>(goalsRows.map((r) => [r.meal_type, r.calorie_goal]));
  const eaten = new Map<string, { cal: number; n: number }>(
    entriesByMeal.map((r) => [r.meal_type, { cal: Math.round(r.cal), n: r.n }])
  );

  return MEAL_ORDER.map((m) => {
    const meta = MEAL_LABELS[m];
    const slot = eaten.get(m);
    return {
      meal: m,
      label: meta.label,
      icon: meta.icon,
      calorieGoal: goals.get(m) ?? meta.defaultGoal,
      caloriesEaten: slot?.cal ?? 0,
      hasLogged: (slot?.n ?? 0) > 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Weekly view (Stats screen)
// ---------------------------------------------------------------------------

export interface WeeklyDay {
  date: string;
  shortLabel: string;       // "Mon"
  caloriesEaten: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
}

export interface WeekSummary {
  start: string;            // YYYY-MM-DD (Monday)
  end: string;              // YYYY-MM-DD (Sunday)
  rangeLabel: string;       // "Dec 16 – Dec 22"
  days: WeeklyDay[];
  calorieGoal: number;      // daily
  avgCarbsPct: number;
  avgProteinPct: number;
  avgFatPct: number;
  goalCarbsPct: number;
  goalProteinPct: number;
  goalFatPct: number;
}

export function getWeekSummary(user: User, anyDateInWeek: string): WeekSummary {
  const start = startOfWeek(anyDateInWeek);
  const end = addDays(start, 6);

  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days: WeeklyDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(start, i);
    const totals = getDayTotals(user.id, date);
    days.push({
      date,
      shortLabel: labels[i],
      caloriesEaten: totals.calories,
      carbsG: totals.carbs,
      proteinG: totals.protein,
      fatG: totals.fat,
    });
  }

  // Macro percentages — what share of calories came from each macro this
  // week on average. 4 kcal/g carbs, 4 kcal/g protein, 9 kcal/g fat.
  const totC = days.reduce((a, d) => a + d.carbsG, 0);
  const totP = days.reduce((a, d) => a + d.proteinG, 0);
  const totF = days.reduce((a, d) => a + d.fatG, 0);
  const kcalC = totC * 4;
  const kcalP = totP * 4;
  const kcalF = totF * 9;
  const kcalTotal = Math.max(1, kcalC + kcalP + kcalF);

  const avgCarbsPct = Math.round((kcalC / kcalTotal) * 100);
  const avgProteinPct = Math.round((kcalP / kcalTotal) * 100);
  const avgFatPct = Math.max(0, 100 - avgCarbsPct - avgProteinPct);

  // Goal % — rebase the goal grams against the same 4/4/9 formula so
  // "Average" and "Goal" rows share a reference frame.
  const goalKcalC = user.carbsGoalG * 4;
  const goalKcalP = user.proteinGoalG * 4;
  const goalKcalF = user.fatGoalG * 9;
  const goalKcalTotal = Math.max(1, goalKcalC + goalKcalP + goalKcalF);

  const goalCarbsPct = Math.round((goalKcalC / goalKcalTotal) * 100);
  const goalProteinPct = Math.round((goalKcalP / goalKcalTotal) * 100);
  const goalFatPct = Math.max(0, 100 - goalCarbsPct - goalProteinPct);

  return {
    start,
    end,
    rangeLabel: `${shortDay(start)} – ${shortDay(end)}`,
    days,
    calorieGoal: user.dailyCalorieGoal,
    avgCarbsPct,
    avgProteinPct,
    avgFatPct,
    goalCarbsPct,
    goalProteinPct,
    goalFatPct,
  };
}

// ---------------------------------------------------------------------------
// Diary view — grouped food entries for a single day.
// ---------------------------------------------------------------------------

export interface DiaryEntry {
  id: string;
  food: Food;
  servings: number;
  calories: number;
}

export interface DiarySection {
  meal: MealBucket["meal"];
  label: string;
  icon: string;
  entries: DiaryEntry[];
  caloriesEaten: number;
  calorieGoal: number;
}

export function getDiary(userId: string, date: string): DiarySection[] {
  const rows = db.query(
    `SELECT fe.id AS entry_id, fe.servings, fe.meal_type,
            f.id, f.name, f.icon, f.calories, f.carbs_g, f.protein_g,
            f.fat_g, f.serving_label, f.category
       FROM food_entries fe
       JOIN foods f ON f.id = fe.food_id
      WHERE fe.user_id = ? AND fe.logged_date = ?
      ORDER BY fe.logged_at ASC`
  ).all(userId, date) as any[];

  const sections = MEAL_ORDER.map<DiarySection>((meal) => {
    const meta = MEAL_LABELS[meal];
    return {
      meal,
      label: meta.label,
      icon: meta.icon,
      entries: [],
      caloriesEaten: 0,
      calorieGoal: meta.defaultGoal,
    };
  });

  for (const r of rows) {
    const section = sections.find((s) => s.meal === r.meal_type);
    if (!section) continue;
    const food = formatFood(r);
    const cal = Math.round(food.calories * r.servings);
    section.entries.push({
      id: r.entry_id,
      food,
      servings: r.servings,
      calories: cal,
    });
    section.caloriesEaten += cal;
  }

  // Pull any per-user overrides from meal_goals in one query.
  const goals = db.query(
    "SELECT meal_type, calorie_goal FROM meal_goals WHERE user_id = ?"
  ).all(userId) as any[];
  const goalMap = new Map<string, number>(goals.map((g) => [g.meal_type, g.calorie_goal]));
  for (const s of sections) {
    s.calorieGoal = goalMap.get(s.meal) ?? s.calorieGoal;
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export function logFoodEntry(
  userId: string,
  foodId: string,
  mealType: MealBucket["meal"],
  servings: number,
  date: string
): { id: string } {
  const id = `fe${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  db.query(
    "INSERT INTO food_entries (id, user_id, food_id, meal_type, servings, logged_date) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, userId, foodId, mealType, servings, date);
  return { id };
}

export function removeFoodEntry(entryId: string, userId: string): void {
  db.query("DELETE FROM food_entries WHERE id = ? AND user_id = ?").run(entryId, userId);
}

export function logActivity(
  userId: string,
  type: Activity["type"],
  calories: number,
  date: string
): { id: string } {
  const id = `act${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  db.query(
    "INSERT INTO activities (id, user_id, type, calories, logged_date) VALUES (?, ?, ?, ?, ?)"
  ).run(id, userId, type, calories, date);
  return { id };
}
