package space.hypen.instagram

import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import kotlin.time.Duration.Companion.seconds
import kotlinx.serialization.Serializable
import space.hypen.core.*
import java.sql.Connection

// ---------------------------------------------------------------------------
// Action payload types — `HypenAction` wrappers are required for the typed
// Kotlin DSL. Each module's actions are grouped into a sealed interface so
// `onAction<X>` inside that module's builder stays self-contained.
// ---------------------------------------------------------------------------

sealed interface HomePageAction : HypenAction {
    @Serializable
    data class ToggleLike(val postId: String = "") : HomePageAction {
        override val _actionName: String get() = "toggleLike"
    }

    @Serializable
    data class ToggleSave(val postId: String = "") : HomePageAction {
        override val _actionName: String get() = "toggleSave"
    }

    @Serializable
    data class SharePost(val postId: String = "") : HomePageAction {
        override val _actionName: String get() = "sharePost"
    }

    @Serializable
    data class PostOptions(val postId: String = "") : HomePageAction {
        override val _actionName: String get() = "postOptions"
    }
}

sealed interface SearchAction : HypenAction {
    data object Search : SearchAction {
        override val _actionName: String get() = "search"
    }
}

sealed interface ProfileAction : HypenAction {
    data object EditProfile : ProfileAction {
        override val _actionName: String get() = "editProfile"
    }
}

sealed interface UserProfileAction : HypenAction {
    data object ToggleFollow : UserProfileAction {
        override val _actionName: String get() = "toggleFollow"
    }
}

sealed interface CommentsAction : HypenAction {
    data object PostComment : CommentsAction {
        override val _actionName: String get() = "postComment"
    }

    @Serializable
    data class LikeComment(val commentId: String = "") : CommentsAction {
        override val _actionName: String get() = "likeComment"
    }
}

// ---------------------------------------------------------------------------
// Module builders — one per route. Each module owns its own state and
// lifecycle; the auto-wired ManagedRouter mounts them on navigation based
// on the `Router { Route(path) { Component() ... } }` blocks discovered
// from App's template.
// ---------------------------------------------------------------------------

fun buildAppModule(currentUser: User): ModuleDefinition<MutableMap<String, Any?>> =
    hypen(AppState(currentUser = currentUser)) {
        name("App")
        ui(loadTemplate("App"))
    }

fun buildHomePageModule(conn: Connection, currentUser: User): ModuleDefinition<MutableMap<String, Any?>> =
    hypen(HomePageState(currentUser = currentUser)) {
        name("HomePage")
        ui(loadTemplate("HomePage"))
        onCreated { state, _ ->
            state.posts = getFeedPosts(conn, currentUser.id)
            state.stories = getStories(conn, currentUser.id)
        }
        onAction<HomePageAction.ToggleLike> { action, state, _ ->
            state.posts = state.posts.map { post ->
                if (post.id != action.postId) return@map post
                val newLiked = !post.isLiked
                val newCount = post.likesCount + if (newLiked) 1 else -1
                if (newLiked) {
                    conn.prepareStatement("INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)")
                        .apply { setString(1, action.postId); setString(2, currentUser.id) }.executeUpdate()
                } else {
                    conn.prepareStatement("DELETE FROM likes WHERE post_id = ? AND user_id = ?")
                        .apply { setString(1, action.postId); setString(2, currentUser.id) }.executeUpdate()
                }
                conn.prepareStatement("UPDATE posts SET likes_count = ? WHERE id = ?")
                    .apply { setInt(1, newCount); setString(2, action.postId) }.executeUpdate()
                post.copy(isLiked = newLiked, likesCount = newCount)
            }
        }
        onAction<HomePageAction.ToggleSave> { action, state, _ ->
            state.posts = state.posts.map { post ->
                if (post.id != action.postId) return@map post
                val newSaved = !post.isSaved
                if (newSaved) {
                    conn.prepareStatement("INSERT OR IGNORE INTO saves (post_id, user_id) VALUES (?, ?)")
                        .apply { setString(1, action.postId); setString(2, currentUser.id) }.executeUpdate()
                } else {
                    conn.prepareStatement("DELETE FROM saves WHERE post_id = ? AND user_id = ?")
                        .apply { setString(1, action.postId); setString(2, currentUser.id) }.executeUpdate()
                }
                post.copy(isSaved = newSaved)
            }
        }
        onAction<HomePageAction.SharePost> { _, _, _ -> }
        onAction<HomePageAction.PostOptions> { _, _, _ -> }
    }

fun buildSearchModule(allExplorePosts: List<PostThumbnail>): ModuleDefinition<MutableMap<String, Any?>> =
    hypen(SearchState(explorePosts = allExplorePosts)) {
        name("Search")
        ui(loadTemplate("Search"))
        onAction<SearchAction.Search> { _, state, _ ->
            val query = state.searchQuery.lowercase()
            state.explorePosts = if (query.isEmpty()) {
                allExplorePosts
            } else {
                allExplorePosts.filter { it.imageUrl.lowercase().contains(query) }
            }
        }
    }

