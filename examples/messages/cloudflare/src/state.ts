/**
 * Per-session module state. Everything here is a VIEW of the hub's data
 * (hub.ts owns the truth in DO SQLite) shaped for the template: flags and
 * pre-formatted strings, so the DSL only binds fields and never computes.
 */

export type Screen = "setup" | "list" | "thread" | "newRoom" | "newDm";

export interface Me {
  id: string;
  name: string;
  color: string;
  initial: string;
}

export interface ColorOption {
  color: string;
  selected: boolean;
}

export interface ConversationView {
  id: string;
  isRoom: boolean;
  title: string;
  initial: string;
  color: string;
  preview: string;
  time: string;
  unread: number;
  hasUnread: boolean;
  unreadLabel: string;
  online: boolean;
}

export interface PersonView {
  id: string;
  name: string;
  initial: string;
  color: string;
  online: boolean;
  status: string;
}

export interface ReactionView {
  key: string;
  emoji: string;
  label: string;
  mine: boolean;
}

export interface MessageView {
  id: string;
  isDay: boolean;
  dayLabel: string;
  mine: boolean;
  author: string;
  initial: string;
  color: string;
  text: string;
  hasText: boolean;
  time: string;
  showName: boolean;
  showAvatar: boolean;
  showTime: boolean;
  radius: string;
  gapTop: number;
  hasImage: boolean;
  image: string;
  hasPreview: boolean;
  previewUrl: string;
  previewSite: string;
  previewTitle: string;
  previewDesc: string;
  hasPreviewImage: boolean;
  previewImage: string;
  reactions: ReactionView[];
  hasReactions: boolean;
  showStatus: boolean;
  status: string;
  selected: boolean;
}

export interface RoomHeader {
  id: string;
  isRoom: boolean;
  title: string;
  subtitle: string;
  initial: string;
  color: string;
  online: boolean;
}

export interface Toast {
  show: boolean;
  roomId: string;
  title: string;
  text: string;
  initial: string;
  color: string;
}

export interface MessagesState {
  screen: Screen;
  me: Me;
  setupName: string;
  setupColor: string;
  setupInitial: string;
  setupError: string;
  editingProfile: boolean;
  colors: ColorOption[];

  conversations: ConversationView[];
  unreadTotal: number;
  people: PersonView[];
  onlineCount: number;
  hasPeople: boolean;

  room: RoomHeader;
  messages: MessageView[];
  hasMore: boolean;
  isEmpty: boolean;
  typingText: string;
  isTyping: boolean;

  draft: string;
  notice: string;
  hasNotice: boolean;
  pickerFor: string;
  pickerOpen: boolean;
  reactionChoices: { emoji: string }[];

  newRoomName: string;
  newRoomError: string;

  toast: Toast;
  canAttach: boolean;
  uploading: boolean;
}

export const EMPTY_ROOM: RoomHeader = {
  id: "",
  isRoom: true,
  title: "",
  subtitle: "",
  initial: "",
  color: "#6366F1",
  online: false,
};

export const EMPTY_TOAST: Toast = { show: false, roomId: "", title: "", text: "", initial: "", color: "#6366F1" };
