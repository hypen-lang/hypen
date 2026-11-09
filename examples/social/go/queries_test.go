package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func seededDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1) // one shared in-memory database
	for _, f := range []string{"schema.sql", "seed.sql"} {
		b, err := os.ReadFile(filepath.Join("..", "data", f))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(b)); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
	}
	return db
}

// Regression: the Story module used to look the route's story id up as a
// user id, found nothing, and rendered a black screen.
func TestGetStoryByStoryID(t *testing.T) {
	db := seededDB(t)
	s := getStory(db, "s1")
	if s == nil || s.ID != "s1" || s.User.ID != "u2" || s.ImageUrl == "" {
		t.Fatalf("getStory(s1) = %+v", s)
	}
	if s := getStory(db, "u2"); s == nil || s.User.ID != "u2" {
		t.Fatalf("user-id fallback = %+v", s)
	}
	if s := getStory(db, "nope"); s != nil {
		t.Fatalf("unknown id = %+v, want nil", s)
	}
}

func TestSeedCommentCountsMatchRows(t *testing.T) {
	db := seededDB(t)
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM posts p
		WHERE p.comments_count != (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("%d posts have comments_count != seeded comments", n)
	}
}

// Regression: the driver scans DATETIME as RFC 3339 ("2026-10-18T01:01:37Z"),
// which the old single-layout parse rejected, so comments showed raw
// timestamps instead of "5m"/"2h" like the other backends.
func TestFormatTimeAgoAcceptsDriverAndSQLiteForms(t *testing.T) {
	recent := time.Now().UTC().Add(-3 * time.Hour)
	for _, s := range []string{recent.Format(time.RFC3339), recent.Format("2006-01-02 15:04:05")} {
		if got := formatTimeAgo(s); got != "3h" {
			t.Errorf("formatTimeAgo(%q) = %q, want 3h", s, got)
		}
	}
	if got := formatTimeAgo("nonsense"); got != "nonsense" {
		t.Errorf("unparseable input changed: %q", got)
	}
}

func TestCommentsHaveRelativeTimes(t *testing.T) {
	db := seededDB(t)
	var postID string
	if err := db.QueryRow("SELECT post_id FROM comments LIMIT 1").Scan(&postID); err != nil {
		t.Skip("no seeded comments:", err)
	}
	for _, c := range getComments(db, postID) {
		if strings.ContainsAny(c.TimeAgo, "-:") {
			t.Errorf("comment %s has raw timestamp %q", c.ID, c.TimeAgo)
		}
	}
}
