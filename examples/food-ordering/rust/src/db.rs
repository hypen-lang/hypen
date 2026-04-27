use rusqlite::Connection;
use std::fs;
use std::path::Path;

pub fn init_database() -> Connection {
    let conn = Connection::open("./food-ordering.db").expect("Failed to open database");
    let data_dir = Path::new("../data");

    let schema = fs::read_to_string(data_dir.join("schema.sql")).expect("Failed to read schema");
    conn.execute_batch(&schema).expect("Failed to apply schema");

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
        .unwrap_or(0);

    if count == 0 {
        let seed = fs::read_to_string(data_dir.join("seed.sql")).expect("Failed to read seed");
        conn.execute_batch(&seed).expect("Failed to seed database");
        println!("Database seeded");
    }

    conn
}

/// Trim a SQLite `datetime('now', ...)` ISO string to a friendlier
/// `YYYY-MM-DD HH:MM` shown to the user. The DB stores UTC; we don't
/// time-zone-convert here — it's fine for a demo.
pub fn format_placed_at(date_str: &str) -> String {
    // SQLite default format: "2026-04-23 14:32:18"
    if date_str.len() >= 16 {
        date_str[..16].to_string()
    } else {
        date_str.to_string()
    }
}
