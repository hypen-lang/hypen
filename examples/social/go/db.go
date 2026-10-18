package main

import (
	"database/sql"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

func initDatabase() *sql.DB {
	db, err := sql.Open("sqlite", "./instagram.db")
	if err != nil {
		panic(fmt.Sprintf("failed to open database: %v", err))
	}

	dataDir := filepath.Join("..", "data")

	schema, err := os.ReadFile(filepath.Join(dataDir, "schema.sql"))
	if err != nil {
		panic(fmt.Sprintf("failed to read schema: %v", err))
	}
	if _, err := db.Exec(string(schema)); err != nil {
		panic(fmt.Sprintf("failed to apply schema: %v", err))
	}

	var count int
	db.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if count == 0 {
		seed, err := os.ReadFile(filepath.Join(dataDir, "seed.sql"))
		if err != nil {
			panic(fmt.Sprintf("failed to read seed: %v", err))
		}
		if _, err := db.Exec(string(seed)); err != nil {
			panic(fmt.Sprintf("failed to seed database: %v", err))
		}
		fmt.Println("Database seeded")
	}

	return db
}

// sqliteTimeLayouts covers SQLite's CURRENT_TIMESTAMP text form and the
// RFC 3339 form the driver yields when it scans a DATETIME column.
var sqliteTimeLayouts = []string{"2006-01-02 15:04:05", time.RFC3339Nano, "2006-01-02T15:04:05"}

func formatTimeAgo(dateStr string) string {
	var t time.Time
	var err error
	for _, layout := range sqliteTimeLayouts {
		if t, err = time.Parse(layout, dateStr); err == nil {
			break
		}
	}
	if err != nil {
		return dateStr
	}
	diff := time.Since(t)
	minutes := int(math.Floor(diff.Minutes()))
	if minutes < 0 {
		minutes = 0
	}
	if minutes < 60 {
		return fmt.Sprintf("%dm", minutes)
	}
	hours := minutes / 60
	if hours < 24 {
		return fmt.Sprintf("%dh", hours)
	}
	days := hours / 24
	return fmt.Sprintf("%dd", days)
}
