use serde::{Deserialize, Serialize};

// -- Domain types (shared across modules) ---------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: String,
    pub bio: String,
    pub posts_count: u32,
    pub followers_count: u32,
    pub following_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Post {
    pub id: String,
    pub user: User,
    pub image_url: String,
    pub caption: String,
    pub location: Option<String>,
    pub likes_count: i32,
    pub comments_count: i32,
    pub is_liked: bool,
    pub is_saved: bool,
    pub time_ago: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Story {
    pub id: String,
    pub user: User,
    pub image_url: String,
    pub has_unseen_story: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    pub user: User,
    pub text: String,
    pub time_ago: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    #[serde(rename = "type")]
    pub notification_type: String,
    pub user: User,
    pub text: String,
    pub post_image_url: Option<String>,
    pub time_ago: String,
    pub is_read: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub user: User,
    pub last_message: String,
    pub time_ago: String,
    pub is_unread: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostThumbnail {
    pub id: String,
    pub image_url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub caption: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewedUser {
    #[serde(flatten)]
    pub user: User,
    pub posts: Vec<PostThumbnail>,
    pub is_following: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewedStory {
    pub id: String,
    pub user: User,
    pub image_url: String,
}

// -- Per-module state shapes ----------------------------------------------
//
// Matches the 9-module split used in TS/Go/Swift/Kotlin Social. Each
// module's state is registered under its lowercase name on the shared
// engine so DSL `@{state.x}` inside `module Foo { ... }` resolves
// against `foo.x`.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub current_user: User,
    /// Drives the Router IR in `App/component.hypen`. Mirrored from
    /// the session's router by the SDK-side `router.*` handlers.
    pub location: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomePageState {
    pub current_user: User,
    pub posts: Vec<Post>,
    pub stories: Vec<Story>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchState {
    pub search_query: String,
    pub explore_posts: Vec<PostThumbnail>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationsState {
    pub notifications: Vec<Notification>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesState {
    pub current_user: User,
    pub messages: Vec<Conversation>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileState {
    pub current_user: User,
    pub user_posts: Vec<PostThumbnail>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfileState {
    pub viewed_user: Option<ViewedUser>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentsState {
    pub current_user: User,
    pub post_id: String,
    pub comments: Vec<Comment>,
    pub comment_text: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryState {
    pub story: Option<ViewedStory>,
}

// -- Action payloads -------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostIdPayload {
    pub post_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentIdPayload {
    #[serde(default)]
    pub comment_id: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct InputValuePayload {
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub input: String,
}

impl InputValuePayload {
    pub fn text(&self) -> &str {
        if !self.value.is_empty() {
            &self.value
        } else {
            &self.input
        }
    }
}
