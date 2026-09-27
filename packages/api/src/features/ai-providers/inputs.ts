import z from "zod";
import { aiProviderSchema } from "@reactive-resume/ai/types";

const providerFields = {
	label: z.string().trim().min(1),
	provider: aiProviderSchema,
	model: z.string().trim().min(1),
	baseURL: z.string().trim().optional(),
	apiKey: z.string().trim().optional(),
};

// A connected agent has no key: the server mints a placeholder so the encrypted column stays
// non-null. Every other provider still needs one.
export const providerInput = z.object(providerFields).superRefine((value, ctx) => {
	if (value.provider !== "mcp-agent" && !value.apiKey) {
		ctx.addIssue({ code: "custom", path: ["apiKey"], message: "API key is required." });
	}
});

export const updateProviderInput = z
	.object(providerFields)
	.partial()
	.extend({ id: z.string(), enabled: z.boolean().optional() })
	.refine((input) => Object.keys(input).some((key) => key !== "id"), {
		message: "At least one field must be provided.",
	});
