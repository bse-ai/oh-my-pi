import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { BedrockOptions } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { withEnv } from "./helpers";
import {
	BEDROCK_TEST_CONTEXT,
	type BedrockCapture,
	bedrockTestModel,
	capturingBedrockFetch,
} from "./helpers/bedrock-stream";

const HAIKU55 = "us.anthropic.claude-haiku-5-5";
const target = (id = HAIKU55) => bedrockTestModel({ id, name: id, reasoning: true });

interface RequestBody {
	inferenceConfig: { maxTokens?: number; temperature?: number; topP?: number };
	additionalModelRequestFields?: Record<string, unknown>;
	toolConfig?: { toolChoice?: unknown };
}

async function capture(
	path: "main" | "helper",
	options: BedrockOptions & SimpleStreamOptions = {},
	id = HAIKU55,
	context: Context = BEDROCK_TEST_CONTEXT,
) {
	const seen: BedrockCapture = {};
	let url = "";
	const captureFetch = capturingBedrockFetch(seen);
	const fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			url = String(input);
			return captureFetch(input, init);
		},
		{ preconnect: captureFetch.preconnect },
	);
	let result: AssistantMessage | undefined;
	await withEnv(
		{
			AWS_REGION: "us-west-2",
			AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
			AWS_SECRET_ACCESS_KEY: "offline-fixture-secret",
			AWS_SESSION_TOKEN: "offline-session-token",
			AWS_PROFILE: undefined,
			AWS_BEARER_TOKEN_BEDROCK: undefined,
			AWS_BEDROCK_SKIP_AUTH: undefined,
			AWS_CONFIG_FILE: "/nonexistent/aws-config",
			AWS_SHARED_CREDENTIALS_FILE: "/nonexistent/aws-credentials",
			AWS_EC2_METADATA_DISABLED: "true",
		},
		async () => {
			clearAwsCredentialCache();
			try {
				const request = { maxTokens: 64, temperature: 0.5, topP: 0.9, ...options, fetch };
				result = await (
					path === "main" ? stream(target(id), context, request) : streamSimple(target(id), context, request)
				).result();
			} finally {
				clearAwsCredentialCache();
			}
		},
	);
	if (!result) throw new Error("Bedrock returned no result");
	expect(result.stopReason).toBe("stop");
	expect(result.model).toBe(id);
	expect(result.content).toMatchObject([{ type: "text", text: "hi" }]);
	expect(decodeURIComponent(url)).toBe(`https://bedrock-runtime.us-west-2.amazonaws.com/model/${id}/converse-stream`);
	const headers = new Headers(seen.headers);
	expect(headers.get("authorization")).toContain("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/");
	expect(headers.get("authorization")).toContain("/us-west-2/bedrock/aws4_request");
	expect(headers.get("x-amz-security-token")).toBe("offline-session-token");
	expect(headers.get("x-api-key")).toBeNull();
	return seen.body as RequestBody;
}

function expectOff(body: RequestBody) {
	expect(body.additionalModelRequestFields).toEqual({
		thinking: { type: "disabled" },
		output_config: { effort: "low" },
	});
	expect(body.inferenceConfig).toEqual({ maxTokens: 64 });
}

describe("Bedrock Haiku 5.5 thinking Off", () => {
	for (const path of ["main", "helper"] as const) {
		it(`${path} uses explicit disabled thinking without changing model or AWS authentication`, async () => {
			expectOff(await capture(path));
		});

		it(`${path} keeps requested adaptive Low and prefix binding`, async () => {
			const body = await capture(path, { reasoning: Effort.Low });
			expect(body.additionalModelRequestFields).toMatchObject({
				thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
				output_config: { effort: "low" },
				anthropic_beta: ["thinking-binding-controls-2026-08-01"],
			});
		});
	}

	it("keeps the global inference profile identity", async () => {
		expectOff(await capture("helper", {}, "global.anthropic.claude-haiku-5-5"));
	});

	for (const options of [{ disableReasoning: true }, { forceReasoningOff: true }]) {
		it(`honors helper ${Object.keys(options)[0]} over a requested effort`, async () => {
			expectOff(await capture("helper", { reasoning: Effort.Low, ...options }));
		});
	}

	it("preserves forced tool choice when thinking is disabled", async () => {
		const body = await capture("main", { toolChoice: "any" }, HAIKU55, {
			...BEDROCK_TEST_CONTEXT,
			tools: [{ name: "read", description: "Read a file", parameters: type({ path: "string" }) }],
		});
		expectOff(body);
		expect(body.toolConfig?.toolChoice).toEqual({ any: {} });
	});

	it("preserves onPayload additions to output_config", async () => {
		const body = await capture("helper", {
			onPayload(payload) {
				const request = payload as RequestBody;
				const fields = request.additionalModelRequestFields!;
				fields.output_config = {
					...(fields.output_config as Record<string, unknown>),
					format: { type: "json_schema" },
				};
			},
		});
		expect(body.additionalModelRequestFields).toEqual({
			thinking: { type: "disabled" },
			output_config: { effort: "low", format: { type: "json_schema" } },
		});
	});

	it("leaves Haiku 4.5 Off unchanged", async () => {
		const body = await capture("helper", {}, "us.anthropic.claude-haiku-4-5-20251001-v1:0");
		expect(body.additionalModelRequestFields).toBeUndefined();
	});

	it("leaves Sonnet 5.5 mandatory adaptive thinking unchanged", async () => {
		const body = await capture("helper", {}, "us.anthropic.claude-sonnet-5-5");
		expect(body.additionalModelRequestFields?.thinking).toMatchObject({ type: "adaptive" });
	});
});
