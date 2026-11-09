use rusqlite::{params, Connection};

use crate::db::format_time_ago;
use crate::types::{Comment, Post, PostThumbnail, Story, User, ViewedStory};

/// Look up a user by id. Returns `None` for an unknown id instead of
/// panicking: these run inside request handlers while the shared DB
/// mutex is held, and a panic there poisons the lock for every other
/// connection.
pub fn get_user(conn: &Connection, id: &str) -> Option<User> {
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
    .ok()
}

/// Resolve a `/story/:id` route param. The param is a *story* id
/// (`StoryItem` pushes `/story/@{item.id}` with the id from `stories`), so
/// look it up in the stories table first. Fall back to treating it as a
/// user id for deep links that name a user, mirroring the TS reference.
pub fn get_story(conn: &Connection, id: &str) -> Option<ViewedStory> {
    let story = conn
        .query_row(
            "SELECT s.id, s.image_url, u.id, u.username, u.display_name, u.avatar_url
             FROM stories s JOIN users u ON s.user_id = u.id
             WHERE s.id = ?1",
            params![id],
            |row| {
                Ok(ViewedStory {
                    id: row.get(0)?,
                    image_url: row.get(1)?,
                    user: User {
                        id: row.get(2)?,
                        username: row.get(3)?,
                        display_name: row.get(4)?,
                        avatar_url: row.get(5)?,
                        ..Default::default()
                    },
                })
            },
        )
        .ok();
    story.or_else(|| {
        get_user(conn, id).map(|u| ViewedStory {
            id: id.to_string(),
            image_url: u.avatar_url.clone(),
            user: u,
        })
    })
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
            ..Default::default()
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

pub fn get_explore_posts(conn: &Connection) -> Vec<PostThumbnail> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.image_url, u.username, p.caption \
             FROM posts p JOIN users u ON p.user_id = u.id \
             ORDER BY p.likes_count DESC",
        )
        .unwrap();

    stmt.query_map([], |row| {
        Ok(PostThumbnail {
            id: row.get(0)?,
            image_url: row.get(1)?,
            username: row.get(2)?,
            caption: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
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
            ..Default::default()
        })
    })
    .unwrap()
    .filter_map(|r| r.ok())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../data/schema.sql")).unwrap();
        conn.execute_batch(include_str!("../../data/seed.sql")).unwrap();
        conn
    }

    #[test]
    fn story_route_param_is_a_story_id() {
        // Regression: `/story/s1` used to be passed to `get_user`, which
        // panicked ("User not found") and poisoned the shared DB lock.
        let conn = seeded();
        let story = get_story(&conn, "s1").expect("s1 is a seeded story");
        assert_eq!(story.id, "s1");
        assert_eq!(story.user.id, "u2");
        assert!(story.image_url.contains("unsplash"));
    }

    #[test]
    fn story_falls_back_to_user_id_and_never_panics() {
        let conn = seeded();
        assert_eq!(get_story(&conn, "u2").unwrap().user.id, "u2");
        assert!(get_story(&conn, "nope").is_none());
        assert!(get_user(&conn, "nope").is_none());
    }

    #[test]
    fn seeded_comment_counts_match_comment_rows() {
        let conn = seeded();
        let mismatches: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM posts p
                 WHERE p.comments_count != (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mismatches, 0);
    }
}
