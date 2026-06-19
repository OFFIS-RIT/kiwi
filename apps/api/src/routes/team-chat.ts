import { teamChatTargetSpec } from "../controllers/chat/team-chat";
import { createChatTargetRoute } from "./chat-target-route";

export const teamChatRoute = createChatTargetRoute(teamChatTargetSpec);
