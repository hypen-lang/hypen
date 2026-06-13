package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	core "github.com/hypen-space/core"
	"github.com/hypen-space/core/remote"
)

func main() {
	db := initDatabase()
	defer db.Close()

	// Single logical user for the demo. Captured in every module's
	// closure so per-route modules don't need a shared GlobalContext to
	// read it (the Go SDK's handlers get a fresh context on every
	// dispatch — sibling-module lookup via `context.GetModule("app")` is
	// not wired the way it is in the TS SDK).
	currentUser := getUser(db, "u1")
	allExplorePosts := getExplorePosts(db)

	appDef := buildAppModule(currentUser)
	buildHomePageModule(db, currentUser)
	buildSearchModule(allExplorePosts)
	buildNotificationsModule(db, currentUser)
	buildMessagesModule(db, currentUser)
	buildProfileModule(db, currentUser)
	buildUserProfileModule(db, currentUser)
	buildCommentsModule(db, currentUser)
	buildStoryModule(db)

	resourcesDir := filepath.Join("..", "resources")

	port := 3000
	if envPort := os.Getenv("PORT"); envPort != "" {
		fmt.Sscanf(envPort, "%d", &port)
	}

	// No routing wiring. `RemoteServer` auto-discovers every
	// `Router { Route(path) { Component() } }` block in the primary
	// template, matches each route against the registered modules,
	// and spins up a ManagedRouter per session. Opt out via
	// `.DisableAutoRouter()` if a host wants bespoke wiring.
	server := remote.NewRemoteServer().
		Source(filepath.Join("..", "components")).
		WithDefinition(appDef).
		UI(loadTemplate("App")).
		ResourcesDir(resourcesDir).
		Config(remote.ServerConfig{Port: port})

	fmt.Printf("Instagram server (Go) running on ws://localhost:%d\n", port)
	server.Listen()
	select {}
}

// ---------------------------------------------------------------------------
// App — shell module. Holds currentUser + the router path mirror.
// ---------------------------------------------------------------------------

func buildAppModule(currentUser User) *core.ModuleDefinition {
	return core.NewApp(AppState{
		CurrentUser: currentUser,
		Location:    "/",
	}).
		Name("App").
		Build()
}

// ---------------------------------------------------------------------------
// HomePage — route "/".
// ---------------------------------------------------------------------------

func buildHomePageModule(db *sql.DB, currentUser User) *core.ModuleDefinition {
	return core.NewApp(HomePageState{}).
		Name("HomePage").
		OnCreated(func(state *HomePageState, _ core.GlobalContext) {
			state.CurrentUser = currentUser
			state.Posts = getFeedPosts(db, currentUser.ID)
			state.Stories = getStories(db, currentUser.ID)
		}).
		OnAction("toggleLike", func(ctx core.TypedActionContext[HomePageState]) {
			payloadMap, _ := ctx.Action.Payload.(map[string]any)
			postID, _ := payloadMap["postId"].(string)
			for i, p := range ctx.State.Posts {
				if p.ID == postID {
					ctx.State.Posts[i].IsLiked = !ctx.State.Posts[i].IsLiked
					if ctx.State.Posts[i].IsLiked {
						ctx.State.Posts[i].LikesCount++
						db.Exec("INSERT OR IGNORE INTO likes (post_id, user_id) VALUES (?, ?)", postID, currentUser.ID)
					} else {
						ctx.State.Posts[i].LikesCount--
						db.Exec("DELETE FROM likes WHERE post_id = ? AND user_id = ?", postID, currentUser.ID)
					}
					db.Exec("UPDATE posts SET likes_count = ? WHERE id = ?", ctx.State.Posts[i].LikesCount, postID)
					return
				}
			}
		}).
		OnAction("toggleSave", func(ctx core.TypedActionContext[HomePageState]) {
			payloadMap, _ := ctx.Action.Payload.(map[string]any)
			postID, _ := payloadMap["postId"].(string)
			for i, p := range ctx.State.Posts {
				if p.ID == postID {
					ctx.State.Posts[i].IsSaved = !ctx.State.Posts[i].IsSaved
					if ctx.State.Posts[i].IsSaved {
						db.Exec("INSERT OR IGNORE INTO saves (post_id, user_id) VALUES (?, ?)", postID, currentUser.ID)
					} else {
						db.Exec("DELETE FROM saves WHERE post_id = ? AND user_id = ?", postID, currentUser.ID)
					}
					return
				}
			}
		}).
		OnAction("sharePost", func(_ core.TypedActionContext[HomePageState]) {}).
		OnAction("postOptions", func(_ core.TypedActionContext[HomePageState]) {}).
		Build()
}

// ---------------------------------------------------------------------------
// Search — route "/search".
// ---------------------------------------------------------------------------

