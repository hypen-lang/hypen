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

export function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
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
