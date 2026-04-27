import { app } from "@hypen-space/core/app";
import type { GlobalContext } from "@hypen-space/core/app";
import { db } from "./db";
import {
  getUser,
  getFeedPosts,
  getUserPosts,
  getStories,
  getComments,
  formatUser,
} from "./queries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  bio: string;
  postsCount: number;
  followersCount: number;
  followingCount: number;
}

interface Post {
  id: string;
  user: Pick<User, "id" | "username" | "displayName" | "avatarUrl">;
  imageUrl: string;
  caption: string;
  location: string | null;
  likesCount: number;
  commentsCount: number;
  isLiked: boolean;
  isSaved: boolean;
  timeAgo: string;
}

interface Comment {
  id: string;
  user: Pick<User, "id" | "username" | "displayName" | "avatarUrl">;
  text: string;
  timeAgo: string;
}

interface Notification {
  id: string;
  type: string;
  user: Pick<User, "id" | "username" | "displayName" | "avatarUrl">;
  text: string;
  postImageUrl: string | null;
  timeAgo: string;
  isRead: boolean;
}

interface Conversation {
  id: string;
  user: Pick<User, "id" | "username" | "displayName" | "avatarUrl">;
  lastMessage: string;
  timeAgo: string;
  isUnread: boolean;
}

interface ViewedUser extends User {
  posts: { id: string; imageUrl: string }[];
  isFollowing: boolean;
}

interface ViewedStory {
  id: string;
  user: Pick<User, "id" | "username" | "displayName" | "avatarUrl">;
  imageUrl: string;
}

// Exposed for the server wiring (which pulls currentUser from App for the
// initial session hydration).
export interface AppState {
  currentUser: User | null;
  location: string;
}

// ---------------------------------------------------------------------------
// Mock data helpers (unchanged from the prior implementation)
// ---------------------------------------------------------------------------

function getMockNotifications(currentUserId: string): Notification[] {
  const users = db
    .query("SELECT * FROM users WHERE id != ?")
    .all(currentUserId) as any[];
  const posts = db
    .query(
      "SELECT id, image_url FROM posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 4"
    )
    .all(currentUserId) as any[];

  return [
    {
      id: "n1",
      type: "like",
      user: { id: users[0].id, username: users[0].username, displayName: users[0].display_name, avatarUrl: users[0].avatar_url },
      text: `${users[0].username} liked your photo.  2h`,
      postImageUrl: posts[0]?.image_url || null,
      timeAgo: "2h",
      isRead: false,
    },
    {
      id: "n2",
      type: "follow",
      user: { id: users[1].id, username: users[1].username, displayName: users[1].display_name, avatarUrl: users[1].avatar_url },
      text: `${users[1].username} started following you.  4h`,
      postImageUrl: null,
      timeAgo: "4h",
      isRead: false,
    },
    {
      id: "n3",
      type: "comment",
      user: { id: users[2].id, username: users[2].username, displayName: users[2].display_name, avatarUrl: users[2].avatar_url },
      text: `${users[2].username} commented: "Amazing shot!"  6h`,
      postImageUrl: posts[0]?.image_url || null,
      timeAgo: "6h",
      isRead: true,
    },
    {
      id: "n4",
      type: "like",
      user: { id: users[3].id, username: users[3].username, displayName: users[3].display_name, avatarUrl: users[3].avatar_url },
      text: `${users[3].username} liked your photo.  1d`,
      postImageUrl: posts[1]?.image_url || null,
      timeAgo: "1d",
      isRead: true,
    },
    {
      id: "n5",
      type: "mention",
      user: { id: users[0].id, username: users[0].username, displayName: users[0].display_name, avatarUrl: users[0].avatar_url },
      text: `${users[0].username} mentioned you in a comment.  1d`,
      postImageUrl: posts[1]?.image_url || null,
      timeAgo: "1d",
      isRead: true,
    },
    {
      id: "n6",
      type: "follow",
      user: { id: users[2].id, username: users[2].username, displayName: users[2].display_name, avatarUrl: users[2].avatar_url },
      text: `${users[2].username} started following you.  2d`,
      postImageUrl: null,
      timeAgo: "2d",
      isRead: true,
    },
  ];
}

