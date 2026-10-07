import { app } from "@hypen-space/core/app";
import type { GlobalContext } from "@hypen-space/core/app";
import { durableObjectStore, session } from "@hypen-space/cf";
import { db } from "./db";
import {
  getUser,
  getFeedPosts,
  getUserPosts,
  getStories,
  getComments,
  getConversations,
  getConversation,
  getConversationMessages,
  markConversationRead,
  formatUser,
} from "./queries";
import { deleteMedia, mediaIdFromUrl, storePhoto } from "./media";

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

function getExplorePosts(): {
  id: string;
  imageUrl: string;
  username: string;
  caption: string;
}[] {
  const posts = db
    .query(
      "SELECT p.id, p.image_url, p.caption, u.username FROM posts p JOIN users u ON p.user_id = u.id ORDER BY p.likes_count DESC",
    )
    .all() as any[];
  const base = posts.map((p) => ({
    id: p.id,
    imageUrl: p.image_url,
    username: p.username ?? "",
    caption: p.caption ?? "",
  }));
  const multiplied = [];
  for (let i = 0; i < 10; i++) {
    for (const p of base) {
      multiplied.push({
        id: `${p.id}_${i}`,
        imageUrl: p.imageUrl,
        username: p.username,
        caption: p.caption,
      });
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
  // Persist the App shell's `currentUser` + `location` to DO storage
  // so a reconnecting client lands on the same route. `bindAppStateStore
  // (state.storage)` in src/do.ts wires the DO's transactional storage
  // into this store on every fetch.
  .persist(durableObjectStore<AppState>(session<AppState>()))
  .onCreated(async (state) => {
    // Always re-derive `currentUser` from the DB rather than trusting a
    // restored copy: a DO that persisted the user under an older shape (or
    // an avatar URL that has since changed) would otherwise serve a
    // `currentUser` with no usable `avatarUrl` forever — which showed up as
    // a blank "Your story" avatar and an empty profile tab on Android.
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
  // Reload on every return to the feed, not once: posts shared from
  // /create (by this visitor or anyone else on the shared Durable Object)
  // show up as soon as the feed is on screen again.
  .onActivated(async (state, context) => {
    state.currentUser = context ? currentUserFromApp(context) : null;
    const id = state.currentUser?.id ?? "u1";
    state.posts = getFeedPosts(id);
    state.stories = getStories(id);
  })
  .onAction<{ postId: string }>("toggleLike", async ({ state, action }) => {
    const postId = action.payload?.postId;
    if (!postId) return;
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
    const postId = action.payload?.postId;
    if (!postId) return;
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
  explorePosts: { id: string; imageUrl: string; username: string; caption: string }[];
}

// Lazy — the DO's `db` shim isn't bound until the constructor runs, so
// this top-level evaluation has to defer the SQL call to first use.
let _allExplorePosts: ReturnType<typeof getExplorePosts> | null = null;
const getAllExplorePosts = () => {
  if (!_allExplorePosts) _allExplorePosts = getExplorePosts();
  return _allExplorePosts;
};

export const searchModule = app
  .module("Search")
  .defineState<SearchState>({
    searchQuery: "",
    explorePosts: [],
  })
  .onCreated((state) => {
    state.explorePosts = getAllExplorePosts();
  })
  .onAction("search", ({ action, state }) => {
    const payload = (action.payload ?? {}) as { value?: string; input?: string };
    const raw = payload.value ?? payload.input ?? "";
    const query = raw.toLowerCase();
    const all = getAllExplorePosts();
    state.explorePosts =
      query === ""
        ? all
        : all.filter(
            (p) =>
              p.username.toLowerCase().includes(query) ||
              p.caption.toLowerCase().includes(query),
          );
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
  // Refresh last-message previews and unread markers whenever we return from
  // a thread instead of keeping the first inbox snapshot forever.
  .onActivated(async (state, context) => {
    state.currentUser = context ? currentUserFromApp(context) : null;
    state.messages = getConversations(state.currentUser?.id ?? "u1");
  })
  .build();

// ---------------------------------------------------------------------------
// Conversation — route "/dm/:id".
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  text: string;
  isMine: boolean;
  avatarUrl: string;
  timeAgo: string;
}

interface ConversationState {
  currentUser: User | null;
  conversationId: string;
  peer: Pick<User, "id" | "username" | "displayName" | "avatarUrl"> | null;
  chatMessages: ChatMessage[];
  draft: string;
}

const cannedReplies = [
  "Absolutely — sounds good!",
  "Haha, I was just thinking the same thing.",
  "Send me the details 👀",
  "I’m in! When works for you?",
  "That looks amazing!",
  "Deal 🙌",
];

export const conversationModule = app
  .module("Conversation")
  .defineState<ConversationState>({
    currentUser: null,
    conversationId: "",
    peer: null,
    chatMessages: [],
    draft: "",
  })
  .onActivated(async (state, context) => {
    if (!context?.router) return;
    state.currentUser = currentUserFromApp(context);
    const userId = state.currentUser?.id ?? "u1";
    const path = context.router.getCurrentPath();
    const match = context.router.matchPath("/dm/:id", path);
    const id = match?.params.id ?? "";
    state.conversationId = id;
    state.draft = "";

    const conversation = id ? getConversation(id, userId) : null;
    state.peer = conversation?.user ?? null;
    state.chatMessages = conversation ? getConversationMessages(id, userId) : [];
    if (conversation) markConversationRead(id, userId);
  })
  .onAction("sendMessage", async ({ state }) => {
    const text = state.draft.trim();
    if (!text || !state.currentUser || !state.peer || !state.conversationId) return;

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sentId = `msg-${nonce}`;
    db.query(
      "INSERT INTO messages (id, conversation_id, sender_id, text, is_read) VALUES (?, ?, ?, ?, 1)"
    ).run(sentId, state.conversationId, state.currentUser.id, text);

    state.chatMessages.push({
      id: sentId,
      text,
      isMine: true,
      avatarUrl: state.currentUser.avatarUrl,
      timeAgo: "now",
    });
    state.draft = "";

    const reply = cannedReplies[Math.floor(Math.random() * cannedReplies.length)]!;
    const replyId = `${sentId}-reply`;
    db.query(
      "INSERT INTO messages (id, conversation_id, sender_id, text, is_read) VALUES (?, ?, ?, ?, 1)"
    ).run(replyId, state.conversationId, state.peer.id, reply);
    state.chatMessages.push({
      id: replyId,
      text: reply,
      isMine: false,
      avatarUrl: state.peer.avatarUrl,
      timeAgo: "now",
    });
  })
  .build();

// ---------------------------------------------------------------------------
// Profile — route "/profile".
// ---------------------------------------------------------------------------

interface ProfileState {
  currentUser: User | null;
  userPosts: { id: string; imageUrl: string }[];
  /** Progress / error line under "Edit Profile" while changing the avatar. */
  avatarStatus: string;
}

export const profileModule = app
  .module("Profile")
  .defineState<ProfileState>({ currentUser: null, userPosts: [], avatarStatus: "" })
  .onActivated(async (state, context) => {
    const appUser = context ? currentUserFromApp(context) : null;
    const id = appUser?.id ?? "u1";
    const freshUser = getUser(id);
    state.currentUser = freshUser ? formatUser(freshUser) : appUser;
    state.userPosts = getUserPosts(id);
  })
  // "Edit Profile" → change the avatar. The photo comes from the device
  // plane: the visitor's DeviceHost shows its own consent dialog (with a
  // drop zone) and picker; the handler just awaits the verified bytes.
  .onAction("editProfile", async ({ state, context }) => {
    const user = state.currentUser;
    if (!user) return;
    state.avatarStatus = "Choose a photo…";
    const res = await context.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 });
    if ("error" in res) {
      state.avatarStatus = deviceErrorMessage(res.error.code);
      return;
    }
    const item = res.value.items[0];
    if (!item) {
      state.avatarStatus = "";
      return;
    }
    const stored = await storePhoto(item.bytes, user.id);
    if ("reason" in stored) {
      state.avatarStatus = stored.reason;
      return;
    }
    const previous = mediaIdFromUrl(user.avatarUrl);
    db.query("UPDATE users SET avatar_url = ? WHERE id = ?").run(stored.url, user.id);
    if (previous) await deleteMedia(previous, user.id);
    state.currentUser = { ...user, avatarUrl: stored.url };
    state.avatarStatus = "";
    // The App shell is the source of truth other screens copy from.
    if (context.hasModule("app")) {
      const shell = context.getModule<AppState>("app");
      const current = shell.getState().currentUser;
      if (current) shell.setState({ currentUser: { ...current, avatarUrl: stored.url } });
    }
  })
  .build();

// ---------------------------------------------------------------------------
// CreatePost — route "/create". A new photo post from the device.
// ---------------------------------------------------------------------------

type CreateStatus = "idle" | "picking" | "ready" | "posting";

interface CreatePostState {
  currentUser: User | null;
  status: CreateStatus;
  /** Uploaded draft photo (`/media/<id>`), or "" before one is chosen. */
  draftImageUrl: string;
  caption: string;
  location: string;
  error: string;
  /** Whether the connected device can open a camera (live device selection). */
  canUseCamera: boolean;
  /** Whether the connected client has a device plane at all. */
  canUpload: boolean;
}

/** Friendly text for a device error code (handlers never branch on `platformDetail`). */
export function deviceErrorMessage(code: string): string {
  switch (code) {
    case "cancelled":
    case "denied":
      return "";
    case "unsupported":
    case "unavailable":
      return "This device can't share photos with Hypengram.";
    case "throttled":
      return "That photo is too large, or another prompt is already open.";
    case "timeout":
      return "Timed out waiting for a photo.";
    case "connectionLost":
      return "Connection lost while uploading. Try again.";
    default:
      return "Something went wrong with that photo.";
  }
}

export const createPostModule = app
  .module("CreatePost")
  .defineState<CreatePostState>({
    currentUser: null,
    status: "idle",
    draftImageUrl: "",
    caption: "",
    location: "",
    error: "",
    canUseCamera: false,
    canUpload: false,
  })
  .onActivated(async (state, context) => {
    state.currentUser = context ? currentUserFromApp(context) : null;
    state.canUpload = !!context?.device.supports("gallery.pick");
    state.canUseCamera = !!context?.device.supports("camera.capture");
    state.error = state.canUpload ? "" : "Open Hypengram in a browser to share photos.";
    if (state.status !== "ready") state.status = "idle";
  })
  .onAction("pickPhoto", async ({ state, context }) => {
    await takeDraft(state, () =>
      context.device.request("gallery.pick", { mediaTypes: ["photo"], maxCount: 1 })
    );
  })
  .onAction("takePhoto", async ({ state, context }) => {
    await takeDraft(state, () => context.device.camera.capture({ mode: "photo", facing: "back" }));
  })
  .onAction("sharePost", async ({ state, context }) => {
    const user = state.currentUser;
    if (!user || !state.draftImageUrl || state.status !== "ready") return;
    state.status = "posting";
    const id = `p-${crypto.randomUUID()}`;
    db.transaction(() => {
      db.query(
        "INSERT INTO posts (id, user_id, image_url, caption, location) VALUES (?, ?, ?, ?, ?)"
      ).run(id, user.id, state.draftImageUrl, state.caption.trim().slice(0, 2200), state.location.trim().slice(0, 100) || null);
      db.query("UPDATE users SET posts_count = posts_count + 1 WHERE id = ?").run(user.id);
    })();
    resetDraft(state, { keepMedia: true });
    const current = context.hasModule("app") ? context.getModule<AppState>("app").getState().currentUser : null;
    goHome(context, current ? { currentUser: { ...current, postsCount: current.postsCount + 1 } } : {});
  })
  .onAction("discardPost", async ({ state, context }) => {
    resetDraft(state, { keepMedia: false });
    goHome(context);
  })
  .build();

/**
 * Back to the feed, in ONE App-shell update. The shell's `location` drives
 * the Router (and the router mirrors back into it), so a separate
 * `router.push("/")` next to a shell `setState` races: the shell's flush
 * lands with the stale "/create" and the mirror navigates right back.
 */
function goHome(context: GlobalContext, patch: Partial<AppState> = {}): void {
  if (context.hasModule("app")) {
    context.getModule<AppState>("app").setState({ ...patch, location: "/" });
  } else {
    context.router?.push("/");
  }
}

/** What `gallery.pick` and `camera.capture` both resolve to, as far as a draft cares. */
type PhotoResult =
  | { ok: true; value: { items: Array<{ bytes: Uint8Array }> } }
  | { ok: false; error: { code: string } };

/** Ask the device for one photo and keep it as the draft. */
async function takeDraft(state: CreatePostState, ask: () => Promise<PhotoResult>): Promise<void> {
  const user = state.currentUser;
  if (!user || state.status === "picking" || state.status === "posting") return;
  state.error = "";
  const before = state.status;
  state.status = "picking";
  const res = await ask();
  if ("error" in res) {
    state.status = before === "ready" ? "ready" : "idle";
    state.error = deviceErrorMessage(res.error.code);
    return;
  }
  const item = res.value.items[0];
  if (!item) {
    state.status = before === "ready" ? "ready" : "idle";
    return;
  }
  const stored = await storePhoto(item.bytes, user.id);
  if ("reason" in stored) {
    state.status = before === "ready" ? "ready" : "idle";
    state.error = stored.reason;
    return;
  }
  // Replacing a draft: the old photo was never shared, so drop it.
  const old = mediaIdFromUrl(state.draftImageUrl);
  if (old) await deleteMedia(old, user.id);
  state.draftImageUrl = stored.url;
  state.status = "ready";
}

function resetDraft(state: CreatePostState, { keepMedia }: { keepMedia: boolean }): void {
  const draft = mediaIdFromUrl(state.draftImageUrl);
  if (draft && !keepMedia && state.currentUser) void deleteMedia(draft, state.currentUser.id);
  state.draftImageUrl = "";
  state.caption = "";
  state.location = "";
  state.error = "";
  state.status = "idle";
}

// ---------------------------------------------------------------------------
// UserProfile — route "/user-profile/:id". onActivated re-reads the URL
// param so navigating between two different users reuses the module but
// refreshes the viewed data.
// ---------------------------------------------------------------------------

interface UserProfileState {
  viewedUser: ViewedUser | null;
}

function loadViewedUser(userId: string, currentUserId: string): ViewedUser | null {
  const raw = getUser(userId);
  if (!raw) return null;
  const follow = db.query(
    "SELECT 1 AS present FROM follows WHERE follower_id = ? AND following_id = ?"
  ).get(currentUserId, userId);
  return {
    ...formatUser(raw),
    posts: getUserPosts(userId),
    isFollowing: !!follow,
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
    const appUser = currentUserFromApp(context);
    if (!appUser) return;
    state.viewedUser = loadViewedUser(id, appUser.id);
  })
  .onAction("toggleFollow", async ({ state, context }) => {
    if (!state.viewedUser) return;
    const appUser = context ? currentUserFromApp(context) : null;
    if (!appUser || appUser.id === state.viewedUser.id) return;

    const targetId = state.viewedUser.id;
    const alreadyFollowing = !!db.query(
      "SELECT 1 AS present FROM follows WHERE follower_id = ? AND following_id = ?"
    ).get(appUser.id, targetId);
    const delta = alreadyFollowing ? -1 : 1;

    db.transaction(() => {
      if (alreadyFollowing) {
        db.query(
          "DELETE FROM follows WHERE follower_id = ? AND following_id = ?"
        ).run(appUser.id, targetId);
      } else {
        db.query(
          "INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)"
        ).run(appUser.id, targetId);
      }
      db.query(
        "UPDATE users SET followers_count = MAX(0, followers_count + ?) WHERE id = ?"
      ).run(delta, targetId);
      db.query(
        "UPDATE users SET following_count = MAX(0, following_count + ?) WHERE id = ?"
      ).run(delta, appUser.id);
    })();

    state.viewedUser = loadViewedUser(targetId, appUser.id);

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
    const commentId = action.payload?.commentId;
    if (!commentId) return;
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
