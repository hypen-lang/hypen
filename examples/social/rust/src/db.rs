use rusqlite::Connection;
use std::fs;
use std::path::Path;

pub fn init_database() -> Connection {
    let conn = Connection::open("./instagram.db").expect("Failed to open database");
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

pub fn format_time_ago(date_str: &str) -> String {
    // Simple relative time — in production use chrono
    date_str.to_string()
}
