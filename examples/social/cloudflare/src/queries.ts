import { db } from "./db";

export function getUser(id: string) {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as any;
}

export function getUserByUsername(username: string) {
  return db.query("SELECT * FROM users WHERE username = ?").get(username) as any;
}

export function getFeedPosts(currentUserId: string) {
  const posts = db.query(
    "SELECT p.*, u.username, u.display_name, u.avatar_url FROM posts p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC"
  ).all() as any[];

  return posts.map((p) => {
    const isLiked = db.query("SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?").get(p.id, currentUserId);
    const isSaved = db.query("SELECT 1 FROM saves WHERE post_id = ? AND user_id = ?").get(p.id, currentUserId);
    return {
      id: p.id,
      user: { id: p.user_id, username: p.username, displayName: p.display_name, avatarUrl: p.avatar_url },
      imageUrl: p.image_url,
      caption: p.caption,
      location: p.location,
      likesCount: p.likes_count,
      commentsCount: p.comments_count,
      isLiked: !!isLiked,
      isSaved: !!isSaved,
      timeAgo: formatTimeAgo(p.created_at),
    };
  });
}

export function getUserPosts(userId: string) {
  const posts = db.query(
    "SELECT id, image_url FROM posts WHERE user_id = ? ORDER BY created_at DESC"
  ).all(userId) as any[];
  return posts.map((p) => ({ id: p.id, imageUrl: p.image_url }));
}

export function getStories(currentUserId: string) {
  const stories = db.query(
    "SELECT s.*, u.username, u.display_name, u.avatar_url FROM stories s JOIN users u ON s.user_id = u.id WHERE s.user_id != ? ORDER BY s.created_at DESC"
  ).all(currentUserId) as any[];

  return stories.map((s) => ({
    id: s.id,
    user: { id: s.user_id, username: s.username, displayName: s.display_name, avatarUrl: s.avatar_url },
    imageUrl: s.image_url,
    hasUnseenStory: !!s.has_unseen,
  }));
}

export function getComments(postId: string) {
  const comments = db.query(
    "SELECT c.*, u.username, u.display_name, u.avatar_url FROM comments c JOIN users u ON c.user_id = u.id WHERE c.post_id = ? ORDER BY c.created_at ASC"
  ).all(postId) as any[];

  return comments.map((c) => ({
    id: c.id,
    user: { id: c.user_id, username: c.username, displayName: c.display_name, avatarUrl: c.avatar_url },
    text: c.text,
    timeAgo: formatTimeAgo(c.created_at),
  }));
}

export function getConversations(currentUserId: string) {
  const rows = db.query(
    `SELECT c.id,
            u.id as other_id, u.username, u.display_name, u.avatar_url,
            m.text as last_message, m.created_at as last_at,
            (SELECT COUNT(*) FROM messages
              WHERE conversation_id = c.id AND sender_id != ? AND is_read = 0) as unread_count
     FROM conversations c
     JOIN users u ON u.id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END
     LEFT JOIN messages m ON m.id = (
       SELECT id FROM messages WHERE conversation_id = c.id
       ORDER BY created_at DESC, id DESC LIMIT 1
     )
     WHERE c.user_a = ? OR c.user_b = ?
     ORDER BY m.created_at DESC`
  ).all(currentUserId, currentUserId, currentUserId, currentUserId) as any[];

  return rows.map((r) => ({
    id: r.id,
    user: { id: r.other_id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
    lastMessage: r.last_message ?? "",
    timeAgo: r.last_at ? formatTimeAgo(r.last_at) : "",
    isUnread: r.unread_count > 0,
  }));
}

export function getConversation(conversationId: string, currentUserId: string) {
  const row = db.query(
    `SELECT c.id, u.id as other_id, u.username, u.display_name, u.avatar_url
     FROM conversations c
     JOIN users u ON u.id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END
     WHERE c.id = ? AND (c.user_a = ? OR c.user_b = ?)`
  ).get(currentUserId, conversationId, currentUserId, currentUserId) as any;
  if (!row) return null;
  return {
    id: row.id,
    user: { id: row.other_id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_url },
  };
}

export function getConversationMessages(conversationId: string, currentUserId: string) {
  const rows = db.query(
    `SELECT m.*, u.avatar_url FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ?
     ORDER BY m.created_at ASC, m.id ASC`
  ).all(conversationId) as any[];

  return rows.map((m) => ({
    id: m.id,
    text: m.text,
    isMine: m.sender_id === currentUserId,
    avatarUrl: m.avatar_url,
    timeAgo: formatTimeAgo(m.created_at),
  }));
}

export function markConversationRead(conversationId: string, currentUserId: string) {
  db.query(
    "UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ?"
  ).run(conversationId, currentUserId);
}

export function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  // SQLite's CURRENT_TIMESTAMP is UTC with no zone marker ("2026-09-27 10:00:00").
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateStr) ? `${dateStr.replace(" ", "T")}Z` : dateStr;
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d`;
}

export function formatUser(u: any) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarUrl: u.avatar_url,
    bio: u.bio,
    postsCount: u.posts_count,
    followersCount: u.followers_count,
    followingCount: u.following_count,
  };
}
