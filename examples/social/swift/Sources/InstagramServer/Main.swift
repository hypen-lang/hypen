import Foundation
import HypenServer

@main
struct InstagramServer {
    static func main() throws {
        let dataDir = URL(fileURLWithPath: "../data")
        let database = Database(path: "instagram.db")

        let schema = try String(contentsOf: dataDir.appendingPathComponent("schema.sql"), encoding: .utf8)
        database.exec(schema)

        if database.queryInt("SELECT COUNT(*) FROM users") == 0 {
            let seed = try String(contentsOf: dataDir.appendingPathComponent("seed.sql"), encoding: .utf8)
            database.exec(seed)
            print("Database seeded")
        }

        let currentUser = database.queryUser(id: "u1")
        let currentUserId = currentUser.id
        let allExplorePosts = database.queryExplorePosts()

        let app = HypenApp.shared
        let appModule = buildAppModule(currentUser: currentUser)
        _ = buildHomePageModule(database: database, currentUser: currentUser, currentUserId: currentUserId, app: app)
        _ = buildSearchModule(allExplorePosts: allExplorePosts, app: app)
        _ = buildNotificationsModule(database: database, currentUser: currentUser, app: app)
        _ = buildMessagesModule(database: database, currentUser: currentUser, app: app)
        _ = buildProfileModule(database: database, currentUser: currentUser, app: app)
        _ = buildUserProfileModule(database: database, currentUserId: currentUserId, app: app)
        _ = buildCommentsModule(database: database, currentUser: currentUser, currentUserId: currentUserId, app: app)
        _ = buildStoryModule(database: database, app: app)

        let port = ProcessInfo.processInfo.environment["PORT"].flatMap(Int.init) ?? 3000
        let appTemplate = loadTemplate("App")

        // No routing wiring. `RemoteServer` auto-discovers every
        // `Router { Route(path) { Component() } }` block in the primary
        // template, matches each route against registered modules, and
        // spins up a per-session ManagedRouter. Opt out via
        // `.disableAutoRouter()` if a host wants bespoke wiring.
        let server = RemoteServer()
            .module("App", appModule)
            .ui(appTemplate)

        _ = try? server.componentsDir("../components")
        _ = try? server.resourcesDir("../resources")

        print("Instagram server (Swift) ready on ws://localhost:\(port)")
        print("User: \(currentUser.username)")

        try server.listenAndWait(port)
    }
}

// MARK: - Modules

func buildAppModule(currentUser: User) -> ModuleDefinition {
    hypen(AppState(currentUser: currentUser))
        .name("App")
        .build()
}

func buildHomePageModule(
    database: Database,
    currentUser: User,
    currentUserId: String,
    app: HypenApp
) -> ModuleDefinition {
    hypen(HomePageState(currentUser: currentUser))
        .name("HomePage")
        .app(app)
        .onCreated { (state: inout HomePageState, _: GlobalContext?) in
            state.posts = database.queryPosts(currentUserId: currentUserId)
            state.stories = database.queryStories(currentUserId: currentUserId)
        }
        .onAction("toggleLike", payload: PostIdPayload.self) {
            (state: inout HomePageState, payload: PostIdPayload) in
            if let idx = state.posts.firstIndex(where: { $0.id == payload.postId }) {
                state.posts[idx].isLiked.toggle()
                state.posts[idx].likesCount += state.posts[idx].isLiked ? 1 : -1
                let liked = state.posts[idx].isLiked
                let count = state.posts[idx].likesCount
                if liked {
                    database.exec("INSERT OR IGNORE INTO likes (post_id, user_id) VALUES ('\(payload.postId)', '\(currentUserId)')")
                } else {
                    database.exec("DELETE FROM likes WHERE post_id = '\(payload.postId)' AND user_id = '\(currentUserId)'")
                }
                database.exec("UPDATE posts SET likes_count = \(count) WHERE id = '\(payload.postId)'")
            }
        }
        .onAction("toggleSave", payload: PostIdPayload.self) {
            (state: inout HomePageState, payload: PostIdPayload) in
            if let idx = state.posts.firstIndex(where: { $0.id == payload.postId }) {
                state.posts[idx].isSaved.toggle()
                if state.posts[idx].isSaved {
                    database.exec("INSERT OR IGNORE INTO saves (post_id, user_id) VALUES ('\(payload.postId)', '\(currentUserId)')")
                } else {
                    database.exec("DELETE FROM saves WHERE post_id = '\(payload.postId)' AND user_id = '\(currentUserId)'")
                }
            }
        }
        .onAction("sharePost") { (_: inout HomePageState) in }
        .onAction("postOptions") { (_: inout HomePageState) in }
        .build()
}

