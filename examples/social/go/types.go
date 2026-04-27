package main

// User represents an Instagram user profile.
type User struct {
	ID             string `json:"id"`
	Username       string `json:"username"`
	DisplayName    string `json:"displayName"`
	AvatarUrl      string `json:"avatarUrl"`
	Bio            string `json:"bio"`
	PostsCount     int    `json:"postsCount"`
	FollowersCount int    `json:"followersCount"`
	FollowingCount int    `json:"followingCount"`
}

// Post represents an Instagram post with metadata.
type Post struct {
	ID            string  `json:"id"`
	User          User    `json:"user"`
	ImageUrl      string  `json:"imageUrl"`
	Caption       string  `json:"caption"`
	Location      *string `json:"location"`
	LikesCount    int     `json:"likesCount"`
	CommentsCount int     `json:"commentsCount"`
	IsLiked       bool    `json:"isLiked"`
	IsSaved       bool    `json:"isSaved"`
	TimeAgo       string  `json:"timeAgo"`
}

// Story represents an Instagram story entry.
type Story struct {
	ID             string `json:"id"`
	User           User   `json:"user"`
	ImageUrl       string `json:"imageUrl"`
	HasUnseenStory bool   `json:"hasUnseenStory"`
}

// Comment represents a comment on a post.
type Comment struct {
	ID      string `json:"id"`
	User    User   `json:"user"`
	Text    string `json:"text"`
	TimeAgo string `json:"timeAgo"`
}

// Notification represents an activity notification.
type Notification struct {
	ID           string `json:"id"`
	Type         string `json:"type"`
	User         User   `json:"user"`
	Text         string `json:"text"`
	PostImageUrl string `json:"postImageUrl"`
	TimeAgo      string `json:"timeAgo"`
	IsRead       bool   `json:"isRead"`
}

// Conversation represents a DM thread.
type Conversation struct {
	ID          string `json:"id"`
	User        User   `json:"user"`
	LastMessage string `json:"lastMessage"`
	TimeAgo     string `json:"timeAgo"`
	IsUnread    bool   `json:"isUnread"`
}

// PostThumbnail is a minimal post for grids.
type PostThumbnail struct {
	ID       string `json:"id"`
	ImageUrl string `json:"imageUrl"`
}

// ViewedUser is a user profile being viewed with their posts.
type ViewedUser struct {
	User
	Posts       []PostThumbnail `json:"posts"`
	IsFollowing bool            `json:"isFollowing"`
}

// ViewedStory is the currently viewed story.
type ViewedStory struct {
	ID       string `json:"id"`
	User     User   `json:"user"`
	ImageUrl string `json:"imageUrl"`
}

// ---------------------------------------------------------------------------
// Per-module state types. Each screen is its own Hypen module; ManagedRouter
// mounts the right one per route and persists the instance across navigations
// by default (opt out with `{Persist: &falseVal}` on ModuleOptions).
// ---------------------------------------------------------------------------

// AppState backs the shell module that owns the top-level Router template.
// It holds the currentUser (read-only from every other module's point of
// view) and mirrors the router's path into `location` so the Router IR can
// reconcile against it.
type AppState struct {
	CurrentUser User   `json:"currentUser"`
	Location    string `json:"location"`
}

// HomePageState backs route "/".
type HomePageState struct {
	CurrentUser User    `json:"currentUser"`
	Posts       []Post  `json:"posts"`
	Stories     []Story `json:"stories"`
}

// SearchState backs route "/search".
type SearchState struct {
	SearchQuery  string          `json:"searchQuery"`
	ExplorePosts []PostThumbnail `json:"explorePosts"`
}

// NotificationsState backs route "/notifications".
type NotificationsState struct {
	Notifications []Notification `json:"notifications"`
}

// MessagesState backs route "/messages".
type MessagesState struct {
	CurrentUser User           `json:"currentUser"`
	Messages    []Conversation `json:"messages"`
}

// ProfileState backs route "/profile".
type ProfileState struct {
	CurrentUser User            `json:"currentUser"`
	UserPosts   []PostThumbnail `json:"userPosts"`
}

// UserProfileState backs route "/user-profile/:id".
type UserProfileState struct {
	ViewedUser *ViewedUser `json:"viewedUser"`
}

// CommentsState backs route "/comments/:postId".
type CommentsState struct {
	CurrentUser User      `json:"currentUser"`
	PostID      string    `json:"postId"`
	Comments    []Comment `json:"comments"`
	CommentText string    `json:"commentText"`
}

// StoryState backs route "/story/:id".
type StoryState struct {
	Story *ViewedStory `json:"story"`
}
