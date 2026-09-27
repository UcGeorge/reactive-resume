// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";

type RouteRow = {
	feature: string;
	aiProviderId: string | null;
	status: "unset" | "ok" | "unavailable" | "removed";
	effectiveProviderId: string | null;
	source: "feature" | "default" | "fallback";
};

type ComboboxProps = {
	id: string;
	value: string;
	options: { value: string; label: string }[];
	onValueChange: (value: string) => void;
};

const FEATURES = [
	"default",
	"chat",
	"import",
	"ats-review",
	"autofill",
	"evaluation",
	"tailoring",
	"cover-letter",
	"outreach",
	"stories",
];

const state = vi.hoisted(() => ({
	providers: [] as {
		id: string;
		label: string;
		provider: string;
		model: string;
		enabled: boolean;
		testStatus: string;
	}[],
	routes: [] as RouteRow[],
}));

const queryClient = vi.hoisted(() => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }));
const setRoute = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", () => ({
	useQuery: (options: { queryKey: string[] }) =>
		options.queryKey[1] === "routes"
			? { data: state.routes, isLoading: false, error: null }
			: { data: state.providers, isLoading: false, error: null },
	useQueryClient: () => queryClient,
	useMutation: () => ({
		isPending: false,
		mutate: (
			input: unknown,
			handlers?: { onSuccess?: (data: unknown) => void; onError?: (error: unknown) => void },
		) => {
			setRoute(input).then(handlers?.onSuccess).catch(handlers?.onError);
		},
	}),
}));

vi.mock("@/libs/orpc/client", () => ({
	orpc: {
		aiProviders: {
			list: { queryOptions: () => ({ queryKey: ["aiProviders", "list"] }) },
			routes: {
				list: {
					queryOptions: () => ({ queryKey: ["aiProviders", "routes"] }),
					queryKey: () => ["aiProviders", "routes"],
				},
				set: { mutationOptions: () => ({}) },
			},
		},
	},
}));

vi.mock("@/components/ui/combobox", () => ({
	Combobox: ({ id, value, options, onValueChange }: ComboboxProps) => (
		<select id={id} value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	),
}));

vi.mock("@reactive-resume/ui/components/toast", () => ({ toast: { add: vi.fn() } }));

i18n.loadAndActivate({ locale: "en", messages: {} });

const { AiRoutingSection } = await import("./ai-routing-section");

const route = (feature: string, overrides: Partial<RouteRow> = {}): RouteRow => ({
	feature,
	aiProviderId: null,
	status: "unset",
	effectiveProviderId: "openai",
	source: "fallback",
	...overrides,
});

const renderSection = () =>
	render(
		<I18nProvider i18n={i18n}>
			<AiRoutingSection />
		</I18nProvider>,
	);

describe("AiRoutingSection", () => {
	beforeEach(() => {
		setRoute.mockReset();
		queryClient.setQueryData.mockReset();
		state.providers = [
			{ id: "openai", label: "Work", provider: "openai", model: "gpt-4.1", enabled: true, testStatus: "success" },
			{
				id: "agent",
				label: "Claude",
				provider: "mcp-agent",
				model: "claude-code",
				enabled: false,
				testStatus: "failure",
			},
		];
		state.routes = FEATURES.map((feature) => route(feature));
	});

	it("renders one picker per feature with every saved provider and a default option", () => {
		renderSection();

		for (const label of ["Default", "Agent chat", "Resume import", "Job evaluation", "Story bank"]) {
			expect(screen.getByLabelText(label)).toBeInTheDocument();
		}

		const chat = screen.getByLabelText("Agent chat") as HTMLSelectElement;
		expect(chat.value).toBe("__default__");
		expect(Array.from(chat.options).map((option) => option.textContent)).toEqual([
			"Use default",
			"Work · openai · gpt-4.1",
			"Claude · mcp-agent · claude-code (not connected)",
		]);

		const fallback = screen.getByLabelText("Default") as HTMLSelectElement;
		expect(fallback.options[0]?.textContent).toBe("Oldest tested provider");
	});

	it("flags routes whose provider cannot run or was removed", () => {
		state.routes = [
			route("default"),
			route("chat", { aiProviderId: "agent", status: "unavailable" }),
			route("evaluation", { aiProviderId: null, status: "removed" }),
		];

		renderSection();

		expect(screen.getByText("Provider unavailable, using default")).toBeInTheDocument();
		expect(screen.getByText("Provider removed, using default")).toBeInTheDocument();
		expect((screen.getByLabelText("Agent chat") as HTMLSelectElement).value).toBe("agent");
	});

	it("saves a route and clears it back to default", async () => {
		const updated = FEATURES.map((feature) =>
			feature === "chat" ? route(feature, { aiProviderId: "agent", status: "unavailable" }) : route(feature),
		);
		setRoute.mockResolvedValue(updated);

		renderSection();

		fireEvent.change(screen.getByLabelText("Agent chat"), { target: { value: "agent" } });
		await waitFor(() => expect(setRoute).toHaveBeenCalledWith({ feature: "chat", aiProviderId: "agent" }));
		expect(queryClient.setQueryData).toHaveBeenCalledWith(["aiProviders", "routes"], updated);

		fireEvent.change(screen.getByLabelText("Agent chat"), { target: { value: "__default__" } });
		await waitFor(() => expect(setRoute).toHaveBeenCalledWith({ feature: "chat", aiProviderId: null }));
	});
});