function getMockMessages(currentUserId: string): Conversation[] {
  const users = db
    .query("SELECT * FROM users WHERE id != ?")
    .all(currentUserId) as any[];
  return [
    {
      id: "m1",
      user: { id: users[0].id, username: users[0].username, displayName: users[0].display_name, avatarUrl: users[0].avatar_url },
      lastMessage: "That coffee spot was incredible!",
      timeAgo: "2h",
      isUnread: true,
    },
    {
      id: "m2",
      user: { id: users[1].id, username: users[1].username, displayName: users[1].display_name, avatarUrl: users[1].avatar_url },
      lastMessage: "See you at the food festival 🍕",
      timeAgo: "5h",
      isUnread: true,
    },
    {
      id: "m3",
      user: { id: users[2].id, username: users[2].username, displayName: users[2].display_name, avatarUrl: users[2].avatar_url },
      lastMessage: "Love the new designs!",
      timeAgo: "1d",
      isUnread: false,
    },
    {
      id: "m4",
      user: { id: users[3].id, username: users[3].username, displayName: users[3].display_name, avatarUrl: users[3].avatar_url },
      lastMessage: "Want to join the next hike?",
      timeAgo: "2d",
      isUnread: false,
    },
  ];
}

function getExplorePosts(): { id: string; imageUrl: string }[] {
  const posts = db
    .query("SELECT id, image_url FROM posts ORDER BY likes_count DESC")
    .all() as any[];
  const base = posts.map((p) => ({ id: p.id, imageUrl: p.image_url }));
  const multiplied = [];
  for (let i = 0; i < 10; i++) {
    for (const p of base) {
      multiplied.push({ id: `${p.id}_${i}`, imageUrl: p.imageUrl });
    }
  }
  return multiplied;
}

// currentUser helper — each route module copies this from the App shell on
// activation. Going through a helper (instead of `getUser("u1")` inline)
// keeps the demo consistent with the "App is the source of truth for
// currentUser" rule.
function currentUserFromApp(context: GlobalContext): User | null {
  if (!context.hasModule("app")) return null;
  const appState = context.getModule<AppState>("app").getState();
  return appState.currentUser;
}

// ---------------------------------------------------------------------------
// App — shell module. Holds currentUser and the mirror of the router path.
// The App template owns the top-level Router { Route { … } } that renders
// each route's child module in the active slot.
// ---------------------------------------------------------------------------

export const appModule = app
  .defineState<AppState>({
    currentUser: null,
    location: "/",
  })
  .onCreated(async (state) => {
    const user = getUser("u1");
    state.currentUser = formatUser(user);
  })
  .build();

// ---------------------------------------------------------------------------
// HomePage — route "/". Owns the feed + stories carousel.
// ---------------------------------------------------------------------------

interface HomePageState {
  currentUser: User | null;
  posts: Post[];
  stories: any[];
}

export const homePageModule = app
  .module("HomePage")
  .defineState<HomePageState>({
    currentUser: null,
    posts: [],
    stories: [],
  })
  .onCreated(async (state, context) => {
    state.currentUser = context ? currentUserFromApp(context) : null;
    const id = state.currentUser?.id ?? "u1";
    state.posts = getFeedPosts(id);
    state.stories = getStories(id);
  })
  .onAction<{ postId: string }>("toggleLike", async ({ state, action }) => {
    const postId = action.payload.postId;
    const post = state.posts.find((p) => p.id === postId);
    if (!post || !state.currentUser) return;

    if (post.isLiked) {
      db.query("DELETE FROM likes WHERE post_id = ? AND user_id = ?").run(
        postId,
        state.currentUser.id
      );
      post.likesCount -= 1;
    } else {
      db.query(
        "INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)"
      ).run(postId, state.currentUser.id);
      post.likesCount += 1;
    }
    post.isLiked = !post.isLiked;
    db.query("UPDATE posts SET likes_count = ? WHERE id = ?").run(
      post.likesCount,
      postId
    );
  })
  .onAction<{ postId: string }>("toggleSave", async ({ state, action }) => {
    const postId = action.payload.postId;
    const post = state.posts.find((p) => p.id === postId);
    if (!post || !state.currentUser) return;

    if (post.isSaved) {
      db.query("DELETE FROM saves WHERE post_id = ? AND user_id = ?").run(
        postId,
        state.currentUser.id
      );
    } else {
      db.query(
        "INSERT OR IGNORE INTO saves (post_id, user_id) VALUES (?, ?)"
      ).run(postId, state.currentUser.id);
    }
    post.isSaved = !post.isSaved;
  })
  .onAction("sharePost", async () => {
    // Client-side share sheet
  })
  .onAction("postOptions", async () => {
    // Client-side options menu
  })
  .build();

