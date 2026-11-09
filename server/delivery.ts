export class DeliveryDeferred extends Error {}

/** The provider no longer has the agent's conversation: every send fails, so Follow-up stops sending to it. */
export class ConversationGone extends Error { constructor(readonly agentId: string, reason: string) { super(reason); this.name = "ConversationGone"; } }
