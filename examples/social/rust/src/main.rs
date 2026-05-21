//! Instagram-style Social example, Rust SDK port.
//!
//! Mirrors the 9-module split used in every other SDK's Social
//! (`examples/social/typescript`, `go`, `swift`, `kotlin`). App is a
//! thin routing shell; per-route modules own their own state and actions.
//!
//! Routing uses the engine's reserved `@router.*` action namespace —
//! wired into `RemoteSession` at the SDK level, so zero routing code
//! lives in this file. Per-route data loading happens via
//! `session.on_route_enter(pattern, |params, state, ctx| …)`.
mod db;
mod queries;
mod types;

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use hypen_server::app::HypenApp;
use hypen_server::discovery::ComponentRegistry;
use hypen_server::remote::{ModuleSessionConfig, RemoteSession};
use rusqlite::{params, Connection};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use db::init_database;
use queries::{
    get_comments, get_explore_posts, get_feed_posts, get_other_users, get_stories, get_user,
    get_user_post_thumbnails, get_user_posts,
};
use types::{
    AppState, CommentIdPayload, CommentsState, Comment, Conversation, HomePageState,
    InputValuePayload, MessagesState, Notification, NotificationsState, PostIdPayload, PostThumbnail, ProfileState,
    SearchState, StoryState, User, UserProfileState, ViewedStory, ViewedUser,
};

// ---------------------------------------------------------------------------
// Module builders
// ---------------------------------------------------------------------------
//
// Each function returns a built `ModuleDefinition`. Data captures (`db`,
// `current_user`) happen per-session in `main` since each connection
// gets its own user — same pattern as the Go example.

fn build_app_module(
    current_user: User,
) -> Arc<hypen_server::module::ModuleDefinition<AppState>> {
    Arc::new(
        HypenApp::module::<AppState>("App")
            .state(AppState {
                current_user,
                location: "/".into(),
            })
            .ui_file("../components/App/component.hypen")
            .resources_dir("../resources")
            .build(),
    )
}

fn build_home_page_module(
    db: Arc<Mutex<Connection>>,
    current_user: User,
) -> Arc<hypen_server::module::ModuleDefinition<HomePageState>> {
    let initial = {
        let conn = db.lock().unwrap();
        HomePageState {
            current_user: current_user.clone(),
            posts: get_feed_posts(&conn, &current_user.id),
            stories: get_stories(&conn, &current_user.id),
        }
    };

    Arc::new(
        HypenApp::module::<HomePageState>("HomePage")
            .state(initial)
            .on_action::<PostIdPayload>("toggleLike", {
                let db = db.clone();
                let user_id = current_user.id.clone();
                move |state, payload, _| {
                    let Some(post) = state.posts.iter_mut().find(|p| p.id == payload.post_id)
                    else {
                        return;
                    };
                    post.is_liked = !post.is_liked;
                    post.likes_count += if post.is_liked { 1 } else { -1 };
                    let conn = db.lock().unwrap();
                    if post.is_liked {
                        conn.execute(
                            "INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?1, ?2)",
                            params![payload.post_id, user_id],
                        )
                        .ok();
                    } else {
                        conn.execute(
                            "DELETE FROM likes WHERE post_id = ?1 AND user_id = ?2",
                            params![payload.post_id, user_id],
                        )
                        .ok();
                    }
                    conn.execute(
                        "UPDATE posts SET likes_count = ?1 WHERE id = ?2",
                        params![post.likes_count, payload.post_id],
                    )
                    .ok();
                }
            })
            .on_action::<PostIdPayload>("toggleSave", {
                let db = db.clone();
                let user_id = current_user.id.clone();
                move |state, payload, _| {
                    let Some(post) = state.posts.iter_mut().find(|p| p.id == payload.post_id)
                    else {
                        return;
                    };
                    post.is_saved = !post.is_saved;
                    let conn = db.lock().unwrap();
                    if post.is_saved {
                        conn.execute(
                            "INSERT OR IGNORE INTO saves (post_id, user_id) VALUES (?1, ?2)",
                            params![payload.post_id, user_id],
                        )
                        .ok();
                    } else {
                        conn.execute(
                            "DELETE FROM saves WHERE post_id = ?1 AND user_id = ?2",
                            params![payload.post_id, user_id],
                        )
                        .ok();
                    }
                }
            })
            .on_action::<PostIdPayload>("sharePost", |_s, _p, _| {})
            .on_action::<PostIdPayload>("postOptions", |_s, _p, _| {})
            .build(),
    )
}

