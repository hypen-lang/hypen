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

/// Relative time ("5m", "3h", "2d") for a SQLite `CURRENT_TIMESTAMP` value
/// (`YYYY-MM-DD HH:MM:SS`, UTC; an ISO `T`/`Z` form is accepted too), matching
/// the TypeScript and Cloudflare backends. Unparseable input is returned as-is.
pub fn format_time_ago(date_str: &str) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    match parse_utc_seconds(date_str) {
        Some(then) => relative(now - then),
        None => date_str.to_string(),
    }
}

fn relative(diff_secs: i64) -> String {
    let minutes = diff_secs.max(0) / 60;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 24 {
        return format!("{hours}h");
    }
    format!("{}d", hours / 24)
}

fn parse_utc_seconds(s: &str) -> Option<i64> {
    let s = s.trim().trim_end_matches('Z');
    let (date, time) = s.split_once([' ', 'T'])?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let time = time.split('.').next()?;
    let mut t = time.splitn(3, ':').map(|p| p.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    // Days from civil (Howard Hinnant's algorithm), proleptic Gregorian.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3_600 + mm * 60 + ss)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sqlite_and_iso_timestamps() {
        assert_eq!(parse_utc_seconds("1970-01-01 00:00:00"), Some(0));
        assert_eq!(parse_utc_seconds("2026-10-18 01:03:06"), Some(1_792_285_386));
        assert_eq!(parse_utc_seconds("2026-10-18T01:03:06Z"), Some(1_792_285_386));
        assert_eq!(parse_utc_seconds("yesterday"), None);
    }

    #[test]
    fn formats_relative_units() {
        assert_eq!(relative(30), "0m");
        assert_eq!(relative(5 * 60), "5m");
        assert_eq!(relative(3 * 3_600), "3h");
        assert_eq!(relative(2 * 86_400), "2d");
        assert_eq!(format_time_ago("not a date"), "not a date");
    }
}