// ---------------------------------------------------------------------------
// Search — route "/search".
// ---------------------------------------------------------------------------

interface SearchState {
  searchQuery: string;
  explorePosts: { id: string; imageUrl: string }[];
}

const allExplorePosts = getExplorePosts();

export const searchModule = app
  .module("Search")
  .defineState<SearchState>({
    searchQuery: "",
    explorePosts: allExplorePosts,
  })
  .onAction("search", ({ state }) => {
    const query = state.searchQuery.toLowerCase();
    state.explorePosts =
      query === ""
        ? allExplorePosts
        : allExplorePosts.filter((p) => p.imageUrl.toLowerCase().includes(query));
  })
  .build();

// ---------------------------------------------------------------------------
// Notifications — route "/notifications".
// ---------------------------------------------------------------------------

interface NotificationsState {
  notifications: Notification[];
}

export const notificationsModule = app
  .module("Notifications")
  .defineState<NotificationsState>({ notifications: [] })
  .onCreated(async (state, context) => {
    const user = context ? currentUserFromApp(context) : null;
    state.notifications = getMockNotifications(user?.id ?? "u1");
  })
  .onActivated(async (state) => {
    for (const n of state.notifications) n.isRead = true;
  })
  .build();

// ---------------------------------------------------------------------------
// Messages — route "/messages".
// ---------------------------------------------------------------------------

interface MessagesState {
  currentUser: User | null;
  messages: Conversation[];
}

export const messagesModule = app
  .module("Messages")
  .defineState<MessagesState>({ currentUser: null, messages: [] })
  .onCreated(async (state, context) => {
    state.currentUser = context ? currentUserFromApp(context) : null;
    state.messages = getMockMessages(state.currentUser?.id ?? "u1");
  })
  .build();

// ---------------------------------------------------------------------------
// Profile — route "/profile".
// ---------------------------------------------------------------------------

interface ProfileState {
  currentUser: User | null;
  userPosts: { id: string; imageUrl: string }[];
}

export const profileModule = app
  .module("Profile")
  .defineState<ProfileState>({ currentUser: null, userPosts: [] })
  .onCreated(async (state, context) => {
    state.currentUser = context ? currentUserFromApp(context) : null;
    const id = state.currentUser?.id ?? "u1";
    state.userPosts = getUserPosts(id);
  })
  .onAction("editProfile", async () => {
    // No-op — triggers a client-side sheet.
  })
  .build();

// ---------------------------------------------------------------------------
// UserProfile — route "/user-profile/:id". onActivated re-reads the URL
// param so navigating between two different users reuses the module but
// refreshes the viewed data.
// ---------------------------------------------------------------------------

interface UserProfileState {
  viewedUser: ViewedUser | null;
}

function loadViewedUser(userId: string): ViewedUser | null {
  const raw = getUser(userId);
  if (!raw) return null;
  return {
    ...formatUser(raw),
    posts: getUserPosts(userId),
    isFollowing: false,
  };
}

export const userProfileModule = app
  .module("UserProfile")
  .defineState<UserProfileState>({ viewedUser: null })
  .onActivated(async (state, context) => {
    if (!context?.router) return;
    const path = context.router.getCurrentPath();
    const match = context.router.matchPath("/user-profile/:id", path);
    const id = match?.params.id;
    if (!id) return;
    state.viewedUser = loadViewedUser(id);
  })
  .onAction("toggleFollow", async ({ state, context }) => {
    if (!state.viewedUser) return;
    const appUser = context ? currentUserFromApp(context) : null;
    if (!appUser) return;
    state.viewedUser.isFollowing = !state.viewedUser.isFollowing;
    if (state.viewedUser.isFollowing) {
      state.viewedUser.followersCount += 1;
      db.query(
        "INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)"
      ).run(appUser.id, state.viewedUser.id);
    } else {
      state.viewedUser.followersCount -= 1;
      db.query(
        "DELETE FROM follows WHERE follower_id = ? AND following_id = ?"
      ).run(appUser.id, state.viewedUser.id);
    }
  })
  .build();