fn build_search_module(
    all_explore_posts: Arc<Vec<PostThumbnail>>,
) -> Arc<hypen_server::module::ModuleDefinition<SearchState>> {
    Arc::new(
        HypenApp::module::<SearchState>("Search")
            .state(SearchState {
                search_query: String::new(),
                explore_posts: (*all_explore_posts).clone(),
            })
            .on_action::<InputValuePayload>("search", move |state, payload, _| {
                let query = payload.text().to_lowercase();
                state.explore_posts = if query.is_empty() {
                    (*all_explore_posts).clone()
                } else {
                    all_explore_posts
                        .iter()
                        .filter(|p| {
                            p.username.to_lowercase().contains(&query)
                                || p.caption.to_lowercase().contains(&query)
                        })
                        .cloned()
                        .collect()
                };
            })
            .build(),
    )
}

fn build_notifications_module(
) -> Arc<hypen_server::module::ModuleDefinition<NotificationsState>> {
    Arc::new(
        HypenApp::module::<NotificationsState>("Notifications")
            .state(NotificationsState::default())
            .build(),
    )
}

fn build_messages_module(
    current_user: User,
) -> Arc<hypen_server::module::ModuleDefinition<MessagesState>> {
    Arc::new(
        HypenApp::module::<MessagesState>("Messages")
            .state(MessagesState {
                current_user,
                messages: vec![],
            })
            .build(),
    )
}

fn build_profile_module(
    db: Arc<Mutex<Connection>>,
    current_user: User,
) -> Arc<hypen_server::module::ModuleDefinition<ProfileState>> {
    let initial = {
        let conn = db.lock().unwrap();
        ProfileState {
            current_user: current_user.clone(),
            user_posts: get_user_posts(&conn, &current_user.id),
        }
    };

    Arc::new(
        HypenApp::module::<ProfileState>("Profile")
            .state(initial)
            .on_action::<()>("editProfile", |_s, _p, _| {})
            .build(),
    )
}

fn build_user_profile_module(
) -> Arc<hypen_server::module::ModuleDefinition<UserProfileState>> {
    Arc::new(
        HypenApp::module::<UserProfileState>("UserProfile")
            .state(UserProfileState::default())
            .on_action::<()>("toggleFollow", |state, _, _| {
                if let Some(viewed) = state.viewed_user.as_mut() {
                    viewed.is_following = !viewed.is_following;
                    let delta: i32 = if viewed.is_following { 1 } else { -1 };
                    viewed.user.followers_count =
                        (viewed.user.followers_count as i32 + delta).max(0) as u32;
                }
            })
            .build(),
    )
}

fn build_comments_module(
    db: Arc<Mutex<Connection>>,
    current_user: User,
) -> Arc<hypen_server::module::ModuleDefinition<CommentsState>> {
    Arc::new(
        HypenApp::module::<CommentsState>("Comments")
            .state(CommentsState {
                current_user: current_user.clone(),
                ..Default::default()
            })
            .on_action::<()>("postComment", {
                let db = db.clone();
                let actor = current_user.clone();
                move |state, _, _| {
                    let text = state.comment_text.trim().to_string();
                    if text.is_empty() || state.post_id.is_empty() {
                        return;
                    }
                    let id = format!("c{}", chrono_millis());
                    {
                        let conn = db.lock().unwrap();
                        conn.execute(
                            "INSERT INTO comments (id, post_id, user_id, text) VALUES (?1, ?2, ?3, ?4)",
                            params![id, state.post_id, actor.id, text],
                        )
                        .ok();
                        conn.execute(
                            "UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?1",
                            params![state.post_id],
                        )
                        .ok();
                    }
                    state.comments.push(Comment {
                        id,
                        user: actor.clone(),
                        text,
                        time_ago: "now".into(),
                    });
                    state.comment_text.clear();
                }
            })
            .on_action::<CommentIdPayload>("likeComment", {
                let db = db.clone();
                let user_id = current_user.id.clone();
                move |_state, payload, _| {
                    let conn = db.lock().unwrap();
                    let exists: bool = conn
                        .query_row(
                            "SELECT COUNT(*) FROM comment_likes WHERE comment_id = ?1 AND user_id = ?2",
                            params![payload.comment_id, user_id],
                            |row| row.get::<_, i32>(0),
                        )
                        .unwrap_or(0)
                        > 0;
                    if exists {
                        conn.execute(
                            "DELETE FROM comment_likes WHERE comment_id = ?1 AND user_id = ?2",
                            params![payload.comment_id, user_id],
                        )
                        .ok();
                    } else {
                        conn.execute(
                            "INSERT OR IGNORE INTO comment_likes (comment_id, user_id) VALUES (?1, ?2)",
                            params![payload.comment_id, user_id],
                        )
                        .ok();
                    }
                }
            })
            .build(),
    )
}

