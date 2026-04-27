use rusqlite::{params, Connection};

use crate::db::format_time_ago;
use crate::types::{Comment, Post, PostThumbnail, Story, User};

pub fn get_user(conn: &Connection, id: &str) -> User {
    conn.query_row(
        "SELECT id, username, display_name, avatar_url, bio, posts_count, followers_count, following_count FROM users WHERE id = ?1",
        params![id],
        |row| {
            Ok(User {
                id: row.get(0)?,
                username: row.get(1)?,
                display_name: row.get(2)?,
                avatar_url: row.get(3)?,
                bio: row.get::<_, String>(4).unwrap_or_default(),
                posts_count: row.get(5)?,
                followers_count: row.get(6)?,
                following_count: row.get(7)?,
            })
        },
    )
    .expect("User not found")
}

pub fn get_feed_posts(conn: &Connection, current_user_id: &str) -> Vec<Post> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.image_url, p.caption, p.location, p.likes_count, p.comments_count, p.created_at,
                    u.id, u.username, u.display_name, u.avatar_url
             FROM posts p JOIN users u ON p.user_id = u.id
             ORDER BY p.created_at DESC",
        )
        .unwrap();

    stmt.query_map([], |row| {
        let post_id: String = row.get(0)?;
        let user = User {
            id: row.get(7)?,
            username: row.get(8)?,
            display_name: row.get(9)?,
            avatar_url: row.get(10)?,
            bio: String::new(),
            posts_count: 0,
            followers_count: 0,
            following_count: 0,
        };

        let is_liked: bool = conn
            .query_row(
                "SELECT 1 FROM likes WHERE post_id = ?1 AND user_id = ?2",
                params![&post_id, current_user_id],
                |_| Ok(true),
            )
            .unwrap_or(false);

        let is_saved: bool = conn
            .query_row(
                "SELECT 1 FROM saves WHERE post_id = ?1 AND user_id = ?2",
                params![&post_id, current_user_id],
                |_| Ok(true),
            )
            .unwrap_or(false);

        let created_at: String = row.get(6)?;

        Ok(Post {
            id: post_id,
            user,
            image_url: row.get(1)?,
            caption: row.get(2)?,
            location: row.get(3)?,
            likes_count: row.get(4)?,
            comments_count: row.get(5)?,
            is_liked,
            is_saved,
            time_ago: format_time_ago(&created_at),
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn get_stories(conn: &Connection, current_user_id: &str) -> Vec<Story> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.has_unseen, s.image_url, u.id, u.username, u.display_name, u.avatar_url
             FROM stories s JOIN users u ON s.user_id = u.id
             WHERE s.user_id != ?1
             ORDER BY s.created_at DESC",
        )
        .unwrap();

    stmt.query_map(params![current_user_id], |row| {
        let has_unseen: i32 = row.get(1)?;
        Ok(Story {
            id: row.get(0)?,
            image_url: row.get(2)?,
            user: User {
                id: row.get(3)?,
                username: row.get(4)?,
                display_name: row.get(5)?,
                avatar_url: row.get(6)?,
                bio: String::new(),
                posts_count: 0,
                followers_count: 0,
                following_count: 0,
            },
            has_unseen_story: has_unseen == 1,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn get_comments(conn: &Connection, post_id: &str) -> Vec<Comment> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.text, c.created_at, u.id, u.username, u.display_name, u.avatar_url
             FROM comments c JOIN users u ON c.user_id = u.id
             WHERE c.post_id = ?1
             ORDER BY c.created_at ASC",
        )
        .unwrap();

    stmt.query_map(params![post_id], |row| {
        let created_at: String = row.get(2)?;
        Ok(Comment {
            id: row.get(0)?,
            user: User {
                id: row.get(3)?,
                username: row.get(4)?,
                display_name: row.get(5)?,
                avatar_url: row.get(6)?,
                bio: String::new(),
                posts_count: 0,
                followers_count: 0,
                following_count: 0,
            },
            text: row.get(1)?,
            time_ago: format_time_ago(&created_at),
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn get_user_posts(conn: &Connection, user_id: &str) -> Vec<PostThumbnail> {
    let mut stmt = conn
        .prepare("SELECT id, image_url FROM posts WHERE user_id = ?1 ORDER BY created_at DESC")
        .unwrap();

    stmt.query_map(params![user_id], |row| {
        Ok(PostThumbnail {
            id: row.get(0)?,
            image_url: row.get(1)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn get_explore_posts(conn: &Connection) -> Vec<PostThumbnail> {
    let mut stmt = conn
        .prepare("SELECT id, image_url FROM posts ORDER BY likes_count DESC")
        .unwrap();

    stmt.query_map([], |row| {
        Ok(PostThumbnail {
            id: row.get(0)?,
            image_url: row.get(1)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn get_other_users(conn: &Connection, exclude_id: &str) -> Vec<User> {
    let mut stmt = conn
        .prepare("SELECT id, username, display_name, avatar_url, bio, posts_count, followers_count, following_count FROM users WHERE id != ?1")
        .unwrap();

    stmt.query_map(params![exclude_id], |row| {
        Ok(User {
            id: row.get(0)?,
            username: row.get(1)?,
            display_name: row.get(2)?,
            avatar_url: row.get(3)?,
            bio: row.get::<_, String>(4).unwrap_or_default(),
            posts_count: row.get(5)?,
            followers_count: row.get(6)?,
            following_count: row.get(7)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn get_user_post_thumbnails(conn: &Connection, user_id: &str) -> Vec<PostThumbnail> {
    let mut stmt = conn
        .prepare("SELECT id, image_url FROM posts WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 4")
        .unwrap();

    stmt.query_map(params![user_id], |row| {
        Ok(PostThumbnail {
            id: row.get(0)?,
            image_url: row.get(1)?,
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}