func buildSearchModule(allExplorePosts []PostThumbnail) *core.ModuleDefinition {
	return core.NewApp(SearchState{
		SearchQuery:  "",
		ExplorePosts: allExplorePosts,
	}).
		Name("Search").
		OnAction("search", func(ctx core.TypedActionContext[SearchState]) {
			payloadMap, _ := ctx.Action.Payload.(map[string]any)
			raw, _ := payloadMap["value"].(string)
			if raw == "" {
				raw, _ = payloadMap["input"].(string)
			}
			query := strings.ToLower(raw)
			if query == "" {
				ctx.State.ExplorePosts = allExplorePosts
				return
			}
			filtered := make([]PostThumbnail, 0)
			for _, p := range allExplorePosts {
				if strings.Contains(strings.ToLower(p.Username), query) ||
					strings.Contains(strings.ToLower(p.Caption), query) {
					filtered = append(filtered, p)
				}
			}
			ctx.State.ExplorePosts = filtered
		}).
		Build()
}

// ---------------------------------------------------------------------------
// Notifications — route "/notifications".
// OnActivated marks everything read on every mount; OnCreated runs once
// (fresh mount only) and hydrates from the DB.
// ---------------------------------------------------------------------------

func buildNotificationsModule(db *sql.DB, currentUser User) *core.ModuleDefinition {
	return core.NewApp(NotificationsState{}).
		Name("Notifications").
		OnCreated(func(state *NotificationsState, _ core.GlobalContext) {
			state.Notifications = getMockNotifications(db, currentUser.ID)
		}).
		OnActivated(func(state *NotificationsState, _ core.GlobalContext) {
			for i := range state.Notifications {
				state.Notifications[i].IsRead = true
			}
		}).
		Build()
}

// ---------------------------------------------------------------------------
// Messages — route "/messages".
// ---------------------------------------------------------------------------

func buildMessagesModule(db *sql.DB, currentUser User) *core.ModuleDefinition {
	return core.NewApp(MessagesState{}).
		Name("Messages").
		OnCreated(func(state *MessagesState, _ core.GlobalContext) {
			state.CurrentUser = currentUser
			state.Messages = getMockMessages(db, currentUser.ID)
		}).
		Build()
}

// ---------------------------------------------------------------------------
// Profile — route "/profile".
// ---------------------------------------------------------------------------

func buildProfileModule(db *sql.DB, currentUser User) *core.ModuleDefinition {
	return core.NewApp(ProfileState{}).
		Name("Profile").
		OnCreated(func(state *ProfileState, _ core.GlobalContext) {
			state.CurrentUser = currentUser
			state.UserPosts = getUserPosts(db, currentUser.ID)
		}).
		OnAction("editProfile", func(_ core.TypedActionContext[ProfileState]) {}).
		Build()
}

// ---------------------------------------------------------------------------
// UserProfile — route "/user-profile/:id". OnActivated re-reads the URL
// param so navigating between two different users reuses the module but
// refreshes the viewed data.
// ---------------------------------------------------------------------------

func buildUserProfileModule(db *sql.DB, currentUser User) *core.ModuleDefinition {
	return core.NewApp(UserProfileState{}).
		Name("UserProfile").
		OnActivated(func(state *UserProfileState, ctx core.GlobalContext) {
			router := ctx.GetRouter()
			if router == nil {
				return
			}
			match := router.MatchPath("/user-profile/:id", router.GetCurrentPath())
			if match == nil {
				return
			}
			id := match.Params["id"]
			if id == "" {
				return
			}
			u := getUser(db, id)
			if u.ID == "" {
				return
			}
			vu := ViewedUser{
				User:        u,
				Posts:       getUserPosts(db, id),
				IsFollowing: false,
			}
			state.ViewedUser = &vu
		}).
		OnAction("toggleFollow", func(ctx core.TypedActionContext[UserProfileState]) {
			if ctx.State.ViewedUser == nil {
				return
			}
			ctx.State.ViewedUser.IsFollowing = !ctx.State.ViewedUser.IsFollowing
			if ctx.State.ViewedUser.IsFollowing {
				ctx.State.ViewedUser.FollowersCount++
				db.Exec("INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)", currentUser.ID, ctx.State.ViewedUser.ID)
			} else {
				ctx.State.ViewedUser.FollowersCount--
				db.Exec("DELETE FROM follows WHERE follower_id = ? AND following_id = ?", currentUser.ID, ctx.State.ViewedUser.ID)
			}
		}).
		Build()
}

// ---------------------------------------------------------------------------
// Comments — route "/comments/:postId".
// ---------------------------------------------------------------------------

