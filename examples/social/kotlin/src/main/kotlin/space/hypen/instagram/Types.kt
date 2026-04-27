package space.hypen.instagram

import kotlinx.serialization.Serializable

@Serializable
data class User(
    val id: String,
    val username: String,
    val displayName: String,
    val avatarUrl: String,
    val bio: String = "",
    val postsCount: Int = 0,
    val followersCount: Int = 0,
    val followingCount: Int = 0,
)

@Serializable
data class Post(
    val id: String,
    val user: User,
    val imageUrl: String,
    val caption: String,
    val location: String? = null,
    var likesCount: Int = 0,
    var commentsCount: Int = 0,
    var isLiked: Boolean = false,
    var isSaved: Boolean = false,
    val timeAgo: String = ""
)

@Serializable
data class Story(
    val id: String,
    val user: User,
    val hasUnseenStory: Boolean,
    val imageUrl: String = "",
)

@Serializable
data class Comment(
    val id: String,
    val user: User,
    val text: String,
    val timeAgo: String
)

@Serializable
data class Notification(
    val id: String,
    val type: String,
    val user: User,
    val text: String,
    val postImageUrl: String? = null,
    val timeAgo: String,
    val isRead: Boolean = false,
)

@Serializable
data class Conversation(
    val id: String,
    val user: User,
    val lastMessage: String,
    val timeAgo: String,
    val isUnread: Boolean = false,
)

@Serializable
data class PostThumbnail(
    val id: String,
    val imageUrl: String,
)

@Serializable
data class ViewedUser(
    val id: String,
    val username: String,
    val displayName: String,
    val avatarUrl: String,
    val bio: String = "",
    val postsCount: Int = 0,
    var followersCount: Int = 0,
    val followingCount: Int = 0,
    var posts: List<PostThumbnail> = emptyList(),
    var isFollowing: Boolean = false,
)

@Serializable
data class ViewedStory(
    val id: String,
    val user: User,
    val imageUrl: String,
)

// ---------------------------------------------------------------------------
// Per-module state
// ---------------------------------------------------------------------------

/**
 * Shell module. Owns the top-level Router template's `location` mirror
 * and the current user. Every other module closes over `currentUser` at
 * startup rather than reading it through `context.getModule("app")` —
 * matches the Go / Swift examples' pragmatic shortcut for the demo.
 */
@Serializable
data class AppState(
    val currentUser: User,
    /** Current route path — the auto-wired [ManagedRouter] mirrors navigation here. */
    var location: String = "/",
)

@Serializable
data class HomePageState(
    val currentUser: User,
    var posts: List<Post> = emptyList(),
    var stories: List<Story> = emptyList(),
)

@Serializable
data class SearchState(
    var searchQuery: String = "",
    var explorePosts: List<PostThumbnail> = emptyList(),
)

@Serializable
data class NotificationsState(
    var notifications: List<Notification> = emptyList(),
)

@Serializable
data class MessagesState(
    val currentUser: User,
    var messages: List<Conversation> = emptyList(),
)

@Serializable
data class ProfileState(
    val currentUser: User,
    var userPosts: List<PostThumbnail> = emptyList(),
)

@Serializable
data class UserProfileState(
    var viewedUser: ViewedUser? = null,
)

@Serializable
data class CommentsState(
    val currentUser: User,
    var postId: String = "",
    var comments: List<Comment> = emptyList(),
    var commentText: String = "",
)

@Serializable
data class StoryState(
    var story: ViewedStory? = null,
)

// ---------------------------------------------------------------------------
// Action payloads
// ---------------------------------------------------------------------------

@Serializable
data class PostIdPayload(val postId: String = "")

@Serializable
data class CommentIdPayload(val commentId: String = "")
