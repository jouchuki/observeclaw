/** Typed interface for the OpenClaw plugin API as used by ObserveClaw */
export interface PluginApi {
	pluginConfig: Record<string, unknown> | undefined;
	logger: PluginLogger;
	on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) => void;
	registerGatewayMethod: (name: string, handler: (params: GatewayMethodParams) => void) => void;
	registerHttpRoute: (route: HttpRouteConfig) => void;
}

export interface PluginLogger {
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
}

export interface GatewayMethodParams {
	params: Record<string, unknown>;
	respond: (ok: boolean, data?: unknown, error?: { code: string; message: string }) => void;
}

export interface HttpRouteConfig {
	path: string;
	auth: string;
	match: string;
	handler: (req: unknown, res: HttpResponse) => Promise<void>;
}

export interface HttpResponse {
	writeHead: (code: number, headers: Record<string, string>) => void;
	end: (body: string) => void;
}

export interface HookContext {
	agentId?: string;
	sessionKey?: string;
	sessionId?: string;
	runId?: string;
}
