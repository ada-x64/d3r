import { createHash } from "node:crypto";
import { type RuntimePermissionScope } from "@d3r/core/runtime";

/** Known native tool definitions supply scopes; model arguments never select a grant category. */
export const nativeWorkspaceScope = (
	name: string,
): RuntimePermissionScope | undefined => {
	if (name === "run_command") {
		return {
			id: "d3r:native:commands",
			label: "all command executions (not sandboxed)",
		};
	}
	if (name === "write_file" || name === "edit_file") {
		return {
			id: "d3r:native:workspace-edits",
			label: "workspace file writes and edits",
		};
	}
	return undefined;
};

/** An MCP grant covers only one tool from the fixed live connection's catalog, not other servers/tools. */
export const nativeMcpScope = (name: string): RuntimePermissionScope => ({
	id: `d3r:native:mcp:${createHash("sha256").update(name).digest("hex")}`,
	label: `calls to MCP tool ${name}`,
});
