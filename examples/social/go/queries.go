package main

import "database/sql"

func getUser(db *sql.DB, id string) User {
	var u User
	row := db.QueryRow("SELECT id, username, display_name, avatar_url, bio, posts_count, followers_count, following_count FROM users WHERE id = ?", id)
	row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarUrl, &u.Bio, &u.PostsCount, &u.FollowersCount, &u.FollowingCount)
	return u
}

func getFeedPosts(db *sql.DB, currentUserId string) []Post {
	rows, err := db.Query(`
		SELECT p.id, p.image_url, p.caption, p.location, p.likes_count, p.comments_count, p.created_at,
		       u.id, u.username, u.display_name, u.avatar_url
		FROM posts p JOIN users u ON p.user_id = u.id
		ORDER BY p.created_at DESC`)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var posts []Post
	for rows.Next() {
		var p Post
		var location sql.NullString
		var createdAt string
		rows.Scan(&p.ID, &p.ImageUrl, &p.Caption, &location, &p.LikesCount, &p.CommentsCount, &createdAt,
			&p.User.ID, &p.User.Username, &p.User.DisplayName, &p.User.AvatarUrl)

		if location.Valid {
			p.Location = &location.String
		}
		p.TimeAgo = formatTimeAgo(createdAt)

		var dummy int
		err := db.QueryRow("SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?", p.ID, currentUserId).Scan(&dummy)
		p.IsLiked = err == nil
		err = db.QueryRow("SELECT 1 FROM saves WHERE post_id = ? AND user_id = ?", p.ID, currentUserId).Scan(&dummy)
		p.IsSaved = err == nil

		posts = append(posts, p)
	}
	return posts
}

func getStories(db *sql.DB, currentUserId string) []Story {
	rows, err := db.Query(`
		SELECT s.id, s.image_url, s.has_unseen, u.id, u.username, u.display_name, u.avatar_url
		FROM stories s JOIN users u ON s.user_id = u.id
		WHERE s.user_id != ?
		ORDER BY s.created_at DESC`, currentUserId)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var stories []Story
	for rows.Next() {
		var s Story
		var hasUnseen int
		rows.Scan(&s.ID, &s.ImageUrl, &hasUnseen, &s.User.ID, &s.User.Username, &s.User.DisplayName, &s.User.AvatarUrl)
		s.HasUnseenStory = hasUnseen == 1
		stories = append(stories, s)
	}
	return stories
}

func getComments(db *sql.DB, postId string) []Comment {
	rows, err := db.Query(`
		SELECT c.id, c.text, c.created_at, u.id, u.username, u.display_name, u.avatar_url
		FROM comments c JOIN users u ON c.user_id = u.id
		WHERE c.post_id = ?
		ORDER BY c.created_at ASC`, postId)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var comments []Comment
	for rows.Next() {
		var c Comment
		var createdAt string
		rows.Scan(&c.ID, &c.Text, &createdAt, &c.User.ID, &c.User.Username, &c.User.DisplayName, &c.User.AvatarUrl)
		c.TimeAgo = formatTimeAgo(createdAt)
		comments = append(comments, c)
	}
	return comments
}

func getUserPosts(db *sql.DB, userId string) []PostThumbnail {
	rows, err := db.Query("SELECT id, image_url FROM posts WHERE user_id = ? ORDER BY created_at DESC", userId)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var posts []PostThumbnail
	for rows.Next() {
		var p PostThumbnail
		rows.Scan(&p.ID, &p.ImageUrl)
		posts = append(posts, p)
	}
	return posts
}

func getExplorePosts(db *sql.DB) []PostThumbnail {
	rows, err := db.Query("SELECT id, image_url FROM posts ORDER BY likes_count DESC")
	if err != nil {
		return nil
	}
	defer rows.Close()
	var posts []PostThumbnail
	for rows.Next() {
		var p PostThumbnail
		rows.Scan(&p.ID, &p.ImageUrl)
		posts = append(posts, p)
	}
	return posts
}

func getOtherUsers(db *sql.DB, excludeId string) []User {
	rows, err := db.Query("SELECT id, username, display_name, avatar_url, bio, posts_count, followers_count, following_count FROM users WHERE id != ?", excludeId)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var users []User
	for rows.Next() {
		var u User
		rows.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarUrl, &u.Bio, &u.PostsCount, &u.FollowersCount, &u.FollowingCount)
		users = append(users, u)
	}
	return users
}

func getUserPostThumbnails(db *sql.DB, userId string) []PostThumbnail {
	rows, err := db.Query("SELECT id, image_url FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 4", userId)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var posts []PostThumbnail
	for rows.Next() {
		var p PostThumbnail
		rows.Scan(&p.ID, &p.ImageUrl)
		posts = append(posts, p)
	}
	return posts
}