// ---------------------------------------------------------------------------
// Comments — route "/comments/:postId".
// ---------------------------------------------------------------------------

interface CommentsState {
  currentUser: User | null;
  postId: string;
  comments: Comment[];
  commentText: string;
}

export const commentsModule = app
  .module("Comments")
  .defineState<CommentsState>({
    currentUser: null,
    postId: "",
    comments: [],
    commentText: "",
  })
  .onActivated(async (state, context) => {
    if (!context?.router) return;
    state.currentUser = currentUserFromApp(context);
    const path = context.router.getCurrentPath();
    const match = context.router.matchPath("/comments/:postId", path);
    const postId = match?.params.postId ?? "";
    state.postId = postId;
    state.comments = postId ? getComments(postId) : [];
    state.commentText = "";
  })
  .onAction("postComment", async ({ state }) => {
    const text = state.commentText.trim();
    if (!text || !state.currentUser || !state.postId) return;

    const id = `c${Date.now()}`;
    db.query(
      "INSERT INTO comments (id, post_id, user_id, text) VALUES (?, ?, ?, ?)"
    ).run(id, state.postId, state.currentUser.id, text);

    state.comments.push({
      id,
      user: state.currentUser,
      text,
      timeAgo: "now",
    });
    state.commentText = "";

    db.query(
      "UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?"
    ).run(state.postId);
  })
  .onAction<{ commentId: string }>("likeComment", async ({ state, action }) => {
    if (!state.currentUser) return;
    const commentId = action.payload.commentId;
    const existing = db
      .query(
        "SELECT COUNT(*) as cnt FROM comment_likes WHERE comment_id = ? AND user_id = ?"
      )
      .get(commentId, state.currentUser.id) as any;
    if (existing && existing.cnt > 0) {
      db.query(
        "DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?"
      ).run(commentId, state.currentUser.id);
    } else {
      db.query(
        "INSERT OR IGNORE INTO comment_likes (comment_id, user_id) VALUES (?, ?)"
      ).run(commentId, state.currentUser.id);
    }
  })
  .build();

// ---------------------------------------------------------------------------
// Story — route "/story/:id".
// ---------------------------------------------------------------------------

interface StoryState {
  story: ViewedStory | null;
}

export const storyModule = app
  .module("Story")
  .defineState<StoryState>({ story: null })
  .onActivated(async (state, context) => {
    if (!context?.router) return;
    const path = context.router.getCurrentPath();
    const match = context.router.matchPath("/story/:id", path);
    const id = match?.params.id;
    if (!id) {
      state.story = null;
      return;
    }

    // First try to pull the story off HomePage (already hydrated on "/" visits).
    let story: ViewedStory | null = null;
    if (context.hasModule("homepage")) {
      const home = context.getModule("homepage").getState() as HomePageState;
      const hit = home.stories?.find((s: any) => s.id === id);
      if (hit) {
        story = {
          id: hit.id,
          user: {
            id: hit.user.id,
            username: hit.user.username,
            displayName: hit.user.displayName ?? hit.user.username,
            avatarUrl: hit.user.avatarUrl,
          },
          imageUrl: hit.imageUrl ?? hit.user.avatarUrl,
        };
      }
    }

    // Fallback (deep link): synthesise a minimal story from the user record so
    // the template at least renders a real avatar and name.
    if (!story) {
      const rawUser = getUser(id);
      if (rawUser) {
        const u = formatUser(rawUser);
        story = {
          id,
          user: {
            id: u.id,
            username: u.username,
            displayName: u.displayName,
            avatarUrl: u.avatarUrl,
          },
          imageUrl: u.avatarUrl,
        };
      }
    }

    state.story = story;
  })
  .build();
