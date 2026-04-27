import Foundation

struct User: Codable, Sendable {
    let id: String
    let username: String
    let displayName: String
    let avatarUrl: String
    var bio: String = ""
    var postsCount: Int = 0
    var followersCount: Int = 0
    var followingCount: Int = 0
}

struct Post: Codable, Sendable {
    let id: String
    let user: User
    let imageUrl: String
    let caption: String
    var location: String?
    var likesCount: Int = 0
    var commentsCount: Int = 0
    var isLiked: Bool = false
    var isSaved: Bool = false
    let timeAgo: String
}

struct Story: Codable, Sendable {
    let id: String
    let user: User
    let hasUnseenStory: Bool
    var imageUrl: String = ""
}

struct Comment: Codable, Sendable {
    let id: String
    let user: User
    let text: String
    let timeAgo: String
}

struct Notification: Codable, Sendable {
    let id: String
    let type: String
    let user: User
    let text: String
    var postImageUrl: String? = nil
    let timeAgo: String
    var isRead: Bool = false
}

struct Conversation: Codable, Sendable {
    let id: String
    let user: User
    let lastMessage: String
    let timeAgo: String
    var isUnread: Bool = false
}

struct PostThumbnail: Codable, Sendable {
    let id: String
    let imageUrl: String
}

struct ViewedUser: Codable, Sendable {
    let id: String
    let username: String
    let displayName: String
    let avatarUrl: String
    var bio: String = ""
    var postsCount: Int = 0
    var followersCount: Int = 0
    var followingCount: Int = 0
    var posts: [PostThumbnail] = []
    var isFollowing: Bool = false
}

struct ViewedStory: Codable, Sendable {
    let id: String
    let user: User
    let imageUrl: String
}

// MARK: - Per-module state

/// Shell module. Owns the top-level Router template's `location` mirror
/// and the current user. Every other module closes over `currentUser` at
/// startup rather than reading it through `context.getModule("app")`
/// (matching the Go SDK's pragmatic shortcut for the demo).
struct AppState: Codable, Sendable {
    var currentUser: User
    var location: String = "/"
}

struct HomePageState: Codable, Sendable {
    var currentUser: User
    var posts: [Post] = []
    var stories: [Story] = []
}

struct SearchState: Codable, Sendable {
    var searchQuery: String = ""
    var explorePosts: [PostThumbnail] = []
}

struct NotificationsState: Codable, Sendable {
    var notifications: [Notification] = []
}

struct MessagesState: Codable, Sendable {
    var currentUser: User
    var messages: [Conversation] = []
}

struct ProfileState: Codable, Sendable {
    var currentUser: User
    var userPosts: [PostThumbnail] = []
}

struct UserProfileState: Codable, Sendable {
    var viewedUser: ViewedUser? = nil
}

struct CommentsState: Codable, Sendable {
    var currentUser: User
    var postId: String = ""
    var comments: [Comment] = []
    var commentText: String = ""
}

struct StoryState: Codable, Sendable {
    var story: ViewedStory? = nil
}

// MARK: - Action payloads

struct PostIdPayload: Codable, Sendable { let postId: String }
struct CommentIdPayload: Codable, Sendable { let commentId: String }