func buildCommentsModule(db *sql.DB, currentUser User) *core.ModuleDefinition {
	return core.NewApp(CommentsState{}).
		Name("Comments").
		OnActivated(func(state *CommentsState, ctx core.GlobalContext) {
			state.CurrentUser = currentUser
			router := ctx.GetRouter()
			if router == nil {
				return
			}
			match := router.MatchPath("/comments/:postId", router.GetCurrentPath())
			if match == nil {
				return
			}
			state.PostID = match.Params["postId"]
			state.Comments = getComments(db, state.PostID)
			state.CommentText = ""
		}).
		OnAction("postComment", func(ctx core.TypedActionContext[CommentsState]) {
			text := strings.TrimSpace(ctx.State.CommentText)
			if text == "" || ctx.State.PostID == "" {
				return
			}
			id := fmt.Sprintf("c%d", time.Now().UnixMilli())
			db.Exec("INSERT INTO comments (id, post_id, user_id, text) VALUES (?, ?, ?, ?)", id, ctx.State.PostID, currentUser.ID, text)
			ctx.State.Comments = append(ctx.State.Comments, Comment{
				ID:      id,
				User:    currentUser,
				Text:    text,
				TimeAgo: "now",
			})
			ctx.State.CommentText = ""
			db.Exec("UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?", ctx.State.PostID)
		}).
		OnAction("likeComment", func(ctx core.TypedActionContext[CommentsState]) {
			payloadMap, _ := ctx.Action.Payload.(map[string]any)
			commentID, _ := payloadMap["commentId"].(string)
			if commentID == "" {
				return
			}
			var count int
			row := db.QueryRow("SELECT COUNT(*) FROM comment_likes WHERE comment_id = ? AND user_id = ?", commentID, currentUser.ID)
			row.Scan(&count)
			if count > 0 {
				db.Exec("DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?", commentID, currentUser.ID)
			} else {
				db.Exec("INSERT OR IGNORE INTO comment_likes (comment_id, user_id) VALUES (?, ?)", commentID, currentUser.ID)
			}
		}).
		Build()
}

// ---------------------------------------------------------------------------
// Story — route "/story/:id". Pulls a minimal user record to seed the
// overlay; a "real" story object would come from HomePage's cache, but
// Go modules don't share state the way the TS plan assumes so we
// reconstruct from the DB by user id.
// ---------------------------------------------------------------------------

func buildStoryModule(db *sql.DB) *core.ModuleDefinition {
	return core.NewApp(StoryState{}).
		Name("Story").
		OnActivated(func(state *StoryState, ctx core.GlobalContext) {
			router := ctx.GetRouter()
			if router == nil {
				return
			}
			match := router.MatchPath("/story/:id", router.GetCurrentPath())
			if match == nil {
				state.Story = nil
				return
			}
			id := match.Params["id"]
			if id == "" {
				state.Story = nil
				return
			}
			u := getUser(db, id)
			if u.ID == "" {
				state.Story = nil
				return
			}
			state.Story = &ViewedStory{
				ID: id,
				User: User{
					ID:          u.ID,
					Username:    u.Username,
					DisplayName: u.DisplayName,
					AvatarUrl:   u.AvatarUrl,
				},
				ImageUrl: u.AvatarUrl,
			}
		}).
		Build()
}

// ---------------------------------------------------------------------------
// Mock notification / message generators (match the TS example's fixtures
// so Web clients see the same content regardless of which SDK hosts them).
// ---------------------------------------------------------------------------

func getMockNotifications(db *sql.DB, currentUserID string) []Notification {
	users := getOtherUsers(db, currentUserID)
	posts := getUserPostThumbnails(db, currentUserID)
	postAt := func(i int) string {
		if i < len(posts) {
			return posts[i].ImageUrl
		}
		return ""
	}
	get := func(i int) User {
		if i < len(users) {
			return users[i]
		}
		return User{}
	}
	return []Notification{
		{ID: "n1", Type: "like", User: get(0), Text: fmt.Sprintf("%s liked your photo.  2h", get(0).Username), PostImageUrl: postAt(0), TimeAgo: "2h", IsRead: false},
		{ID: "n2", Type: "follow", User: get(1), Text: fmt.Sprintf("%s started following you.  4h", get(1).Username), PostImageUrl: "", TimeAgo: "4h", IsRead: false},
		{ID: "n3", Type: "comment", User: get(2), Text: fmt.Sprintf("%s commented: \"Amazing shot!\"  6h", get(2).Username), PostImageUrl: postAt(0), TimeAgo: "6h", IsRead: true},
		{ID: "n4", Type: "like", User: get(3), Text: fmt.Sprintf("%s liked your photo.  1d", get(3).Username), PostImageUrl: postAt(1), TimeAgo: "1d", IsRead: true},
		{ID: "n5", Type: "mention", User: get(0), Text: fmt.Sprintf("%s mentioned you in a comment.  1d", get(0).Username), PostImageUrl: postAt(1), TimeAgo: "1d", IsRead: true},
		{ID: "n6", Type: "follow", User: get(2), Text: fmt.Sprintf("%s started following you.  2d", get(2).Username), PostImageUrl: "", TimeAgo: "2d", IsRead: true},
	}
}

func getMockMessages(db *sql.DB, currentUserID string) []Conversation {
	users := getOtherUsers(db, currentUserID)
	get := func(i int) User {
		if i < len(users) {
			return users[i]
		}
		return User{}
	}
	return []Conversation{
		{ID: "m1", User: get(0), LastMessage: "That coffee spot was incredible!", TimeAgo: "2h", IsUnread: true},
		{ID: "m2", User: get(1), LastMessage: "See you at the food festival 🍕", TimeAgo: "5h", IsUnread: true},
		{ID: "m3", User: get(2), LastMessage: "Love the new designs!", TimeAgo: "1d", IsUnread: false},
		{ID: "m4", User: get(3), LastMessage: "Want to join the next hike?", TimeAgo: "2d", IsUnread: false},
	}
}
