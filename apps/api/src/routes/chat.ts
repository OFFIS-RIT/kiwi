import { graphChatTargetSpec } from "../controllers/chat/graph-chat";
import { createChatTargetRoute } from "./chat-target-route";

export const chatRoute = createChatTargetRoute(graphChatTargetSpec);