func buildSearchModule(allExplorePosts: [PostThumbnail], app: HypenApp) -> ModuleDefinition {
    hypen(SearchState(explorePosts: allExplorePosts))
        .name("Search")
        .app(app)
        .onAction("search") { (state: inout SearchState) in
            let query = state.searchQuery.lowercased()
            if query.isEmpty {
                state.explorePosts = allExplorePosts
            } else {
                state.explorePosts = allExplorePosts.filter { $0.imageUrl.lowercased().contains(query) }
            }
        }
        .build()
}

func buildNotificationsModule(
    database: Database,
    currentUser: User,
    app: HypenApp
) -> ModuleDefinition {
    hypen(NotificationsState())
        .name("Notifications")
        .app(app)
        .onCreated { (state: inout NotificationsState, _: GlobalContext?) in
            state.notifications = mockNotifications(database: database, currentUserId: currentUser.id)
        }
        .onActivated { (state: inout NotificationsState, _: GlobalContext?) in
            for i in state.notifications.indices {
                state.notifications[i].isRead = true
            }
        }
        .build()
}

func buildMessagesModule(
    database: Database,
    currentUser: User,
    app: HypenApp
) -> ModuleDefinition {
    hypen(MessagesState(currentUser: currentUser))
        .name("Messages")
        .app(app)
        .onCreated { (state: inout MessagesState, _: GlobalContext?) in
            state.messages = mockMessages(database: database, currentUserId: currentUser.id)
        }
        .build()
}

func buildProfileModule(
    database: Database,
    currentUser: User,
    app: HypenApp
) -> ModuleDefinition {
    hypen(ProfileState(currentUser: currentUser))
        .name("Profile")
        .app(app)
        .onCreated { (state: inout ProfileState, _: GlobalContext?) in
            state.userPosts = database.queryUserPosts(userId: currentUser.id)
        }
        .onAction("editProfile") { (_: inout ProfileState) in }
        .build()
}

func buildUserProfileModule(
    database: Database,
    currentUserId: String,
    app: HypenApp
) -> ModuleDefinition {
    hypen(UserProfileState())
        .name("UserProfile")
        .app(app)
        .onActivated { (state: inout UserProfileState, ctx: GlobalContext?) in
            guard let r = ctx?.getRouter(),
                  let match = r.matchPath(pattern: "/user-profile/:id", path: r.getCurrentPath()),
                  let id = match.params["id"], !id.isEmpty else {
                return
            }
            let u = database.queryUser(id: id)
            guard !u.id.isEmpty else { return }
            state.viewedUser = ViewedUser(
                id: u.id,
                username: u.username,
                displayName: u.displayName,
                avatarUrl: u.avatarUrl,
                bio: u.bio,
                postsCount: u.postsCount,
                followersCount: u.followersCount,
                followingCount: u.followingCount,
                posts: database.queryUserPosts(userId: id),
                isFollowing: false
            )
        }
        .onAction("toggleFollow") { (state: inout UserProfileState) in
            guard var viewed = state.viewedUser else { return }
            viewed.isFollowing.toggle()
            if viewed.isFollowing {
                viewed.followersCount += 1
                database.exec("INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES ('\(currentUserId)', '\(viewed.id)')")
            } else {
                viewed.followersCount -= 1
                database.exec("DELETE FROM follows WHERE follower_id = '\(currentUserId)' AND following_id = '\(viewed.id)'")
            }
            state.viewedUser = viewed
        }
        .build()
}

