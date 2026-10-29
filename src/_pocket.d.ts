/**
 * Local editor/type-check stub. A real drop-in folder receives Pi Pocket's
 * own `_pocket.d.ts` link, which has the full v0.18.0 public API. This file is
 * never installed and is not a second source of truth.
 */
export type Role = "owner" | "guest" | "viewer";

export interface Person {
    readonly id: string;
    readonly name: string;
    readonly role: Role;
}

export interface Pocket {
    readonly module: string;
    readonly title: string;
    readonly h: any;
    html(strings: TemplateStringsArray, ...values: unknown[]): any;
    readonly Fragment: any;
    readonly useState: any;
    readonly useEffect: any;
    readonly useLayoutEffect: any;
    readonly useRef: any;
    readonly useMemo: any;
    readonly useCallback: any;
    readonly useReducer: any;
    readonly Icon: any;
    readonly Spinner: any;
    readonly Loader: any;
    readonly Markdown: any;
    readonly Switch: any;
    me(): Person | null;
    conversationId(): number | null;
    api<T = unknown>(
        path: string,
        body?: object,
        options?: { method?: string; signal?: AbortSignal },
    ): Promise<T>;
    on<T = unknown>(event: string, run: (data: T) => void): () => void;
    notify(level: "info" | "warning" | "error", message: string): void;
    rail(spec: any): { update(patch: any): void; remove(): void };
    menu(spec: any): { update(patch: any): void; remove(): void };
    launcher(spec: any): { update(patch: any): void; remove(): void };
    page(spec: any): { update(patch: any): void; remove(): void };
    sheet(spec: any): { update(patch: any): void; remove(): void };
    openPage(id: string): void;
    closePage(): void;
    openSheet(id: string, props?: object): void;
    closeSheet(): void;
    style(path: string): void;
    onDispose(dispose: () => void): void;
}
