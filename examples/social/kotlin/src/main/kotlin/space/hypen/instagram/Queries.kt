package space.hypen.instagram

import java.sql.Connection

fun getUser(conn: Connection, id: String): User {
    val rs = conn.prepareStatement("SELECT * FROM users WHERE id = ?").apply { setString(1, id) }.executeQuery()
    rs.next()
    return User(
        id = rs.getString("id"),
        username = rs.getString("username"),
        displayName = rs.getString("display_name"),
        avatarUrl = rs.getString("avatar_url"),
        bio = rs.getString("bio") ?: "",
        postsCount = rs.getInt("posts_count"),
        followersCount = rs.getInt("followers_count"),
        followingCount = rs.getInt("following_count"),
    )
}

fun getFeedPosts(conn: Connection, currentUserId: String): MutableList<Post> {
    val rs = conn.prepareStatement("""
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        ORDER BY p.created_at DESC
    """).executeQuery()

    val posts = mutableListOf<Post>()
    while (rs.next()) {
        val postId = rs.getString("id")
        val user = User(
            id = rs.getString("user_id"),
            username = rs.getString("username"),
            displayName = rs.getString("display_name"),
            avatarUrl = rs.getString("avatar_url"),
        )

        val likeRs = conn.prepareStatement("SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?")
            .apply { setString(1, postId); setString(2, currentUserId) }.executeQuery()
        val saveRs = conn.prepareStatement("SELECT 1 FROM saves WHERE post_id = ? AND user_id = ?")
            .apply { setString(1, postId); setString(2, currentUserId) }.executeQuery()

        posts.add(Post(
            id = postId,
            user = user,
            imageUrl = rs.getString("image_url"),
            caption = rs.getString("caption") ?: "",
            location = rs.getString("location"),
            likesCount = rs.getInt("likes_count"),
            commentsCount = rs.getInt("comments_count"),
            isLiked = likeRs.next(),
            isSaved = saveRs.next(),
            timeAgo = formatTimeAgo(rs.getString("created_at")),
        ))
    }
    return posts
}

fun getStories(conn: Connection, currentUserId: String): List<Story> {
    val rs = conn.prepareStatement("""
        SELECT s.*, s.image_url, u.username, u.display_name, u.avatar_url
        FROM stories s JOIN users u ON s.user_id = u.id
        WHERE s.user_id != ?
        ORDER BY s.created_at DESC
    """).apply { setString(1, currentUserId) }.executeQuery()

    val stories = mutableListOf<Story>()
    while (rs.next()) {
        stories.add(Story(
            id = rs.getString("id"),
            user = User(
                id = rs.getString("user_id"),
                username = rs.getString("username"),
                displayName = rs.getString("display_name"),
                avatarUrl = rs.getString("avatar_url"),
            ),
            hasUnseenStory = rs.getInt("has_unseen") == 1,
            imageUrl = rs.getString("image_url") ?: "",
        ))
    }
    return stories
}

fun getComments(conn: Connection, postId: String): MutableList<Comment> {
    val rs = conn.prepareStatement("""
        SELECT c.*, u.username, u.display_name, u.avatar_url
        FROM comments c JOIN users u ON c.user_id = u.id
        WHERE c.post_id = ?
        ORDER BY c.created_at ASC
    """).apply { setString(1, postId) }.executeQuery()

    val comments = mutableListOf<Comment>()
    while (rs.next()) {
        comments.add(Comment(
            id = rs.getString("id"),
            user = User(
                id = rs.getString("user_id"),
                username = rs.getString("username"),
                displayName = rs.getString("display_name"),
                avatarUrl = rs.getString("avatar_url"),
            ),
            text = rs.getString("text"),
            timeAgo = formatTimeAgo(rs.getString("created_at")),
        ))
    }
    return comments
}

fun getUserPosts(conn: Connection, userId: String): List<PostThumbnail> {
    val rs = conn.prepareStatement(
        "SELECT id, image_url FROM posts WHERE user_id = ? ORDER BY created_at DESC"
    ).apply { setString(1, userId) }.executeQuery()

    val posts = mutableListOf<PostThumbnail>()
    while (rs.next()) {
        posts.add(PostThumbnail(
            id = rs.getString("id"),
            imageUrl = rs.getString("image_url"),
        ))
    }
    return posts
}

fun getExplorePosts(conn: Connection): List<PostThumbnail> {
    val rs = conn.prepareStatement(
        "SELECT p.id, p.image_url, p.caption, u.username FROM posts p JOIN users u ON p.user_id = u.id ORDER BY p.likes_count DESC"
    ).executeQuery()

    val posts = mutableListOf<PostThumbnail>()
    while (rs.next()) {
        posts.add(PostThumbnail(
            id = rs.getString("id"),
            imageUrl = rs.getString("image_url"),
            username = rs.getString("username") ?: "",
            caption = rs.getString("caption") ?: "",
        ))
    }
    return posts
}

fun getOtherUsers(conn: Connection, excludeId: String): List<User> {
    val rs = conn.prepareStatement(
        "SELECT * FROM users WHERE id != ?"
    ).apply { setString(1, excludeId) }.executeQuery()

    val users = mutableListOf<User>()
    while (rs.next()) {
        users.add(User(
            id = rs.getString("id"),
            username = rs.getString("username"),
            displayName = rs.getString("display_name"),
            avatarUrl = rs.getString("avatar_url"),
            bio = rs.getString("bio") ?: "",
            postsCount = rs.getInt("posts_count"),
            followersCount = rs.getInt("followers_count"),
            followingCount = rs.getInt("following_count"),
        ))
    }
    return users
}

fun getUserPostThumbnails(conn: Connection, userId: String): List<PostThumbnail> {
    val rs = conn.prepareStatement(
        "SELECT id, image_url FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 4"
    ).apply { setString(1, userId) }.executeQuery()

    val posts = mutableListOf<PostThumbnail>()
    while (rs.next()) {
        posts.add(PostThumbnail(
            id = rs.getString("id"),
            imageUrl = rs.getString("image_url"),
        ))
    }
    return posts
}
