import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@reactive-resume/ui/components/button";
import { Input } from "@reactive-resume/ui/components/input";
import { Label } from "@reactive-resume/ui/components/label";

const COPIED_FEEDBACK_MS = 2_000;

/** The MCP endpoint of this deployment, as the browser sees it. */
export function getMcpUrl() {
	return `${window.location.origin}/mcp`;
}

/** Replaces the API-key field for a "Connected agent (MCP)" provider: there is no key, only a client to connect. */
export function McpAgentSetupPanel() {
	const [copied, setCopied] = useState(false);
	const mcpUrl = getMcpUrl();

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(mcpUrl);
			setCopied(true);
			setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
		} catch {
			// The URL stays visible in the input; a failed clipboard write needs no message.
		}
	};

	return (
		<div className="grid gap-3 rounded-md border bg-background/50 p-3 text-sm">
			<p className="font-medium">
				<Trans>Serve this provider from your own agent</Trans>
			</p>

			<ol className="grid list-decimal gap-2 ps-5 text-muted-foreground">
				<li>
					<Trans>
						Connect an MCP client (Claude Code, Codex, or any MCP-capable agent) to the URL below, with OAuth or an API
						key from Settings → API Keys.
					</Trans>
				</li>
				<li>
					<Trans>
						In that client, run the <code>serve_ai_requests</code> prompt, or call <code>claim_ai_request</code> in a
						loop.
					</Trans>
				</li>
				<li>
					<Trans>
						Save & Test waits up to 90 seconds for the agent to answer. Keep the agent serving whenever you use AI
						features routed to it.
					</Trans>
				</li>
			</ol>

			<div className="space-y-2">
				<Label htmlFor="mcp-url">
					<Trans>MCP server URL</Trans>
				</Label>
				<div className="flex gap-2">
					<Input id="mcp-url" readOnly value={mcpUrl} />
					<Button type="button" size="icon" variant="outline" aria-label={t`Copy MCP URL`} onClick={() => void copy()}>
						{copied ? <CheckIcon /> : <CopyIcon />}
					</Button>
				</div>
			</div>
		</div>
	);
}
