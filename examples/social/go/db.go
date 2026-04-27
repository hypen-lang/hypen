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

func formatTimeAgo(dateStr string) string {
	t, err := time.Parse("2006-01-02 15:04:05", dateStr)
	if err != nil {
		return dateStr
	}
	diff := time.Since(t)
	minutes := int(math.Floor(diff.Minutes()))
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