fun buildNotificationsModule(conn: Connection, currentUser: User): ModuleDefinition<MutableMap<String, Any?>> =
    hypen(NotificationsState()) {
        name("Notifications")
        ui(loadTemplate("Notifications"))
        onCreated { state, _ ->
            state.notifications = mockNotifications(conn, currentUser.id)
        }
        onActivated { state, _ ->
            state.notifications = state.notifications.map { it.copy(isRead = true) }
        }
    }

fun buildMessagesModule(conn: Connection, currentUser: User): ModuleDefinition<MutableMap<String, Any?>> =
    hypen(MessagesState(currentUser = currentUser)) {
        name("Messages")
        ui(loadTemplate("Messages"))
        onCreated { state, _ ->
            state.messages = mockMessages(conn, currentUser.id)
        }
    }

fun buildProfileModule(conn: Connection, currentUser: User): ModuleDefinition<MutableMap<String, Any?>> =
    hypen(ProfileState(currentUser = currentUser)) {
        name("Profile")
        ui(loadTemplate("Profile"))
        onCreated { state, _ ->
            state.userPosts = getUserPosts(conn, currentUser.id)
        }
        onAction<ProfileAction.EditProfile> { _, _, _ -> }
    }

fun buildUserProfileModule(conn: Connection, currentUserId: String): ModuleDefinition<MutableMap<String, Any?>> =
    hypen(UserProfileState()) {
        name("UserProfile")
        ui(loadTemplate("UserProfile"))
        onActivated { state, ctx ->
            val router = ctx?.getRouter() ?: return@onActivated
            val id = router.matchPath("/user-profile/:id", router.getCurrentPath())
                ?.params?.get("id") ?: return@onActivated
            if (id.isEmpty()) return@onActivated
            val u = try { getUser(conn, id) } catch (_: Exception) { return@onActivated }
            state.viewedUser = ViewedUser(
                id = u.id,
                username = u.username,
                displayName = u.displayName,
                avatarUrl = u.avatarUrl,
                bio = u.bio,
                postsCount = u.postsCount,
                followersCount = u.followersCount,
                followingCount = u.followingCount,
                posts = getUserPosts(conn, id),
                isFollowing = false,
            )
        }
        onAction<UserProfileAction.ToggleFollow> { _, state, _ ->
            val viewed = state.viewedUser ?: return@onAction
            val nowFollowing = !viewed.isFollowing
            val delta = if (nowFollowing) 1 else -1
            // Follow writes close over the session's currentUserId — the
            // server holds a single demo user so this is safe; in a real
            // multi-user server the actor would come from session context.
            state.viewedUser = viewed.copy(
                isFollowing = nowFollowing,
                followersCount = viewed.followersCount + delta,
            )
        }
    }

fun buildCommentsModule(conn: Connection, currentUser: User): ModuleDefinition<MutableMap<String, Any?>> =
    hypen(CommentsState(currentUser = currentUser)) {
        name("Comments")
        ui(loadTemplate("Comments"))
        onActivated { state, ctx ->
            val router = ctx?.getRouter()
            val postId = router
                ?.matchPath("/comments/:postId", router.getCurrentPath())
                ?.params?.get("postId")
                ?: ""
            if (postId.isEmpty()) {
                state.postId = ""
                state.comments = emptyList()
                state.commentText = ""
                return@onActivated
            }
            state.postId = postId
            state.comments = getComments(conn, postId)
            state.commentText = ""
        }
        onAction<CommentsAction.PostComment> { _, state, _ ->
            val text = state.commentText.trim()
            val postId = state.postId
            if (text.isEmpty() || postId.isEmpty()) return@onAction
            val id = "c${System.currentTimeMillis()}"
            conn.prepareStatement("INSERT INTO comments (id, post_id, user_id, text) VALUES (?, ?, ?, ?)")
                .apply {
                    setString(1, id); setString(2, postId)
                    setString(3, currentUser.id); setString(4, text)
                }.executeUpdate()
            conn.prepareStatement("UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?")
                .apply { setString(1, postId) }.executeUpdate()
            state.comments = state.comments + Comment(
                id = id, user = currentUser, text = text, timeAgo = "now"
            )
            state.commentText = ""
        }
        onAction<CommentsAction.LikeComment> { action, _, _ ->
            val countRs = conn.prepareStatement(
                "SELECT COUNT(*) FROM comment_likes WHERE comment_id = ? AND user_id = ?"
            ).apply { setString(1, action.commentId); setString(2, currentUser.id) }.executeQuery()
            countRs.next()
            val count = countRs.getInt(1)
            if (count > 0) {
                conn.prepareStatement("DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?")
                    .apply { setString(1, action.commentId); setString(2, currentUser.id) }.executeUpdate()
            } else {
                conn.prepareStatement("INSERT OR IGNORE INTO comment_likes (comment_id, user_id) VALUES (?, ?)")
                    .apply { setString(1, action.commentId); setString(2, currentUser.id) }.executeUpdate()
            }
        }
    }