func buildCommentsModule(
    database: Database,
    currentUser: User,
    currentUserId: String,
    app: HypenApp
) -> ModuleDefinition {
    hypen(CommentsState(currentUser: currentUser))
        .name("Comments")
        .app(app)
        .onActivated { (state: inout CommentsState, ctx: GlobalContext?) in
            guard let r = ctx?.getRouter(),
                  let match = r.matchPath(pattern: "/comments/:postId", path: r.getCurrentPath()),
                  let postId = match.params["postId"], !postId.isEmpty else {
                state.postId = ""
                state.comments = []
                state.commentText = ""
                return
            }
            state.postId = postId
            state.comments = database.queryComments(postId: postId)
            state.commentText = ""
        }
        .onAction("postComment") { (state: inout CommentsState) in
            let text = state.commentText.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty, !state.postId.isEmpty else { return }
            let id = "c\(Int(Date().timeIntervalSince1970 * 1000))"
            let escapedText = text.replacingOccurrences(of: "'", with: "''")
            database.exec("INSERT INTO comments (id, post_id, user_id, text) VALUES ('\(id)', '\(state.postId)', '\(currentUserId)', '\(escapedText)')")
            state.comments.append(Comment(id: id, user: currentUser, text: text, timeAgo: "now"))
            state.commentText = ""
            database.exec("UPDATE posts SET comments_count = comments_count + 1 WHERE id = '\(state.postId)'")
        }
        .onAction("likeComment", payload: CommentIdPayload.self) {
            (_: inout CommentsState, payload: CommentIdPayload) in
            let count = database.queryInt("SELECT COUNT(*) FROM comment_likes WHERE comment_id = '\(payload.commentId)' AND user_id = '\(currentUserId)'")
            if count > 0 {
                database.exec("DELETE FROM comment_likes WHERE comment_id = '\(payload.commentId)' AND user_id = '\(currentUserId)'")
            } else {
                database.exec("INSERT OR IGNORE INTO comment_likes (comment_id, user_id) VALUES ('\(payload.commentId)', '\(currentUserId)')")
            }
        }
        .build()
}

func buildStoryModule(database: Database, app: HypenApp) -> ModuleDefinition {
    hypen(StoryState())
        .name("Story")
        .app(app)
        .onActivated { (state: inout StoryState, ctx: GlobalContext?) in
            guard let r = ctx?.getRouter(),
                  let match = r.matchPath(pattern: "/story/:id", path: r.getCurrentPath()),
                  let id = match.params["id"], !id.isEmpty else {
                state.story = nil
                return
            }
            let u = database.queryUser(id: id)
            guard !u.id.isEmpty else {
                state.story = nil
                return
            }
            state.story = ViewedStory(
                id: id,
                user: User(id: u.id, username: u.username, displayName: u.displayName, avatarUrl: u.avatarUrl),
                imageUrl: u.avatarUrl
            )
        }
        .build()
}

// MARK: - Mock fixtures (match the TS example so Web clients see parity)

func mockNotifications(database: Database, currentUserId: String) -> [Notification] {
    let users = database.queryOtherUsers(excludeId: currentUserId)
    let posts = database.queryUserPostThumbnails(userId: currentUserId)
    func at(_ i: Int) -> String? { i < posts.count ? posts[i].imageUrl : nil }
    func user(_ i: Int) -> User { i < users.count ? users[i] : User(id: "", username: "", displayName: "", avatarUrl: "") }
    return [
        Notification(id: "n1", type: "like", user: user(0), text: "\(user(0).username) liked your photo.  2h", postImageUrl: at(0), timeAgo: "2h", isRead: false),
        Notification(id: "n2", type: "follow", user: user(1), text: "\(user(1).username) started following you.  4h", postImageUrl: nil, timeAgo: "4h", isRead: false),
        Notification(id: "n3", type: "comment", user: user(2), text: "\(user(2).username) commented: \"Amazing shot!\"  6h", postImageUrl: at(0), timeAgo: "6h", isRead: true),
        Notification(id: "n4", type: "like", user: user(3), text: "\(user(3).username) liked your photo.  1d", postImageUrl: at(1), timeAgo: "1d", isRead: true),
        Notification(id: "n5", type: "mention", user: user(0), text: "\(user(0).username) mentioned you in a comment.  1d", postImageUrl: at(1), timeAgo: "1d", isRead: true),
        Notification(id: "n6", type: "follow", user: user(2), text: "\(user(2).username) started following you.  2d", postImageUrl: nil, timeAgo: "2d", isRead: true),
    ]
}

func mockMessages(database: Database, currentUserId: String) -> [Conversation] {
    let users = database.queryOtherUsers(excludeId: currentUserId)
    func user(_ i: Int) -> User { i < users.count ? users[i] : User(id: "", username: "", displayName: "", avatarUrl: "") }
    return [
        Conversation(id: "m1", user: user(0), lastMessage: "That coffee spot was incredible!", timeAgo: "2h", isUnread: true),
        Conversation(id: "m2", user: user(1), lastMessage: "See you at the food festival 🍕", timeAgo: "5h", isUnread: true),
        Conversation(id: "m3", user: user(2), lastMessage: "Love the new designs!", timeAgo: "1d", isUnread: false),
        Conversation(id: "m4", user: user(3), lastMessage: "Want to join the next hike?", timeAgo: "2d", isUnread: false),
    ]
}
