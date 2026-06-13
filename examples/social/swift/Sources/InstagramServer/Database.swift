import Foundation
#if canImport(SQLite3)
import SQLite3
#endif

final class Database: @unchecked Sendable {
    private var db: OpaquePointer?

    init(path: String) {
        guard sqlite3_open(path, &db) == SQLITE_OK else {
            fatalError("Failed to open database at \(path)")
        }
    }

    deinit {
        sqlite3_close(db)
    }

    func exec(_ sql: String) {
        var error: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &error) != SQLITE_OK {
            let msg = error.map { String(cString: $0) } ?? "unknown error"
            sqlite3_free(error)
            print("SQL error: \(msg)")
        }
    }

    func queryInt(_ sql: String) -> Int {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK,
              sqlite3_step(stmt) == SQLITE_ROW else { return 0 }
        return Int(sqlite3_column_int(stmt, 0))
    }

    func queryUser(id: String) -> User {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        let sql = "SELECT id, username, display_name, avatar_url, bio, posts_count, followers_count, following_count FROM users WHERE id = ?"
        sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, (id as NSString).utf8String, -1, nil)
        sqlite3_step(stmt)

        return User(
            id: col(stmt, 0), username: col(stmt, 1), displayName: col(stmt, 2),
            avatarUrl: col(stmt, 3), bio: col(stmt, 4),
            postsCount: Int(sqlite3_column_int(stmt, 5)),
            followersCount: Int(sqlite3_column_int(stmt, 6)),
            followingCount: Int(sqlite3_column_int(stmt, 7))
        )
    }

    func queryPosts(currentUserId: String) -> [Post] {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        let sql = """
            SELECT p.id, p.image_url, p.caption, p.location, p.likes_count, p.comments_count, p.created_at,
                   u.id, u.username, u.display_name, u.avatar_url
            FROM posts p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC
            """
        sqlite3_prepare_v2(db, sql, -1, &stmt, nil)

        var posts: [Post] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let postId = col(stmt, 0)
            let user = User(id: col(stmt, 7), username: col(stmt, 8), displayName: col(stmt, 9), avatarUrl: col(stmt, 10))
            let isLiked = exists("SELECT 1 FROM likes WHERE post_id = '\(postId)' AND user_id = '\(currentUserId)'")
            let isSaved = exists("SELECT 1 FROM saves WHERE post_id = '\(postId)' AND user_id = '\(currentUserId)'")

            posts.append(Post(
                id: postId, user: user, imageUrl: col(stmt, 1), caption: col(stmt, 2),
                location: optCol(stmt, 3),
                likesCount: Int(sqlite3_column_int(stmt, 4)),
                commentsCount: Int(sqlite3_column_int(stmt, 5)),
                isLiked: isLiked, isSaved: isSaved,
                timeAgo: col(stmt, 6)
            ))
        }
        return posts
    }

    func queryStories(currentUserId: String) -> [Story] {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        let sql = """
            SELECT s.id, s.has_unseen, u.id, u.username, u.display_name, u.avatar_url, s.image_url
            FROM stories s JOIN users u ON s.user_id = u.id WHERE s.user_id != ? ORDER BY s.created_at DESC
            """
        sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, (currentUserId as NSString).utf8String, -1, nil)

        var stories: [Story] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            stories.append(Story(
                id: col(stmt, 0),
                user: User(id: col(stmt, 2), username: col(stmt, 3), displayName: col(stmt, 4), avatarUrl: col(stmt, 5)),
                hasUnseenStory: sqlite3_column_int(stmt, 1) == 1,
                imageUrl: col(stmt, 6)
            ))
        }
        return stories
    }

    func queryComments(postId: String) -> [Comment] {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        let sql = """
            SELECT c.id, c.text, c.created_at, u.id, u.username, u.display_name, u.avatar_url
            FROM comments c JOIN users u ON c.user_id = u.id WHERE c.post_id = ? ORDER BY c.created_at ASC
            """
        sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, (postId as NSString).utf8String, -1, nil)

        var comments: [Comment] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            comments.append(Comment(
                id: col(stmt, 0),
                user: User(id: col(stmt, 3), username: col(stmt, 4), displayName: col(stmt, 5), avatarUrl: col(stmt, 6)),
                text: col(stmt, 1), timeAgo: col(stmt, 2)
            ))
        }
        return comments
    }

    func queryUserPosts(userId: String) -> [PostThumbnail] {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        let sql = "SELECT id, image_url FROM posts WHERE user_id = ? ORDER BY created_at DESC"
        sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, (userId as NSString).utf8String, -1, nil)

        var posts: [PostThumbnail] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            posts.append(PostThumbnail(id: col(stmt, 0), imageUrl: col(stmt, 1)))
        }
        return posts
    }

    func queryExplorePosts() -> [PostThumbnail] {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        let sql = "SELECT p.id, p.image_url, u.username, p.caption FROM posts p JOIN users u ON p.user_id = u.id ORDER BY p.likes_count DESC"
        sqlite3_prepare_v2(db, sql, -1, &stmt, nil)

        var posts: [PostThumbnail] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            posts.append(PostThumbnail(
                id: col(stmt, 0),
                imageUrl: col(stmt, 1),
                username: col(stmt, 2),
                caption: col(stmt, 3)
            ))
        }
        return posts
    }

    func queryOtherUsers(excludeId: String) -> [User] {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        let sql = "SELECT id, username, display_name, avatar_url, bio, posts_count, followers_count, following_count FROM users WHERE id != ?"
        sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, (excludeId as NSString).utf8String, -1, nil)

        var users: [User] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            users.append(User(
                id: col(stmt, 0), username: col(stmt, 1), displayName: col(stmt, 2),
                avatarUrl: col(stmt, 3), bio: col(stmt, 4),
                postsCount: Int(sqlite3_column_int(stmt, 5)),
                followersCount: Int(sqlite3_column_int(stmt, 6)),
                followingCount: Int(sqlite3_column_int(stmt, 7))
            ))
        }
        return users
    }

    func queryUserPostThumbnails(userId: String) -> [PostThumbnail] {
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        let sql = "SELECT id, image_url FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 4"
        sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        sqlite3_bind_text(stmt, 1, (userId as NSString).utf8String, -1, nil)

        var posts: [PostThumbnail] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            posts.append(PostThumbnail(id: col(stmt, 0), imageUrl: col(stmt, 1)))
        }
        return posts
    }

    private func exists(_ sql: String) -> Bool {
        return queryInt(sql) != 0
    }

    private func col(_ stmt: OpaquePointer?, _ index: Int32) -> String {
        if let cStr = sqlite3_column_text(stmt, index) {
            return String(cString: cStr)
        }
        return ""
    }

    private func optCol(_ stmt: OpaquePointer?, _ index: Int32) -> String? {
        if sqlite3_column_type(stmt, index) == SQLITE_NULL { return nil }
        return col(stmt, index)
    }
}