fun buildStoryModule(conn: Connection): ModuleDefinition<MutableMap<String, Any?>> =
    hypen(StoryState()) {
        name("Story")
        ui(loadTemplate("Story"))
        onActivated { state, ctx ->
            val router = ctx?.getRouter()
            val id = router
                ?.matchPath("/story/:id", router.getCurrentPath())
                ?.params?.get("id")
                ?: ""
            if (id.isEmpty()) {
                state.story = null
                return@onActivated
            }
            val u = try { getUser(conn, id) } catch (_: Exception) {
                state.story = null
                return@onActivated
            }
            state.story = ViewedStory(
                id = id,
                user = u,
                imageUrl = u.avatarUrl,
            )
        }
    }

// ---------------------------------------------------------------------------
// Mock notifications / messages fixtures — match the Swift / TS / Go
// examples so Web clients see parity across SDKs.
// ---------------------------------------------------------------------------

private fun mockNotifications(conn: Connection, currentUserId: String): List<Notification> {
    val users = getOtherUsers(conn, currentUserId)
    val posts = getUserPostThumbnails(conn, currentUserId)
    fun at(i: Int): String? = posts.getOrNull(i)?.imageUrl
    fun user(i: Int): User = users.getOrNull(i) ?: User(id = "", username = "", displayName = "", avatarUrl = "")
    return listOf(
        Notification("n1", "like", user(0), "${user(0).username} liked your photo.  2h", at(0), "2h", false),
        Notification("n2", "follow", user(1), "${user(1).username} started following you.  4h", null, "4h", false),
        Notification("n3", "comment", user(2), "${user(2).username} commented: \"Amazing shot!\"  6h", at(0), "6h", true),
        Notification("n4", "like", user(3), "${user(3).username} liked your photo.  1d", at(1), "1d", true),
        Notification("n5", "mention", user(0), "${user(0).username} mentioned you in a comment.  1d", at(1), "1d", true),
        Notification("n6", "follow", user(2), "${user(2).username} started following you.  2d", null, "2d", true),
    )
}

private fun mockMessages(conn: Connection, currentUserId: String): List<Conversation> {
    val users = getOtherUsers(conn, currentUserId)
    fun user(i: Int): User = users.getOrNull(i) ?: User(id = "", username = "", displayName = "", avatarUrl = "")
    return listOf(
        Conversation("m1", user(0), "That coffee spot was incredible!", "2h", true),
        Conversation("m2", user(1), "See you at the food festival", "5h", true),
        Conversation("m3", user(2), "Love the new designs!", "1d", false),
        Conversation("m4", user(3), "Want to join the next hike?", "2d", false),
    )
}

// ---------------------------------------------------------------------------
// Server entrypoint. No routing code — the auto-wired `ManagedRouter`
// inspects `App`'s template for `Router { Route ... }` blocks on each
// session and mounts the matching module.
// ---------------------------------------------------------------------------

fun main() {
    val conn = initDatabase()
    val currentUser = getUser(conn, "u1")
    val port = System.getenv("PORT")?.toIntOrNull() ?: 3000

    // Primary module (App) — its `.ui` template owns the Router block.
    val appModule = buildAppModule(currentUser)
    // Per-route modules — auto-registered on HypenApp by their `name(...)`
    // builder call. Results are ignored; only the registration side-effect
    // matters.
    buildHomePageModule(conn, currentUser)
    buildSearchModule(getExplorePosts(conn))
    buildNotificationsModule(conn, currentUser)
    buildMessagesModule(conn, currentUser)
    buildProfileModule(conn, currentUser)
    buildUserProfileModule(conn, currentUser.id)
    buildCommentsModule(conn, currentUser)
    buildStoryModule(conn)

    val server = HypenServer {
        module("App", appModule)
        // A single `route("/", "App")` is enough for auto-wire: it tells
        // the server which module is the primary so it can pull the
        // Router template from its `.ui`. Every other route comes from
        // the DSL — no per-route declarations needed.
        route("/", "App")
        watchComponents("../components")
        resourcesDir("../resources")
    }

    val engine = embeddedServer(Netty, port = port) {
        install(WebSockets) {
            pingPeriod = 15.seconds
            timeout = 15.seconds
            maxFrameSize = Long.MAX_VALUE
            masking = false
        }
        routing {
            webSocket("/") {
                val sendMessage: suspend (String) -> Unit = { msg ->
                    try {
                        send(Frame.Text(msg))
                    } catch (_: Exception) {
                        // Connection closed mid-send; the `for (frame in incoming)`
                        // loop below will exit and trigger handleDisconnect in finally.
                    }
                }

                val initialTree = server.handleConnect(
                    connectionKey = this,
                    sendMessage = sendMessage,
                )
                sendMessage(initialTree)

                try {
                    for (frame in incoming) {
                        if (frame is Frame.Text) {
                            server.handleMessage(
                                connectionKey = this,
                                message = frame.readText(),
                                sendMessage = sendMessage,
                            )
                        }
                    }
                } finally {
                    server.handleDisconnect(this)
                }
            }
        }
    }
    engine.start(wait = false)
    println("Instagram server (Kotlin) running on ws://localhost:$port")
    println("User: ${currentUser.username}")
    Thread.currentThread().join()
}