fn build_story_module() -> Arc<hypen_server::module::ModuleDefinition<StoryState>> {
    Arc::new(
        HypenApp::module::<StoryState>("Story")
            .state(StoryState::default())
            .build(),
    )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
//
// Mock notification / message feeds, parity with the Go / Swift / Kotlin
// Social examples so the Web client sees identical content across SDKs.

fn mock_notifications(db: &Connection, current_user_id: &str) -> Vec<Notification> {
    let users = get_other_users(db, current_user_id);
    let posts = get_user_post_thumbnails(db, current_user_id);
    let at = |i: usize| posts.get(i).map(|t| t.image_url.clone());
    let user = |i: usize| users.get(i).cloned().unwrap_or_default();

    vec![
        Notification {
            id: "n1".into(),
            notification_type: "like".into(),
            user: user(0),
            text: format!("{} liked your photo.  2h", user(0).username),
            post_image_url: at(0),
            time_ago: "2h".into(),
            is_read: false,
        },
        Notification {
            id: "n2".into(),
            notification_type: "follow".into(),
            user: user(1),
            text: format!("{} started following you.  4h", user(1).username),
            post_image_url: None,
            time_ago: "4h".into(),
            is_read: false,
        },
        Notification {
            id: "n3".into(),
            notification_type: "comment".into(),
            user: user(2),
            text: format!("{} commented: \"Amazing shot!\"  6h", user(2).username),
            post_image_url: at(0),
            time_ago: "6h".into(),
            is_read: true,
        },
        Notification {
            id: "n4".into(),
            notification_type: "like".into(),
            user: user(3),
            text: format!("{} liked your photo.  1d", user(3).username),
            post_image_url: at(1),
            time_ago: "1d".into(),
            is_read: true,
        },
    ]
}

fn mock_messages(db: &Connection, current_user_id: &str) -> Vec<Conversation> {
    let users = get_other_users(db, current_user_id);
    let user = |i: usize| users.get(i).cloned().unwrap_or_default();
    vec![
        Conversation {
            id: "m1".into(),
            user: user(0),
            last_message: "That coffee spot was incredible!".into(),
            time_ago: "2h".into(),
            is_unread: true,
        },
        Conversation {
            id: "m2".into(),
            user: user(1),
            last_message: "See you at the food festival".into(),
            time_ago: "5h".into(),
            is_unread: true,
        },
        Conversation {
            id: "m3".into(),
            user: user(2),
            last_message: "Love the new designs!".into(),
            time_ago: "1d".into(),
            is_unread: false,
        },
        Conversation {
            id: "m4".into(),
            user: user(3),
            last_message: "Want to join the next hike?".into(),
            time_ago: "2d".into(),
            is_unread: false,
        },
    ]
}

/// Cheap monotonic-ish id suffix. We used `chrono` elsewhere? No —
/// just pull epoch millis. Standalone helper to keep comment id
/// generation out of the action handler body.
fn chrono_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

fn build_session(
    db: Arc<Mutex<Connection>>,
    all_explore_posts: Arc<Vec<PostThumbnail>>,
    components: ComponentRegistry,
    current_user: User,
) -> RemoteSession {
    let app = build_app_module(current_user.clone());
    let home = build_home_page_module(db.clone(), current_user.clone());
    let search = build_search_module(all_explore_posts);
    let notifications = build_notifications_module();
    let messages = build_messages_module(current_user.clone());
    let profile = build_profile_module(db.clone(), current_user.clone());
    let user_profile = build_user_profile_module();
    let comments = build_comments_module(db.clone(), current_user.clone());
    let story = build_story_module();

    let session = RemoteSession::from_definition_with_state(
        app,
        components,
        AppState {
            current_user: current_user.clone(),
            location: "/".into(),
        },
        vec![
            ModuleSessionConfig::from_definition(home),
            ModuleSessionConfig::from_definition(search),
            ModuleSessionConfig::from_definition(notifications),
            ModuleSessionConfig::from_definition(messages),
            ModuleSessionConfig::from_definition(profile),
            ModuleSessionConfig::from_definition(user_profile),
            ModuleSessionConfig::from_definition(comments),
            ModuleSessionConfig::from_definition(story),
        ],
    );

    // Route-enter hooks for routes whose state depends on `:params`.
    // `params` for a route like `/notifications` is empty; for
    // `/comments/:postId` it's `{"postId": "p42"}`, etc.
    //
    // Notifications uses a route hook even though it has no params
    // because the cross-SDK reference treats it as route-triggered:
    // re-loading the fixture on every visit plus marking unread
    // entries read is the behaviour the Swift / Kotlin ports encode in
    // `onActivated`. Keeping parity here means nav-back-and-forth
    // resets the unread badges, same as elsewhere.
    session.on_route_enter("/notifications", {
        let db = db.clone();
        let user_id = current_user.id.clone();
        move |_params, state, _ctx| {
            let conn = db.lock().unwrap();
            let mut notifs = mock_notifications(&conn, &user_id);
            for n in &mut notifs {
                n.is_read = true;
            }
            if let Some(slot) = state.get_mut("notifications") {
                if let Some(obj) = slot.as_object_mut() {
                    obj.insert(
                        "notifications".into(),
                        serde_json::to_value(&notifs).unwrap_or(Value::Null),
                    );
                }
            }
        }
    });

    session.on_route_enter("/messages", {
        let db = db.clone();
        let user_id = current_user.id.clone();
        move |_params, state, _ctx| {
            let conn = db.lock().unwrap();
            let msgs = mock_messages(&conn, &user_id);
            if let Some(slot) = state.get_mut("messages") {
                if let Some(obj) = slot.as_object_mut() {
                    obj.insert(
                        "messages".into(),
                        serde_json::to_value(&msgs).unwrap_or(Value::Null),
                    );
                }
            }
        }
    });

    session.on_route_enter("/user-profile/:id", {
        let db = db.clone();
        move |params, state, _ctx| {
            let id = params.get("id").cloned().unwrap_or_default();
            if id.is_empty() {
                return;
            }
            let conn = db.lock().unwrap();
            let u = get_user(&conn, &id);
            let posts = get_user_post_thumbnails(&conn, &id);
            let viewed = ViewedUser {
                user: u,
                posts,
                is_following: false,
            };
            if let Some(slot) = state.get_mut("userprofile") {
                if let Some(obj) = slot.as_object_mut() {
                    obj.insert(
                        "viewedUser".into(),
                        serde_json::to_value(&viewed).unwrap_or(Value::Null),
                    );
                }
            }
        }
    });

    session.on_route_enter("/comments/:postId", {
        let db = db.clone();
        move |params, state, _ctx| {
            let post_id = params.get("postId").cloned().unwrap_or_default();
            let conn = db.lock().unwrap();
            let comments = get_comments(&conn, &post_id);
            if let Some(slot) = state.get_mut("comments") {
                if let Some(obj) = slot.as_object_mut() {
                    obj.insert("postId".into(), Value::String(post_id));
                    obj.insert(
                        "comments".into(),
                        serde_json::to_value(&comments).unwrap_or(Value::Null),
                    );
                    obj.insert("commentText".into(), Value::String(String::new()));
                }
            }
        }
    });

    session.on_route_enter("/story/:id", {
        let db = db.clone();
        move |params, state, _ctx| {
            let id = params.get("id").cloned().unwrap_or_default();
            if id.is_empty() {
                return;
            }
            let conn = db.lock().unwrap();
            let u = get_user(&conn, &id);
            let viewed = ViewedStory {
                id: id.clone(),
                image_url: u.avatar_url.clone(),
                user: u,
            };
            if let Some(slot) = state.get_mut("story") {
                if let Some(obj) = slot.as_object_mut() {
                    obj.insert(
                        "story".into(),
                        serde_json::to_value(&viewed).unwrap_or(Value::Null),
                    );
                }
            }
        }
    });

    session
}

#[tokio::main]
async fn main() {
    let db = Arc::new(Mutex::new(init_database()));
    let all_explore_posts: Arc<Vec<PostThumbnail>> = {
        let conn = db.lock().unwrap();
        Arc::new(get_explore_posts(&conn))
    };

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let addr = format!("0.0.0.0:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("Failed to bind {addr}: {e}"));

    println!("Instagram server (Rust) running on ws://localhost:{port}");

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("Accept failed: {e}");
                continue;
            }
        };

        let db = db.clone();
        let all_explore_posts = all_explore_posts.clone();

        tokio::spawn(async move {
            let ws_stream = match tokio_tungstenite::accept_async(stream).await {
                Ok(ws) => ws,
                Err(e) => {
                    eprintln!("WebSocket handshake failed from {peer}: {e}");
                    return;
                }
            };

            let current_user = {
                let conn = db.lock().unwrap();
                get_user(&conn, "u1")
            };

            let mut components = ComponentRegistry::new();
            if let Err(e) = components.load_dir("../components") {
                eprintln!("Failed to load components for client {peer}: {e}");
                return;
            }

            let session = build_session(db, all_explore_posts, components, current_user);

            let (mut sender, mut receiver) = ws_stream.split();
            while let Some(Ok(msg)) = receiver.next().await {
                match msg {
                    Message::Text(text) => {
                        for resp in session.handle_message(&text) {
                            if sender.send(Message::Text(resp)).await.is_err() {
                                return;
                            }
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
    }
}
