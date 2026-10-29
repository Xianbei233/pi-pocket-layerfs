/** Synthetic test-only probe for validating the isolated Pocket HTTP/loader harness. */
export default function (_host: unknown, web: {
    route: (method: string, path: string, handler: () => unknown) => void;
    conversationRoute: (
        method: string,
        path: string,
        handler: (request: { conversation: { id: unknown }; user: { id: string } }) => unknown,
        options: { conversation: string; access: string },
    ) => void;
}) {
    web.route("GET", "status", () => ({ syntheticHarnessProbe: true }));
    web.conversationRoute(
        "GET",
        "source/:source",
        (request) => ({ source: request.conversation.id, actor: request.user.id }),
        { conversation: "source", access: "owner" },
    );
}
